const crypto = require('crypto');
const ServiceError = require('./ServiceError');
const { validateTeam } = require('../utils/teamValidator');

// Orchestrates the student portal: enrollment, preferences, team membership and
// the proposal-backed team-forming flow. All business rules live here so the
// route handlers stay thin. Errors are thrown as ServiceError and translated to
// HTTP by the router.
class StudentPortalService {
  constructor({ units, enrollment, progress, prefs, teams, slots, announcements, studentRepo, proposalService }) {
    this.units = units;
    this.enrollment = enrollment;
    this.progress = progress;
    this.prefs = prefs;
    this.teams = teams;
    this.slots = slots;
    this.announcements = announcements;
    this.studentRepo = studentRepo;
    this.proposalService = proposalService;
  }

  listUnits(studentId) {
    return this.units.listAllWithJoinedFlag(studentId);
  }

  joinUnit(unitId, studentId) {
    const unit = this.units.findById(unitId);
    if (!unit) throw new ServiceError('Unit not found', 404);

    if (this.enrollment.isEnrolled(unitId, studentId)) {
      return { ok: true, alreadyJoined: true };
    }

    const profile = this.studentRepo.findByUsername(studentId);
    const displayName = profile?.displayName || studentId;

    this.enrollment.enroll(unitId, studentId, displayName);
    this.progress.ensure(unitId, studentId);
    this.createTeamOfOne(unitId, studentId); // every enrolled student is always on a team

    return { ok: true, alreadyJoined: false };
  }

  getUnitForEnrolled(unitId, studentId) {
    if (!this.enrollment.isEnrolled(unitId, studentId))
      throw new ServiceError('NOT_JOINED', 403);
    const unit = this.units.findById(unitId);
    if (!unit) throw new ServiceError('Unit not found', 404);
    return unit;
  }

  getAnnouncements(unitId, studentId) {
    if (!this.enrollment.isEnrolled(unitId, studentId))
      throw new ServiceError('NOT_JOINED', 403);
    return this.announcements.listForStudent(unitId);
  }

  getProgress(unitId, studentId) {
    return this.progress.get(unitId, studentId) || {
      read_rules: 0, entered_preferences: 0,
      in_team: 0, submitted_request: 0, teacher_approved: 0
    };
  }

  setProgressStage(unitId, studentId, stage, value) {
    if (!this.progress.constructor.TOGGLEABLE_STAGES.includes(stage))
      throw new ServiceError('Invalid stage', 400);
    this.progress.setStage(unitId, studentId, stage, value);
  }

  getTutorialSlots(unitId) {
    return this.slots.listForUnit(unitId);
  }

  getPrefs(unitId, studentId) {
    return this.prefs.get(unitId, studentId) || null;
  }

  savePrefs(unitId, studentId, body) {
    const { tutorialSlots, projectInterests, skills, preferredRole, preferredTeammates } = body;
    const csv = v => Array.isArray(v) ? v.join(',') : (v || '');
    this.prefs.upsert(unitId, studentId, {
      tutorialSlots: csv(tutorialSlots),
      projectInterests: csv(projectInterests),
      skills: csv(skills),
      preferredRole: preferredRole || '',
      preferredTeammates: preferredTeammates || 'None',
      savedAt: new Date().toISOString()
    });
    this.progress.markEnteredPreferences(unitId, studentId);
  }

  searchClassmates(unitId, studentId, { search, tutorial, interest, skill }) {
    let students = this.enrollment.listClassmates(unitId, studentId);
    if (search) {
      const q = search.toLowerCase();
      students = students.filter(s => s.name.toLowerCase().includes(q) || s.student_id.toLowerCase().includes(q));
    }
    if (tutorial) students = students.filter(s => (s.tutorial_slots || s.tutorial_time || '').includes(tutorial));
    if (interest) students = students.filter(s => (s.project_interests || '').includes(interest));
    if (skill)    students = students.filter(s => (s.skills || '').includes(skill));
    return students;
  }

  getMyTeam(unitId, studentId) {
    const membership = this.teams.findStudentTeam(unitId, studentId);
    if (!membership) return { team: null };

    const team = this.teams.findById(membership.team_id);
    const members = this.teams.getMembersDetailed(unitId, membership.team_id);
    const unit = this.units.findById(unitId);
    const validation = validateTeam(members, unit, { tutorialFallback: true });
    return { team, members, validation };
  }

  getTeamView(unitId, teamId) {
    const team = this.teams.findSummaryInUnit(teamId, unitId);
    if (!team) throw new ServiceError('Team not found', 404);

    const members = this.teams.getAcceptedMembersBasic(unitId, teamId);
    const unit = this.units.findById(unitId);
    const sizes = (unit?.valid_team_sizes || '4').split(',').map(s => parseInt(s.trim())).filter(Boolean);
    const maxSize = sizes.length ? Math.max(...sizes) : 4;
    return { team, members, maxSize };
  }

  // ── Proposals (delegated, with caller-team resolution) ───────────────────────
  createProposal(unitId, studentId, targetTeamId) {
    const callerTeam = this.teams.findStudentTeam(unitId, studentId);
    if (!callerTeam) throw new ServiceError('You are not on a team in this unit', 400);
    const result = this.proposalService.createProposal({
      unitId, sourceTeamId: callerTeam.team_id, targetTeamId, initiatorId: studentId,
    });
    return { proposalId: result.proposalId, state: result.state };
  }

  listProposals(unitId, studentId) {
    return this.proposalService.listProposalsForStudent(unitId, studentId);
  }

  getProposalDetail(unitId, proposalId, studentId) {
    return this.proposalService.getProposalDetail(unitId, proposalId, studentId);
  }

  castVote(proposalId, studentId, vote) {
    return this.proposalService.castVote({ proposalId, studentId, vote });
  }

  markProposalSeen(proposalId, studentId) {
    this.proposalService.markSeen({ proposalId, studentId });
  }

  // ── Membership mutations ─────────────────────────────────────────────────────
  kickMember(unitId, teamId, ownerId, kicked) {
    const team = this.teams.findOwned(teamId, ownerId);
    if (!team) throw new ServiceError('Only the team creator can remove members', 403);
    if (team.status !== 'FORMING') throw new ServiceError('Cannot modify a submitted team', 400);
    if (kicked === ownerId) throw new ServiceError('Use the leave endpoint to remove yourself', 400);
    if (!this.teams.getMembership(teamId, kicked))
      throw new ServiceError('Member not on this team', 404);

    this.proposalService.invalidateProposalsForStudent(kicked);
    this.teams.removeMember(teamId, kicked);
    this.createTeamOfOne(unitId, kicked);
  }

  leaveTeam(unitId, teamId, studentId) {
    const team = this.teams.findInUnit(teamId, unitId);
    if (!team) throw new ServiceError('Team not found', 404);
    if (team.status !== 'FORMING') throw new ServiceError('Cannot leave a submitted team', 400);
    if (!this.teams.getMembership(teamId, studentId))
      throw new ServiceError('You are not in this team', 400);
    if (this.teams.countMembers(teamId) <= 1)
      throw new ServiceError('You are not in a team with anyone to leave', 400);

    this.proposalService.invalidateProposalsForStudent(studentId);
    this.teams.removeMember(teamId, studentId);

    // If the leaver owned the team, hand ownership to a surviving member.
    if (team.created_by === studentId) {
      const remaining = this.teams.getMembers(teamId);
      const newOwner = remaining.find(m => m.status === 'ACCEPTED') || remaining[0];
      if (newOwner) this.teams.transferOwnership(teamId, newOwner.student_id);
    }

    this.createTeamOfOne(unitId, studentId);
  }

  submitTeam(unitId, teamId) {
    const team = this.teams.findInUnit(teamId, unitId);
    if (!team) throw new ServiceError('Team not found', 404);
    if (team.status !== 'FORMING') throw new ServiceError('Team has already been submitted', 400);

    const members = this.teams.getMembers(teamId);
    this.teams.markSubmitted(teamId, new Date().toISOString());
    members.forEach(m => this.progress.markSubmitted(unitId, m.student_id));

    // Submitting locks the team — invalidate any in-flight proposal it touches.
    this.proposalService.resolveOpenForTeam(teamId);
  }

  // Eager team-of-1 so every enrolled student is always on a team. Used on join,
  // and to re-home a student after they leave or are kicked.
  createTeamOfOne(unitId, studentId) {
    const role = this.prefs.getPreferredRole(unitId, studentId);
    const number = this.teams.nextTeamNumber(unitId);
    const teamId = crypto.randomUUID();
    this.teams.create(teamId, unitId, `Team ${number}`, number, studentId);
    this.teams.addMember(teamId, studentId, role);
    this.progress.markInTeam(unitId, studentId);
    return teamId;
  }
}

module.exports = StudentPortalService;

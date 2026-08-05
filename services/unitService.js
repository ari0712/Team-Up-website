const crypto = require('crypto');
const ServiceError = require('./ServiceError');
const { parseTeamSizesCsv } = require('../utils/teamSizes');
const { validateTeam } = require('../utils/teamValidator');

// CSV-field helpers for the tutorial-slot cascade rename / delete.
function csvReplace(csv, oldLabel, newLabel) {
  if (!csv) return '';
  const parts = csv.split(',').map(s => s.trim()).filter(Boolean);
  const replaced = parts.map(p => (p === oldLabel ? newLabel : p));
  return [...new Set(replaced)].join(',');
}
function csvRemove(csv, label) {
  if (!csv) return '';
  return csv.split(',').map(s => s.trim()).filter(s => s && s !== label).join(',');
}

// Orchestrates the teacher unit-management surface: units, class lists, progress,
// team review, announcements and tutorial slots. Business rules and ownership
// checks live here; routes stay thin.
class UnitService {
  constructor({ units, enrollment, roster, progress, teams, prefs, slots, announcements }) {
    this.units = units;
    this.enrollment = enrollment;
    this.roster = roster;
    this.progress = progress;
    this.teams = teams;
    this.prefs = prefs;
    this.slots = slots;
    this.announcements = announcements;
  }

  // Resolve a teacher-owned unit or throw 404 (used to scope every teacher action).
  _ownedOr404(unitId, teacherId) {
    const unit = this.units.findOwned(unitId, teacherId);
    if (!unit) throw new ServiceError('Unit not found', 404);
    return unit;
  }

  listUnits(teacherId) {
    return this.units.listForTeacher(teacherId);
  }

  listEnrolledUnits(studentId) {
    return this.units.listEnrolled(studentId);
  }

  getUnit(unitId, teacherId) {
    return this._ownedOr404(unitId, teacherId);
  }

  createUnit(teacherId, body) {
    const {
      unitName, description, semester, deadline,
      validTeamSizes, maxOneGroup, mustShareTutorial, maxNewToQut, students
    } = body;

    if (!unitName || !unitName.trim())
      throw new ServiceError('Unit name is required', 400);
    if (validTeamSizes !== undefined && parseTeamSizesCsv(validTeamSizes) === null)
      throw new ServiceError('validTeamSizes must be comma-separated positive integers', 400);

    const unitId = crypto.randomUUID();

    // Count only rows the roster will actually accept. `upsertMany` drops any
    // entry without a usable email, so counting raw rows made a unit advertise
    // students it had never admitted — an empty roster that looked populated.
    const roster = (Array.isArray(students) ? students : [])
      .filter(s => String(s?.email ?? '').trim().includes('@'));
    const studentCount = roster.length;

    this.units.create({
      unitId,
      unitName: unitName.trim(),
      description: (description || '').trim(),
      semester: (semester || '').trim(),
      deadline: (deadline || '').trim(),
      createdBy: teacherId,
      validTeamSizes: (validTeamSizes || '4'),
      maxOneGroup: maxOneGroup ? 1 : 0,
      mustShareTutorial: mustShareTutorial ? 1 : 0,
      maxNewToQut: parseInt(maxNewToQut) || 2,
      studentCount
    });

    let imported = { added: 0, skipped: 0 };
    if (roster.length > 0) {
      // The import builds the ROSTER (who may join), not the enrolment list.
      // Students become enrolled when they actually join, which is when the
      // roster attributes are copied onto their unit_students row.
      imported = this.roster.upsertMany(unitId, roster, new Date().toISOString());

      // Auto-create tutorial slots for any new labels seen in the import. The
      // class list is email-only today, so this stays dormant until the richer
      // spreadsheet arrives and starts carrying tutorial_time.
      const slotSet = new Set();
      roster.forEach(s => {
        (s.tutorial_time || '').split(',').map(x => x.trim())
          .filter(Boolean).forEach(x => slotSet.add(x));
      });
      if (slotSet.size > 0) {
        let nextOrder = this.slots.nextSortOrder(unitId);
        for (const label of [...slotSet].sort()) {
          if (this.slots.existsByLabel(unitId, label)) continue;
          this.slots.create(crypto.randomUUID(), unitId, label, nextOrder++);
        }
      }
    }

    // `ignored` tells the caller how many submitted rows carried no usable
    // email, so a silently-halved import can be surfaced instead of guessed at.
    return {
      ok: true, unitId,
      rostered: imported.added,
      ignored: (Array.isArray(students) ? students.length : 0) - imported.added
    };
  }

  getProgress(unitId, teacherId) {
    this._ownedOr404(unitId, teacherId);
    const stats = this.units.aggregateProgress(unitId);
    return {
      total:            this.enrollment.countForUnit(unitId),
      readRules:        stats.readRules        || 0,
      enteredPrefs:     stats.enteredPrefs      || 0,
      inTeam:           stats.inTeam            || 0,
      submittedRequest: stats.submittedRequest  || 0
    };
  }

  // Note: matches the original — no ownership check on this manual stage update.
  setStudentStage(unitId, studentId, stage, value) {
    if (!this.progress.constructor.TOGGLEABLE_STAGES.includes(stage))
      throw new ServiceError('Invalid stage name', 400);
    this.progress.setStage(unitId, studentId, stage, value);
  }

  getTeamRequests(unitId, teacherId) {
    this._ownedOr404(unitId, teacherId);
    const teams = this.teams.listByStatuses(unitId, ['SUBMITTED', 'APPROVED', 'REJECTED']);
    return teams.map(team => ({
      ...team,
      members: this.teams.getMembersBasic(unitId, team.team_id)
    }));
  }

  approveAll(unitId, teacherId) {
    this._ownedOr404(unitId, teacherId);
    return { ok: true, approved: this.teams.approveAllSubmitted(unitId) };
  }

  reviewTeam(unitId, teacherId, teamId, action) {
    if (!['approve', 'reject'].includes(action))
      throw new ServiceError('action must be approve or reject', 400);
    this._ownedOr404(unitId, teacherId);

    if (action === 'approve') {
      // A team can reach the teacher without ever being submitted — the students
      // never got round to it, or the deadline locked before they could. Record
      // the submission so submitted_at and the progress rows stay consistent with
      // a normally-submitted team, then approve.
      const team = this.teams.findById(teamId);
      if (team && !team.submitted_at)
        this.teams.markSubmitted(teamId, new Date().toISOString());
      this.teams.setStatus(teamId, 'APPROVED');
    } else {
      this.teams.setRejected(teamId, new Date().toISOString());
    }

    const members = this.teams.getMembers(teamId);
    if (action === 'approve') {
      members.forEach(m => {
        this.progress.ensure(unitId, m.student_id);
        this.progress.markSubmitted(unitId, m.student_id);
        this.progress.markTeacherApproved(unitId, m.student_id);
      });
    } else {
      // Reject sends the team back to FORMING so members can edit and resubmit.
      members.forEach(m => this.progress.clearSubmission(unitId, m.student_id));
    }
    return { ok: true };
  }

  getAllTeams(unitId, teacherId) {
    const unit = this._ownedOr404(unitId, teacherId);
    const teams = this.teams.listAllWithCounts(unitId);
    return teams.map(team => {
      const members = this.teams.getMembersDetailed(unitId, team.team_id);
      const validation = validateTeam(members, unit, { includeAllAccepted: true });
      return { ...team, members, validation };
    });
  }

  getClassList(unitId, teacherId) {
    this._ownedOr404(unitId, teacherId);
    return this.enrollment.listWithProgress(unitId);
  }

  getAnnouncements(unitId, teacherId) {
    this._ownedOr404(unitId, teacherId);
    return this.announcements.listForUnit(unitId);
  }

  postAnnouncement(unitId, teacherId, title, content) {
    this._ownedOr404(unitId, teacherId);
    if (!title || !title.trim()) throw new ServiceError('Title is required', 400);
    this.announcements.create(unitId, title.trim(), (content || '').trim(), new Date().toISOString());
    return { ok: true };
  }

  // ── Roster: who may join this unit ───────────────────────────────────────────
  // Returned with a `joined` flag so a teacher can see who has taken the place
  // up and who has not.
  getRoster(unitId, teacherId) {
    this._ownedOr404(unitId, teacherId);
    return this.roster.listForUnitWithJoined(unitId);
  }

  importRoster(unitId, teacherId, students) {
    this._ownedOr404(unitId, teacherId);
    if (!Array.isArray(students) || !students.length)
      throw new ServiceError('Provide at least one student', 400);
    const result = this.roster.upsertMany(unitId, students, new Date().toISOString());
    if (!result.added)
      throw new ServiceError('No valid email addresses found', 400);
    return { ok: true, ...result, total: this.roster.countForUnit(unitId) };
  }

  removeFromRoster(unitId, teacherId, email) {
    this._ownedOr404(unitId, teacherId);
    if (!email) throw new ServiceError('email is required', 400);
    this.roster.remove(unitId, email);
    return { ok: true, total: this.roster.countForUnit(unitId) };
  }

  updateRules(unitId, teacherId, body) {
    const unit = this._ownedOr404(unitId, teacherId);
    const { validTeamSizes, maxOneGroup, mustShareTutorial, maxNewToQut, deadline } = body;

    if (validTeamSizes !== undefined && parseTeamSizesCsv(validTeamSizes) === null)
      throw new ServiceError('validTeamSizes must be comma-separated positive integers', 400);

    this.units.updateRules(unitId, {
      validTeamSizes:    validTeamSizes || unit.valid_team_sizes,
      maxOneGroup:       maxOneGroup       !== undefined ? (maxOneGroup ? 1 : 0)       : unit.max_one_group,
      mustShareTutorial: mustShareTutorial !== undefined ? (mustShareTutorial ? 1 : 0) : unit.must_share_tutorial,
      maxNewToQut:       parseInt(maxNewToQut) || unit.max_new_to_qut,
      deadline:          deadline || unit.deadline
    });
    return { ok: true };
  }

  // ── Tutorial slots ───────────────────────────────────────────────────────────
  listTutorialSlots(unitId, teacherId) {
    this._ownedOr404(unitId, teacherId);
    return this.slots.listForUnit(unitId);
  }

  createTutorialSlot(unitId, teacherId, rawLabel) {
    this._ownedOr404(unitId, teacherId);
    const label = (rawLabel || '').trim();
    if (!label) throw new ServiceError('label is required', 400);
    if (this.slots.existsByLabel(unitId, label))
      throw new ServiceError('A slot with that label already exists', 409);

    const sortOrder = this.slots.nextSortOrder(unitId);
    const slotId = crypto.randomUUID();
    this.slots.create(slotId, unitId, label, sortOrder);
    return { slot_id: slotId, label, sort_order: sortOrder };
  }

  renameTutorialSlot(unitId, teacherId, slotId, rawLabel) {
    this._ownedOr404(unitId, teacherId);
    const slot = this.slots.findById(slotId, unitId);
    if (!slot) throw new ServiceError('Slot not found', 404);

    const newLabel = (rawLabel || '').trim();
    if (!newLabel) throw new ServiceError('label is required', 400);
    if (newLabel === slot.label) return { ok: true, unchanged: true };
    if (this.slots.hasCollision(unitId, newLabel, slotId))
      throw new ServiceError('Another slot already uses that label', 409);

    // Cascade the rename through student CSV fields (scoped to this unit).
    for (const r of this.enrollment.listTutorialTimes(unitId)) {
      const updated = csvReplace(r.tutorial_time, slot.label, newLabel);
      if (updated !== (r.tutorial_time || ''))
        this.enrollment.updateTutorialTime(unitId, r.student_id, updated);
    }
    for (const r of this.prefs.listTutorialSlots(unitId)) {
      const updated = csvReplace(r.tutorial_slots, slot.label, newLabel);
      if (updated !== (r.tutorial_slots || ''))
        this.prefs.updateTutorialSlots(unitId, r.student_id, updated);
    }

    this.slots.rename(slotId, newLabel);
    return { ok: true };
  }

  deleteTutorialSlot(unitId, teacherId, slotId) {
    this._ownedOr404(unitId, teacherId);
    const slot = this.slots.findById(slotId, unitId);
    if (!slot) throw new ServiceError('Slot not found', 404);

    for (const r of this.enrollment.listTutorialTimes(unitId)) {
      const updated = csvRemove(r.tutorial_time, slot.label);
      if (updated !== (r.tutorial_time || ''))
        this.enrollment.updateTutorialTime(unitId, r.student_id, updated);
    }
    for (const r of this.prefs.listTutorialSlots(unitId)) {
      const updated = csvRemove(r.tutorial_slots, slot.label);
      if (updated !== (r.tutorial_slots || ''))
        this.prefs.updateTutorialSlots(unitId, r.student_id, updated);
    }

    this.slots.remove(slotId);
    return { ok: true };
  }
}

module.exports = UnitService;

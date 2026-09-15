const crypto = require('crypto');
const ServiceError = require('./ServiceError');
const { validateTeam, targetSizeLabel } = require('../utils/teamValidator');
const { placementOf } = require('../utils/placement');
const { matchesStudent, normalise } = require('../utils/studentSearch');
const { CATEGORIES, CATEGORY_LABELS } = require('../utils/emailCategories');

// Classmate search rate limit: per (student, unit), sliding window.
//
// A real session is a handful of queries. A burst is someone walking the
// address space: the search matches full emails, so without a limit a script
// could confirm addresses one guess at a time.
//
// In-memory and per-process: it resets on restart and is NOT shared across
// instances. That matches the single-process sql.js deployment this app is.
// If TeamUp is ever run multi-instance it needs a shared store (see README,
// "Open decisions").
const SEARCH_LIMIT = 30;
const SEARCH_WINDOW_MS = 5 * 60 * 1000;
const { isLocked } = require('../utils/deadline');
const { ABOUT_FIELDS, ABOUT_MAX_LENGTH } = require('../utils/aboutFields');
const avatarStore = require('../utils/avatarStore');

// Orchestrates the student portal: enrollment, preferences, team membership and
// the team-up request flow. All business rules live here so the route handlers
// stay thin. Errors are thrown as ServiceError and translated to HTTP by the
// router.
//
// There is no "submit" step. An accepted team-up request is the record, and
// the unit's deadline is the only thing that freezes a student's group; the
// coordinator's FINALISED status is an override, never a required step.
class StudentPortalService {
  constructor({ units, enrollment, roster, progress, prefs, teams, slots, studentRepo,
                teamRequestService, notificationService, matchingService, emailPrefs = null }) {
    this.emailPrefs = emailPrefs;
    this.notificationService = notificationService;
    this.matchingService = matchingService;
    this.roster = roster;
    this.units = units;
    this.enrollment = enrollment;
    this.progress = progress;
    this.prefs = prefs;
    this.teams = teams;
    this.slots = slots;
    this.studentRepo = studentRepo;
    this.requests = teamRequestService;
  }

  // Only units the student's email appears on the roster for. A unit with no
  // roster is invisible to everyone until its teacher adds a class list.
  listUnits(studentId) {
    const profile = this.studentRepo.findByUsername(studentId);
    return this.units.listRosteredWithJoinedFlag(studentId, profile?.email);
  }

  joinUnit(unitId, studentId) {
    const unit = this.units.findById(unitId);
    if (!unit) throw new ServiceError('Unit not found', 404);

    if (this.enrollment.isEnrolled(unitId, studentId)) {
      return { ok: true, alreadyJoined: true };
    }

    const profile = this.studentRepo.findByUsername(studentId);

    // The real access check. Hiding the unit from the list is presentation;
    // this is what actually stops someone posting a join for a unit id they
    // were never invited to.
    const entry = this.roster.findByEmail(unitId, profile?.email);
    if (!entry) throw new ServiceError('NOT_INVITED', 403);

    const displayName = entry.name || profile?.displayName || studentId;
    this.enrollment.enrollFromRoster(unitId, studentId, entry, displayName);
    this.progress.ensure(unitId, studentId);
    this.createTeamOfOne(unitId, studentId); // every enrolled student is always on a team
    // From this moment their notifications are live; anything older is history.
    this.notificationService.seedStudent(unitId, studentId);

    return { ok: true, alreadyJoined: false };
  }

  getUnitForEnrolled(unitId, studentId) {
    if (!this.enrollment.isEnrolled(unitId, studentId))
      throw new ServiceError('NOT_JOINED', 403);
    const unit = this.units.findById(unitId);
    if (!unit) throw new ServiceError('Unit not found', 404);
    return unit;
  }

  // Every per-unit read and write goes through this. requireStudent only proves
  // the caller is A student — not that they are in THIS unit — and an id in
  // the URL is not a credential.
  _assertEnrolled(unitId, studentId) {
    if (!this.enrollment.isEnrolled(unitId, studentId))
      throw new ServiceError('NOT_JOINED', 403);
  }

  // Two stages the student performs (stored) and two the system derives —
  // grouped/declared from placement, finalised from the team's status — so the
  // nav ticks can never disagree with the class list or the export.
  getProgress(unitId, studentId) {
    this._assertEnrolled(unitId, studentId);
    const stored = this.progress.get(unitId, studentId) || {};
    const { placement, team } = this._standing(unitId, studentId);
    return {
      read_rules:          stored.read_rules ? 1 : 0,
      entered_preferences: stored.entered_preferences ? 1 : 0,
      grouped:             placement === 'GROUPED' || placement === 'DECLARED' ? 1 : 0,
      finalised:           team?.status === 'FINALISED' ? 1 : 0,
      placement
    };
  }

  // The student's team row, accepted-member count and placement, in one place.
  _standing(unitId, studentId) {
    const noPreferenceAt = this.enrollment.getNoPreferenceAt(unitId, studentId);
    const membership = this.teams.findStudentTeam(unitId, studentId);
    const team = membership ? this.teams.findById(membership.team_id) : null;
    const acceptedCount = team
      ? this.teams.getMembers(team.team_id).filter(m => m.status === 'ACCEPTED').length : 0;
    return { team, acceptedCount, noPreferenceAt,
             placement: placementOf({ acceptedCount, noPreferenceAt }) };
  }

  setProgressStage(unitId, studentId, stage, value) {
    this._assertEnrolled(unitId, studentId);
    if (!this.progress.constructor.TOGGLEABLE_STAGES.includes(stage))
      throw new ServiceError('Invalid stage', 400);
    this.progress.setStage(unitId, studentId, stage, value);
  }

  getTutorialSlots(unitId, studentId) {
    this._assertEnrolled(unitId, studentId);
    return this.slots.listForUnit(unitId);
  }

  getPrefs(unitId, studentId) {
    this._assertEnrolled(unitId, studentId);
    return this.prefs.get(unitId, studentId) || null;
  }

  // ── Full student profile (own or a classmate's) ─────────────────────────────

  // Everything the full-profile page needs for one student, in one call.
  //
  // The About Me answers come back as an ordered [{ key, label, value }] list
  // rather than loose columns, so the page renders whatever it is given and the
  // prompts stay defined in exactly one place (utils/aboutFields.js).
  //
  // Deliberately per-student: listClassmates is a whole-class fanout feeding the
  // Find Teammates list, and seven text blobs each do not belong in it.
  getStudentProfile(unitId, viewerId, studentId) {
    if (!this.enrollment.isEnrolled(unitId, viewerId))
      throw new ServiceError('NOT_JOINED', 403);
    if (!this.enrollment.isEnrolled(unitId, studentId))
      throw new ServiceError('That student is not in this unit', 404);

    const prefs = this.prefs.get(unitId, studentId) || {};
    const account = this.studentRepo.findByUsername(studentId);

    const isSelf = studentId === viewerId;
    return {
      studentId,
      isSelf,
      name: this.enrollment.getName(unitId, studentId) || studentId,
      // Your own address, never a classmate's: a classmate's email reaches a
      // viewer through exactly one path — the shared-name case on the Find
      // Teammates card. The student number is never returned here.
      ...(isSelf ? { email: account?.email || '' } : {}),

      avatarPath: account?.avatarPath || '',
      preferredRole: prefs.preferred_role || '',
      tutorialSlots: prefs.tutorial_slots || '',
      projectInterests: prefs.project_interests || '',
      skills: prefs.skills || '',
      about: ABOUT_FIELDS.map(f => ({ ...f, value: prefs[f.key] || '' })),
    };
  }

  // Saves the About Me text. Every field is optional, so an all-blank save is
  // valid and simply clears them.
  //
  // No arePrefsLocked check, by design: this text feeds neither validateTeam nor
  // matching, so freezing it when the team is submitted would only stop students
  // introducing themselves to teammates they have just committed to.
  saveAbout(unitId, studentId, body) {
    if (!this.enrollment.isEnrolled(unitId, studentId))
      throw new ServiceError('NOT_JOINED', 403);

    const about = {};
    for (const { key, label } of ABOUT_FIELDS) {
      const value = String(body?.[key] ?? '').trim();
      if (value.length > ABOUT_MAX_LENGTH)
        throw new ServiceError(
          `"${label}" is ${value.length} characters; the limit is ${ABOUT_MAX_LENGTH}.`, 400);
      about[key] = value;
    }

    this.prefs.upsertAbout(unitId, studentId, about);
    return { ok: true };
  }

  // The picture belongs to the person, not to any one unit, so this is not
  // unit-scoped. Writes the new file first, then repoints the row, then deletes
  // the old file — that order means a failure anywhere leaves the student with a
  // picture that still exists, never a row pointing at a deleted file.
  saveAvatar(studentId, dataUrl) {
    let avatarPath;
    try { avatarPath = avatarStore.save(dataUrl); }
    catch (e) { throw new ServiceError(e.message, 400); }

    const previous = this.studentRepo.getAvatarPath(studentId);
    this.studentRepo.setAvatarPath(studentId, avatarPath);
    if (previous && previous !== avatarPath) avatarStore.remove(previous);
    return { ok: true, avatarPath };
  }

  clearAvatar(studentId) {
    const previous = this.studentRepo.getAvatarPath(studentId);
    this.studentRepo.setAvatarPath(studentId, '');
    avatarStore.remove(previous);
    return { ok: true, avatarPath: '' };
  }

  // Preferences freeze only once the coordinator finalises the team. Until
  // then they stay editable — but see savePrefs: an edit that would put a
  // recorded group in breach of a rule is refused, not silently allowed.
  arePrefsLocked(unitId, studentId) {
    const membership = this.teams.findStudentTeam(unitId, studentId);
    if (!membership) return false;
    return this.teams.findById(membership.team_id)?.status === 'FINALISED';
  }

  // Every field is required. Enforced here rather than only in the page,
  // because entering preferences marks a progress stage that
  // the teacher's readiness view and the team-formation flow both trust — an
  // empty save used to set that flag and make a student look ready when the
  // data the matching depends on did not exist.
  savePrefs(unitId, studentId, body) {
    this._assertEnrolled(unitId, studentId);
    // Once the request is with the teacher, the preferences the team was built
    // and validated against must stop moving underneath it. Approval keeps them
    // locked rather than releasing them — an approved team is final.
    if (this.arePrefsLocked(unitId, studentId))
      throw new ServiceError('PREFS_LOCKED', 403, 'PREFS_LOCKED');

    const { tutorialSlots, projectInterests, skills, preferredRole } = body;
    const csv = v => Array.isArray(v) ? v.join(',') : (v || '');

    const missing = [];
    // Only required when the teacher has actually published slots — otherwise
    // there is nothing to select and the student could never save.
    if (this.slots.listForUnit(unitId).length && !csv(tutorialSlots))
      missing.push('tutorial availability');
    if (!csv(projectInterests)) missing.push('at least one project interest');
    if (!csv(skills))           missing.push('at least one skill');
    if (!String(preferredRole || '').trim()) missing.push('a preferred role');

    if (missing.length) {
      const list = missing.length === 1 ? missing[0]
        : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
      throw new ServiceError(`Please choose ${list} before saving.`, 400);
    }

    // A recorded group must not drift into violation because one member
    // changed their availability. Evaluate the group with the new value in
    // place and refuse the edit if a rule would break — the student is told
    // which rule and why, and can leave the group first if they mean it.
    const { team, acceptedCount } = this._standing(unitId, studentId);
    if (team && acceptedCount >= 2) {
      const unit = this.units.findById(unitId);
      const members = this.teams.getMembersDetailed(unitId, team.team_id)
        .map(m => m.student_id === studentId ? { ...m, tutorial_slots: csv(tutorialSlots) } : m);
      const v = validateTeam(members, unit, { tutorialFallback: true, includeAllAccepted: true });
      if (v.violations.length) {
        const x = v.violations[0];
        throw new ServiceError(
          `${x.rule} — ${x.why}. Leave the group first if you need to change this.`,
          400, 'PREFS_WOULD_BREAK_GROUP');
      }
    }

    this.prefs.upsert(unitId, studentId, {
      tutorialSlots: csv(tutorialSlots),
      projectInterests: csv(projectInterests),
      skills: csv(skills),
      preferredRole: preferredRole || '',
      savedAt: new Date().toISOString()
    });
    this.progress.markEnteredPreferences(unitId, studentId);
  }

  _searchAllowed(unitId, studentId) {
    if (!this._searchHits) this._searchHits = new Map();
    const key = `${unitId}|${studentId}`;
    const now = Date.now();
    const hits = (this._searchHits.get(key) || []).filter(t => now - t < SEARCH_WINDOW_MS);
    hits.push(now);
    this._searchHits.set(key, hits);
    return hits.length <= SEARCH_LIMIT ? null : hits.length;
  }

  // Name matching is tolerant; email matching is exact on the full address
  // (utils/studentSearch.js). What comes BACK is governed separately:
  //
  //   - a classmate's email is attached only when two or more rows in the
  //     result share the same normalised name — the one case where the name
  //     cannot tell them apart;
  //   - a row found by its email is returned WITHOUT the email: the searcher
  //     typed it, so echoing it back adds nothing and would confirm a guess;
  //   - every other row has the email removed before it leaves the server.
  //
  // The student number is never in these rows at all.
  searchClassmates(unitId, studentId, { search, tutorial, interest, skill, available }) {
    this._assertEnrolled(unitId, studentId);
    const over = this._searchAllowed(unitId, studentId);
    if (over) {
      // Username and unit only — never the query text.
      console.warn('Classmate search rate-limited', { unitId, studentId, count: over });
      throw new ServiceError(
        'Too many searches — try again in a few minutes.', 429, 'SEARCH_RATE_LIMITED');
    }
    let students = this.enrollment.listClassmates(unitId, studentId);
    // "Available" mirrors exactly what sendRequest will accept: the other
    // team must not be finalised, and it must not already be your own team.
    // Anything else renders an "Ask to team up" button that is guaranteed to fail.
    //
    // Opt-in, because the classmate profile page reads this same endpoint and
    // must still resolve a student whose team has since been submitted.
    // A student with no team at all is left in: they already render with a
    // disabled "No team yet" button rather than a broken action.
    if (available) {
      const myTeamId = this.teams.findStudentTeam(unitId, studentId)?.team_id;
      students = students.filter(s =>
        s.team_status !== 'FINALISED' &&
        (!myTeamId || s.team_id !== myTeamId)
      );
    }
    if (search) {
      students = students
        .map(s => ({ s, m: matchesStudent(search, s) }))
        .filter(x => x.m.match)
        .sort((a, b) => (b.m.score - a.m.score) ||
                        String(a.s.name || '').localeCompare(String(b.s.name || '')))
        .map(x => x.s);
    }
    if (tutorial) students = students.filter(s => (s.tutorial_slots || s.tutorial_time || '').includes(tutorial));
    if (interest) students = students.filter(s => (s.project_interests || '').includes(interest));
    if (skill)    students = students.filter(s => (s.skills || '').includes(skill));

    // Display rule: email survives only where names collide within this result.
    const byName = new Map();
    for (const s of students) {
      const k = normalise(s.name || '');
      byName.set(k, (byName.get(k) || 0) + 1);
    }
    return students.map(s => {
      const shared = byName.get(normalise(s.name || '')) > 1;
      const { email, ...rest } = s;
      return shared ? { ...rest, email, shared_name: true } : rest;
    });
  }

  // Re-validates the group on every read. A group that was feasible when it
  // formed can be put in breach by a later rule or slot change; the student
  // must learn that here, with the rule named, never by being dissolved.
  getMyTeam(unitId, studentId) {
    this._assertEnrolled(unitId, studentId);
    const { team, noPreferenceAt, placement } = this._standing(unitId, studentId);
    if (!team) return { team: null, noPreferenceAt, placement };

    const members = this.teams.getMembersDetailed(unitId, team.team_id);
    const unit = this.units.findById(unitId);
    const validation = validateTeam(members, unit, { tutorialFallback: true });
    return { team, members, validation, noPreferenceAt, placement,
             targetSizeLabel: targetSizeLabel(unit) };
  }

  // ── "I have no preferred teammates — place me anywhere" ─────────────────────
  // A declaration, not a group submission: there is no mutual preference to
  // record, so it is the solo student's way of saying they are done. Only a
  // student who is actually alone can make it — someone in a group has a group
  // to submit instead. Deliberately still allowed after the deadline: a late
  // declaration still tells the coordinator something useful.
  declareNoPreference(unitId, studentId) {
    this._assertEnrolled(unitId, studentId);
    const membership = this.teams.findStudentTeam(unitId, studentId);
    const team = membership ? this.teams.findById(membership.team_id) : null;
    const accepted = team ? this.teams.countMembers(team.team_id) : 0;
    if (team && team.status === 'FINALISED')
      throw new ServiceError('Your team has been finalised by your coordinator', 400, 'FINALISED');
    if (accepted >= 2)
      throw new ServiceError(
        'You are in a group — submit the group instead, or leave it first', 400, 'NOT_SOLO');

    const at = new Date().toISOString();
    this.enrollment.setNoPreference(unitId, studentId, at);
    return { ok: true, noPreferenceAt: at };
  }

  withdrawNoPreference(unitId, studentId) {
    this._assertEnrolled(unitId, studentId);
    this.enrollment.setNoPreference(unitId, studentId, '');
    return { ok: true, noPreferenceAt: '' };
  }

  getTeamView(unitId, teamId, viewerId) {
    this._assertEnrolled(unitId, viewerId);
    const team = this.teams.findSummaryInUnit(teamId, unitId);
    if (!team) throw new ServiceError('Team not found', 404);

    const members = this.teams.getAcceptedMembersBasic(unitId, teamId);
    const unit = this.units.findById(unitId);
    const sizes = (unit?.valid_team_sizes || '4').split(',').map(s => parseInt(s.trim())).filter(Boolean);
    const maxSize = sizes.length ? Math.max(...sizes) : 4;
    return { team, members, maxSize };
  }

  // Ranked team-up suggestions for this student. Gated by the same lock as
  // sendRequest — recommending a team-up the student cannot act on would be
  // worse than offering nothing.
  autoMatch(unitId, studentId) {
    this._assertOpen(unitId);
    return this.matchingService.suggestForStudent(unitId, studentId);
  }

  // ── Team-up requests (delegated, with caller-team resolution) ────────────────
  sendRequest(unitId, studentId, targetTeamId) {
    this._assertOpen(unitId);
    const callerTeam = this.teams.findStudentTeam(unitId, studentId);
    if (!callerTeam) throw new ServiceError('You are not on a team in this unit', 400);
    const result = this.requests.sendRequest({
      unitId, sourceTeamId: callerTeam.team_id, targetTeamId, initiatorId: studentId,
    });
    // Produce now, not on the next timer tick: the recipient's "new request"
    // row exists immediately, and a request born with under a day of runway
    // gets its expiry warning at once. Idempotent, so the timer re-running it
    // changes nothing.
    try { this.notificationService.syncRequest(unitId, result.requestId); }
    catch (e) { console.error('Notification sync after request failed:', e.message); }
    return { requestId: result.requestId, state: result.state };
  }

  listRequests(unitId, studentId) {
    return this.requests.listRequestsForStudent(unitId, studentId);
  }

  getRequestDetail(unitId, requestId, studentId) {
    return this.requests.getRequestDetail(unitId, requestId, studentId);
  }

  // Guarded as tightly as sendRequest: without this, a request sent before the
  // deadline could still be accepted afterwards and join two teams.
  respondToRequest(requestId, studentId, response) {
    const request = this.requests.getRequest(requestId);
    if (request) this._assertOpen(request.unit_id);
    return this.requests.respondToRequest({ proposalId: requestId, studentId, response });
  }

  markRequestSeen(requestId, studentId) {
    this.requests.markRequestSeen({ proposalId: requestId, studentId });
  }

  // Once the deadline passes the teacher takes over team formation, so the
  // student-side actions that change team membership stop. Preferences and
  // joining are deliberately still allowed.
  _assertOpen(unitId) {
    const unit = this.units.findById(unitId);
    if (isLocked(unit)) {
      throw new ServiceError('DEADLINE_PASSED', 403, 'DEADLINE_PASSED');
    }
  }

  // ── Email preferences (per unit, per category) ───────────────────────────────
  getEmailPrefs(unitId, studentId) {
    this._assertEnrolled(unitId, studentId);
    const account = this.studentRepo.findByUsername(studentId);
    const master = this.notificationService.getPrefs(studentId);
    return {
      categories: this.emailPrefs.get(studentId, unitId),
      labels: CATEGORY_LABELS,
      emailEnabled: master.emailEnabled,
      deliveringTo: master.deliveringTo || account?.email || ''
    };
  }

  saveEmailPrefs(unitId, studentId, body = {}) {
    this._assertEnrolled(unitId, studentId);
    const at = new Date().toISOString();
    for (const c of CATEGORIES) {
      if (body[c] === undefined) continue;
      this.emailPrefs.set(studentId, unitId, c, !!body[c], at);
    }
    return this.getEmailPrefs(unitId, studentId);
  }

  // The unsubscribe link: token instead of a login. Returns what was switched
  // off, or null for a token that matches nobody (the page says "link not
  // valid" either way and never reveals whether the token existed).
  unsubscribeByToken(token, unitId, category) {
    if (!CATEGORIES.includes(category)) return null;
    const owner = this.notificationService.findUserByUnsubscribeToken(token);
    if (!owner) return null;
    if (!this.enrollment.isEnrolled(unitId, owner.username)) return null;
    this.emailPrefs.set(owner.username, unitId, category, false, new Date().toISOString());
    return { unitId, category, label: CATEGORY_LABELS[category] };
  }

  // ── Notifications (delegated) ────────────────────────────────────────────────
  // Both reads run the producer for the unit first, so the enrolment check has
  // to come before them: an outsider must not be able to trigger it.
  listNotifications(unitId, studentId) {
    this._assertEnrolled(unitId, studentId);
    return this.notificationService.list(unitId, studentId);
  }

  unreadNotificationCount(unitId, studentId) {
    this._assertEnrolled(unitId, studentId);
    return this.notificationService.unreadCount(unitId, studentId);
  }

  markNotificationRead(unitId, studentId, id) {
    return this.notificationService.markRead(unitId, studentId, id);
  }

  markAllNotificationsRead(unitId, studentId) {
    return this.notificationService.markAllRead(unitId, studentId);
  }

  // ── Membership mutations ─────────────────────────────────────────────────────
  kickMember(unitId, teamId, ownerId, kicked) {
    // Scoped to the unit in the URL first. The lock check and the kicked
    // student's replacement team both key off unitId, so a team from another
    // unit must never get this far — it would dodge that unit's deadline and
    // create the new team-of-one in the wrong unit.
    if (!this.teams.findInUnit(teamId, unitId)) throw new ServiceError('Team not found', 404);
    this._assertOpen(unitId);
    const team = this.teams.findOwned(teamId, ownerId);
    if (!team) throw new ServiceError('Only the team creator can remove members', 403);
    if (team.status === 'FINALISED')
      throw new ServiceError('Your team has been finalised by your coordinator', 400, 'FINALISED');
    if (kicked === ownerId) throw new ServiceError('Use the leave endpoint to remove yourself', 400);
    if (!this.teams.getMembership(teamId, kicked))
      throw new ServiceError('Member not on this team', 404);

    this.requests.invalidateRequestsForStudent(kicked);
    this.teams.removeMember(teamId, kicked);
    this.createTeamOfOne(unitId, kicked);
  }

  leaveTeam(unitId, teamId, studentId) {
    this._assertOpen(unitId);
    const team = this.teams.findInUnit(teamId, unitId);
    if (!team) throw new ServiceError('Team not found', 404);
    if (team.status === 'FINALISED')
      throw new ServiceError('Your team has been finalised by your coordinator', 400, 'FINALISED');
    if (!this.teams.getMembership(teamId, studentId))
      throw new ServiceError('You are not in this team', 400);
    if (this.teams.countMembers(teamId) <= 1)
      throw new ServiceError('You are not in a team with anyone to leave', 400);

    this.requests.invalidateRequestsForStudent(studentId);
    this.teams.removeMember(teamId, studentId);

    // If the leaver owned the team, hand ownership to a surviving member.
    if (team.created_by === studentId) {
      const remaining = this.teams.getMembers(teamId);
      const newOwner = remaining.find(m => m.status === 'ACCEPTED') || remaining[0];
      if (newOwner) this.teams.transferOwnership(teamId, newOwner.student_id);
    }

    this.createTeamOfOne(unitId, studentId);
  }

  // Every enrolled student is always on a team — see TeamRepository.createTeamOfOne.

  createTeamOfOne(unitId, studentId) {

    return this.teams.createTeamOfOne(unitId, studentId, this.prefs.getPreferredRole(unitId, studentId));

  }

}



module.exports = StudentPortalService;

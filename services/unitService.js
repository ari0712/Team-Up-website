const crypto = require('crypto');
const ServiceError = require('./ServiceError');
const { parseTeamSizesCsv } = require('../utils/teamSizes');
const { validateTeam, targetSizeLabel } = require('../utils/teamValidator');
const { placementOf, PLACEMENTS, PLACEMENT_LABELS } = require('../utils/placement');
const { isLocked } = require('../utils/deadline');
const { AT_RISK_CHOICES, AT_RISK_DEFAULT } = require('./notificationService');

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
// the coordinator's overrides, the export and tutorial slots.
// Business rules and ownership checks live here; routes stay thin.
//
// The coordinator never approves individual teams. Groups record themselves
// when a team-up request is accepted by everyone; what the coordinator has is
// VISIBILITY over all of it and an exception-path OVERRIDE: finalise / reopen /
// dissolve one team, or finalise a whole grouping from the organiser and
// revert that batch as a unit.
class UnitService {
  constructor({ units, enrollment, roster, progress, teams, prefs, slots,
                batches, teamRequestService, userRepo }) {
    this.users = userRepo;
    this.units = units;
    this.enrollment = enrollment;
    this.roster = roster;
    this.progress = progress;
    this.teams = teams;
    this.prefs = prefs;
    this.slots = slots;
    this.batches = batches;
    this.requests = teamRequestService;
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

  // Auto-create tutorial slots for any label seen in an import that the unit
  // does not have yet. Shared by unit creation and later roster top-ups so a
  // student imported in the second batch is not left with a tutorial time the
  // unit has no matching slot for.
  _ensureTutorialSlots(unitId, entries) {
    const slotSet = new Set();
    for (const s of entries || []) {
      (s.tutorial_time || '').split(',').map(x => x.trim())
        .filter(Boolean).forEach(x => slotSet.add(x));
    }
    if (!slotSet.size) return;
    let nextOrder = this.slots.nextSortOrder(unitId);
    for (const label of [...slotSet].sort()) {
      if (this.slots.existsByLabel(unitId, label)) continue;
      this.slots.create(crypto.randomUUID(), unitId, label, nextOrder++);
    }
  }

  // What a delete would remove. Read-only, so the confirmation dialog can name
  // real numbers instead of a generic warning.
  getDeleteImpact(unitId, teacherId) {
    const unit = this._ownedOr404(unitId, teacherId);
    return { unitName: unit.unit_name, ...this.units.countDependents(unitId) };
  }

  // Permanently removes a unit and every record scoped to it. Ownership-checked
  // like every other teacher action, so a unit can only ever be deleted by the
  // teacher who created it.
  deleteUnit(unitId, teacherId) {
    const unit = this._ownedOr404(unitId, teacherId);
    const removed = this.units.countDependents(unitId);
    this.units.deleteCascade(unitId);
    return { ok: true, unitName: unit.unit_name, removed };
  }

  createUnit(teacherId, body) {
    const {
      unitName, description, semester, deadline,
      validTeamSizes, students
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
      // Mandatory for every unit, so the request body is not consulted.
      maxOneGroup: 1,
      mustShareTutorial: 1,
      studentCount
    });

    let imported = { added: 0, skipped: 0 };
    if (roster.length > 0) {
      // The import builds the ROSTER (who may join), not the enrolment list.
      // Students become enrolled when they actually join, which is when the
      // roster attributes are copied onto their unit_students row.
      imported = this.roster.upsertMany(unitId, roster, new Date().toISOString());

      this._ensureTutorialSlots(unitId, roster);
    }

    // `ignored` tells the caller how many submitted rows carried no usable
    // email, so a silently-halved import can be surfaced instead of guessed at.
    return {
      ok: true, unitId,
      rostered: imported.added,
      ignored: (Array.isArray(students) ? students.length : 0) - imported.added
    };
  }

  // Aggregate counts for the dashboard. The two stored stages come from
  // student_progress; grouped/declared and finalised are derived from teams,
  // never stored, so this cannot drift from the class list.
  getProgress(unitId, teacherId) {
    this._ownedOr404(unitId, teacherId);
    const stats = this.units.aggregateProgress(unitId);
    const students = this._classListWithPlacement(unitId);
    return {
      total:        students.length,
      readRules:    stats.readRules    || 0,
      enteredPrefs: stats.enteredPrefs || 0,
      grouped:      students.filter(s => s.placement === 'GROUPED').length,
      declared:     students.filter(s => s.placement === 'DECLARED').length,
      silent:       students.filter(s => s.placement === 'SILENT').length,
      finalised:    students.filter(s => s.team_status === 'FINALISED').length
    };
  }

  setStudentStage(unitId, teacherId, studentId, stage, value) {
    this._ownedOr404(unitId, teacherId);
    if (!this.progress.constructor.TOGGLEABLE_STAGES.includes(stage))
      throw new ServiceError('Invalid stage name', 400);
    this.progress.setStage(unitId, studentId, stage, value);
  }

  // ── Coordinator override: one team ───────────────────────────────────────────
  //   finalise  OPEN → FINALISED. Refused if the team currently breaks a hard
  //             rule (a rule or slot edit can do that to a recorded group).
  //   reopen    FINALISED → OPEN. Students can change it again only while the
  //             deadline has not passed; after that the coordinator dissolves
  //             or uses the organiser.
  //   dissolve  any → every member re-homed to a team of one. The one
  //             sanctioned way to split a group; declarations are untouched.
  overrideTeam(unitId, teacherId, teamId, action) {
    if (!['finalise', 'reopen', 'dissolve'].includes(action))
      throw new ServiceError('action must be finalise, reopen or dissolve', 400);
    const unit = this._ownedOr404(unitId, teacherId);
    const team = this.teams.findInUnit(teamId, unitId);
    if (!team) throw new ServiceError('Team not found', 404);
    const now = new Date().toISOString();

    if (action === 'finalise') {
      if (team.status === 'FINALISED') return { ok: true, status: 'FINALISED', unchanged: true };
      const members = this.teams.getMembersDetailed(unitId, teamId);
      const v = validateTeam(members, unit, { includeAllAccepted: true, tutorialFallback: true });
      if (v.violations.length)
        throw new ServiceError(
          `${team.team_name} cannot be finalised: ${v.violations[0].rule} — ${v.violations[0].why}`,
          400, 'TEAM_CONSTRAINT');
      this.teams.setFinalised(teamId, now, '');
      this.requests.resolveOpenForTeam(teamId);
      return { ok: true, status: 'FINALISED' };
    }

    if (action === 'reopen') {
      if (team.status !== 'FINALISED')
        throw new ServiceError('Only a finalised team can be reopened', 400);
      this.teams.setReopened(teamId, now);
      return { ok: true, status: 'OPEN' };
    }

    // dissolve
    const members = this.teams.getMembers(teamId);
    for (const m of members) {
      this.requests.invalidateRequestsForStudent(m.student_id);
      this.teams.removeMember(teamId, m.student_id);
      this.teams.createTeamOfOne(unitId, m.student_id, this.prefs.getPreferredRole(unitId, m.student_id));
    }
    this.teams.deleteIfEmpty(teamId);
    return { ok: true, status: 'DISSOLVED', students: members.map(m => m.student_id) };
  }

  // ── Coordinator override: a whole grouping, as one batch ─────────────────────
  // Everything the organiser saves goes through here. The snapshot is taken
  // BEFORE anything changes and is what revertFinaliseBatch restores: the
  // affected teams' rows, their memberships, and each affected student's
  // "place me anywhere" declaration.
  //
  // Enforced whoever built the payload: every student enrolled and at most
  // once; a protected group (OPEN, 2+, no violation) wholly inside one payload
  // group or wholly absent; every payload group passes the hard rules. Being
  // under the target size is NOT checked — a group of 3 is a legitimate outcome.
  finaliseTeams(unitId, teacherId, groups) {
    const unit = this._ownedOr404(unitId, teacherId);
    if (!isLocked(unit))
      throw new ServiceError('Teams can only be finalised after the deadline has passed', 403, 'DEADLINE_NOT_PASSED');
    if (!Array.isArray(groups) || !groups.length)
      throw new ServiceError('Provide at least one team', 400);

    const students = this.enrollment.listWithProgress(unitId);
    const byId = new Map(students.map(s => [s.student_id, s]));
    const seen = new Set();
    const clean = [];
    for (const g of groups) {
      if (!Array.isArray(g) || !g.length) continue;
      const ids = [];
      for (const sid of g) {
        if (!byId.has(sid)) throw new ServiceError(`${sid} is not enrolled in this unit`, 400);
        if (seen.has(sid)) throw new ServiceError(`${sid} appears in more than one team`, 400);
        seen.add(sid);
        ids.push(sid);
      }
      clean.push(ids);
    }
    if (!clean.length) throw new ServiceError('Provide at least one team', 400);

    // ── Split invariant ──
    const groupOf = new Map();
    clean.forEach((ids, i) => ids.forEach(sid => groupOf.set(sid, i)));
    const allTeams = this.teams.listWithMembersDetailed(unitId);
    const seedByGroup = new Map();     // payload group index → the protected team row it contains
    for (const t of allTeams) {
      if (t.status === 'FINALISED') {
        // A finalised team is settled; the payload must leave it alone.
        const touched = t.members.some(m => groupOf.has(m.student_id));
        if (touched)
          throw new ServiceError(`${t.team_name} is already finalised. Reopen it first.`, 400, 'ALREADY_FINALISED');
        continue;
      }
      const guard = this._isProtected(t, unit);
      if (!guard.protected) continue;
      const accepted = t.members.filter(m => m.status === 'ACCEPTED').map(m => m.student_id);
      const placed = accepted.map(sid => groupOf.get(sid)).filter(i => i !== undefined);
      if (!placed.length) continue;                                  // wholly absent: untouched
      if (placed.length !== accepted.length || new Set(placed).size !== 1)
        throw new ServiceError(
          `Cannot split ${t.team_name}: its members teamed up together. Dissolve the team first if you need to separate them.`,
          400, 'SPLITS_PROTECTED_GROUP');
      const idx = placed[0];
      const current = seedByGroup.get(idx);
      if (!current || (t.team_number || 0) < (current.team_number || 0)) seedByGroup.set(idx, t);
    }

    // ── Hard rules on every group ──
    clean.forEach((ids, i) => {
      const shaped = ids.map(sid => {
        const st = byId.get(sid);
        return { student_id: sid, name: st.name, status: 'ACCEPTED',
                 tutorial_slots: st.tutorial_slots, tutorial_time: st.tutorial_time };
      });
      const v = validateTeam(shaped, unit, { includeAllAccepted: true, tutorialFallback: true });
      if (v.violations.length) {
        const x = v.violations[0];
        throw new ServiceError(
          `Team ${i + 1} (${shaped.map(m => m.name || m.student_id).join(', ')}): ${x.rule} — ${x.why}`,
          400, 'TEAM_CONSTRAINT');
      }
    });

    // ── Snapshot, then write, in one transaction-shaped sequence ──
    const affected = new Set();
    for (const t of allTeams) if (t.members.some(m => seen.has(m.student_id))) affected.add(t.team_id);
    const snapshot = {
      teams: allTeams.filter(t => affected.has(t.team_id)).map(t => ({
        row: { ...t, members: undefined },
        members: t.members.map(m => ({ student_id: m.student_id, status: m.status, role: '' }))
      })),
      declarations: [...seen].map(sid => ({ student_id: sid, no_preference_at: byId.get(sid).no_preference_at || '' }))
    };
    // tm.role is not in the detailed rows; read it so restore is exact.
    for (const t of snapshot.teams)
      for (const m of t.members) m.role = this.teams.getMembership(t.row.team_id, m.student_id)?.role || '';

    const now = new Date().toISOString();
    const batchId = crypto.randomUUID();
    const reused = new Set([...seedByGroup.values()].map(t => t.team_id));
    const created = [];

    for (const teamId of affected) {
      if (reused.has(teamId)) continue;
      for (const m of this.teams.getMembers(teamId)) this.teams.removeMember(teamId, m.student_id);
    }

    clean.forEach((ids, i) => {
      const seed = seedByGroup.get(i);
      let teamId, teamName;
      if (seed) {
        teamId = seed.team_id; teamName = seed.team_name;
        const already = new Set(this.teams.getMembers(teamId).map(m => m.student_id));
        for (const sid of ids) if (!already.has(sid))
          this.teams.addMember(teamId, sid, this.prefs.getPreferredRole(unitId, sid));
      } else {
        const number = this.teams.nextTeamNumber(unitId);
        teamId = crypto.randomUUID(); teamName = `Team ${number}`;
        this.teams.create(teamId, unitId, teamName, number, ids[0]);
        for (const sid of ids)
          this.teams.addMember(teamId, sid, this.prefs.getPreferredRole(unitId, sid));
      }
      this.teams.setFinalised(teamId, now, batchId);
      this.requests.resolveOpenForTeam(teamId);
      if (ids.length >= 2) this.enrollment.clearNoPreferenceForStudents(unitId, ids);
      created.push({ team_id: teamId, team_name: teamName, members: ids, reused: !!seed });
    });

    for (const teamId of affected) this.teams.deleteIfEmpty(teamId);

    this.batches.create({
      batchId, unitId, createdBy: teacherId, createdAt: now,
      teamCount: created.length, studentCount: seen.size, snapshot
    });

    const unassigned = students.filter(s => !seen.has(s.student_id) &&
      !allTeams.some(t => t.status === 'FINALISED' && t.members.some(m => m.student_id === s.student_id))).length;
    return { ok: true, status: 'FINALISED', batchId, teams: created, students: seen.size, unassigned };
  }

  // A protected group is one the organiser must never split: OPEN, 2+
  // accepted members, and passing the hard rules right now. A group that
  // breaks a rule is not protected — keeping it together would only reproduce
  // the violation — and is reported as dissolved with the reason.
  _isProtected(team, unit) {
    const accepted = team.members.filter(m => m.status === 'ACCEPTED');
    if (team.status !== 'OPEN' || accepted.length < 2) return { protected: false };
    const v = validateTeam(team.members, unit, { includeAllAccepted: true, tutorialFallback: true });
    if (!v.violations.length) return { protected: true };
    return { protected: false, reason: `${v.violations[0].rule} — ${v.violations[0].why}` };
  }

  listFinaliseBatches(unitId, teacherId) {
    this._ownedOr404(unitId, teacherId);
    return this.batches.listForUnit(unitId);
  }

  // Puts everything the batch touched back exactly as it was: teams the save
  // created are deleted, snapshotted teams and memberships are restored with
  // their prior status, and each affected student's declaration comes back.
  // Refused once any team in the batch has been changed individually since —
  // the snapshot would no longer describe the current state it is replacing.
  revertFinaliseBatch(unitId, teacherId, batchId) {
    this._ownedOr404(unitId, teacherId);
    const batch = this.batches.findInUnit(batchId, unitId);
    if (!batch) throw new ServiceError('Batch not found', 404);
    if (batch.reverted_at) throw new ServiceError('This batch has already been reverted', 400);

    // Every team the batch finalised must still carry its batch id. Reopen
    // clears it and dissolve deletes the row, so a count mismatch means the
    // snapshot no longer describes what it would be replacing.
    const finalisedNow = this.teams.listByBatch(batchId);
    if (finalisedNow.length !== batch.team_count)
      throw new ServiceError(
        'A team in this batch was changed after it was saved; revert is no longer safe', 409, 'BATCH_STALE');
    const restoredIds = new Set(batch.snapshot.teams.map(t => t.row.team_id));

    // Sequential repo calls, not Database.tx: every repo write flushes the
    // file, and sql.js's export ends an open transaction. Same convention as
    // the rest of the services.
    const now = new Date().toISOString();
    for (const t of finalisedNow) this.teams.deleteTeam(t.team_id);
    for (const t of batch.snapshot.teams) {
      if (!restoredIds.has(t.row.team_id)) continue;
      this.teams.restore(t.row);
      for (const m of t.members) this.teams.addMember(t.row.team_id, m.student_id, m.role || '');
    }
    for (const d of batch.snapshot.declarations)
      this.enrollment.setNoPreference(unitId, d.student_id, d.no_preference_at || '');
    this.batches.markReverted(batchId, now);
    return { ok: true, restored: batch.snapshot.teams.length };
  }

  // ── Rules-change impact ──────────────────────────────────────────────────────
  // Which existing groups of 2+ would break a hard rule under the proposed
  // values. Read-only. The rules modal calls it as the coordinator edits, so
  // a change that puts recorded groups in breach is never a surprise at
  // finalise time. The save itself is not blocked — the coordinator decides.
  previewRulesImpact(unitId, teacherId, proposed = {}) {
    const unit = this._ownedOr404(unitId, teacherId);
    const trial = {
      ...unit,
      valid_team_sizes:    proposed.validTeamSizes    !== undefined && proposed.validTeamSizes !== ''
                             ? String(proposed.validTeamSizes) : unit.valid_team_sizes
    };
    if (proposed.validTeamSizes && parseTeamSizesCsv(String(proposed.validTeamSizes)) === null)
      throw new ServiceError('validTeamSizes must be comma-separated positive integers', 400);
    return this._groupsInBreach(unitId, trial, proposed.removeSlotLabel);
  }

  // Groups of 2+ that break a rule under `rules`, optionally with one tutorial
  // slot label removed from every member (the slot-delete dry run).
  _groupsInBreach(unitId, rules, removeSlotLabel = null) {
    const strip = csv => !removeSlotLabel ? csv
      : String(csv || '').split(',').map(x => x.trim()).filter(x => x && x !== removeSlotLabel).join(',');
    const out = [];
    for (const t of this.teams.listWithMembersDetailed(unitId)) {
      if (t.members.filter(m => m.status === 'ACCEPTED').length < 2) continue;
      const members = t.members.map(m => ({
        ...m, tutorial_slots: strip(m.tutorial_slots), tutorial_time: strip(m.tutorial_time) }));
      const v = validateTeam(members, rules, { includeAllAccepted: true, tutorialFallback: true });
      if (!v.violations.length) continue;
      out.push({
        team_id: t.team_id, team_name: t.team_name, status: t.status,
        members: t.members.map(m => ({ student_id: m.student_id, name: m.name })),
        violations: v.violations
      });
    }
    return out;
  }

  getAllTeams(unitId, teacherId) {
    const unit = this._ownedOr404(unitId, teacherId);
    return this.teams.listWithMembersDetailed(unitId).map(team => ({
      ...team,
      member_count: team.members.length,
      validation: validateTeam(team.members, unit, { includeAllAccepted: true, tutorialFallback: true })
    }));
  }

  // Every student with their progress stages, saved preferences, and where they
  // stand in team formation (`placement`, see utils/placement.js). One query
  // for memberships, so this stays two queries however large the class is.
  getClassList(unitId, teacherId) {
    this._ownedOr404(unitId, teacherId);
    return this._classListWithPlacement(unitId);
  }

  _classListWithPlacement(unitId) {
    const teamOf = new Map(
      this.teams.listMembershipsWithSizes(unitId).map(m => [m.student_id, m]));
    return this.enrollment.listWithProgress(unitId).map(s => {
      const t = teamOf.get(s.student_id);
      return {
        ...s,
        team_id:     t?.team_id     || null,
        team_name:   t?.team_name   || '',
        team_status: t?.status      || null,
        team_size:   t?.accepted_count || 0,
        placement:   placementOf({
          acceptedCount: t?.accepted_count || 0,
          noPreferenceAt: s.no_preference_at
        })
      };
    }).map(s => ({
      ...s,
      // The two derived stages, alongside the two stored ones, so the class
      // list can draw four rows without knowing how any of them is computed.
      grouped:   s.placement === 'SILENT' ? 0 : 1,
      finalised: s.team_status === 'FINALISED' ? 1 : 0
    }));
  }

  // ── Export ───────────────────────────────────────────────────────────────────
  // The coordinator's primary output, built here rather than in the page so the
  // rows can be tested and so the page and the download can never disagree.
  //
  // Email is the identifier on every row. It is the address the teacher put on
  // the roster (joinUnit matches on it), so it is the coordinator's own join key
  // against their class list — names collide and get misspelled; emails don't.
  // The student number is included only when the unit opts in.
  buildExport(unitId, teacherId) {
    const unit = this._ownedOr404(unitId, teacherId);
    const withNumber = unit.export_student_number == 1;
    const sizeLabel = targetSizeLabel(unit);
    const students = this._classListWithPlacement(unitId);
    const byId = new Map(students.map(s => [s.student_id, s]));

    const sizeText = v => v.sizeState === 'COMPLETE' ? 'Complete'
      : v.sizeState === 'OVER_MAX' ? `${v.size} — over the maximum`
      : `${v.size} of ${sizeLabel}`;

    // The n-number is not on the class-list rows any more (see
    // listWithProgress). When the unit has opted in, look it up here — the
    // export is the one place it is allowed to surface.
    const numbers = withNumber ? this.users.listStudentNumbers(students.map(s => s.student_id)) : new Map();
    const identity = s => ({
      'Email': s?.email || '',
      ...(withNumber ? { 'Student number': (s && numbers.get(s.student_id)) || '' } : {})
    });

    const STATUS_LABEL = { OPEN: 'Open', FINALISED: 'Finalised' };
    const teams = [];
    const allTeams = this.teams.listWithMembersDetailed(unitId);
    for (const t of allTeams) {
      const members = t.members;
      const validation = validateTeam(members, unit, { includeAllAccepted: true, tutorialFallback: true });
      const shared = validation.sharedTutorials.join(', ') || '—';
      const teamName = t.team_name || t.team_id.slice(0, 8);
      if (!members.length) {
        teams.push({
          'Team': teamName, 'Team Status': STATUS_LABEL[t.status] || t.status, 'Size': '0', 'Shared Tutorial': shared,
          'Member Name': '(no members)', ...identity(null), 'Role': '',
          'Member Tutorials': ''
        });
        continue;
      }
      for (const m of members) {
        const s = byId.get(m.student_id);
        teams.push({
          'Team': teamName,
          'Team Status': STATUS_LABEL[t.status] || t.status,
          'Size': sizeText(validation),
          'Shared Tutorial': shared,
          'Member Name': m.name || m.student_id,
          ...identity(s),
          'Role': m.role || '',
          'Member Tutorials': m.tutorial_slots || m.tutorial_time || ''
        });
      }
    }

    // Everyone the coordinator may still need to act on or know about. GROUPED
    // students are fully described by the Teams rows and are not repeated.
    const order = { SILENT: 0, DECLARED: 1 };
    const ungrouped = students
      .filter(s => s.placement !== 'GROUPED')
      .sort((a, b) => (order[a.placement] - order[b.placement]) ||
                      String(a.name || a.student_id).localeCompare(String(b.name || b.student_id)))
      .map(s => ({
        'Name': s.name || s.student_id,
        ...identity(s),
        'Category': PLACEMENT_LABELS[s.placement],
        'Team': s.team_name || '—',
        'Team size': `${s.team_size} of ${sizeLabel}`,
        'Preferences entered': s.entered_preferences == 1 ? 'Yes' : 'No',
        'Tutorial Slots': s.tutorial_slots || s.tutorial_time || ''
      }));

    const placements = {};
    for (const p of PLACEMENTS) placements[p] = students.filter(s => s.placement === p).length;
    const teamsByStatus = { OPEN: 0, FINALISED: 0 };
    for (const t of allTeams) teamsByStatus[t.status] = (teamsByStatus[t.status] || 0) + 1;

    return {
      unit: { unit_id: unit.unit_id, unit_name: unit.unit_name, description: unit.description,
              semester: unit.semester, target_size: sizeLabel, export_student_number: withNumber },
      teams,
      ungrouped,
      summary: { total: students.length, placements, teamsByStatus, labels: PLACEMENT_LABELS }
    };
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
    // Re-uploading a file whose students are all on the roster already is a
    // successful no-op, not an empty import — only a batch that matched nothing
    // at all is an error.
    if (!result.added && !result.updated)
      throw new ServiceError('No valid email addresses found', 400);

    // A top-up can introduce tutorial times the unit has no slot for yet. Same
    // rule createUnit applies to the first import, so both paths agree.
    this._ensureTutorialSlots(unitId, students);

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
    const { validTeamSizes, deadline, atRiskDays, exportStudentNumber } = body;

    if (validTeamSizes !== undefined && parseTeamSizesCsv(validTeamSizes) === null)
      throw new ServiceError('validTeamSizes must be comma-separated positive integers', 400);

    // Only the offered choices are storable. 0 is a real value here ("never"),
    // so this is checked explicitly rather than relying on truthiness — the
    // deadline-only save path below would otherwise turn "never" back into 3.
    let resolvedAtRisk = unit.at_risk_days ?? AT_RISK_DEFAULT;
    if (atRiskDays !== undefined && atRiskDays !== null && atRiskDays !== '') {
      const n = parseInt(atRiskDays);
      if (!AT_RISK_CHOICES.includes(n))
        throw new ServiceError(
          `atRiskDays must be one of ${AT_RISK_CHOICES.join(', ')}`, 400);
      resolvedAtRisk = n;
    }

    this.units.updateRules(unitId, {
      validTeamSizes:    validTeamSizes || unit.valid_team_sizes,
      // Mandatory for every unit — never taken from the request, never turned off.
      maxOneGroup:       1,
      mustShareTutorial: 1,
      deadline:          deadline || unit.deadline,
      atRiskDays:        resolvedAtRisk,
      exportStudentNumber: exportStudentNumber !== undefined
        ? (exportStudentNumber ? 1 : 0) : unit.export_student_number
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

  deleteTutorialSlot(unitId, teacherId, slotId, { dryRun = false } = {}) {
    const unit = this._ownedOr404(unitId, teacherId);
    const slot = this.slots.findById(slotId, unitId);
    if (!slot) throw new ServiceError('Slot not found', 404);

    // Which recorded groups this delete would put in breach (a pair whose only
    // common slot is this one, say). The dry run answers without touching
    // anything; the real delete returns the same list so the page can say so.
    const impact = this._groupsInBreach(unitId, unit, slot.label);
    if (dryRun) return { ok: true, dryRun: true, impact };

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
    return { ok: true, impact };
  }
}

module.exports = UnitService;

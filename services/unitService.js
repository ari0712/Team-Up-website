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
  constructor({ units, enrollment, progress, teams, prefs, slots, announcements }) {
    this.units = units;
    this.enrollment = enrollment;
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
    const studentCount = Array.isArray(students) ? students.length : 0;

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

    if (Array.isArray(students) && students.length > 0) {
      students.forEach(s => {
        const sid = (s.student_id || '').trim();
        if (!sid) return;
        this.enrollment.upsertImport(unitId, { ...s, student_id: sid });
        this.progress.ensure(unitId, sid);
      });

      // Auto-create tutorial slots for any new labels seen in the import.
      const slotSet = new Set();
      students.forEach(s => {
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

    return { ok: true, unitId };
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
      this.teams.setStatus(teamId, 'APPROVED');
    } else {
      this.teams.setRejected(teamId, new Date().toISOString());
    }

    const members = this.teams.getMembers(teamId);
    if (action === 'approve') {
      members.forEach(m => this.progress.markTeacherApproved(unitId, m.student_id));
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

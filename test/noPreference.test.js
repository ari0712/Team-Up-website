const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, expectServiceError, PAST } = require('./helpers/harness');

describe('"place me anywhere" declaration and placement categories', () => {
  let h, teacher;
  before(async () => { h = await createHarness(); teacher = h.createTeacher(); });
  after(() => h.close());

  test('a solo student can declare; it is timestamped and counts as their submit step', () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId);

    const r = h.studentPortalService.declareNoPreference(unitId, a);
    assert.ok(Date.parse(r.noPreferenceAt) > 0);
    assert.equal(h.repos.enrollment.getNoPreferenceAt(unitId, a), r.noPreferenceAt);
    assert.equal(h.studentPortalService.getProgress(unitId, a).grouped, 1);

    const view = h.studentPortalService.getMyTeam(unitId, a);
    assert.equal(view.placement, 'DECLARED');
    assert.equal(view.noPreferenceAt, r.noPreferenceAt);
  });

  test('withdrawing clears the timestamp and the derived stage', () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId);
    h.studentPortalService.declareNoPreference(unitId, a);
    h.studentPortalService.withdrawNoPreference(unitId, a);
    assert.equal(h.repos.enrollment.getNoPreferenceAt(unitId, a), '');
    assert.equal(h.studentPortalService.getProgress(unitId, a).grouped, 0);
    assert.equal(h.studentPortalService.getMyTeam(unitId, a).placement, 'SILENT');
  });

  test('a student in a group cannot declare — they have a group to submit', () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId);
    const b = h.enrolStudent(unitId);
    h.groupTogether(unitId, [a, b]);
    expectServiceError(() => h.studentPortalService.declareNoPreference(unitId, a), 400, 'NOT_SOLO');
  });

  test('declaring is still allowed after the deadline', () => {
    const unitId = h.createUnit(teacher, { deadline: PAST });
    const a = h.enrolStudent(unitId);
    h.studentPortalService.declareNoPreference(unitId, a);
    assert.equal(h.studentPortalService.getMyTeam(unitId, a).placement, 'DECLARED');
  });

  test('a declaration is cleared when the student merges into a group', () => {
    const unitId = h.createUnit(teacher, { validTeamSizes: '4' });
    const a = h.enrolStudent(unitId);
    const b = h.enrolStudent(unitId);
    h.studentPortalService.declareNoPreference(unitId, a);
    h.studentPortalService.declareNoPreference(unitId, b);

    // b asks a to team up; a accepts → everyone accepted → one group.
    assert.equal(h.teamUp(unitId, b, a), 'approved');
    assert.equal(h.teamOf(unitId, a).team_id, h.teamOf(unitId, b).team_id);

    assert.equal(h.repos.enrollment.getNoPreferenceAt(unitId, a), '');
    assert.equal(h.repos.enrollment.getNoPreferenceAt(unitId, b), '');
    assert.equal(h.studentPortalService.getMyTeam(unitId, a).placement, 'GROUPED');
  });

  test('the class list reports the three placement categories, with team status alongside', () => {
    const unitId = h.createUnit(teacher);
    const [g1, g2] = [h.enrolStudent(unitId), h.enrolStudent(unitId)];
    h.teamUp(unitId, g1, g2);
    h.unitService.overrideTeam(unitId, teacher, h.teamOf(unitId, g1).team_id, 'finalise');
    const [u1, u2] = [h.enrolStudent(unitId), h.enrolStudent(unitId)];
    h.teamUp(unitId, u1, u2);
    const declared = h.enrolStudent(unitId);
    h.studentPortalService.declareNoPreference(unitId, declared);
    const silent = h.enrolStudent(unitId);

    const byId = new Map(h.unitService.getClassList(unitId, teacher).map(s => [s.student_id, s]));
    assert.equal(byId.get(g1).placement, 'GROUPED');
    assert.equal(byId.get(g1).team_status, 'FINALISED');
    assert.equal(byId.get(u1).placement, 'GROUPED');
    assert.equal(byId.get(u1).team_status, 'OPEN');
    assert.equal(byId.get(u2).placement, 'GROUPED');
    assert.equal(byId.get(declared).placement, 'DECLARED');
    assert.equal(byId.get(silent).placement, 'SILENT');
    assert.equal(byId.get(g1).team_size, 2);
    assert.ok(byId.get(silent).email.endsWith('@example.edu'));
  });
});

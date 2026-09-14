const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/harness');

// A recorded group can be put in breach by teacher-side edits. Two things
// must then be true: the student learns it on My Team with the rule named,
// and the coordinator sees it BEFORE saving the change.
describe('rules can change under a recorded group', () => {
  let h, teacher;
  before(async () => { h = await createHarness(); teacher = h.createTeacher(); });
  after(() => h.close());

  test('my-team re-validates at read time and names the rule after a tighter cap', () => {
    const unitId = h.createUnit(teacher, { maxNewToQut: 2 });
    const a = h.enrolStudent(unitId, { newToQut: 1 }), b = h.enrolStudent(unitId, { newToQut: 1 });
    h.teamUp(unitId, a, b);
    assert.deepEqual(h.studentPortalService.getMyTeam(unitId, a).validation.violations, []);

    h.unitService.updateRules(unitId, teacher, { maxNewToQut: 1 });
    const view = h.studentPortalService.getMyTeam(unitId, a);
    assert.equal(view.placement, 'GROUPED');
    assert.equal(view.team.status, 'OPEN');
    assert.equal(view.validation.violations.length, 1);
    assert.equal(view.validation.violations[0].code, 'NEW_TO_QUT_CAP');
    assert.match(view.validation.violations[0].rule, /Maximum 1 new-to-QUT/);
  });

  test('previewRulesImpact names exactly the groups a proposed change would break, without saving', () => {
    const unitId = h.createUnit(teacher, { validTeamSizes: '4', mustShareTutorial: 0, maxNewToQut: 2 });
    const a = h.enrolStudent(unitId, { slots: 'Tue 10' }), b = h.enrolStudent(unitId, { slots: 'Wed 2' });
    h.teamUp(unitId, a, b);                                            // fine while tutorial not required
    const c = h.enrolStudent(unitId, { slots: 'Tue 10' }), d = h.enrolStudent(unitId, { slots: 'Tue 10' });
    h.teamUp(unitId, c, d);
    const solo = h.enrolStudent(unitId);

    let impact = h.unitService.previewRulesImpact(unitId, teacher, { mustShareTutorial: true });
    assert.equal(impact.length, 1);
    assert.equal(impact[0].team_id, h.teamOf(unitId, a).team_id);
    assert.equal(impact[0].violations[0].code, 'NO_SHARED_TUTORIAL');
    assert.deepEqual(impact[0].members.map(m => m.student_id).sort(), [a, b].sort());
    // Nothing was saved.
    assert.equal(h.repos.unitRepo.findById(unitId).must_share_tutorial, 0);
    assert.deepEqual(h.studentPortalService.getMyTeam(unitId, a).validation.violations, []);

    impact = h.unitService.previewRulesImpact(unitId, teacher, { validTeamSizes: '1' });
    assert.equal(impact.length, 2);                                     // both pairs over max 1
    assert.ok(impact.every(g => g.violations[0].code === 'OVER_MAX_SIZE'));

    impact = h.unitService.previewRulesImpact(unitId, teacher, { maxNewToQut: 0 });
    assert.equal(impact.length, 0);
    void solo;
  });

  test('deleting a tutorial slot can be dry-run, and the real delete reports the same impact', () => {
    const unitId = h.createUnit(teacher, { mustShareTutorial: 1 });
    const a = h.enrolStudent(unitId, { slots: 'Tue 10' }), b = h.enrolStudent(unitId, { slots: 'Tue 10,Wed 2' });
    h.teamUp(unitId, a, b);
    const slot = h.repos.slots.listForUnit(unitId).find(s => s.label === 'Tue 10');

    const dry = h.unitService.deleteTutorialSlot(unitId, teacher, slot.slot_id, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.impact.length, 1);
    assert.equal(dry.impact[0].violations[0].code, 'NO_SHARED_TUTORIAL');
    assert.ok(h.repos.slots.findById(slot.slot_id, unitId), 'dry run must not delete');

    const real = h.unitService.deleteTutorialSlot(unitId, teacher, slot.slot_id);
    assert.equal(real.impact.length, 1);
    assert.equal(h.repos.slots.findById(slot.slot_id, unitId), null);
    assert.equal(h.studentPortalService.getMyTeam(unitId, a).validation.violations[0].code, 'NO_SHARED_TUTORIAL');
  });
});

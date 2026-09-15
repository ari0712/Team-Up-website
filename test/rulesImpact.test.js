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

  test('my-team re-validates at read time and names the rule after a smaller maximum size', () => {
    const unitId = h.createUnit(teacher, { validTeamSizes: '3,4' });
    const [a, b, c] = [1, 2, 3].map(() => h.enrolStudent(unitId));
    h.teamUp(unitId, a, b); h.teamUp(unitId, c, a);
    assert.deepEqual(h.studentPortalService.getMyTeam(unitId, a).validation.violations, []);

    h.unitService.updateRules(unitId, teacher, { validTeamSizes: '2' });
    const view = h.studentPortalService.getMyTeam(unitId, a);
    assert.equal(view.placement, 'GROUPED');
    assert.equal(view.team.status, 'OPEN');
    assert.equal(view.validation.violations.length, 1);
    assert.equal(view.validation.violations[0].code, 'OVER_MAX_SIZE');
    assert.match(view.validation.violations[0].rule, /Largest allowed team size is 2/);
  });

  test('previewRulesImpact names exactly the groups a proposed change would break, without saving', () => {
    const unitId = h.createUnit(teacher, { validTeamSizes: '4' });
    const [a, b, c] = [1, 2, 3].map(() => h.enrolStudent(unitId, { slots: 'Tue 10' }));
    h.teamUp(unitId, a, b); h.teamUp(unitId, c, a);                     // a trio
    const d = h.enrolStudent(unitId, { slots: 'Wed 2' }), e = h.enrolStudent(unitId, { slots: 'Wed 2' });
    h.teamUp(unitId, d, e);                                             // a pair
    const solo = h.enrolStudent(unitId);

    let impact = h.unitService.previewRulesImpact(unitId, teacher, { validTeamSizes: '2' });
    assert.equal(impact.length, 1);                                     // only the trio is over max 2
    assert.equal(impact[0].team_id, h.teamOf(unitId, a).team_id);
    assert.equal(impact[0].violations[0].code, 'OVER_MAX_SIZE');
    assert.deepEqual(impact[0].members.map(m => m.student_id).sort(), [a, b, c].sort());
    // Nothing was saved.
    assert.equal(h.repos.unitRepo.findById(unitId).valid_team_sizes, '4');
    assert.deepEqual(h.studentPortalService.getMyTeam(unitId, a).validation.violations, []);

    impact = h.unitService.previewRulesImpact(unitId, teacher, { validTeamSizes: '1' });
    assert.equal(impact.length, 2);                                     // both groups over max 1
    assert.ok(impact.every(g => g.violations[0].code === 'OVER_MAX_SIZE'));

    impact = h.unitService.previewRulesImpact(unitId, teacher, { validTeamSizes: '3,4' });
    assert.equal(impact.length, 0);
    void solo;
  });

  test('"one group" and "shared tutorial" are always on — the request body cannot switch them off', () => {
    const { unitId } = h.unitService.createUnit(teacher, {
      unitName: 'Locked rules', maxOneGroup: false, mustShareTutorial: false, students: []
    });
    let unit = h.repos.unitRepo.findById(unitId);
    assert.equal(unit.max_one_group, 1);
    assert.equal(unit.must_share_tutorial, 1);

    h.unitService.updateRules(unitId, teacher, { maxOneGroup: false, mustShareTutorial: 0, validTeamSizes: '3,4' });
    unit = h.repos.unitRepo.findById(unitId);
    assert.equal(unit.max_one_group, 1);
    assert.equal(unit.must_share_tutorial, 1);
    assert.equal(unit.valid_team_sizes, '3,4');                         // the rest of the save still lands
  });

  test('deleting a tutorial slot can be dry-run, and the real delete reports the same impact', () => {
    const unitId = h.createUnit(teacher);
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

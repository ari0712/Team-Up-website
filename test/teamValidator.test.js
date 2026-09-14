const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validateTeam, targetSizeLabel } = require('../utils/teamValidator');

const unit = (over = {}) => ({ valid_team_sizes: '4', must_share_tutorial: 1, max_new_to_qut: 2, ...over });
const member = (id, slots, newToQut = 0) =>
  ({ student_id: id, name: id, status: 'ACCEPTED', tutorial_slots: slots, is_new_to_qut: newToQut });

describe('validateTeam — size is advisory, rules are hard', () => {
  test('a valid pair is UNDER_TARGET, has no violations, and can be submitted', () => {
    const v = validateTeam([member('a', 'Tue 10'), member('b', 'Tue 10')], unit());
    assert.equal(v.sizeState, 'UNDER_TARGET');
    assert.equal(v.needed, 2);
    assert.deepEqual(v.violations, []);
    assert.equal(v.canSubmit, true);
    assert.equal(v.solo, false);
    // Legacy keys keep their meaning for existing callers.
    assert.equal(v.sizeValid, false);
    assert.equal(v.tutorialShared, true);
  });

  test('a valid trio is UNDER_TARGET by one and can be submitted', () => {
    const v = validateTeam([member('a', 'Tue 10'), member('b', 'Tue 10,Wed 2'), member('c', 'Tue 10')], unit());
    assert.equal(v.sizeState, 'UNDER_TARGET');
    assert.equal(v.needed, 1);
    assert.equal(v.canSubmit, true);
    assert.deepEqual(v.sharedTutorials, ['Tue 10']);
  });

  test('a pair with no shared tutorial slot is a NO_SHARED_TUTORIAL violation and cannot be submitted', () => {
    const v = validateTeam([member('a', 'Tue 10'), member('b', 'Wed 2')], unit());
    assert.equal(v.canSubmit, false);
    assert.equal(v.violations.length, 1);
    const [x] = v.violations;
    assert.equal(x.code, 'NO_SHARED_TUTORIAL');
    assert.match(x.rule, /share at least one tutorial/i);
    assert.match(x.why, /no single slot/i);
    // Size is still just advisory alongside the violation.
    assert.equal(v.sizeState, 'UNDER_TARGET');
  });

  test('the tutorial violation names members who have nothing saved', () => {
    const v = validateTeam([member('a', 'Tue 10'), member('bob', '')], unit());
    assert.equal(v.violations[0].code, 'NO_SHARED_TUTORIAL');
    assert.match(v.violations[0].why, /bob has no tutorial availability saved/);
  });

  test('a trio of three new-to-QUT students is a NEW_TO_QUT_CAP violation', () => {
    const v = validateTeam(
      [member('a', 'Tue 10', 1), member('b', 'Tue 10', 1), member('c', 'Tue 10', 1)], unit());
    assert.equal(v.canSubmit, false);
    assert.equal(v.violations.length, 1);
    assert.equal(v.violations[0].code, 'NEW_TO_QUT_CAP');
    assert.match(v.violations[0].rule, /Maximum 2 new-to-QUT/);
    assert.match(v.violations[0].why, /3 of the 3 members are new to QUT/);
    assert.equal(v.newToQutOk, false);
  });

  test('a solo student has no violations but cannot submit a group', () => {
    const v = validateTeam([member('a', 'Tue 10')], unit());
    assert.equal(v.solo, true);
    assert.deepEqual(v.violations, []);
    assert.equal(v.canSubmit, false);
    assert.equal(v.needed, 3);
  });

  test('a team at a target size is COMPLETE', () => {
    const four = ['a', 'b', 'c', 'd'].map(id => member(id, 'Tue 10'));
    const v = validateTeam(four, unit({ valid_team_sizes: '4,5' }));
    assert.equal(v.sizeState, 'COMPLETE');
    assert.equal(v.needed, 0);
    assert.equal(v.canSubmit, true);
  });

  test('over the largest allowed size is a real violation, not advisory', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => member(id, 'Tue 10'));
    const v = validateTeam(six, unit({ valid_team_sizes: '4,5' }));
    assert.equal(v.sizeState, 'OVER_MAX');
    assert.equal(v.violations[0].code, 'OVER_MAX_SIZE');
    assert.equal(v.canSubmit, false);
  });

  test('no shared tutorial is not a violation when the unit does not require one', () => {
    const v = validateTeam([member('a', 'Tue 10'), member('b', 'Wed 2')], unit({ must_share_tutorial: 0 }));
    assert.equal(v.tutorialRequired, false);
    assert.deepEqual(v.violations, []);
    assert.equal(v.canSubmit, true);
  });

  test('tutorialFallback reads the roster tutorial_time when nothing is saved', () => {
    const members = [
      { ...member('a', ''), tutorial_time: 'Tue 10' },
      { ...member('b', ''), tutorial_time: 'Tue 10' },
    ];
    assert.equal(validateTeam(members, unit()).canSubmit, false);
    assert.equal(validateTeam(members, unit(), { tutorialFallback: true }).canSubmit, true);
  });

  test('targetSizeLabel renders a range or a single size', () => {
    assert.equal(targetSizeLabel({ valid_team_sizes: '4,5' }), '4–5');
    assert.equal(targetSizeLabel({ valid_team_sizes: '4' }), '4');
    assert.equal(targetSizeLabel({}), '4');
  });
});

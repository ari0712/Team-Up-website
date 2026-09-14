const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/harness');

// Every protected group's members must appear together in exactly one output
// group. This is the invariant the matcher exists to keep.
function assertKeptTogether(groups, memberIds, label) {
  const holders = groups.filter(g => g.some(id => memberIds.includes(id)));
  assert.equal(holders.length, 1, `${label} was split or dropped: found in ${holders.length} groups`);
  for (const id of memberIds) assert.ok(holders[0].includes(id), `${label}: ${id} missing from its group`);
}

describe('matcher — feasible OPEN groups are never split; infeasible ones are dissolved with the reason', () => {
  let h, teacher, unitId;
  const groups = {};

  before(async () => {
    h = await createHarness();
    teacher = h.createTeacher();
    unitId = h.createUnit(teacher, { validTeamSizes: '4,5', maxNewToQut: 2 });

    const enrol = (n, opts = {}) => Array.from({ length: n }, () => h.enrolStudent(unitId, { slots: 'Tue 10', ...opts }));
    const join = ids => { for (let i = 1; i < ids.length; i++) assert.equal(h.teamUp(unitId, ids[i], ids[0]), 'approved'); };

    groups.pair = enrol(2);  join(groups.pair);
    groups.trio = enrol(3);  join(groups.trio);
    groups.quad = enrol(4);  join(groups.quad);                 // complete → settled
    // A pair that will be put in breach by a later rule change.
    groups.newPair = enrol(2, { newToQut: 1 }); join(groups.newPair);
    groups.singles = enrol(6);
    // The coordinator tightens the cap AFTER the pair formed: it is now in breach.
    h.unitService.updateRules(unitId, teacher, { maxNewToQut: 1 });
    h.lock(unitId, teacher);
  });
  after(() => h.close());

  test('suggest keeps every feasible OPEN group intact and never puts one in unassigned', () => {
    const s = h.matchingService.suggest(unitId, teacher);
    const out = s.teams.map(t => t.members.map(m => m.student_id));
    assertKeptTogether(out, groups.pair, 'pair');
    assertKeptTogether(out, groups.trio, 'trio');
    assert.ok(s.settled.some(t => t.members.length === 4), 'the complete quad is settled');
    assert.ok(!out.some(g => g.includes(groups.quad[0])));
    for (const id of [...groups.pair, ...groups.trio])
      assert.ok(!s.unassigned.some(m => m.student_id === id), `${id} should not be unassigned`);
    const seeded = s.teams.filter(t => t.seed_team_id);
    assert.equal(seeded.length, 2);
    assert.ok(seeded.every(t => t.locked_member_ids.length >= 2));
  });

  test('a group made infeasible by a later rule change is dissolved and the reason is reported', () => {
    const s = h.matchingService.suggest(unitId, teacher);
    assert.equal(s.dissolved.length, 1);
    assert.match(s.dissolved[0].reason, /Maximum 1 new-to-QUT/);
    const placed = new Set([...s.teams.flatMap(t => t.members.map(m => m.student_id)),
                            ...s.unassigned.map(m => m.student_id)]);
    for (const id of groups.newPair) assert.ok(placed.has(id), `${id} should be back in the pool`);
    // And not together as a locked block.
    assert.ok(!s.teams.some(t => t.locked_member_ids.includes(groups.newPair[0])));
  });

  test('a finalised team is settled and untouched by the suggestion', () => {
    const [x, y] = groups.singles;
    // Finalise two singles as a pair via the override; they must drop out of the pool.
    const r = h.unitService.finaliseTeams(unitId, teacher, [[x, y]]);
    const s = h.matchingService.suggest(unitId, teacher);
    assert.ok(s.settled.some(t => t.team_id === r.teams[0].team_id));
    assert.ok(!s.teams.some(t => t.members.some(m => m.student_id === x)));
    h.unitService.revertFinaliseBatch(unitId, teacher, r.batchId);
  });

  test('student-side auto-match never suggests a finalised team or one that breaks a rule', async () => {
    const h2 = await createHarness();
    try {
      const t2 = h2.createTeacher();
      const u2 = h2.createUnit(t2, { validTeamSizes: '4', maxNewToQut: 1 });
      const me = h2.enrolStudent(u2, { slots: 'Tue 10', newToQut: 1 });
      const okMate = h2.enrolStudent(u2, { slots: 'Tue 10' });
      const newMate = h2.enrolStudent(u2, { slots: 'Tue 10', newToQut: 1 });   // would breach the cap
      const farMate = h2.enrolStudent(u2, { slots: 'Wed 2' });                 // no shared slot
      const s = h2.studentPortalService.autoMatch(u2, me);
      const ids = s.suggestions.flatMap(x => x.members.map(m => m.student_id));
      assert.ok(ids.includes(okMate));
      assert.ok(!ids.includes(newMate));
      assert.ok(!ids.includes(farMate));
    } finally { h2.close(); }
  });
});

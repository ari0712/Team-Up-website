const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, expectServiceError } = require('./helpers/harness');

describe('coordinator override — finalise / reopen / dissolve, and revertible batches', () => {
  let h, teacher;
  before(async () => { h = await createHarness(); teacher = h.createTeacher(); });
  after(() => h.close());

  test('finalise a single team, reopen it, and the stamps drive the notifications', () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId);
    h.teamUp(unitId, a, b);
    const teamId = h.teamOf(unitId, a).team_id;
    h.studentPortalService.listNotifications(unitId, a);   // prime the inbox

    assert.equal(h.unitService.overrideTeam(unitId, teacher, teamId, 'finalise').status, 'FINALISED');
    let row = h.repos.teams.findById(teamId);
    assert.equal(row.status, 'FINALISED');
    assert.ok(row.finalised_at);
    assert.equal(row.finalise_batch_id, '');
    assert.equal(h.studentPortalService.getProgress(unitId, a).finalised, 1);
    assert.ok(h.studentPortalService.listNotifications(unitId, a).some(n => /has been finalised/.test(n.title)));
    // Students can no longer change it.
    expectServiceError(() => h.studentPortalService.leaveTeam(unitId, teamId, a), 400, 'FINALISED');
    expectServiceError(() => h.studentPortalService.savePrefs(unitId, a, {
      tutorialSlots: 'Tue 10', projectInterests: 'x', skills: 'y', preferredRole: 'z' }), 403, 'PREFS_LOCKED');

    assert.equal(h.unitService.overrideTeam(unitId, teacher, teamId, 'reopen').status, 'OPEN');
    row = h.repos.teams.findById(teamId);
    assert.equal(row.status, 'OPEN');
    assert.ok(row.reopened_at);
    assert.ok(h.studentPortalService.listNotifications(unitId, a).some(n => /reopened your team/.test(n.title)));
    expectServiceError(() => h.unitService.overrideTeam(unitId, teacher, teamId, 'reopen'), 400);
  });

  test('finalise is refused when the team currently breaks a rule', () => {
    const unitId = h.createUnit(teacher, { validTeamSizes: '3,4' });
    const [a, b, c] = [1, 2, 3].map(() => h.enrolStudent(unitId));
    h.teamUp(unitId, a, b); h.teamUp(unitId, c, a);
    h.unitService.updateRules(unitId, teacher, { validTeamSizes: '2' });   // the trio is now in breach
    const e = expectServiceError(
      () => h.unitService.overrideTeam(unitId, teacher, h.teamOf(unitId, a).team_id, 'finalise'), 400, 'TEAM_CONSTRAINT');
    assert.match(e.message, /Largest allowed team size is 2/);
  });

  test('dissolve re-homes every member to a team of one and leaves declarations alone', () => {
    const unitId = h.createUnit(teacher);
    const [a, b, c] = [1, 2, 3].map(() => h.enrolStudent(unitId));
    h.teamUp(unitId, a, b); h.teamUp(unitId, c, a);
    const teamId = h.teamOf(unitId, a).team_id;
    assert.equal(h.membersOf(unitId, a).length, 3);

    const r = h.unitService.overrideTeam(unitId, teacher, teamId, 'dissolve');
    assert.equal(r.status, 'DISSOLVED');
    assert.deepEqual(r.students.sort(), [a, b, c].sort());
    for (const s of [a, b, c]) {
      assert.equal(h.membersOf(unitId, s).length, 1);
      assert.equal(h.teamOf(unitId, s).status, 'OPEN');
    }
    assert.equal(h.repos.teams.findById(teamId), null);
    assert.equal(h.studentPortalService.getMyTeam(unitId, a).placement, 'SILENT');
  });

  test('finaliseTeams writes FINALISED with one batch id; revert restores the prior grouping and declarations', () => {
    const unitId = h.createUnit(teacher, { validTeamSizes: '4' });
    const [p1, p2] = [h.enrolStudent(unitId), h.enrolStudent(unitId)];
    h.teamUp(unitId, p1, p2);                              // a recorded pair
    const d = h.enrolStudent(unitId);
    h.studentPortalService.declareNoPreference(unitId, d); // a declared solo
    const s1 = h.enrolStudent(unitId), s2 = h.enrolStudent(unitId), s3 = h.enrolStudent(unitId);
    const bystander = h.enrolStudent(unitId);              // left out of the payload
    h.lock(unitId, teacher);

    const pairTeamBefore = h.teamOf(unitId, p1);
    const dSoloTeamBefore = h.teamOf(unitId, d);
    const r = h.unitService.finaliseTeams(unitId, teacher, [[p1, p2, d, s1], [s2, s3]]);
    assert.equal(r.status, 'FINALISED');
    assert.ok(r.batchId);
    assert.equal(r.teams.length, 2);
    assert.equal(r.students, 6);
    assert.equal(r.unassigned, 1);

    for (const t of r.teams) {
      const row = h.repos.teams.findById(t.team_id);
      assert.equal(row.status, 'FINALISED');
      assert.equal(row.finalise_batch_id, r.batchId);
    }
    // The pair kept its team row; d's declaration was cleared; d's solo team is gone.
    assert.equal(h.teamOf(unitId, p1).team_id, pairTeamBefore.team_id);
    assert.equal(h.repos.enrollment.getNoPreferenceAt(unitId, d), '');
    assert.equal(h.repos.teams.findById(dSoloTeamBefore.team_id), null);
    assert.equal(h.membersOf(unitId, bystander).length, 1);
    const batches = h.unitService.listFinaliseBatches(unitId, teacher);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].team_count, 2);
    assert.equal(batches[0].reverted_at, null);

    // ── Revert ──
    const rv = h.unitService.revertFinaliseBatch(unitId, teacher, r.batchId);
    assert.ok(rv.ok);
    assert.deepEqual(h.membersOf(unitId, p1), [p1, p2].sort());
    assert.equal(h.teamOf(unitId, p1).status, 'OPEN');
    assert.equal(h.teamOf(unitId, p1).team_id, pairTeamBefore.team_id);
    // d is back alone, on the very team row the save had emptied, still declared.
    assert.equal(h.membersOf(unitId, d).length, 1);
    assert.equal(h.teamOf(unitId, d).team_id, dSoloTeamBefore.team_id);
    assert.ok(h.repos.enrollment.getNoPreferenceAt(unitId, d));
    assert.equal(h.studentPortalService.getMyTeam(unitId, d).placement, 'DECLARED');
    for (const s of [s1, s2, s3]) assert.equal(h.membersOf(unitId, s).length, 1);
    // The teams the batch created are gone; nothing is FINALISED.
    assert.ok(h.repos.teams.listAllWithCounts(unitId).every(t => t.status === 'OPEN' && t.member_count > 0));
    assert.ok(h.unitService.listFinaliseBatches(unitId, teacher)[0].reverted_at);
    expectServiceError(() => h.unitService.revertFinaliseBatch(unitId, teacher, r.batchId), 400);
  });

  test('a batch cannot be reverted once one of its teams was changed individually', () => {
    const unitId = h.createUnit(teacher, { validTeamSizes: '2' });
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId), c = h.enrolStudent(unitId), d = h.enrolStudent(unitId);
    h.lock(unitId, teacher);
    const r = h.unitService.finaliseTeams(unitId, teacher, [[a, b], [c, d]]);
    h.unitService.overrideTeam(unitId, teacher, r.teams[0].team_id, 'reopen');
    expectServiceError(() => h.unitService.revertFinaliseBatch(unitId, teacher, r.batchId), 409, 'BATCH_STALE');
  });

  test('finaliseTeams enforces the hard rules and the split invariant, not the target size', () => {
    const unitId = h.createUnit(teacher, { validTeamSizes: '4,5' });
    const a = h.enrolStudent(unitId, { slots: 'Tue 10' }), b = h.enrolStudent(unitId, { slots: 'Tue 10' });
    h.teamUp(unitId, a, b);
    const w = h.enrolStudent(unitId, { slots: 'Wed 2' });
    const s1 = h.enrolStudent(unitId), s2 = h.enrolStudent(unitId), s3 = h.enrolStudent(unitId);
    h.lock(unitId, teacher);

    expectServiceError(() => h.unitService.finaliseTeams(unitId, teacher, [[a, s1], [b, s2]]), 400, 'SPLITS_PROTECTED_GROUP');
    expectServiceError(() => h.unitService.finaliseTeams(unitId, teacher, [[s1, s2, w]]), 400, 'TEAM_CONSTRAINT');
    // A group of 3 in a 4/5 unit is accepted.
    const r = h.unitService.finaliseTeams(unitId, teacher, [[s1, s2, s3]]);
    assert.equal(r.teams[0].members.length, 3);
    // Touching an already-finalised team is refused.
    expectServiceError(() => h.unitService.finaliseTeams(unitId, teacher, [[s1, a, b]]), 400, 'ALREADY_FINALISED');
  });
});

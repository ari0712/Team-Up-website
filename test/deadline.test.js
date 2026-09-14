const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, expectServiceError, PAST } = require('./helpers/harness');

// The deadline is the only student-side freeze, so it has to hold in the
// service layer for every mutation — hiding a button is not enforcement.
describe('deadline — enforced server-side on every student mutation', () => {
  let h, teacher, unitId, a, b, c, requestId;
  before(async () => {
    h = await createHarness(); teacher = h.createTeacher();
    unitId = h.createUnit(teacher, { validTeamSizes: '4' });
    a = h.enrolStudent(unitId); b = h.enrolStudent(unitId); c = h.enrolStudent(unitId);
    h.teamUp(unitId, a, b);
    // A request sent before the deadline, still open when it passes.
    ({ requestId } = h.studentPortalService.sendRequest(unitId, c, h.teamOf(unitId, a).team_id));
    h.lock(unitId, teacher);
  });
  after(() => h.close());

  test('sending a request → 403 DEADLINE_PASSED', () => {
    const d = h.enrolStudent(unitId);
    expectServiceError(() => h.studentPortalService.sendRequest(unitId, d, h.teamOf(unitId, c).team_id), 403, 'DEADLINE_PASSED');
  });

  test('accepting a request sent before the deadline → 403', () => {
    expectServiceError(() => h.studentPortalService.respondToRequest(requestId, a, 'accept'), 403, 'DEADLINE_PASSED');
    assert.equal(h.membersOf(unitId, a).length, 2);
  });

  test('leaving → 403', () => {
    expectServiceError(() => h.studentPortalService.leaveTeam(unitId, h.teamOf(unitId, a).team_id, b), 403, 'DEADLINE_PASSED');
  });

  test('kicking → 403', () => {
    const team = h.teamOf(unitId, a);
    expectServiceError(() => h.studentPortalService.kickMember(unitId, team.team_id, team.created_by, b), 403, 'DEADLINE_PASSED');
  });

  test('auto-match for a student → 403', () => {
    expectServiceError(() => h.studentPortalService.autoMatch(unitId, c), 403, 'DEADLINE_PASSED');
  });

  test('declaring "place me anywhere" is still allowed after the deadline', () => {
    const r = h.studentPortalService.declareNoPreference(unitId, c);
    assert.ok(r.noPreferenceAt);
  });

  test('the organiser is unreachable BEFORE the deadline, in the service layer', async () => {
    const h2 = await createHarness();
    try {
      const t2 = h2.createTeacher();
      const u2 = h2.createUnit(t2);
      const x = h2.enrolStudent(u2), y = h2.enrolStudent(u2);
      expectServiceError(() => h2.matchingService.suggest(u2, t2), 409);
      expectServiceError(() => h2.unitService.finaliseTeams(u2, t2, [[x, y]]), 403, 'DEADLINE_NOT_PASSED');
      h2.lock(u2, t2);
      assert.ok(h2.matchingService.suggest(u2, t2).locked);
    } finally { h2.close(); }
  });
});

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, expectServiceError } = require('./helpers/harness');

describe('team-up requests — rules are evaluated at the moment students act', () => {
  let h, teacher;
  before(async () => { h = await createHarness(); teacher = h.createTeacher(); });
  after(() => h.close());

  test('a feasible pair: request sent, other side accepts, the group is recorded', () => {
    const unitId = h.createUnit(teacher, { validTeamSizes: '4' });
    const a = h.enrolStudent(unitId, { slots: 'Tue 10' });
    const b = h.enrolStudent(unitId, { slots: 'Tue 10' });

    assert.equal(h.teamUp(unitId, a, b), 'approved');
    assert.deepEqual(h.membersOf(unitId, a), [a, b].sort());
    assert.equal(h.teamOf(unitId, a).status, 'OPEN');

    const view = h.studentPortalService.getMyTeam(unitId, a);
    assert.equal(view.placement, 'GROUPED');
    assert.equal(view.validation.sizeState, 'UNDER_TARGET');
    assert.deepEqual(view.validation.violations, []);
    // No submit step exists: the record is complete as it stands.
    assert.equal(h.studentPortalService.getProgress(unitId, a).grouped, 1);
    assert.equal(h.studentPortalService.getProgress(unitId, a).finalised, 0);
  });

  test('a pair with no shared tutorial slot is refused when the request is SENT, naming the rule', () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId, { slots: 'Tue 10' });
    const b = h.enrolStudent(unitId, { slots: 'Wed 2' });
    const target = h.teamOf(unitId, b).team_id;

    const e = expectServiceError(() => h.studentPortalService.sendRequest(unitId, a, target), 400, 'RULE');
    assert.match(e.message, /share at least one tutorial slot/i);
    assert.match(e.message, /no single slot/i);
    assert.equal(h.membersOf(unitId, a).length, 1);
  });

  test('three new-to-QUT students cannot team up when the cap is 2', () => {
    const unitId = h.createUnit(teacher, { maxNewToQut: 2 });
    const [a, b, c] = [1, 2, 3].map(() => h.enrolStudent(unitId, { slots: 'Tue 10', newToQut: 1 }));
    assert.equal(h.teamUp(unitId, a, b), 'approved');
    const e = expectServiceError(
      () => h.studentPortalService.sendRequest(unitId, c, h.teamOf(unitId, a).team_id), 400, 'RULE');
    assert.match(e.message, /Maximum 2 new-to-QUT/);
    assert.match(e.message, /3 of the 3 members/);
  });

  test('over the largest allowed size is refused', () => {
    const unitId = h.createUnit(teacher, { validTeamSizes: '2' });
    const [a, b, c] = [1, 2, 3].map(() => h.enrolStudent(unitId));
    h.teamUp(unitId, a, b);
    const e = expectServiceError(
      () => h.studentPortalService.sendRequest(unitId, c, h.teamOf(unitId, a).team_id), 400);
    assert.match(e.message, /exceed the max/i);
  });

  test('checkRequest reports the rule as data, for UIs that need it before sending', () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId, { slots: 'Tue 10' });
    const b = h.enrolStudent(unitId, { slots: 'Wed 2' });
    const check = h.teamRequestService.checkRequest({
      unitId, sourceTeamId: h.teamOf(unitId, a).team_id, targetTeamId: h.teamOf(unitId, b).team_id, initiatorId: a });
    assert.equal(check.ok, false);
    assert.equal(check.code, 'RULE');
    assert.equal(check.violation.code, 'NO_SHARED_TUTORIAL');
  });

  test('a request that became infeasible before acceptance is invalidated with the reason', () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId, { slots: 'Tue 10,Wed 2' });
    const b = h.enrolStudent(unitId, { slots: 'Tue 10' });
    const { requestId, state } = h.studentPortalService.sendRequest(unitId, a, h.teamOf(unitId, b).team_id);
    assert.equal(state, 'open');
    // a (solo, so unrestricted) moves off the shared slot before b accepts.
    h.studentPortalService.savePrefs(unitId, a, { tutorialSlots: 'Wed 2', projectInterests: 'x', skills: 'y', preferredRole: 'z' });

    const r = h.studentPortalService.respondToRequest(requestId, b, 'accept');
    assert.equal(r.state, 'invalidated');
    assert.match(r.reason, /share at least one tutorial/i);
    assert.equal(h.membersOf(unitId, a).length, 1);
    // The sender sees the outcome (their seen_at was reset), with the reason.
    const listed = h.studentPortalService.listRequests(unitId, a).find(x => x.request_id === requestId);
    assert.match(listed.invalidated_reason, /tutorial/i);
    assert.equal(listed.state, 'invalidated');
    const detail = h.studentPortalService.getRequestDetail(unitId, requestId, b);
    assert.equal(detail.responses.find(r => r.student_id === b).response, 'accept');
  });

  test('declining ends the request', () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId);
    const { requestId } = h.studentPortalService.sendRequest(unitId, a, h.teamOf(unitId, b).team_id);
    const r = h.studentPortalService.respondToRequest(requestId, b, 'decline');
    assert.equal(r.state, 'rejected');
    expectServiceError(() => h.studentPortalService.respondToRequest(requestId, b, 'maybe'), 400);
  });

  test('a preference change that would break a recorded group is refused, naming the rule', () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId, { slots: 'Tue 10' });
    const b = h.enrolStudent(unitId, { slots: 'Tue 10' });
    h.teamUp(unitId, a, b);
    const e = expectServiceError(() => h.studentPortalService.savePrefs(unitId, a, {
      tutorialSlots: 'Wed 2', projectInterests: 'x', skills: 'y', preferredRole: 'z' }), 400, 'PREFS_WOULD_BREAK_GROUP');
    assert.match(e.message, /share at least one tutorial slot/i);
    assert.match(e.message, /Leave the group first/);
    // A compatible change goes through.
    h.studentPortalService.savePrefs(unitId, a, {
      tutorialSlots: 'Tue 10,Wed 2', projectInterests: 'x', skills: 'y', preferredRole: 'z' });
    assert.equal(h.repos.prefs.get(unitId, a).tutorial_slots, 'Tue 10,Wed 2');
  });

  test('a finalised team cannot be asked to team up', () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId), c = h.enrolStudent(unitId);
    h.teamUp(unitId, a, b);
    h.unitService.overrideTeam(unitId, teacher, h.teamOf(unitId, a).team_id, 'finalise');
    const e = expectServiceError(
      () => h.studentPortalService.sendRequest(unitId, c, h.teamOf(unitId, a).team_id), 400);
    assert.match(e.message, /finalised/i);
  });
});

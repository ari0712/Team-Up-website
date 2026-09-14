const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, expectServiceError } = require('./helpers/harness');

// An id in the URL is not a credential. Each case here was a route that took a
// unitId/teamId/studentId and did not check the caller against it.
describe('authorization — ids in the URL are checked against the caller', () => {
  let h, teacherA, teacherB, unitA, unitB, a1, a2, b1;

  before(async () => {
    h = await createHarness();
    teacherA = h.createTeacher();
    teacherB = h.createTeacher();
    unitA = h.createUnit(teacherA);
    unitB = h.createUnit(teacherB);
    a1 = h.enrolStudent(unitA); a2 = h.enrolStudent(unitA);
    b1 = h.enrolStudent(unitB);
    h.groupTogether(unitA, [a1, a2]);
  });
  after(() => h.close());

  test('A2: a teacher cannot override a team that belongs to another teacher\'s unit', () => {
    const teamA = h.teamOf(unitA, a1);
    // Teacher B owns unitB and passes their own unit id with A's team id.
    expectServiceError(() => h.unitService.overrideTeam(unitB, teacherB, teamA.team_id, 'finalise'), 404);
    expectServiceError(() => h.unitService.overrideTeam(unitB, teacherB, teamA.team_id, 'dissolve'), 404);
    assert.equal(h.teamOf(unitA, a1).status, 'OPEN');
    assert.equal(h.membersOf(unitA, a1).length, 2);
    // The owner still can.
    h.unitService.overrideTeam(unitA, teacherA, teamA.team_id, 'finalise');
    assert.equal(h.teamOf(unitA, a1).status, 'FINALISED');
    // And batches / previews are ownership-scoped too.
    expectServiceError(() => h.unitService.listFinaliseBatches(unitA, teacherB), 404);
    expectServiceError(() => h.unitService.previewRulesImpact(unitA, teacherB, {}), 404);
  });

  test('A3: kick is scoped to the unit in the URL; no team-of-one is created in the wrong unit', () => {
    const unitC = h.createUnit(teacherA);
    const c1 = h.enrolStudent(unitC), c2 = h.enrolStudent(unitC);
    const teamC = h.groupTogether(unitC, [c1, c2]);
    const teamsInBBefore = h.repos.teams.listAllWithCounts(unitB).length;

    // c1 owns teamC (in unitC) but passes unitB in the URL.
    expectServiceError(() => h.studentPortalService.kickMember(unitB, teamC, c1, c2), 404);
    assert.equal(h.repos.teams.countMembers(teamC), 2);
    assert.equal(h.repos.teams.listAllWithCounts(unitB).length, teamsInBBefore);
  });

  test('A4: a teacher cannot flip progress flags in a unit they do not own', () => {
    expectServiceError(() => h.unitService.setStudentStage(unitA, teacherB, a1, 'read_rules', 1), 404);
    assert.equal(h.progressOf(unitA, a1).read_rules, 0);
    h.unitService.setStudentStage(unitA, teacherA, a1, 'read_rules', 1);
    assert.equal(h.progressOf(unitA, a1).read_rules, 1);
  });

  test('A5/A6: a student cannot list classmates or view a team in a unit they have not joined', () => {
    expectServiceError(() => h.studentPortalService.searchClassmates(unitA, b1, {}), 403);
    const teamA = h.teamOf(unitA, a1);
    expectServiceError(() => h.studentPortalService.getTeamView(unitA, teamA.team_id, b1), 403);
    // Enrolled students still can.
    assert.ok(h.studentPortalService.searchClassmates(unitA, a1, {}).length >= 1);
    assert.equal(h.studentPortalService.getTeamView(unitA, teamA.team_id, a2).team.team_id, teamA.team_id);
  });

  test('A7: preferences, tutorial slots and progress are per-enrolment', () => {
    expectServiceError(() => h.studentPortalService.getPrefs(unitA, b1), 403);
    expectServiceError(() => h.studentPortalService.savePrefs(unitA, b1, {
      projectInterests: 'x', skills: 'y', preferredRole: 'z' }), 403);
    expectServiceError(() => h.studentPortalService.getTutorialSlots(unitA, b1), 403);
    expectServiceError(() => h.studentPortalService.setProgressStage(unitA, b1, 'read_rules', 1), 403);
    expectServiceError(() => h.studentPortalService.getMyTeam(unitA, b1), 403);
    assert.equal(h.repos.prefs.get(unitA, b1), null);
  });

  test('A8: an outsider cannot read (or trigger the producer for) another unit\'s notifications', () => {
    expectServiceError(() => h.studentPortalService.listNotifications(unitA, b1), 403);
    expectServiceError(() => h.studentPortalService.unreadNotificationCount(unitA, b1), 403);
  });

  test('A1: a team-up request and a declaration are per-enrolment', () => {
    expectServiceError(() => h.studentPortalService.declareNoPreference(unitA, b1), 403);
    const teamA = h.teamOf(unitA, a1);
    expectServiceError(() => h.studentPortalService.sendRequest(unitA, b1, teamA.team_id), 400);
  });
});

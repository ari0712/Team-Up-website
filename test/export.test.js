const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/harness');

describe('export — the coordinator\'s report', () => {
  let h, teacher, unitId;
  const who = {};

  before(async () => {
    h = await createHarness();
    teacher = h.createTeacher();
    unitId = h.createUnit(teacher, { validTeamSizes: '4,5' });

    who.pair = [h.enrolStudent(unitId, { username: 'pat', name: 'Pat Lee', slots: 'Tue 10', studentNumber: 'n1', newToQut: 1 }),
                h.enrolStudent(unitId, { username: 'sam', name: 'Sam Roe', slots: 'Tue 10,Wed 2', studentNumber: 'n2' })];
    h.teamUp(unitId, 'sam', 'pat');
    // The coordinator finalised this one.
    h.unitService.overrideTeam(unitId, teacher, h.teamOf(unitId, 'pat').team_id, 'finalise');

    who.trio = ['kim', 'lou', 'max'].map(u => h.enrolStudent(unitId, { username: u, slots: 'Wed 2' }));
    h.teamUp(unitId, 'lou', 'kim'); h.teamUp(unitId, 'max', 'kim');

    who.declared = h.enrolStudent(unitId, { username: 'dee' });
    h.studentPortalService.declareNoPreference(unitId, 'dee');

    who.silent = h.enrolStudent(unitId, { username: 'sol', prefs: false });
  });
  after(() => h.close());

  test('summary counts the three placement categories and the two statuses', () => {
    const { summary } = h.unitService.buildExport(unitId, teacher);
    assert.deepEqual(summary.placements, { GROUPED: 5, DECLARED: 1, SILENT: 1 });
    assert.equal(summary.total, 7);
    assert.equal(summary.teamsByStatus.FINALISED, 1);
    assert.equal(summary.teamsByStatus.OPEN, 3);   // trio + two solos
    assert.ok(!('GROUPED_UNSUBMITTED' in summary.placements));
  });

  test('ungrouped rows carry a category for every solo student', () => {
    const { ungrouped } = h.unitService.buildExport(unitId, teacher);
    const byName = new Map(ungrouped.map(r => [r['Name'], r]));
    assert.equal(ungrouped.length, 2);
    assert.equal(byName.get('sol')['Category'], 'No activity recorded');
    assert.equal(byName.get('dee')['Category'], 'Declared no preference');
    assert.ok(!byName.has('kim'), 'a formed group is a recorded group — Teams sheet only');
    assert.equal(byName.get('sol')['Preferences entered'], 'No');
    assert.equal(byName.get('dee')['Preferences entered'], 'Yes');
    // Most urgent first.
    assert.equal(ungrouped[0]['Category'], 'No activity recorded');
    assert.equal(ungrouped[ungrouped.length - 1]['Category'], 'Declared no preference');
    // Recorded students are described by the Teams rows, not repeated here.
    assert.ok(!byName.has('Pat Lee'));
  });

  test('a finalised pair appears as one team with its shared tutorial slot and size', () => {
    const { teams } = h.unitService.buildExport(unitId, teacher);
    const rows = teams.filter(r => ['Pat Lee', 'Sam Roe'].includes(r['Member Name']));
    assert.equal(rows.length, 2);
    assert.equal(rows[0]['Team'], rows[1]['Team']);
    assert.equal(rows[0]['Team Status'], 'Finalised');
    assert.equal(rows[0]['Shared Tutorial'], 'Tue 10');
    assert.equal(rows[0]['Size'], '2 of 4–5');
  });

  test('an open group appears in the Teams sheet with status Open', () => {
    const { teams } = h.unitService.buildExport(unitId, teacher);
    const rows = teams.filter(r => r['Member Name'] === 'kim' || r['Member Name'] === 'lou' || r['Member Name'] === 'max');
    assert.equal(rows.length, 3);
    assert.ok(rows.every(r => r['Team Status'] === 'Open'));
    assert.ok(rows.every(r => r['Team'] === rows[0]['Team']));
    assert.equal(rows[0]['Size'], '3 of 4–5');
  });

  test('every row carries the student\'s email and no row carries a "Student ID"', () => {
    const { teams, ungrouped } = h.unitService.buildExport(unitId, teacher);
    for (const r of [...teams, ...ungrouped]) {
      assert.ok(!('Student ID' in r), 'the username must not be exported as "Student ID"');
      assert.match(r['Email'], /^[a-z]+@example\.edu$/, `bad email on ${JSON.stringify(r)}`);
    }
    const pat = teams.find(r => r['Member Name'] === 'Pat Lee');
    assert.equal(pat['Email'], 'pat@example.edu');
    const sol = ungrouped.find(r => r['Name'] === 'sol');
    assert.equal(sol['Email'], 'sol@example.edu');
  });

  test('the student number is exported only when the unit opts in', () => {
    let out = h.unitService.buildExport(unitId, teacher);
    assert.ok(out.teams.every(r => !('Student number' in r)));
    assert.ok(out.ungrouped.every(r => !('Student number' in r)));
    assert.equal(out.unit.export_student_number, false);

    h.unitService.updateRules(unitId, teacher, { exportStudentNumber: true });
    out = h.unitService.buildExport(unitId, teacher);
    assert.equal(out.unit.export_student_number, true);
    assert.equal(out.teams.find(r => r['Member Name'] === 'Pat Lee')['Student number'], 'n1');
    // Blank, never invented, for a student who never entered one.
    assert.equal(out.ungrouped.find(r => r['Name'] === 'sol')['Student number'], '');

    h.unitService.updateRules(unitId, teacher, { exportStudentNumber: false });
    assert.ok(h.unitService.buildExport(unitId, teacher).teams.every(r => !('Student number' in r)));
  });

  test('"New to QUT" is on both sheets even though this unit sets no cap', () => {
    // The flag is information the coordinator balances by hand; the CAP is a
    // separate, optional rule. Removing the rule must never remove the column.
    assert.equal(h.repos.unitRepo.findById(unitId).max_new_to_qut, 0);
    const { teams, ungrouped } = h.unitService.buildExport(unitId, teacher);
    assert.ok(teams.every(r => 'New to QUT' in r));
    assert.ok(ungrouped.every(r => 'New to QUT' in r));
    assert.equal(teams.find(r => r['Member Name'] === 'Pat Lee')['New to QUT'], 'Yes');
    assert.equal(teams.find(r => r['Member Name'] === 'Sam Roe')['New to QUT'], 'No');
    assert.equal(ungrouped.find(r => r['Name'] === 'sol')['New to QUT'], 'No');
    // And the class list shows it too.
    const pat = h.unitService.getClassList(unitId, teacher).find(s => s.student_id === 'pat');
    assert.equal(pat.is_new_to_qut, 1);
  });

  test('a CSV "new to QUT" of Yes / 1 lands on the enrolment row; a blank top-up keeps it', () => {
    const u = h.createUnit(teacher);                                     // cap off — irrelevant to the flag
    // The parser hands the raw cell text through; the repository reads Yes/1/true.
    h.unitService.importRoster(u, teacher, [
      { email: 'yes@example.edu',  is_new_to_qut: 'Yes' },
      { email: 'one@example.edu',  is_new_to_qut: '1' },
      { email: 'no@example.edu',   is_new_to_qut: 'No' },
      { email: 'none@example.edu' },
    ]);
    // An email-only top-up must not wipe the flag an earlier import set.
    h.unitService.importRoster(u, teacher, [{ email: 'yes@example.edu' }]);
    const roster = new Map(h.repos.roster.listForUnitWithJoined(u).map(r => [r.email, r.is_new_to_qut]));
    assert.deepEqual([...roster.entries()].sort(),
      [['no@example.edu', 0], ['none@example.edu', 0], ['one@example.edu', 1], ['yes@example.edu', 1]]);

    // Joining copies it onto unit_students, which is what the class list and export read.
    h.authService.signUp('yes', 'pw', 'yes@example.edu', 'STUDENT');
    h.studentPortalService.joinUnit(u, 'yes');
    assert.equal(h.unitService.getClassList(u, teacher).find(s => s.student_id === 'yes').is_new_to_qut, 1);
  });

  test('another teacher cannot export the unit', () => {
    const other = h.createTeacher();
    assert.throws(() => h.unitService.buildExport(unitId, other), e => e.status === 404);
  });
});

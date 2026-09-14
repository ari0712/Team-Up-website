const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, expectServiceError } = require('./helpers/harness');

describe('classmate search — name-tolerant, email-exact, email shown only where names collide', () => {
  let h, teacher, unitId, me;
  before(async () => {
    h = await createHarness(); teacher = h.createTeacher();
    unitId = h.createUnit(teacher);
    me = h.enrolStudent(unitId, { username: 'viewer', name: 'Viewer One', studentNumber: 'n0000001' });
    h.enrolStudent(unitId, { username: 'alex1', name: 'Alex Chen', studentNumber: 'n8123457' });
    h.enrolStudent(unitId, { username: 'alex2', name: 'Alex Chen', studentNumber: 'n2222222' });
    h.enrolStudent(unitId, { username: 'sam',   name: 'Samuel Ng', studentNumber: 'n3333333' });
    h.enrolStudent(unitId, { username: 'jo',    name: 'Jo Alexander', studentNumber: 'n4444444' });
    h.enrolStudent(unitId, { username: 'zq9x',  name: 'Pat Lee',      studentNumber: 'n5555555' });
    // A roster row that carries a number from the CSV import, so a leak of the
    // roster's own column (not just users.student_id) would be caught.
    h.unitService.importRoster(unitId, teacher, [{ email: 'alex1@example.edu', student_number: 'n8123457' }]);
    assert.equal(h.repos.roster.findByEmail(unitId, 'alex1@example.edu').student_number, 'n8123457');
  });
  after(() => h.close());
  const search = (q, extra = {}) => h.studentPortalService.searchClassmates(unitId, me, { search: q, ...extra });

  test('two students sharing a name both come back, each with their email', () => {
    const rows = search('Alex Chen');
    assert.deepEqual(rows.map(r => r.student_id).sort(), ['alex1', 'alex2']);
    for (const r of rows) {
      assert.equal(r.email, `${r.student_id}@example.edu`);
      assert.equal(r.shared_name, true);
    }
  });

  test('a uniquely named student in the same result set has no email', () => {
    const rows = search('alex');               // Alex Chen ×2 and Jo Alexander
    assert.deepEqual(rows.map(r => r.student_id).sort(), ['alex1', 'alex2', 'jo']);
    const jo = rows.find(r => r.student_id === 'jo');
    assert.ok(!('email' in jo));
    assert.ok(!('shared_name' in jo));
    assert.ok(rows.filter(r => r.student_id !== 'jo').every(r => r.email));
  });

  test('a misspelt name still finds both Alex Chens', () => {
    assert.deepEqual(search('Alx Chen').map(r => r.student_id).sort(), ['alex1', 'alex2']);
    assert.deepEqual(search('chen aelx').map(r => r.student_id).sort(), ['alex1', 'alex2']);
  });

  test('a partial that matches one student returns them WITHOUT an email', () => {
    const rows = search('Sam');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].student_id, 'sam');
    assert.ok(!('email' in rows[0]));
  });

  test('searching a full address you already hold finds them — but does not echo the address back', () => {
    const rows = search('alex2@example.edu');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].student_id, 'alex2');
    assert.ok(!('email' in rows[0]), 'the searcher typed it; echoing it would confirm a guess');
  });

  test('a fragment of an address finds nothing', () => {
    for (const q of ['alex2@', 'alex2@example', '@example.edu', 'lex2@example.edu']) {
      assert.equal(search(q).length, 0, `"${q}" must not match`);
    }
  });

  test('no student number on any row, and the username is not a search key', () => {
    for (const r of search('')) {
      assert.ok(!('student_number' in r));
      assert.ok(!('studentNumber' in r));
    }
    assert.equal(search('n8123457').length, 0);
    assert.equal(search('zq9x').length, 0, 'the login name is not something students can see');
  });

  test('profile: a classmate never gets your email or number; you get your own email', () => {
    const theirs = h.studentPortalService.getStudentProfile(unitId, me, 'alex1');
    assert.ok(!('email' in theirs));
    assert.ok(!('studentNumber' in theirs));
    const mine = h.studentPortalService.getStudentProfile(unitId, me, me);
    assert.equal(mine.email, 'viewer@example.edu');
    assert.ok(!('studentNumber' in mine));
  });

  test('/api/auth/me shape carries no student number', () => {
    const user = h.repos.studentRepo.findByUsername(me);
    assert.ok(!('studentId' in user));
    assert.ok(!('student_id' in user));
    assert.equal(user.email, 'viewer@example.edu');
  });

  test('teacher class list and roster carry no student number; the export still can, opt-in only', () => {
    for (const s of h.unitService.getClassList(unitId, teacher)) assert.ok(!('student_number' in s));
    for (const r of h.unitService.getRoster(unitId, teacher)) assert.ok(!('student_number' in r));
    assert.ok(h.unitService.buildExport(unitId, teacher).teams.every(r => !('Student number' in r)));
    h.unitService.updateRules(unitId, teacher, { exportStudentNumber: true });
    const rows = h.unitService.buildExport(unitId, teacher).teams;
    assert.equal(rows.find(r => r['Member Name'] === 'Alex Chen' && r['Email'] === 'alex1@example.edu')['Student number'], 'n8123457');
    h.unitService.updateRules(unitId, teacher, { exportStudentNumber: false });
  });

  test('payload sweep: no stored number appears anywhere a student can read', () => {
    // Every number stored for the unit — the sweep must catch a leak of a
    // classmate's number, not only the viewer's own.
    const enrolled = h.unitService.getClassList(unitId, teacher).map(s => s.student_id);
    const numbers = [...h.repos.userRepo.listStudentNumbers(enrolled).values()].filter(Boolean);
    assert.ok(numbers.length >= 6, 'fixture must actually have numbers stored');
    assert.ok(numbers.every(n => /^n\d{7}$/.test(n)), 'numbers must be distinctive, not "1" or "123"');

    // Positive control: the numbers ARE stored and DO surface on the one
    // sanctioned path, so a sweep that finds nothing is finding nothing for
    // the right reason.
    h.unitService.updateRules(unitId, teacher, { exportStudentNumber: true });
    const exportJson = JSON.stringify(h.unitService.buildExport(unitId, teacher));
    assert.ok(numbers.every(n => exportJson.includes(n)), 'the opt-in export must carry every number');
    h.unitService.updateRules(unitId, teacher, { exportStudentNumber: false });

    h.teamUp(unitId, 'alex1', 'alex2');
    for (const viewer of [me, 'alex1']) {
      const blobs = [
        h.studentPortalService.getMyTeam(unitId, viewer),
        h.studentPortalService.searchClassmates(unitId, viewer, {}),
        h.studentPortalService.searchClassmates(unitId, viewer, { search: 'alex' }),
        h.studentPortalService.getStudentProfile(unitId, viewer, 'alex2'),
        h.studentPortalService.getStudentProfile(unitId, viewer, viewer),
        h.studentPortalService.listRequests(unitId, viewer),
        h.studentPortalService.listNotifications(unitId, viewer),
        h.studentPortalService.getProgress(unitId, viewer),
        h.studentPortalService.listUnits(viewer),
        h.studentPortalService.autoMatch(unitId, viewer),
        h.repos.studentRepo.findByUsername(viewer),
      ];
      for (const b of blobs) {
        const json = JSON.stringify(b);
        for (const n of numbers) assert.ok(!json.includes(n), `${n} leaked to ${viewer}: ${json.slice(0, 160)}`);
      }
    }
    // Teacher-facing payloads that are NOT the opt-in export are clean too.
    for (const b of [h.unitService.getClassList(unitId, teacher), h.unitService.getRoster(unitId, teacher),
                     h.unitService.getAllTeams(unitId, teacher), h.unitService.buildExport(unitId, teacher)]) {
      const json = JSON.stringify(b);
      for (const n of numbers) assert.ok(!json.includes(n), `${n} leaked to teacher: ${json.slice(0, 160)}`);
    }
  });

  test('rate limit: the 31st search in the window is refused and logged without the query', async () => {
    const h2 = await createHarness();
    const warned = [];
    const origWarn = console.warn; console.warn = (...a) => warned.push(a);
    try {
      const t2 = h2.createTeacher();
      const u2 = h2.createUnit(t2), u3 = h2.createUnit(t2);
      const a = h2.enrolStudent(u2), b = h2.enrolStudent(u2);
      h2.enrolStudent(u3, { username: a }); h2.enrolStudent(u3, { username: b });
      for (let i = 0; i < 30; i++) h2.studentPortalService.searchClassmates(u2, a, { search: 'secret-query' });
      const e = expectServiceError(() => h2.studentPortalService.searchClassmates(u2, a, { search: 'secret-query' }), 429, 'SEARCH_RATE_LIMITED');
      assert.match(e.message, /Too many searches/);
      assert.equal(warned.length, 1);
      const line = JSON.stringify(warned[0]);
      assert.ok(line.includes(a) && line.includes(u2));
      assert.ok(!line.includes('secret-query'));
      // Another student, and the same student in another unit, are unaffected.
      assert.ok(Array.isArray(h2.studentPortalService.searchClassmates(u2, b, {})));
      assert.ok(Array.isArray(h2.studentPortalService.searchClassmates(u3, a, {})));
    } finally { console.warn = origWarn; h2.close(); }
  });
});

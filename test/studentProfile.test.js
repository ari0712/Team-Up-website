const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, expectServiceError } = require('./helpers/harness');

// A coordinator can read what a student wrote about themselves, and reads
// exactly what a classmate would: same shape, same values, one builder
// (utils/studentProfile.js). The differences are deliberate and tested here —
// the teacher gets the email and never gets `isSelf`.
describe('full profile — teachers read the same profile students do', () => {
  let h, teacher, otherTeacher, unitId, otherUnit, student, classmate;

  before(async () => {
    h = await createHarness();
    teacher = h.createTeacher();
    otherTeacher = h.createTeacher();
    unitId = h.createUnit(teacher);
    otherUnit = h.createUnit(otherTeacher);
    student = h.enrolStudent(unitId, { name: 'Robin Vale', slots: 'Tue 10', role: 'Team Leader' });
    classmate = h.enrolStudent(unitId);

    h.studentPortalService.saveAbout(unitId, student, {
      about_goals: 'I want to ship something real.\n\nAnd learn to review code.',
      about_commitment: 'About ten hours a week.',
    });
  });
  after(() => h.close());

  test('a teacher gets the About Me answers, the header fields and the address', () => {
    const p = h.unitService.getStudentProfile(unitId, teacher, student);
    assert.equal(p.studentId, student);
    assert.equal(p.name, 'Robin Vale');
    assert.equal(p.isSelf, false);
    assert.equal(p.email, `${student}@example.edu`);
    assert.equal(p.preferredRole, 'Team Leader');
    assert.equal(p.tutorialSlots, 'Tue 10');

    const by = Object.fromEntries(p.about.map(f => [f.key, f.value]));
    assert.match(by.about_goals, /ship something real/);
    assert.equal(by.about_commitment, 'About ten hours a week.');
    // Every prompt comes back, blank ones included, each with its label.
    assert.equal(p.about.length, require('../utils/aboutFields').ABOUT_FIELDS.length);
    assert.equal(by.about_experience, '');
    assert.ok(p.about.every(f => f.label));
  });

  test('it is the same data the student portal serves to a classmate', () => {
    const asTeacher = h.unitService.getStudentProfile(unitId, teacher, student);
    const asClassmate = h.studentPortalService.getStudentProfile(unitId, classmate, student);
    assert.deepEqual(asTeacher.about, asClassmate.about);
    assert.equal(asTeacher.preferredRole, asClassmate.preferredRole);
    assert.equal(asTeacher.skills, asClassmate.skills);
    // The classmate still gets no address; that rule is unchanged.
    assert.ok(!('email' in asClassmate));
  });

  test('a teacher who does not own the unit cannot read into it', () => {
    expectServiceError(() => h.unitService.getStudentProfile(unitId, otherTeacher, student), 404);
    // Nor by passing their own unit id with a student who is not in it.
    expectServiceError(() => h.unitService.getStudentProfile(otherUnit, otherTeacher, student), 404);
  });

  test('rostered but never joined has no profile to show', () => {
    h.unitService.importRoster(unitId, teacher, [{ email: 'ghost@example.edu', name: 'Ghost' }]);
    expectServiceError(() => h.unitService.getStudentProfile(unitId, teacher, 'ghost'), 404);
    expectServiceError(() => h.unitService.getStudentProfile(unitId, teacher, 'nobody-at-all'), 404);
  });
});

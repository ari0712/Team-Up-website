const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, inDays } = require('./helpers/harness');

function teacherInbox(h, unitId, teacher) {
  return h.notificationService.listForTeacher(unitId, teacher);
}
const attention = rows => rows.filter(n => n.type === 'needs_attention');

describe('teacher notification volume is bounded by placement, not by class size', () => {
  let h, teacher;
  before(async () => { h = await createHarness(); teacher = h.createTeacher(); });
  after(() => h.close());

  test('300 silent students produce ONE summary line, linking to the filtered class list', () => {
    // Inside the at-risk window: deadline in 2 days, at_risk_days 3.
    const unitId = h.createUnit(teacher, { deadline: inDays(2), atRiskDays: 3 });
    // Prime the teacher inbox so the first real sync is not treated as a seed
    // backfill (which would mark everything already-read).
    teacherInbox(h, unitId, teacher);
    for (let i = 0; i < 300; i++) h.enrolStudent(unitId, { prefs: false });

    const rows = attention(teacherInbox(h, unitId, teacher));
    assert.ok(rows.length <= 22, `expected a bounded inbox, got ${rows.length} attention rows`);

    const silent = rows.filter(n => n.dedupeKey?.includes(':silent:') || /nothing recorded/.test(n.title));
    assert.equal(silent.length, 1);
    assert.equal(silent[0].severity, 'CRITICAL');
    assert.match(silent[0].body, /300 students have no team/);
    assert.match(silent[0].link, /class-list\.html\?unitId=.*&placement=SILENT/);
    // No per-student rows.
    assert.ok(!rows.some(n => /is alone/.test(n.title)));

    // Idempotent: a second pass adds nothing.
    const again = attention(teacherInbox(h, unitId, teacher));
    assert.equal(again.length, rows.length);
  });

  test('declared students never raise a signal; a silent one does', () => {
    const unitId = h.createUnit(teacher, { deadline: inDays(1), atRiskDays: 3 });
    teacherInbox(h, unitId, teacher);
    const d = h.enrolStudent(unitId);
    h.studentPortalService.declareNoPreference(unitId, d);
    assert.equal(attention(teacherInbox(h, unitId, teacher)).length, 0);

    h.enrolStudent(unitId);   // silent
    const rows = attention(teacherInbox(h, unitId, teacher));
    assert.equal(rows.length, 1);
    assert.match(rows[0].body, /^1 student has no team/);
  });

  test('a formed pair is quiet on the teacher side; finalising notifies its members once', () => {
    const unitId = h.createUnit(teacher, { deadline: inDays(2), atRiskDays: 3 });
    teacherInbox(h, unitId, teacher);
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId);
    h.studentPortalService.listNotifications(unitId, a);
    h.teamUp(unitId, a, b);
    // Nothing for the coordinator to chase: a formed group is a recorded group.
    assert.equal(attention(teacherInbox(h, unitId, teacher)).length, 0);
    assert.ok(!h.studentPortalService.listNotifications(unitId, a).some(n => /not recorded/.test(n.title)));

    h.unitService.overrideTeam(unitId, teacher, h.teamOf(unitId, a).team_id, 'finalise');
    const mine = h.studentPortalService.listNotifications(unitId, a).filter(n => /has been finalised/.test(n.title));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].read_at, null);
  });
});

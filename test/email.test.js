const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, inDays } = require('./helpers/harness');
const Database = require('../db/Database');
const { createServices } = require('../services/container');
const { createTransport, ConsoleTransport } = require('../services/email/transport');
const NotificationService = require('../services/notificationService');

const mailsTo = (h, addr) => h.transport.sent.filter(m => m.to === addr);
const sentFor = (h, addr, re) => mailsTo(h, addr).filter(m => re.test(m.subject));
const outboxFor = (h, id) => h.repos.outbox.findByNotification(id);
// Raw rows: the inbox listing omits dedupe_key and emailed_at on purpose.
const noteBy = (h, unitId, sid, re) =>
  h.db.all(`SELECT * FROM notifications WHERE unit_id = ? AND student_id = ?`, [unitId, sid])
    .find(n => re.test(n.dedupe_key || '') || re.test(n.title));

describe('email delivery — a channel for the existing notification events', () => {
  let h, teacher;
  before(async () => { h = await createHarness(); teacher = h.createTeacher(); });
  after(() => h.close());

  test('the no-op console transport is the default, and the harness uses a recording one', () => {
    assert.ok(createTransport({}) instanceof ConsoleTransport);
    assert.equal(createTransport({}).name, 'console');
    assert.ok(Array.isArray(h.transport.sent));
    assert.equal(h.transport.name, 'test');
  });

  test('a new request emails the recipient once — not the sender, and not twice across passes', async () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId);
    h.studentPortalService.sendRequest(unitId, a, h.teamOf(unitId, b).team_id);

    await h.notificationService.dispatchEmails();
    assert.equal(sentFor(h, `${b}@example.edu`, /New team-up request/).length, 1);
    assert.equal(sentFor(h, `${a}@example.edu`, /New team-up request/).length, 0);
    const before = h.transport.sent.length;
    await h.notificationService.dispatchEmails();
    await h.notificationService.dispatchEmails();
    assert.equal(h.transport.sent.length, before, 'second and third passes send nothing');
  });

  test('dedupe survives a restart: re-opening the same database file resends nothing', async () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId);
    h.studentPortalService.sendRequest(unitId, a, h.teamOf(unitId, b).team_id);
    await h.notificationService.dispatchEmails();
    assert.equal(sentFor(h, `${b}@example.edu`, /New team-up request/).length, 1);

    // A "restart": a fresh Database on the same file and a fresh service graph.
    const db2 = await new Database(h.filePath).connect();
    const fresh = createServices({ db: db2, transport: { name: 'test2', sent: [], async send(m) { this.sent.push(m); return {}; } }, env: {} });
    fresh.notificationService.syncForUnit(unitId);
    const r = await fresh.notificationService.dispatchEmails();
    assert.equal(fresh.notificationService.transport.sent.length, 0);
    assert.equal(r.sent, 0);
  });

  test('accepted, declined and no-longer-valid each email exactly once', async () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId), c = h.enrolStudent(unitId), d = h.enrolStudent(unitId);
    // accepted
    const r1 = h.studentPortalService.sendRequest(unitId, a, h.teamOf(unitId, b).team_id);
    h.studentPortalService.respondToRequest(r1.requestId, b, 'accept');
    // declined
    const r2 = h.studentPortalService.sendRequest(unitId, c, h.teamOf(unitId, d).team_id);
    h.studentPortalService.respondToRequest(r2.requestId, d, 'decline');
    h.notificationService.syncForUnit(unitId);
    await h.notificationService.dispatchEmails();
    for (const who of [a, b]) assert.equal(sentFor(h, `${who}@example.edu`, /Request accepted/).length, 1, who);
    for (const who of [c, d]) assert.equal(sentFor(h, `${who}@example.edu`, /Request declined/).length, 1, who);
    await h.notificationService.dispatchEmails();
    assert.equal(sentFor(h, `${a}@example.edu`, /Request accepted/).length, 1);
  });

  test('expired is never emailed; auto_cancelled is emailed to a loser-only student but suppressed for one who also won', async () => {
    const unitId = h.createUnit(teacher, { validTeamSizes: '4' });
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId), c = h.enrolStudent(unitId);
    // a asks b, and c asks b. b accepts a's → c's is auto_cancelled.
    const ra = h.studentPortalService.sendRequest(unitId, a, h.teamOf(unitId, b).team_id);
    const rc = h.studentPortalService.sendRequest(unitId, c, h.teamOf(unitId, b).team_id);
    h.studentPortalService.respondToRequest(ra.requestId, b, 'accept');
    assert.equal(h.teamRequestService.getRequest(rc.requestId).state, 'auto_cancelled');
    assert.equal(h.teamRequestService.getRequest(rc.requestId).superseded_by, ra.requestId);

    h.notificationService.syncForUnit(unitId);
    // Prove the rule does not depend on timestamps: push the two notifications apart.
    const winB = noteBy(h, unitId, b, /:approved$/), lostB = noteBy(h, unitId, b, /:auto_cancelled$/);
    h.db.run(`UPDATE notifications SET created_at = ? WHERE id = ?`, ['2001-01-01T00:00:00.000Z', winB.id]);
    h.db.run(`UPDATE notifications SET created_at = ? WHERE id = ?`, ['2002-02-02T00:00:00.000Z', lostB.id]);

    await h.notificationService.dispatchEmails();
    // b was in both: accepted email yes, withdrawn email suppressed.
    assert.equal(sentFor(h, `${b}@example.edu`, /Request accepted/).length, 1);
    assert.equal(sentFor(h, `${b}@example.edu`, /Request withdrawn/).length, 0);
    assert.match(outboxFor(h, lostB.id)[0].error, /superseded/);
    // c only lost: the withdrawn email is their sole signal.
    assert.equal(sentFor(h, `${c}@example.edu`, /Request withdrawn/).length, 1);

    // expired: force one and confirm it is skipped as not an email event.
    const d = h.enrolStudent(unitId), e = h.enrolStudent(unitId);
    const rd = h.studentPortalService.sendRequest(unitId, d, h.teamOf(unitId, e).team_id);
    h.db.run(`UPDATE proposals SET expires_at = ? WHERE proposal_id = ?`, ['2000-01-01T00:00:00.000Z', rd.requestId]);
    h.teamRequestService.sweepExpired();
    h.notificationService.syncForUnit(unitId);
    await h.notificationService.dispatchEmails();
    const exp = noteBy(h, unitId, e, /:expired$/);
    assert.ok(exp);
    assert.equal(sentFor(h, `${e}@example.edu`, /Request expired/).length, 0);
    assert.match(outboxFor(h, exp.id)[0].error, /not an email event/);
  });

  test('the 24 h expiry warning fires once, not before, and at creation when the unit deadline is near', async () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId);
    const r = h.studentPortalService.sendRequest(unitId, a, h.teamOf(unitId, b).team_id);
    assert.equal(noteBy(h, unitId, b, /:expiring$/), undefined, 'not warned with 48 h of runway');
    // Move the expiry inside the window and sweep.
    h.db.run(`UPDATE proposals SET expires_at = ? WHERE proposal_id = ?`,
      [new Date(Date.now() + 20 * 3600000).toISOString(), r.requestId]);
    h.notificationService.syncForUnit(unitId);
    h.notificationService.syncForUnit(unitId);
    const warn = noteBy(h, unitId, b, /:expiring$/);
    assert.ok(warn);
    assert.match(warn.title, /expires in 20 hours/);
    assert.equal(noteBy(h, unitId, a, /:expiring$/), undefined, 'the sender is not warned');
    await h.notificationService.dispatchEmails();
    await h.notificationService.dispatchEmails();
    assert.equal(sentFor(h, `${b}@example.edu`, /expires in/).length, 1);

    // Created with the unit deadline 10 h away: expires_at is clamped and the
    // warning exists immediately, without any sweep.
    const u2 = h.createUnit(teacher, { deadline: new Date(Date.now() + 10 * 3600000).toISOString() });
    const c = h.enrolStudent(u2), d = h.enrolStudent(u2);
    const r2 = h.studentPortalService.sendRequest(u2, c, h.teamOf(u2, d).team_id);
    const exp = Date.parse(h.teamRequestService.getRequest(r2.requestId).expires_at);
    assert.ok(exp - Date.now() <= 10 * 3600000 + 5000, 'clamped to the deadline');
    const w2 = noteBy(h, u2, d, /:expiring$/);
    assert.ok(w2, 'warned at creation');
    assert.match(w2.title, /expires in 10 hours/);
  });

  test('finalised and reopened email the members once each', async () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId);
    h.teamUp(unitId, a, b);
    const teamId = h.teamOf(unitId, a).team_id;
    h.unitService.overrideTeam(unitId, teacher, teamId, 'finalise');
    h.notificationService.syncForUnit(unitId);
    await h.notificationService.dispatchEmails();
    h.unitService.overrideTeam(unitId, teacher, teamId, 'reopen');
    h.notificationService.syncForUnit(unitId);
    await h.notificationService.dispatchEmails();
    await h.notificationService.dispatchEmails();
    for (const who of [a, b]) {
      assert.equal(sentFor(h, `${who}@example.edu`, /has been finalised/).length, 1);
      assert.equal(sentFor(h, `${who}@example.edu`, /reopened your team/).length, 1);
    }
  });

  test('deadline reminders are off by default; opting in delivers them', async () => {
    const unitId = h.createUnit(teacher, { deadline: inDays(2) });
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId);
    // Prime inboxes so the events below are fresh rather than seed-backfilled.
    h.studentPortalService.listNotifications(unitId, a); h.studentPortalService.listNotifications(unitId, b);
    h.notificationService.syncForUnit(unitId);
    await h.notificationService.dispatchEmails();
    assert.equal(sentFor(h, `${a}@example.edu`, /Deadline/).length, 0);
    const dl = noteBy(h, unitId, a, /^deadline:/);
    assert.match(outboxFor(h, dl.id)[0].error, /category off: deadline/);

    // b opts in before the next bucket lands.
    h.studentPortalService.saveEmailPrefs(unitId, b, { deadline: true });
    h.unitService.updateRules(unitId, teacher, { deadline: inDays(0.5) });   // → the 1d bucket
    h.notificationService.syncForUnit(unitId);
    await h.notificationService.dispatchEmails();
    assert.equal(sentFor(h, `${b}@example.edu`, /Deadline tomorrow/).length, 1);
    assert.equal(sentFor(h, `${a}@example.edu`, /Deadline tomorrow/).length, 0);
    const prefs = h.studentPortalService.getEmailPrefs(unitId, b);
    assert.deepEqual(prefs.categories, { requests: 1, team: 1, deadline: 1 });
  });

  test('the requests category can be switched off, and the master switch overrides everything', async () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId), c = h.enrolStudent(unitId);
    h.studentPortalService.saveEmailPrefs(unitId, b, { requests: false });
    h.notificationService.savePrefs(c, { emailEnabled: false });
    h.studentPortalService.sendRequest(unitId, a, h.teamOf(unitId, b).team_id);
    h.studentPortalService.sendRequest(unitId, a, h.teamOf(unitId, c).team_id);
    await h.notificationService.dispatchEmails();
    assert.equal(mailsTo(h, `${b}@example.edu`).length, 0);
    assert.equal(mailsTo(h, `${c}@example.edu`).length, 0);
    assert.match(outboxFor(h, noteBy(h, unitId, b, /:open$/).id)[0].error, /category off: requests/);
    assert.match(outboxFor(h, noteBy(h, unitId, c, /:open$/).id)[0].error, /disabled email/);
  });

  test('every student email carries an absolute link and a working unsubscribe link', async () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId);
    h.studentPortalService.sendRequest(unitId, a, h.teamOf(unitId, b).team_id);
    await h.notificationService.dispatchEmails();
    const mail = sentFor(h, `${b}@example.edu`, /New team-up request/)[0];
    assert.match(mail.body, /Open TeamUp: http:\/\/localhost:3000\/student\/dashboard\.html\?unitId=/);
    const m = mail.body.match(/Stop these emails: (http:\/\/localhost:3000\/unsubscribe\?t=([^&\s]+)&u=([^&\s]+)&c=requests)/);
    assert.ok(m, 'unsubscribe URL present');
    const token = decodeURIComponent(m[2]);
    assert.ok(!mail.body.includes('undefined'));

    const r = h.studentPortalService.unsubscribeByToken(token, unitId, 'requests');
    assert.equal(r.category, 'requests');
    assert.equal(h.studentPortalService.getEmailPrefs(unitId, b).categories.requests, 0);
    assert.equal(h.studentPortalService.getEmailPrefs(unitId, b).categories.team, 1, 'only that category');
    assert.equal(h.studentPortalService.unsubscribeByToken('not-a-token', unitId, 'requests'), null);
    assert.equal(h.studentPortalService.unsubscribeByToken(token, unitId, 'bogus'), null);
  });

  test('a throwing transport leaves a failed outbox row, a stamped notification, and no retry', async () => {
    const unitId = h.createUnit(teacher);
    const a = h.enrolStudent(unitId), b = h.enrolStudent(unitId);
    h.studentPortalService.sendRequest(unitId, a, h.teamOf(unitId, b).team_id);
    const real = h.notificationService.transport;
    h.notificationService.transport = { name: 'boom', async send() { throw new Error('SMTP down'); } };
    try {
      const r = await h.notificationService.dispatchEmails();
      assert.equal(r.failed, 1);
    } finally { h.notificationService.transport = real; }
    const n = noteBy(h, unitId, b, /:open$/);
    assert.ok(n.emailed_at, 'stamped even though the send failed');
    const rows = outboxFor(h, n.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'failed');
    assert.match(rows[0].error, /SMTP down/);
    const before = h.transport.sent.length;
    await h.notificationService.dispatchEmails();
    assert.equal(h.transport.sent.length, before, 'no retry');
  });

  test('daily cap: the 11th email to one student in a day is dropped with a reason and one warn line', async () => {
    const unitId = h.createUnit(teacher, { validTeamSizes: '20' });
    const target = h.enrolStudent(unitId, { username: 'popular' });
    const warned = [];
    const origWarn = console.warn; console.warn = (...a) => warned.push(a);
    try {
      // 11 distinct senders each ask `popular` to team up → 11 distinct events.
      for (let i = 0; i < 11; i++) {
        const s = h.enrolStudent(unitId);
        h.studentPortalService.sendRequest(unitId, s, h.teamOf(unitId, target).team_id);
      }
      await h.notificationService.dispatchEmails();
    } finally { console.warn = origWarn; }
    assert.equal(mailsTo(h, 'popular@example.edu').length, NotificationService.EMAIL_DAILY_CAP);
    const skipped = h.repos.outbox.listRecent(50).filter(r => r.intended_recipient === 'popular@example.edu' && r.status === 'skipped');
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].error, /daily cap/);
    const capLines = warned.filter(a => /daily cap/.test(String(a[0])));
    assert.equal(capLines.length, 1);
    assert.ok(!JSON.stringify(capLines[0]).includes('team up'), 'never the message body');
  });
});

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, PAST } = require('./helpers/harness');
const SchemaMigrator = require('../db/SchemaMigrator');

// Wall time and SQL statement count for the calls that matter at semester
// scale: ~330 students, ~86 groups, mixed sizes and tutorial slots.
//
// NOTHING IS ASSERTED ABOUT SPEED. The table prints on every run so the
// numbers are always in view; the statement column is what exposes an N+1
// (a per-team query loop shows up as ~86 statements for one call).
describe('performance — semester-scale fixture', () => {
  let h, teacher, unitId, solo1, solo2;
  const SLOTS = ['Mon 9', 'Mon 2', 'Tue 10', 'Wed 2', 'Thu 11', 'Fri 1'];

  before(async () => {
    h = await createHarness();
    teacher = h.createTeacher();
    unitId = h.createUnit(teacher, { validTeamSizes: '4,5' });

    // 86 groups: sizes cycle 4,5,3,2 → ~305 students; every group shares one
    // slot (plus a second slot for variety). Then 20 solos, half declared.
    let n = 0;
    const sizes = [4, 5, 3, 2];
    for (let g = 0; g < 86; g++) {
      const size = sizes[g % sizes.length];
      const slot = SLOTS[g % SLOTS.length];
      const members = [];
      for (let i = 0; i < size; i++) {
        members.push(h.enrolStudent(unitId, {
          username: `p${n++}`, slots: i % 2 ? `${slot},${SLOTS[(g + 1) % SLOTS.length]}` : slot
        }));
      }
      h.groupTogether(unitId, members);
    }
    const solos = [];
    for (let i = 0; i < 20; i++) {
      solos.push(h.enrolStudent(unitId, { username: `solo${i}`, slots: SLOTS[i % SLOTS.length] }));
      if (i % 2) h.studentPortalService.declareNoPreference(unitId, solos[i]);
    }
    [solo1, solo2] = [solos[0], solos[2]];   // both undeclared, same slot? solo0: Mon 9, solo2: Tue 10
  });
  after(() => h.close());

  test('print wall time and statement counts', async () => {
    const rows = [];
    const time = (label, fn) => { const r = h.measure(label, fn); rows.push(r); return r.result; };

    time('getClassList',       () => h.unitService.getClassList(unitId, teacher));
    time('buildExport',        () => h.unitService.buildExport(unitId, teacher));
    time('previewRulesImpact', () => h.unitService.previewRulesImpact(unitId, teacher, { validTeamSizes: '3' }));
    time('getMyTeam',          () => h.studentPortalService.getMyTeam(unitId, 'p0'));

    // The request path, between two solos who share a slot: make solo2 share solo1's slot first.
    h.studentPortalService.savePrefs(unitId, solo2, { tutorialSlots: 'Mon 9', projectInterests: 'x', skills: 'y', preferredRole: 'z' });
    const target = h.teamOf(unitId, solo2).team_id;
    const sent = time('sendRequest', () => h.studentPortalService.sendRequest(unitId, solo1, target));
    const resp = time('respondToRequest (accept → join)', () => h.studentPortalService.respondToRequest(sent.requestId, solo2, 'accept'));
    assert.equal(resp.state, 'approved');

    // Producers and the organiser (needs a passed deadline inside the at-risk window).
    h.unitService.updateRules(unitId, teacher, { deadline: PAST, atRiskDays: 7 });
    h.notificationService.listForTeacher(unitId, teacher);   // seed pass, not measured
    time('syncTeacherForUnit', () => h.notificationService.syncTeacherForUnit(unitId));
    time('suggest',            () => h.matchingService.suggest(unitId, teacher));

    // Email at scale: every student opts in to deadline reminders, the unit
    // deadline sits inside a bucket, and one producer pass + one dispatch pass
    // must send to all of them. The statement count per email is inherent
    // (outbox row, stamp, mark sent) — the thing to watch is that nothing
    // else scales with the class size.
    const at = new Date().toISOString();
    for (const s of h.unitService.getClassList(unitId, teacher))
      h.repos.emailPrefs.set(s.student_id, unitId, 'deadline', true, at);
    // Deadline is already PAST (set above) → the 'due' bucket applies to everyone.
    time('syncForUnit (deadline bucket)', () => h.notificationService.syncForUnit(unitId));
    let sendResult;
    const es = h.measure('dispatchEmails (400 cap)', () => null);   // placeholder for ordering
    const t1 = performance.now(); const b1 = h.statements.n;
    sendResult = await h.notificationService.dispatchEmails(400);
    rows.push({ label: 'dispatchEmails (400 cap)', ms: performance.now() - t1, statements: h.statements.n - b1, result: sendResult });
    void es;
    console.log(`  emails: sent=${sendResult.sent} skipped=${sendResult.skipped} failed=${sendResult.failed}`);

    // The boot re-validation pass, standalone against this fixture.
    const migrator = new SchemaMigrator(h.db.raw);
    const before = h.statements.n;
    const t0 = performance.now();
    const broken = migrator.revalidateGroups();
    rows.push({ label: 'revalidateGroups (boot)', ms: performance.now() - t0,
                statements: `${h.statements.n - before} (raw handle: 2)`, result: broken });

    const students = h.unitService.getClassList(unitId, teacher).length;
    const teams = h.repos.teams.listAllWithCounts(unitId).length;
    console.log(`\nperformance — ${students} students, ${teams} teams (86 groups + solos)`);
    console.log('  ' + 'call'.padEnd(36) + 'ms'.padStart(9) + '   statements');
    for (const r of rows)
      console.log('  ' + r.label.padEnd(36) + r.ms.toFixed(1).padStart(9) + '   ' + r.statements);
    console.log('');
    assert.ok(rows.length === 11);
  });
});

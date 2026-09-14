const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const Database = require('../db/Database');
const SchemaMigrator = require('../db/SchemaMigrator');

// Builds an approval-era database by hand — FORMING / SUBMITTED / APPROVED
// rows and a 5-member SUBMITTED team in a max-4 unit — then boots it through
// the real migrator.
async function legacyDbFile() {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  // Let the migrator create today's schema, then write legacy values into it.
  new SchemaMigrator(raw).migrate();
  raw.run(`INSERT INTO users (username, password_hash, email, role) VALUES ('t','x','t@x','TEACHER')`);
  raw.run(`INSERT INTO units (unit_id, unit_name, created_by, valid_team_sizes, must_share_tutorial, max_new_to_qut)
           VALUES ('u1','Legacy','t','4',1,2)`);
  const students = ['a','b','c','d','e','f','g','h'];
  for (const s of students) {
    raw.run(`INSERT INTO users (username, password_hash, email, role) VALUES (?,?,?,?)`, [s,'x',`${s}@x`,'STUDENT']);
    raw.run(`INSERT INTO unit_students (unit_id, student_id, name, tutorial_time) VALUES ('u1',?,?, 'Tue 10')`, [s, s]);
  }
  const team = (id, status, number, members) => {
    raw.run(`INSERT INTO unit_teams (team_id, unit_id, team_name, team_number, created_by, status, submitted_at)
             VALUES (?,?,?,?,?,?,?)`, [id, 'u1', `Team ${number}`, number, members[0], status, status === 'FORMING' ? '' : '2026-08-01T00:00:00.000Z']);
    for (const m of members)
      raw.run(`INSERT INTO unit_team_members (team_id, student_id, role, status) VALUES (?,?,'','ACCEPTED')`, [id, m]);
  };
  team('t1', 'SUBMITTED', 1, ['a','b','c','d','e']);   // 5 in a max-4 unit
  team('t2', 'FORMING',   2, ['f']);
  team('t3', 'APPROVED',  3, ['g','h']);
  const file = path.join(os.tmpdir(), `teamup-legacy-${crypto.randomUUID()}.db`);
  fs.writeFileSync(file, Buffer.from(raw.export()));
  return file;
}

describe('migration — approval era → OPEN / FINALISED', () => {
  test('statuses are mapped, violators are reported not promoted, and a second boot is a no-op', async () => {
    const file = await legacyDbFile();
    const warnings = [];
    const origWarn = console.warn, origLog = console.log;
    console.warn = (...a) => warnings.push(a.join(' '));
    console.log = () => {};
    try {
      const db = await new Database(file).connect();
      const status = id => db.get(`SELECT status, finalised_at FROM unit_teams WHERE team_id = ?`, [id]);
      assert.equal(status('t1').status, 'OPEN');
      assert.equal(status('t2').status, 'OPEN');
      assert.equal(status('t3').status, 'FINALISED');
      assert.ok(status('t3').finalised_at, 'APPROVED teams get a finalised_at stamp');
      assert.equal(db.get(`SELECT COUNT(*) AS n FROM unit_teams WHERE status NOT IN ('OPEN','FINALISED')`).n, 0);

      // The 5-member team is reported as breaking the max size and left OPEN.
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Team 1 \(Legacy\) breaks a hard rule/);
      assert.match(warnings[0], /Largest allowed team size is 4/);
      assert.equal(db.get(`SELECT COUNT(*) AS n FROM unit_team_members WHERE team_id = 't1'`).n, 5);

      // Second boot: nothing to map, same warning (it is a report, not a change).
      warnings.length = 0;
      const again = await new Database(file).connect();
      assert.equal(again.get(`SELECT status FROM unit_teams WHERE team_id = 't1'`).status, 'OPEN');
      assert.equal(again.get(`SELECT status FROM unit_teams WHERE team_id = 't3'`).status, 'FINALISED');
      assert.equal(new SchemaMigrator(again.raw).migrateTeamStatuses(), 0);
      assert.equal(new SchemaMigrator(again.raw).revalidateGroups().length, 1);
    } finally {
      console.warn = origWarn; console.log = origLog;
      try { fs.unlinkSync(file); } catch { /* gone */ }
    }
  });
});

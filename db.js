const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'teamup.db');
let db = null;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('Loaded existing teamup.db');
  } else {
    db = new SQL.Database();
    console.log('Created new teamup.db');
  }

  db.run('PRAGMA foreign_keys = ON');

  db.run(`CREATE TABLE IF NOT EXISTS users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    email         TEXT NOT NULL,
    role          TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS teams (
    team_id TEXT PRIMARY KEY,
    status  TEXT NOT NULL DEFAULT 'FORMING'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS students (
    username              TEXT PRIMARY KEY,
    display_name          TEXT,
    tutorial_availability TEXT,
    major                 TEXT,
    units_passed          INTEGER DEFAULT 0,
    team_id               TEXT,
    FOREIGN KEY (username) REFERENCES users(username),
    FOREIGN KEY (team_id)  REFERENCES teams(team_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS team_invites (
    invite_id          TEXT PRIMARY KEY,
    sender_username    TEXT NOT NULL,
    receiver_username  TEXT NOT NULL,
    sent_at            TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'PENDING',
    rejection_reason   TEXT,
    FOREIGN KEY (sender_username)   REFERENCES users(username),
    FOREIGN KEY (receiver_username) REFERENCES users(username)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS units (
  unit_id               TEXT PRIMARY KEY,
  unit_name             TEXT NOT NULL,
  description           TEXT DEFAULT '',
  semester              TEXT DEFAULT '',
  created_by            TEXT NOT NULL,
  valid_team_sizes      TEXT DEFAULT '4',
  max_one_group         INTEGER DEFAULT 1,
  must_share_tutorial   INTEGER DEFAULT 1,
  max_new_to_qut        INTEGER DEFAULT 2,
  student_count         INTEGER DEFAULT 0,
  teams_generated       INTEGER DEFAULT 0,
  students_in_teams     INTEGER DEFAULT 0,
  FOREIGN KEY (created_by) REFERENCES users(username)
)`);

  // ── ADDITION 1: add deadline column to existing units table (safe if already exists)
  try { db.run(`ALTER TABLE units ADD COLUMN deadline TEXT DEFAULT ''`); } catch(e) {}

// ── ADDITION 2: students imported from CSV per unit
  db.run(`CREATE TABLE IF NOT EXISTS unit_students (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id          TEXT NOT NULL,
  student_id       TEXT NOT NULL,
  name             TEXT DEFAULT '',
  tutorial_time    TEXT DEFAULT '',
  is_new_to_qut    INTEGER DEFAULT 0,
  degree           TEXT DEFAULT '',
  major            TEXT DEFAULT '',
  minor            TEXT DEFAULT '',
  units_passed     INTEGER DEFAULT 0,
  it_skill_groups  TEXT DEFAULT '',
  UNIQUE(unit_id, student_id),
  FOREIGN KEY (unit_id) REFERENCES units(unit_id)
)`);

// ── ADDITION 3: 4-stage progress tracking per student per unit
  db.run(`CREATE TABLE IF NOT EXISTS student_progress (
  unit_id              TEXT NOT NULL,
  student_id           TEXT NOT NULL,
  read_rules           INTEGER DEFAULT 0,
  entered_preferences  INTEGER DEFAULT 0,
  in_team              INTEGER DEFAULT 0,
  submitted_request    INTEGER DEFAULT 0,
  PRIMARY KEY (unit_id, student_id)
)`);

  // ── STUDENT PORTAL: per-unit preferences ──────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS student_unit_prefs (
    unit_id             TEXT NOT NULL,
    student_id          TEXT NOT NULL,
    tutorial_slots      TEXT DEFAULT '',
    project_interests   TEXT DEFAULT '',
    skills              TEXT DEFAULT '',
    preferred_role      TEXT DEFAULT '',
    preferred_teammates TEXT DEFAULT 'None',
    saved_at            TEXT DEFAULT '',
    PRIMARY KEY (unit_id, student_id),
    FOREIGN KEY (unit_id) REFERENCES units(unit_id)
  )`);

  // ── STUDENT PORTAL: unit-scoped teams ─────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS unit_teams (
    team_id      TEXT PRIMARY KEY,
    unit_id      TEXT NOT NULL,
    team_name    TEXT DEFAULT '',
    created_by   TEXT NOT NULL,
    status       TEXT DEFAULT 'FORMING',
    submitted_at TEXT DEFAULT '',
    quality_score INTEGER DEFAULT 0,
    FOREIGN KEY (unit_id) REFERENCES units(unit_id)
  )`);

  // ── STUDENT PORTAL: team membership ───────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS unit_team_members (
    team_id    TEXT NOT NULL,
    student_id TEXT NOT NULL,
    role       TEXT DEFAULT '',
    status     TEXT DEFAULT 'ACCEPTED',
    PRIMARY KEY (team_id, student_id),
    FOREIGN KEY (team_id) REFERENCES unit_teams(team_id)
  )`);

  // ── STUDENT PORTAL: team invites ──────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS unit_team_invites (
    invite_id    TEXT PRIMARY KEY,
    unit_id      TEXT NOT NULL,
    team_id      TEXT NOT NULL,
    from_student TEXT NOT NULL,
    to_student   TEXT NOT NULL,
    status       TEXT DEFAULT 'PENDING',
    sent_at      TEXT DEFAULT '',
    FOREIGN KEY (unit_id) REFERENCES units(unit_id),
    FOREIGN KEY (team_id) REFERENCES unit_teams(team_id)
  )`);

  // ── Add teacher_approved stage to existing student_progress ───
  try { db.run(`ALTER TABLE student_progress ADD COLUMN teacher_approved INTEGER DEFAULT 0`); } catch(e) {}

  // ── Announcements per unit ─────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS unit_announcements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id    TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (unit_id) REFERENCES units(unit_id)
  )`);

  save();
  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Returns array of row objects
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Returns first row or null
function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}

// Runs INSERT/UPDATE/DELETE and saves to disk
function run(sql, params = []) {
  db.run(sql, params);
  save();
}

function getDb() { return db; }

module.exports = { initDb, all, get, run, save, getDb };

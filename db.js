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

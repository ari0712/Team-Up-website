// Builds the real service graph against a throwaway database.
//
// The project's teamup.db is a live file that the running server rewrites in
// full on every write — tests must never open it. Every harness gets its own
// file under the OS temp dir, runs the real SchemaMigrator on it, and deletes
// it afterwards.
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Database = require('../../db/Database');
const { createServices } = require('../../services/container');

// A transport that records instead of sending.
function recordingTransport() {
  const sent = [];
  return { name: 'test', sent, async send(msg) { sent.push(msg); return {}; } };
}

// Counts every SQL statement the services run, so a test can see an N+1
// rather than guess at one. `db.tx` runs on the raw handle and is counted
// once per statement inside it as well.
function countStatements(db) {
  const counter = { n: 0 };
  for (const m of ['all', 'get', 'run']) {
    const orig = db[m];
    db[m] = (...args) => { counter.n++; return orig(...args); };
  }
  const origTx = db.tx;
  db.tx = fn => origTx(raw => fn({
    run: (...a) => { counter.n++; return raw.run(...a); },
    prepare: (...a) => { counter.n++; return raw.prepare(...a); }
  }));
  return counter;
}

async function createHarness() {
  const filePath = path.join(os.tmpdir(), `teamup-test-${crypto.randomUUID()}.db`);
  const db = await new Database(filePath).connect();
  const statements = countStatements(db);
  const transport = recordingTransport();
  const services = createServices({ db, transport, env: {} });
  const { repos, authService, unitService, studentPortalService } = services;

  let seq = 0;
  const next = prefix => `${prefix}${++seq}`;

  const h = {
    db, filePath, transport, statements, ...services,

    createTeacher(username = next('teacher')) {
      authService.signUp(username, 'pw', `${username}@example.edu`, 'TEACHER');
      return username;
    },

    createUnit(teacherId, {
      unitName = next('Unit '), validTeamSizes = '4', maxNewToQut, deadline = '', atRiskDays
    } = {}) {
      // maxNewToQut left undefined = the cap is off, as it is for a new unit.
      const { unitId } = unitService.createUnit(teacherId, {
        unitName, validTeamSizes, maxNewToQut, deadline, students: []
      });
      if (atRiskDays !== undefined) unitService.updateRules(unitId, teacherId, { atRiskDays });
      return unitId;
    },

    // Signs up, rosters, joins and (optionally) saves preferences. `slots` is
    // both the roster tutorial_time and the saved tutorial_slots, so the
    // student has availability whichever fallback a reader uses.
    enrolStudent(unitId, {
      username = next('s'), name = username, studentNumber = '', slots = 'Tue 10',
      newToQut = 0, prefs = true, role = 'Developer', interests = 'Web', skills = 'JS'
    } = {}) {
      const email = `${username}@example.edu`;
      if (!repos.userRepo.existsByUsername(username)) {
        authService.signUp(username, 'pw', email, 'STUDENT');
        if (studentNumber) repos.userRepo.setStudentId(username, studentNumber);
      }
      const unit = repos.unitRepo.findById(unitId);
      unitService.importRoster(unitId, unit.created_by, [
        { email, name, tutorial_time: slots, is_new_to_qut: newToQut ? 1 : 0 }
      ]);
      studentPortalService.joinUnit(unitId, username);
      if (prefs) {
        studentPortalService.savePrefs(unitId, username, {
          tutorialSlots: slots, projectInterests: interests, skills, preferredRole: role
        });
      }
      return username;
    },

    // The real path: `from` asks `to`'s team to team up, and everyone on the
    // other side accepts. Returns the final request state.
    teamUp(unitId, from, to) {
      const target = repos.teams.findStudentTeam(unitId, to).team_id;
      const { requestId, state } = studentPortalService.sendRequest(unitId, from, target);
      if (state !== 'open') return state;
      let last = state;
      for (const m of repos.teams.getMembers(target)) {
        const r = studentPortalService.respondToRequest(requestId, m.student_id, 'accept');
        last = r.state;
        if (r.resolved) break;
      }
      return last;
    },

    // Puts the named students on one team (the first student's), bypassing the
    // request flow. For fixtures where the path itself is not under test.
    groupTogether(unitId, usernames) {
      const [first, ...rest] = usernames;
      const teamId = repos.teams.findStudentTeam(unitId, first).team_id;
      for (const sid of rest) {
        const theirs = repos.teams.findStudentTeam(unitId, sid);
        if (theirs && theirs.team_id !== teamId) {
          repos.teams.removeMember(theirs.team_id, sid);
          repos.teams.deleteIfEmpty(theirs.team_id);
        }
        if (!repos.teams.getMembership(teamId, sid))
          repos.teams.addMember(teamId, sid, repos.prefs.getPreferredRole(unitId, sid));
      }
      return teamId;
    },

    teamOf(unitId, username) {
      const m = repos.teams.findStudentTeam(unitId, username);
      return m ? repos.teams.findById(m.team_id) : null;
    },

    membersOf(unitId, username) {
      const t = h.teamOf(unitId, username);
      return t ? repos.teams.getMembers(t.team_id).map(m => m.student_id).sort() : [];
    },

    progressOf(unitId, username) {
      return repos.progress.get(unitId, username);
    },

    lock(unitId, teacherId) {
      unitService.updateRules(unitId, teacherId, { deadline: PAST });
    },

    // Wall time and statement count for one call.
    measure(label, fn) {
      const before = statements.n;
      const t0 = performance.now();
      const result = fn();
      const ms = performance.now() - t0;
      return { label, ms, statements: statements.n - before, result };
    },

    close() {
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    }
  };
  return h;
}

// Expects `fn` to throw a ServiceError with the given status (and code, when
// given). Returns the error so the test can inspect the message.
function expectServiceError(fn, status, code) {
  const assert = require('node:assert/strict');
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, `expected a ServiceError(${status}${code ? ', ' + code : ''}) but nothing was thrown`);
  assert.equal(caught.status, status, `expected status ${status}, got ${caught.status}: ${caught.message}`);
  if (code) assert.equal(caught.code, code, `expected code ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

const PAST   = '2020-01-01T00:00:00.000Z';
const inDays = n => new Date(Date.now() + n * 86400000).toISOString();

module.exports = { createHarness, expectServiceError, PAST, inDays };

const crypto = require('crypto');

// Owns all schema creation and one-shot data migrations. Operates directly on
// the raw sql.js handle so the DDL and the legacy migrations behave exactly as
// they did before — Database flushes once after migrate() returns.
class SchemaMigrator {
  constructor(rawDb) {
    this.db = rawDb;
  }

  migrate() {
    const db = this.db;

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
    try { db.run(`ALTER TABLE units ADD COLUMN deadline TEXT DEFAULT ''`); } catch (e) {}

    try { db.run(`ALTER TABLE users ADD COLUMN student_id TEXT DEFAULT ''`); } catch (e) {}

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

    // ── PROPOSAL SYSTEM: merge proposals between teams ────────────
    db.run(`CREATE TABLE IF NOT EXISTS proposals (
      proposal_id     TEXT PRIMARY KEY,
      unit_id         TEXT NOT NULL,
      source_team_id  TEXT NOT NULL,
      target_team_id  TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'open',
      created_at      TEXT NOT NULL,
      expires_at      TEXT NOT NULL,
      resolved_at     TEXT,
      initiator_id    TEXT NOT NULL,
      FOREIGN KEY (unit_id)        REFERENCES units(unit_id),
      FOREIGN KEY (source_team_id) REFERENCES unit_teams(team_id),
      FOREIGN KEY (target_team_id) REFERENCES unit_teams(team_id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_proposals_unit_state ON proposals(unit_id, state)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_proposals_expires ON proposals(state, expires_at)`);

    // ── PROPOSAL SYSTEM: snapshotted approver votes ───────────────
    db.run(`CREATE TABLE IF NOT EXISTS proposal_votes (
      proposal_id TEXT NOT NULL,
      student_id  TEXT NOT NULL,
      vote        TEXT NOT NULL DEFAULT 'pending',
      voted_at    TEXT,
      seen_at     TEXT,
      PRIMARY KEY (proposal_id, student_id),
      FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_votes_student ON proposal_votes(student_id)`);

    // ── Stable per-unit team number (drives 'Team N' naming) ─────
    try { db.run(`ALTER TABLE unit_teams ADD COLUMN team_number INTEGER DEFAULT 0`); } catch (e) {}

    // Timestamp of the most recent teacher rejection. Drives the "your last
    // submission was rejected" notice on the my-team page after the team is
    // bounced back to FORMING.
    try { db.run(`ALTER TABLE unit_teams ADD COLUMN last_rejected_at TEXT DEFAULT ''`); } catch (e) {}

    // ── Teacher-managed tutorial slots per unit ─────────────────────
    db.run(`CREATE TABLE IF NOT EXISTS unit_tutorial_slots (
      slot_id    TEXT PRIMARY KEY,
      unit_id    TEXT NOT NULL,
      label      TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      UNIQUE(unit_id, label),
      FOREIGN KEY (unit_id) REFERENCES units(unit_id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tutorial_slots_unit
              ON unit_tutorial_slots(unit_id, sort_order)`);

    // Seed from existing CSV data (one-shot, guarded inside).
    this.migrateTutorialSlots();

    // ── PROPOSAL SYSTEM: one-shot migration from legacy invites ───
    this.migrateToProposalModel();

    // ── Backfill 'Team N' names for any team with team_number=0 ───
    this.backfillTeamNumbers();

    // ── Add teacher_approved stage to existing student_progress ───
    try { db.run(`ALTER TABLE student_progress ADD COLUMN teacher_approved INTEGER DEFAULT 0`); } catch (e) {}

    // ── Announcements per unit ─────────────────────────────────────
    db.run(`CREATE TABLE IF NOT EXISTS unit_announcements (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id    TEXT NOT NULL,
      title      TEXT NOT NULL DEFAULT '',
      content    TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (unit_id) REFERENCES units(unit_id)
    )`);
  }

  // One-shot migration: existing PENDING unit_team_invites → proposals,
  // and backfill team-of-1 rows for any enrolled student without a team.
  // Idempotent: short-circuits when any proposals row already exists.
  migrateToProposalModel() {
    const db = this.db;
    const guard = db.prepare(`SELECT COUNT(*) AS n FROM proposals`);
    guard.step();
    const { n } = guard.getAsObject();
    guard.free();
    if (n > 0) return;

    db.run('BEGIN TRANSACTION');
    try {
      // ── Step A: team-of-1 backfill ───────────────────────────────
      const orphansStmt = db.prepare(`
        SELECT us.unit_id, us.student_id, us.name
        FROM unit_students us
        WHERE NOT EXISTS (
          SELECT 1 FROM unit_team_members tm
          INNER JOIN unit_teams t ON t.team_id = tm.team_id
          WHERE t.unit_id = us.unit_id AND tm.student_id = us.student_id
        )
      `);
      const orphans = [];
      while (orphansStmt.step()) orphans.push(orphansStmt.getAsObject());
      orphansStmt.free();

      let stepA = 0;
      for (const o of orphans) {
        const teamId = crypto.randomUUID();
        const baseName = (o.name && String(o.name).trim()) || o.student_id;
        const teamName = `${baseName}'s team`;

        const prefStmt = db.prepare(
          `SELECT preferred_role FROM student_unit_prefs WHERE unit_id=? AND student_id=?`
        );
        prefStmt.bind([o.unit_id, o.student_id]);
        let role = '';
        if (prefStmt.step()) role = prefStmt.getAsObject().preferred_role || '';
        prefStmt.free();

        db.run(
          `INSERT INTO unit_teams (team_id, unit_id, team_name, created_by, status) VALUES (?,?,?,?, 'FORMING')`,
          [teamId, o.unit_id, teamName, o.student_id]
        );
        db.run(
          `INSERT INTO unit_team_members (team_id, student_id, role, status) VALUES (?,?,?, 'ACCEPTED')`,
          [teamId, o.student_id, role]
        );
        db.run(
          `INSERT OR IGNORE INTO student_progress (unit_id, student_id) VALUES (?,?)`,
          [o.unit_id, o.student_id]
        );
        db.run(
          `UPDATE student_progress SET in_team = 1 WHERE unit_id=? AND student_id=?`,
          [o.unit_id, o.student_id]
        );
        stepA++;
      }

      // ── Step B: PENDING unit_team_invites → proposals ───────────
      const pendStmt = db.prepare(`SELECT * FROM unit_team_invites WHERE status='PENDING'`);
      const pending = [];
      while (pendStmt.step()) pending.push(pendStmt.getAsObject());
      pendStmt.free();

      let stepB = 0;
      let skipped = 0;
      for (const inv of pending) {
        // Drop the WAITING placeholder in the inviter's team
        db.run(
          `DELETE FROM unit_team_members WHERE team_id=? AND student_id=? AND status='WAITING'`,
          [inv.team_id, inv.to_student]
        );

        // Source team must exist
        const srcStmt = db.prepare(`SELECT 1 AS ok FROM unit_teams WHERE team_id=?`);
        srcStmt.bind([inv.team_id]);
        const srcOk = srcStmt.step();
        srcStmt.free();
        if (!srcOk) {
          console.warn(`Proposal migration: skipping invite ${inv.invite_id} — source team ${inv.team_id} missing`);
          skipped++;
          continue;
        }

        // Locate (or create) the invitee's team-of-1
        let targetTeamId = null;
        const inviteeTeamStmt = db.prepare(`
          SELECT tm.team_id FROM unit_team_members tm
          INNER JOIN unit_teams t ON t.team_id = tm.team_id
          WHERE t.unit_id = ? AND tm.student_id = ?
        `);
        inviteeTeamStmt.bind([inv.unit_id, inv.to_student]);
        if (inviteeTeamStmt.step()) targetTeamId = inviteeTeamStmt.getAsObject().team_id;
        inviteeTeamStmt.free();

        if (!targetTeamId) {
          const usStmt = db.prepare(`SELECT name FROM unit_students WHERE unit_id=? AND student_id=?`);
          usStmt.bind([inv.unit_id, inv.to_student]);
          let inviteeName = '';
          if (usStmt.step()) inviteeName = String(usStmt.getAsObject().name || '').trim();
          usStmt.free();

          targetTeamId = crypto.randomUUID();
          const teamName = `${inviteeName || inv.to_student}'s team`;
          db.run(
            `INSERT INTO unit_teams (team_id, unit_id, team_name, created_by, status) VALUES (?,?,?,?, 'FORMING')`,
            [targetTeamId, inv.unit_id, teamName, inv.to_student]
          );
          db.run(
            `INSERT INTO unit_team_members (team_id, student_id, role, status) VALUES (?,?,'', 'ACCEPTED')`,
            [targetTeamId, inv.to_student]
          );
          db.run(
            `INSERT OR IGNORE INTO student_progress (unit_id, student_id) VALUES (?,?)`,
            [inv.unit_id, inv.to_student]
          );
          db.run(
            `UPDATE student_progress SET in_team = 1 WHERE unit_id=? AND student_id=?`,
            [inv.unit_id, inv.to_student]
          );
        }

        if (targetTeamId === inv.team_id) {
          console.warn(`Proposal migration: skipping invite ${inv.invite_id} — target equals source`);
          skipped++;
          continue;
        }

        // sent_at may be empty for hand-edited rows; fall back to now
        const sentAt = inv.sent_at && Date.parse(inv.sent_at)
          ? inv.sent_at
          : new Date().toISOString();
        const expiresAt = new Date(Date.parse(sentAt) + 48 * 3600 * 1000).toISOString();

        const proposalId = crypto.randomUUID();
        db.run(
          `INSERT INTO proposals (proposal_id, unit_id, source_team_id, target_team_id,
                                  state, created_at, expires_at, initiator_id)
           VALUES (?,?,?,?,'open',?,?,?)`,
          [proposalId, inv.unit_id, inv.team_id, targetTeamId, sentAt, expiresAt, inv.from_student]
        );

        // Snapshot approver set from current ACCEPTED membership of both teams
        const memStmt = db.prepare(`
          SELECT DISTINCT student_id FROM unit_team_members
          WHERE team_id IN (?, ?) AND status='ACCEPTED'
        `);
        memStmt.bind([inv.team_id, targetTeamId]);
        const members = [];
        while (memStmt.step()) members.push(memStmt.getAsObject().student_id);
        memStmt.free();

        for (const sid of members) {
          const isInitiator = sid === inv.from_student;
          db.run(
            `INSERT INTO proposal_votes (proposal_id, student_id, vote, voted_at) VALUES (?,?,?,?)`,
            [proposalId, sid, isInitiator ? 'yes' : 'pending', isInitiator ? sentAt : null]
          );
        }

        db.run(`UPDATE unit_team_invites SET status='MIGRATED' WHERE invite_id=?`, [inv.invite_id]);
        stepB++;
      }

      db.run('COMMIT');
      if (stepA || stepB || skipped) {
        console.log(`Proposal migration: ${stepA} team-of-1 backfills, ${stepB} proposals created, ${skipped} invites skipped`);
      }
    } catch (e) {
      db.run('ROLLBACK');
      throw e;
    }
  }

  // One-shot seed: collect distinct tutorial-slot labels from existing student
  // data (unit_students.tutorial_time + student_unit_prefs.tutorial_slots) and
  // insert them into unit_tutorial_slots. Skips entirely once any slot row
  // exists — teachers manage from there.
  migrateTutorialSlots() {
    const db = this.db;
    const guard = db.prepare(`SELECT COUNT(*) AS n FROM unit_tutorial_slots`);
    guard.step();
    const { n } = guard.getAsObject();
    guard.free();
    if (n > 0) return;

    const unitsStmt = db.prepare(`SELECT unit_id FROM units`);
    const units = [];
    while (unitsStmt.step()) units.push(unitsStmt.getAsObject().unit_id);
    unitsStmt.free();

    let total = 0;
    for (const unitId of units) {
      const slotSet = new Set();

      const usStmt = db.prepare(
        `SELECT tutorial_time FROM unit_students WHERE unit_id = ?`
      );
      usStmt.bind([unitId]);
      while (usStmt.step()) {
        const v = usStmt.getAsObject().tutorial_time || '';
        v.split(',').map(s => s.trim()).filter(Boolean).forEach(s => slotSet.add(s));
      }
      usStmt.free();

      const supStmt = db.prepare(
        `SELECT tutorial_slots FROM student_unit_prefs WHERE unit_id = ?`
      );
      supStmt.bind([unitId]);
      while (supStmt.step()) {
        const v = supStmt.getAsObject().tutorial_slots || '';
        v.split(',').map(s => s.trim()).filter(Boolean).forEach(s => slotSet.add(s));
      }
      supStmt.free();

      if (slotSet.size === 0) continue;

      let i = 0;
      for (const label of [...slotSet].sort()) {
        db.run(
          `INSERT INTO unit_tutorial_slots (slot_id, unit_id, label, sort_order)
           VALUES (?,?,?,?)`,
          [crypto.randomUUID(), unitId, label, i++]
        );
        total++;
      }
    }
    if (total) console.log(`Tutorial-slot seed: imported ${total} slot rows`);
  }

  // Compacts team_number per unit so names are always contiguous Team 1..N.
  // Order is determined by rowid ASC (creation order). Runs at every startup
  // and only writes the rows whose number/name actually need to change, so it's
  // a no-op when everything is already in order.
  backfillTeamNumbers() {
    const db = this.db;
    const unitsStmt = db.prepare(`SELECT DISTINCT unit_id FROM unit_teams`);
    const units = [];
    while (unitsStmt.step()) units.push(unitsStmt.getAsObject().unit_id);
    unitsStmt.free();

    let renamed = 0;
    for (const unitId of units) {
      const teamsStmt = db.prepare(
        `SELECT team_id, team_number, team_name FROM unit_teams
          WHERE unit_id = ? ORDER BY rowid ASC`
      );
      teamsStmt.bind([unitId]);
      const teams = [];
      while (teamsStmt.step()) teams.push(teamsStmt.getAsObject());
      teamsStmt.free();

      teams.forEach((t, i) => {
        const expected = i + 1;
        const expectedName = `Team ${expected}`;
        if (t.team_number !== expected || t.team_name !== expectedName) {
          db.run(
            `UPDATE unit_teams SET team_number = ?, team_name = ? WHERE team_id = ?`,
            [expected, expectedName, t.team_id]
          );
          renamed++;
        }
      });
    }
    if (renamed) console.log(`Team-name compaction: renumbered ${renamed} teams`);
  }
}

module.exports = SchemaMigrator;

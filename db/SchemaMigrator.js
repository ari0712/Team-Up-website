const crypto = require('crypto');
const { ABOUT_COLUMNS } = require('../utils/aboutFields');

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

    // Profile picture, added when student profiles shipped. Holds a PATH under
    // public/uploads/avatars, never the image itself: Database.save() rewrites
    // the whole file on every write, so image bytes in here would slow down
    // every unrelated write in the app. '' means "no picture set".
    try { db.run(`ALTER TABLE students ADD COLUMN avatar_path TEXT DEFAULT ''`); } catch (e) {}

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

    // How many days before the deadline the teacher wants at-risk students
    // reported. 0 means never. Allowed values are enforced in UnitService, not
    // here, so the rule lives with the rest of the unit validation.
    //
    // DEFAULT 3 is deliberate: it is what the gate was hardcoded to before this
    // was configurable, so existing units keep behaving exactly as they did.
    try { db.run(`ALTER TABLE units ADD COLUMN at_risk_days INTEGER NOT NULL DEFAULT 3`); } catch (e) {}

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

    // ── Unit roster: WHO IS ALLOWED to join a unit ─────────────────
    // Deliberately separate from unit_students, which means "actually enrolled"
    // and is INNER JOINed by teams, classmates, notifications and more. Keeping
    // the allowlist in its own table means none of those readers can
    // accidentally pick up someone who was merely invited.
    //
    // Matching is by email, lowercased on write and on lookup. A unit with no
    // roster rows matches nobody, so it is closed until a teacher adds a list.
    db.run(`CREATE TABLE IF NOT EXISTS unit_roster (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id          TEXT NOT NULL,
      email            TEXT NOT NULL,
      name             TEXT DEFAULT '',
      student_number   TEXT DEFAULT '',
      tutorial_time    TEXT DEFAULT '',
      is_new_to_qut    INTEGER DEFAULT 0,
      degree           TEXT DEFAULT '',
      major            TEXT DEFAULT '',
      minor            TEXT DEFAULT '',
      units_passed     INTEGER DEFAULT 0,
      it_skill_groups  TEXT DEFAULT '',
      invited_at       TEXT DEFAULT '',
      UNIQUE(unit_id, email),
      FOREIGN KEY (unit_id) REFERENCES units(unit_id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_unit_roster_email ON unit_roster(email)`);
    this.backfillRosterFromEnrolments();

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

    // Free-text "About Me" answers, added when student profiles shipped. Kept
    // per-unit alongside the other preferences because four of the seven prompts
    // ask about THIS capstone. All optional — '' means "not filled in yet", and
    // an empty answer is a normal state rather than an unfinished one.
    for (const col of ABOUT_COLUMNS) {
      try { db.run(`ALTER TABLE student_unit_prefs ADD COLUMN ${col} TEXT DEFAULT ''`); } catch (e) {}
    }

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
    // Who actually merged, recorded when a proposal is auto-cancelled. Both
    // sides of a cancelled proposal see it, so the row can only be phrased
    // correctly if it knows which side went away — and that is unrecoverable
    // afterwards, because the losing team row is deleted by then.
    try { db.run(`ALTER TABLE proposals ADD COLUMN cancelled_by_student_ids TEXT`); } catch (e) {}
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

    // ── Forum: the unit's shared discussion board ──────────────────
    // The first feature students write into and other people read. Both roles
    // post here, so `author_username` is a users.username — the same convention
    // notifications.student_id uses — with author_role as the discriminator.
    //
    // The author's display name and picture are deliberately NOT stored: they
    // are joined from `students` at read time, so editing your profile does not
    // leave a stale name on every post you ever made. A teacher has no students
    // row at all, which is why those joins must be LEFT joins.
    db.run(`CREATE TABLE IF NOT EXISTS forum_threads (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id         TEXT    NOT NULL,
      author_username TEXT    NOT NULL,
      author_role     TEXT    NOT NULL DEFAULT 'STUDENT',
      title           TEXT    NOT NULL DEFAULT '',
      body            TEXT    NOT NULL DEFAULT '',
      pinned          INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT    NOT NULL DEFAULT '',
      FOREIGN KEY (unit_id) REFERENCES units(unit_id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_forum_threads_unit
              ON forum_threads(unit_id, pinned, id)`);

    // What kind of post this is: 'DISCUSSION' | 'RECRUITING'.
    //
    // One column, not a second table — a recruiting post IS a thread: same board,
    // same replies, same moderation, same pinning. Only the card around it differs.
    //
    // And deliberately no team_id. ProposalService.executeMerge DELETEs the losing
    // unit_teams row on every approved merge, so a team id stored here would be a
    // dangling pointer within a day. The author's team is derived from
    // author_username at read time, the same way author_name is, which stays
    // correct across every merge, leave and kick without anyone editing the post.
    //
    // No index: the board is already fetched whole, so the tab filter is a
    // client-side array filter, not a query.
    try { db.run(`ALTER TABLE forum_threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'DISCUSSION'`); } catch (e) {}

    // unit_id is repeated here rather than reached through thread_id: it makes
    // both the per-unit scope check and the unit-delete cascade single-table
    // operations, with no join to get wrong.
    //
    // There is no reply_count or last_activity_at on forum_threads for the same
    // reason — the list query derives both with a subquery, which cannot drift
    // the way two denormalised counters maintained across three mutation paths
    // eventually would.
    db.run(`CREATE TABLE IF NOT EXISTS forum_replies (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id       INTEGER NOT NULL,
      unit_id         TEXT    NOT NULL,
      author_username TEXT    NOT NULL,
      author_role     TEXT    NOT NULL DEFAULT 'STUDENT',
      body            TEXT    NOT NULL DEFAULT '',
      created_at      TEXT    NOT NULL DEFAULT '',
      FOREIGN KEY (thread_id) REFERENCES forum_threads(id),
      FOREIGN KEY (unit_id)   REFERENCES units(unit_id)
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_forum_replies_thread
              ON forum_replies(thread_id, id)`);

    // ── Notifications ──────────────────────────────────────────────
    // Rows are produced by NotificationService.syncForUnit (students) and
    // syncTeacherForUnit (teachers), which derive them from current state and
    // insert with INSERT OR IGNORE. The UNIQUE index on (student_id, dedupe_key)
    // is what makes those producers idempotent, so they can run on every read
    // and on a timer without ever duplicating a notification.
    //
    // `student_id` is a users.username, not a students-table key — which is why
    // a teacher's inbox lives in this same table rather than a parallel one.
    // recipient_role tells the two apart.
    db.run(`CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id     TEXT NOT NULL,
      student_id  TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT '',
      title       TEXT NOT NULL DEFAULT '',
      body        TEXT NOT NULL DEFAULT '',
      link        TEXT NOT NULL DEFAULT '',
      dedupe_key  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT '',
      read_at     TEXT,
      emailed_at  TEXT,
      FOREIGN KEY (unit_id) REFERENCES units(unit_id)
    )`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
              ON notifications(student_id, dedupe_key)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_inbox
              ON notifications(unit_id, student_id, read_at)`);

    // Added when the teacher inbox shipped — safe if the columns already exist.
    // Both carry a DEFAULT, so existing rows backfill to exactly what they
    // already were: a student notification of ordinary importance.
    try { db.run(`ALTER TABLE notifications ADD COLUMN recipient_role TEXT NOT NULL DEFAULT 'STUDENT'`); } catch (e) {}
    try { db.run(`ALTER TABLE notifications ADD COLUMN severity       TEXT NOT NULL DEFAULT 'INFO'`); } catch (e) {}

    // ── Per-user email preferences ─────────────────────────────────
    // Keyed by users.username, so it covers students and teachers alike.
    // A missing row means "defaults" — NotificationPrefsRepository.get
    // synthesises them rather than requiring a row to exist up front.
    //
    // These are the RECIPIENT's preferences and are applied before the
    // env-level guard in dispatchEmails, never instead of it: email_override
    // cannot be used to reach an address MAIL_ALLOWLIST forbids.
    db.run(`CREATE TABLE IF NOT EXISTS notification_prefs (
      username       TEXT PRIMARY KEY,
      email_enabled  INTEGER NOT NULL DEFAULT 1,
      email_override TEXT    NOT NULL DEFAULT '',
      min_severity   TEXT    NOT NULL DEFAULT 'INFO',
      updated_at     TEXT    NOT NULL DEFAULT '',
      FOREIGN KEY (username) REFERENCES users(username)
    )`);

    // Every message the app decided to send, whether or not a real transport
    // delivered it. Keeps dispatch auditable and makes "emailed exactly once"
    // a checkable property.
    db.run(`CREATE TABLE IF NOT EXISTS email_outbox (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      notification_id INTEGER,
      recipient       TEXT NOT NULL DEFAULT '',
      subject         TEXT NOT NULL DEFAULT '',
      body            TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'queued',
      error           TEXT,
      created_at      TEXT NOT NULL DEFAULT '',
      sent_at         TEXT,
      FOREIGN KEY (notification_id) REFERENCES notifications(id)
    )`);
    // Added after the outbox shipped — safe if the columns already exist.
    // intended_recipient records who a message was really for when
    // MAIL_REDIRECT_TO rewrote the envelope; preview_url holds the Ethereal
    // link so a send can be opened and inspected.
    try { db.run(`ALTER TABLE email_outbox ADD COLUMN intended_recipient TEXT`); } catch (e) {}
    try { db.run(`ALTER TABLE email_outbox ADD COLUMN preview_url TEXT`); } catch (e) {}
  }

  // One-shot migration: everyone already enrolled becomes rostered.
  //
  // Without this, turning on closed-by-default would lock every existing
  // student out of the unit they are already in — units created before the
  // roster existed have no allowlist at all.
  //
  // Idempotent by the same rule migrateToProposalModel uses: short-circuit as
  // soon as any roster row exists anywhere, so a teacher's later edits are
  // never undone by a restart.
  backfillRosterFromEnrolments() {
    const db = this.db;
    const guard = db.prepare(`SELECT COUNT(*) AS n FROM unit_roster`);
    guard.step();
    const already = guard.getAsObject().n;
    guard.free();
    if (already > 0) return 0;

    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO unit_roster
         (unit_id, email, name, student_number, tutorial_time, is_new_to_qut,
          degree, major, minor, units_passed, it_skill_groups, invited_at)
       SELECT us.unit_id,
              LOWER(TRIM(u.email)),
              us.name,
              COALESCE(u.student_id, ''),
              us.tutorial_time, us.is_new_to_qut,
              us.degree, us.major, us.minor, us.units_passed, us.it_skill_groups,
              ?
         FROM unit_students us
         INNER JOIN users u ON u.username = us.student_id
        WHERE TRIM(COALESCE(u.email, '')) <> ''`,
      [now]
    );

    const after = db.prepare(`SELECT COUNT(*) AS n FROM unit_roster`);
    after.step();
    const n = after.getAsObject().n;
    after.free();
    if (n > 0) console.log(`Roster backfill: ${n} existing enrolments granted access`);
    return n;
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

const BaseRepository = require('./BaseRepository');

// Data access for `notifications` (per-student, per-unit inbox).
class NotificationRepository extends BaseRepository {
  // INSERT OR IGNORE against the UNIQUE (student_id, dedupe_key) index — this is
  // what lets the producer run on every read and on a timer without duplicating.
  insertIgnore(n) {
    this.run(
      `INSERT OR IGNORE INTO notifications
         (unit_id, student_id, type, title, body, link, dedupe_key, created_at, read_at, emailed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [n.unitId, n.studentId, n.type, n.title, n.body, n.link, n.dedupeKey,
       n.createdAt, n.readAt || null, n.emailedAt || null]
    );
  }

  // True once a student has been synced at least once for a unit. Drives the
  // first-sync backfill rule: existing history is inserted already-read so
  // switching the feature on doesn't produce a badge storm or an email blast.
  hasAnyFor(unitId, studentId) {
    return !!this.get(
      `SELECT 1 FROM notifications WHERE unit_id = ? AND student_id = ? LIMIT 1`,
      [unitId, studentId]
    );
  }

  listForStudent(unitId, studentId, limit = 100) {
    return this.all(
      `SELECT id, unit_id, student_id, type, title, body, link, created_at, read_at
         FROM notifications
        WHERE unit_id = ? AND student_id = ?
        ORDER BY (read_at IS NOT NULL), created_at DESC, id DESC
        LIMIT ?`,
      [unitId, studentId, limit]
    );
  }

  countUnread(unitId, studentId) {
    const row = this.get(
      `SELECT COUNT(*) AS cnt FROM notifications
        WHERE unit_id = ? AND student_id = ? AND read_at IS NULL`,
      [unitId, studentId]
    );
    return row?.cnt || 0;
  }

  // Scoped by student_id so one student can never mark another's row read.
  markRead(id, studentId, at) {
    this.run(
      `UPDATE notifications SET read_at = ?
        WHERE id = ? AND student_id = ? AND read_at IS NULL`,
      [at, id, studentId]
    );
  }

  markAllRead(unitId, studentId, at) {
    this.run(
      `UPDATE notifications SET read_at = ?
        WHERE unit_id = ? AND student_id = ? AND read_at IS NULL`,
      [at, unitId, studentId]
    );
  }

  findOwned(id, studentId) {
    return this.get(`SELECT * FROM notifications WHERE id = ? AND student_id = ?`,
      [id, studentId]);
  }

  // Everything still awaiting an email decision, newest last so a backlog is
  // dispatched in the order it happened.
  listPendingEmail(limit = 200) {
    return this.all(
      `SELECT * FROM notifications WHERE emailed_at IS NULL ORDER BY id ASC LIMIT ?`,
      [limit]
    );
  }

  markEmailed(id, at) {
    this.run(`UPDATE notifications SET emailed_at = ? WHERE id = ?`, [at, id]);
  }
}

module.exports = NotificationRepository;

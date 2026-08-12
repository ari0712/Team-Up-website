const BaseRepository = require('./BaseRepository');

// Data access for `email_outbox` — an audit trail of every message the app
// decided to send, independent of whether a transport actually delivered it.
class EmailOutboxRepository extends BaseRepository {
  queue(m) {
    this.run(
      `INSERT INTO email_outbox
         (notification_id, recipient, intended_recipient, subject, body,
          status, error, created_at, sent_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [m.notificationId, m.recipient, m.intendedRecipient || m.recipient,
       m.subject, m.body,
       m.status || 'queued', m.error || null, m.createdAt, m.sentAt || null]
    );
    // NOT last_insert_rowid(): Database.run() flushes with export() after every
    // statement, which resets it to 0. sql.js is synchronous and Node is
    // single-threaded, so no insert can interleave between the two statements.
    return this.get(`SELECT MAX(id) AS id FROM email_outbox`)?.id;
  }

  markSent(id, at, previewUrl = null) {
    this.run(`UPDATE email_outbox SET status = 'sent', sent_at = ?, preview_url = ? WHERE id = ?`,
      [at, previewUrl, id]);
  }

  markFailed(id, error) {
    this.run(`UPDATE email_outbox SET status = 'failed', error = ? WHERE id = ?`,
      [String(error).slice(0, 500), id]);
  }

  findByNotification(notificationId) {
    return this.all(`SELECT * FROM email_outbox WHERE notification_id = ?`, [notificationId]);
  }

  listRecent(limit = 50) {
    return this.all(`SELECT * FROM email_outbox ORDER BY id DESC LIMIT ?`, [limit]);
  }
}

module.exports = EmailOutboxRepository;

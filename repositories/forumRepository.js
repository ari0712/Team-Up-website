const BaseRepository = require('./BaseRepository');

// Author identity, resolved at read time rather than stored on the post.
//
// LEFT JOIN, never INNER: a teacher has no `students` row, so an inner join
// would silently drop every teacher's post from the board. The COALESCE chain is
// what gives a teacher a usable name — they have no display_name either.
const AUTHOR = `
  COALESCE(NULLIF(s.display_name, ''), p.author_username) AS author_name,
  COALESCE(s.avatar_path, '')                             AS author_avatar`;

// Data access for `forum_threads` and `forum_replies`.
//
// Every read and every write is scoped by unit_id as well as by row id, so a
// caller who has been cleared for one unit can never reach another unit's board
// by guessing a thread or reply number.
class ForumRepository extends BaseRepository {
  // Board index. Pinned first, then by most recent activity — a thread with a
  // fresh reply outranks a newer thread nobody has answered.
  listThreads(unitId) {
    return this.all(
      `SELECT p.id, p.unit_id, p.author_username, p.author_role, p.title, p.body,
              p.pinned, p.created_at,
              ${AUTHOR},
              (SELECT COUNT(*)        FROM forum_replies r WHERE r.thread_id = p.id) AS reply_count,
              (SELECT MAX(created_at) FROM forum_replies r WHERE r.thread_id = p.id) AS last_reply_at
         FROM forum_threads p
         LEFT JOIN students s ON s.username = p.author_username
        WHERE p.unit_id = ?
        ORDER BY p.pinned DESC,
                 COALESCE((SELECT MAX(created_at) FROM forum_replies r WHERE r.thread_id = p.id),
                          p.created_at) DESC,
                 p.id DESC`,
      [unitId]
    );
  }

  findThread(unitId, threadId) {
    return this.get(
      `SELECT p.id, p.unit_id, p.author_username, p.author_role, p.title, p.body,
              p.pinned, p.created_at,
              ${AUTHOR}
         FROM forum_threads p
         LEFT JOIN students s ON s.username = p.author_username
        WHERE p.unit_id = ? AND p.id = ?`,
      [unitId, threadId]
    );
  }

  // Oldest first: a thread reads top to bottom as the conversation happened.
  listReplies(unitId, threadId) {
    return this.all(
      `SELECT p.id, p.thread_id, p.author_username, p.author_role, p.body, p.created_at,
              ${AUTHOR}
         FROM forum_replies p
         LEFT JOIN students s ON s.username = p.author_username
        WHERE p.unit_id = ? AND p.thread_id = ?
        ORDER BY p.id ASC`,
      [unitId, threadId]
    );
  }

  findReply(unitId, replyId) {
    return this.get(`SELECT * FROM forum_replies WHERE unit_id = ? AND id = ?`,
      [unitId, replyId]);
  }

  // Reads last_insert_rowid() on the raw handle inside the transaction, before
  // Database.save() runs. Reading it afterwards returns 0: save() exports the
  // whole database, and that clears the connection's last-insert state.
  _insertReturningId(sql, params) {
    return this.db.tx(db => {
      db.run(sql, params);
      const stmt = db.prepare(`SELECT last_insert_rowid() AS id`);
      stmt.step();
      const { id } = stmt.getAsObject();
      stmt.free();
      return id;
    });
  }

  // Returns the new thread's id so the caller can send the author straight to it.
  createThread({ unitId, authorUsername, authorRole, title, body, createdAt }) {
    return this._insertReturningId(
      `INSERT INTO forum_threads
         (unit_id, author_username, author_role, title, body, created_at)
       VALUES (?,?,?,?,?,?)`,
      [unitId, authorUsername, authorRole, title, body, createdAt]
    );
  }

  createReply({ unitId, threadId, authorUsername, authorRole, body, createdAt }) {
    return this._insertReturningId(
      `INSERT INTO forum_replies
         (thread_id, unit_id, author_username, author_role, body, created_at)
       VALUES (?,?,?,?,?,?)`,
      [threadId, unitId, authorUsername, authorRole, body, createdAt]
    );
  }

  // One transaction, so removing a thread and its replies costs a single flush.
  // Database.run rewrites the whole db file per call, so a busy thread deleted
  // reply-by-reply would rewrite it dozens of times for one action.
  deleteThread(unitId, threadId) {
    this.db.tx(db => {
      db.run(`DELETE FROM forum_replies WHERE unit_id = ? AND thread_id = ?`, [unitId, threadId]);
      db.run(`DELETE FROM forum_threads WHERE unit_id = ? AND id = ?`,        [unitId, threadId]);
    });
  }

  deleteReply(unitId, replyId) {
    this.run(`DELETE FROM forum_replies WHERE unit_id = ? AND id = ?`, [unitId, replyId]);
  }

  setPinned(unitId, threadId, pinned) {
    this.run(`UPDATE forum_threads SET pinned = ? WHERE unit_id = ? AND id = ?`,
      [pinned ? 1 : 0, unitId, threadId]);
  }
}

module.exports = ForumRepository;

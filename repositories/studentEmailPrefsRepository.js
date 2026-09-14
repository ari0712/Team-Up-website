const BaseRepository = require('./BaseRepository');
const { CATEGORIES, CATEGORY_DEFAULTS } = require('../utils/emailCategories');

// Data access for `student_email_prefs`: one on/off per (student, unit,
// category). A student who has never touched the panel has no rows, so `get`
// synthesises the defaults — they live in utils/emailCategories.js and
// nowhere else.
class StudentEmailPrefsRepository extends BaseRepository {
  get(username, unitId) {
    const prefs = { ...CATEGORY_DEFAULTS };
    for (const r of this.all(
      `SELECT category, enabled FROM student_email_prefs WHERE username = ? AND unit_id = ?`,
      [username, unitId])) {
      if (CATEGORIES.includes(r.category)) prefs[r.category] = r.enabled ? 1 : 0;
    }
    return prefs;
  }

  set(username, unitId, category, enabled, at) {
    if (!CATEGORIES.includes(category)) throw new Error(`Unknown email category: ${category}`);
    this.run(
      `INSERT INTO student_email_prefs (username, unit_id, category, enabled, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(username, unit_id, category) DO UPDATE SET
         enabled = excluded.enabled, updated_at = excluded.updated_at`,
      [username, unitId, category, enabled ? 1 : 0, at]
    );
  }

  // Every (student, unit) row in one query — the dispatcher reads prefs for
  // many recipients per pass and must not go to the database once per email.
  listAll() {
    return this.all(`SELECT username, unit_id, category, enabled FROM student_email_prefs`);
  }
}

module.exports = StudentEmailPrefsRepository;

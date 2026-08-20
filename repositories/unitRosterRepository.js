const BaseRepository = require('./BaseRepository');

// Data access for `unit_roster` — WHO IS ALLOWED to join a unit.
//
// Distinct from `unit_students`, which is who actually joined. Email is the
// match key and is always lowercased and trimmed, on write and on lookup, so
// "Tom@QUT.edu.au" on a roster admits a signup of "tom@qut.edu.au".
const norm = e => String(e ?? '').trim().toLowerCase();

class UnitRosterRepository extends BaseRepository {
  findByEmail(unitId, email) {
    const e = norm(email);
    if (!e) return null;
    return this.get(`SELECT * FROM unit_roster WHERE unit_id = ? AND email = ?`, [unitId, e]);
  }

  // Units this email may see. Returned as a Set-friendly list of unit ids.
  listUnitIdsForEmail(email) {
    const e = norm(email);
    if (!e) return [];
    return this.all(`SELECT unit_id FROM unit_roster WHERE email = ?`, [e])
      .map(r => r.unit_id);
  }

  listForUnit(unitId) {
    return this.all(
      `SELECT * FROM unit_roster WHERE unit_id = ? ORDER BY name, email`, [unitId]
    );
  }

  // Roster plus whether that person has actually joined. The roster is keyed by
  // email and enrolment by username, so the link has to go through `users`.
  listForUnitWithJoined(unitId) {
    return this.all(
      `SELECT r.*,
              CASE WHEN EXISTS (
                SELECT 1 FROM users u
                  INNER JOIN unit_students us
                          ON us.student_id = u.username AND us.unit_id = r.unit_id
                 WHERE LOWER(TRIM(u.email)) = r.email
              ) THEN 1 ELSE 0 END AS joined
         FROM unit_roster r
        WHERE r.unit_id = ?
        ORDER BY joined DESC, r.name, r.email`,
      [unitId]
    );
  }

  countForUnit(unitId) {
    return this.get(`SELECT COUNT(*) AS cnt FROM unit_roster WHERE unit_id = ?`, [unitId])?.cnt || 0;
  }

  // Rows without a usable email are skipped rather than stored — a roster entry
  // that can never match anybody is worse than no entry, because it looks like
  // access was granted. Returns { added, updated, skipped }.
  //
  // Imports are additive and repeatable: a unit's roster can be topped up as
  // many times as the teacher likes, and nobody already listed is removed.
  //
  // Every field is merged rather than overwritten — a blank incoming value keeps
  // whatever is already stored. Without that, a later top-up listing only emails
  // would silently wipe the names and tutorial times an earlier richer import
  // had set. The two integer columns are passed as NULL (not 0) when absent,
  // because 0 is a real value for both and cannot double as "not supplied".
  upsertMany(unitId, entries, invitedAt) {
    let added = 0, updated = 0, skipped = 0;
    const text = v => String(v ?? '').trim();
    const flag = v => (v === undefined || v === null || v === ''
      ? null : (String(v) === '1' || v === true || String(v).toLowerCase() === 'yes' ? 1 : 0));
    const num = v => {
      if (v === undefined || v === null || String(v).trim() === '') return null;
      const n = parseInt(v);
      return Number.isFinite(n) ? n : null;
    };

    for (const s of entries || []) {
      const email = norm(s.email);
      if (!email || !email.includes('@')) { skipped++; continue; }
      const existing = !!this.findByEmail(unitId, email);
      // NULL means "keep what is stored", which only makes sense for a row that
      // already exists. A brand-new row takes the column defaults instead, so
      // the two integer columns are never left null.
      const newToQut = existing ? flag(s.is_new_to_qut) : (flag(s.is_new_to_qut) ?? 0);
      const unitsPassed = existing ? num(s.units_passed) : (num(s.units_passed) ?? 0);
      this.run(
        `INSERT INTO unit_roster
           (unit_id, email, name, student_number, tutorial_time, is_new_to_qut,
            degree, major, minor, units_passed, it_skill_groups, invited_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(unit_id, email) DO UPDATE SET
           name            = COALESCE(NULLIF(excluded.name, ''),            unit_roster.name),
           student_number  = COALESCE(NULLIF(excluded.student_number, ''),  unit_roster.student_number),
           tutorial_time   = COALESCE(NULLIF(excluded.tutorial_time, ''),   unit_roster.tutorial_time),
           is_new_to_qut   = COALESCE(excluded.is_new_to_qut,               unit_roster.is_new_to_qut),
           degree          = COALESCE(NULLIF(excluded.degree, ''),          unit_roster.degree),
           major           = COALESCE(NULLIF(excluded.major, ''),           unit_roster.major),
           minor           = COALESCE(NULLIF(excluded.minor, ''),           unit_roster.minor),
           units_passed    = COALESCE(excluded.units_passed,                unit_roster.units_passed),
           it_skill_groups = COALESCE(NULLIF(excluded.it_skill_groups, ''), unit_roster.it_skill_groups)`,
        [unitId, email,
         text(s.name), text(s.student_id || s.student_number),
         text(s.tutorial_time),
         newToQut,
         text(s.degree), text(s.major), text(s.minor),
         unitsPassed, text(s.it_skill_groups),
         invitedAt]
      );
      if (existing) updated++; else added++;
    }
    return { added, updated, skipped };
  }

  remove(unitId, email) {
    this.run(`DELETE FROM unit_roster WHERE unit_id = ? AND email = ?`, [unitId, norm(email)]);
  }
}

module.exports = UnitRosterRepository;
module.exports.normaliseEmail = norm;

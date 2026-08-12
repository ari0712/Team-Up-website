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
  // access was granted. Returns { added, skipped }.
  upsertMany(unitId, entries, invitedAt) {
    let added = 0, skipped = 0;
    for (const s of entries || []) {
      const email = norm(s.email);
      if (!email || !email.includes('@')) { skipped++; continue; }
      this.run(
        `INSERT INTO unit_roster
           (unit_id, email, name, student_number, tutorial_time, is_new_to_qut,
            degree, major, minor, units_passed, it_skill_groups, invited_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(unit_id, email) DO UPDATE SET
           name            = excluded.name,
           student_number  = excluded.student_number,
           tutorial_time   = excluded.tutorial_time,
           is_new_to_qut   = excluded.is_new_to_qut,
           degree          = excluded.degree,
           major           = excluded.major,
           minor           = excluded.minor,
           units_passed    = excluded.units_passed,
           it_skill_groups = excluded.it_skill_groups`,
        [unitId, email,
         s.name || '', s.student_id || s.student_number || '',
         s.tutorial_time || '',
         ('1' === String(s.is_new_to_qut) || s.is_new_to_qut === true) ? 1 : 0,
         s.degree || '', s.major || '', s.minor || '',
         parseInt(s.units_passed) || 0, s.it_skill_groups || '',
         invitedAt]
      );
      added++;
    }
    return { added, skipped };
  }

  remove(unitId, email) {
    this.run(`DELETE FROM unit_roster WHERE unit_id = ? AND email = ?`, [unitId, norm(email)]);
  }
}

module.exports = UnitRosterRepository;
module.exports.normaliseEmail = norm;

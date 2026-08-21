const BaseRepository = require('./BaseRepository');
const { ABOUT_COLUMNS } = require('../utils/aboutFields');

// Data access for `student_unit_prefs` (per-unit student preferences).
class PreferencesRepository extends BaseRepository {
  get(unitId, studentId) {
    return super.get(
      `SELECT * FROM student_unit_prefs WHERE unit_id = ? AND student_id = ?`,
      [unitId, studentId]
    );
  }

  getPreferredRole(unitId, studentId) {
    const row = super.get(
      `SELECT preferred_role FROM student_unit_prefs WHERE unit_id = ? AND student_id = ?`,
      [unitId, studentId]
    );
    return row?.preferred_role || '';
  }

  upsert(unitId, studentId, p) {
    this.run(
      `INSERT INTO student_unit_prefs
         (unit_id, student_id, tutorial_slots, project_interests, skills, preferred_role, preferred_teammates, saved_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(unit_id, student_id) DO UPDATE SET
         tutorial_slots=excluded.tutorial_slots,
         project_interests=excluded.project_interests,
         skills=excluded.skills,
         preferred_role=excluded.preferred_role,
         preferred_teammates=excluded.preferred_teammates,
         saved_at=excluded.saved_at`,
      [unitId, studentId, p.tutorialSlots, p.projectInterests, p.skills,
       p.preferredRole, p.preferredTeammates, p.savedAt]
    );
  }

  // Writes ONLY the About Me columns, leaving the structured preferences alone.
  //
  // Deliberately not folded into `upsert` above: that one overwrites every
  // column from its argument, so routing the profile save through it would
  // blank the student's tutorial slots, interests, skills and role.
  //
  // The INSERT branch matters — a student can write their profile before ever
  // saving preferences, and there is no row yet in that case. The remaining
  // columns take their table defaults, and `saved_at` is left alone because it
  // records when the *preferences* were last saved.
  upsertAbout(unitId, studentId, about) {
    const cols = ABOUT_COLUMNS.join(', ');
    const placeholders = ABOUT_COLUMNS.map(() => '?').join(',');
    const updates = ABOUT_COLUMNS.map(c => `${c}=excluded.${c}`).join(', ');
    const values = ABOUT_COLUMNS.map(c => about[c] ?? '');

    this.run(
      `INSERT INTO student_unit_prefs (unit_id, student_id, ${cols})
       VALUES (?,?,${placeholders})
       ON CONFLICT(unit_id, student_id) DO UPDATE SET ${updates}`,
      [unitId, studentId, ...values]
    );
  }

  // For tutorial-slot cascade rename/delete.
  listTutorialSlots(unitId) {
    return this.all(
      `SELECT student_id, tutorial_slots FROM student_unit_prefs WHERE unit_id = ?`,
      [unitId]
    );
  }

  updateTutorialSlots(unitId, studentId, value) {
    this.run(
      `UPDATE student_unit_prefs SET tutorial_slots = ? WHERE unit_id = ? AND student_id = ?`,
      [value, unitId, studentId]
    );
  }
}

module.exports = PreferencesRepository;

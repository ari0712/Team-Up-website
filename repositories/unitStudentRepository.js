const BaseRepository = require('./BaseRepository');

// Data access for `unit_students` (the per-unit class list / enrollment).
class UnitStudentRepository extends BaseRepository {
  isEnrolled(unitId, studentId) {
    return !!this.get(
      `SELECT 1 FROM unit_students WHERE unit_id = ? AND student_id = ?`,
      [unitId, studentId]
    );
  }

  enroll(unitId, studentId, name) {
    this.run(
      `INSERT INTO unit_students (unit_id, student_id, name) VALUES (?,?,?)`,
      [unitId, studentId, name]
    );
  }

  countForUnit(unitId) {
    const row = this.get(`SELECT COUNT(*) AS cnt FROM unit_students WHERE unit_id = ?`, [unitId]);
    return row?.cnt || 0;
  }

  getName(unitId, studentId) {
    const row = this.get(
      `SELECT name FROM unit_students WHERE unit_id = ? AND student_id = ?`,
      [unitId, studentId]
    );
    return row?.name || '';
  }

  // Bulk import from a parsed CSV row (idempotent on (unit_id, student_id)).
  upsertImport(unitId, s) {
    this.run(
      `INSERT OR REPLACE INTO unit_students
         (unit_id, student_id, name, tutorial_time, is_new_to_qut,
          degree, major, minor, units_passed, it_skill_groups)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        unitId, s.student_id,
        s.name           || '',
        s.tutorial_time  || '',
        ('1' === String(s.is_new_to_qut) || s.is_new_to_qut === true) ? 1 : 0,
        s.degree         || '',
        s.major          || '',
        s.minor          || '',
        parseInt(s.units_passed) || 0,
        s.it_skill_groups || ''
      ]
    );
  }

  // Classmates for the find-teammates search (excludes the caller). The caller
  // applies text filters in memory.
  listClassmates(unitId, excludeStudentId) {
    return this.all(
      `SELECT us.student_id, us.name, us.tutorial_time, us.is_new_to_qut,
              sup.tutorial_slots, sup.project_interests, sup.skills, sup.preferred_role,
              (SELECT tm.team_id FROM unit_team_members tm
                 INNER JOIN unit_teams t ON t.team_id = tm.team_id
                WHERE tm.student_id = us.student_id AND t.unit_id = us.unit_id
                LIMIT 1) AS team_id
       FROM unit_students us
       LEFT JOIN student_unit_prefs sup ON sup.unit_id = us.unit_id AND sup.student_id = us.student_id
       WHERE us.unit_id = ? AND us.student_id != ?`,
      [unitId, excludeStudentId]
    );
  }

  // Full class list with each student's progress stages and saved preferences.
  listWithProgress(unitId) {
    return this.all(
      `SELECT us.student_id, us.name, us.tutorial_time, us.is_new_to_qut,
              us.degree, us.major,
              COALESCE(sp.read_rules,          0) AS read_rules,
              COALESCE(sp.entered_preferences, 0) AS entered_preferences,
              COALESCE(sp.in_team,             0) AS in_team,
              COALESCE(sp.submitted_request,   0) AS submitted_request,
              COALESCE(sp.teacher_approved,    0) AS teacher_approved,
              sup.tutorial_slots, sup.project_interests, sup.skills, sup.preferred_role
       FROM unit_students us
       LEFT JOIN student_progress sp ON sp.unit_id = us.unit_id AND sp.student_id = us.student_id
       LEFT JOIN student_unit_prefs sup ON sup.unit_id = us.unit_id AND sup.student_id = us.student_id
       WHERE us.unit_id = ?
       ORDER BY us.name ASC`,
      [unitId]
    );
  }

  // For tutorial-slot cascade rename/delete.
  listTutorialTimes(unitId) {
    return this.all(
      `SELECT student_id, tutorial_time FROM unit_students WHERE unit_id = ?`,
      [unitId]
    );
  }

  updateTutorialTime(unitId, studentId, value) {
    this.run(
      `UPDATE unit_students SET tutorial_time = ? WHERE unit_id = ? AND student_id = ?`,
      [value, unitId, studentId]
    );
  }
}

module.exports = UnitStudentRepository;

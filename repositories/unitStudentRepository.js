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

  // Enrol a student, carrying across the attributes the teacher supplied on the
  // roster. tutorial_time still feeds validateTeam's fallback and the
  // find-teammates search, so it must land here on join — the roster row
  // itself is never read by those code paths.
  //
  // `is_new_to_qut` is a retired column on both tables: it was only ever an
  // input to the removed new-to-QUT cap, so it is neither imported nor copied.
  enrollFromRoster(unitId, studentId, roster, fallbackName) {
    this.run(
      `INSERT INTO unit_students
         (unit_id, student_id, name, tutorial_time,
          degree, major, minor, units_passed, it_skill_groups)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [unitId, studentId,
       roster?.name || fallbackName || studentId,
       roster?.tutorial_time || '',
       roster?.degree || '', roster?.major || '', roster?.minor || '',
       parseInt(roster?.units_passed) || 0, roster?.it_skill_groups || '']
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

  // The "place me anywhere" declaration. '' withdraws it.
  setNoPreference(unitId, studentId, at) {
    this.run(
      `UPDATE unit_students SET no_preference_at = ? WHERE unit_id = ? AND student_id = ?`,
      [at || '', unitId, studentId]
    );
  }

  getNoPreferenceAt(unitId, studentId) {
    return this.get(
      `SELECT no_preference_at FROM unit_students WHERE unit_id = ? AND student_id = ?`,
      [unitId, studentId]
    )?.no_preference_at || '';
  }

  // Called when students land in a group of 2+: a declaration made while alone
  // no longer describes what they want.
  clearNoPreferenceForStudents(unitId, studentIds) {
    if (!studentIds.length) return;
    const placeholders = studentIds.map(() => '?').join(',');
    this.run(
      `UPDATE unit_students SET no_preference_at = ''
        WHERE unit_id = ? AND student_id IN (${placeholders})`,
      [unitId, ...studentIds]
    );
  }

  // Bulk import from a parsed CSV row (idempotent on (unit_id, student_id)).
  upsertImport(unitId, s) {
    this.run(
      `INSERT OR REPLACE INTO unit_students
         (unit_id, student_id, name, tutorial_time,
          degree, major, minor, units_passed, it_skill_groups)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        unitId, s.student_id,
        s.name           || '',
        s.tutorial_time  || '',
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
  //
  // `us.student_id` is the USERNAME — it is the identity key every other query
  // joins on, so it must keep that meaning. It is never shown as an identifier.
  //
  // `email` is selected so the search can match a full address the caller
  // already holds. It does NOT reach the caller by default: searchClassmates
  // strips it from every row except the shared-name case. The student number
  // (users.student_id) is deliberately not selected here — students cannot see
  // anyone's number in QUT systems, so it could only ever leak.
  listClassmates(unitId, excludeStudentId) {
    return this.all(
      `SELECT us.student_id, us.name, us.tutorial_time,
              LOWER(TRIM(COALESCE(u.email, ''))) AS email,
              sup.tutorial_slots, sup.project_interests, sup.skills, sup.preferred_role,
              (SELECT tm.team_id FROM unit_team_members tm
                 INNER JOIN unit_teams t ON t.team_id = tm.team_id
                WHERE tm.student_id = us.student_id AND t.unit_id = us.unit_id
                LIMIT 1) AS team_id,
              -- Only a FORMING team can be merged with; createProposal refuses
              -- the rest. Returned so callers can hide students who are no
              -- longer available instead of offering an action that must fail.
              (SELECT t.status FROM unit_team_members tm
                 INNER JOIN unit_teams t ON t.team_id = tm.team_id
                WHERE tm.student_id = us.student_id AND t.unit_id = us.unit_id
                LIMIT 1) AS team_status
       FROM unit_students us
       LEFT JOIN student_unit_prefs sup ON sup.unit_id = us.unit_id AND sup.student_id = us.student_id
       LEFT JOIN users u ON u.username = us.student_id
       WHERE us.unit_id = ? AND us.student_id != ?`,
      [unitId, excludeStudentId]
    );
  }

  // Full class list with each student's progress stages and saved preferences.
  //
  // As in listClassmates, `us.student_id` is the USERNAME — the identity key the
  // progress and prefs joins rely on. Email is the identifier a coordinator
  // uses; the student number is not carried here — the export's opt-in column
  // (UnitService.buildExport) is the one sanctioned channel for it.
  listWithProgress(unitId) {
    return this.all(
      `SELECT us.student_id, us.name, us.tutorial_time,
              us.degree, us.major, us.no_preference_at,
              LOWER(TRIM(COALESCE(u.email, ''))) AS email,
              COALESCE(sp.read_rules,          0) AS read_rules,
              COALESCE(sp.entered_preferences, 0) AS entered_preferences,
              COALESCE(sp.in_team,             0) AS in_team,
              COALESCE(sp.submitted_request,   0) AS submitted_request,
              COALESCE(sp.teacher_approved,    0) AS teacher_approved,
              sup.tutorial_slots, sup.project_interests, sup.skills, sup.preferred_role
       FROM unit_students us
       LEFT JOIN student_progress sp ON sp.unit_id = us.unit_id AND sp.student_id = us.student_id
       LEFT JOIN student_unit_prefs sup ON sup.unit_id = us.unit_id AND sup.student_id = us.student_id
       LEFT JOIN users u ON u.username = us.student_id
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

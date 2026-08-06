const BaseRepository = require('./BaseRepository');

// Stages a student may toggle directly. teacher_approved is intentionally
// excluded — it is only set by teacher review flows.
const TOGGLEABLE_STAGES = ['read_rules', 'entered_preferences', 'in_team', 'submitted_request'];

// Data access for `student_progress`.
class ProgressRepository extends BaseRepository {
  static get TOGGLEABLE_STAGES() { return TOGGLEABLE_STAGES; }

  get(unitId, studentId) {
    return super.get(
      `SELECT * FROM student_progress WHERE unit_id = ? AND student_id = ?`,
      [unitId, studentId]
    );
  }

  ensure(unitId, studentId) {
    this.run(`INSERT OR IGNORE INTO student_progress (unit_id, student_id) VALUES (?,?)`,
      [unitId, studentId]);
  }

  // Sets one of the toggleable stage columns. The column name is validated
  // against a whitelist so the interpolation can never carry untrusted input.
  setStage(unitId, studentId, stage, value) {
    if (!TOGGLEABLE_STAGES.includes(stage)) {
      throw new Error(`Refusing to set unknown progress stage: ${stage}`);
    }
    this.run(
      `UPDATE student_progress SET ${stage} = ? WHERE unit_id = ? AND student_id = ?`,
      [value ? 1 : 0, unitId, studentId]
    );
  }

  markEnteredPreferences(unitId, studentId) {
    this.run(`UPDATE student_progress SET entered_preferences = 1 WHERE unit_id = ? AND student_id = ?`,
      [unitId, studentId]);
  }

  markInTeam(unitId, studentId) {
    this.run(`UPDATE student_progress SET in_team = 1 WHERE unit_id = ? AND student_id = ?`,
      [unitId, studentId]);
  }

  markSubmitted(unitId, studentId) {
    this.run(`UPDATE student_progress SET submitted_request = 1 WHERE unit_id = ? AND student_id = ?`,
      [unitId, studentId]);
  }

  markTeacherApproved(unitId, studentId) {
    this.run(`UPDATE student_progress SET teacher_approved = 1 WHERE unit_id = ? AND student_id = ?`,
      [unitId, studentId]);
  }

  // Disapprove revokes the teacher's decision but leaves the team submitted, so
  // only the approval flag is cleared — the students did submit, and that is
  // still true. Distinct from clearSubmission, which unwinds both.
  clearTeacherApproval(unitId, studentId) {
    this.run(`UPDATE student_progress SET teacher_approved = 0 WHERE unit_id = ? AND student_id = ?`,
      [unitId, studentId]);
  }

  // Reject sends a team back to FORMING — clear both flags so the UI matches.
  clearSubmission(unitId, studentId) {
    this.run(
      `UPDATE student_progress SET submitted_request = 0, teacher_approved = 0
        WHERE unit_id = ? AND student_id = ?`,
      [unitId, studentId]
    );
  }
}

module.exports = ProgressRepository;

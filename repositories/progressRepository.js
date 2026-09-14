const BaseRepository = require('./BaseRepository');

// The two stages a student performs themselves and that nothing else can
// derive: reading the rules and saving preferences. The team stages —
// grouped / declared, finalised — are DERIVED at read time from placement and
// the team's status (see UnitService._classListWithPlacement and
// StudentPortalService.getProgress), never stored, so they cannot drift.
//
// `in_team`, `submitted_request` and `teacher_approved` are legacy columns from
// the teacher-approval era. They are no longer written or read.
const TOGGLEABLE_STAGES = ['read_rules', 'entered_preferences'];

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
}

module.exports = ProgressRepository;

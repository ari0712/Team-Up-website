const BaseRepository = require('./BaseRepository');

// Data access for `finalise_batches` — one row per organiser save.
//
// The snapshot is what makes a batch revertible: the affected teams, their
// memberships and each affected student's "place me anywhere" declaration,
// exactly as they were before the save. Restoring only statuses would leave a
// bad allocation in place as a protected OPEN group the organiser could not
// then split, and would lose declarations the save had cleared.
class FinaliseBatchRepository extends BaseRepository {
  create({ batchId, unitId, createdBy, createdAt, teamCount, studentCount, snapshot }) {
    this.run(
      `INSERT INTO finalise_batches
         (batch_id, unit_id, created_by, created_at, team_count, student_count, snapshot_json)
       VALUES (?,?,?,?,?,?,?)`,
      [batchId, unitId, createdBy, createdAt, teamCount, studentCount, JSON.stringify(snapshot)]
    );
  }

  findInUnit(batchId, unitId) {
    const row = this.get(
      `SELECT * FROM finalise_batches WHERE batch_id = ? AND unit_id = ?`, [batchId, unitId]);
    if (!row) return null;
    return { ...row, snapshot: JSON.parse(row.snapshot_json || '{}') };
  }

  // Newest first, without the snapshot payload — the list is for a panel.
  listForUnit(unitId, limit = 20) {
    return this.all(
      `SELECT batch_id, unit_id, created_by, created_at, team_count, student_count, reverted_at
         FROM finalise_batches WHERE unit_id = ?
        ORDER BY created_at DESC LIMIT ?`,
      [unitId, limit]
    );
  }

  markReverted(batchId, at) {
    this.run(`UPDATE finalise_batches SET reverted_at = ? WHERE batch_id = ?`, [at, batchId]);
  }
}

module.exports = FinaliseBatchRepository;

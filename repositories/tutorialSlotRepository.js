const BaseRepository = require('./BaseRepository');

// Data access for `unit_tutorial_slots`.
class TutorialSlotRepository extends BaseRepository {
  listForUnit(unitId) {
    return this.all(
      `SELECT slot_id, label, sort_order FROM unit_tutorial_slots
        WHERE unit_id = ? ORDER BY sort_order, label`,
      [unitId]
    );
  }

  findById(slotId, unitId) {
    return this.get(`SELECT * FROM unit_tutorial_slots WHERE slot_id = ? AND unit_id = ?`,
      [slotId, unitId]);
  }

  existsByLabel(unitId, label) {
    return !!this.get(`SELECT 1 FROM unit_tutorial_slots WHERE unit_id = ? AND label = ?`,
      [unitId, label]);
  }

  hasCollision(unitId, label, excludeSlotId) {
    return !!this.get(
      `SELECT 1 FROM unit_tutorial_slots WHERE unit_id = ? AND label = ? AND slot_id <> ?`,
      [unitId, label, excludeSlotId]
    );
  }

  nextSortOrder(unitId) {
    const row = this.get(`SELECT MAX(sort_order) AS m FROM unit_tutorial_slots WHERE unit_id = ?`,
      [unitId]);
    return (row?.m ?? -1) + 1;
  }

  create(slotId, unitId, label, sortOrder) {
    this.run(
      `INSERT INTO unit_tutorial_slots (slot_id, unit_id, label, sort_order)
       VALUES (?,?,?,?)`,
      [slotId, unitId, label, sortOrder]
    );
  }

  rename(slotId, label) {
    this.run(`UPDATE unit_tutorial_slots SET label = ? WHERE slot_id = ?`, [label, slotId]);
  }

  remove(slotId) {
    this.run(`DELETE FROM unit_tutorial_slots WHERE slot_id = ?`, [slotId]);
  }
}

module.exports = TutorialSlotRepository;

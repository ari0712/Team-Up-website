const BaseRepository = require('./BaseRepository');

// Data access for `unit_announcements`.
class AnnouncementRepository extends BaseRepository {
  // Teacher view — full rows.
  listForUnit(unitId) {
    return this.all(`SELECT * FROM unit_announcements WHERE unit_id = ? ORDER BY id DESC`,
      [unitId]);
  }

  // Student view — public columns only.
  listForStudent(unitId) {
    return this.all(
      `SELECT id, title, content, created_at FROM unit_announcements
        WHERE unit_id = ? ORDER BY id DESC`,
      [unitId]
    );
  }

  create(unitId, title, content, createdAt) {
    this.run(
      `INSERT INTO unit_announcements (unit_id, title, content, created_at) VALUES (?,?,?,?)`,
      [unitId, title, content, createdAt]
    );
  }
}

module.exports = AnnouncementRepository;

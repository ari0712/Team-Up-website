const BaseRepository = require('./BaseRepository');

const JOIN = `
  SELECT u.username, u.password_hash, u.email, u.student_id,
         s.display_name, s.tutorial_availability, s.major, s.units_passed, s.team_id
  FROM users u JOIN students s ON u.username = s.username
`;

class StudentRepository extends BaseRepository {
  _map(row) {
    if (!row) return null;
    return {
      username: row.username,
      passwordHash: row.password_hash,
      email: row.email,
      studentId: row.student_id,
      displayName: row.display_name,
      tutorialAvailability: row.tutorial_availability,
      major: row.major,
      unitsPassed: row.units_passed,
      teamId: row.team_id,
      role: 'STUDENT'
    };
  }

  save(s) {
    this.run(
      `INSERT INTO students (username, display_name, tutorial_availability, major, units_passed, team_id)
       VALUES (?,?,?,?,?,?)`,
      [s.username, s.displayName || null, s.tutorialAvailability || null,
       s.major || null, s.unitsPassed || 0, s.teamId || null]
    );
  }

  findByUsername(username) {
    return this._map(this.get(JOIN + ' WHERE u.username = ?', [username]));
  }
}

module.exports = StudentRepository;

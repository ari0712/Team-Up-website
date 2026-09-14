const BaseRepository = require('./BaseRepository');

class UserRepository extends BaseRepository {
  findByUsername(username) {
    return this.get(
      'SELECT username, password_hash, email, role FROM users WHERE username = ?',
      [username]
    );
  }

  save(user) {
    this.run(
      'INSERT INTO users (username, password_hash, email, role) VALUES (?,?,?,?)',
      [user.username, user.passwordHash, user.email, user.role]
    );
  }

  existsByUsername(username) {
    return !!this.findByUsername(username);
  }

  // Student numbers for a set of usernames. The ONE read path for the number
  // outside signup: UnitService.buildExport, and only when the unit opted in.
  listStudentNumbers(usernames) {
    if (!usernames.length) return new Map();
    const placeholders = usernames.map(() => '?').join(',');
    return new Map(this.all(
      `SELECT username, COALESCE(student_id, '') AS student_id FROM users WHERE username IN (${placeholders})`,
      usernames).map(r => [r.username, r.student_id]));
  }

  setStudentId(username, studentId) {
    this.run('UPDATE users SET student_id = ? WHERE username = ?', [studentId, username]);
  }

  updateEmail(username, email) {
    this.run('UPDATE users SET email = ? WHERE username = ?', [email, username]);
  }
}

module.exports = UserRepository;

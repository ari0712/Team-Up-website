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

  setStudentId(username, studentId) {
    this.run('UPDATE users SET student_id = ? WHERE username = ?', [studentId, username]);
  }

  updateEmail(username, email) {
    this.run('UPDATE users SET email = ? WHERE username = ?', [email, username]);
  }
}

module.exports = UserRepository;

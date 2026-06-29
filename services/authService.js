const crypto = require('crypto');

class AuthService {
  constructor({ userRepo, studentRepo }) {
    this.userRepo = userRepo;
    this.studentRepo = studentRepo;
  }

  hash(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  login(username, password, role) {
    const u = this.userRepo.findByUsername(username);
    if (!u) return null;
    if (u.password_hash !== this.hash(password)) return null;
    if (u.role.toUpperCase() !== role.toUpperCase()) return null;

    if (role === 'STUDENT') return this.studentRepo.findByUsername(username);
    return { username: u.username, email: u.email, role: 'TEACHER' };
  }

  usernameExists(username) {
    return this.userRepo.existsByUsername(username);
  }

  signUp(username, password, email, role) {
    const hashed = this.hash(password);
    if (role === 'STUDENT') {
      const s = { username, passwordHash: hashed, email, role: 'STUDENT',
                  displayName: username, tutorialAvailability: '', major: '', unitsPassed: 0, teamId: null };
      this.userRepo.save(s);
      this.studentRepo.save(s);
      return s;
    } else {
      const t = { username, passwordHash: hashed, email, role: 'TEACHER' };
      this.userRepo.save(t);
      return t;
    }
  }
}

module.exports = AuthService;

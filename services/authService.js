const crypto = require('crypto');
const userRepo = require('../repositories/userRepository');
const studentRepo = require('../repositories/studentRepository');

function hash(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function login(username, password, role) {
  const u = userRepo.findByUsername(username);
  if (!u) return null;
  if (u.password_hash !== hash(password)) return null;
  if (u.role.toUpperCase() !== role.toUpperCase()) return null;

  if (role === 'STUDENT') return studentRepo.findByUsername(username);
  return { username: u.username, email: u.email, role: 'TEACHER' };
}

function usernameExists(username) {
  return userRepo.existsByUsername(username);
}

function signUp(username, password, email, role) {
  const hashed = hash(password);
  if (role === 'STUDENT') {
    const s = { username, passwordHash: hashed, email, role: 'STUDENT',
                displayName: username, tutorialAvailability: '', major: '', unitsPassed: 0, teamId: null };
    userRepo.save(s);
    studentRepo.save(s);
    return s;
  } else {
    const t = { username, passwordHash: hashed, email, role: 'TEACHER' };
    userRepo.save(t);
    return t;
  }
}

module.exports = { login, usernameExists, signUp, hash };

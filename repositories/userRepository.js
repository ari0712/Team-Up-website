const { all, get, run } = require('../db');

function findByUsername(username) {
  return get('SELECT username, password_hash, email, role FROM users WHERE username = ?', [username]);
}

function save(user) {
  run('INSERT INTO users (username, password_hash, email, role) VALUES (?,?,?,?)',
    [user.username, user.passwordHash, user.email, user.role]);
}

function existsByUsername(username) {
  return !!findByUsername(username);
}

function updateEmail(username, email) {
  run('UPDATE users SET email = ? WHERE username = ?', [email, username]);
}

module.exports = { findByUsername, save, existsByUsername, updateEmail };

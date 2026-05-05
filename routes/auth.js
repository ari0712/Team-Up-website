const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const { run } = require('../db');
const studentService = require('../services/studentService');

function sanitize(user) {
  if (!user) return null;
  const { passwordHash, password_hash, ...safe } = user;
  return safe;
}

router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.user.role === 'STUDENT') {
    const fresh = studentService.getStudent(req.session.user.username);
    if (fresh) req.session.user = fresh;
  }
  res.json(sanitize(req.session.user));
});

router.post('/login', (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role)
    return res.status(400).json({ error: 'username, password and role are required' });
  const user = authService.login(username, password, role);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.user = user;
  res.json(sanitize(user));
});

router.post('/signup', (req, res) => {
  const { username, email, password, confirmPassword, role, studentId } = req.body;
  if (!username || !email || !password || !role)
    return res.status(400).json({ error: 'All fields are required' });
  if (password !== confirmPassword)
    return res.status(400).json({ error: 'Passwords do not match' });
  if (authService.usernameExists(username))
    return res.status(409).json({ error: 'Username already taken' });
  const user = authService.signUp(username, password, email, role);
  // Store student_id for future use (students only)
  if (role === 'STUDENT' && studentId && studentId.trim()) {
    run(`UPDATE users SET student_id = ? WHERE username = ?`, [studentId.trim(), username]);
  }
  req.session.user = user;
  res.json(sanitize(user));
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

module.exports = router;

const express = require('express');

function sanitize(user) {
  if (!user) return null;
  const { passwordHash, password_hash, ...safe } = user;
  return safe;
}

function passwordError(password) {
  if (password.length < 8) return 'Password must be at least 8 characters long';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least 1 uppercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least 1 number';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must contain at least 1 special character';
  return null;
}

// Factory: receives its collaborators from the composition root (server.js).
module.exports = function createAuthRouter({ userRepo, authService, studentService }) {
  const router = express.Router();

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
    const pwError = passwordError(password);
    if (pwError)
      return res.status(400).json({ error: pwError });
    if (authService.usernameExists(username))
      return res.status(409).json({ error: 'Username already taken' });
    const user = authService.signUp(username, password, email, role);
    // Store student_id for future use (students only)
    if (role === 'STUDENT' && studentId && studentId.trim()) {
      userRepo.setStudentId(username, studentId.trim());
    }
    req.session.user = user;
    res.json(sanitize(user));
  });

  router.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ ok: true });
  });

  return router;
};

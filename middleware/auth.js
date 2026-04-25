function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function requireStudent(req, res, next) {
  if (!req.session || !req.session.user || req.session.user.role !== 'STUDENT') {
    return res.status(403).json({ error: 'Students only' });
  }
  next();
}

function requireTeacher(req, res, next) {
  if (!req.session || !req.session.user || req.session.user.role !== 'TEACHER') {
    return res.status(403).json({ error: 'Teachers only' });
  }
  next();
}

module.exports = { requireAuth, requireStudent, requireTeacher };

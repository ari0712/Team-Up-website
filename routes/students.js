const express = require('express');
const router = express.Router();
const studentService = require('../services/studentService');
const { requireStudent } = require('../middleware/auth');

function sanitize(user) {
  if (!user) return null;
  const { passwordHash, password_hash, ...safe } = user;
  return safe;
}

router.get('/', requireStudent, (req, res) => {
  const { name, tutorial, major, sort } = req.query;
  const students = studentService.getFilteredStudents(
    req.session.user.username, name || '', tutorial || '', major || '', sort || 'name'
  );
  res.json(students.map(sanitize));
});

router.post('/onboarding', requireStudent, (req, res) => {
  const { displayName, tutorialAvailability, major, unitsPassed } = req.body;
  if (!displayName || !tutorialAvailability || !major || unitsPassed === undefined)
    return res.status(400).json({ error: 'All fields are required' });

  const student = req.session.user;
  student.displayName = displayName;
  student.tutorialAvailability = Array.isArray(tutorialAvailability)
    ? tutorialAvailability.join(',') : tutorialAvailability;
  student.major = major;
  student.unitsPassed = parseInt(unitsPassed, 10) || 0;

  studentService.saveProfile(student);
  req.session.user = studentService.getStudent(student.username);
  res.json(sanitize(req.session.user));
});

router.put('/profile', requireStudent, (req, res) => {
  const { displayName, email, tutorialAvailability, major, unitsPassed } = req.body;
  if (!displayName || !email || !tutorialAvailability || !major || unitsPassed === undefined)
    return res.status(400).json({ error: 'All fields are required' });

  const student = req.session.user;
  student.displayName = displayName;
  student.email = email;
  student.tutorialAvailability = Array.isArray(tutorialAvailability)
    ? tutorialAvailability.join(',') : tutorialAvailability;
  student.major = major;
  student.unitsPassed = parseInt(unitsPassed, 10) || 0;

  studentService.saveProfile(student);
  studentService.updateEmail(student.username, email);
  req.session.user = studentService.getStudent(student.username);
  res.json(sanitize(req.session.user));
});

module.exports = router;

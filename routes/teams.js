const express = require('express');
const router = express.Router();
const teamService = require('../services/teamService');
const studentService = require('../services/studentService');
const { requireStudent, requireTeacher, requireAuth } = require('../middleware/auth');

router.get('/all', requireAuth, (req, res) => {
  res.json(teamService.getAllTeams());
});

router.get('/incomplete', requireTeacher, (req, res) => {
  res.json(teamService.getIncompleteTeams());
});

router.get('/current', requireStudent, (req, res) => {
  const team = teamService.getCurrentTeam(req.session.user.username);
  res.json(team || null);
});

router.post('/leave', requireStudent, (req, res) => {
  const student = studentService.getStudent(req.session.user.username);
  if (!student || !student.teamId)
    return res.status(400).json({ error: 'You are not in a team' });
  teamService.leaveTeam(student);
  req.session.user = studentService.getStudent(req.session.user.username);
  res.json({ ok: true });
});

module.exports = router;

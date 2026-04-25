const express = require('express');
const router = express.Router();
const inviteService = require('../services/inviteService');
const { requireStudent } = require('../middleware/auth');

router.get('/received', requireStudent, (req, res) => {
  res.json(inviteService.getInvitesForStudent(req.session.user.username));
});

router.get('/sent', requireStudent, (req, res) => {
  res.json(inviteService.getSentInvites(req.session.user.username));
});

router.post('/send', requireStudent, (req, res) => {
  const { receiverUsername } = req.body;
  const error = inviteService.sendInvite(req.session.user.username, receiverUsername);
  if (error) return res.status(400).json({ error });
  res.json({ ok: true });
});

router.get('/:id/check-accept', requireStudent, (req, res) => {
  const result = inviteService.checkAcceptInvite(req.params.id);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

router.post('/:id/accept', requireStudent, (req, res) => {
  inviteService.confirmAcceptInvite(req.params.id);
  // Refresh session
  const studentService = require('../services/studentService');
  req.session.user = studentService.getStudent(req.session.user.username);
  res.json({ ok: true });
});

router.post('/:id/reject', requireStudent, (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Rejection reason is required' });
  inviteService.rejectInvite(req.params.id, reason.trim());
  res.json({ ok: true });
});

module.exports = router;

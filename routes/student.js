const express = require('express');
const { requireStudent } = require('../middleware/auth');

// Factory: receives the StudentPortalService from the composition root.
module.exports = function createStudentRouter({ studentPortalService }) {
  const router = express.Router();
  const svc = studentPortalService;

  router.use(requireStudent);

  const sid = req => req.session.user.username;

  // Run a handler and translate any thrown ServiceError into an HTTP response.
  const send = (res, fn) => {
    try { return fn(); }
    catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('Student portal error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  };

  // ── Units & enrollment ──────────────────────────────────────────
  router.get('/units', (req, res) =>
    send(res, () => res.json(svc.listUnits(sid(req)))));

  router.post('/units/:unitId/join', (req, res) =>
    send(res, () => res.json(svc.joinUnit(req.params.unitId, sid(req)))));

  router.get('/units/:unitId', (req, res) =>
    send(res, () => res.json(svc.getUnitForEnrolled(req.params.unitId, sid(req)))));

  router.get('/units/:unitId/announcements', (req, res) =>
    send(res, () => res.json(svc.getAnnouncements(req.params.unitId, sid(req)))));

  // ── Progress ────────────────────────────────────────────────────
  router.get('/units/:unitId/progress', (req, res) =>
    send(res, () => res.json(svc.getProgress(req.params.unitId, sid(req)))));

  router.put('/units/:unitId/progress', (req, res) =>
    send(res, () => {
      const { stage, value } = req.body;
      svc.setProgressStage(req.params.unitId, sid(req), stage, value);
      res.json({ ok: true });
    }));

  // ── Preferences & tutorial slots ────────────────────────────────
  router.get('/units/:unitId/tutorial-slots', (req, res) =>
    send(res, () => res.json(svc.getTutorialSlots(req.params.unitId))));

  router.get('/units/:unitId/prefs', (req, res) =>
    send(res, () => res.json(svc.getPrefs(req.params.unitId, sid(req)))));

  router.post('/units/:unitId/prefs', (req, res) =>
    send(res, () => {
      svc.savePrefs(req.params.unitId, sid(req), req.body || {});
      res.json({ ok: true });
    }));

  // ── Classmates & teams ──────────────────────────────────────────
  router.get('/units/:unitId/students', (req, res) =>
    send(res, () => res.json(svc.searchClassmates(req.params.unitId, sid(req), req.query))));

  router.get('/units/:unitId/my-team', (req, res) =>
    send(res, () => res.json(svc.getMyTeam(req.params.unitId, sid(req)))));

  router.get('/units/:unitId/teams/:teamId', (req, res) =>
    send(res, () => res.json(svc.getTeamView(req.params.unitId, req.params.teamId))));

  // ── Proposals ───────────────────────────────────────────────────
  router.post('/units/:unitId/proposals', (req, res) =>
    send(res, () => res.json(svc.createProposal(req.params.unitId, sid(req), (req.body || {}).targetTeamId))));

  router.get('/units/:unitId/proposals', (req, res) =>
    send(res, () => res.json(svc.listProposals(req.params.unitId, sid(req)))));

  router.get('/units/:unitId/proposals/:id', (req, res) =>
    send(res, () => res.json(svc.getProposalDetail(req.params.unitId, req.params.id, sid(req)))));

  router.patch('/units/:unitId/proposals/:id/vote', (req, res) =>
    send(res, () => res.json(svc.castVote(req.params.id, sid(req), (req.body || {}).vote))));

  router.patch('/units/:unitId/proposals/:id/seen', (req, res) =>
    send(res, () => {
      svc.markProposalSeen(req.params.id, sid(req));
      res.json({ ok: true });
    }));

  // ── Notifications ───────────────────────────────────────────────
  // Both reads sync first, so the inbox and the nav badge are always current
  // without any event plumbing. Email is dispatched only on the timer.
  router.get('/units/:unitId/notifications', (req, res) =>
    send(res, () => res.json(svc.listNotifications(req.params.unitId, sid(req)))));

  router.get('/units/:unitId/notifications/count', (req, res) =>
    send(res, () => res.json(svc.unreadNotificationCount(req.params.unitId, sid(req)))));

  router.patch('/units/:unitId/notifications/:id/read', (req, res) =>
    send(res, () => res.json(
      svc.markNotificationRead(req.params.unitId, sid(req), parseInt(req.params.id)))));

  router.post('/units/:unitId/notifications/read-all', (req, res) =>
    send(res, () => res.json(svc.markAllNotificationsRead(req.params.unitId, sid(req)))));

  // ── Membership mutations ────────────────────────────────────────
  router.delete('/units/:unitId/teams/:teamId/members/:studentId', (req, res) =>
    send(res, () => {
      svc.kickMember(req.params.unitId, req.params.teamId, sid(req), req.params.studentId);
      res.json({ ok: true });
    }));

  router.delete('/units/:unitId/teams/:teamId/leave', (req, res) =>
    send(res, () => {
      svc.leaveTeam(req.params.unitId, req.params.teamId, sid(req));
      res.json({ ok: true });
    }));

  router.post('/units/:unitId/teams/:teamId/submit', (req, res) =>
    send(res, () => {
      svc.submitTeam(req.params.unitId, req.params.teamId);
      res.json({ ok: true });
    }));

  return router;
};

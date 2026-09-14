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
      if (e && e.status) return res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
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
    send(res, () => res.json(svc.getTutorialSlots(req.params.unitId, sid(req)))));

  router.get('/units/:unitId/prefs', (req, res) =>
    send(res, () => res.json(svc.getPrefs(req.params.unitId, sid(req)))));

  router.post('/units/:unitId/prefs', (req, res) =>
    send(res, () => {
      svc.savePrefs(req.params.unitId, sid(req), req.body || {});
      res.json({ ok: true });
    }));

  // ── Full profile (About Me + picture) ───────────────────────────
  // Fetched one student at a time rather than added to the class-list payload,
  // which is a whole-class fanout. Works for your own profile and a classmate's.
  router.get('/units/:unitId/students/:studentId/profile', (req, res) =>
    send(res, () => res.json(
      svc.getStudentProfile(req.params.unitId, sid(req), req.params.studentId))));

  router.post('/units/:unitId/profile', (req, res) =>
    send(res, () => res.json(svc.saveAbout(req.params.unitId, sid(req), req.body || {}))));

  // Not unit-scoped: the picture is a property of the person, not the enrolment.
  router.post('/avatar', (req, res) =>
    send(res, () => res.json(svc.saveAvatar(sid(req), (req.body || {}).dataUrl))));

  router.delete('/avatar', (req, res) =>
    send(res, () => res.json(svc.clearAvatar(sid(req)))));

  // ── Classmates & teams ──────────────────────────────────────────
  router.get('/units/:unitId/students', (req, res) =>
    send(res, () => res.json(svc.searchClassmates(req.params.unitId, sid(req), req.query))));

  // Ranked merge suggestions for the signed-in student. Recommends only.
  router.get('/units/:unitId/auto-match', (req, res) =>
    send(res, () => res.json(svc.autoMatch(req.params.unitId, sid(req)))));

  router.get('/units/:unitId/my-team', (req, res) =>
    send(res, () => res.json(svc.getMyTeam(req.params.unitId, sid(req)))));

  router.get('/units/:unitId/teams/:teamId', (req, res) =>
    send(res, () => res.json(svc.getTeamView(req.params.unitId, req.params.teamId, sid(req)))));

  // "I have no preferred teammates — place me anywhere." A declaration by a
  // solo student, not a group submission. DELETE withdraws it.
  router.post('/units/:unitId/no-preference', (req, res) =>
    send(res, () => res.json(svc.declareNoPreference(req.params.unitId, sid(req)))));

  router.delete('/units/:unitId/no-preference', (req, res) =>
    send(res, () => res.json(svc.withdrawNoPreference(req.params.unitId, sid(req)))));

  // ── Team-up requests ────────────────────────────────────────────
  // Sending one asks another team to join up; every member of both teams then
  // accepts or declines. Unanimous acceptance is the record — no further step.
  router.post('/units/:unitId/team-requests', (req, res) =>
    send(res, () => res.json(svc.sendRequest(req.params.unitId, sid(req), (req.body || {}).targetTeamId))));

  router.get('/units/:unitId/team-requests', (req, res) =>
    send(res, () => res.json(svc.listRequests(req.params.unitId, sid(req)))));

  router.get('/units/:unitId/team-requests/:id', (req, res) =>
    send(res, () => res.json(svc.getRequestDetail(req.params.unitId, req.params.id, sid(req)))));

  router.patch('/units/:unitId/team-requests/:id/respond', (req, res) =>
    send(res, () => res.json(svc.respondToRequest(req.params.id, sid(req), (req.body || {}).response))));

  router.patch('/units/:unitId/team-requests/:id/seen', (req, res) =>
    send(res, () => {
      svc.markRequestSeen(req.params.id, sid(req));
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

  // Which categories of event reach this student by email, for this unit.
  router.get('/units/:unitId/email-prefs', (req, res) =>
    send(res, () => res.json(svc.getEmailPrefs(req.params.unitId, sid(req)))));

  router.put('/units/:unitId/email-prefs', (req, res) =>
    send(res, () => res.json(svc.saveEmailPrefs(req.params.unitId, sid(req), req.body || {}))));

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

  return router;
};

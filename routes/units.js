const express = require('express');
const { requireTeacher, requireStudent } = require('../middleware/auth');

// Factory: receives the UnitService from the composition root.
module.exports = function createUnitsRouter({ unitService }) {
  const router = express.Router();
  const svc = unitService;

  const username = req => req.session.user.username;

  // Run a handler and translate any thrown ServiceError into an HTTP response.
  const send = (res, fn) => {
    try { return fn(); }
    catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('Unit service error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  };

  // ── Units ───────────────────────────────────────────────────────
  router.get('/', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.listUnits(username(req)))));

  router.get('/student/enrolled', requireStudent, (req, res) =>
    send(res, () => res.json(svc.listEnrolledUnits(username(req)))));

  router.get('/:unitId', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.getUnit(req.params.unitId, username(req)))));

  router.post('/', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.createUnit(username(req), req.body))));

  // ── Progress ────────────────────────────────────────────────────
  router.get('/:unitId/progress', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.getProgress(req.params.unitId, username(req)))));

  router.put('/:unitId/progress/:studentId', requireTeacher, (req, res) =>
    send(res, () => {
      const { stage, value } = req.body;
      svc.setStudentStage(req.params.unitId, req.params.studentId, stage, value);
      res.json({ ok: true });
    }));

  // ── Team requests / review ──────────────────────────────────────
  router.get('/:unitId/team-requests', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.getTeamRequests(req.params.unitId, username(req)))));

  router.post('/:unitId/team-requests/approve-all', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.approveAll(req.params.unitId, username(req)))));

  router.put('/:unitId/team-requests/:teamId', requireTeacher, (req, res) =>
    send(res, () => res.json(
      svc.reviewTeam(req.params.unitId, username(req), req.params.teamId, (req.body || {}).action))));

  // ── Teams & class list ──────────────────────────────────────────
  router.get('/:unitId/all-teams', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.getAllTeams(req.params.unitId, username(req)))));

  router.get('/:unitId/class-list', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.getClassList(req.params.unitId, username(req)))));

  // ── Announcements ───────────────────────────────────────────────
  router.get('/:unitId/announcements', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.getAnnouncements(req.params.unitId, username(req)))));

  router.post('/:unitId/announcements', requireTeacher, (req, res) =>
    send(res, () => {
      const { title, content } = req.body || {};
      res.json(svc.postAnnouncement(req.params.unitId, username(req), title, content));
    }));

  // ── Rules ───────────────────────────────────────────────────────
  router.put('/:unitId/rules', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.updateRules(req.params.unitId, username(req), req.body || {}))));

  // ── Tutorial slots ──────────────────────────────────────────────
  router.get('/:unitId/tutorial-slots', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.listTutorialSlots(req.params.unitId, username(req)))));

  router.post('/:unitId/tutorial-slots', requireTeacher, (req, res) =>
    send(res, () => res.json(
      svc.createTutorialSlot(req.params.unitId, username(req), (req.body || {}).label))));

  router.put('/:unitId/tutorial-slots/:slotId', requireTeacher, (req, res) =>
    send(res, () => res.json(
      svc.renameTutorialSlot(req.params.unitId, username(req), req.params.slotId, (req.body || {}).label))));

  router.delete('/:unitId/tutorial-slots/:slotId', requireTeacher, (req, res) =>
    send(res, () => res.json(
      svc.deleteTutorialSlot(req.params.unitId, username(req), req.params.slotId))));

  return router;
};

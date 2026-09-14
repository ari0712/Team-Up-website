const express = require('express');
const { requireTeacher, requireStudent } = require('../middleware/auth');

// Factory: receives the UnitService from the composition root.
module.exports = function createUnitsRouter({ unitService, matchingService }) {
  const router = express.Router();
  const svc = unitService;

  const username = req => req.session.user.username;

  // Run a handler and translate any thrown ServiceError into an HTTP response.
  const send = (res, fn) => {
    try { return fn(); }
    catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
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

  // Read-only preview of what deleting this unit would remove.
  router.get('/:unitId/delete-impact', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.getDeleteImpact(req.params.unitId, username(req)))));

  router.delete('/:unitId', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.deleteUnit(req.params.unitId, username(req)))));

  // ── Progress ────────────────────────────────────────────────────
  router.get('/:unitId/progress', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.getProgress(req.params.unitId, username(req)))));

  router.put('/:unitId/progress/:studentId', requireTeacher, (req, res) =>
    send(res, () => {
      const { stage, value } = req.body;
      svc.setStudentStage(req.params.unitId, username(req), req.params.studentId, stage, value);
      res.json({ ok: true });
    }));

  // ── Coordinator override (exception path, never a required step) ──
  router.put('/:unitId/teams/:teamId/override', requireTeacher, (req, res) =>
    send(res, () => res.json(
      svc.overrideTeam(req.params.unitId, username(req), req.params.teamId, (req.body || {}).action))));

  router.get('/:unitId/finalise-batches', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.listFinaliseBatches(req.params.unitId, username(req)))));

  router.post('/:unitId/finalise-batches/:batchId/revert', requireTeacher, (req, res) =>
    send(res, () => res.json(
      svc.revertFinaliseBatch(req.params.unitId, username(req), req.params.batchId))));

  // What a proposed rules change would do to existing groups. Read-only; the
  // rules modal calls it as the coordinator edits.
  router.get('/:unitId/rules/impact', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.previewRulesImpact(req.params.unitId, username(req), req.query || {}))));

  // ── Teams & class list ──────────────────────────────────────────
  router.get('/:unitId/all-teams', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.getAllTeams(req.params.unitId, username(req)))));

  router.get('/:unitId/class-list', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.getClassList(req.params.unitId, username(req)))));

  // The coordinator's report, as rows. The page renders and downloads exactly
  // what this returns.
  router.get('/:unitId/export', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.buildExport(req.params.unitId, username(req)))));

  // ── Announcements ───────────────────────────────────────────────
  router.get('/:unitId/announcements', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.getAnnouncements(req.params.unitId, username(req)))));

  router.post('/:unitId/announcements', requireTeacher, (req, res) =>
    send(res, () => {
      const { title, content } = req.body || {};
      res.json(svc.postAnnouncement(req.params.unitId, username(req), title, content));
    }));

  // ── Organiser (only once the deadline has locked formation) ──
  router.get('/:unitId/suggestions', requireTeacher, (req, res) =>
    send(res, () => res.json(matchingService.suggest(req.params.unitId, username(req)))));

  // Finalises a grouping as one revertible batch.
  router.post('/:unitId/finalise-teams', requireTeacher, (req, res) =>
    send(res, () => res.json(
      svc.finaliseTeams(req.params.unitId, username(req), (req.body || {}).teams))));

  // ── Roster (who may join) ───────────────────────────────────────
  router.get('/:unitId/roster', requireTeacher, (req, res) =>
    send(res, () => res.json(svc.getRoster(req.params.unitId, username(req)))));

  router.post('/:unitId/roster', requireTeacher, (req, res) =>
    send(res, () => res.json(
      svc.importRoster(req.params.unitId, username(req), (req.body || {}).students))));

  router.delete('/:unitId/roster', requireTeacher, (req, res) =>
    send(res, () => res.json(
      svc.removeFromRoster(req.params.unitId, username(req), (req.body || {}).email))));

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

  // ?dryRun=1 answers "which groups would this break?" without deleting.
  router.delete('/:unitId/tutorial-slots/:slotId', requireTeacher, (req, res) =>
    send(res, () => res.json(
      svc.deleteTutorialSlot(req.params.unitId, username(req), req.params.slotId,
        { dryRun: String(req.query.dryRun || '') === '1' }))));

  return router;
};

const express = require('express');
const { requireTeacher } = require('../middleware/auth');

// Factory: the teacher notification inbox and per-user email preferences.
//
// Mounted at /api/teacher, alongside the student portal's /api/student. It sits
// apart from routes/units.js because the preference routes are not unit-scoped.
module.exports = function createTeacherNotificationsRouter({ notificationService, unitRepo }) {
  const router = express.Router();

  router.use(requireTeacher);

  const tid = req => req.session.user.username;

  // Run a handler and translate any thrown ServiceError into an HTTP response.
  const send = (res, fn) => {
    try { return fn(); }
    catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('Teacher notification error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  };

  // requireTeacher only proves the caller is A teacher — not that they own THIS
  // unit. Without this, any teacher could read any other teacher's inbox by
  // changing the unitId in the URL. 404 rather than 403: a teacher has no
  // business learning which unit ids exist on someone else's account.
  const ownedUnit = (unitId, teacherId) => {
    const unit = unitRepo.findOwned(unitId, teacherId);
    if (!unit) {
      const err = new Error('Unit not found');
      err.status = 404;
      throw err;
    }
    return unit;
  };

  // ── Inbox ───────────────────────────────────────────────────────
  router.get('/units/:unitId/notifications', (req, res) =>
    send(res, () => {
      ownedUnit(req.params.unitId, tid(req));
      res.json(notificationService.listForTeacher(req.params.unitId, tid(req)));
    }));

  router.get('/units/:unitId/notifications/count', (req, res) =>
    send(res, () => {
      ownedUnit(req.params.unitId, tid(req));
      res.json(notificationService.unreadCountForTeacher(req.params.unitId, tid(req)));
    }));

  router.patch('/units/:unitId/notifications/:id/read', (req, res) =>
    send(res, () => {
      ownedUnit(req.params.unitId, tid(req));
      // markRead is already scoped by username, so a teacher cannot mark a row
      // that is not theirs even if they guess an id.
      res.json(notificationService.markRead(req.params.unitId, tid(req), req.params.id));
    }));

  router.post('/units/:unitId/notifications/read-all', (req, res) =>
    send(res, () => {
      ownedUnit(req.params.unitId, tid(req));
      res.json(notificationService.markAllReadForTeacher(req.params.unitId, tid(req)));
    }));

  // ── Email preferences (not unit-scoped) ─────────────────────────
  router.get('/notification-prefs', (req, res) =>
    send(res, () => res.json(notificationService.getPrefs(tid(req)))));

  router.put('/notification-prefs', (req, res) =>
    send(res, () => res.json(notificationService.savePrefs(tid(req), req.body || {}))));

  return router;
};

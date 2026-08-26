const express = require('express');
const { requireAuth } = require('../middleware/auth');

// Factory: the per-unit discussion board.
//
// Guarded by requireAuth rather than requireStudent/requireTeacher, because this
// is the one surface both roles use. What the caller is allowed to do inside a
// unit is decided by ForumService._access from req.session.user — mounting two
// copies of these routes under /api/student and /api/units would mean two places
// for that rule to drift apart.
module.exports = function createForumRouter({ forumService }) {
  const router = express.Router();
  const svc = forumService;

  router.use(requireAuth);

  const me = req => req.session.user;

  // Run a handler and translate any thrown ServiceError into an HTTP response.
  const send = (res, fn) => {
    try { return fn(); }
    catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: e.message });
      console.error('Forum error:', e);
      return res.status(500).json({ error: 'Internal error' });
    }
  };

  // ── Threads ─────────────────────────────────────────────────────
  router.get('/units/:unitId/threads', (req, res) =>
    send(res, () => res.json(svc.listThreads(req.params.unitId, me(req)))));

  router.post('/units/:unitId/threads', (req, res) =>
    send(res, () => res.json(svc.createThread(req.params.unitId, me(req), req.body || {}))));

  router.get('/units/:unitId/threads/:threadId', (req, res) =>
    send(res, () => res.json(
      svc.getThread(req.params.unitId, parseInt(req.params.threadId), me(req)))));

  router.delete('/units/:unitId/threads/:threadId', (req, res) =>
    send(res, () => res.json(
      svc.deleteThread(req.params.unitId, parseInt(req.params.threadId), me(req)))));

  // Teacher-only; the service is what enforces that, not the route.
  router.patch('/units/:unitId/threads/:threadId/pin', (req, res) =>
    send(res, () => res.json(svc.setPinned(
      req.params.unitId, parseInt(req.params.threadId), me(req), !!(req.body || {}).pinned))));

  // ── Replies ─────────────────────────────────────────────────────
  router.post('/units/:unitId/threads/:threadId/replies', (req, res) =>
    send(res, () => res.json(svc.createReply(
      req.params.unitId, parseInt(req.params.threadId), me(req), req.body || {}))));

  // Not nested under its thread: a reply id is unique on its own, and the unit
  // scope — which is the part that matters for access — is already in the path.
  router.delete('/units/:unitId/replies/:replyId', (req, res) =>
    send(res, () => res.json(
      svc.deleteReply(req.params.unitId, parseInt(req.params.replyId), me(req)))));

  return router;
};

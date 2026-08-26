const ServiceError = require('./ServiceError');

const TITLE_MAX = 200;
const BODY_MAX  = 4000;

// The unit's public discussion board.
//
// This is the only service both roles call, which is why the access rule lives
// in one place here rather than being split across the student and teacher
// routers. Everything else in the app answers "may this student see this unit?"
// or "does this teacher own this unit?"; the forum has to answer both, and give
// the same board back either way.
class ForumService {
  constructor({ forum, units, enrollment }) {
    this.forum = forum;
    this.units = units;
    this.enrollment = enrollment;
  }

  // Resolves what this caller may do in this unit, or throws.
  //
  // The two failures are deliberately different: a student who is not enrolled
  // gets 403 NOT_JOINED, the code every student page already knows how to handle;
  // a teacher reaching for a unit they do not own gets 404, because — as
  // routes/teacherNotifications.js explains — unit ids must not be enumerable
  // from another teacher's account.
  _access(unitId, user) {
    if (!user) throw new ServiceError('Not authenticated', 401);

    if (user.role === 'TEACHER') {
      if (!this.units.findOwned(unitId, user.username))
        throw new ServiceError('Unit not found', 404);
      return { username: user.username, role: 'TEACHER', canModerate: true };
    }

    if (!this.enrollment.isEnrolled(unitId, user.username))
      throw new ServiceError('NOT_JOINED', 403);
    return { username: user.username, role: 'STUDENT', canModerate: false };
  }

  _text(value, max, label, { required }) {
    const text = String(value ?? '').trim();
    if (required && !text) throw new ServiceError(`${label} is required`, 400);
    if (text.length > max)
      throw new ServiceError(`${label} must be ${max} characters or fewer`, 400);
    return text;
  }

  // `me` and `canModerate` travel with the board so the page can decide which
  // controls to draw without re-deriving the permission rule client-side. The
  // server still checks on every mutation — hiding a button is presentation.
  listThreads(unitId, user) {
    const access = this._access(unitId, user);
    return {
      me: access.username,
      canModerate: access.canModerate,
      threads: this.forum.listThreads(unitId)
    };
  }

  getThread(unitId, threadId, user) {
    const access = this._access(unitId, user);
    const thread = this.forum.findThread(unitId, threadId);
    if (!thread) throw new ServiceError('Thread not found', 404);
    return {
      me: access.username,
      canModerate: access.canModerate,
      thread,
      replies: this.forum.listReplies(unitId, threadId)
    };
  }

  createThread(unitId, user, { title, body } = {}) {
    const access = this._access(unitId, user);
    const id = this.forum.createThread({
      unitId,
      authorUsername: access.username,
      authorRole: access.role,
      title: this._text(title, TITLE_MAX, 'Title', { required: true }),
      body:  this._text(body,  BODY_MAX,  'Message', { required: true }),
      createdAt: new Date().toISOString()
    });
    return { ok: true, id };
  }

  createReply(unitId, threadId, user, { body } = {}) {
    const access = this._access(unitId, user);
    if (!this.forum.findThread(unitId, threadId))
      throw new ServiceError('Thread not found', 404);

    const id = this.forum.createReply({
      unitId,
      threadId,
      authorUsername: access.username,
      authorRole: access.role,
      body: this._text(body, BODY_MAX, 'Reply', { required: true }),
      createdAt: new Date().toISOString()
    });
    return { ok: true, id };
  }

  // A teacher may remove anything on their unit's board; everyone else may
  // remove only what they wrote.
  _mayDelete(access, row) {
    if (access.canModerate) return;
    if (row.author_username !== access.username)
      throw new ServiceError('You can only delete your own posts', 403);
  }

  deleteThread(unitId, threadId, user) {
    const access = this._access(unitId, user);
    const thread = this.forum.findThread(unitId, threadId);
    if (!thread) throw new ServiceError('Thread not found', 404);
    this._mayDelete(access, thread);
    this.forum.deleteThread(unitId, threadId);
    return { ok: true };
  }

  deleteReply(unitId, replyId, user) {
    const access = this._access(unitId, user);
    const reply = this.forum.findReply(unitId, replyId);
    if (!reply) throw new ServiceError('Reply not found', 404);
    this._mayDelete(access, reply);
    this.forum.deleteReply(unitId, replyId);
    return { ok: true };
  }

  setPinned(unitId, threadId, user, pinned) {
    const access = this._access(unitId, user);
    if (!access.canModerate)
      throw new ServiceError('Only the unit teacher can pin threads', 403);
    if (!this.forum.findThread(unitId, threadId))
      throw new ServiceError('Thread not found', 404);
    this.forum.setPinned(unitId, threadId, pinned);
    return { ok: true, pinned: pinned ? 1 : 0 };
  }
}

module.exports = ForumService;
module.exports.TITLE_MAX = TITLE_MAX;
module.exports.BODY_MAX  = BODY_MAX;

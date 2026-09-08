const ServiceError = require('./ServiceError');
const { isLocked } = require('../utils/deadline');

const TITLE_MAX = 200;
const BODY_MAX  = 4000;
const KINDS     = ['DISCUSSION', 'RECRUITING'];

// The unit's public discussion board.
//
// This is the only service both roles call, which is why the access rule lives
// in one place here rather than being split across the student and teacher
// routers. Everything else in the app answers "may this student see this unit?"
// or "does this teacher own this unit?"; the forum has to answer both, and give
// the same board back either way.
//
// Since recruiting threads it answers a third question — "could this viewer ask
// to join that poster's team?" — and it answers it by asking ProposalService,
// never by re-deriving the merge rules here. See _recruiting.
class ForumService {
  constructor({ forum, units, enrollment, teams, proposals }) {
    this.forum = forum;
    this.units = units;
    this.enrollment = enrollment;
    this.teams = teams;
    this.proposals = proposals;
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

  // A teacher has no team, so a "looking for teammates" post from one would point
  // at nothing. Rejecting it here removes the whole class of edge cases that a
  // teamless recruiting thread would otherwise create downstream.
  _kind(value, access) {
    const kind = String(value || 'DISCUSSION').toUpperCase();
    if (!KINDS.includes(kind))
      throw new ServiceError('Unknown thread kind', 400);
    if (kind === 'RECRUITING' && access.role !== 'STUDENT')
      throw new ServiceError('Only students can post a looking-for-teammates thread', 400);
    return kind;
  }

  // The viewer's own situation, resolved once per request and shared by every
  // recruiting card on the board rather than re-read per card.
  //
  // maxSize comes from ProposalService rather than being parsed from the unit
  // here, so the number shown as "spots left" is literally the number
  // createProposal enforces.
  _viewerCtx(unitId, access) {
    const unit = this.units.findById(unitId);
    const ctx = {
      maxSize:    this.proposals.getMaxTeamSize(unitId),
      validSizes: unit ? unit.valid_team_sizes || '' : '',
      locked:     isLocked(unit),
      myTeamId:   null,
      mySize:     0
    };
    if (access.role === 'STUDENT') {
      const mine = this.teams.findStudentTeam(unitId, access.username);
      if (mine) {
        ctx.myTeamId = mine.team_id;
        ctx.mySize   = this.teams.getAcceptedMembersBasic(unitId, mine.team_id).length;
      }
    }
    return ctx;
  }

  // Everything a recruiting card shows, derived at read time.
  //
  // Nothing here is stored on the thread — not the team, not its size, not
  // whether it has room. An approved merge deletes one of the two team rows
  // outright, so any of it written onto the post would be wrong by the next
  // merge. The cost is a few indexed reads per recruiting thread: the same trade
  // the reply-count subquery already makes.
  _recruiting(unitId, thread, access, ctx) {
    if (thread.kind !== 'RECRUITING') return null;

    const theirs = this.teams.findStudentTeam(unitId, thread.author_username);
    const team   = theirs ? this.teams.findSummaryInUnit(theirs.team_id, unitId) : null;

    // The author has left the unit. The post stays — the conversation on it may
    // still be worth reading — but there is no longer a team to ask to join.
    if (!team) return { gone: true };

    const members = this.teams.getAcceptedMembersBasic(unitId, team.team_id);
    const out = {
      gone:        false,
      team_id:     team.team_id,
      team_name:   team.team_name,
      status:      team.status,
      size:        members.length,
      max_size:    ctx.maxSize,
      spots_left:  Math.max(0, ctx.maxSize - members.length),
      members:     members.map(m => ({ student_id: m.student_id, name: m.name, role: m.role })),
      can_request: false,
      why_not:     null
    };

    // A teacher has no team, so there is no request to make on their behalf. They
    // see who is on it, not a dead button with an excuse underneath.
    if (access.role !== 'STUDENT') return out;
    if (ctx.locked)    { out.why_not = 'Team formation has closed for this unit.'; return out; }
    if (!ctx.myTeamId) { out.why_not = 'You are not on a team in this unit yet.';  return out; }

    const check = this.proposals.checkProposal({
      unitId,
      sourceTeamId: ctx.myTeamId,
      targetTeamId: team.team_id,
      initiatorId:  access.username
    });
    out.can_request = check.ok;
    if (!check.ok) out.why_not = this._whyNot(check, out, ctx);
    return out;
  }

  // checkProposal's messages are written for an API error; these are written for
  // a card. Switching on the code rather than on the text is what stops the two
  // drifting apart when a guard's wording changes.
  _whyNot(check, team, ctx) {
    switch (check.code) {
      case 'SELF':        return 'This is your own team.';
      case 'NOT_FORMING': return 'That team has already submitted.';
      case 'TOO_BIG':     return `Your team of ${ctx.mySize} plus their ${team.size} `
                               + `is over the limit of ${check.max}.`;
      case 'DUPLICATE':   return 'You already have a request open with this team.';
      default:            return check.reason;
    }
  }

  // `me` and `canModerate` travel with the board so the page can decide which
  // controls to draw without re-deriving the permission rule client-side. The
  // server still checks on every mutation — hiding a button is presentation.
  listThreads(unitId, user) {
    const access = this._access(unitId, user);
    const ctx = this._viewerCtx(unitId, access);
    return {
      me: access.username,
      role: access.role,                // decides which tabs the board draws
      canModerate: access.canModerate,
      valid_team_sizes: ctx.validSizes, // one copy for the board, not one per card
      threads: this.forum.listThreads(unitId).map(t =>
        t.kind === 'RECRUITING'
          ? { ...t, recruiting: this._recruiting(unitId, t, access, ctx) }
          : t)
    };
  }

  getThread(unitId, threadId, user) {
    const access = this._access(unitId, user);
    const thread = this.forum.findThread(unitId, threadId);
    if (!thread) throw new ServiceError('Thread not found', 404);
    const ctx = this._viewerCtx(unitId, access);
    return {
      me: access.username,
      role: access.role,
      canModerate: access.canModerate,
      valid_team_sizes: ctx.validSizes,
      thread: { ...thread, recruiting: this._recruiting(unitId, thread, access, ctx) },
      replies: this.forum.listReplies(unitId, threadId)
    };
  }

  createThread(unitId, user, { title, body, kind } = {}) {
    const access = this._access(unitId, user);
    const id = this.forum.createThread({
      unitId,
      authorUsername: access.username,
      authorRole: access.role,
      title: this._text(title, TITLE_MAX, 'Title', { required: true }),
      body:  this._text(body,  BODY_MAX,  'Message', { required: true }),
      kind:  this._kind(kind, access),
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

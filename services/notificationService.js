// =============================================================================
// NotificationService — notification inboxes and email dispatch.
//
// DESIGN: idempotent producers, not event hooks.
//
// `syncForUnit` (students) and `syncTeacherForUnit` (teachers) DERIVE
// notifications from current state and insert them with INSERT OR IGNORE
// against the UNIQUE (student_id, dedupe_key) index. Nothing else in the app
// has to know notifications exist — proposalService, unitService and the
// team-submit paths are untouched, and none of this has to be threaded through
// their transactions.
//
// Because they are idempotent they can safely run on every read (so the UI is
// fresh) and on a timer (so email goes out to people who aren't in the app).
//
// The dedupe_key encodes the EVENT, not just the entity:
//   proposal:<id>:open              a request is waiting on you
//   proposal:<id>:<state>           that request resolved
//   team:<id>:<status>:<timestamp>  timestamp lets a re-submit notify again
//   deadline:<unit>:<bucket>        7d / 3d / 1d / due
// Teacher keys carry a `teacher:` prefix. They cannot collide with student keys
// anyway — dedupe is scoped per-username and a teacher is a different user —
// but the prefix keeps the table readable when debugging.
// =============================================================================

const ServiceError = require('./ServiceError');
const { isDeliverable } = require('./email/transport');
const { placementOf } = require('../utils/placement');
const { SEVERITIES } = require('../repositories/notificationPrefsRepository');
const { categoryOf, CATEGORY_LABELS } = require('../utils/emailCategories');

// ── Email volume bounds ──────────────────────────────────────────────────────
// One email per event per student is guaranteed by `notifications.emailed_at`
// (stamped before the send). On top of that, no recipient gets more than this
// many messages in a rolling day; anything past it is dropped, not deferred —
// a "request received" email a day late is worse than none, and the in-app
// inbox still has the row. Category defaults keep the 400-student cases
// (deadline buckets) opt-in, so this is a backstop.
const EMAIL_DAILY_CAP = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

// How close to lapsing a request is before its pending voters are warned.
const EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;

function nowIso() { return new Date().toISOString(); }

// A recipient's first sync backfills existing history as already-read and
// already-emailed. Without it, turning the feature on would show everyone a
// badge full of old events and send a backlog of email. A student who
// joins later gets the same treatment, which is correct — they should not be
// notified about things that happened before they arrived.
const SEED_TYPE = 'seed';

// Shared by both producers so the two can never disagree about when a deadline
// becomes urgent. Returns [bucketKey, title, body] or null.
function deadlineBucket(deadline, audience) {
  if (!deadline) return null;
  const ms = Date.parse(deadline) - Date.now();
  if (isNaN(ms)) return null;

  const forTeacher = audience === 'TEACHER';
  if (ms <= 0) {
    return ['due', 'Deadline passed',
      forTeacher ? 'The team formation deadline for this unit has passed.'
                 : 'The team formation deadline has passed.'];
  }
  const days = ms / 86400000;
  if (days <= 1) {
    return ['1d', 'Deadline tomorrow',
      forTeacher ? 'This unit\'s team formation deadline is less than a day away.'
                 : 'The team formation deadline is less than a day away.'];
  }
  if (days <= 3) {
    return ['3d', 'Deadline in 3 days',
      forTeacher ? 'This unit\'s team formation deadline is approaching.'
                 : 'The team formation deadline is approaching.'];
  }
  if (days <= 7) {
    return ['7d', 'Deadline in a week',
      forTeacher ? 'This unit\'s team formation deadline is a week away.'
                 : 'The team formation deadline is a week away.'];
  }
  return null;
}

// A passed deadline is the only thing either audience must not miss.
const deadlineSeverity = bucket => (bucket === 'due' ? 'CRITICAL' : 'WARNING');

// ── "Needs attention" ─────────────────────────────────────────────────────────
// Driven by placement (utils/placement.js), the same categorisation the class
// list and the export use, so the three can never disagree about who is at
// risk. Exactly one thing needs the coordinator's attention:
//
//   SILENT   alone and nothing recorded — chase these.
//
// GROUPED students recorded themselves (an accepted team-up request is the
// record); DECLARED students asked to be placed anywhere. Neither is chased.
//
// Volume is bounded per unit whatever the class size: SILENT students are one
// summary line, and the class list, pre-filtered, carries the names.

// At-risk reporting stays silent until the deadline is close enough that the
// teacher wants to know. How close is per-unit (`units.at_risk_days`), chosen
// from AT_RISK_CHOICES; 0 disables the Students at Risk category entirely.
//
// 7 is the largest offered because the deadline buckets only exist inside a
// week — the summary's dedupe key is bucket-based, so a longer window would
// have nothing to key on.
const AT_RISK_CHOICES = [0, 1, 3, 5, 7];
const AT_RISK_DEFAULT = 3;

function atRiskDaysFor(unit) {
  const raw = unit.at_risk_days;
  // A unit predating the column, or carrying a value no longer offered, falls
  // back to the default rather than silently disabling itself.
  if (raw === null || raw === undefined) return AT_RISK_DEFAULT;
  const n = parseInt(raw);
  return AT_RISK_CHOICES.includes(n) ? n : AT_RISK_DEFAULT;
}

// Whole and fractional days until the deadline; negative once it has passed,
// null when there is no usable deadline.
function daysUntilDeadline(deadline) {
  if (!deadline) return null;
  const ms = Date.parse(deadline) - Date.now();
  return isNaN(ms) ? null : ms / 86400000;
}

class NotificationService {
  constructor({ db, notifications, prefs, outbox, units, enrollment, teams,
                userRepo, transport, emailPrefs = null, env = process.env }) {
    this.db = db;
    this.env = env;
    this.emailPrefs = emailPrefs;
    this.notifications = notifications;
    this.prefs = prefs;
    this.outbox = outbox;
    this.units = units;
    this.enrollment = enrollment;
    this.teams = teams;
    this.userRepo = userRepo;
    this.transport = transport;
  }

  // ── Producer ────────────────────────────────────────────────────────────────
  syncForUnit(unitId) {
    const unit = this.units.findById(unitId);
    if (!unit) return 0;

    const students = this.enrollment.listWithProgress(unitId);
    if (!students.length) return 0;

    const now = nowIso();
    const link = page => `/student/${page}.html?unitId=${unitId}`;

    // The backfill line for each student: the moment they joined the unit
    // (seedStudent is called from joinUnit). Events that happened BEFORE it —
    // a request that expired last month — are inserted already read and
    // already emailed; anything from that moment on is fresh. A student
    // without a sentinel (joined before seeding existed) is seeded now, so a
    // backlog is never mailed to them either.
    const seededAt = new Map(this.notifications.listSeedTimes(unitId).map(r => [r.student_id, r.created_at]));
    for (const s of students) {
      if (seededAt.has(s.student_id)) continue;
      this.seedStudent(unitId, s.student_id, now);
      seededAt.set(s.student_id, now);
    }

    const add = (studentId, n) => {
      const createdAt = n.createdAt || now;
      const backfill = Date.parse(createdAt) < Date.parse(seededAt.get(studentId) || now);
      this.notifications.insertIgnore({
        unitId, studentId, recipientRole: 'STUDENT',
        type: n.type, severity: n.severity || 'INFO',
        title: n.title, body: n.body || '', link: n.link || '',
        dedupeKey: n.dedupeKey,
        createdAt,
        readAt:    backfill ? now : null,
        emailedAt: backfill ? now : null
      });
    };

    // ── Team-up requests ──
    this._produceRequests(unitId, add, link, now);

    // ── Coordinator overrides ──
    // The only team-status events a student can receive: the coordinator
    // finalised their team, or reopened it. Keyed on the stamps, so a team
    // finalised, reopened and finalised again notifies each time.
    for (const t of this.teams.listAllWithCounts(unitId)) {
      const members = this.teams.getMembers(t.team_id).map(m => m.student_id);
      const emit = (key, title, body, severity, at) => members.forEach(sid =>
        add(sid, { type: 'team_status', severity, title, body, link: link('my-team'),
                   dedupeKey: key, createdAt: at || now }));

      if (t.status === 'FINALISED' && t.finalised_at) {
        emit(`team:${t.team_id}:FINALISED:${t.finalised_at}`,
             'Your team has been finalised',
             `${t.team_name} has been finalised by your coordinator. Membership can no longer change.`,
             'INFO', t.finalised_at);
      }
      if (t.status === 'OPEN' && t.reopened_at) {
        emit(`team:${t.team_id}:REOPENED:${t.reopened_at}`,
             'Your coordinator reopened your team',
             `${t.team_name} was reopened by your coordinator. Check My Team for what changed.`,
             'WARNING', t.reopened_at);
      }
    }

    // ── Deadline approaching ──
    const bucket = deadlineBucket(unit.deadline, 'STUDENT');
    if (bucket) {
      for (const s of students) {
        add(s.student_id, {
          type: 'deadline', severity: deadlineSeverity(bucket[0]),
          title: bucket[1], body: bucket[2],
          link: link('dashboard'), dedupeKey: `deadline:${unitId}:${bucket[0]}`
        });
      }
    }

    return students.length;
  }

  // The team-up request rows for a unit — or for ONE request when
  // `onlyProposalId` is given, which is what sendRequest uses to produce the
  // recipient's "new request" (and any expiry warning) immediately without
  // walking every student in the unit.
  _produceRequests(unitId, add, link, now, onlyProposalId = null) {
    const proposalRows = this.db.all(
      `SELECT p.proposal_id, p.state, p.initiator_id, p.created_at, p.resolved_at,
              p.invalidated_reason, p.expires_at,
              ts.team_name AS source_team_name, tt.team_name AS target_team_name,
              pv.student_id, pv.vote
         FROM proposals p
         INNER JOIN proposal_votes pv ON pv.proposal_id = p.proposal_id
         LEFT JOIN unit_teams ts ON ts.team_id = p.source_team_id
         LEFT JOIN unit_teams tt ON tt.team_id = p.target_team_id
        WHERE p.unit_id = ?${onlyProposalId ? ' AND p.proposal_id = ?' : ''}`,
      onlyProposalId ? [unitId, onlyProposalId] : [unitId]
    );
    for (const r of proposalRows) {
      const otherTeam = r.source_team_name || r.target_team_name || 'Another team';
      if (r.state === 'open') {
        if (r.vote === 'pending' && r.student_id !== r.initiator_id) {
          add(r.student_id, {
            type: 'team_request',
            title: 'New team-up request',
            body: `${otherTeam} wants to team up with your group. Accept or decline before it expires.`,
            link: link('dashboard'),
            dedupeKey: `proposal:${r.proposal_id}:open`,
            createdAt: r.created_at || now
          });
          // About to lapse: warn everyone who still has not answered. Once per
          // request (no bucket in the key). Produced on the timer AND by
          // sendRequest right after creation, so a request born with less than
          // a day of runway is warned immediately, not a minute later.
          const msLeft = Date.parse(r.expires_at) - Date.now();
          if (!isNaN(msLeft) && msLeft > 0 && msLeft <= EXPIRY_WARNING_MS) {
            const hours = Math.max(1, Math.round(msLeft / 3600000));
            add(r.student_id, {
              type: 'team_request', severity: 'WARNING',
              title: `A team-up request expires in ${hours} hour${hours === 1 ? '' : 's'}`,
              body: `${otherTeam} asked to team up with your group and nobody has answered yet. ` +
                    `It will be declined automatically when it expires.`,
              link: link('dashboard'),
              dedupeKey: `proposal:${r.proposal_id}:expiring`
            });
          }
        }
        continue;
      }
      const resolved = {
        approved:       ['Request accepted — you\'re now one group', 'Everyone accepted a team-up request. Your group is recorded; nothing more to do.'],
        rejected:       ['Request declined', 'A team-up request was declined.'],
        expired:        ['Request expired', 'A team-up request expired because not everyone responded in time.'],
        auto_cancelled: ['Request withdrawn', 'A team-up request was withdrawn because another team-up completed first.'],
        invalidated:    ['Request no longer valid',
                         r.invalidated_reason ? `A team-up request can no longer go ahead: ${r.invalidated_reason}.`
                                              : 'A team-up request can no longer go ahead because a team changed.']
      }[r.state];
      if (!resolved) continue;
      add(r.student_id, {
        type: 'team_request',
        title: resolved[0],
        body: resolved[1],
        link: link('my-team'),
        dedupeKey: `proposal:${r.proposal_id}:${r.state}`,
        createdAt: r.resolved_at || now
      });
    }

  }

  // Produce only what one request can generate, for its voters. Called by
  // sendRequest right after creation. Same rows, same dedupe keys as the full
  // pass — the timer sweep re-deriving them is a no-op.
  syncRequest(unitId, proposalId) {
    const now = nowIso();
    const link = page => `/student/${page}.html?unitId=${unitId}`;
    const voters = this.db.all(`SELECT student_id FROM proposal_votes WHERE proposal_id = ?`, [proposalId]).map(r => r.student_id);
    const seededAt = new Map(this.notifications.listSeedTimes(unitId).map(r => [r.student_id, r.created_at]));
    for (const sid of voters) if (!seededAt.has(sid)) { this.seedStudent(unitId, sid, now); seededAt.set(sid, now); }
    const add = (studentId, n) => {
      const createdAt = n.createdAt || now;
      const backfill = Date.parse(createdAt) < Date.parse(seededAt.get(studentId) || now);
      this.notifications.insertIgnore({
        unitId, studentId, recipientRole: 'STUDENT',
        type: n.type, severity: n.severity || 'INFO',
        title: n.title, body: n.body || '', link: n.link || '',
        dedupeKey: n.dedupeKey, createdAt,
        readAt: backfill ? now : null, emailedAt: backfill ? now : null
      });
    };
    this._produceRequests(unitId, add, link, now, proposalId);
  }

  // Marks the point from which a student's notifications are live. Called on
  // join; older events are backfilled as read + emailed, later ones are not.
  // The sentinel row is hidden from the inbox listing.
  seedStudent(unitId, studentId, at = nowIso()) {
    this.notifications.insertIgnore({
      unitId, studentId, recipientRole: 'STUDENT', type: SEED_TYPE,
      severity: 'INFO', title: '', body: '', link: '',
      dedupeKey: `seed:${unitId}`, createdAt: at, readAt: at, emailedAt: at
    });
  }

  // ── Teacher producer ────────────────────────────────────────────────────────
  // Same shape as syncForUnit, but there is exactly one recipient: the unit's
  // owner. Everything it derives is something the teacher may need to ACT on,
  // which is why most of it is WARNING rather than INFO.
  syncTeacherForUnit(unitId) {
    const unit = this.units.findById(unitId);
    if (!unit) return 0;

    const teacherId = unit.created_by;
    if (!teacherId) return 0;

    const now = nowIso();
    const link = page => `/teacher/${page}.html?unitId=${unitId}`;

    // Same first-sync rule as the student producer: a teacher enabling this on
    // a unit with months of history gets a clean inbox, not a backlog.
    const seeding = !this.notifications.hasAnyFor(unitId, teacherId, 'TEACHER');

    const add = n => this.notifications.insertIgnore({
      unitId, studentId: teacherId, recipientRole: 'TEACHER',
      type: n.type, severity: n.severity || 'INFO',
      title: n.title, body: n.body || '', link: n.link || '',
      dedupeKey: n.dedupeKey,
      createdAt: n.createdAt || now,
      readAt:    seeding ? now : null,
      emailedAt: seeding ? now : null
    });

    if (seeding) {
      this.notifications.insertIgnore({
        unitId, studentId: teacherId, recipientRole: 'TEACHER', type: SEED_TYPE,
        severity: 'INFO', title: '', body: '', link: '',
        dedupeKey: `teacher:seed:${unitId}`, createdAt: now, readAt: now, emailedAt: now
      });
    }

    const allTeams = this.teams.listAllWithCounts(unitId);
    const students = this.enrollment.listWithProgress(unitId);

    // ── Placement, once for the unit ──
    const teamOf = new Map(
      this.teams.listMembershipsWithSizes(unitId).map(m => [m.student_id, m]));
    const placementOfStudent = s => {
      const t = teamOf.get(s.student_id);
      return placementOf({ acceptedCount: t?.accepted_count || 0, noPreferenceAt: s.no_preference_at });
    };
    const silentCount = students.filter(s => placementOfStudent(s) === 'SILENT').length;

    // ── Deadline approaching ──
    const bucket = deadlineBucket(unit.deadline, 'TEACHER');
    if (bucket) {
      add({
        type: 'deadline', severity: deadlineSeverity(bucket[0]),
        title: bucket[1], body: bucket[2],
        link: link('dashboard'),
        dedupeKey: `teacher:deadline:${unitId}:${bucket[0]}`
      });

      // ── Students at risk ──
      // Held back until the unit's own at_risk_days window opens. Before that,
      // "no preferences" and "not in a team" describe an ordinary
      // early-semester unit, and reporting them is noise rather than signal.
      //
      // daysLeft goes negative once the deadline passes, which keeps reporting
      // on after the fact — a student still unplaced then is the most urgent
      // case, not the least.
      const atRiskDays = atRiskDaysFor(unit);
      const daysLeft   = daysUntilDeadline(unit.deadline);
      if (atRiskDays > 0 && daysLeft !== null && daysLeft <= atRiskDays) {
        // ── Silent students: ONE line, keyed on the deadline bucket so it
        //    re-states the count as the deadline closes in and never per student.
        //    The class list, pre-filtered, carries the names.
        if (silentCount > 0) {
          add({
            type: 'needs_attention', severity: 'CRITICAL',
            title: `${silentCount} student${silentCount === 1 ? '' : 's'} with nothing recorded`,
            body: `${silentCount} student${silentCount === 1 ? ' has' : 's have'} no team and `
                + `${silentCount === 1 ? "hasn't" : "haven't"} asked to be placed. `
                + `These are the ones to chase.`,
            link: link('class-list') + '&placement=SILENT',
            dedupeKey: `teacher:attention:${unitId}:silent:${bucket[0]}`
          });
        }

      }
    }

    // ── Allocation complete ──
    // Every enrolled student sits in a finalised team. Not keyed on a
    // timestamp: a one-shot "you're done" for the unit.
    const allFinalised = students.length > 0 &&
      students.every(s => teamOf.get(s.student_id)?.status === 'FINALISED');
    if (allFinalised) {
      add({
        type: 'complete', severity: 'INFO',
        title: 'Every student is in a finalised team',
        body: `Every student in ${unit.unit_name || unitId} is in a finalised team. Allocation is complete.`,
        link: link('team-formation'),
        dedupeKey: `teacher:complete:${unitId}`
      });
    }

    return 1;
  }

  // ── Reads ───────────────────────────────────────────────────────────────────
  list(unitId, studentId) {
    this.syncForUnit(unitId);
    return this.notifications.listForStudent(unitId, studentId)
      .filter(n => n.type !== SEED_TYPE);
  }

  unreadCount(unitId, studentId) {
    this.syncForUnit(unitId);
    return { count: this.notifications.countUnread(unitId, studentId) };
  }

  markRead(unitId, studentId, id) {
    const row = this.notifications.findOwned(id, studentId);
    if (!row) throw new ServiceError('Notification not found', 404);
    this.notifications.markRead(id, studentId, nowIso());
    return { ok: true };
  }

  markAllRead(unitId, studentId) {
    this.notifications.markAllRead(unitId, studentId, nowIso());
    return { ok: true };
  }

  // ── Teacher reads ───────────────────────────────────────────────────────────
  // Ownership is enforced by the route before these are called; they take the
  // teacher id as given, exactly as the student reads do.
  listForTeacher(unitId, teacherId) {
    this.syncTeacherForUnit(unitId);
    return this.notifications.listForStudent(unitId, teacherId, 100, 'TEACHER')
      .filter(n => n.type !== SEED_TYPE);
  }

  unreadCountForTeacher(unitId, teacherId) {
    this.syncTeacherForUnit(unitId);
    return { count: this.notifications.countUnread(unitId, teacherId, 'TEACHER') };
  }

  markAllReadForTeacher(unitId, teacherId) {
    this.notifications.markAllRead(unitId, teacherId, nowIso(), 'TEACHER');
    return { ok: true };
  }

  // ── Preferences ─────────────────────────────────────────────────────────────
  getPrefs(username) {
    const p = this.prefs.get(username);
    const user = this.userRepo.findByUsername(username);
    const signupEmail = (user?.email || '').trim();
    return {
      emailEnabled:  !!p.email_enabled,
      emailOverride: p.email_override || '',
      minSeverity:   p.min_severity || 'INFO',
      signupEmail,
      // What dispatch would actually use right now, so the panel can show it
      // rather than making the user infer the override/fallback rule.
      deliveringTo:  (p.email_override || '').trim() || signupEmail
    };
  }

  savePrefs(username, body = {}) {
    const minSeverity = String(body.minSeverity || 'INFO').toUpperCase();
    if (!SEVERITIES.includes(minSeverity)) {
      throw new ServiceError('Invalid minimum severity', 400);
    }
    const override = String(body.emailOverride || '').trim();
    // Rejected here rather than silently ignored at dispatch time — an address
    // that will never be mailed should fail loudly while the user is looking.
    if (override && !isDeliverable(override)) {
      throw new ServiceError('That override address is not a valid email', 400);
    }
    this.prefs.upsert(username, {
      emailEnabled:  body.emailEnabled !== false,
      emailOverride: override,
      minSeverity,
      updatedAt:     nowIso()
    });
    return this.getPrefs(username);
  }

  findUserByUnsubscribeToken(token) {
    return this.prefs.findByUnsubscribeToken(token);
  }

  // ── Recipient guard ─────────────────────────────────────────────────────────
  // Applied to every transport, because it lives here rather than in one of
  // them. The database holds third-party addresses, so switching MAIL_TRANSPORT
  // to a real provider must not be able to mail people by accident.
  _allowlist() {
    return (this.env.MAIL_ALLOWLIST || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  }

  _isAllowed(address) {
    const list = this._allowlist();
    if (!list.length) return true;
    const a = address.toLowerCase();
    return list.some(entry => entry.startsWith('@') ? a.endsWith(entry) : a === entry);
  }

  // ── Email dispatch ──────────────────────────────────────────────────────────
  // Runs on the timer, never inline with a request. Every notification is
  // stamped emailed_at exactly once, whichever way it goes — and the stamp is
  // written BEFORE the transport is called, so a crash mid-send produces a
  // visible failed/queued outbox row rather than a duplicate email. Silent
  // non-delivery is the better failure mode.
  //
  // Gates, in order and never the other way round:
  //   1. is this an email event at all?               (utils/emailCategories)
  //   2. the RECIPIENT's preferences — master switch, per-unit category,
  //      minimum severity
  //   3. the auto_cancelled suppression (they already got the winner's email)
  //   4. the per-recipient daily cap
  //   5. the OPERATOR's env guard — what this deployment is allowed to send
  // A user's choices only ever narrow the audience or change the intended
  // address; they never bypass the operator guard.
  async dispatchEmails(limit = 100) {
    const pending = this.notifications.listPendingEmail(limit);
    const result = { sent: 0, skipped: 0, failed: 0 };
    const redirectTo = (this.env.MAIL_REDIRECT_TO || '').trim();
    const baseUrl = (this.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

    // Read per-unit category prefs once per pass, not once per email.
    const unitPrefs = new Map();
    if (this.emailPrefs) {
      for (const r of this.emailPrefs.listAll())
        unitPrefs.set(`${r.username}|${r.unit_id}|${r.category}`, r.enabled ? 1 : 0);
    }
    const categoryOn = (username, unitId, category) => {
      const k = `${username}|${unitId}|${category}`;
      if (unitPrefs.has(k)) return !!unitPrefs.get(k);
      return !!require('../utils/emailCategories').CATEGORY_DEFAULTS[category];
    };
    const sentToday = new Map();          // intended address → count, memoised per pass
    const cappedWarned = new Set();

    for (const n of pending) {
      const at = nowIso();
      const user = this.userRepo.findByUsername(n.student_id);
      const prefs = this.prefs.get(n.student_id);
      const intended = (prefs.email_override || '').trim() || (user?.email || '').trim();
      const category = categoryOf(n);
      const subject = `[TeamUp] ${n.title}`;

      const skip = reason => {
        this.outbox.queue({
          notificationId: n.id, recipient: intended, intendedRecipient: intended,
          subject, body: '', status: 'skipped', error: reason, createdAt: at
        });
        this.notifications.markEmailed(n.id, at);
        result.skipped++;
      };

      // ── 1. Event gate ──
      if (n.recipient_role !== 'TEACHER' && !category) { skip('not an email event'); continue; }

      // ── 2. Recipient preferences ──
      if (!prefs.email_enabled) { skip('recipient disabled email notifications'); continue; }
      if (category && !categoryOn(n.student_id, n.unit_id, category)) { skip(`category off: ${category}`); continue; }
      // Unknown severities rank as INFO rather than -1, so a row written by
      // older code is never silently filtered out by a CRITICAL-only setting.
      const rank = sv => Math.max(0, SEVERITIES.indexOf(sv));
      if (rank(n.severity) < rank(prefs.min_severity)) { skip('below recipient minimum severity'); continue; }

      // ── 3. auto_cancelled: suppress only for someone who also won ──
      if (category === 'requests' && String(n.dedupe_key).endsWith(':auto_cancelled')) {
        const proposalId = String(n.dedupe_key).split(':')[1];
        const winner = this.db.get(`SELECT superseded_by FROM proposals WHERE proposal_id = ?`, [proposalId])?.superseded_by;
        const alsoWon = winner && this.db.get(
          `SELECT 1 AS ok FROM proposal_votes WHERE proposal_id = ? AND student_id = ?`, [winner, n.student_id]);
        if (alsoWon) { skip('superseded by accepted request'); continue; }
      }

      // ── 4. Daily cap ──
      if (n.recipient_role !== 'TEACHER') {
        if (!sentToday.has(intended))
          sentToday.set(intended, this.outbox.countSentSince(intended, new Date(Date.now() - DAY_MS).toISOString()));
        const count = sentToday.get(intended);
        if (count >= EMAIL_DAILY_CAP) {
          if (!cappedWarned.has(n.student_id)) {
            cappedWarned.add(n.student_id);
            // Username and count only — never the message.
            console.warn('Email daily cap reached', { studentId: n.student_id, count });
          }
          skip('daily cap reached');
          continue;
        }
      }

      // ── 5. Operator guard ──
      if (!isDeliverable(intended)) { skip('recipient address is not a valid email'); continue; }
      let recipient = intended;
      let body = this._emailBody(n, baseUrl, category);
      if (redirectTo) {
        recipient = redirectTo;
        body = `[would have gone to ${intended}]\n\n${body}`;
      } else if (!this._isAllowed(intended)) {
        skip('recipient is not in MAIL_ALLOWLIST');
        continue;
      }

      // Stamp and record BEFORE sending: a crash from here on leaves a
      // queued/failed row, never a second email.
      const outboxId = this.outbox.queue({
        notificationId: n.id, recipient, intendedRecipient: intended,
        subject, body, status: 'queued', createdAt: at
      });
      this.notifications.markEmailed(n.id, at);
      try {
        const info = await this.transport.send({ to: recipient, subject, body });
        this.outbox.markSent(outboxId, nowIso(), info?.previewUrl || null);
        sentToday.set(intended, (sentToday.get(intended) || 0) + 1);
        result.sent++;
      } catch (e) {
        // Recorded, not retried: the stamp is already down, and retrying
        // forever against an unreachable address is the worse failure.
        this.outbox.markFailed(outboxId, e.message);
        result.failed++;
      }
    }
    return result;
  }

  // Plain text. Absolute links (a relative path is useless in a mail client),
  // and for students an unsubscribe link that needs no login plus a link to
  // the panel with the other switches.
  _emailBody(n, baseUrl, category) {
    const link = n.link ? (n.link.startsWith('http') ? n.link : baseUrl + n.link) : baseUrl;
    let body = `${n.body}\n\nOpen TeamUp: ${link}`;
    if (category && n.recipient_role !== 'TEACHER') {
      const token = this.prefs.ensureUnsubscribeToken(n.student_id);
      const stop = `${baseUrl}/unsubscribe?t=${encodeURIComponent(token)}&u=${encodeURIComponent(n.unit_id)}&c=${category}`;
      const manage = `${baseUrl}/student/notifications.html?unitId=${encodeURIComponent(n.unit_id)}`;
      body += `\n\n—\nYou are getting this because "${CATEGORY_LABELS[category]}" is on for this unit.` +
              `\nStop these emails: ${stop}\nManage all email settings: ${manage}`;
    }
    return body;
  }

  // Timer entry point: produce for every unit, then dispatch.
  // The two producers are caught separately so a failure in one audience still
  // leaves the other's notifications produced.
  async runBackgroundPass() {
    for (const u of this.db.all(`SELECT unit_id FROM units`)) {
      try { this.syncForUnit(u.unit_id); }
      catch (e) { console.error('Notification sync failed for', u.unit_id, e.message); }
      try { this.syncTeacherForUnit(u.unit_id); }
      catch (e) { console.error('Teacher notification sync failed for', u.unit_id, e.message); }
    }
    return this.dispatchEmails();
  }
}

NotificationService.SEED_TYPE = SEED_TYPE;
NotificationService.EMAIL_DAILY_CAP = EMAIL_DAILY_CAP;
NotificationService.EXPIRY_WARNING_MS = EXPIRY_WARNING_MS;
NotificationService.AT_RISK_CHOICES = AT_RISK_CHOICES;
NotificationService.AT_RISK_DEFAULT = AT_RISK_DEFAULT;
module.exports = NotificationService;

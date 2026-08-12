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
//   announcement:<id>
// Teacher keys carry a `teacher:` prefix. They cannot collide with student keys
// anyway — dedupe is scoped per-username and a teacher is a different user —
// but the prefix keeps the table readable when debugging.
// =============================================================================

const ServiceError = require('./ServiceError');
const { isDeliverable } = require('./email/transport');
const { validateTeam } = require('../utils/teamValidator');
const { SEVERITIES } = require('../repositories/notificationPrefsRepository');

function nowIso() { return new Date().toISOString(); }

// A recipient's first sync backfills existing history as already-read and
// already-emailed. Without it, turning the feature on would show everyone a
// badge full of old announcements and send a backlog of email. A student who
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

// ── "Needs attention" signals ────────────────────────────────────────────────
// These deliberately mirror the SIGNALS list the Export page renders
// (public/teacher/export.html), so the notification and the exported report
// can never disagree about who is at risk. Ordered most urgent first; a
// student takes the status of their first match and is reported once.
//
// If you add a signal, add it in BOTH places — the export list is client-side
// and cannot require this module.
const ATTENTION_SIGNALS = [
  {
    key: 'alone', severity: 'CRITICAL', label: 'alone in a team',
    // sizeValid guards against crying wolf where a one-person team is a legal
    // size for the unit — it is the server's own team rule, via teamValidator.
    test: c => c.team && c.team.status === 'FORMING'
               && c.teamSize === 1 && !c.sizeValid
  },
  {
    key: 'no_prefs', severity: 'WARNING', label: 'no preferences entered',
    test: c => c.student.entered_preferences != 1
  }
];

// Longest name list worth putting in a notification body; beyond this the
// count carries the message and the class list carries the detail.
const ATTENTION_NAME_LIMIT = 5;

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

const displayName = s => (s.name && String(s.name).trim()) || s.student_id;

class NotificationService {
  constructor({ db, notifications, prefs, outbox, units, enrollment, teams, announcements,
                userRepo, transport, env = process.env }) {
    this.db = db;
    this.env = env;
    this.notifications = notifications;
    this.prefs = prefs;
    this.outbox = outbox;
    this.units = units;
    this.enrollment = enrollment;
    this.teams = teams;
    this.announcements = announcements;
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

    // Computed up front: hasAnyFor flips to true as soon as we insert.
    const firstSync = new Set(
      students.filter(s => !this.notifications.hasAnyFor(unitId, s.student_id))
              .map(s => s.student_id)
    );

    const add = (studentId, n) => {
      const seeding = firstSync.has(studentId);
      this.notifications.insertIgnore({
        unitId, studentId, recipientRole: 'STUDENT',
        type: n.type, severity: n.severity || 'INFO',
        title: n.title, body: n.body || '', link: n.link || '',
        dedupeKey: n.dedupeKey,
        createdAt: n.createdAt || now,
        readAt:    seeding ? now : null,
        emailedAt: seeding ? now : null
      });
    };

    // A sentinel so a student with no derivable events is still "synced".
    // Without it they would stay in firstSync forever and their first real
    // notification would arrive pre-read. Hidden from the inbox listing.
    for (const sid of firstSync) {
      this.notifications.insertIgnore({
        unitId, studentId: sid, recipientRole: 'STUDENT', type: SEED_TYPE,
        severity: 'INFO', title: '', body: '', link: '',
        dedupeKey: `seed:${unitId}`, createdAt: now, readAt: now, emailedAt: now
      });
    }

    // ── Teacher announcements ──
    for (const a of this.announcements.listForStudent(unitId)) {
      for (const s of students) {
        add(s.student_id, {
          type: 'announcement',
          title: `Announcement: ${a.title || 'Untitled'}`,
          body: a.content || '',
          link: link('announcements'),
          dedupeKey: `announcement:${a.id}`,
          createdAt: a.created_at || now
        });
      }
    }

    // ── Team requests (merge proposals) ──
    // One query for the whole unit rather than N per-student calls.
    const proposalRows = this.db.all(
      `SELECT p.proposal_id, p.state, p.initiator_id, p.created_at, p.resolved_at,
              ts.team_name AS source_team_name, tt.team_name AS target_team_name,
              pv.student_id, pv.vote
         FROM proposals p
         INNER JOIN proposal_votes pv ON pv.proposal_id = p.proposal_id
         LEFT JOIN unit_teams ts ON ts.team_id = p.source_team_id
         LEFT JOIN unit_teams tt ON tt.team_id = p.target_team_id
        WHERE p.unit_id = ?`,
      [unitId]
    );
    for (const r of proposalRows) {
      const otherTeam = r.source_team_name || r.target_team_name || 'Another team';
      if (r.state === 'open') {
        if (r.vote === 'pending' && r.student_id !== r.initiator_id) {
          add(r.student_id, {
            type: 'team_request',
            title: 'New team request',
            body: `${otherTeam} wants to merge with your team. Accept or decline before it expires.`,
            link: link('dashboard'),
            dedupeKey: `proposal:${r.proposal_id}:open`,
            createdAt: r.created_at || now
          });
        }
        continue;
      }
      const resolved = {
        approved:       ['Teams merged', 'A team request was accepted by everyone — your team has been merged.'],
        rejected:       ['Team request declined', 'A team request was declined.'],
        expired:        ['Team request expired', 'A team request expired because not everyone responded in time.'],
        auto_cancelled: ['Team request cancelled', 'A team request was cancelled because another merge completed first.'],
        invalidated:    ['Team request no longer valid', 'A team request is no longer valid because a team changed.']
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

    // ── Team status ──
    for (const t of this.teams.listAllWithCounts(unitId)) {
      const members = this.teams.getMembers(t.team_id).map(m => m.student_id);
      const emit = (key, title, body, severity = 'INFO') => members.forEach(sid =>
        add(sid, { type: 'team_status', severity, title, body, link: link('my-team'),
                   dedupeKey: key,
                   createdAt: t.submitted_at || t.last_rejected_at || now }));

      if (t.status === 'SUBMITTED') {
        emit(`team:${t.team_id}:SUBMITTED:${t.submitted_at || ''}`,
             'Team submitted',
             `${t.team_name} was submitted for teacher review.`);
      } else if (t.status === 'APPROVED') {
        emit(`team:${t.team_id}:APPROVED:${t.submitted_at || ''}`,
             'Team approved',
             `${t.team_name} was approved by your teacher.`);
      }
      // A rejected team goes back to FORMING, so this is checked independently
      // of status and keyed on the rejection time — a re-submit notifies again.
      // WARNING because it is the one team_status the students must act on.
      if (t.last_rejected_at) {
        emit(`team:${t.team_id}:REJECTED:${t.last_rejected_at}`,
             'Team submission rejected',
             `${t.team_name} was sent back by your teacher. Review it and re-submit.`,
             'WARNING');
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

    // ── Students needing attention ──
    // Evaluated once here and used by two rules below: the immediate per-student
    // alert and the periodic summary.
    const teamOf = new Map();
    for (const t of allTeams) {
      const members = this.teams.getMembers(t.team_id);
      const accepted = members.filter(m => m.status === 'ACCEPTED');
      const sizeValid = validateTeam(members, unit, { includeAllAccepted: true }).sizeValid;
      for (const m of members) {
        teamOf.set(m.student_id, { team: t, teamSize: accepted.length, sizeValid });
      }
    }

    const flagged = [];
    for (const student of students) {
      const ctx = { student, ...(teamOf.get(student.student_id) || { team: null, teamSize: 0, sizeValid: false }) };
      const hit = ATTENTION_SIGNALS.find(s => s.test(ctx));
      if (hit) flagged.push({ student, signal: hit });
    }

    // ── Teams waiting on review ──
    // Keyed on submitted_at so a team that is sent back and re-submitted
    // notifies again, mirroring the student-side rejection rule.
    for (const t of allTeams) {
      if (t.status !== 'SUBMITTED') continue;
      add({
        type: 'review_pending', severity: 'WARNING',
        title: 'Team awaiting review',
        body: `${t.team_name} was submitted and is waiting for your approval.`,
        link: link('team-formation'),
        dedupeKey: `teacher:team:${t.team_id}:SUBMITTED:${t.submitted_at || ''}`,
        createdAt: t.submitted_at || now
      });
    }

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
        const unformed = students.filter(s => !s.in_team).length;
        if (unformed > 0) {
          add({
            type: 'unformed', severity: 'WARNING',
            title: `${unformed} student${unformed === 1 ? '' : 's'} without a team`,
            body: `${unformed} of ${students.length} student${students.length === 1 ? '' : 's'} `
                + `still ${unformed === 1 ? 'has' : 'have'} no team as the deadline approaches.`,
            link: link('class-list'),
            dedupeKey: `teacher:unformed:${unitId}:${bucket[0]}`
          });
        }

        // A student stranded alone in an undersized team, named individually.
        // The dedupe key carries no bucket, so this stays one notification per
        // student for the life of the unit — crossing into a nearer bucket
        // re-states the summary below, but never re-reports the same student.
        for (const { student, signal } of flagged) {
          if (signal.key !== 'alone') continue;
          add({
            type: 'needs_attention', severity: signal.severity,
            title: `${displayName(student)} is alone in a team`,
            body: `${displayName(student)} is the only accepted member of `
                + `${teamOf.get(student.student_id)?.team?.team_name || 'their team'}, `
                + `which is not a valid size for this unit.`,
            link: link('team-formation'),
            dedupeKey: `teacher:attention:${unitId}:${student.student_id}:alone`
          });
        }

        // Summary of everyone currently flagged. Keyed on the deadline bucket
        // rather than the count, so it re-states the position as the deadline
        // closes in instead of firing every time one student changes.
        if (flagged.length) {
          const worst = flagged.some(f => f.signal.severity === 'CRITICAL')
            ? 'CRITICAL' : 'WARNING';
          const named = flagged.slice(0, ATTENTION_NAME_LIMIT)
            .map(f => `${displayName(f.student)} (${f.signal.label})`)
            .join(', ');
          const rest = flagged.length - Math.min(flagged.length, ATTENTION_NAME_LIMIT);

          add({
            type: 'needs_attention', severity: worst,
            title: `${flagged.length} student${flagged.length === 1 ? '' : 's'} need`
                 + `${flagged.length === 1 ? 's' : ''} attention`,
            body: `${named}${rest > 0 ? `, and ${rest} more` : ''}.`,
            link: link('export'),
            dedupeKey: `teacher:attention:${unitId}:summary:${bucket[0]}`
          });
        }
      }
    }

    // ── Formation complete ──
    // Not keyed on a timestamp: this is a one-shot "you're done" for the unit.
    if (allTeams.length && allTeams.every(t => t.status === 'APPROVED')) {
      add({
        type: 'complete', severity: 'INFO',
        title: 'All teams approved',
        body: `Every team in ${unit.unit_name || unitId} has been approved. Team formation is complete.`,
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
  // stamped emailed_at exactly once, whichever way it goes, so nothing is sent
  // twice and nothing is retried forever.
  //
  // Two layers of filtering, in this order and never the other way round:
  //   1. the RECIPIENT's preferences  — what they asked to receive
  //   2. the OPERATOR's env guard     — what this deployment is allowed to send
  // A user choosing an override address must not be able to reach somewhere
  // MAIL_ALLOWLIST forbids, so their choice only ever narrows the audience or
  // changes the intended address; it never bypasses the guard below.
  async dispatchEmails(limit = 100) {
    const pending = this.notifications.listPendingEmail(limit);
    const result = { sent: 0, skipped: 0, failed: 0 };
    const redirectTo = (this.env.MAIL_REDIRECT_TO || '').trim();

    for (const n of pending) {
      const at = nowIso();
      const user = this.userRepo.findByUsername(n.student_id);
      const prefs = this.prefs.get(n.student_id);
      // The override is the address the user nominated; falling back to the
      // one they signed up with.
      const intended = (prefs.email_override || '').trim() || (user?.email || '').trim();
      const subject = `[TeamUp] ${n.title}`;
      let body = `${n.body}\n\nOpen TeamUp: ${n.link}`;

      const skip = reason => {
        this.outbox.queue({
          notificationId: n.id, recipient: intended, intendedRecipient: intended,
          subject, body, status: 'skipped', error: reason, createdAt: at
        });
        this.notifications.markEmailed(n.id, at);
        result.skipped++;
      };

      // ── Layer 1: recipient preferences ──
      if (!prefs.email_enabled) { skip('recipient disabled email notifications'); continue; }

      // Unknown severities rank as INFO rather than -1, so a row written by
      // older code is never silently filtered out by a CRITICAL-only setting.
      const rank = s => Math.max(0, SEVERITIES.indexOf(s));
      if (rank(n.severity) < rank(prefs.min_severity)) {
        skip('below recipient minimum severity');
        continue;
      }

      // ── Layer 2: operator guard ──
      if (!isDeliverable(intended)) { skip('recipient address is not a valid email'); continue; }

      // Redirect wins over the allowlist: it is the blunt "nothing can escape"
      // switch, so it must not be second-guessed by a narrower rule.
      let recipient = intended;
      if (redirectTo) {
        recipient = redirectTo;
        body = `[would have gone to ${intended}]\n\n${body}`;
      } else if (!this._isAllowed(intended)) {
        skip('recipient is not in MAIL_ALLOWLIST');
        continue;
      }

      const outboxId = this.outbox.queue({
        notificationId: n.id, recipient, intendedRecipient: intended,
        subject, body, status: 'queued', createdAt: at
      });
      try {
        const info = await this.transport.send({ to: recipient, subject, body });
        this.outbox.markSent(outboxId, nowIso(), info?.previewUrl || null);
        result.sent++;
      } catch (e) {
        this.outbox.markFailed(outboxId, e.message);
        result.failed++;
      }
      // Stamped regardless: a failure is recorded in the outbox, not retried
      // forever against an address that may simply be unreachable.
      this.notifications.markEmailed(n.id, at);
    }
    return result;
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
NotificationService.AT_RISK_CHOICES = AT_RISK_CHOICES;
NotificationService.AT_RISK_DEFAULT = AT_RISK_DEFAULT;
module.exports = NotificationService;

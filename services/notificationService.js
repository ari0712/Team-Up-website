// =============================================================================
// NotificationService — student notification inbox and email dispatch.
//
// DESIGN: one idempotent producer, not event hooks.
//
// `syncForUnit` DERIVES notifications from current state and inserts them with
// INSERT OR IGNORE against the UNIQUE (student_id, dedupe_key) index. Nothing
// else in the app has to know notifications exist — proposalService,
// unitService and the team-submit paths are untouched, and none of this has to
// be threaded through their transactions.
//
// Because it is idempotent it can safely run on every read (so the UI is fresh)
// and on a timer (so email goes out to students who aren't in the app).
//
// The dedupe_key encodes the EVENT, not just the entity:
//   proposal:<id>:open              a request is waiting on you
//   proposal:<id>:<state>           that request resolved
//   team:<id>:<status>:<timestamp>  timestamp lets a re-submit notify again
//   deadline:<unit>:<bucket>        7d / 3d / 1d / due
//   announcement:<id>
// =============================================================================

const ServiceError = require('./ServiceError');
const { isDeliverable } = require('./email/transport');

function nowIso() { return new Date().toISOString(); }

// A student's first sync backfills existing history as already-read and
// already-emailed. Without it, turning the feature on would show everyone a
// badge full of old announcements and send a backlog of email. A student who
// joins later gets the same treatment, which is correct — they should not be
// notified about things that happened before they arrived.
const SEED_TYPE = 'seed';

class NotificationService {
  constructor({ db, notifications, outbox, units, enrollment, teams, announcements,
                userRepo, transport, env = process.env }) {
    this.db = db;
    this.env = env;
    this.notifications = notifications;
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
        unitId, studentId,
        type: n.type, title: n.title, body: n.body || '', link: n.link || '',
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
        unitId, studentId: sid, type: SEED_TYPE,
        title: '', body: '', link: '',
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
      const emit = (key, title, body) => members.forEach(sid =>
        add(sid, { type: 'team_status', title, body, link: link('my-team'), dedupeKey: key,
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
      if (t.last_rejected_at) {
        emit(`team:${t.team_id}:REJECTED:${t.last_rejected_at}`,
             'Team submission rejected',
             `${t.team_name} was sent back by your teacher. Review it and re-submit.`);
      }
    }

    // ── Deadline approaching ──
    if (unit.deadline) {
      const ms = Date.parse(unit.deadline) - Date.now();
      let bucket = null;
      if (isNaN(ms))          bucket = null;
      else if (ms <= 0)       bucket = ['due', 'Deadline passed', 'The team formation deadline has passed.'];
      else {
        const days = ms / 86400000;
        if (days <= 1)      bucket = ['1d', 'Deadline tomorrow', 'The team formation deadline is less than a day away.'];
        else if (days <= 3) bucket = ['3d', 'Deadline in 3 days', 'The team formation deadline is approaching.'];
        else if (days <= 7) bucket = ['7d', 'Deadline in a week', 'The team formation deadline is a week away.'];
      }
      if (bucket) {
        for (const s of students) {
          add(s.student_id, {
            type: 'deadline', title: bucket[1], body: bucket[2],
            link: link('dashboard'), dedupeKey: `deadline:${unitId}:${bucket[0]}`
          });
        }
      }
    }

    return students.length;
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
  async dispatchEmails(limit = 100) {
    const pending = this.notifications.listPendingEmail(limit);
    const result = { sent: 0, skipped: 0, failed: 0 };
    const redirectTo = (this.env.MAIL_REDIRECT_TO || '').trim();

    for (const n of pending) {
      const at = nowIso();
      const user = this.userRepo.findByUsername(n.student_id);
      const intended = (user?.email || '').trim();
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
  async runBackgroundPass() {
    for (const u of this.db.all(`SELECT unit_id FROM units`)) {
      try { this.syncForUnit(u.unit_id); }
      catch (e) { console.error('Notification sync failed for', u.unit_id, e.message); }
    }
    return this.dispatchEmails();
  }
}

NotificationService.SEED_TYPE = SEED_TYPE;
module.exports = NotificationService;

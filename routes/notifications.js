const express = require('express');
const router  = express.Router();
const { all, get, run } = require('../db');
const { requireAuth } = require('../middleware/auth');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');

router.use(requireAuth);

const SEVERITY_RANK = notificationService.SEVERITY_RANK;
const AUTO_DIGEST_INTERVAL_MS = 60 * 60 * 1000;   // at most one automatic digest per hour

const me = req => req.session.user.username;

// The address a user signed up with — the default destination for email notifications
function signupEmail(username) {
    const row = get(`SELECT email FROM users WHERE username = ?`, [username]);
    return row ? (row.email || '') : '';
}

function getPrefs(username) {
    let row = get(`SELECT * FROM notification_prefs WHERE username = ?`, [username]);
    if (!row) {
        run(`INSERT OR IGNORE INTO notification_prefs (username) VALUES (?)`, [username]);
        row = get(`SELECT * FROM notification_prefs WHERE username = ?`, [username]);
    }
    return row;
}

function prefsPayload(username) {
    const prefs = getPrefs(username);
    const signup = signupEmail(username);
    return {
        signupEmail:   signup,
        emailOverride: prefs.email_override || '',
        deliverTo:     prefs.email_override || signup,
        emailEnabled:  prefs.email_enabled == 1,
        minSeverity:   prefs.min_severity || 'INFO',
        lastDigestAt:  prefs.last_digest_at || '',
        transport:     emailService.transportMode()
    };
}

// Attach read state, and optionally narrow to one unit
function buildList(req) {
    const username = me(req);
    let list = notificationService.forUser(req.session.user);

    const unitId = req.query.unitId;
    if (unitId) list = list.filter(n => n.unitId === unitId);

    const readRows = all(`SELECT notif_key, read_at FROM notification_reads WHERE username = ?`, [username]);
    const readMap  = new Map(readRows.map(r => [r.notif_key, r.read_at]));

    return list.map(n => ({
        ...n,
        read:   readMap.has(n.key),
        readAt: readMap.get(n.key) || null
    }));
}

// ── GET /api/notifications ────────────────────────────────────
// Optional ?unitId= narrows the feed to a single unit.
router.get('/', (req, res) => {
    const notifications = buildList(req);
    autoSendDigest(req.session.user);
    res.json({
        role:          req.session.user.role,
        notifications,
        unreadCount:   notifications.filter(n => !n.read).length,
        email:         prefsPayload(me(req))
    });
});

// ── GET /api/notifications/count ──────────────────────────────
// Lightweight unread total for the sidebar badge.
router.get('/count', (req, res) => {
    const notifications = buildList(req);
    autoSendDigest(req.session.user);
    res.json({ unread: notifications.filter(n => !n.read).length, total: notifications.length });
});

// ── POST /api/notifications/read ──────────────────────────────
// Body: { keys: ['deadline:…'] }  or  { all: true, unitId? }
router.post('/read', (req, res) => {
    const username = me(req);
    const now = new Date().toISOString();

    let keys = Array.isArray(req.body.keys) ? req.body.keys : [];
    if (req.body.all) keys = buildList(req).map(n => n.key);

    keys.filter(Boolean).forEach(key => {
        run(`INSERT OR REPLACE INTO notification_reads (username, notif_key, read_at) VALUES (?,?,?)`,
            [username, String(key), now]);
    });
    res.json({ ok: true, marked: keys.length });
});

// ── POST /api/notifications/unread ────────────────────────────
// Body: { keys: [...] } — undo a "mark as read"
router.post('/unread', (req, res) => {
    const username = me(req);
    const keys = Array.isArray(req.body.keys) ? req.body.keys : [];
    keys.filter(Boolean).forEach(key => {
        run(`DELETE FROM notification_reads WHERE username = ? AND notif_key = ?`, [username, String(key)]);
    });
    res.json({ ok: true, cleared: keys.length });
});

// ── GET /api/notifications/prefs ──────────────────────────────
router.get('/prefs', (req, res) => res.json(prefsPayload(me(req))));

// ── PUT /api/notifications/prefs ──────────────────────────────
// Body: { emailEnabled, emailOverride, minSeverity }
router.put('/prefs', (req, res) => {
    const username = me(req);
    const prefs = getPrefs(username);
    const { emailEnabled, emailOverride, minSeverity } = req.body;

    const override = emailOverride === undefined ? prefs.email_override : String(emailOverride).trim();
    if (override && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(override))
        return res.status(400).json({ error: 'That does not look like a valid email address' });

    const severity = minSeverity === undefined ? prefs.min_severity : String(minSeverity).toUpperCase();
    if (!(severity in SEVERITY_RANK))
        return res.status(400).json({ error: 'minSeverity must be INFO, WARNING or CRITICAL' });

    run(`UPDATE notification_prefs
         SET email_enabled = ?, email_override = ?, min_severity = ?
         WHERE username = ?`,
        [
            emailEnabled === undefined ? prefs.email_enabled : (emailEnabled ? 1 : 0),
            override,
            severity,
            username
        ]);
    res.json(prefsPayload(username));
});

// ── GET /api/notifications/emails ─────────────────────────────
// Delivery log, newest first — shows what was emailed and how it went.
router.get('/emails', (req, res) => {
    res.json(all(
        `SELECT notif_key, email, subject, sent_at, status
         FROM notification_emails WHERE username = ?
         ORDER BY id DESC LIMIT 30`,
        [me(req)]
    ));
});

// Emails every notification that is email-worthy, at or above the user's
// severity threshold, and has not been emailed before. Respects the enabled
// flag and an hourly throttle. Fired automatically whenever a user's
// notifications are computed (see GET / and GET /count above) so that an
// email goes out on its own as soon as a qualifying notification appears —
// no user action required.
function autoSendDigest(user) {
    (async () => {
        try {
            const username = user.username;
            const prefs    = getPrefs(username);
            if (prefs.email_enabled != 1) return;
            if (prefs.last_digest_at &&
                (Date.now() - new Date(prefs.last_digest_at).getTime()) < AUTO_DIGEST_INTERVAL_MS)
                return;

            const payload = prefsPayload(username);
            const to = payload.deliverTo;
            if (!to) return;

            const threshold = SEVERITY_RANK[payload.minSeverity] ?? 0;
            const alreadySent = new Set(
                all(`SELECT notif_key FROM notification_emails WHERE username = ?`, [username])
                    .map(r => r.notif_key)
            );

            const pending = notificationService.forUser(user).filter(n =>
                n.emailWorthy &&
                (SEVERITY_RANK[n.severity] ?? 0) >= threshold &&
                !alreadySent.has(n.key)
            );
            if (!pending.length) return;

            // Claim the throttle window immediately, before the send completes,
            // so two requests arriving close together don't both fire a digest.
            const now = new Date().toISOString();
            run(`UPDATE notification_prefs SET last_digest_at = ? WHERE username = ?`, [now, username]);

            const isTeacher = user.role === 'TEACHER';
            const subject = pending.length === 1
                ? `TeamUp: ${pending[0].title}`
                : `TeamUp: ${pending.length} updates need your attention`;

            const body =
                `Hi ${username},\n\n` +
                `${pending.length === 1 ? 'There is 1 update' : `There are ${pending.length} updates`} ` +
                `on your TeamUp ${isTeacher ? 'teacher' : 'student'} portal.\n\n` +
                pending.map((n, i) =>
                    `${i + 1}. [${n.severity}] ${n.title}\n` +
                    `   ${n.body}\n` +
                    (n.unitName ? `   Unit: ${n.unitName}\n` : '') +
                    (n.link ? `   Open: ${n.link}\n` : '')
                ).join('\n') +
                `\n—\nYou are receiving this at ${to} because it is the address on your TeamUp account.\n` +
                `Change or turn off these emails on the Notifications page.\n`;

            const result = await emailService.sendMail({ to, subject, text: body });

            // One log row per notification — this is also what stops a repeat send
            pending.forEach(n => {
                run(`INSERT OR REPLACE INTO notification_emails
                       (username, email, notif_key, subject, body, sent_at, status)
                     VALUES (?,?,?,?,?,?,?)`,
                    [username, to, n.key, subject, `${n.title}\n${n.body}`, now, result.status]);
            });
        } catch (e) {
            console.error('[notifications] auto-email failed:', e.message);
        }
    })();
}

module.exports = router;

const { all, get } = require('../db');

//  Notifications are created from the live data on every request.
//  Nothing is written when an event happens instead each
//  notification carries a stable `key` so that read/dismiss state
//  and "already emailed" state can be tracked against it.
//
//  Numbered notifications with embedded
//  count in the key, so the notification re-surfaces as unread
//  when the number changes.

const SEVERITY_RANK = { INFO: 0, SUCCESS: 0, WARNING: 1, CRITICAL: 2 };

// Reminder intervals, in days remaining before the deadline
const DEADLINE_STEPS = [14, 7, 3, 1];

const STUDENT_STAGES = [
    { key: 'read_rules',          label: 'Read the team formation rules',  page: 'student-rules.html'          },
    { key: 'entered_preferences', label: 'Enter your teaming preferences', page: 'student-preferences.html'    },
    { key: 'in_team',             label: 'Build or join a team',           page: 'student-find-teammates.html' },
    { key: 'submitted_request',   label: 'Submit your team request',       page: 'student-my-team.html'        },
    { key: 'teacher_approved',    label: 'Teacher review of your team',    page: 'student-final-team.html'     },
];

const EMPTY_PROGRESS = {
    read_rules: 0, entered_preferences: 0, in_team: 0,
    submitted_request: 0, teacher_approved: 0
};

function daysUntil(iso, now) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return Math.ceil((d.getTime() - now.getTime()) / 86400000);
}

// Which reminder interval the deadline currently falls into
function deadlineBucket(days) {
    if (days === null)  return null;
    if (days <  0)      return { step: 'overdue', text: `Overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`, severity: 'CRITICAL' };
    if (days === 0)     return { step: 'today',   text: 'Due today',                                                          severity: 'CRITICAL' };
    const step = DEADLINE_STEPS.find(s => days <= s);
    if (!step) return null;                       // more than 14 days out no notification needed yet
    return {
        step: `${step}d`,
        text: `${days} day${days === 1 ? '' : 's'} remaining`,
        severity: step === 1 ? 'CRITICAL' : step === 3 ? 'WARNING' : 'INFO'
    };
}

function fmtDeadline(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-AU', {
        weekday: 'long', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit'
    });
}

function note(n) {
    return {
        severity: 'INFO',
        category: 'general',
        emailWorthy: false,
        details: null,
        link: null,
        ...n
    };
}

function sortNotifications(list) {
    return list.sort((a, b) => {
        const rank = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
        if (rank !== 0) return rank;
        return new Date(b.createdAt) - new Date(a.createdAt);
    });
}

// STUDENT
function studentNotifications(username, now = new Date()) {
    const nowIso = now.toISOString();
    const units = all(
        `SELECT u.unit_id, u.unit_name, u.deadline, u.valid_team_sizes
         FROM units u
         INNER JOIN unit_students us ON us.unit_id = u.unit_id
         WHERE us.student_id = ?
         ORDER BY u.rowid DESC`,
        [username]
    );

    const out = [];

    units.forEach(unit => {
        const uid  = unit.unit_id;
        const ctx  = { unitId: uid, unitName: unit.unit_name };
        const link = page => `/${page}?unitId=${uid}`;

        const progress = get(
            `SELECT * FROM student_progress WHERE unit_id = ? AND student_id = ?`,
            [uid, username]
        ) || { ...EMPTY_PROGRESS };

        const daysLeft = daysUntil(unit.deadline, now);

        // Deadline intervals
        // Suppressed once the teacher has approved the team
        const bucket = deadlineBucket(daysLeft);
        if (bucket && !progress.teacher_approved) {
            const remaining = STUDENT_STAGES
                .filter(s => s.key !== 'teacher_approved' && progress[s.key] != 1);
            out.push(note({
                ...ctx,
                key: `deadline:${uid}:${bucket.step}`,
                category: 'deadline',
                severity: bucket.severity,
                title: `${unit.unit_name}: ${bucket.text}`,
                body: `Team formation closes ${fmtDeadline(unit.deadline)}.` +
                      (remaining.length
                          ? ` You still have ${remaining.length} step${remaining.length === 1 ? '' : 's'} to complete.`
                          : ' All of your steps are complete - you are just waiting on teacher review.'),
                createdAt: nowIso,
                link: link('student-dashboard.html'),
                emailWorthy: true
            }));
        }

        // Team invites addressed to student
        const invites = all(
            `SELECT i.invite_id, i.sent_at, t.team_name, i.from_student, us.name AS from_name
             FROM unit_team_invites i
             INNER JOIN unit_teams t ON t.team_id = i.team_id
             LEFT  JOIN unit_students us ON us.unit_id = i.unit_id AND us.student_id = i.from_student
             WHERE i.unit_id = ? AND i.to_student = ? AND i.status = 'PENDING'`,
            [uid, username]
        );
        invites.forEach(inv => {
            out.push(note({
                ...ctx,
                key: `invite:${inv.invite_id}`,
                category: 'invite',
                severity: 'WARNING',
                title: `Team invite from ${inv.from_name || inv.from_student}`,
                body: `You have been invited to join "${inv.team_name || 'their team'}" in ${unit.unit_name}. ` +
                      `Accept or decline it from your dashboard.`,
                createdAt: inv.sent_at || nowIso,
                link: link('student-dashboard.html'),
                emailWorthy: true
            }));
        });

        // Invites student sent that were turned down
        const declined = all(
            `SELECT i.invite_id, i.to_student, us.name AS to_name
             FROM unit_team_invites i
             LEFT JOIN unit_students us ON us.unit_id = i.unit_id AND us.student_id = i.to_student
             WHERE i.unit_id = ? AND i.from_student = ? AND i.status = 'DECLINED'`,
            [uid, username]
        );
        declined.forEach(inv => {
            out.push(note({
                ...ctx,
                key: `invite-declined:${inv.invite_id}`,
                category: 'invite',
                severity: 'INFO',
                title: `${inv.to_name || inv.to_student} declined your invite`,
                body: `Your invitation was declined in ${unit.unit_name}. Try inviting someone else to fill the spot.`,
                createdAt: nowIso,
                link: link('student-find-teammates.html')
            }));
        });

        // Prompts from the teacher
        const announcements = all(
            `SELECT id, title, content, created_at FROM unit_announcements
             WHERE unit_id = ? ORDER BY id DESC LIMIT 20`,
            [uid]
        );
        announcements.forEach(a => {
            out.push(note({
                ...ctx,
                key: `announcement:${a.id}`,
                category: 'teacher',
                severity: 'INFO',
                title: `${unit.unit_name}: ${a.title}`,
                body: a.content || 'Your teacher posted an announcement for this unit.',
                createdAt: a.created_at || nowIso,
                link: link('student-dashboard.html'),
                emailWorthy: true
            }));
        });

        // What's left to complete in the teaming progress
        const doneCount  = STUDENT_STAGES.filter(s => progress[s.key] == 1).length;
        const nextStage  = STUDENT_STAGES.find(s => progress[s.key] != 1);
        if (nextStage && nextStage.key !== 'teacher_approved') {
            const outstanding = STUDENT_STAGES
                .filter(s => s.key !== 'teacher_approved' && progress[s.key] != 1)
                .map(s => s.label);
            out.push(note({
                ...ctx,
                key: `progress:${uid}:${nextStage.key}`,
                category: 'progress',
                severity: (daysLeft !== null && daysLeft <= 3) ? 'WARNING' : 'INFO',
                title: `Next step: ${nextStage.label}`,
                body: `You have completed ${doneCount} of ${STUDENT_STAGES.length} steps in ${unit.unit_name}. ` +
                      `Still to do: ${outstanding.join(', ')}.`,
                createdAt: nowIso,
                link: link(nextStage.page),
                details: outstanding.map(label => ({ label })),
                emailWorthy: true
            }));
        }

        // Team state
        const team = get(
            `SELECT t.* FROM unit_teams t
             INNER JOIN unit_team_members tm ON tm.team_id = t.team_id
             WHERE t.unit_id = ? AND tm.student_id = ?`,
            [uid, username]
        );
        if (team) {
            const members  = all(`SELECT student_id, status FROM unit_team_members WHERE team_id = ?`, [team.team_id]);
            const accepted = members.filter(m => m.status === 'ACCEPTED').length;
            const waiting  = members.filter(m => m.status === 'WAITING').length;
            const sizes    = (unit.valid_team_sizes || '4').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
            const minSize  = sizes.length ? Math.min(...sizes) : 4;
            const teamName = team.team_name || 'your team';

            if (team.status === 'SUBMITTED') {
                out.push(note({
                    ...ctx,
                    key: `team-status:${team.team_id}:SUBMITTED`,
                    category: 'progress',
                    severity: 'INFO',
                    title: `${teamName} is awaiting teacher review`,
                    body: `Your team request for ${unit.unit_name} was submitted and is with your teacher.`,
                    createdAt: team.submitted_at || nowIso,
                    link: link('student-status.html'),
                    emailWorthy: true
                }));
            } else if (team.status === 'APPROVED') {
                out.push(note({
                    ...ctx,
                    key: `team-status:${team.team_id}:APPROVED`,
                    category: 'progress',
                    severity: 'SUCCESS',
                    title: `${teamName} has been approved`,
                    body: `Your teacher approved your team for ${unit.unit_name}. You are all set.`,
                    createdAt: nowIso,
                    link: link('student-final-team.html'),
                    emailWorthy: true
                }));
            } else if (team.status === 'REJECTED') {
                out.push(note({
                    ...ctx,
                    key: `team-status:${team.team_id}:REJECTED`,
                    category: 'progress',
                    severity: 'CRITICAL',
                    title: `${teamName} was not approved`,
                    body: `Your teacher rejected this team request for ${unit.unit_name}. Adjust your team and submit again.`,
                    createdAt: nowIso,
                    link: link('student-my-team.html'),
                    emailWorthy: true
                }));
            } else {
                if (waiting > 0) {
                    out.push(note({
                        ...ctx,
                        key: `team-pending:${team.team_id}:${waiting}`,
                        category: 'progress',
                        severity: 'INFO',
                        title: `${waiting} invited teammate${waiting === 1 ? ' has' : 's have'} not responded`,
                        body: `${teamName} cannot be submitted until every invited member accepts.`,
                        createdAt: nowIso,
                        link: link('student-my-team.html')
                    }));
                }
                if (accepted < minSize) {
                    const short = minSize - accepted;
                    out.push(note({
                        ...ctx,
                        key: `team-size:${team.team_id}:${accepted}`,
                        category: 'progress',
                        severity: (daysLeft !== null && daysLeft <= 3) ? 'WARNING' : 'INFO',
                        title: `${teamName} needs ${short} more member${short === 1 ? '' : 's'}`,
                        body: `${unit.unit_name} requires teams of ${sizes.join(' or ')} students. ` +
                              `You currently have ${accepted} confirmed member${accepted === 1 ? '' : 's'}.`,
                        createdAt: nowIso,
                        link: link('student-find-teammates.html')
                    }));
                }
            }
        }
    });

    return sortNotifications(out);
}

// TEACHER
function teacherNotifications(username, now = new Date()) {
    const nowIso = now.toISOString();
    const units = all(
        `SELECT unit_id, unit_name, deadline, valid_team_sizes, max_new_to_qut, must_share_tutorial
         FROM units WHERE created_by = ? ORDER BY rowid DESC`,
        [username]
    );

    const out = [];

    units.forEach(unit => {
        const uid  = unit.unit_id;
        const ctx  = { unitId: uid, unitName: unit.unit_name };
        const link = page => `/${page}?unitId=${uid}`;

        const daysLeft  = daysUntil(unit.deadline, now);
        const validSizes = (unit.valid_team_sizes || '4').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

        const roster = all(
            `SELECT us.student_id, us.name,
                    COALESCE(sp.read_rules,          0) AS read_rules,
                    COALESCE(sp.entered_preferences, 0) AS entered_preferences,
                    COALESCE(sp.in_team,             0) AS in_team,
                    COALESCE(sp.submitted_request,   0) AS submitted_request,
                    COALESCE(sp.teacher_approved,    0) AS teacher_approved
             FROM unit_students us
             LEFT JOIN student_progress sp
                    ON sp.unit_id = us.unit_id AND sp.student_id = us.student_id
             WHERE us.unit_id = ?
             ORDER BY us.name ASC`,
            [uid]
        );

        // Deadline intervals
        const bucket = deadlineBucket(daysLeft);
        if (bucket) {
            const notSubmitted = roster.filter(s => s.submitted_request != 1).length;
            out.push(note({
                ...ctx,
                key: `deadline:${uid}:${bucket.step}`,
                category: 'deadline',
                severity: bucket.severity,
                title: `${unit.unit_name}: ${bucket.text}`,
                body: `Team formation closes ${fmtDeadline(unit.deadline)}. ` +
                      `${notSubmitted} of ${roster.length} student${roster.length === 1 ? '' : 's'} ` +
                      `${notSubmitted === 1 ? 'has' : 'have'} not submitted a team request yet.`,
                createdAt: nowIso,
                link: link('teacher-dashboard.html'),
                emailWorthy: true
            }));
        }

        // Currently formed teams
        const teams = all(
            `SELECT t.team_id, t.team_name, t.status, t.submitted_at, t.created_by
             FROM unit_teams t WHERE t.unit_id = ? ORDER BY t.rowid DESC`,
            [uid]
        );

        const teamInfo = teams.map(t => {
            const members = all(
                `SELECT tm.student_id, tm.status, us.name, us.is_new_to_qut, sup.tutorial_slots
                 FROM unit_team_members tm
                 LEFT JOIN unit_students us
                        ON us.unit_id = ? AND us.student_id = tm.student_id
                 LEFT JOIN student_unit_prefs sup
                        ON sup.unit_id = ? AND sup.student_id = tm.student_id
                 WHERE tm.team_id = ?`,
                [uid, uid, t.team_id]
            );
            const acceptedMembers = members.filter(m => m.status === 'ACCEPTED');
            const slotSets = acceptedMembers.map(m =>
                new Set((m.tutorial_slots || '').split(',').map(s => s.trim()).filter(Boolean))
            );
            const sharedTutorials = slotSets.length
                ? [...slotSets[0]].filter(slot => slotSets.every(s => s.has(slot)))
                : [];
            const newToQutCount = members.filter(m => m.is_new_to_qut == 1).length;

            const issues = [];
            if (!validSizes.includes(members.length))
                issues.push(`${members.length} member${members.length === 1 ? '' : 's'} (allowed: ${validSizes.join(' or ')})`);
            if (!sharedTutorials.length && unit.must_share_tutorial !== 0)
                issues.push('no shared tutorial slot');
            if (newToQutCount > (unit.max_new_to_qut || 2))
                issues.push(`${newToQutCount} new-to-QUT students (max ${unit.max_new_to_qut || 2})`);

            return { ...t, members, acceptedCount: acceptedMembers.length, issues };
        });

        // Teams waiting on the teacher's decision
        teamInfo.filter(t => t.status === 'SUBMITTED').forEach(t => {
            out.push(note({
                ...ctx,
                key: `team-review:${t.team_id}`,
                category: 'teams',
                severity: t.issues.length ? 'CRITICAL' : 'WARNING',
                title: t.issues.length
                    ? `"${t.team_name || 'Unnamed team'}" needs review — rule breaches`
                    : `"${t.team_name || 'Unnamed team'}" is awaiting your approval`,
                body: `${t.members.length} member${t.members.length === 1 ? '' : 's'}: ` +
                      `${t.members.map(m => m.name || m.student_id).join(', ')}.` +
                      (t.issues.length ? ` Rule breaches: ${t.issues.join('; ')}.` : ''),
                createdAt: t.submitted_at || nowIso,
                link: link('teacher-team-formation.html'),
                details: t.members.map(m => ({
                    label: m.name || m.student_id,
                    meta: m.status
                })),
                emailWorthy: true
            }));
        });

        // Summary of teams that have come together but are not submitted yet
        const formed = teamInfo.filter(t => t.status === 'FORMING');
        const complete = formed.filter(t => validSizes.includes(t.acceptedCount));
        if (formed.length) {
            out.push(note({
                ...ctx,
                key: `teams-forming:${uid}:${formed.length}:${complete.length}`,
                category: 'teams',
                severity: 'INFO',
                title: `${formed.length} team${formed.length === 1 ? '' : 's'} still forming in ${unit.unit_name}`,
                body: `${complete.length} of them already ${complete.length === 1 ? 'has' : 'have'} a valid team size ` +
                      `but ${complete.length === 1 ? 'has' : 'have'} not submitted a request yet.`,
                createdAt: nowIso,
                link: link('teacher-team-formation.html'),
                details: formed.map(t => ({
                    label: t.team_name || 'Unnamed team',
                    meta: `${t.acceptedCount} confirmed${t.issues.length ? ' · ' + t.issues.join('; ') : ''}`
                }))
            }));
        }

        const approved = teamInfo.filter(t => t.status === 'APPROVED');
        if (approved.length) {
            out.push(note({
                ...ctx,
                key: `teams-approved:${uid}:${approved.length}`,
                category: 'teams',
                severity: 'SUCCESS',
                title: `${approved.length} team${approved.length === 1 ? '' : 's'} approved in ${unit.unit_name}`,
                body: `These teams are locked in and visible to their members.`,
                createdAt: nowIso,
                link: link('teacher-team-formation.html'),
                details: approved.map(t => ({
                    label: t.team_name || 'Unnamed team',
                    meta: `${t.acceptedCount} members`
                }))
            }));
        }

        // Students at risk of not completing
        // At risk = has not submitted a team request AND either the
        // deadline is within a week or they have barely started.
        const atRisk = roster
            .filter(s => s.submitted_request != 1)
            .map(s => {
                const stagesDone = s.read_rules + s.entered_preferences + s.in_team + s.submitted_request;
                const missing = [];
                if (!s.read_rules)          missing.push('has not read the rules');
                if (!s.entered_preferences) missing.push('no preferences entered');
                if (!s.in_team)             missing.push('not in a team');
                else                        missing.push('team request not submitted');
                const urgent = daysLeft !== null && daysLeft <= 7;
                return { ...s, stagesDone, missing, urgent };
            })
            .filter(s => s.urgent || s.stagesDone < 2);

        if (atRisk.length) {
            const noTeam = atRisk.filter(s => !s.in_team).length;
            out.push(note({
                ...ctx,
                key: `at-risk:${uid}:${atRisk.length}:${noTeam}`,
                category: 'at-risk',
                severity: (daysLeft !== null && daysLeft <= 3) ? 'CRITICAL' : 'WARNING',
                title: `${atRisk.length} student${atRisk.length === 1 ? ' is' : 's are'} at risk in ${unit.unit_name}`,
                body: `${noTeam} of them ${noTeam === 1 ? 'is' : 'are'} not in a team yet` +
                      (daysLeft !== null
                          ? ` and the deadline is ${daysLeft < 0 ? 'already past' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} away`}.`
                          : '.') +
                      ` Consider posting an announcement to prompt them.`,
                createdAt: nowIso,
                link: link('teacher-class-list.html'),
                details: atRisk.map(s => ({
                    label: s.name || s.student_id,
                    meta: `${s.stagesDone}/4 steps · ${s.missing[0]}`
                })),
                emailWorthy: true
            }));
        }

        // Roster imported but nobody has started at all
        const started = roster.filter(s => s.read_rules == 1).length;
        if (roster.length && started === 0) {
            out.push(note({
                ...ctx,
                key: `not-started:${uid}:${roster.length}`,
                category: 'at-risk',
                severity: 'WARNING',
                title: `No students have started team formation in ${unit.unit_name}`,
                body: `All ${roster.length} enrolled student${roster.length === 1 ? ' has' : 's have'} yet to read the rules. ` +
                      `An announcement may help kick things off.`,
                createdAt: nowIso,
                link: link('teacher-announcements.html'),
                emailWorthy: true
            }));
        }
    });

    return sortNotifications(out);
}

function forUser(user, now = new Date()) {
    return user.role === 'TEACHER'
        ? teacherNotifications(user.username, now)
        : studentNotifications(user.username, now);
}

module.exports = {
    forUser, studentNotifications, teacherNotifications,
    SEVERITY_RANK, DEADLINE_STEPS
};

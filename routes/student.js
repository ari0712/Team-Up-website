const express = require('express');
const router  = express.Router();
const { all, get, run } = require('../db');
const { requireStudent } = require('../middleware/auth');
const crypto = require('crypto');

// Apply requireStudent to ALL routes in this file
router.use(requireStudent);

// Helper: get the calling student's ID
const sid = req => req.session.user.username;

// ── GET /api/student/units ─────────────────────────────────────
// List units the logged-in student is enrolled in
//router.get('/units', (req, res) => {
//    const units = all(
//        `SELECT u.unit_id, u.unit_name, u.description, u.semester, u.deadline,
//                u.valid_team_sizes, u.max_one_group, u.must_share_tutorial, u.max_new_to_qut
//         FROM units u
//         INNER JOIN unit_students us ON us.unit_id = u.unit_id
//         WHERE us.student_id = ?
//         ORDER BY u.rowid DESC`,
//        [sid(req)]
//    );
//    res.json(units);
//});

router.get('/units', (req, res) => {
    const units = all(
        `SELECT u.unit_id, u.unit_name, u.description, u.semester, u.deadline,
                u.valid_team_sizes, u.max_one_group, u.must_share_tutorial, u.max_new_to_qut,
                CASE WHEN us.student_id IS NOT NULL THEN 1 ELSE 0 END AS joined
         FROM units u
                  LEFT JOIN unit_students us
                            ON us.unit_id = u.unit_id AND us.student_id = ?
         ORDER BY u.rowid DESC`,
        [sid(req)]
    );
    res.json(units);
});

// ── POST /api/student/units/:unitId/join ──────────────────────────
router.post('/units/:unitId/join', (req, res) => {
    const unit = get(`SELECT * FROM units WHERE unit_id = ?`, [req.params.unitId]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    // Check not already joined
    const already = get(
        `SELECT 1 FROM unit_students WHERE unit_id = ? AND student_id = ?`,
        [req.params.unitId, sid(req)]
    );
    if (already) return res.json({ ok: true, alreadyJoined: true });

    // Get student display name from the students/users table
    const studentRow = get(
        `SELECT s.display_name, u.email
         FROM users u
         LEFT JOIN students s ON s.username = u.username
         WHERE u.username = ?`,
        [sid(req)]
    );
    const displayName = studentRow?.display_name || sid(req);

    // Insert into unit_students
    run(
        `INSERT INTO unit_students (unit_id, student_id, name) VALUES (?,?,?)`,
        [req.params.unitId, sid(req), displayName]
    );

    // Create student_progress row
    run(
        `INSERT OR IGNORE INTO student_progress (unit_id, student_id) VALUES (?,?)`,
        [req.params.unitId, sid(req)]
    );

    res.json({ ok: true, alreadyJoined: false });
});

// ── GET /api/student/units/:unitId ────────────────────────────
// Single unit details (used by Rules page)
router.get('/units/:unitId', (req, res) => {
    // Verify student is enrolled
    const enrolled = get(
        `SELECT 1 FROM unit_students WHERE unit_id = ? AND student_id = ?`,
        [req.params.unitId, sid(req)]
    );
    if (!enrolled) return res.status(403).json({ error: 'NOT_JOINED' });

    const unit = get(`SELECT * FROM units WHERE unit_id = ?`, [req.params.unitId]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    res.json(unit);
});

// ── GET /api/student/units/:unitId/progress ───────────────────
router.get('/units/:unitId/progress', (req, res) => {
    const row = get(
        `SELECT * FROM student_progress WHERE unit_id = ? AND student_id = ?`,
        [req.params.unitId, sid(req)]
    );
    res.json(row || {
        read_rules: 0, entered_preferences: 0,
        in_team: 0, submitted_request: 0, teacher_approved: 0
    });
});

// ── PUT /api/student/units/:unitId/progress ───────────────────
// Body: { stage: 'read_rules', value: 1 }
router.put('/units/:unitId/progress', (req, res) => {
    const { stage, value } = req.body;
    const valid = ['read_rules','entered_preferences','in_team','submitted_request'];
    if (!valid.includes(stage))
        return res.status(400).json({ error: 'Invalid stage' });
    run(
        `UPDATE student_progress SET ${stage} = ? WHERE unit_id = ? AND student_id = ?`,
        [value ? 1 : 0, req.params.unitId, sid(req)]
    );
    res.json({ ok: true });
});

// ── GET /api/student/units/:unitId/prefs ──────────────────────
router.get('/units/:unitId/prefs', (req, res) => {
    const row = get(
        `SELECT * FROM student_unit_prefs WHERE unit_id = ? AND student_id = ?`,
        [req.params.unitId, sid(req)]
    );
    res.json(row || null);
});

// ── POST /api/student/units/:unitId/prefs ─────────────────────
// Body: { tutorialSlots, projectInterests, skills, preferredRole, preferredTeammates }
router.post('/units/:unitId/prefs', (req, res) => {
    const { tutorialSlots, projectInterests, skills, preferredRole, preferredTeammates } = req.body;
    const now = new Date().toISOString();
    run(
        `INSERT INTO student_unit_prefs
           (unit_id, student_id, tutorial_slots, project_interests, skills, preferred_role, preferred_teammates, saved_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(unit_id, student_id) DO UPDATE SET
           tutorial_slots=excluded.tutorial_slots,
           project_interests=excluded.project_interests,
           skills=excluded.skills,
           preferred_role=excluded.preferred_role,
           preferred_teammates=excluded.preferred_teammates,
           saved_at=excluded.saved_at`,
        [
            req.params.unitId, sid(req),
            Array.isArray(tutorialSlots) ? tutorialSlots.join(',') : (tutorialSlots || ''),
            Array.isArray(projectInterests) ? projectInterests.join(',') : (projectInterests || ''),
            Array.isArray(skills) ? skills.join(',') : (skills || ''),
            preferredRole || '',
            preferredTeammates || 'None',
            now
        ]
    );
    // Mark entered_preferences stage
    run(
        `UPDATE student_progress SET entered_preferences = 1 WHERE unit_id = ? AND student_id = ?`,
        [req.params.unitId, sid(req)]
    );
    res.json({ ok: true });
});

// ── GET /api/student/units/:unitId/students ───────────────────
// Search/filter classmates. Query params: search, tutorial, interest, skill
router.get('/units/:unitId/students', (req, res) => {
    const { search, tutorial, interest, skill } = req.query;
    let students = all(
        `SELECT us.student_id, us.name, us.tutorial_time, us.is_new_to_qut,
                sup.tutorial_slots, sup.project_interests, sup.skills, sup.preferred_role
         FROM unit_students us
         LEFT JOIN student_unit_prefs sup ON sup.unit_id = us.unit_id AND sup.student_id = us.student_id
         WHERE us.unit_id = ? AND us.student_id != ?`,
        [req.params.unitId, sid(req)]
    );
    if (search) {
        const q = search.toLowerCase();
        students = students.filter(s => s.name.toLowerCase().includes(q) || s.student_id.toLowerCase().includes(q));
    }
    if (tutorial) students = students.filter(s => (s.tutorial_slots || s.tutorial_time || '').includes(tutorial));
    if (interest) students = students.filter(s => (s.project_interests || '').includes(interest));
    if (skill)    students = students.filter(s => (s.skills || '').includes(skill));
    res.json(students);
});

// ── GET /api/student/units/:unitId/my-team ────────────────────
router.get('/units/:unitId/my-team', (req, res) => {
    // Find this student's team in this unit
    const membership = get(
        `SELECT tm.team_id FROM unit_team_members tm
         INNER JOIN unit_teams t ON t.team_id = tm.team_id
         WHERE t.unit_id = ? AND tm.student_id = ?`,
        [req.params.unitId, sid(req)]
    );
    if (!membership) return res.json({ team: null });

    const team = get(`SELECT * FROM unit_teams WHERE team_id = ?`, [membership.team_id]);
    const members = all(
        `SELECT tm.student_id, tm.role, tm.status, us.name, us.is_new_to_qut,
                sup.tutorial_slots
         FROM unit_team_members tm
         INNER JOIN unit_students us ON us.unit_id = ? AND us.student_id = tm.student_id
         LEFT JOIN student_unit_prefs sup ON sup.unit_id = ? AND sup.student_id = tm.student_id
         WHERE tm.team_id = ?`,
        [req.params.unitId, req.params.unitId, membership.team_id]
    );

    // Run validation
    const unit = get(`SELECT * FROM units WHERE unit_id = ?`, [req.params.unitId]);
    const acceptedMembers = members.filter(m => m.status === 'ACCEPTED');
    const validSizes = (unit.valid_team_sizes || '4').split(',').map(s => parseInt(s.trim()));

    // Tutorial overlap among accepted members
    let sharedTutorial = null;
    if (acceptedMembers.length > 0) {
        const slotSets = acceptedMembers.map(m => new Set((m.tutorial_slots || m.tutorial_time || '').split(',').map(s => s.trim()).filter(Boolean)));
        if (slotSets.length > 0) {
            sharedTutorial = [...slotSets[0]].filter(slot => slotSets.every(s => s.has(slot)));
        }
    }

    const newToQutCount = members.filter(m => m.is_new_to_qut == 1).length;
    const allAccepted = members.every(m => m.status === 'ACCEPTED');

    const validation = {
        sizeValid:       validSizes.includes(members.length),
        tutorialShared:  sharedTutorial && sharedTutorial.length > 0,
        newToQutOk:      newToQutCount <= (unit.max_new_to_qut || 2),
        allAccepted:     allAccepted,
        sharedTutorials: sharedTutorial || [],
        newToQutCount,
        maxNewToQut:     unit.max_new_to_qut || 2
    };

    res.json({ team, members, validation });
});

// ── POST /api/student/units/:unitId/teams ─────────────────────
// Create a new team. Body: { teamName }
router.post('/units/:unitId/teams', (req, res) => {
    // Check student isn't already in a team
    const existing = get(
        `SELECT tm.team_id FROM unit_team_members tm
         INNER JOIN unit_teams t ON t.team_id = tm.team_id
         WHERE t.unit_id = ? AND tm.student_id = ?`,
        [req.params.unitId, sid(req)]
    );
    if (existing) return res.status(409).json({ error: 'You are already in a team for this unit' });

    const teamId = crypto.randomUUID();
    run(
        `INSERT INTO unit_teams (team_id, unit_id, team_name, created_by) VALUES (?,?,?,?)`,
        [teamId, req.params.unitId, (req.body.teamName || 'My Team').trim(), sid(req)]
    );
    // Get the student's preferred role from their prefs
    const prefs = get(
        `SELECT preferred_role FROM student_unit_prefs WHERE unit_id = ? AND student_id = ?`,
        [req.params.unitId, sid(req)]
    );
    run(
        `INSERT INTO unit_team_members (team_id, student_id, role, status) VALUES (?,?,?,?)`,
        [teamId, sid(req), prefs ? prefs.preferred_role : '', 'ACCEPTED']
    );
    run(
        `UPDATE student_progress SET in_team = 1 WHERE unit_id = ? AND student_id = ?`,
        [req.params.unitId, sid(req)]
    );
    res.json({ ok: true, teamId });
});

// ── POST /api/student/units/:unitId/teams/:teamId/invite ──────
// Body: { toStudentId }
router.post('/units/:unitId/teams/:teamId/invite', (req, res) => {
    const { toStudentId } = req.body;
    if (!toStudentId) return res.status(400).json({ error: 'toStudentId required' });

    // Verify caller is in this team
    const membership = get(
        `SELECT 1 FROM unit_team_members WHERE team_id = ? AND student_id = ?`,
        [req.params.teamId, sid(req)]
    );
    if (!membership) return res.status(403).json({ error: 'You are not in this team' });

    // Check target isn't already in a team
    const alreadyIn = get(
        `SELECT 1 FROM unit_team_members tm
         INNER JOIN unit_teams t ON t.team_id = tm.team_id
         WHERE t.unit_id = ? AND tm.student_id = ?`,
        [req.params.unitId, toStudentId]
    );
    if (alreadyIn) return res.status(409).json({ error: 'That student is already in a team' });

    const inviteId = crypto.randomUUID();
    run(
        `INSERT INTO unit_team_invites (invite_id, unit_id, team_id, from_student, to_student, sent_at)
         VALUES (?,?,?,?,?,?)`,
        [inviteId, req.params.unitId, req.params.teamId, sid(req), toStudentId, new Date().toISOString()]
    );
    // Add member row as WAITING
    const prefs = get(
        `SELECT preferred_role FROM student_unit_prefs WHERE unit_id = ? AND student_id = ?`,
        [req.params.unitId, toStudentId]
    );
    run(
        `INSERT OR IGNORE INTO unit_team_members (team_id, student_id, role, status) VALUES (?,?,?,?)`,
        [req.params.teamId, toStudentId, prefs ? prefs.preferred_role : '', 'WAITING']
    );
    res.json({ ok: true, inviteId });
});

// ── GET /api/student/units/:unitId/invites ────────────────────
// Pending invites for the logged-in student
router.get('/units/:unitId/invites', (req, res) => {
    const invites = all(
        `SELECT i.*, t.team_name, us.name as from_name
         FROM unit_team_invites i
         INNER JOIN unit_teams t ON t.team_id = i.team_id
         INNER JOIN unit_students us ON us.unit_id = i.unit_id AND us.student_id = i.from_student
         WHERE i.unit_id = ? AND i.to_student = ? AND i.status = 'PENDING'`,
        [req.params.unitId, sid(req)]
    );
    res.json(invites);
});

// ── PUT /api/student/units/:unitId/invites/:inviteId ──────────
// Body: { action: 'accept' | 'decline' }
router.put('/units/:unitId/invites/:inviteId', (req, res) => {
    const { action } = req.body;
    if (!['accept','decline'].includes(action))
        return res.status(400).json({ error: 'action must be accept or decline' });

    const invite = get(
        `SELECT * FROM unit_team_invites WHERE invite_id = ? AND to_student = ?`,
        [req.params.inviteId, sid(req)]
    );
    if (!invite) return res.status(404).json({ error: 'Invite not found' });

    run(`UPDATE unit_team_invites SET status = ? WHERE invite_id = ?`,
        [action === 'accept' ? 'ACCEPTED' : 'DECLINED', req.params.inviteId]);

    if (action === 'accept') {
        run(`UPDATE unit_team_members SET status = 'ACCEPTED' WHERE team_id = ? AND student_id = ?`,
            [invite.team_id, sid(req)]);
        run(`UPDATE student_progress SET in_team = 1 WHERE unit_id = ? AND student_id = ?`,
            [req.params.unitId, sid(req)]);
    } else {
        run(`DELETE FROM unit_team_members WHERE team_id = ? AND student_id = ?`,
            [invite.team_id, sid(req)]);
    }
    res.json({ ok: true });
});

// ── DELETE /api/student/units/:unitId/teams/:teamId/members/:studentId ──
router.delete('/units/:unitId/teams/:teamId/members/:studentId', (req, res) => {
    // Only team creator can remove members
    const team = get(`SELECT * FROM unit_teams WHERE team_id = ? AND created_by = ?`,
        [req.params.teamId, sid(req)]);
    if (!team) return res.status(403).json({ error: 'Only the team creator can remove members' });

    run(`DELETE FROM unit_team_members WHERE team_id = ? AND student_id = ?`,
        [req.params.teamId, req.params.studentId]);
    run(`UPDATE student_progress SET in_team = 0 WHERE unit_id = ? AND student_id = ?`,
        [req.params.unitId, req.params.studentId]);
    // Cancel any pending invites for them
    run(`UPDATE unit_team_invites SET status = 'DECLINED' WHERE team_id = ? AND to_student = ?`,
        [req.params.teamId, req.params.studentId]);
    res.json({ ok: true });
});

// ── DELETE /api/student/units/:unitId/teams/:teamId/leave ──────
router.delete('/units/:unitId/teams/:teamId/leave', (req, res) => {
    const studentId = sid(req);
    const team = get(`SELECT * FROM unit_teams WHERE team_id = ? AND unit_id = ?`,
        [req.params.teamId, req.params.unitId]);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const membership = get(`SELECT * FROM unit_team_members WHERE team_id = ? AND student_id = ?`,
        [req.params.teamId, studentId]);
    if (!membership) return res.status(400).json({ error: 'You are not in this team' });

    if (team.status !== 'FORMING')
        return res.status(400).json({ error: 'Cannot leave a submitted team' });

    run(`DELETE FROM unit_team_members WHERE team_id = ? AND student_id = ?`,
        [req.params.teamId, studentId]);
    run(`UPDATE student_progress SET in_team = 0 WHERE unit_id = ? AND student_id = ?`,
        [req.params.unitId, studentId]);
    run(`UPDATE unit_team_invites SET status = 'DECLINED' WHERE team_id = ? AND to_student = ?`,
        [req.params.teamId, studentId]);

    const remaining = all(`SELECT * FROM unit_team_members WHERE team_id = ?`, [req.params.teamId]);
    if (remaining.length === 0) {
        run(`DELETE FROM unit_teams WHERE team_id = ?`, [req.params.teamId]);
    } else if (team.created_by === studentId) {
        const newOwner = remaining.find(m => m.status === 'ACCEPTED') || remaining[0];
        run(`UPDATE unit_teams SET created_by = ? WHERE team_id = ?`, [newOwner.student_id, req.params.teamId]);
    }

    res.json({ ok: true });
});

// ── POST /api/student/units/:unitId/teams/:teamId/submit ──────
router.post('/units/:unitId/teams/:teamId/submit', (req, res) => {
    const team = get(`SELECT * FROM unit_teams WHERE team_id = ? AND unit_id = ?`,
        [req.params.teamId, req.params.unitId]);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (team.status !== 'FORMING')
        return res.status(400).json({ error: 'Team has already been submitted' });

    const members = all(`SELECT * FROM unit_team_members WHERE team_id = ?`, [req.params.teamId]);
    if (members.some(m => m.status === 'WAITING'))
        return res.status(400).json({ error: 'All members must accept before submitting' });

    run(`UPDATE unit_teams SET status = 'SUBMITTED', submitted_at = ? WHERE team_id = ?`,
        [new Date().toISOString(), req.params.teamId]);

    members.forEach(m => {
        run(`UPDATE student_progress SET submitted_request = 1 WHERE unit_id = ? AND student_id = ?`,
            [req.params.unitId, m.student_id]);
    });
    res.json({ ok: true });
});

module.exports = router;
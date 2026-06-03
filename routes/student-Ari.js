const express = require('express');
const router  = express.Router();
const { all, get, run } = require('../db');
const { requireStudent } = require('../middleware/auth');
const proposalService = require('../services/proposalService');
const crypto = require('crypto');

// Apply requireStudent to ALL routes in this file
router.use(requireStudent);

// Helper: get the calling student's ID
const sid = req => req.session.user.username;

// Create a team-of-1 for a student in a unit. Used by:
//   - POST /units/:unitId/join (eager creation on enrollment)
//   - DELETE /units/:unitId/teams/:teamId/leave (move leaver to a fresh team)
//   - DELETE /units/:unitId/teams/:teamId/members/:studentId (kicked → fresh team)
function createTeamOfOne(unitId, studentId) {
    const prefs = get(
        `SELECT preferred_role FROM student_unit_prefs WHERE unit_id = ? AND student_id = ?`,
        [unitId, studentId]
    );
    const role = prefs?.preferred_role || '';
    const maxRow = get(
        `SELECT MAX(team_number) AS m FROM unit_teams WHERE unit_id = ?`,
        [unitId]
    );
    const teamNumber = (maxRow?.m || 0) + 1;
    const teamId = crypto.randomUUID();
    run(
        `INSERT INTO unit_teams (team_id, unit_id, team_name, team_number, created_by, status)
         VALUES (?,?,?,?,?, 'FORMING')`,
        [teamId, unitId, `Team ${teamNumber}`, teamNumber, studentId]
    );
    run(
        `INSERT INTO unit_team_members (team_id, student_id, role, status)
         VALUES (?,?,?, 'ACCEPTED')`,
        [teamId, studentId, role]
    );
    run(
        `UPDATE student_progress SET in_team = 1 WHERE unit_id = ? AND student_id = ?`,
        [unitId, studentId]
    );
    return teamId;
}

// Translate ServiceError thrown by proposalService into an HTTP response.
function handleServiceError(res, e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error('Unexpected proposal service error:', e);
    return res.status(500).json({ error: 'Internal error' });
}

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

    // Eager team-of-1 so every enrolled student is always on a team.
    createTeamOfOne(req.params.unitId, sid(req));

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

// ── GET /api/student/units/:unitId/announcements ──────────────
// All announcements posted by the teacher for this unit, newest first.
router.get('/units/:unitId/announcements', (req, res) => {
    const enrolled = get(
        `SELECT 1 FROM unit_students WHERE unit_id = ? AND student_id = ?`,
        [req.params.unitId, sid(req)]
    );
    if (!enrolled) return res.status(403).json({ error: 'NOT_JOINED' });

    const announcements = all(
        `SELECT id, title, content, created_at FROM unit_announcements
          WHERE unit_id = ? ORDER BY id DESC`,
        [req.params.unitId]
    );
    res.json(announcements);
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

// ── GET /api/student/units/:unitId/tutorial-slots ─────────────
router.get('/units/:unitId/tutorial-slots', (req, res) => {
    const slots = all(
        `SELECT slot_id, label, sort_order FROM unit_tutorial_slots
          WHERE unit_id = ? ORDER BY sort_order, label`,
        [req.params.unitId]
    );
    res.json(slots);
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
                sup.tutorial_slots, sup.project_interests, sup.skills, sup.preferred_role,
                (SELECT tm.team_id FROM unit_team_members tm
                   INNER JOIN unit_teams t ON t.team_id = tm.team_id
                  WHERE tm.student_id = us.student_id AND t.unit_id = us.unit_id
                  LIMIT 1) AS team_id
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

    const validation = {
        sizeValid:       validSizes.includes(members.length),
        tutorialShared:  sharedTutorial && sharedTutorial.length > 0,
        newToQutOk:      newToQutCount <= (unit.max_new_to_qut || 2),
        sharedTutorials: sharedTutorial || [],
        newToQutCount,
        maxNewToQut:     unit.max_new_to_qut || 2
    };

    res.json({ team, members, validation });
});

// ── GET /api/student/units/:unitId/teams/:teamId ──────────────
// Read-only view of any team in the unit (name, accepted members, max size).
// Used by the classmate profile so a student can see what they'd be merging into.
router.get('/units/:unitId/teams/:teamId', (req, res) => {
    const team = get(
        `SELECT team_id, team_name, team_number, status FROM unit_teams
         WHERE team_id = ? AND unit_id = ?`,
        [req.params.teamId, req.params.unitId]
    );
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const members = all(
        `SELECT tm.student_id, tm.role, tm.status, us.name
         FROM unit_team_members tm
         INNER JOIN unit_students us ON us.unit_id = ? AND us.student_id = tm.student_id
         WHERE tm.team_id = ? AND tm.status = 'ACCEPTED'`,
        [req.params.unitId, req.params.teamId]
    );

    const unit = get(`SELECT valid_team_sizes FROM units WHERE unit_id = ?`, [req.params.unitId]);
    const sizes = (unit?.valid_team_sizes || '4').split(',').map(s => parseInt(s.trim())).filter(Boolean);
    const maxSize = sizes.length ? Math.max(...sizes) : 4;

    res.json({ team, members, maxSize });
});

// ── POST /api/student/units/:unitId/proposals ─────────────────
// Body: { targetTeamId }. Source team is the caller's team in this unit.
router.post('/units/:unitId/proposals', (req, res) => {
    const { targetTeamId } = req.body || {};
    const callerTeam = get(
        `SELECT tm.team_id FROM unit_team_members tm
         INNER JOIN unit_teams t ON t.team_id = tm.team_id
         WHERE t.unit_id = ? AND tm.student_id = ?`,
        [req.params.unitId, sid(req)]
    );
    if (!callerTeam) return res.status(400).json({ error: 'You are not on a team in this unit' });

    try {
        const result = proposalService.createProposal({
            unitId: req.params.unitId,
            sourceTeamId: callerTeam.team_id,
            targetTeamId,
            initiatorId: sid(req),
        });
        res.json({ proposalId: result.proposalId, state: result.state });
    } catch (e) { handleServiceError(res, e); }
});

// ── GET /api/student/units/:unitId/proposals ──────────────────
router.get('/units/:unitId/proposals', (req, res) => {
    try {
        res.json(proposalService.listProposalsForStudent(req.params.unitId, sid(req)));
    } catch (e) { handleServiceError(res, e); }
});

// ── GET /api/student/units/:unitId/proposals/:id ──────────────
router.get('/units/:unitId/proposals/:id', (req, res) => {
    try {
        res.json(proposalService.getProposalDetail(req.params.unitId, req.params.id, sid(req)));
    } catch (e) { handleServiceError(res, e); }
});

// ── PATCH /api/student/units/:unitId/proposals/:id/vote ───────
// Body: { vote: 'yes' | 'no' }
router.patch('/units/:unitId/proposals/:id/vote', (req, res) => {
    try {
        const result = proposalService.castVote({
            proposalId: req.params.id,
            studentId: sid(req),
            vote: (req.body || {}).vote,
        });
        res.json(result);
    } catch (e) { handleServiceError(res, e); }
});

// ── PATCH /api/student/units/:unitId/proposals/:id/seen ───────
router.patch('/units/:unitId/proposals/:id/seen', (req, res) => {
    try {
        proposalService.markSeen({ proposalId: req.params.id, studentId: sid(req) });
        res.json({ ok: true });
    } catch (e) { handleServiceError(res, e); }
});

// ── DELETE /api/student/units/:unitId/teams/:teamId/members/:studentId ──
// Team creator kicks a teammate. Kicked student is moved to a fresh team-of-1
// (we keep the "every student is a team" invariant) and any open proposal
// they're part of is invalidated.
router.delete('/units/:unitId/teams/:teamId/members/:studentId', (req, res) => {
    const team = get(`SELECT * FROM unit_teams WHERE team_id = ? AND created_by = ?`,
        [req.params.teamId, sid(req)]);
    if (!team) return res.status(403).json({ error: 'Only the team creator can remove members' });
    if (team.status !== 'FORMING')
        return res.status(400).json({ error: 'Cannot modify a submitted team' });

    const kicked = req.params.studentId;
    if (kicked === sid(req))
        return res.status(400).json({ error: 'Use the leave endpoint to remove yourself' });

    const membership = get(
        `SELECT 1 AS ok FROM unit_team_members WHERE team_id = ? AND student_id = ?`,
        [req.params.teamId, kicked]
    );
    if (!membership) return res.status(404).json({ error: 'Member not on this team' });

    proposalService.invalidateProposalsForStudent(kicked);
    run(`DELETE FROM unit_team_members WHERE team_id = ? AND student_id = ?`,
        [req.params.teamId, kicked]);
    createTeamOfOne(req.params.unitId, kicked);

    res.json({ ok: true });
});

// ── DELETE /api/student/units/:unitId/teams/:teamId/leave ──────
// Caller leaves a multi-member team. They get moved to a fresh team-of-1
// (every student is always on a team). Open proposals they participate in
// are invalidated. A team-of-1 has no one to leave from → 400.
router.delete('/units/:unitId/teams/:teamId/leave', (req, res) => {
    const studentId = sid(req);
    const team = get(`SELECT * FROM unit_teams WHERE team_id = ? AND unit_id = ?`,
        [req.params.teamId, req.params.unitId]);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (team.status !== 'FORMING')
        return res.status(400).json({ error: 'Cannot leave a submitted team' });

    const membership = get(`SELECT * FROM unit_team_members WHERE team_id = ? AND student_id = ?`,
        [req.params.teamId, studentId]);
    if (!membership) return res.status(400).json({ error: 'You are not in this team' });

    const memberCount = all(`SELECT 1 FROM unit_team_members WHERE team_id = ?`,
        [req.params.teamId]).length;
    if (memberCount <= 1)
        return res.status(400).json({ error: 'You are not in a team with anyone to leave' });

    proposalService.invalidateProposalsForStudent(studentId);
    run(`DELETE FROM unit_team_members WHERE team_id = ? AND student_id = ?`,
        [req.params.teamId, studentId]);

    // If the leaver was the creator, transfer ownership of the surviving team.
    if (team.created_by === studentId) {
        const remaining = all(`SELECT * FROM unit_team_members WHERE team_id = ?`,
            [req.params.teamId]);
        const newOwner = remaining.find(m => m.status === 'ACCEPTED') || remaining[0];
        if (newOwner) {
            run(`UPDATE unit_teams SET created_by = ? WHERE team_id = ?`,
                [newOwner.student_id, req.params.teamId]);
        }
    }

    createTeamOfOne(req.params.unitId, studentId);
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

    run(`UPDATE unit_teams SET status = 'SUBMITTED', submitted_at = ? WHERE team_id = ?`,
        [new Date().toISOString(), req.params.teamId]);

    members.forEach(m => {
        run(`UPDATE student_progress SET submitted_request = 1 WHERE unit_id = ? AND student_id = ?`,
            [req.params.unitId, m.student_id]);
    });

    // Submitting locks the team — any in-flight proposal involving it must be
    // invalidated. resolveProposal sees the non-FORMING state and flips it.
    const inflight = all(
        `SELECT proposal_id FROM proposals
          WHERE state = 'open' AND (source_team_id = ? OR target_team_id = ?)`,
        [req.params.teamId, req.params.teamId]
    );
    for (const p of inflight) {
        try { proposalService.resolveProposal(p.proposal_id); }
        catch (e) { console.error('Submit-time proposal resolve failed:', e.message); }
    }

    res.json({ ok: true });
});

module.exports = router;
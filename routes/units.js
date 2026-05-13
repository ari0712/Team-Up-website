const express = require('express');
const router  = express.Router();
const { all, run, get } = require('../db');
const { requireTeacher, requireStudent } = require('../middleware/auth');
const { parseTeamSizesCsv } = require('../utils/teamSizes');
const crypto = require('crypto');

// ── GET /api/units — list teacher's units ────────────────────────
router.get('/', requireTeacher, (req, res) => {
    const units = all(
        `SELECT u.*,
            (SELECT COUNT(*) FROM unit_students us WHERE us.unit_id = u.unit_id) AS student_count,
            (SELECT COUNT(DISTINCT tm.student_id)
             FROM unit_team_members tm
             INNER JOIN unit_teams t ON t.team_id = tm.team_id
             WHERE t.unit_id = u.unit_id AND tm.status = 'ACCEPTED') AS students_in_teams
         FROM units u
         WHERE u.created_by = ?
         ORDER BY u.rowid DESC`,
        [req.session.user.username]
    );
    res.json(units);
});

// ── GET /api/units/student/enrolled ──────────────────────────────
router.get('/student/enrolled', requireStudent, (req, res) => {
    const studentId = req.session.user.username;
    const units = all(
        `SELECT u.unit_id, u.unit_name, u.description, u.semester
         FROM units u
         INNER JOIN unit_students us ON us.unit_id = u.unit_id
         WHERE us.student_id = ?
         ORDER BY u.rowid DESC`,
        [studentId]
    );
    res.json(units);
});

// ── GET /api/units/:unitId — single unit ─────────────────────────
router.get('/:unitId', requireTeacher, (req, res) => {
    const unit = get(
        'SELECT * FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]
    );
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    res.json(unit);
});

// ── POST /api/units — create unit + import students ──────────────
router.post('/', requireTeacher, (req, res) => {
    const {
        unitName, description, semester, deadline,
        validTeamSizes, maxOneGroup, mustShareTutorial,
        maxNewToQut, students
    } = req.body;

    if (!unitName || !unitName.trim())
        return res.status(400).json({ error: 'Unit name is required' });

    if (validTeamSizes !== undefined && parseTeamSizesCsv(validTeamSizes) === null)
        return res.status(400).json({ error: 'validTeamSizes must be comma-separated positive integers' });

    const unitId       = crypto.randomUUID();
    const studentCount = Array.isArray(students) ? students.length : 0;

    run(
        `INSERT INTO units
       (unit_id, unit_name, description, semester, deadline, created_by,
        valid_team_sizes, max_one_group, must_share_tutorial, max_new_to_qut, student_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
            unitId,
            unitName.trim(),
            (description || '').trim(),
            (semester    || '').trim(),
            (deadline    || '').trim(),
            req.session.user.username,
            (validTeamSizes || '4'),
            maxOneGroup       ? 1 : 0,
            mustShareTutorial ? 1 : 0,
            parseInt(maxNewToQut) || 2,
            studentCount
        ]
    );

    // Bulk-import students from parsed CSV
    if (Array.isArray(students) && students.length > 0) {
        students.forEach(s => {
            const sid = (s.student_id || '').trim();
            if (!sid) return;
            run(
                `INSERT OR REPLACE INTO unit_students
           (unit_id, student_id, name, tutorial_time, is_new_to_qut,
            degree, major, minor, units_passed, it_skill_groups)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
                [
                    unitId, sid,
                    s.name           || '',
                    s.tutorial_time  || '',
                    ('1' === String(s.is_new_to_qut) || s.is_new_to_qut === true) ? 1 : 0,
                    s.degree         || '',
                    s.major          || '',
                    s.minor          || '',
                    parseInt(s.units_passed) || 0,
                    s.it_skill_groups || ''
                ]
            );
            // Initialise progress row for each student
            run(
                `INSERT OR IGNORE INTO student_progress (unit_id, student_id) VALUES (?,?)`,
                [unitId, sid]
            );
        });
    }

    res.json({ ok: true, unitId });
});

// ── GET /api/units/:unitId/progress — aggregated counts ──────────
router.get('/:unitId/progress', requireTeacher, (req, res) => {
    const unit = get(
        'SELECT * FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]
    );
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    const stats = get(
        `SELECT
       COALESCE(SUM(read_rules),          0) AS readRules,
       COALESCE(SUM(entered_preferences), 0) AS enteredPrefs,
       COALESCE(SUM(in_team),             0) AS inTeam,
       COALESCE(SUM(submitted_request),   0) AS submittedRequest
     FROM student_progress WHERE unit_id = ?`,
        [req.params.unitId]
    );

    const liveCount = get(
        `SELECT COUNT(*) AS cnt FROM unit_students WHERE unit_id = ?`,
        [req.params.unitId]
    );

    res.json({
        total:            liveCount.cnt        || 0,
        readRules:        stats.readRules      || 0,
        enteredPrefs:     stats.enteredPrefs   || 0,
        inTeam:           stats.inTeam         || 0,
        submittedRequest: stats.submittedRequest || 0
    });
});

// ── PUT /api/units/:unitId/progress/:studentId — update a stage ──
// Used by student portal later; teachers can also call it manually
router.put('/:unitId/progress/:studentId', requireTeacher, (req, res) => {
    const { stage, value } = req.body;
    const valid = ['read_rules','entered_preferences','in_team','submitted_request'];
    if (!valid.includes(stage))
        return res.status(400).json({ error: 'Invalid stage name' });

    run(
        `UPDATE student_progress SET ${stage} = ? WHERE unit_id = ? AND student_id = ?`,
        [value ? 1 : 0, req.params.unitId, req.params.studentId]
    );
    res.json({ ok: true });
});

// ── GET /api/units/:unitId/team-requests ──────────────────────
router.get('/:unitId/team-requests', requireTeacher, (req, res) => {
    const unit = get('SELECT * FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    const teams = all(
        `SELECT t.*, COUNT(tm.student_id) as member_count
         FROM unit_teams t
         LEFT JOIN unit_team_members tm ON tm.team_id = t.team_id
         WHERE t.unit_id = ? AND t.status IN ('SUBMITTED','APPROVED','REJECTED')
         GROUP BY t.team_id
         ORDER BY t.submitted_at DESC`,
        [req.params.unitId]
    );
    const result = teams.map(team => {
        const members = all(
            `SELECT tm.student_id, tm.role, tm.status, us.name
             FROM unit_team_members tm
             INNER JOIN unit_students us ON us.unit_id = ? AND us.student_id = tm.student_id
             WHERE tm.team_id = ?`,
            [req.params.unitId, team.team_id]
        );
        return { ...team, members };
    });
    res.json(result);
});

// ── PUT /api/units/:unitId/team-requests/:teamId ──────────────
// Body: { action: 'approve' | 'reject' }
router.put('/:unitId/team-requests/:teamId', requireTeacher, (req, res) => {
    const { action } = req.body;
    if (!['approve','reject'].includes(action))
        return res.status(400).json({ error: 'action must be approve or reject' });

    const unit = get('SELECT * FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
    run(`UPDATE unit_teams SET status = ? WHERE team_id = ?`,
        [newStatus, req.params.teamId]);

    if (action === 'approve') {
        const members = all(`SELECT student_id FROM unit_team_members WHERE team_id = ?`,
            [req.params.teamId]);
        members.forEach(m => {
            run(`UPDATE student_progress SET teacher_approved = 1 WHERE unit_id = ? AND student_id = ?`,
                [req.params.unitId, m.student_id]);
        });
    }
    res.json({ ok: true });
});

// ── GET /api/units/:unitId/all-teams ──────────────────────────
// Returns all teams in the unit with members + validation result
router.get('/:unitId/all-teams', requireTeacher, (req, res) => {
    const unit = get('SELECT * FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    const teams = all(
        `SELECT t.*, COUNT(tm.student_id) as member_count
         FROM unit_teams t
         LEFT JOIN unit_team_members tm ON tm.team_id = t.team_id
         WHERE t.unit_id = ?
         GROUP BY t.team_id
         ORDER BY t.rowid DESC`,
        [req.params.unitId]
    );

    const validSizes = (unit.valid_team_sizes || '4').split(',').map(s => parseInt(s.trim()));

    const result = teams.map(team => {
        const members = all(
            `SELECT tm.student_id, tm.role, tm.status, us.name, us.is_new_to_qut,
                    sup.tutorial_slots
             FROM unit_team_members tm
             INNER JOIN unit_students us ON us.unit_id = ? AND us.student_id = tm.student_id
             LEFT JOIN student_unit_prefs sup ON sup.unit_id = ? AND sup.student_id = tm.student_id
             WHERE tm.team_id = ?`,
            [req.params.unitId, req.params.unitId, team.team_id]
        );

        const acceptedMembers = members.filter(m => m.status === 'ACCEPTED');
        const slotSets = acceptedMembers.map(m =>
            new Set((m.tutorial_slots || '').split(',').map(s => s.trim()).filter(Boolean))
        );
        const sharedTutorials = slotSets.length > 0
            ? [...slotSets[0]].filter(slot => slotSets.every(s => s.has(slot)))
            : [];

        const newToQutCount = members.filter(m => m.is_new_to_qut == 1).length;

        const validation = {
            sizeValid:       validSizes.includes(members.length),
            tutorialShared:  sharedTutorials.length > 0,
            sharedTutorials,
            newToQutOk:      newToQutCount <= (unit.max_new_to_qut || 2),
            allAccepted:     members.every(m => m.status === 'ACCEPTED'),
            newToQutCount,
            maxNewToQut:     unit.max_new_to_qut || 2
        };

        return { ...team, members, validation };
    });

    res.json(result);
});

// ── GET /api/units/:unitId/class-list ─────────────────────────
// All students in the unit with their individual progress stages
router.get('/:unitId/class-list', requireTeacher, (req, res) => {
    const unit = get('SELECT * FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    const students = all(
        `SELECT us.student_id, us.name, us.tutorial_time, us.is_new_to_qut,
                us.degree, us.major,
                COALESCE(sp.read_rules,          0) AS read_rules,
                COALESCE(sp.entered_preferences, 0) AS entered_preferences,
                COALESCE(sp.in_team,             0) AS in_team,
                COALESCE(sp.submitted_request,   0) AS submitted_request,
                COALESCE(sp.teacher_approved,    0) AS teacher_approved,
                sup.tutorial_slots, sup.project_interests, sup.skills, sup.preferred_role
         FROM unit_students us
         LEFT JOIN student_progress sp ON sp.unit_id = us.unit_id AND sp.student_id = us.student_id
         LEFT JOIN student_unit_prefs sup ON sup.unit_id = us.unit_id AND sup.student_id = us.student_id
         WHERE us.unit_id = ?
         ORDER BY us.name ASC`,
        [req.params.unitId]
    );

    res.json(students);
});

// ── GET /api/units/:unitId/announcements ──────────────────────
router.get('/:unitId/announcements', requireTeacher, (req, res) => {
    const unit = get('SELECT * FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    const announcements = all(
        `SELECT * FROM unit_announcements WHERE unit_id = ? ORDER BY id DESC`,
        [req.params.unitId]
    );
    res.json(announcements);
});

// ── POST /api/units/:unitId/announcements ─────────────────────
router.post('/:unitId/announcements', requireTeacher, (req, res) => {
    const unit = get('SELECT * FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    const { title, content } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });

    run(
        `INSERT INTO unit_announcements (unit_id, title, content, created_at) VALUES (?,?,?,?)`,
        [req.params.unitId, title.trim(), (content || '').trim(), new Date().toISOString()]
    );
    res.json({ ok: true });
});

// ── PUT /api/units/:unitId/rules — teacher edits unit rules ──────
router.put('/:unitId/rules', requireTeacher, (req, res) => {
    const unit = get(
        'SELECT * FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]
    );
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    const { validTeamSizes, maxOneGroup, mustShareTutorial, maxNewToQut, deadline } = req.body;

    if (validTeamSizes !== undefined && parseTeamSizesCsv(validTeamSizes) === null)
        return res.status(400).json({ error: 'validTeamSizes must be comma-separated positive integers' });

    run(
        `UPDATE units SET
            valid_team_sizes    = ?,
            max_one_group       = ?,
            must_share_tutorial = ?,
            max_new_to_qut      = ?,
            deadline            = ?
         WHERE unit_id = ?`,
        [
            validTeamSizes    || unit.valid_team_sizes,
            maxOneGroup       !== undefined ? (maxOneGroup ? 1 : 0)       : unit.max_one_group,
            mustShareTutorial !== undefined ? (mustShareTutorial ? 1 : 0) : unit.must_share_tutorial,
            parseInt(maxNewToQut) || unit.max_new_to_qut,
            deadline          || unit.deadline,
            req.params.unitId
        ]
    );
    res.json({ ok: true });
});

module.exports = router;
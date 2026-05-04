const express = require('express');
const router  = express.Router();
const { all, run, get } = require('../db');
const { requireTeacher } = require('../middleware/auth');
const crypto = require('crypto');

// ── GET /api/units — list teacher's units ────────────────────────
router.get('/', requireTeacher, (req, res) => {
    const units = all(
        'SELECT * FROM units WHERE created_by = ? ORDER BY rowid DESC',
        [req.session.user.username]
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

    res.json({
        total:            unit.student_count   || 0,
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

module.exports = router;
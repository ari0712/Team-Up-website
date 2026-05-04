const express = require('express');
const router = express.Router();
const { all, run, get } = require('../db');
const { requireTeacher } = require('../middleware/auth');
const crypto = require('crypto');

// GET /api/units — list units for the logged-in teacher
router.get('/', requireTeacher, (req, res) => {
    const units = all(
        'SELECT * FROM units WHERE created_by = ? ORDER BY rowid DESC',
        [req.session.user.username]
    );
    res.json(units);
});

// POST /api/units — create a new unit
router.post('/', requireTeacher, (req, res) => {
    const {
        unitName, description, semester,
        validTeamSizes, maxOneGroup, mustShareTutorial,
        maxNewToQut, studentCount
    } = req.body;

    if (!unitName || !unitName.trim())
        return res.status(400).json({ error: 'Unit name is required' });

    const unitId = crypto.randomUUID();
    run(
        `INSERT INTO units
      (unit_id, unit_name, description, semester, created_by,
       valid_team_sizes, max_one_group, must_share_tutorial,
       max_new_to_qut, student_count)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
            unitId,
            unitName.trim(),
            (description || '').trim(),
            (semester || '').trim(),
            req.session.user.username,
            (validTeamSizes || '4'),
            maxOneGroup ? 1 : 0,
            mustShareTutorial ? 1 : 0,
            parseInt(maxNewToQut) || 2,
            parseInt(studentCount) || 0
        ]
    );
    res.json({ ok: true, unitId });
});

module.exports = router;
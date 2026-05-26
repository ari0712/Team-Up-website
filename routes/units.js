const express = require('express');
const router  = express.Router();
const { all, run, get, tx } = require('../db');
const { requireTeacher, requireStudent } = require('../middleware/auth');
const { parseTeamSizesCsv } = require('../utils/teamSizes');
const crypto = require('crypto');

// CSV-field helpers used by the tutorial-slot cascade-rename / cascade-delete.
function csvReplace(csv, oldLabel, newLabel) {
    if (!csv) return '';
    const parts = csv.split(',').map(s => s.trim()).filter(Boolean);
    const replaced = parts.map(p => (p === oldLabel ? newLabel : p));
    return [...new Set(replaced)].join(',');
}
function csvRemove(csv, label) {
    if (!csv) return '';
    return csv.split(',').map(s => s.trim()).filter(s => s && s !== label).join(',');
}

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

        // Auto-create tutorial slots for any new labels seen in the import.
        const slotSet = new Set();
        students.forEach(s => {
            (s.tutorial_time || '').split(',').map(x => x.trim())
                .filter(Boolean).forEach(x => slotSet.add(x));
        });
        if (slotSet.size > 0) {
            const max = get(
                `SELECT MAX(sort_order) AS m FROM unit_tutorial_slots WHERE unit_id = ?`,
                [unitId]
            );
            let nextOrder = (max?.m ?? -1) + 1;
            for (const label of [...slotSet].sort()) {
                const existing = get(
                    `SELECT 1 AS ok FROM unit_tutorial_slots WHERE unit_id = ? AND label = ?`,
                    [unitId, label]
                );
                if (existing) continue;
                run(
                    `INSERT INTO unit_tutorial_slots (slot_id, unit_id, label, sort_order)
                     VALUES (?,?,?,?)`,
                    [crypto.randomUUID(), unitId, label, nextOrder++]
                );
            }
        }
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

// ── POST /api/units/:unitId/team-requests/approve-all ─────────
// Bulk-approves every team in this unit whose status is 'SUBMITTED'. Each
// member's `teacher_approved` progress flag is set in the same transaction.
router.post('/:unitId/team-requests/approve-all', requireTeacher, (req, res) => {
    const unit = get('SELECT * FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    const teams = all(
        `SELECT team_id FROM unit_teams WHERE unit_id = ? AND status = 'SUBMITTED'`,
        [req.params.unitId]
    );
    if (!teams.length) return res.json({ ok: true, approved: 0 });

    const memberRows = all(
        `SELECT tm.team_id, tm.student_id
           FROM unit_team_members tm
           INNER JOIN unit_teams t ON t.team_id = tm.team_id
          WHERE t.unit_id = ? AND t.status = 'SUBMITTED'`,
        [req.params.unitId]
    );

    tx(db => {
        for (const t of teams) {
            db.run(`UPDATE unit_teams SET status = 'APPROVED' WHERE team_id = ?`,
                [t.team_id]);
        }
        for (const m of memberRows) {
            db.run(
                `UPDATE student_progress SET teacher_approved = 1
                  WHERE unit_id = ? AND student_id = ?`,
                [req.params.unitId, m.student_id]
            );
        }
    });

    res.json({ ok: true, approved: teams.length });
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

    const newStatus = action === 'approve' ? 'APPROVED' : 'FORMING';
    if (action === 'approve') {
        run(`UPDATE unit_teams SET status = ? WHERE team_id = ?`,
            [newStatus, req.params.teamId]);
    } else {
        run(`UPDATE unit_teams SET status = ?, last_rejected_at = ? WHERE team_id = ?`,
            [newStatus, new Date().toISOString(), req.params.teamId]);
    }

    const members = all(`SELECT student_id FROM unit_team_members WHERE team_id = ?`,
        [req.params.teamId]);

    if (action === 'approve') {
        members.forEach(m => {
            run(`UPDATE student_progress SET teacher_approved = 1 WHERE unit_id = ? AND student_id = ?`,
                [req.params.unitId, m.student_id]);
        });
    } else {
        // Reject sends the team back to FORMING so members can edit and resubmit.
        // Clear submitted_request (and teacher_approved, in case of approve→reject)
        // so the progress UI reflects the team's actual state.
        members.forEach(m => {
            run(`UPDATE student_progress SET submitted_request = 0, teacher_approved = 0
                  WHERE unit_id = ? AND student_id = ?`,
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

// ── GET /api/units/:unitId/tutorial-slots ─────────────────────
router.get('/:unitId/tutorial-slots', requireTeacher, (req, res) => {
    const unit = get('SELECT 1 AS ok FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });
    const slots = all(
        `SELECT slot_id, label, sort_order FROM unit_tutorial_slots
          WHERE unit_id = ? ORDER BY sort_order, label`,
        [req.params.unitId]
    );
    res.json(slots);
});

// ── POST /api/units/:unitId/tutorial-slots ────────────────────
// Body: { label }
router.post('/:unitId/tutorial-slots', requireTeacher, (req, res) => {
    const unit = get('SELECT 1 AS ok FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    const label = (req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'label is required' });

    const existing = get(
        `SELECT 1 AS ok FROM unit_tutorial_slots WHERE unit_id = ? AND label = ?`,
        [req.params.unitId, label]
    );
    if (existing) return res.status(409).json({ error: 'A slot with that label already exists' });

    const max = get(
        `SELECT MAX(sort_order) AS m FROM unit_tutorial_slots WHERE unit_id = ?`,
        [req.params.unitId]
    );
    const nextOrder = (max?.m ?? -1) + 1;
    const slotId = crypto.randomUUID();
    run(
        `INSERT INTO unit_tutorial_slots (slot_id, unit_id, label, sort_order)
         VALUES (?,?,?,?)`,
        [slotId, req.params.unitId, label, nextOrder]
    );
    res.json({ slot_id: slotId, label, sort_order: nextOrder });
});

// ── PUT /api/units/:unitId/tutorial-slots/:slotId ─────────────
// Body: { label }. Cascade-renames the label in unit_students.tutorial_time
// and student_unit_prefs.tutorial_slots so existing student data stays in sync.
router.put('/:unitId/tutorial-slots/:slotId', requireTeacher, (req, res) => {
    const unit = get('SELECT 1 AS ok FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    const slot = get(
        `SELECT * FROM unit_tutorial_slots WHERE slot_id = ? AND unit_id = ?`,
        [req.params.slotId, req.params.unitId]
    );
    if (!slot) return res.status(404).json({ error: 'Slot not found' });

    const newLabel = (req.body?.label || '').trim();
    if (!newLabel) return res.status(400).json({ error: 'label is required' });
    if (newLabel === slot.label) return res.json({ ok: true, unchanged: true });

    const collision = get(
        `SELECT 1 AS ok FROM unit_tutorial_slots
          WHERE unit_id = ? AND label = ? AND slot_id <> ?`,
        [req.params.unitId, newLabel, req.params.slotId]
    );
    if (collision) return res.status(409).json({ error: 'Another slot already uses that label' });

    // Cascade rename in student CSV fields (scoped to this unit).
    const usRows = all(
        `SELECT student_id, tutorial_time FROM unit_students WHERE unit_id = ?`,
        [req.params.unitId]
    );
    for (const r of usRows) {
        const updated = csvReplace(r.tutorial_time, slot.label, newLabel);
        if (updated !== (r.tutorial_time || ''))
            run(`UPDATE unit_students SET tutorial_time = ? WHERE unit_id = ? AND student_id = ?`,
                [updated, req.params.unitId, r.student_id]);
    }
    const supRows = all(
        `SELECT student_id, tutorial_slots FROM student_unit_prefs WHERE unit_id = ?`,
        [req.params.unitId]
    );
    for (const r of supRows) {
        const updated = csvReplace(r.tutorial_slots, slot.label, newLabel);
        if (updated !== (r.tutorial_slots || ''))
            run(`UPDATE student_unit_prefs SET tutorial_slots = ? WHERE unit_id = ? AND student_id = ?`,
                [updated, req.params.unitId, r.student_id]);
    }

    run(`UPDATE unit_tutorial_slots SET label = ? WHERE slot_id = ?`,
        [newLabel, req.params.slotId]);
    res.json({ ok: true });
});

// ── DELETE /api/units/:unitId/tutorial-slots/:slotId ──────────
// Cascade-removes the label from student CSVs.
router.delete('/:unitId/tutorial-slots/:slotId', requireTeacher, (req, res) => {
    const unit = get('SELECT 1 AS ok FROM units WHERE unit_id = ? AND created_by = ?',
        [req.params.unitId, req.session.user.username]);
    if (!unit) return res.status(404).json({ error: 'Unit not found' });

    const slot = get(
        `SELECT * FROM unit_tutorial_slots WHERE slot_id = ? AND unit_id = ?`,
        [req.params.slotId, req.params.unitId]
    );
    if (!slot) return res.status(404).json({ error: 'Slot not found' });

    const usRows = all(
        `SELECT student_id, tutorial_time FROM unit_students WHERE unit_id = ?`,
        [req.params.unitId]
    );
    for (const r of usRows) {
        const updated = csvRemove(r.tutorial_time, slot.label);
        if (updated !== (r.tutorial_time || ''))
            run(`UPDATE unit_students SET tutorial_time = ? WHERE unit_id = ? AND student_id = ?`,
                [updated, req.params.unitId, r.student_id]);
    }
    const supRows = all(
        `SELECT student_id, tutorial_slots FROM student_unit_prefs WHERE unit_id = ?`,
        [req.params.unitId]
    );
    for (const r of supRows) {
        const updated = csvRemove(r.tutorial_slots, slot.label);
        if (updated !== (r.tutorial_slots || ''))
            run(`UPDATE student_unit_prefs SET tutorial_slots = ? WHERE unit_id = ? AND student_id = ?`,
                [updated, req.params.unitId, r.student_id]);
    }

    run(`DELETE FROM unit_tutorial_slots WHERE slot_id = ?`, [req.params.slotId]);
    res.json({ ok: true });
});

module.exports = router;
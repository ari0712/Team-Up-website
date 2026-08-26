const BaseRepository = require('./BaseRepository');

// Data access for the `units` table.
class UnitRepository extends BaseRepository {
  findById(unitId) {
    return this.get(`SELECT * FROM units WHERE unit_id = ?`, [unitId]);
  }

  // Teacher ownership-scoped lookup. Returns null when the unit is not owned.
  findOwned(unitId, teacherId) {
    return this.get('SELECT * FROM units WHERE unit_id = ? AND created_by = ?',
      [unitId, teacherId]);
  }

  // Teacher's units, each with live student/in-team counts.
  listForTeacher(teacherId) {
    return this.all(
      `SELECT u.*,
          (SELECT COUNT(*) FROM unit_students us WHERE us.unit_id = u.unit_id) AS student_count,
          (SELECT COUNT(DISTINCT tm.student_id)
           FROM unit_team_members tm
           INNER JOIN unit_teams t ON t.team_id = tm.team_id
           WHERE t.unit_id = u.unit_id AND tm.status = 'ACCEPTED') AS students_in_teams
       FROM units u
       WHERE u.created_by = ?
       ORDER BY u.rowid DESC`,
      [teacherId]
    );
  }

  // Units a student is enrolled in (used by the units home page).
  listEnrolled(studentId) {
    return this.all(
      `SELECT u.unit_id, u.unit_name, u.description, u.semester
       FROM units u
       INNER JOIN unit_students us ON us.unit_id = u.unit_id
       WHERE us.student_id = ?
       ORDER BY u.rowid DESC`,
      [studentId]
    );
  }

  // Units this student is ALLOWED to see, each flagged with whether they have
  // joined. The INNER JOIN on unit_roster is the access control: a unit with no
  // roster row for this email is invisible, and a unit with no roster at all is
  // invisible to everyone.
  //
  // (This replaces an earlier listAllWithJoinedFlag that selected every unit
  // with no WHERE clause, which let any student see and join any teacher's unit.
  // Do not reintroduce an unfiltered variant.)
  listRosteredWithJoinedFlag(studentId, email) {
    const e = String(email ?? '').trim().toLowerCase();
    if (!e) return [];
    return this.all(
      // Carries the student's OWN standing in each unit — progress stages and
      // team — so Student Home can answer "do I need to act?" without a second
      // request per card. Progress flags follow listWithProgress; the team
      // subqueries follow listClassmates.
      `SELECT u.unit_id, u.unit_name, u.description, u.semester, u.deadline,
              u.valid_team_sizes, u.max_one_group, u.must_share_tutorial, u.max_new_to_qut,
              CASE WHEN us.student_id IS NOT NULL THEN 1 ELSE 0 END AS joined,
              COALESCE(sp.read_rules,          0) AS read_rules,
              COALESCE(sp.entered_preferences, 0) AS entered_preferences,
              COALESCE(sp.in_team,             0) AS in_team,
              COALESCE(sp.submitted_request,   0) AS submitted_request,
              COALESCE(sp.teacher_approved,    0) AS teacher_approved,
              (SELECT tm.team_id FROM unit_team_members tm
                 INNER JOIN unit_teams t ON t.team_id = tm.team_id
                WHERE t.unit_id = u.unit_id AND tm.student_id = ? LIMIT 1) AS team_id,
              (SELECT t.team_name FROM unit_team_members tm
                 INNER JOIN unit_teams t ON t.team_id = tm.team_id
                WHERE t.unit_id = u.unit_id AND tm.student_id = ? LIMIT 1) AS team_name,
              (SELECT t.status FROM unit_team_members tm
                 INNER JOIN unit_teams t ON t.team_id = tm.team_id
                WHERE t.unit_id = u.unit_id AND tm.student_id = ? LIMIT 1) AS team_status,
              -- Accepted only: a pending invitee is not yet a member the student
              -- should be counted alongside.
              (SELECT COUNT(*) FROM unit_team_members m
                WHERE m.team_id = (SELECT tm2.team_id FROM unit_team_members tm2
                                     INNER JOIN unit_teams t2 ON t2.team_id = tm2.team_id
                                    WHERE t2.unit_id = u.unit_id AND tm2.student_id = ? LIMIT 1)
                  AND m.status = 'ACCEPTED') AS team_size
       FROM units u
                INNER JOIN unit_roster r
                          ON r.unit_id = u.unit_id AND r.email = ?
                LEFT JOIN unit_students us
                          ON us.unit_id = u.unit_id AND us.student_id = ?
                LEFT JOIN student_progress sp
                          ON sp.unit_id = u.unit_id AND sp.student_id = ?
       ORDER BY u.rowid DESC`,
      [studentId, studentId, studentId, studentId, e, studentId, studentId]
    );
  }

  create(u) {
    this.run(
      `INSERT INTO units
         (unit_id, unit_name, description, semester, deadline, created_by,
          valid_team_sizes, max_one_group, must_share_tutorial, max_new_to_qut, student_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [u.unitId, u.unitName, u.description, u.semester, u.deadline, u.createdBy,
       u.validTeamSizes, u.maxOneGroup, u.mustShareTutorial, u.maxNewToQut, u.studentCount]
    );
  }

  // Counts of the records a delete would take with it, so the teacher can be
  // shown the blast radius before confirming rather than after.
  countDependents(unitId) {
    return this.get(
      `SELECT
         (SELECT COUNT(*) FROM unit_students        WHERE unit_id = ?) AS students,
         (SELECT COUNT(*) FROM unit_roster          WHERE unit_id = ?) AS rostered,
         (SELECT COUNT(*) FROM unit_teams           WHERE unit_id = ?) AS teams,
         (SELECT COUNT(*) FROM unit_tutorial_slots  WHERE unit_id = ?) AS slots,
         (SELECT COUNT(*) FROM unit_announcements   WHERE unit_id = ?) AS announcements,
         (SELECT COUNT(*) FROM forum_threads        WHERE unit_id = ?) AS forumThreads`,
      Array(6).fill(unitId)
    );
  }

  // Delete a unit and everything hanging off it, in one transaction.
  //
  // SQLite foreign keys are not enforced on this connection, so nothing cascades
  // by itself — every dependent table is listed here explicitly. Children are
  // removed before parents so an interrupted run can never strand rows that are
  // no longer reachable. `unit_team_members` and `proposal_votes` key off
  // team/proposal ids rather than unit_id, hence the subqueries.
  deleteCascade(unitId) {
    this.db.tx(db => {
      const byUnit = table => db.run(`DELETE FROM ${table} WHERE unit_id = ?`, [unitId]);

      db.run(`DELETE FROM proposal_votes
               WHERE proposal_id IN (SELECT proposal_id FROM proposals WHERE unit_id = ?)`, [unitId]);
      byUnit('proposals');

      db.run(`DELETE FROM unit_team_members
               WHERE team_id IN (SELECT team_id FROM unit_teams WHERE unit_id = ?)`, [unitId]);
      byUnit('unit_team_invites');
      byUnit('unit_teams');

      byUnit('student_unit_prefs');
      byUnit('student_progress');
      byUnit('unit_students');
      byUnit('unit_roster');
      byUnit('unit_tutorial_slots');
      byUnit('unit_announcements');

      byUnit('forum_replies');
      byUnit('forum_threads');

      // The outbox is a delivery audit log — what was actually sent stays true
      // even once the unit is gone, so the rows are kept and only their pointer
      // into the deleted notifications is cleared.
      db.run(`UPDATE email_outbox SET notification_id = NULL
               WHERE notification_id IN (SELECT id FROM notifications WHERE unit_id = ?)`, [unitId]);
      byUnit('notifications');

      db.run(`DELETE FROM units WHERE unit_id = ?`, [unitId]);
    });
  }

  updateRules(unitId, r) {
    this.run(
      `UPDATE units SET
          valid_team_sizes    = ?,
          max_one_group       = ?,
          must_share_tutorial = ?,
          max_new_to_qut      = ?,
          deadline            = ?,
          at_risk_days        = ?
       WHERE unit_id = ?`,
      [r.validTeamSizes, r.maxOneGroup, r.mustShareTutorial, r.maxNewToQut, r.deadline,
       r.atRiskDays, unitId]
    );
  }

  // Aggregate progress counts across a unit's students.
  aggregateProgress(unitId) {
    return this.get(
      `SELECT
         COALESCE(SUM(read_rules),          0) AS readRules,
         COALESCE(SUM(entered_preferences), 0) AS enteredPrefs,
         COALESCE(SUM(in_team),             0) AS inTeam,
         COALESCE(SUM(submitted_request),   0) AS submittedRequest
       FROM student_progress WHERE unit_id = ?`,
      [unitId]
    );
  }
}

module.exports = UnitRepository;

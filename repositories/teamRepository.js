const BaseRepository = require('./BaseRepository');

// Data access for unit-scoped teams (`unit_teams`) and their membership
// (`unit_team_members`). These two tables form one aggregate, so they share a
// repository.
class TeamRepository extends BaseRepository {
  findById(teamId) {
    return this.get(`SELECT * FROM unit_teams WHERE team_id = ?`, [teamId]);
  }

  findInUnit(teamId, unitId) {
    return this.get(`SELECT * FROM unit_teams WHERE team_id = ? AND unit_id = ?`,
      [teamId, unitId]);
  }

  findOwned(teamId, ownerId) {
    return this.get(`SELECT * FROM unit_teams WHERE team_id = ? AND created_by = ?`,
      [teamId, ownerId]);
  }

  findSummaryInUnit(teamId, unitId) {
    return this.get(
      `SELECT team_id, team_name, team_number, status FROM unit_teams
        WHERE team_id = ? AND unit_id = ?`,
      [teamId, unitId]
    );
  }

  // The student's team in a unit (every enrolled student is on exactly one).
  findStudentTeam(unitId, studentId) {
    return this.get(
      `SELECT tm.team_id FROM unit_team_members tm
       INNER JOIN unit_teams t ON t.team_id = tm.team_id
       WHERE t.unit_id = ? AND tm.student_id = ?`,
      [unitId, studentId]
    );
  }

  getMembers(teamId) {
    return this.all(`SELECT * FROM unit_team_members WHERE team_id = ?`, [teamId]);
  }

  getMembership(teamId, studentId) {
    return this.get(`SELECT * FROM unit_team_members WHERE team_id = ? AND student_id = ?`,
      [teamId, studentId]);
  }

  countMembers(teamId) {
    return this.all(`SELECT 1 FROM unit_team_members WHERE team_id = ?`, [teamId]).length;
  }

  nextTeamNumber(unitId) {
    const row = this.get(`SELECT MAX(team_number) AS m FROM unit_teams WHERE unit_id = ?`, [unitId]);
    return (row?.m || 0) + 1;
  }

  create(teamId, unitId, name, number, createdBy) {
    this.run(
      `INSERT INTO unit_teams (team_id, unit_id, team_name, team_number, created_by, status)
       VALUES (?,?,?,?,?, 'FORMING')`,
      [teamId, unitId, name, number, createdBy]
    );
  }

  addMember(teamId, studentId, role) {
    this.run(
      `INSERT INTO unit_team_members (team_id, student_id, role, status)
       VALUES (?,?,?, 'ACCEPTED')`,
      [teamId, studentId, role]
    );
  }

  removeMember(teamId, studentId) {
    this.run(`DELETE FROM unit_team_members WHERE team_id = ? AND student_id = ?`,
      [teamId, studentId]);
  }

  transferOwnership(teamId, newOwnerId) {
    this.run(`UPDATE unit_teams SET created_by = ? WHERE team_id = ?`, [newOwnerId, teamId]);
  }

  markSubmitted(teamId, submittedAt) {
    this.run(`UPDATE unit_teams SET status = 'SUBMITTED', submitted_at = ? WHERE team_id = ?`,
      [submittedAt, teamId]);
  }

  setStatus(teamId, status) {
    this.run(`UPDATE unit_teams SET status = ? WHERE team_id = ?`, [status, teamId]);
  }

  setRejected(teamId, rejectedAt) {
    this.run(`UPDATE unit_teams SET status = 'FORMING', last_rejected_at = ? WHERE team_id = ?`,
      [rejectedAt, teamId]);
  }

  // Members joined with their roster + saved prefs. Used by my-team and all-teams.
  getMembersDetailed(unitId, teamId) {
    return this.all(
      `SELECT tm.student_id, tm.role, tm.status, us.name, us.is_new_to_qut,
              sup.tutorial_slots
       FROM unit_team_members tm
       INNER JOIN unit_students us ON us.unit_id = ? AND us.student_id = tm.student_id
       LEFT JOIN student_unit_prefs sup ON sup.unit_id = ? AND sup.student_id = tm.student_id
       WHERE tm.team_id = ?`,
      [unitId, unitId, teamId]
    );
  }

  // Name-only member rows (all statuses). Used by the teacher team-requests view.
  getMembersBasic(unitId, teamId) {
    return this.all(
      `SELECT tm.student_id, tm.role, tm.status, us.name
       FROM unit_team_members tm
       INNER JOIN unit_students us ON us.unit_id = ? AND us.student_id = tm.student_id
       WHERE tm.team_id = ?`,
      [unitId, teamId]
    );
  }

  // Accepted members only, name-only. Used by the read-only classmate team view.
  getAcceptedMembersBasic(unitId, teamId) {
    return this.all(
      `SELECT tm.student_id, tm.role, tm.status, us.name
       FROM unit_team_members tm
       INNER JOIN unit_students us ON us.unit_id = ? AND us.student_id = tm.student_id
       WHERE tm.team_id = ? AND tm.status = 'ACCEPTED'`,
      [unitId, teamId]
    );
  }

  listByStatuses(unitId, statuses) {
    const placeholders = statuses.map(() => '?').join(',');
    return this.all(
      `SELECT t.*, COUNT(tm.student_id) as member_count
       FROM unit_teams t
       LEFT JOIN unit_team_members tm ON tm.team_id = t.team_id
       WHERE t.unit_id = ? AND t.status IN (${placeholders})
       GROUP BY t.team_id
       ORDER BY t.submitted_at DESC`,
      [unitId, ...statuses]
    );
  }

  listAllWithCounts(unitId) {
    return this.all(
      `SELECT t.*, COUNT(tm.student_id) as member_count
       FROM unit_teams t
       LEFT JOIN unit_team_members tm ON tm.team_id = t.team_id
       WHERE t.unit_id = ?
       GROUP BY t.team_id
       ORDER BY t.rowid DESC`,
      [unitId]
    );
  }

  listSubmitted(unitId) {
    return this.all(`SELECT team_id FROM unit_teams WHERE unit_id = ? AND status = 'SUBMITTED'`,
      [unitId]);
  }

  // Atomically approve every SUBMITTED team in a unit and mark each member
  // teacher_approved. Returns the number of teams approved.
  approveAllSubmitted(unitId) {
    const teams = this.listSubmitted(unitId);
    if (!teams.length) return 0;

    const memberRows = this.all(
      `SELECT tm.team_id, tm.student_id
         FROM unit_team_members tm
         INNER JOIN unit_teams t ON t.team_id = tm.team_id
        WHERE t.unit_id = ? AND t.status = 'SUBMITTED'`,
      [unitId]
    );

    this.db.tx(db => {
      for (const t of teams) {
        db.run(`UPDATE unit_teams SET status = 'APPROVED' WHERE team_id = ?`, [t.team_id]);
      }
      for (const m of memberRows) {
        db.run(
          `UPDATE student_progress SET teacher_approved = 1
            WHERE unit_id = ? AND student_id = ?`,
          [unitId, m.student_id]
        );
      }
    });

    return teams.length;
  }
}

module.exports = TeamRepository;

const BaseRepository = require('./BaseRepository');

// Data access for unit-scoped teams (`unit_teams`) and their membership
// (`unit_team_members`). These two tables form one aggregate, so they share a
// repository.
//
// Team status is one of exactly two values, named from the coordinator's point
// of view:
//   OPEN       the group exists and students can still change it
//   FINALISED  the coordinator has allocated it; students can no longer change it
// There is no student-performed transition: an accepted team-up request IS the
// record, and the unit's deadline is the only student-side freeze.
const STATUSES = ['OPEN', 'FINALISED'];

class TeamRepository extends BaseRepository {
  static get STATUSES() { return STATUSES; }

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

  // Every student's team in a unit, one row each, with the accepted-member
  // count of that team. The single query behind placement categorisation —
  // the class list, export and notification producers all need it for a whole
  // unit at once, and per-student lookups would be N+1.
  listMembershipsWithSizes(unitId) {
    return this.all(
      `SELECT tm.student_id, t.team_id, t.team_name, t.team_number, t.status, t.submitted_at,
              (SELECT COUNT(*) FROM unit_team_members x
                WHERE x.team_id = t.team_id AND x.status = 'ACCEPTED') AS accepted_count
         FROM unit_team_members tm
         INNER JOIN unit_teams t ON t.team_id = tm.team_id
        WHERE t.unit_id = ?`,
      [unitId]
    );
  }

  nextTeamNumber(unitId) {
    const row = this.get(`SELECT MAX(team_number) AS m FROM unit_teams WHERE unit_id = ?`, [unitId]);
    return (row?.m || 0) + 1;
  }

  create(teamId, unitId, name, number, createdBy) {
    this.run(
      `INSERT INTO unit_teams (team_id, unit_id, team_name, team_number, created_by, status)
       VALUES (?,?,?,?,?, 'OPEN')`,
      [teamId, unitId, name, number, createdBy]
    );
  }

  // Eager team-of-one so every enrolled student is always on a team. Used on
  // join, when a student leaves or is kicked, and when the coordinator
  // dissolves a group. Returns the new team id.
  createTeamOfOne(unitId, studentId, role = '') {
    const number = this.nextTeamNumber(unitId);
    const teamId = require('crypto').randomUUID();
    this.create(teamId, unitId, `Team ${number}`, number, studentId);
    this.addMember(teamId, studentId, role);
    return teamId;
  }

  // Re-creates a team row exactly as snapshotted (batch revert). The status and
  // stamps come back too, so a reverted team is indistinguishable from before.
  restore(t) {
    this.run(
      `INSERT OR REPLACE INTO unit_teams
         (team_id, unit_id, team_name, team_number, created_by, status, submitted_at,
          quality_score, last_rejected_at, finalised_at, finalise_batch_id, reopened_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [t.team_id, t.unit_id, t.team_name, t.team_number, t.created_by, t.status,
       t.submitted_at || '', t.quality_score || 0, t.last_rejected_at || '',
       t.finalised_at || '', t.finalise_batch_id || '', t.reopened_at || '']
    );
  }

  deleteTeam(teamId) {
    this.run(`DELETE FROM unit_team_members WHERE team_id = ?`, [teamId]);
    this.run(`DELETE FROM unit_teams WHERE team_id = ?`, [teamId]);
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

  // Used after a teacher reshuffle leaves a team with nobody in it — an empty
  // team row would otherwise linger in every teams listing.
  deleteIfEmpty(teamId) {
    if (this.countMembers(teamId) > 0) return false;
    this.run(`DELETE FROM unit_teams WHERE team_id = ?`, [teamId]);
    return true;
  }

  transferOwnership(teamId, newOwnerId) {
    this.run(`UPDATE unit_teams SET created_by = ? WHERE team_id = ?`, [newOwnerId, teamId]);
  }

  // The coordinator's two overrides. `batchId` ties a team to the organiser save
  // that finalised it so the whole batch can be reverted as a unit; '' for a
  // team finalised on its own.
  setFinalised(teamId, at, batchId = '') {
    this.run(
      `UPDATE unit_teams SET status = 'FINALISED', finalised_at = ?, finalise_batch_id = ?
        WHERE team_id = ?`,
      [at, batchId, teamId]);
  }

  setReopened(teamId, at) {
    this.run(
      `UPDATE unit_teams SET status = 'OPEN', reopened_at = ?, finalise_batch_id = ''
        WHERE team_id = ?`,
      [at, teamId]);
  }

  listByBatch(batchId) {
    return this.all(`SELECT * FROM unit_teams WHERE finalise_batch_id = ?`, [batchId]);
  }

  // Every team in the unit with its detailed members, in ONE query. The
  // per-team getMembersDetailed below is right for a single team; looping it
  // over a unit is an N+1 that the export, the matcher, the rules-impact
  // preview and the boot re-validation all used to make. Returns
  // [{ ...team, members: [...] }], including teams with no members.
  listWithMembersDetailed(unitId) {
    const teams = this.all(
      `SELECT * FROM unit_teams WHERE unit_id = ? ORDER BY team_number, rowid`, [unitId]);
    const byId = new Map(teams.map(t => [t.team_id, { ...t, members: [] }]));
    const rows = this.all(
      `SELECT tm.team_id, tm.student_id, tm.status, us.name, us.is_new_to_qut,
              sup.tutorial_slots, us.tutorial_time,
              COALESCE(NULLIF(sup.preferred_role, ''), tm.role) AS role
         FROM unit_team_members tm
         INNER JOIN unit_teams t ON t.team_id = tm.team_id
         INNER JOIN unit_students us ON us.unit_id = t.unit_id AND us.student_id = tm.student_id
         LEFT JOIN student_unit_prefs sup ON sup.unit_id = t.unit_id AND sup.student_id = tm.student_id
        WHERE t.unit_id = ?`,
      [unitId]
    );
    for (const r of rows) byId.get(r.team_id)?.members.push(r);
    return [...byId.values()];
  }

  // Members joined with their roster + saved prefs. Used by my-team and all-teams.
  //
  // `role` comes from the student's CURRENT preference, not from tm.role:
  // tm.role is only ever written when the member row is created, and a student
  // joins a unit before visiting Preferences, so the stored copy is '' for
  // everyone who joined normally. tm.role remains the fallback for legacy rows.
  //
  // `tutorial_time` is the teacher's roster-imported time, kept alongside the
  // student's saved `tutorial_slots` so validateTeam's `tutorialFallback` can
  // reach it for students who never visited Preferences.
  getMembersDetailed(unitId, teamId) {
    return this.all(
      `SELECT tm.student_id, tm.status, us.name, us.is_new_to_qut,
              sup.tutorial_slots, us.tutorial_time,
              COALESCE(NULLIF(sup.preferred_role, ''), tm.role) AS role
       FROM unit_team_members tm
       INNER JOIN unit_students us ON us.unit_id = ? AND us.student_id = tm.student_id
       LEFT JOIN student_unit_prefs sup ON sup.unit_id = ? AND sup.student_id = tm.student_id
       WHERE tm.team_id = ?`,
      [unitId, unitId, teamId]
    );
  }

  // Name-only member rows (all statuses). Used by the teacher team-requests view.
  // `role` is resolved live — see getMembersDetailed for why.
  getMembersBasic(unitId, teamId) {
    return this.all(
      `SELECT tm.student_id, tm.status, us.name,
              COALESCE(NULLIF(sup.preferred_role, ''), tm.role) AS role
       FROM unit_team_members tm
       INNER JOIN unit_students us ON us.unit_id = ? AND us.student_id = tm.student_id
       LEFT JOIN student_unit_prefs sup ON sup.unit_id = ? AND sup.student_id = tm.student_id
       WHERE tm.team_id = ?`,
      [unitId, unitId, teamId]
    );
  }

  // Accepted members only, name-only. Used by the read-only classmate team view.
  // `role` is resolved live — see getMembersDetailed for why.
  getAcceptedMembersBasic(unitId, teamId) {
    return this.all(
      `SELECT tm.student_id, tm.status, us.name,
              COALESCE(NULLIF(sup.preferred_role, ''), tm.role) AS role
       FROM unit_team_members tm
       INNER JOIN unit_students us ON us.unit_id = ? AND us.student_id = tm.student_id
       LEFT JOIN student_unit_prefs sup ON sup.unit_id = ? AND sup.student_id = tm.student_id
       WHERE tm.team_id = ? AND tm.status = 'ACCEPTED'`,
      [unitId, unitId, teamId]
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

}

module.exports = TeamRepository;

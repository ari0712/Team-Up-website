const { all, get, run } = require('../db');
const studentRepo = require('./studentRepository');

function mapTeam(row) {
  if (!row) return null;
  const members = studentRepo.findByTeamId(row.team_id);
  return {
    teamId: row.team_id,
    status: row.status,
    members,
    memberCount: members.length,
    isComplete: members.length >= 4
  };
}

function save(team) {
  run('INSERT INTO teams (team_id, status) VALUES (?,?)', [team.teamId, team.status]);
}

function updateStatus(teamId, status) {
  run('UPDATE teams SET status=? WHERE team_id=?', [status, teamId]);
}

function deleteTeam(teamId) {
  run('DELETE FROM teams WHERE team_id = ?', [teamId]);
}

function findAll() {
  return all('SELECT team_id, status FROM teams ORDER BY CAST(team_id AS INTEGER)').map(mapTeam);
}

function findIncomplete() {
  return findAll().filter(t => t.memberCount < 4);
}

function findByStudentUsername(username) {
  return findAll().find(t => t.members.some(s => s.username === username)) || null;
}

function getNextTeamNumber() {
  const row = get('SELECT COUNT(*) as cnt FROM teams');
  return (row ? row.cnt : 0) + 1;
}

module.exports = { save, updateStatus, deleteTeam, findAll, findIncomplete, findByStudentUsername, getNextTeamNumber };

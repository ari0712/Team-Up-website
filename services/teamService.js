const teamRepo = require('../repositories/teamRepository');
const studentRepo = require('../repositories/studentRepository');

function getAllTeams() { return teamRepo.findAll(); }
function getIncompleteTeams() { return teamRepo.findIncomplete(); }
function getCurrentTeam(username) { return teamRepo.findByStudentUsername(username); }

function addStudentToNewTeam(student) {
  const teamId = String(teamRepo.getNextTeamNumber());
  const team = { teamId, status: 'FORMING' };
  teamRepo.save(team);
  student.teamId = teamId;
  studentRepo.update(student);
  return team;
}

function addStudentToTeam(student, teamId) {
  student.teamId = teamId;
  studentRepo.update(student);
  const members = studentRepo.findByTeamId(teamId);
  if (members.length >= 4) teamRepo.updateStatus(teamId, 'COMPLETE');
}

function leaveTeam(student) {
  const oldTeamId = student.teamId;
  student.teamId = null;
  studentRepo.update(student);
  if (oldTeamId) {
    const remaining = studentRepo.findByTeamId(oldTeamId);
    if (remaining.length === 0) {
      teamRepo.deleteTeam(oldTeamId);
    } else if (remaining.length < 4) {
      teamRepo.updateStatus(oldTeamId, 'FORMING');
    }
  }
}

module.exports = { getAllTeams, getIncompleteTeams, getCurrentTeam, addStudentToNewTeam, addStudentToTeam, leaveTeam };

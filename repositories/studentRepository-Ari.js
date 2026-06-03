const { all, get, run } = require('../db');

const JOIN = `
  SELECT u.username, u.password_hash, u.email, u.student_id,
         s.display_name, s.tutorial_availability, s.major, s.units_passed, s.team_id
  FROM users u JOIN students s ON u.username = s.username
`;

function mapStudent(row) {
  if (!row) return null;
  return {
    username: row.username,
    passwordHash: row.password_hash,
    email: row.email,
    studentId: row.student_id,
    displayName: row.display_name,
    tutorialAvailability: row.tutorial_availability,
    major: row.major,
    unitsPassed: row.units_passed,
    teamId: row.team_id,
    role: 'STUDENT'
  };
}

function save(s) {
  run(`INSERT INTO students (username, display_name, tutorial_availability, major, units_passed, team_id)
       VALUES (?,?,?,?,?,?)`,
    [s.username, s.displayName || null, s.tutorialAvailability || null,
     s.major || null, s.unitsPassed || 0, s.teamId || null]);
}

function update(s) {
  run(`UPDATE students SET display_name=?, tutorial_availability=?, major=?, units_passed=?, team_id=?
       WHERE username=?`,
    [s.displayName, s.tutorialAvailability, s.major, s.unitsPassed, s.teamId || null, s.username]);
}

function findByUsername(username) {
  return mapStudent(get(JOIN + ' WHERE u.username = ?', [username]));
}

function findAll() {
  return all(JOIN + ' ORDER BY s.display_name').map(mapStudent);
}

function findByTeamId(teamId) {
  return all(JOIN + ' WHERE s.team_id = ?', [teamId]).map(mapStudent);
}

module.exports = { save, update, findByUsername, findAll, findByTeamId };

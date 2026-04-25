const studentRepo = require('../repositories/studentRepository');
const userRepo = require('../repositories/userRepository');

function saveProfile(student) {
  studentRepo.update(student);
}

function getStudent(username) {
  return studentRepo.findByUsername(username);
}

function getFilteredStudents(excludeUsername, nameFilter, tutorialFilter, majorFilter, sortBy) {
  let students = studentRepo.findAll().filter(s => s.username !== excludeUsername);

  if (nameFilter) students = students.filter(s =>
    s.displayName && s.displayName.toLowerCase().includes(nameFilter.toLowerCase()));
  if (tutorialFilter) students = students.filter(s =>
    s.tutorialAvailability && s.tutorialAvailability.toLowerCase().includes(tutorialFilter.toLowerCase()));
  if (majorFilter) students = students.filter(s =>
    s.major && s.major.toLowerCase().includes(majorFilter.toLowerCase()));

  if (sortBy === 'units') {
    students.sort((a, b) => b.unitsPassed - a.unitsPassed);
  } else {
    students.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
  }
  return students;
}

function updateEmail(username, email) {
  userRepo.updateEmail(username, email);
}

module.exports = { saveProfile, getStudent, getFilteredStudents, updateEmail };

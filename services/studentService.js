class StudentService {
  constructor({ studentRepo }) {
    this.studentRepo = studentRepo;
  }

  getStudent(username) {
    return this.studentRepo.findByUsername(username);
  }
}

module.exports = StudentService;

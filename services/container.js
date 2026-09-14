// Composition root: builds the repository and service graph once for a given
// Database and returns every piece by name.
//
// Lives apart from server.js so the tests can wire the real services against a
// throwaway database — the same graph, the same injection, no HTTP.
const UserRepository         = require('../repositories/userRepository');
const StudentRepository      = require('../repositories/studentRepository');
const UnitRepository         = require('../repositories/unitRepository');
const UnitStudentRepository  = require('../repositories/unitStudentRepository');
const UnitRosterRepository   = require('../repositories/unitRosterRepository');
const ProgressRepository     = require('../repositories/progressRepository');
const PreferencesRepository  = require('../repositories/preferencesRepository');
const TeamRepository         = require('../repositories/teamRepository');
const TutorialSlotRepository = require('../repositories/tutorialSlotRepository');
const NotificationRepository = require('../repositories/notificationRepository');
const NotificationPrefsRepository = require('../repositories/notificationPrefsRepository');
const EmailOutboxRepository  = require('../repositories/emailOutboxRepository');

const AuthService          = require('./authService');
const StudentService       = require('./studentService');
const TeamRequestService   = require('./teamRequestService');
const StudentPortalService = require('./studentPortalService');
const UnitService          = require('./unitService');
const NotificationService  = require('./notificationService');
const MatchingService      = require('./matchingService');
const FinaliseBatchRepository = require('../repositories/finaliseBatchRepository');
const StudentEmailPrefsRepository = require('../repositories/studentEmailPrefsRepository');

function createServices({ db, transport, env = process.env }) {
  const userRepo    = new UserRepository(db);
  const studentRepo = new StudentRepository(db);
  const unitRepo    = new UnitRepository(db);
  const enrollment  = new UnitStudentRepository(db);
  const roster      = new UnitRosterRepository(db);
  const progress    = new ProgressRepository(db);
  const prefs       = new PreferencesRepository(db);
  const teams       = new TeamRepository(db);
  const slots       = new TutorialSlotRepository(db);
  const notifications = new NotificationRepository(db);
  const notifPrefs    = new NotificationPrefsRepository(db);
  const outbox        = new EmailOutboxRepository(db);
  const batches       = new FinaliseBatchRepository(db);
  const emailPrefs    = new StudentEmailPrefsRepository(db);

  const authService     = new AuthService({ userRepo, studentRepo });
  const studentService  = new StudentService({ studentRepo });
  // Rules are evaluated inside it — when a request is sent and again when
  // everyone has accepted — hence the teams and units repos.
  const teamRequestService = new TeamRequestService({ db, teams, units: unitRepo });
  const notificationService = new NotificationService({
    db, notifications, prefs: notifPrefs, outbox, units: unitRepo, enrollment, teams,
    userRepo, transport, emailPrefs, env
  });
  // Built before studentPortalService, which depends on it for Auto-Match.
  const matchingService = new MatchingService({
    units: unitRepo, enrollment, teams, prefs, progress
  });
  const studentPortalService = new StudentPortalService({
    units: unitRepo, enrollment, roster, progress, prefs, teams, slots,
    studentRepo, teamRequestService, notificationService, matchingService, emailPrefs
  });
  const unitService = new UnitService({
    units: unitRepo, enrollment, roster, progress, teams, prefs, slots,
    batches, teamRequestService, userRepo
  });

  return {
    repos: {
      userRepo, studentRepo, unitRepo, enrollment, roster, progress, prefs, teams, slots,
      notifications, notifPrefs, outbox, batches, emailPrefs
    },
    authService, studentService, teamRequestService, notificationService,
    matchingService, studentPortalService, unitService
  };
}

module.exports = { createServices };

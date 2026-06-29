const express = require('express');
const session = require('express-session');
const path = require('path');

const Database = require('./db/Database');

// Repositories
const UserRepository         = require('./repositories/userRepository');
const StudentRepository      = require('./repositories/studentRepository');
const UnitRepository         = require('./repositories/unitRepository');
const UnitStudentRepository  = require('./repositories/unitStudentRepository');
const ProgressRepository     = require('./repositories/progressRepository');
const PreferencesRepository  = require('./repositories/preferencesRepository');
const TeamRepository         = require('./repositories/teamRepository');
const TutorialSlotRepository = require('./repositories/tutorialSlotRepository');
const AnnouncementRepository = require('./repositories/announcementRepository');

// Services
const AuthService          = require('./services/authService');
const StudentService       = require('./services/studentService');
const ProposalService      = require('./services/proposalService');
const StudentPortalService = require('./services/studentPortalService');
const UnitService          = require('./services/unitService');

// Route factories
const createAuthRouter    = require('./routes/auth');
const createUnitsRouter   = require('./routes/units');
const createStudentRouter = require('./routes/student');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'teamup.db');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'teamup-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const db = new Database(DB_PATH);

db.connect().then(() => {
  // ── Composition root: build the object graph once, inject downward ──
  const userRepo    = new UserRepository(db);
  const studentRepo = new StudentRepository(db);
  const unitRepo    = new UnitRepository(db);
  const enrollment  = new UnitStudentRepository(db);
  const progress    = new ProgressRepository(db);
  const prefs       = new PreferencesRepository(db);
  const teams       = new TeamRepository(db);
  const slots       = new TutorialSlotRepository(db);
  const announcements = new AnnouncementRepository(db);

  const authService     = new AuthService({ userRepo, studentRepo });
  const studentService  = new StudentService({ studentRepo });
  const proposalService = new ProposalService({ db });
  const studentPortalService = new StudentPortalService({
    units: unitRepo, enrollment, progress, prefs, teams, slots, announcements,
    studentRepo, proposalService
  });
  const unitService = new UnitService({
    units: unitRepo, enrollment, progress, teams, prefs, slots, announcements
  });

  app.use('/api/auth',    createAuthRouter({ userRepo, authService, studentService }));
  app.use('/api/units',   createUnitsRouter({ unitService }));
  app.use('/api/student', createStudentRouter({ studentPortalService }));

  // All other GETs serve index.html (the portal select page handles routing)
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(PORT, () => console.log(`TeamUp running at http://localhost:${PORT}`));

  // Periodic sweep: resolve any open proposals whose expires_at has passed.
  setInterval(() => {
    try { proposalService.sweepExpired(); }
    catch (e) { console.error('Proposal sweep failed:', e); }
  }, 60 * 1000);
}).catch(err => {
  console.error('Failed to init database:', err);
  process.exit(1);
});

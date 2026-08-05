const express = require('express');
const session = require('express-session');
const path = require('path');

// Load .env before anything reads process.env. Real environment variables win.
require('./services/email/env').loadEnv();

const Database = require('./db/Database');

// Repositories
const UserRepository         = require('./repositories/userRepository');
const StudentRepository      = require('./repositories/studentRepository');
const UnitRepository         = require('./repositories/unitRepository');
const UnitStudentRepository  = require('./repositories/unitStudentRepository');
const UnitRosterRepository   = require('./repositories/unitRosterRepository');
const ProgressRepository     = require('./repositories/progressRepository');
const PreferencesRepository  = require('./repositories/preferencesRepository');
const TeamRepository         = require('./repositories/teamRepository');
const TutorialSlotRepository = require('./repositories/tutorialSlotRepository');
const AnnouncementRepository = require('./repositories/announcementRepository');
const NotificationRepository = require('./repositories/notificationRepository');
const EmailOutboxRepository  = require('./repositories/emailOutboxRepository');

// Services
const AuthService          = require('./services/authService');
const StudentService       = require('./services/studentService');
const ProposalService      = require('./services/proposalService');
const StudentPortalService = require('./services/studentPortalService');
const UnitService          = require('./services/unitService');
const NotificationService  = require('./services/notificationService');
const MatchingService      = require('./services/matchingService');
const { createTransport }  = require('./services/email/transport');
const { isLocked }         = require('./utils/deadline');

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
  const roster      = new UnitRosterRepository(db);
  const progress    = new ProgressRepository(db);
  const prefs       = new PreferencesRepository(db);
  const teams       = new TeamRepository(db);
  const slots       = new TutorialSlotRepository(db);
  const announcements = new AnnouncementRepository(db);
  const notifications = new NotificationRepository(db);
  const outbox        = new EmailOutboxRepository(db);

  const authService     = new AuthService({ userRepo, studentRepo });
  const studentService  = new StudentService({ studentRepo });
  const proposalService = new ProposalService({ db });
  const mailTransport = createTransport();
  const notificationService = new NotificationService({
    db, notifications, outbox, units: unitRepo, enrollment, teams, announcements,
    userRepo, transport: mailTransport
  });
  // Say out loud what will happen to notification email — silently mailing real
  // people because a variable was set is the failure mode worth preventing.
  const redirect = (process.env.MAIL_REDIRECT_TO || '').trim();
  console.log(
    `Email transport: ${mailTransport.name}` +
    (mailTransport.name === 'console' ? ' (nothing is sent)' : '') +
    (redirect ? ` — ALL mail redirected to ${redirect}` :
      mailTransport.name === 'smtp' ? ' — WARNING: sending to real stored addresses' : '')
  );
  const studentPortalService = new StudentPortalService({
    units: unitRepo, enrollment, roster, progress, prefs, teams, slots, announcements,
    studentRepo, proposalService, notificationService
  });
  const unitService = new UnitService({
    units: unitRepo, enrollment, roster, progress, teams, prefs, slots, announcements
  });
  const matchingService = new MatchingService({
    units: unitRepo, enrollment, teams, prefs, progress
  });

  app.use('/api/auth',    createAuthRouter({ userRepo, authService, studentService }));
  app.use('/api/units',   createUnitsRouter({ unitService, matchingService }));
  app.use('/api/student', createStudentRouter({ studentPortalService }));

  // An unmatched /api route must NOT fall through to the SPA catch-all below.
  // Serving index.html with a 200 makes a missing endpoint look like a
  // successful empty response: the client's res.json() fails, falls back to {},
  // and the page dies later on `undefined.map(...)` far from the real cause.
  // This is exactly what a not-yet-restarted server looked like.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `No such API endpoint: ${req.method} /api${req.path}` });
  });

  // All other GETs serve index.html (the portal select page handles routing)
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(PORT, () => console.log(`TeamUp running at http://localhost:${PORT}`));

  // Periodic sweep: resolve any open proposals whose expires_at has passed,
  // then produce time-based notifications (deadline buckets) and send email to
  // students who may not have the app open.
  setInterval(() => {
    try { proposalService.sweepExpired(); }
    catch (e) { console.error('Proposal sweep failed:', e); }

    // Team formation is closed once a unit's deadline passes; close out any
    // proposal still sitting open so nothing shows a countdown it cannot honour.
    try {
      for (const u of db.all(`SELECT unit_id, deadline FROM units`)) {
        if (isLocked(u)) proposalService.invalidateOpenForUnit(u.unit_id);
      }
    } catch (e) { console.error('Deadline lock sweep failed:', e); }

    notificationService.runBackgroundPass()
      .catch(e => console.error('Notification pass failed:', e));
  }, 60 * 1000);
}).catch(err => {
  console.error('Failed to init database:', err);
  process.exit(1);
});

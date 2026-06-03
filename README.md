# TeamUp Web – Team Formation Platform

A web app that helps university teaching staff form student project teams and lets
students find teammates, set preferences, and self-organise into groups that satisfy
the unit's team-formation rules.

Built with **Node.js + Express** and a file-based **SQLite** database (via
[`sql.js`](https://sql.js.org/)). The frontend is plain HTML/CSS/vanilla JS — no
build step and no frontend framework.

## Requirements

- Node.js 18+ (developed on v22)
- npm

No database server or other external service is needed — the database is a single
`teamup.db` file created automatically on first run.

## Setup & Run

```bash
# 1. Install dependencies (one time)
npm install

# 2. Start the server
npm start          # or: npm run dev   (auto-restart via nodemon)

# 3. Open in your browser
http://localhost:3000
```

The server listens on `PORT` (default `3000`).

## Roles & Portals

Open `http://localhost:3000` to reach the portal-select page. From there you sign in
(or sign up) as a **Teacher** or a **Student**. Passwords are hashed with SHA-256.

### Teacher portal
- **Create a unit** – name, semester, deadline, and team-formation rules
  (valid team sizes, "max one group", "must share a tutorial", max students new to
  the university per team).
- **Import a class list** – bulk-import students from a parsed CSV when creating a unit.
- **Progress dashboard** – per-unit aggregate counts across the student journey
  (read rules → entered preferences → in a team → submitted request → approved).
- **Class list** – every enrolled student with their individual progress stages and
  saved preferences.
- **Team requests** – review teams students have submitted and **approve** or
  **reject** them; approvals mark each member as teacher-approved.
- **All teams** – every team in the unit with live **validation** (size, shared
  tutorial, new-to-university limit, all-members-accepted).
- **Announcements** – post unit announcements.

### Student portal
- **Account** – sign up / log in (student ID captured at signup).
- **Browse & join units** – see available units and join one.
- **Read the rules** for a unit and track progress through each stage.
- **Set preferences** – tutorial slots, project interests, skills, preferred role,
  preferred teammates (saved per unit).
- **Find teammates** – search and filter classmates by name, tutorial, interest, or skill.
- **Teams** – create a team, invite classmates, accept/decline invites, leave/remove
  members, and **submit** the team for teacher review once everyone has accepted.
- **My team** – view members and live rule validation for your team.

## Project structure

```
teamup-web/
├── server.js                 Express app entry point (mounts all API routers)
├── db.js                     sql.js SQLite wrapper — creates schema, auto-saves to teamup.db
├── teamup.db                 SQLite database file (created/updated at runtime)
├── repositories/             Data-access layer (raw SQL)
│   ├── userRepository.js
│   ├── studentRepository.js
│   ├── teamRepository.js
│   └── inviteRepository.js
├── services/                 Business logic
│   ├── authService.js        SHA-256 password hashing, login/signup
│   ├── studentService.js     profile + filter/sort logic
│   ├── teamService.js        team create/join/leave
│   ├── inviteService.js      legacy invite send/accept/reject
│   └── proposalService.js    auto-matching proposals (experimental)
├── routes/                   Express REST API
│   ├── auth.js               login / signup / logout / me
│   ├── students.js           legacy student list, onboarding, profile
│   ├── invites.js            legacy team invites
│   ├── teams.js              legacy teams (all / incomplete / current / leave)
│   ├── units.js              teacher: units, class lists, progress, team reviews, announcements
│   └── student.js            student: join units, preferences, teams, invites, submit
├── middleware/auth.js        Session guards (requireAuth / requireStudent / requireTeacher)
├── utils/                    Helpers (uuid, team-size parsing)
└── public/                   Frontend (static HTML / CSS / vanilla JS)
    ├── index.html            Portal select
    ├── login.html, signup.html
    ├── student-*.html        Student portal pages
    ├── teacher-*.html        Teacher portal pages
    ├── api.js                Shared fetch/table/modal helpers
    └── *.css                 Styles
```

## Database

SQLite, stored as a single `teamup.db` file in the project root. The schema is
created automatically by `db.js` on startup (idempotent `CREATE TABLE IF NOT EXISTS`
plus a few additive `ALTER TABLE` migrations). Key tables:

| Table | Purpose |
|-------|---------|
| `users` | accounts (username, password hash, email, role, student_id) |
| `students` | student profile (display name, major, tutorial availability, units passed) |
| `units` | a unit/class and its team-formation rules |
| `unit_students` | class list imported per unit |
| `student_progress` | per-student stage tracking within a unit |
| `student_unit_prefs` | per-student preferences within a unit |
| `unit_teams` / `unit_team_members` / `unit_team_invites` | unit-scoped teams, membership, invites |
| `unit_announcements` | teacher announcements per unit |
| `teams` / `team_invites` | legacy global teams and invites |

## API Reference

All `/api/*` endpoints return JSON. Student/teacher routes require an authenticated
session of the matching role.

### Auth — `/api/auth`
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET  | `/me`     | Any | Current session user |
| POST | `/login`  | —   | Log in (`username`, `password`, `role`) |
| POST | `/signup` | —   | Create account |
| POST | `/logout` | Any | Destroy session |

### Units (teacher) — `/api/units`
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/` | List the teacher's units |
| POST | `/` | Create a unit and import students |
| GET  | `/:unitId` | Single unit |
| PUT  | `/:unitId/rules` | Update team-formation rules |
| GET  | `/:unitId/progress` | Aggregate progress counts |
| PUT  | `/:unitId/progress/:studentId` | Update a student's stage |
| GET  | `/:unitId/class-list` | Class list with per-student progress + prefs |
| GET  | `/:unitId/all-teams` | All teams with validation |
| GET  | `/:unitId/team-requests` | Submitted teams awaiting review |
| PUT  | `/:unitId/team-requests/:teamId` | Approve / reject a team |
| GET  | `/:unitId/announcements` | List announcements |
| POST | `/:unitId/announcements` | Post an announcement |
| GET  | `/student/enrolled` | (student) Units the caller is enrolled in |

### Student portal — `/api/student`
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/units` | All units, flagged with whether the caller has joined |
| POST | `/units/:unitId/join` | Join a unit |
| GET  | `/units/:unitId` | Unit details (must be enrolled) |
| GET/PUT | `/units/:unitId/progress` | Get / update own progress |
| GET/POST | `/units/:unitId/prefs` | Get / save preferences |
| GET  | `/units/:unitId/students` | Search/filter classmates |
| GET  | `/units/:unitId/my-team` | Own team + validation |
| POST | `/units/:unitId/teams` | Create a team |
| POST | `/units/:unitId/teams/:teamId/invite` | Invite a classmate |
| POST | `/units/:unitId/teams/:teamId/submit` | Submit team for review |
| DELETE | `/units/:unitId/teams/:teamId/members/:studentId` | Remove a member |
| GET  | `/units/:unitId/invites` | Pending invites for the caller |
| PUT  | `/units/:unitId/invites/:inviteId` | Accept / decline an invite |

### Legacy student/team endpoints
`/api/students` (list, onboarding, profile), `/api/invites` (received, sent, send,
accept, reject), and `/api/teams` (all, incomplete, current, leave) are earlier
global-scope endpoints retained from the first version of the app.

## Notes & limitations

This is a student project / prototype, not production-hardened software:

- The session secret in `server.js` is hardcoded — set it from an environment
  variable before any real deployment.
- `sql.js` keeps the whole database in memory and rewrites `teamup.db` on every write,
  which is fine for a class-sized dataset but not for high concurrency.
- Auto-matching (`services/proposalService.js`) is experimental and not fully wired in.

## License

[MIT](LICENSE) © 2026 Ari

# TeamUp Web – Team Formation Platform

Node.js + Express + SQLite web app.

## Requirements
- Node.js 18+
- No other installs needed

## Setup & Run

```bash
# 1. Install dependencies (one time)
npm install

# 2. Start the server
npm start

# 3. Open in browser
http://localhost:3000
```

## Features

| Screen | URL |
|--------|-----|
| Portal Select | `/` |
| Login | `/login.html?role=STUDENT` or `?role=TEACHER` |
| Sign Up | `/signup.html?role=STUDENT` |
| Onboarding | `/onboarding.html` |
| Student Dashboard | `/student.html` |
| Teacher Dashboard | `/teacher.html` |
| **More to Come** |

### Student features
- Login / Sign Up with SHA-256 password hashing (compatible with existing JavaFX DB)
- Onboarding: display name, major, units, multiple tutorial slots
- **Find Teammates**: filter by name/tutorial/major, sort by name or units
- **Team Invites**: send invites, accept (with team-switch warning), reject (mandatory reason)
- **My Team**: view members, leave team (cleans up empty teams)
- **Team Status**: all teams table with your team highlighted
- **Edit Profile**: update all fields + multiple tutorial slots

### Teacher features
- Login / Sign Up
- **All Teams**: overview with complete/forming status + summary bar
- **Incomplete Teams**: teams < 4 members, urgency colour coding

## Project structure

```
teamup-web/
├── server.js                 Express app entry point
├── db.js                     sql.js SQLite wrapper (auto-saves to teamup.db)
├── repositories/             SQL queries (direct port of Java repositories)
│   ├── userRepository.js
│   ├── studentRepository.js
│   ├── teamRepository.js
│   └── inviteRepository.js
├── services/                 Business logic (direct port of Java services)
│   ├── authService.js        SHA-256 Encryption
│   ├── studentService.js     filter/sort logic
│   ├── teamService.js        leave/join/create
│   └── inviteService.js      send/accept/reject
├── routes/                   Express REST API
│   ├── auth.js               POST login/signup/logout, GET me
│   ├── students.js           GET list, POST onboarding, PUT profile
│   ├── invites.js            GET received/sent, POST send/accept/reject
│   └── teams.js              GET all/incomplete/current, POST leave
├── middleware/auth.js        Session guards
└── public/                   Frontend (vanilla JS, no framework)
    ├── style.css             Dark theme matching JavaFX colours
    ├── api.js                Shared fetch/table/modal helpers
    ├── index.html            Portal select
    ├── login.html
    ├── signup.html
    ├── onboarding.html
    ├── student.html          Full dashboard (5 panels)
    └── teacher.html          Full dashboard (2 panels)
```

## Database
- SQLite schema
- File: `teamup.db` in project root
- SHA-256 password hashes are compatible

## API Reference

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/auth/me` | Any | Current session user |
| POST | `/api/auth/login` | — | Login |
| POST | `/api/auth/signup` | — | Create account |
| POST | `/api/auth/logout` | Any | Destroy session |
| GET | `/api/students` | Student | Filtered student list |
| POST | `/api/students/onboarding` | Student | Save onboarding data |
| PUT | `/api/students/profile` | Student | Update profile |
| GET | `/api/invites/received` | Student | Received invites |
| GET | `/api/invites/sent` | Student | Sent invites |
| POST | `/api/invites/send` | Student | Send invite |
| GET | `/api/invites/:id/check-accept` | Student | Check if receiver is in a team |
| POST | `/api/invites/:id/accept` | Student | Accept invite |
| POST | `/api/invites/:id/reject` | Student | Reject with reason |
| GET | `/api/teams/all` | Auth | All teams |
| GET | `/api/teams/incomplete` | Teacher | Teams < 4 members |
| GET | `/api/teams/current` | Student | My current team |
| POST | `/api/teams/leave` | Student | Leave current team |

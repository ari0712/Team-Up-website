const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'teamup-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use('/api/auth',     require('./routes/auth'));
app.use('/api/students', require('./routes/students'));
app.use('/api/invites',  require('./routes/invites'));
app.use('/api/teams',    require('./routes/teams'));

// All other GETs serve index.html (the portal select page handles routing)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`TeamUp running at http://localhost:${PORT}`));
}).catch(err => {
  console.error('Failed to init database:', err);
  process.exit(1);
});

// Note: passwordHash stripping is handled in routes via sanitizeUser

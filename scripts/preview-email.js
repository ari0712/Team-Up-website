// Prints the most recent outbox emails for a student, with their Ethereal
// preview links, so you don't have to query teamup.db by hand to see what a
// notification email actually looked like.
//
// Usage: node scripts/preview-email.js <username> [limit]

const path = require('path');
const Database = require('../db/Database');

const username = process.argv[2];
const limit = parseInt(process.argv[3]) || 5;

if (!username) {
  console.error('Usage: node scripts/preview-email.js <username> [limit]');
  process.exit(1);
}

const db = new Database(path.join(__dirname, '..', 'teamup.db'));

db.connect().then(() => {
  const user = db.get(`SELECT username, email FROM users WHERE username = ?`, [username]);
  if (!user) {
    console.error(`No such user: ${username}`);
    process.exit(1);
  }

  const rows = db.all(
    `SELECT eo.id, eo.subject, eo.status, eo.preview_url, eo.created_at, eo.error
     FROM email_outbox eo
     WHERE eo.intended_recipient = ? OR eo.recipient = ?
     ORDER BY eo.id DESC LIMIT ?`,
    [user.email, user.email, limit]
  );

  if (!rows.length) {
    console.log(`No outbox entries yet for ${username} (${user.email}).`);
    process.exit(0);
  }

  console.log(`Recent email for ${username} (${user.email}):\n`);
  for (const r of rows) {
    console.log(`[${r.created_at}] ${r.subject} — ${r.status}${r.error ? ` (${r.error})` : ''}`);
    console.log(r.preview_url ? `  ${r.preview_url}` : '  (no preview link recorded)');
  }
  process.exit(0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});

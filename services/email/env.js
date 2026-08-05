const fs = require('fs');
const path = require('path');

// Minimal .env loader. The project deliberately keeps its dependency list short,
// and this is all `dotenv` would be doing for us here.
//
// Real environment variables always win, so `MAIL_TRANSPORT=console npm start`
// overrides whatever the file says.
function loadEnv(file = path.join(__dirname, '..', '..', '.env'), env = process.env) {
  if (!fs.existsSync(file)) return {};

  const loaded = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip one layer of matching quotes, so values containing '#' or spaces work.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (env[key] === undefined) {
      env[key] = value;
      loaded[key] = value;
    }
  }
  return loaded;
}

module.exports = { loadEnv };

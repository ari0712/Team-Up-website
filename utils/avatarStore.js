const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Profile pictures on disk, under public/uploads/avatars.
//
// Why not in the database: Database.save() rewrites the ENTIRE db file
// synchronously after every write. Image bytes in a column would turn every
// unrelated write in the app — marking a notification read, casting a vote —
// into a multi-megabyte rewrite. Only the path goes in the db.
//
// Every operation here is synchronous on purpose. The route wrapper in
// routes/student.js is a plain try/catch around a non-awaited call, so a
// rejected promise would escape it and surface as an unhandled rejection
// instead of a 4xx.

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
const PUBLIC_PREFIX = '/uploads/avatars/';

// The client downscales to 256x256 JPEG before sending, which lands around
// 20 KB. This is the backstop for anything that did not come from our page.
const MAX_BYTES = 300 * 1024;

// Magic bytes, not the declared MIME type or the file extension — both of those
// are attacker-controlled and neither proves what the bytes actually are.
const SIGNATURES = [
  { ext: 'jpg', bytes: [0xFF, 0xD8, 0xFF] },
  { ext: 'png', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
];

function sniff(buffer) {
  return SIGNATURES.find(sig =>
    buffer.length >= sig.bytes.length &&
    sig.bytes.every((b, i) => buffer[i] === b))?.ext || null;
}

// Parses a data: URL into a validated Buffer. Returns { buffer, ext } or throws
// a plain Error whose message is safe to show the user.
function decodeDataUrl(dataUrl) {
  const match = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!match) throw new Error('That does not look like an image file.');

  let buffer;
  try { buffer = Buffer.from(match[1], 'base64'); }
  catch { throw new Error('That image could not be read.'); }

  if (!buffer.length) throw new Error('That image is empty.');
  if (buffer.length > MAX_BYTES)
    throw new Error(`That image is ${Math.round(buffer.length / 1024)} KB; the limit is ` +
                    `${Math.round(MAX_BYTES / 1024)} KB.`);

  const ext = sniff(buffer);
  if (!ext) throw new Error('Only JPEG and PNG images are supported.');

  return { buffer, ext };
}

// Writes the image and returns its public path. Random filename: these files are
// served by express.static, which is mounted before the session middleware and
// so applies no auth check — an unguessable name is what keeps one student's
// photo from being enumerable by another.
function save(dataUrl) {
  const { buffer, ext } = decodeDataUrl(dataUrl);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const filename = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
  return PUBLIC_PREFIX + filename;
}

// Best-effort delete of a previously stored avatar. A missing or unexpected path
// is ignored rather than thrown: failing to tidy up an old file must never block
// the student from setting a new one.
function remove(publicPath) {
  if (!publicPath || !publicPath.startsWith(PUBLIC_PREFIX)) return;
  const filename = path.basename(publicPath);
  // Re-joined from the basename so a crafted stored value cannot escape the
  // upload directory.
  try { fs.unlinkSync(path.join(UPLOAD_DIR, filename)); } catch { /* already gone */ }
}

module.exports = { save, remove, MAX_BYTES };

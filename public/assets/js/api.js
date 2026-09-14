// Shared fetch helper - handles errors uniformly
async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const get  = (url)        => api('GET',    url);
const post = (url, body)  => api('POST',   url, body);
const put  = (url, body)  => api('PUT',    url, body);
const del  = (url)        => api('DELETE', url);

// Guard: redirect to index if not logged in
async function requireSession(role) {
  try {
    const user = await get('/api/auth/me');
    if (role && user.role !== role) { window.location = '/'; return null; }
    return user;
  } catch {
    window.location = '/';
    return null;
  }
}

// Build an HTML table from data
function buildTable(cols, rows, opts = {}) {
  if (!rows.length) return `<div class="table-placeholder">No records found.</div>`;
  let html = `<table class="data-table"><thead><tr>`;
  cols.forEach(c => html += `<th>${c.label}</th>`);
  html += `</tr></thead><tbody>`;
  rows.forEach((row, i) => {
    const cls = (opts.highlightFn && opts.highlightFn(row)) ? 'highlight-own' : '';
    html += `<tr class="${cls}" data-idx="${i}">`;
    cols.forEach(c => {
      const val = typeof c.render === 'function' ? c.render(row) : (row[c.key] ?? '');
      html += `<td>${val}</td>`;
    });
    html += `</tr>`;
  });
  html += `</tbody></table>`;
  return html;
}


// Build multi-select list HTML. Caller passes the slot labels for the unit
// (teacher-managed via /api/units/:unitId/tutorial-slots).
function buildTutorialList(selectedSlots = [], allSlots = []) {
  const sel = typeof selectedSlots === 'string' ? selectedSlots.split(',').map(s => s.trim()) : selectedSlots;
  return allSlots.map(slot =>
    `<div class="list-item ${sel.includes(slot) ? 'selected' : ''}" data-slot="${slot}">${slot}</div>`
  ).join('');
}

// Wire up multi-select list toggle behaviour
function initTutorialList(container) {
  container.querySelectorAll('.list-item').forEach(item => {
    item.addEventListener('click', () => item.classList.toggle('selected'));
  });
}

function getSelectedSlots(container) {
  return [...container.querySelectorAll('.list-item.selected')].map(el => el.dataset.slot);
}

// Simple modal helper
function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
function hideModal(id) { document.getElementById(id).classList.add('hidden'); }

// Toast notification
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `alert alert-${type === 'error' ? 'error' : 'success'}`;
  el.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;max-width:320px;';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Status marks ─────────────────────────────────────────────────────────────
// Every colour-coded indicator in the app also says what it means in words or
// a glyph. Colour is a secondary cue only: a red/green dot with no text is
// invisible to a colourblind user and ambiguous to everyone else. Pages render
// verdicts through these so no page invents its own convention.
//
//   ok    ✓  passes / done
//   bad   ✕  breaks a rule / not done
//   info  ⓘ  advisory — a fact, not a fault (e.g. under the target size)
//   off   ○  not yet / locked
const STATUS_MARK = {
  ok:   { glyph: '✓', word: 'OK' },
  bad:  { glyph: '✕', word: 'Breaks a rule' },
  info: { glyph: 'ⓘ', word: 'Note' },
  off:  { glyph: '○', word: 'Not yet' },
};

function statusMark(kind, text) {
  const m = STATUS_MARK[kind] || STATUS_MARK.info;
  const label = text === undefined ? m.word : text;
  const safe = String(label).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  return `<span class="mark mark-${kind}" role="img" aria-label="${safe}">${m.glyph} ${safe}</span>`;
}

// One line explaining the marks a block uses, e.g. markLegend(['ok','bad','info']).
function markLegend(kinds) {
  return `<div class="mark-legend" aria-label="Legend">${
    kinds.map(k => `<span>${STATUS_MARK[k].glyph} ${STATUS_MARK[k].word}</span>`).join(' · ')}</div>`;
}

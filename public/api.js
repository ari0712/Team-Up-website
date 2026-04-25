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

// Status badge helper
function statusBadge(status) {
  const map = {
    FORMING: 'badge-yellow', COMPLETE: 'badge-green',
    PENDING: 'badge-yellow', ACCEPTED: 'badge-green', REJECTED: 'badge-red'
  };
  return `<span class="badge ${map[status] || 'badge-muted'}">${status}</span>`;
}

// Tutorial slots constant
const TUTORIAL_SLOTS = [
  'Monday 10am','Monday 12pm','Monday 2pm',
  'Tuesday 10am','Tuesday 12pm','Tuesday 2pm',
  'Wednesday 10am','Wednesday 12pm','Wednesday 2pm',
  'Thursday 10am','Thursday 12pm','Thursday 2pm',
  'Friday 10am','Friday 12pm','Friday 2pm'
];

// Build multi-select list HTML
function buildTutorialList(selectedSlots = []) {
  const sel = typeof selectedSlots === 'string' ? selectedSlots.split(',').map(s => s.trim()) : selectedSlots;
  return TUTORIAL_SLOTS.map(slot =>
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

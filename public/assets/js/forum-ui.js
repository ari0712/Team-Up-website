// The unit forum board, rendered identically for both portals.
//
// Both /student/forum.html and /teacher/forum.html are thin shells that set up
// their own sidebar and then call mountForum(). The board itself lives here
// because it is the same board — the API returns `canModerate`, so nothing in
// this file needs to know which portal it is running in.
//
// One page renders both views: no ?threadId is the thread list, ?threadId=N is
// that thread. Keeping them in one page keeps the sidebar's active item correct
// in both, and keeps the board's markup and styling in one place.

// ── Text safety ───────────────────────────────────────────────────
// EVERY string from the API goes through this. The forum is the first place in
// the app where one user's typing renders in another user's browser, so an
// unescaped interpolation here is a real stored-XSS hole, not a hypothetical
// one. (teacher/announcements.html injects raw — do not copy that page.)
const foEsc = value => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

function foInitials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// A missing avatar file does NOT 404 — the server's catch-all serves index.html
// with a 200 — so a broken image has to be caught with onerror, exactly as
// student/full-profile.html does.
function foAvatar(src, name) {
    if (!src) return `<div class="fo-initials">${foEsc(foInitials(name))}</div>`;
    return `<img class="fo-avatar" src="${foEsc(src)}" alt=""
                 onerror="this.outerHTML='&lt;div class=&quot;fo-initials&quot;&gt;${foEsc(foInitials(name))}&lt;/div&gt;'">`;
}

function foDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString('en-AU', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: 'numeric', minute: '2-digit'
    });
}

function foRolePill(role) {
    return role === 'TEACHER' ? `<span class="fo-role-pill">TEACHER</span>` : '';
}

const FO_TITLE_MAX = 200;
const FO_BODY_MAX  = 4000;

// Module state, set once by mountForum and read by the global handlers the
// inline onclick attributes call — the same shape every other page here uses.
let foUnitId = null;
let foRoot   = null;

async function mountForum({ unitId, container }) {
    foUnitId = unitId;
    foRoot   = container;
    await foRender();
}

// Which view to draw. Re-read on every render so navigating back to the list
// after deleting a thread picks the list up without a reload.
function foThreadIdFromUrl() {
    const raw = new URLSearchParams(location.search).get('threadId');
    const n = parseInt(raw);
    return Number.isFinite(n) ? n : null;
}

async function foRender() {
    const threadId = foThreadIdFromUrl();
    foRoot.innerHTML = `<p style="color:#888">Loading…</p>`;
    try {
        if (threadId === null) await foRenderList();
        else                   await foRenderThread(threadId);
    } catch (e) {
        foRoot.innerHTML = `<div class="fo-empty">Could not load the forum: ${foEsc(e.message)}</div>`;
    }
}

// ── Thread list ───────────────────────────────────────────────────

async function foRenderList() {
    const data = await get(`/api/forum/units/${foUnitId}/threads`);

    const cards = data.threads.length
        ? data.threads.map(t => foThreadCard(t)).join('')
        : `<div class="fo-empty">No discussions yet. Start the first one above.</div>`;

    foRoot.innerHTML = `
        <div class="fo-compose">
            <h3>Start a discussion</h3>
            <input id="fo-title" class="fo-input" type="text" maxlength="${FO_TITLE_MAX}"
                   placeholder="What do you want to ask or share?">
            <textarea id="fo-body" class="fo-textarea" maxlength="${FO_BODY_MAX}"
                      placeholder="Add the details. Everyone in this unit — including your teacher — can read this."></textarea>
            <p id="fo-error" class="fo-error"></p>
            <div class="fo-actions">
                <span class="fo-count">Visible to everyone in this unit</span>
                <button class="fo-btn" onclick="foPostThread()">Post</button>
            </div>
        </div>
        <div class="fo-section-label">${data.threads.length} discussion${data.threads.length === 1 ? '' : 's'}</div>
        ${cards}`;
}

function foThreadCard(t) {
    const href = `?unitId=${encodeURIComponent(foUnitId)}&threadId=${t.id}`;
    const excerpt = String(t.body || '');
    const short = excerpt.length > 180 ? excerpt.slice(0, 180) + '…' : excerpt;
    const activity = t.last_reply_at || t.created_at;

    return `
        <a class="fo-thread-card ${t.pinned ? 'pinned' : ''}" href="${foEsc(href)}">
            <div class="fo-thread-title">
                ${t.pinned ? `<span class="fo-pin-flag">PINNED</span> ` : ''}${foEsc(t.title)}
            </div>
            ${short ? `<div class="fo-thread-excerpt">${foEsc(short)}</div>` : ''}
            <div class="fo-thread-meta">
                ${foAvatar(t.author_avatar, t.author_name)}
                <span>${foEsc(t.author_name)}</span>
                ${foRolePill(t.author_role)}
                <span>· ${foEsc(foDate(activity))}</span>
                <span class="fo-replies-pill">${t.reply_count} ${t.reply_count === 1 ? 'reply' : 'replies'}</span>
            </div>
        </a>`;
}

async function foPostThread() {
    const titleEl = document.getElementById('fo-title');
    const bodyEl  = document.getElementById('fo-body');
    const errEl   = document.getElementById('fo-error');
    errEl.textContent = '';

    try {
        const r = await post(`/api/forum/units/${foUnitId}/threads`, {
            title: titleEl.value, body: bodyEl.value
        });
        // Straight into the thread that was just created — the author almost
        // always wants to see it, and it doubles as confirmation it posted.
        location.search = `?unitId=${encodeURIComponent(foUnitId)}&threadId=${r.id}`;
    } catch (e) {
        errEl.textContent = e.message;
    }
}

// ── Single thread ─────────────────────────────────────────────────

async function foRenderThread(threadId) {
    const data = await get(`/api/forum/units/${foUnitId}/threads/${threadId}`);
    const t = data.thread;

    const canDeleteThread = data.canModerate || t.author_username === data.me;
    const tools = [
        data.canModerate
            ? `<button class="fo-tool" onclick="foTogglePin(${t.id}, ${t.pinned ? 0 : 1})">${t.pinned ? 'Unpin' : 'Pin'}</button>`
            : '',
        canDeleteThread
            ? `<button class="fo-tool danger" onclick="foDeleteThread(${t.id})">Delete</button>`
            : ''
    ].join('');

    const replies = data.replies.length
        ? data.replies.map(r => foPost(r, data)).join('')
        : `<div class="fo-empty">No replies yet. Be the first to answer.</div>`;

    foRoot.innerHTML = `
        <a class="fo-back" href="?unitId=${encodeURIComponent(foUnitId)}">← Back to all discussions</a>

        <div class="fo-post op">
            <div class="fo-post-title">
                ${t.pinned ? `<span class="fo-pin-flag">PINNED</span> ` : ''}${foEsc(t.title)}
            </div>
            <div class="fo-post-head">
                ${foAvatar(t.author_avatar, t.author_name)}
                <span class="fo-post-name">${foEsc(t.author_name)}</span>
                ${foRolePill(t.author_role)}
                <span class="fo-post-date">${foEsc(foDate(t.created_at))}</span>
                <span class="fo-post-tools">${tools}</span>
            </div>
            <div class="fo-post-body">${foEsc(t.body)}</div>
        </div>

        <div class="fo-section-label">
            ${data.replies.length} ${data.replies.length === 1 ? 'reply' : 'replies'}
        </div>
        ${replies}

        <div class="fo-compose" style="margin-top:16px">
            <h3>Reply</h3>
            <textarea id="fo-reply" class="fo-textarea" maxlength="${FO_BODY_MAX}"
                      placeholder="Write your reply…"></textarea>
            <p id="fo-error" class="fo-error"></p>
            <div class="fo-actions">
                <button class="fo-btn" onclick="foPostReply(${t.id})">Post reply</button>
            </div>
        </div>`;
}

function foPost(r, data) {
    const canDelete = data.canModerate || r.author_username === data.me;
    return `
        <div class="fo-post">
            <div class="fo-post-head">
                ${foAvatar(r.author_avatar, r.author_name)}
                <span class="fo-post-name">${foEsc(r.author_name)}</span>
                ${foRolePill(r.author_role)}
                <span class="fo-post-date">${foEsc(foDate(r.created_at))}</span>
                <span class="fo-post-tools">
                    ${canDelete ? `<button class="fo-tool danger" onclick="foDeleteReply(${r.id})">Delete</button>` : ''}
                </span>
            </div>
            <div class="fo-post-body">${foEsc(r.body)}</div>
        </div>`;
}

async function foPostReply(threadId) {
    const bodyEl = document.getElementById('fo-reply');
    const errEl  = document.getElementById('fo-error');
    errEl.textContent = '';
    try {
        await post(`/api/forum/units/${foUnitId}/threads/${threadId}/replies`, { body: bodyEl.value });
        await foRender();   // refetch rather than patching local state
    } catch (e) {
        errEl.textContent = e.message;
    }
}

// ── Moderation ────────────────────────────────────────────────────
// The buttons these back are hidden for people who may not use them, but the
// service checks again on every call — hiding a control is presentation, not
// permission.

async function foTogglePin(threadId, pinned) {
    try {
        await api('PATCH', `/api/forum/units/${foUnitId}/threads/${threadId}/pin`, { pinned: !!pinned });
        await foRender();
    } catch (e) { alert(e.message); }
}

async function foDeleteThread(threadId) {
    if (!confirm('Delete this discussion and every reply on it? This cannot be undone.')) return;
    try {
        await del(`/api/forum/units/${foUnitId}/threads/${threadId}`);
        // The thread being viewed is gone, so go back to the board.
        location.search = `?unitId=${encodeURIComponent(foUnitId)}`;
    } catch (e) { alert(e.message); }
}

async function foDeleteReply(replyId) {
    if (!confirm('Delete this reply?')) return;
    try {
        await del(`/api/forum/units/${foUnitId}/replies/${replyId}`);
        await foRender();
    } catch (e) { alert(e.message); }
}

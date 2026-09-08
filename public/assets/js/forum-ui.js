// The unit forum board, rendered identically for both portals.
//
// Both /student/forum.html and /teacher/forum.html are thin shells that set up
// their own sidebar and then call mountForum(). The board itself lives here
// because it is the same board — the API returns `canModerate`, so nothing in
// this file needs to know which portal it is running in.
//
// One page renders every view: no ?threadId is the thread list, ?threadId=N is
// that thread, and ?tab= picks which list. Keeping them in one page keeps the
// sidebar's active item correct in all of them, and keeps the board's markup and
// styling in one place.
//
// Two of the tabs are about team formation. A RECRUITING thread carries its
// author's live team — derived by the server on every read, never stored on the
// post — and a button that opens the ordinary merge proposal. The Open teams tab
// is the existing Auto-Match, rendered here rather than ranked again.

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

// The active tab lives in the URL for the same reason threadId does: this board
// navigates by assigning location.search, a full reload, so a tab held in a
// variable would be lost the moment you opened a thread and came back.
function foTabFromUrl() {
    const t = new URLSearchParams(location.search).get('tab');
    return ['recruiting', 'teams'].includes(t) ? t : 'all';
}

// One place that builds board URLs, so every link keeps the tab you are on.
function foHref({ threadId = null, tab = foTabFromUrl() } = {}) {
    const p = new URLSearchParams({ unitId: foUnitId });
    if (tab && tab !== 'all') p.set('tab', tab);
    if (threadId !== null)    p.set('threadId', threadId);
    return '?' + p.toString();
}

async function foRender() {
    const threadId = foThreadIdFromUrl();
    foRoot.innerHTML = `<p style="color:#888">Loading…</p>`;
    try {
        if (threadId !== null) return await foRenderThread(threadId);
        // One fetch serves both list tabs. It also carries `role`, which decides
        // whether the Open teams tab exists at all.
        const data = await get(`/api/forum/units/${foUnitId}/threads`);
        if (foTabFromUrl() === 'teams' && data.role === 'STUDENT')
            return await foRenderOpenTeams(data);
        foRenderList(data);
    } catch (e) {
        foRoot.innerHTML = `<div class="fo-empty">Could not load the forum: ${foEsc(e.message)}</div>`;
    }
}

// Plain links, so a tab click is an ordinary navigation like opening a thread.
// Open teams is student-only: a teacher has no team to merge into, and
// /teacher/team-formation.html is already their version of that view.
function foTabBar(active, role) {
    const tab = (key, label) =>
        `<a class="fo-tab ${active === key ? 'active' : ''}"
            href="${foEsc(foHref({ tab: key }))}">${label}</a>`;
    return `<div class="fo-tabs">
        ${tab('all', 'All discussions')}
        ${tab('recruiting', 'Looking for teammates')}
        ${role === 'STUDENT' ? tab('teams', 'Open teams') : ''}
    </div>`;
}

// ── Thread list ───────────────────────────────────────────────────

function foRenderList(data) {
    const tab = foTabFromUrl();
    const recruitingOnly = tab === 'recruiting';
    const threads = recruitingOnly
        ? data.threads.filter(t => t.kind === 'RECRUITING')
        : data.threads;

    const cards = threads.length
        ? threads.map(t => foThreadCard(t)).join('')
        : `<div class="fo-empty">${recruitingOnly
            ? 'Nobody is looking for teammates yet. Post the first one above.'
            : 'No discussions yet. Start the first one above.'}</div>`;

    // Teachers cannot post a recruiting thread (the service rejects it), so they
    // do not get the choice. Hiding it is presentation; the server still checks.
    const kindPicker = data.role === 'STUDENT' ? `
        <div class="fo-kind">
            <label><input type="radio" name="fo-kind" value="DISCUSSION"
                          ${recruitingOnly ? '' : 'checked'}> Discussion</label>
            <label><input type="radio" name="fo-kind" value="RECRUITING"
                          ${recruitingOnly ? 'checked' : ''}> Looking for teammates</label>
        </div>` : '';

    foRoot.innerHTML = `
        ${foTabBar(tab, data.role)}
        <div class="fo-compose">
            <h3>${recruitingOnly ? 'Look for teammates' : 'Start a discussion'}</h3>
            ${kindPicker}
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
        <div class="fo-section-label">${threads.length} ${recruitingOnly
            ? `post${threads.length === 1 ? '' : 's'}`
            : `discussion${threads.length === 1 ? '' : 's'}`}</div>
        ${cards}`;
}

// ── Recruiting ────────────────────────────────────────────────────

// The one card renderer, shared by recruiting threads, the thread detail strip
// and the Open teams tab. Everything it draws was derived by the server at read
// time — nothing here is stored on a post, so it cannot go stale after a merge.
function foRecruitCard(r) {
    if (!r) return '';
    if (r.gone) return `<div class="fo-recruit">
        <span class="fo-recruit-why">This student is no longer on a team in this unit.</span>
    </div>`;

    const names = r.members.map(m => m.name || m.student_id).join(', ');
    // Two framings of the same fact. A recruiting post is about THAT team, so it
    // reads as spots left; an Open teams suggestion is about the merge, so it
    // reads as the size you would end up at.
    const size = r.merged_size
        ? `Team of ${r.size} · ${r.merged_size} together with yours`
        : `${r.size} of ${r.max_size}${r.spots_left
            ? ` · ${r.spots_left} spot${r.spots_left === 1 ? '' : 's'} left` : ' · full'}`;

    const action = r.can_request
        ? `<button class="fo-btn" onclick="foProposeMerge('${foEsc(r.team_id)}')">Send request</button>`
        : (r.why_not ? `<span class="fo-recruit-why">${foEsc(r.why_not)}</span>` : '');

    return `<div class="fo-recruit">
        <div class="fo-recruit-main">
            <div class="fo-recruit-members"><strong>${foEsc(r.team_name)}</strong> · ${foEsc(names)}</div>
            <div class="fo-recruit-why">${foEsc(size)}</div>
            ${r.reasons && r.reasons.length
                ? `<ul class="fo-recruit-why">${r.reasons.map(x => `<li>${foEsc(x)}</li>`).join('')}</ul>`
                : ''}
        </div>
        ${action}
    </div>`;
}

// Deliberately the SAME endpoint Find Teammates calls. The forum does not rank
// teams itself: two rankers would eventually disagree about who fits whom, and a
// student would be looking at both of them on the same afternoon.
async function foRenderOpenTeams(data) {
    const head = foTabBar('teams', data.role);
    let r;
    try {
        r = await get(`/api/student/units/${foUnitId}/auto-match`);
    } catch (e) {
        foRoot.innerHTML = head + `<div class="fo-empty">${
            e.message === 'DEADLINE_PASSED'
                ? 'Team formation has closed for this unit.'
                : foEsc(e.message)}</div>`;
        return;
    }

    const list = r.suggestions || [];
    const cards = list.map(s => foRecruitCard({
        gone: false,
        team_id: s.team_id,
        team_name: s.team_name,
        members: s.members,
        size: s.members.length,
        merged_size: s.mergedSize,
        spots_left: 0,
        reasons: s.reasons,
        can_request: true,
        why_not: null
    })).join('');

    foRoot.innerHTML = head + `
        <div class="fo-section-label">
            Ranked by shared tutorial time, then role variety, then shared interests.
            Teams need ${foEsc(r.valid_team_sizes)} members.
        </div>
        ${list.length ? cards
            : `<div class="fo-empty">${foEsc(r.why_empty || 'No suitable teams right now.')}</div>`}`;
}

// Sending a request IS a yes-vote from you; everyone on both teams still has to
// agree. On success we refetch rather than navigate, so every card re-derives
// itself — the one just actioned flips to "you already have a request open".
async function foProposeMerge(teamId) {
    try {
        const r = await post(`/api/student/units/${foUnitId}/proposals`, { targetTeamId: teamId });
        alert(r.state === 'approved'
            ? 'Merge approved — your teams are now combined.'
            : 'Request sent. It needs a yes from everyone on both teams.');
        await foRender();
    } catch (e) { alert(e.message); }
}

function foThreadCard(t) {
    const excerpt = String(t.body || '');
    const short = excerpt.length > 180 ? excerpt.slice(0, 180) + '…' : excerpt;
    const activity = t.last_reply_at || t.created_at;
    const recruiting = t.kind === 'RECRUITING';

    // The recruiting strip sits OUTSIDE the anchor: its Send request button
    // nested inside a link would have its clicks swallowed by the navigation.
    return `
        <a class="fo-thread-card ${t.pinned ? 'pinned' : ''} ${recruiting ? 'recruiting' : ''}"
           href="${foEsc(foHref({ threadId: t.id }))}">
            <div class="fo-thread-title">
                ${t.pinned ? `<span class="fo-pin-flag">PINNED</span> ` : ''}
                ${recruiting ? `<span class="fo-recruit-flag">LOOKING FOR TEAMMATES</span> ` : ''}${foEsc(t.title)}
            </div>
            ${short ? `<div class="fo-thread-excerpt">${foEsc(short)}</div>` : ''}
            <div class="fo-thread-meta">
                ${foAvatar(t.author_avatar, t.author_name)}
                <span>${foEsc(t.author_name)}</span>
                ${foRolePill(t.author_role)}
                <span>· ${foEsc(foDate(activity))}</span>
                <span class="fo-replies-pill">${t.reply_count} ${t.reply_count === 1 ? 'reply' : 'replies'}</span>
            </div>
        </a>
        ${foRecruitCard(t.recruiting)}`;
}

async function foPostThread() {
    const titleEl = document.getElementById('fo-title');
    const bodyEl  = document.getElementById('fo-body');
    const errEl   = document.getElementById('fo-error');
    errEl.textContent = '';

    const kindEl = document.querySelector('input[name="fo-kind"]:checked');

    try {
        const r = await post(`/api/forum/units/${foUnitId}/threads`, {
            title: titleEl.value, body: bodyEl.value,
            kind: kindEl ? kindEl.value : 'DISCUSSION'
        });
        // Straight into the thread that was just created — the author almost
        // always wants to see it, and it doubles as confirmation it posted.
        location.search = foHref({ threadId: r.id });
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
        <a class="fo-back" href="${foEsc(foHref())}">${foTabFromUrl() === 'recruiting'
            ? '← Back to looking for teammates' : '← Back to all discussions'}</a>

        <div class="fo-post op">
            <div class="fo-post-title">
                ${t.pinned ? `<span class="fo-pin-flag">PINNED</span> ` : ''}
                ${t.kind === 'RECRUITING' ? `<span class="fo-recruit-flag">LOOKING FOR TEAMMATES</span> ` : ''}${foEsc(t.title)}
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
        ${foRecruitCard(t.recruiting)}

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
        location.search = foHref();
    } catch (e) { alert(e.message); }
}

async function foDeleteReply(replyId) {
    if (!confirm('Delete this reply?')) return;
    try {
        await del(`/api/forum/units/${foUnitId}/replies/${replyId}`);
        await foRender();
    } catch (e) { alert(e.message); }
}

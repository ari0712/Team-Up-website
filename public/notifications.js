function nEsc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function nRelativeTime(iso) {
    if (!iso) return '';
    const then = new Date(iso);
    if (isNaN(then.getTime())) return '';
    const mins = Math.round((Date.now() - then.getTime()) / 60000);
    if (mins < 1)    return 'just now';
    if (mins < 60)   return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24)    return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
    const days = Math.round(hrs / 24);
    if (days < 7)    return `${days} day${days === 1 ? '' : 's'} ago`;
    return then.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

const NotificationFeed = {
    all: [],
    filter: 'all',
    unitFilter: 'all',
    categories: [],
    emptyText: 'You are all caught up.',

    async init({ categories, unitId, emptyText }) {
        this.categories = categories;
        this.unitFilter = unitId || 'all';
        if (emptyText) this.emptyText = emptyText;
        await this.load();
    },

    async load() {
        try {
            const data = await get('/api/notifications');
            this.all = data.notifications || [];
            if (this.unitFilter !== 'all' && !this.all.some(n => n.unitId === this.unitFilter))
                this.unitFilter = 'all';
            this.render();
        } catch (e) {
            document.getElementById('n-list').innerHTML =
                `<div class="n-empty"><strong>Could not load notifications</strong>${nEsc(e.message)}</div>`;
        }
    },

    inScope() {
        return this.unitFilter === 'all'
            ? this.all
            : this.all.filter(n => n.unitId === this.unitFilter);
    },

    visible() {
        return this.filter === 'all'
            ? this.inScope()
            : this.inScope().filter(n => n.category === this.filter);
    },

    render() {
        this.renderUnits();
        this.renderChips();
        this.renderList();
        const scoped = this.inScope();
        const unread = scoped.filter(n => !n.read).length;
        const btn = document.getElementById('n-mark-all');
        if (btn) {
            btn.disabled = unread === 0;
            btn.textContent = unread ? `Mark all as read (${unread})` : 'All read';
        }
        const badge = document.getElementById('n-header-count');
        if (badge) {
            badge.textContent = unread
                ? `${unread} unread update${unread === 1 ? '' : 's'}`
                : 'No unread updates';
        }
    },

    renderUnits() {
        const sel = document.getElementById('n-unit-filter');
        if (!sel) return;
        const units = [];
        this.all.forEach(n => {
            if (n.unitId && !units.some(u => u.id === n.unitId))
                units.push({ id: n.unitId, name: n.unitName || n.unitId });
        });
        if (units.length < 2) { sel.style.display = 'none'; return; }
        sel.style.display = '';
        sel.innerHTML = `<option value="all">All units</option>` +
            units.map(u => `<option value="${nEsc(u.id)}">${nEsc(u.name)}</option>`).join('');
        sel.value = this.unitFilter;
        sel.onchange = () => { this.unitFilter = sel.value; this.render(); };
    },

    renderChips() {
        const bar = document.getElementById('n-chips');
        if (!bar) return;
        const scoped = this.inScope();
        const items = [{ key: 'all', label: 'All' }, ...this.categories];
        bar.innerHTML = items.map(c => {
            const set = c.key === 'all' ? scoped : scoped.filter(n => n.category === c.key);
            const unread = set.filter(n => !n.read).length;
            return `<button class="n-chip ${this.filter === c.key ? 'active' : ''}"
                            onclick="NotificationFeed.setFilter('${c.key}')">
                        ${nEsc(c.label)}<span class="n-chip-count">${set.length}${unread ? ` · ${unread} new` : ''}</span>
                    </button>`;
        }).join('');
    },

    renderList() {
        const list = document.getElementById('n-list');
        if (!list) return;
        const items = this.visible();

        if (!items.length) {
            list.innerHTML = `<div class="n-empty">
                <strong>Nothing here right now</strong>${nEsc(this.emptyText)}</div>`;
            return;
        }

        list.innerHTML = items.map(n => {
            const details = (n.details && n.details.length) ? `
                <details class="n-details">
                    <summary>${n.details.length} item${n.details.length === 1 ? '' : 's'}</summary>
                    ${n.details.map(d => `
                        <div class="n-detail-row">
                            <span>${nEsc(d.label)}</span>
                            <span class="n-detail-meta">${nEsc(d.meta || '')}</span>
                        </div>`).join('')}
                </details>` : '';

            return `
            <article class="n-card sev-${n.severity} ${n.read ? 'is-read' : ''}" id="n-card-${nEsc(n.key)}">
                <div class="n-card-head">
                    <div class="n-card-title">${nEsc(n.title)}</div>
                    ${n.read ? '' : '<span class="n-unread-dot" title="Unread"></span>'}
                </div>
                <div class="n-card-body">${nEsc(n.body)}</div>
                ${details}
                <div class="n-card-meta">
                    <span class="n-tag sev-${n.severity}">${nEsc(n.severity)}</span>
                    ${n.unitName ? `<span class="n-time">${nEsc(n.unitName)}</span>` : ''}
                    <span class="n-time">${nRelativeTime(n.createdAt)}</span>
                    <span class="n-meta-spacer"></span>
                    <button class="n-mark-btn" onclick="NotificationFeed.toggleRead('${nEsc(n.key)}')">
                        ${n.read ? 'Mark unread' : 'Mark read'}
                    </button>
                    ${n.link ? `<a class="n-open-link" href="${nEsc(n.link)}">Open</a>` : ''}
                </div>
            </article>`;
        }).join('');
    },

    setFilter(key) {
        this.filter = key;
        this.render();
    },

    async toggleRead(key) {
        const item = this.all.find(n => n.key === key);
        if (!item) return;
        const nowRead = !item.read;
        item.read = nowRead;              
        this.render();
        try {
            await post(nowRead ? '/api/notifications/read' : '/api/notifications/unread', { keys: [key] });
        } catch (e) {
            item.read = !nowRead;
            this.render();
        }
    },

    async markAll() {
        const keys = this.inScope().filter(n => !n.read).map(n => n.key);
        if (!keys.length) return;
        this.inScope().forEach(n => n.read = true);
        this.render();
        try {
            await post('/api/notifications/read', { keys });
        } catch (e) {
            await this.load();
        }
    }
};


//  EmailPanel

const EmailPanel = {
    prefs: null,

    async init() {
        try {
            this.prefs = await get('/api/notifications/prefs');
            this.render();
        } catch (e) {
            this.msg(e.message, 'err');
        }
    },

    render() {
        const p = this.prefs;
        document.getElementById('n-signup-email').textContent = p.signupEmail || '(no email on file)';
        document.getElementById('n-email-override').value = p.emailOverride || '';
        document.getElementById('n-deliver-to').textContent = p.deliverTo || '—';

        const enabledEl = document.getElementById('n-email-enabled');
        if (enabledEl) enabledEl.checked = p.emailEnabled;
        const severityEl = document.getElementById('n-min-severity');
        if (severityEl) severityEl.value = p.minSeverity || 'INFO';
    },

    async save() {
        try {
            const payload = { emailOverride: document.getElementById('n-email-override').value.trim() };
            const enabledEl = document.getElementById('n-email-enabled');
            if (enabledEl) payload.emailEnabled = enabledEl.checked;
            const severityEl = document.getElementById('n-min-severity');
            if (severityEl) payload.minSeverity = severityEl.value;

            this.prefs = await put('/api/notifications/prefs', payload);
            this.render();
            this.msg('Saved.', 'ok');
        } catch (e) {
            this.msg(e.message, 'err');
        }
    },

    msg(text, kind) {
        const el = document.getElementById('n-email-msg');
        if (!el) return;
        el.textContent = text;
        el.className = `n-msg ${kind}`;
    }
};

async function notificationUnreadCount() {
    try {
        const r = await get('/api/notifications/count');
        return r.unread || 0;
    } catch {
        return 0;
    }
}

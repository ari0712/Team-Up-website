const STUDENT_NAV_ITEMS = [
    { key: 'home',           label: 'Home',           href: '/student-home.html',             noUnit: true },
    { key: 'dashboard',      label: 'Dashboard',      href: '/student-dashboard.html' },
    { key: 'rules',          label: 'Rules',          href: '/student-rules.html',            stage: 'read_rules' },
    { key: 'preferences',    label: 'Preferences',    href: '/student-preferences.html',      stage: 'entered_preferences' },
    { key: 'find-teammates', label: 'Find Teammates', href: '/student-find-teammates.html' },
    { key: 'my-team',        label: 'My Team',        href: '/student-my-team.html',          stage: 'in_team' },
    { key: 'status',         label: 'Status',         href: '/student-status.html',           stage: 'submitted_request' },
    { key: 'final-team',     label: 'Final Team',     href: '/student-final-team.html',       stage: 'teacher_approved' },
    { key: 'profile',        label: 'Your Profile',   href: '/student-profile.html' },
];

async function initStudentNav({ activeItem, pageTitle }) {
    const unitId = new URLSearchParams(location.search).get('unitId');

    // Auth check
    let user;
    try {
        const r = await fetch('/api/auth/me');
        user = await r.json();
        if (!user || user.role !== 'STUDENT') { window.location = '/'; return; }
    } catch { window.location = '/'; return; }

    // Set header
    const titleEl   = document.getElementById('page-title');
    const welcomeEl = document.getElementById('welcome-name');
    if (titleEl)   titleEl.textContent   = pageTitle || 'Student Portal';
    if (welcomeEl) welcomeEl.textContent = user.displayName || user.username;

    // Build sidebar
    const navEl = document.getElementById('student-sidebar');
    if (navEl) {
        // Fetch progress to show completion dots (non-blocking)
        let progress = {};
        if (unitId) {
            try {
                progress = await fetch(`/api/student/units/${unitId}/progress`)
                    .then(r => r.json());
            } catch { /* sidebar still renders without progress */ }
        }

        // Fetch unit name for sidebar header
        let unitName = '';
        if (unitId) {
            try {
                const unit = await fetch(`/api/student/units/${unitId}`)
                    .then(r => r.json());
                unitName = unit.unit_name || '';
            } catch { /* skip */ }
        }

        // Unit name badge at top of sidebar
        const unitBadge = unitId && unitName ? `
            <div style="
                margin: 0 14px 8px;
                padding: 8px 12px;
                background: #eef4ff;
                border: 1px solid #c8d8ff;
                border-radius: 8px;
                font-size: 12px;
                font-weight: 700;
                color: #2663ff;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            ">${unitName}</div>
        ` : '';

        // Divider between Home and the unit-specific items
        let html = unitBadge;

        STUDENT_NAV_ITEMS.forEach((item, i) => {
            // Add a thin divider between Home and Dashboard
            if (i === 1) {
                html += `<div style="height:1px;background:#e8f0fb;margin:6px 0"></div>`;
            }

            const href     = item.noUnit ? item.href : (unitId ? `${item.href}?unitId=${unitId}` : '#');
            const disabled = !item.noUnit && !unitId;
            const isActive = item.key === activeItem;
            const isDone   = item.stage ? progress[item.stage] == 1 : null;

            // Dot indicator for stages
            const dot = isDone !== null ? `
                <span style="
                    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
                    background: ${isDone ? '#22c55e' : '#e0e8f0'};
                    display: inline-block; margin-left: auto;
                "></span>` : '';

            if (isActive) {
                html += `
                    <button class="t-snav-active" style="display:flex;align-items:center;gap:6px">
                        ${item.label}${dot}
                    </button>`;
            } else if (disabled) {
                html += `
                    <span class="t-snav-link t-snav-disabled"
                          style="display:flex;align-items:center;gap:6px">
                        ${item.label}${dot}
                    </span>`;
            } else {
                html += `
                    <a class="t-snav-link" href="${href}"
                       style="display:flex;align-items:center;gap:6px">
                        ${item.label}${dot}
                    </a>`;
            }
        });

        navEl.innerHTML = html;
    }

    return { user, unitId };
}

function studentLogout() {
    fetch('/api/auth/logout', { method: 'POST' }).then(() => window.location = '/');
}

async function requireUnitAccess(unitId) {
    try {
        const unit = await get(`/api/student/units/${unitId}`);
        return unit;
    } catch(e) {
        if (e.message === 'NOT_JOINED' || e.message.includes('NOT_JOINED')) {
            window.location = '/student-home.html';
            return null;
        }
        throw e;
    }
}

// Shared teacher sidebar, modelled on student-nav.js.
//
// This used to be a `buildTeacherSidebar` function copy-pasted into every
// teacher page, which meant adding a nav item was a five-file edit and the
// unread badge would have had to be pasted five times to work everywhere.
const TEACHER_NAV_ITEMS = [
    { key: 'home',            label: 'Home',           href: '/teacher/home.html', noUnit: true },
    { key: 'dashboard',       label: 'Dashboard',      href: '/teacher/dashboard.html' },
    { key: 'notifications',   label: 'Notifications',  href: '/teacher/notifications.html', badge: true },
    { key: 'team-formation',  label: 'Team Formation', href: '/teacher/team-formation.html' },
    { key: 'class-list',      label: 'Class List',     href: '/teacher/class-list.html' },
    { key: 'announcements',   label: 'Announcements',  href: '/teacher/announcements.html' },
    { key: 'export',          label: 'Export',         href: '/teacher/export.html' },
];

// Renders into #teacher-sidebar. Kept synchronous-ish and side-effect free so
// pages that already have a unitId in scope can call it directly; use
// initTeacherNav below if you also want the session check.
async function buildTeacherSidebar(activeItem, unitId) {
    const navEl = document.getElementById('teacher-sidebar');
    if (!navEl) return;

    if (unitId === undefined) {
        unitId = new URLSearchParams(location.search).get('unitId');
    }

    // Non-blocking, exactly like the student sidebar's count: a failed or
    // forbidden request must still leave a usable sidebar behind.
    let unreadCount = 0;
    if (unitId) {
        try {
            const c = await fetch(`/api/teacher/units/${unitId}/notifications/count`)
                .then(r => r.json());
            unreadCount = c.count || 0;
        } catch { /* sidebar still renders without the badge */ }
    }

    navEl.innerHTML = TEACHER_NAV_ITEMS.map(item => {
        const href = item.noUnit ? item.href : (unitId ? `${item.href}?unitId=${unitId}` : '#');

        // Red unread count — omitted entirely at zero so it only ever appears
        // when there is something to look at.
        const badge = (item.badge && unreadCount > 0)
            ? `<span class="t-snav-badge">${unreadCount}</span>` : '';

        if (item.key === activeItem) {
            return `<button class="t-snav-active"
                            style="display:flex;align-items:center;gap:6px">${item.label}${badge}</button>`;
        }
        return `<a class="t-snav-link" href="${href}"
                   style="display:flex;align-items:center;gap:6px">${item.label}${badge}</a>`;
    }).join('');
}

// Session check + sidebar in one call, mirroring initStudentNav. Returns
// { user, unitId } or null when the guard has already redirected.
async function initTeacherNav({ activeItem, pageTitle }) {
    const user = await requireSession('TEACHER');
    if (!user) return null;

    const unitId = new URLSearchParams(location.search).get('unitId');

    const titleEl   = document.getElementById('page-title');
    const welcomeEl = document.getElementById('teacherName') || document.getElementById('welcome-name');
    if (titleEl)   titleEl.textContent   = pageTitle || 'Teacher Portal';
    if (welcomeEl) welcomeEl.textContent = user.displayName || user.username;

    await buildTeacherSidebar(activeItem, unitId);
    return { user, unitId };
}

function teacherLogout() {
    fetch('/api/auth/logout', { method: 'POST' }).then(() => window.location = '/');
}

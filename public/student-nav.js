// student-nav.js — include in every student page
// Usage: call initStudentNav({ activeItem: 'dashboard', pageTitle: 'Student Dashboard' })

const STUDENT_NAV_ITEMS = [
    { key: 'home',           label: 'Home',            href: '/student-home.html',              noUnit: true },
    { key: 'dashboard',      label: 'Dashboard',       href: '/student-dashboard.html' },
    { key: 'rules',          label: 'Rules',           href: '/student-rules.html' },
    { key: 'preferences',    label: 'Preferences',     href: '/student-preferences.html' },
    { key: 'find-teammates', label: 'Find Teammates',  href: '/student-find-teammates.html' },
    { key: 'my-team',        label: 'My Team',         href: '/student-my-team.html' },
    { key: 'status',         label: 'Status',          href: '/student-status.html' },
    { key: 'final-team',     label: 'Final Team',      href: '/student-final-team.html' },
];

async function initStudentNav({ activeItem, pageTitle }) {
    // Get unitId from URL
    const unitId = new URLSearchParams(location.search).get('unitId');

    // Auth check
    let user;
    try {
        const r = await fetch('/api/auth/me');
        user = await r.json();
        if (!user || user.role !== 'STUDENT') { window.location = '/'; return; }
    } catch { window.location = '/'; return; }

    // Set header title + welcome
    const titleEl = document.getElementById('page-title');
    const welcomeEl = document.getElementById('welcome-name');
    if (titleEl) titleEl.textContent = pageTitle || 'Student Portal';
    if (welcomeEl) welcomeEl.textContent = user.displayName || user.username;

    // Build sidebar
    const navEl = document.getElementById('student-sidebar');
    if (navEl) {
        navEl.innerHTML = STUDENT_NAV_ITEMS.map(item => {
            const href = item.noUnit ? item.href : (unitId ? `${item.href}?unitId=${unitId}` : '#');
            const isActive = item.key === activeItem;
            const disabled = !item.noUnit && !unitId;
            return `<a class="t-snav-item ${isActive ? 't-snav-active' : ''} ${disabled ? 't-snav-disabled' : ''}"
                   href="${disabled ? '#' : href}"
                   onclick="${disabled ? 'return false' : ''}">${item.label}</a>`;
        }).join('');
    }

    return { user, unitId };
}

function studentLogout() {
    fetch('/api/auth/logout', { method: 'POST' }).then(() => window.location = '/');
}

// Guard: call this at the top of any page that requires unit access.
// Returns the unit data, or redirects to home if not joined.
async function requireUnitAccess(unitId) {
    try {
        const unit = await get(`/api/student/units/${unitId}`);
        return unit;
    } catch(e) {
        // If the API returned NOT_JOINED, redirect to home
        if (e.message === 'NOT_JOINED' || e.message.includes('NOT_JOINED')) {
            window.location = '/student-home.html';
            return null;
        }
        throw e;
    }
}
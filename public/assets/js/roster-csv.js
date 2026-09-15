// Shared roster-CSV parsing for the teacher pages.
//
// Both the create-unit wizard and the class-list top-up read the same kind of
// file, so the parsing lives here rather than being duplicated per page. The
// import endpoint is additive (unit_roster upserts by email and never deletes),
// which is what makes uploading a second, third or later file safe.
const ROSTER_EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

// Strips a UTF-8 BOM, which Excel writes on "CSV UTF-8" export and which would
// otherwise make the first header read "﻿email" and never match.
const rosterCell = v =>
    String(v ?? '').replace(/^﻿/, '').trim().replace(/^"(.*)"$/, '$1').trim();

// Header spellings accepted for each optional column, normalised to lowercase
// alphanumerics. Anything not listed here is ignored.
const ROSTER_COLUMNS = {
    email:           ['email', 'emailaddress'],
    name:            ['name', 'fullname', 'studentname'],
    student_number:  ['studentid', 'studentnumber', 'id'],
    tutorial_time:   ['tutorial', 'tutorialtime', 'tutorialslot', 'tutorialslots'],
    degree:          ['degree', 'course'],
    major:           ['major'],
    minor:           ['minor'],
    units_passed:    ['unitspassed', 'unitscompleted'],
    it_skill_groups: ['itskillgroups', 'skills', 'skillgroups'],
};

// Parses CSV text into { students, loaded, duplicate, invalid, error }.
//
// `students` carries only the fields the file actually supplied — a blank cell
// is omitted entirely rather than sent as '', because the server treats a blank
// value as "leave what is already stored" and an omitted one the same way. That
// is what lets an email-only top-up run without erasing details an earlier,
// richer import had filled in.
function parseRosterCsv(text) {
    const rows = String(text).split(/\r?\n/)
        .map(l => l.split(',').map(rosterCell))
        .filter(r => r.some(v => v));
    if (!rows.length) return { students: [], loaded: 0, duplicate: 0, invalid: 0, error: 'file is empty' };

    // Which column holds the address? A header named "email" wins. Failing that,
    // fall back to the first column that actually looks like an email — so a bare
    // list with no header row still imports.
    const header = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
    let emailCol = header.findIndex(h => ROSTER_COLUMNS.email.includes(h));
    let start = 1;
    if (emailCol === -1) {
        emailCol = rows[0].findIndex(v => ROSTER_EMAIL_RE.test(v));
        start = 0;                          // no header — row 0 is data
    }
    if (emailCol === -1)
        return { students: [], loaded: 0, duplicate: 0, invalid: 0, error: 'no email column found' };

    // Optional columns are only looked for when there is a header row to name them.
    const cols = {};
    if (start === 1) {
        for (const [field, names] of Object.entries(ROSTER_COLUMNS)) {
            if (field === 'email') continue;
            const i = header.findIndex(h => names.includes(h));
            if (i !== -1) cols[field] = i;
        }
    }

    const seen = new Set();
    const students = [];
    let invalid = 0, duplicate = 0;
    for (let i = start; i < rows.length; i++) {
        const email = (rows[i][emailCol] || '').toLowerCase();
        if (!email) continue;
        if (!ROSTER_EMAIL_RE.test(email)) { invalid++; continue; }
        if (seen.has(email)) { duplicate++; continue; }
        seen.add(email);

        const entry = { email };
        for (const [field, idx] of Object.entries(cols)) {
            const value = rows[i][idx];
            if (value) entry[field] = value;
        }
        students.push(entry);
    }

    return {
        students, loaded: students.length, duplicate, invalid,
        error: students.length ? null : 'no valid email addresses found',
    };
}

// ── Example file ────────────────────────────────────────────────────────────
// The header row is derived from ROSTER_COLUMNS above, so the example on the
// page can never show a column the parser would ignore. The sample rows are
// the same ones shipped in /assets/roster-template.csv — keep the two in step.
const ROSTER_EXAMPLE_HEADERS = {
    email: 'email', name: 'name', student_number: 'student id', tutorial_time: 'tutorial',
    degree: 'degree', major: 'major', minor: 'minor', units_passed: 'units passed',
    it_skill_groups: 'skills',
};
const ROSTER_EXAMPLE_ROWS = [
    ['n1234567@qut.edu.au', 'Alex Tan',    'n1234567', 'Tue 10:00', 'Bachelor of IT', 'Computer Science', 'Data Science',      '12', 'Web Development'],
    ['n7654321@qut.edu.au', 'Priya Nair',  'n7654321', 'Wed 14:00', 'Bachelor of IT', 'Information Systems', '',               '8',  'UI Design'],
    ['n2468135@qut.edu.au', "Sam O'Brien", 'n2468135', 'Tue 10:00', 'Bachelor of IT', 'Computer Science', 'Cyber Security',    '16', 'Testing'],
];

const rosterEsc = v => String(v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A spreadsheet-style mock-up of an acceptable file: column letters, row
// numbers, the header row exactly as accepted, then the sample rows.
function rosterExampleHtml() {
    const headers = Object.keys(ROSTER_COLUMNS).map(k => ROSTER_EXAMPLE_HEADERS[k] || k);
    const letters = headers.map((_, i) => String.fromCharCode(65 + i));
    const cell = (v, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${rosterEsc(v)}</td>`;

    const colRow = `<tr><th class="rx-corner"></th>${letters.map(l => `<th class="rx-col">${l}</th>`).join('')}</tr>`;
    const headRow = `<tr><th class="rx-row">1</th>${headers.map((h, i) =>
        cell(h, 'rx-head' + (i === 0 ? ' rx-required' : ''))).join('')}</tr>`;
    const dataRows = ROSTER_EXAMPLE_ROWS.map((r, n) =>
        `<tr><th class="rx-row">${n + 2}</th>${r.map(v => cell(v)).join('')}</tr>`).join('');

    return `
        <div class="roster-example">
            <div class="rx-scroll">
                <table class="rx-sheet">${colRow}${headRow}${dataRows}</table>
            </div>
            <p class="rx-note">
                Only <code>email</code> (column A) is required — leave any other column out or
                empty. <code>tutorial</code> must match a slot name you set under Manage Tutorial
                Slots, one per student. Save from Excel or Sheets as <strong>CSV</strong>.
                <a class="rx-download" href="/assets/roster-template.csv" download>Download template (.csv)</a>
            </p>
        </div>`;
}

// One-line summary of a parse result, shared so both pages word it the same way.
function rosterParseSummary(r) {
    if (r.error) return r.error;
    const notes = [];
    if (r.duplicate) notes.push(`${r.duplicate} duplicate${r.duplicate !== 1 ? 's' : ''} skipped`);
    if (r.invalid)   notes.push(`${r.invalid} invalid skipped`);
    return `${r.loaded} student${r.loaded !== 1 ? 's' : ''} loaded` +
           (notes.length ? ` (${notes.join(', ')})` : '');
}

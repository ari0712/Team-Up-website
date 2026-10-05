// Read-only rendering of a student's full profile, shared by the student page
// (public/student/full-profile.html, which adds editing on top) and the
// teacher's read-only page (public/teacher/student-profile.html).
//
// Both are fed the same object by the same shape builder on the server
// (utils/studentProfile.js), so what a teacher reads is exactly what a
// classmate reads. Styles live in /assets/css/profile.css.

const esc = value => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

// Escaping alone would collapse the student's paragraphs into one block, so
// blank lines become paragraph breaks and single newlines become <br>.
function prose(text) {
    const paragraphs = esc(text).split(/\n{2,}/)
        .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    return `<div class="fp-prose">${paragraphs}</div>`;
}

function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : ''))
        .toUpperCase();
}

// A missing file does NOT 404 here — the server's catch-all returns index.html
// with a 200 — so a broken image has to be caught with onerror rather than by
// checking the response.
function avatarHtml(src, name) {
    if (!src) return `<div class="fp-initials">${esc(initials(name))}</div>`;
    return `<img class="fp-avatar" src="${esc(src)}" alt=""
                 onerror="this.outerHTML='&lt;div class=&quot;fp-initials&quot;&gt;${esc(initials(name))}&lt;/div&gt;'">`;
}

function tagLine(label, csv) {
    const items = String(csv || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!items.length) return '';
    return `<div class="fp-tags"><strong>${esc(label)}:</strong> ${esc(items.join(' · '))}</div>`;
}

// Photo, name, role and the three tag lines. `src` overrides the stored photo
// (the student page shows an unsaved one), and `extraHtml` is appended inside
// the identity block — that is where the student page puts its photo controls.
function profileHeaderHtml(profile, { src, extraHtml = '' } = {}) {
    const photo = src !== undefined ? src : profile.avatarPath;
    return `
      <div class="fp-head">
        ${avatarHtml(photo, profile.name)}
        <div style="min-width:0">
          <div class="fp-name">${esc(profile.name)}${
              profile.email ? `<span class="fp-id"> – ${esc(profile.email)}</span>` : ''}</div>
          <div class="fp-role">Preferred Role: ${esc(profile.preferredRole || 'Not set')}</div>
          ${tagLine('Tutorial availability', profile.tutorialSlots)}
          ${tagLine('Skills', profile.skills)}
          ${tagLine('Interests', profile.projectInterests)}
          ${extraHtml}
        </div>
      </div>`;
}

// The About Me answers. A blank one stays visible and greyed: an absent section
// reads as a broken page, an explicit "not filled in" reads as a choice.
function profileAboutHtml(about) {
    return (about || []).map(field => `
      <div class="fp-section">
        <div class="fp-section-title">${esc(field.label)}</div>
        ${field.value.trim() ? prose(field.value) : `<div class="fp-empty">Not filled in yet</div>`}
      </div>`).join('');
}

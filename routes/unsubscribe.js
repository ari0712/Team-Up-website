const express = require('express');

// The link at the bottom of every student email. No login: the token in the
// URL is the credential. Switches off one category for one unit and says so.
//
// A token that matches nobody gets the same generic page as a malformed link —
// nothing here confirms whether an address or a token exists, and the token is
// never written to the log.
module.exports = function createUnsubscribeRouter({ studentPortalService }) {
  const router = express.Router();

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} – TeamUp</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#1a2a4a;line-height:1.5}
h1{font-size:22px}a{color:#2663ff}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

  router.get('/', (req, res) => {
    const { t: token, u: unitId, c: category } = req.query;
    let result = null;
    try { result = studentPortalService.unsubscribeByToken(String(token || ''), String(unitId || ''), String(category || '')); }
    catch (e) { console.error('Unsubscribe failed:', e.message); }

    if (!result) {
      return res.status(400).send(page('This link is not valid',
        `<p>The unsubscribe link could not be used. It may be incomplete or out of date.</p>
         <p>You can manage every email setting from the <a href="/student/notifications.html">Notifications page</a> once signed in.</p>`));
    }
    res.send(page('Emails switched off',
      `<p>You will no longer get emails about <strong>${esc(result.label)}</strong> for this unit.</p>
       <p>In-app notifications are unchanged. To turn this back on or adjust the rest, open the
       <a href="/student/notifications.html?unitId=${encodeURIComponent(result.unitId)}">Notifications page</a>.</p>`));
  });

  return router;
};

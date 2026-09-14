const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// No colour may carry meaning on its own. Every coloured dot the pages render
// must have a word or glyph beside it that says the same thing. This is a
// static scan of the page sources, not a substitute for looking at the page —
// but it fails loudly if a future change re-introduces a bare dot.
//
// A "labelled" dot is one whose surrounding template line(s) contain a
// statusMark() call, a `mark-*` span, a glyph inside the element,
// or one of the status words the compliant rows already use.

const ROOT = path.join(__dirname, '..', 'public');
const DOT_CLASSES = ['s-val-dot', 'tf-dot', 'cl-dot', 't-dot', 'sh-dot', 's-note-dot', 'background: ${isDone'];
// A legend is deliberately NOT a per-row label: it explains the marks but does
// not vouch for any one row. Status words need word boundaries so that
// identifiers like `isDone` do not count.
const LABEL = /statusMark\(|mark-(ok|bad|info|off)|aria-label=|✓|✕|ⓘ|○|\b(Completed|In Progress|Locked|Done|Not yet)\b|t-progress-label|t-progress-stat|s-progress-status/;

function* pageFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'css' && entry.name !== 'uploads') yield* pageFiles(full); }
    else if (/\.(html|js)$/.test(entry.name)) yield full;
  }
}

describe('colour-coded indicators carry a label', () => {
  for (const file of pageFiles(ROOT)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    test(rel, () => {
      const bare = [];
      lines.forEach((line, i) => {
        // Only rendered markup: skip CSS rules and comments.
        const t = line.trim();
        if (t.startsWith('.') || t.startsWith('/*') || t.startsWith('//') || t.startsWith('*')) return;
        // A class-name computation is not the rendered element; the row that uses it follows.
        if (t.startsWith('const ') || t.startsWith('let ') || t.startsWith(':')) return;
        if (!DOT_CLASSES.some(c => line.includes(c))) return;
        // The label may sit on the same line or within the next few lines of the
        // SAME row — the window stops at the next dot element, so one row's label
        // can never vouch for its neighbour.
        let end = i + 1;
        while (end < Math.min(lines.length, i + 6) && !DOT_CLASSES.some(c => lines[end].includes(c))) end++;
        const window = lines.slice(i, end).join('\n');
        if (!LABEL.test(window)) bare.push(`${rel}:${i + 1}: ${t.slice(0, 100)}`);
      });
      assert.deepEqual(bare, [], 'colour-only indicator(s):\n' + bare.join('\n'));
    });
  }
});

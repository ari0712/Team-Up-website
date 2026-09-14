// Matching a student against a search box, for Find Teammates.
//
// Students can see two things about each other on Canvas: a NAME and a
// connect email. Names are misspelt and half-remembered, so name matching is
// tolerant — partial tokens, order-free, and a small edit distance. Email
// matching is the opposite: the FULL normalised address, exactly, or nothing.
// Connect addresses are predictably formatted, and a prefix or substring match
// would let anyone walk the address space one fragment at a time and harvest
// confirmations. Someone who already holds an address can still search it;
// someone guessing gets nothing back from a fragment.
//
// Whether an email is then SHOWN to the searcher is a separate rule, decided
// in StudentPortalService.searchClassmates — this module only answers "does
// this student match?" and how well.

// Lowercase, strip diacritics, collapse everything non-alphanumeric to a
// single space.
function normalise(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const tokens = s => normalise(s).split(' ').filter(Boolean);

// Emails keep their punctuation: "a.chen@x" and "achen@x" are different people.
const normaliseEmail = s => String(s ?? '').trim().toLowerCase();

// Damerau–Levenshtein (optimal string alignment): an adjacent transposition
// costs 1, so "micheal" is one edit from "michael" rather than two.
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

// How many edits a query token may be off by. A short token gets one edit
// only against a LONGER name token — a dropped letter ("alx" → "alex",
// "jon" → "john") — never a same-length substitution: "jon" with one free
// edit would match "jan", "ron" and "joe" alike.
function allowance(q, t) {
  if (q.length <= 3) return t.length > q.length ? 1 : 0;
  if (q.length <= 6) return 1;
  return 2;
}

// 3 exact, 2 prefix, 1 fuzzy, 0 no match.
function tokenScore(q, t) {
  if (q === t) return 3;
  if (t.startsWith(q)) return 2;
  if (editDistance(q, t) <= allowance(q, t)) return 1;
  return 0;
}

// { match, matchedBy: 'name' | 'email' | null, score }
//
// Name: every query token must match some name token (order-free, so
// "lee pat" finds "Pat Lee"). Score is the weakest token match, so a result
// is only as good as its worst-matched word.
// Email: the whole query equals the whole address. Ranks with an exact name.
function matchesStudent(query, student) {
  const q = String(query ?? '').trim();
  if (!q) return { match: true, matchedBy: null, score: 0 };

  if (q.includes('@')) {
    const match = normaliseEmail(q) === normaliseEmail(student.email);
    return { match, matchedBy: match ? 'email' : null, score: match ? 3 : 0 };
  }

  const qTokens = tokens(q);
  const nTokens = tokens(student.name);
  if (!qTokens.length || !nTokens.length) return { match: false, matchedBy: null, score: 0 };

  let score = 3;
  for (const qt of qTokens) {
    const best = Math.max(...nTokens.map(nt => tokenScore(qt, nt)));
    if (!best) return { match: false, matchedBy: null, score: 0 };
    score = Math.min(score, best);
  }
  return { match: true, matchedBy: 'name', score };
}

module.exports = { normalise, normaliseEmail, tokens, editDistance, matchesStudent };

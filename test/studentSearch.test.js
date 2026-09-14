const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { matchesStudent, editDistance, normalise } = require('../utils/studentSearch');

const michael = { name: 'Michael Smith', email: 'michael.smith@connect.qut.edu.au' };
const john    = { name: 'John Doe',      email: 'n1234567@connect.qut.edu.au' };
const hit  = (q, s) => assert.equal(matchesStudent(q, s).match, true,  `"${q}" should match ${s.name}`);
const miss = (q, s) => assert.equal(matchesStudent(q, s).match, false, `"${q}" should NOT match ${s.name}`);

describe('studentSearch — tolerant on names, exact on email', () => {
  test('partial tokens match as prefixes', () => {
    hit('sam', { name: 'Samuel Ng', email: 's@x' });
    hit('mic', michael);
    hit('smi', michael);
  });

  test('transposition and single-letter slips are forgiven on longer tokens', () => {
    assert.equal(editDistance('micheal', 'michael'), 1);
    hit('Micheal', michael);
    hit('Jonh', john);          // 4 letters → one edit allowed
    hit('Smoth', michael);      // 5 letters → one edit
    hit('Michaell', michael);
  });

  test('short tokens: a dropped letter is forgiven, a substitution is not', () => {
    miss('Jon', { name: 'Jan Kowalski', email: 'j@x' });   // same length, no fuzz
    miss('Tim', { name: 'Tom Ford', email: 't@x' });
    hit('Jon', { name: 'John Doe', email: 'j@x' });        // dropped letter
    hit('Alx', { name: 'Alex Chen', email: 'a@x' });
    hit('Jon', { name: 'Jonathan Lee', email: 'j@x' });    // still a prefix
  });

  test('order-free and diacritic-insensitive', () => {
    hit('smith michael', michael);
    hit('lee pat', { name: 'Pat Lee', email: 'p@x' });
    hit('jose', { name: 'José Nuñez', email: 'j@x' });
    assert.equal(normalise("O'Brien-Åström"), 'o brien astrom');
  });

  test('every query token must land somewhere', () => {
    miss('michael jones', michael);
  });

  test('a full email address matches exactly, case- and whitespace-insensitively', () => {
    const r = matchesStudent('michael.smith@connect.qut.edu.au', michael);
    assert.deepEqual(r, { match: true, matchedBy: 'email', score: 3 });
    hit('  MICHAEL.SMITH@CONNECT.QUT.EDU.AU ', michael);
    miss('michael.smith@connect.qut.edu.au', john);
  });

  test('a fragment of an email never matches — no enumeration by prefix or substring', () => {
    for (const q of ['n1234', 'n1234567', 'n1234567@', 'n1234567@connect', '@connect.qut.edu.au',
                     'doe@connect.qut.edu.au', 'connect.qut.edu.au', 'michael.smith@', 'smith@connect'])
      miss(q, q.includes('n1234') || q.includes('doe') ? john : michael);
    // A local part without the "@" is treated as a NAME query, so it only
    // matches when the name itself matches — it reveals nothing about the address.
    miss('n1234567', john);
  });

  test('scores rank exact > prefix > fuzzy, and an empty query matches everything at score 0', () => {
    assert.equal(matchesStudent('michael', michael).score, 3);
    assert.equal(matchesStudent('mich', michael).score, 2);
    assert.equal(matchesStudent('micheal', michael).score, 1);
    assert.equal(matchesStudent('smith micheal', michael).score, 1);   // weakest token wins
    assert.deepEqual(matchesStudent('', michael), { match: true, matchedBy: null, score: 0 });
  });
});

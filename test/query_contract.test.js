// Live operator-contract tests for the RDV query parser (see
// rdv-query-parser-2026-09-05.md *(internal)*).
//
// The parser never reports an error, so the offline suite — which stubs the
// backend by construction — cannot see any of this move. Each open trap is
// pinned twice, like daterange_contamination.test.js: an INVARIANT stating the
// behaviour we want (todo while the defect stands) and a CANARY pinning today's
// broken behaviour, so the suite stays green until the backend changes and
// then names exactly which claim in src/guide.md / CLAUDE.md / the tool description
// to re-probe. Both halves of a pair read their probe strings from the same
// constant, so a re-probe cannot update one and leave the other testing
// something else. A fixed trap keeps only its invariant, which then guards the
// guidance that now recommends the operator. Calls go below the tool layer —
// assertQuery would refuse the wrapped probe, and the compiler's trim would
// hide the whitespace pair.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE, liveSearchCount } from './helpers.js';
import { OBJECT_TYPE_VALUES } from '../src/config.js';

// Title scope, 19th century: small enough to be cheap, large enough that every
// baseline below is in the hundreds.
const count = (query, { scope = 'title', filters = {}, raw = false } = {}) =>
  liveSearchCount({ query, scope, filters, year_from: 1801, year_to: 1900 }, raw ? { rawQuery: query } : {});

// Derived from the registry, not spelled: a renamed key would filter to a
// silent 0 and let the diacritics contract pass against an empty population.
const FOLDOUTS = { object_type: ['foldout'] };
const BOOKS = { object_type: Object.keys(OBJECT_TYPE_VALUES).filter((k) => k !== 'foldout') };

test('live: baselines — a trailing * is a working prefix', { skip: !LIVE }, async () => {
  const [plain, prefix] = await Promise.all([count('Cholera'), count('Cholera*')]);
  assert.ok(plain > 100, `Cholera title baseline unexpectedly small: ${plain}`);
  assert.ok(prefix > plain, `Cholera* (${prefix}) should exceed Cholera (${plain})`);
});

// --- spaced vs compact OR -------------------------------------------------------

const SPACED_OR = 'Cholera* | Karte*';
const COMPACT_OR = 'Cholera*|Karte*';

const SPACED_PHRASE_OR = '"Asiatische Cholera" | Karte';
const COMPACT_PHRASE_OR = '"Asiatische Cholera"|Karte';

test('live: | ORs whatever its spacing, beside wildcard and phrase clauses alike', { skip: !LIVE }, async () => {
  const [spaced, compact, cholera, karte, spacedPhrase, compactPhrase] = await Promise.all([
    count(SPACED_OR), count(COMPACT_OR), count('Cholera*'), count('Karte*'),
    count(SPACED_PHRASE_OR), count(COMPACT_PHRASE_OR),
  ]);
  assert.ok(compact > cholera && compact > karte,
    `"${COMPACT_OR}" (${compact}) is no longer the union of ${cholera} and ${karte}: | has stopped ORing`);
  assert.equal(spaced, compact,
    `"${SPACED_OR}" (${spaced}) ≠ "${COMPACT_OR}" (${compact}): whitespace around | matters again — restore the spacing rule in the SKILL syntax section and the sgbr_search query description`);
  assert.equal(spacedPhrase, compactPhrase,
    `"${SPACED_PHRASE_OR}" (${spacedPhrase}) ≠ "${COMPACT_PHRASE_OR}" (${compactPhrase}): a spaced | drops a phrase clause again`);
});

// --- parentheses -----------------------------------------------------------------

const WRAPPED = '(Cholera)';
const INNER = 'Cholera (1831)';
const INNER_STRIPPED = 'Cholera 1831';

test('live: a parenthesised query searches its terms', { skip: !LIVE, todo: true }, async () => {
  const [wrapped, plain] = await Promise.all([count(WRAPPED), count('Cholera')]);
  assert.equal(wrapped, plain, 'parentheses change the result');
});

test('live: the parentheses canary — "(Cholera)" still matches the whole corpus', { skip: !LIVE }, async () => {
  const [wrapped, everything, inner, split] = await Promise.all([
    count(WRAPPED), count(''), count(INNER), count(INNER_STRIPPED),
  ]);
  assert.equal(wrapped, everything,
    `"${WRAPPED}" (${wrapped}) no longer equals the empty query (${everything}): the backend may have started honouring parentheses — re-probe, then revisit detectQueryError's refusal and the SKILL grouping row`);
  assert.equal(inner, split,
    `"${INNER}" (${inner}) no longer equals "${INNER_STRIPPED}" (${split}): inner parentheses are no longer simply stripped`);
});

// --- exclusion --------------------------------------------------------------------

const BOTH = 'Karte Basel';
const EXCLUDED = 'Karte -Basel';
const LEADING_MINUS = '-Karte';

const LEADING_MINUS_AND = '-Karte Basel';

// The SKILL exclude row and the tool description recommend -term; a failure
// here means they must go back to the `exclude` argument.
test('live: -term excludes exactly, mid-query and leading', { skip: !LIVE }, async () => {
  const [karte, basel, both, excluded, negated, negatedAnd, everything] = await Promise.all([
    count('Karte'), count('Basel'), count(BOTH), count(EXCLUDED), count(LEADING_MINUS), count(LEADING_MINUS_AND), count(''),
  ]);
  assert.ok(both > 0, `"${BOTH}" baseline is empty, so the subtractions below prove nothing`);
  assert.equal(excluded, karte - both, `"${EXCLUDED}" (${excluded}) ≠ Karte ${karte} − "${BOTH}" ${both}`);
  assert.equal(negated, everything - karte, `"${LEADING_MINUS}" (${negated}) ≠ all ${everything} − Karte ${karte}`);
  assert.equal(negatedAnd, basel - both,
    `"${LEADING_MINUS_AND}" (${negatedAnd}) ≠ Basel ${basel} − "${BOTH}" ${both}: a leading - no longer reads as a plain exclusion — revisit detectQueryError`);
});

// --- mid-word wildcards -----------------------------------------------------------

const MID_WORD = 'Bur*hardt';
const LITERAL = 'Burckhardt';

test('live: a mid-word wildcard matches at least the literal word', { skip: !LIVE, todo: true }, async () => {
  const [wild, literal] = await Promise.all([count(MID_WORD), count(LITERAL)]);
  assert.ok(wild >= literal, `${MID_WORD} (${wild}) finds fewer titles than ${LITERAL} (${literal})`);
});

test('live: the mid-word wildcard canary — "Bur*hardt" is still 0 in title scope', { skip: !LIVE }, async () => {
  const [wild, literal, prefix] = await Promise.all([count(MID_WORD), count(LITERAL), count('Burck*')]);
  assert.ok(literal > 0 && prefix >= literal, `${LITERAL} ${literal} / Burck* ${prefix}: the prefix baseline itself moved`);
  assert.equal(wild, 0,
    `"${MID_WORD}" now finds ${wild} titles: mid-word wildcards work on the catalogue fields — re-probe and revisit the SKILL wildcard row and the tool description`);
});

// --- edge whitespace (the one thing the compiler rewrites) -----------------------

const LEADING_SPACE = ' Cholera*';
const TRAILING_SPACE = 'Cholera* ';

test('live: edge whitespace is insignificant', { skip: !LIVE }, async () => {
  const [lead, trail, clean] = await Promise.all([
    count(LEADING_SPACE, { raw: true }), count(TRAILING_SPACE, { raw: true }), count('Cholera*'),
  ]);
  assert.equal(lead, clean, `"${LEADING_SPACE}" (${lead}) ≠ "Cholera*" (${clean})`);
  assert.equal(trail, clean, `"${TRAILING_SPACE}" (${trail}) ≠ "Cholera*" (${clean})`);
});

// --- diacritics: folded per scope AND per record family --------------------------

test('live: the diacritics contract — catalogue scopes fold for books, full text and foldouts do not', { skip: !LIVE }, async () => {
  const [tBooks, tBooksAcc, ftBooks, ftBooksAcc, tFold, tFoldAcc] = await Promise.all([
    count('Cholera', { filters: BOOKS }), count('choléra', { filters: BOOKS }),
    count('Cholera', { scope: 'fulltext', filters: BOOKS }), count('choléra', { scope: 'fulltext', filters: BOOKS }),
    count('Cholera', { filters: FOLDOUTS }), count('choléra', { filters: FOLDOUTS }),
  ]);
  assert.equal(tBooks, tBooksAcc,
    `title scope no longer folds accents for book records (Cholera ${tBooks} vs choléra ${tBooksAcc}): the SKILL diacritics bullet and CLAUDE.md are stale`);
  assert.ok(ftBooks > ftBooksAcc * 2,
    `full text now folds accents (Cholera ${ftBooks} vs choléra ${ftBooksAcc}): drop the "OR the accent variants" guidance for full text`);
  assert.ok(tFold > 0 && tFold !== tFoldAcc,
    `foldout records now fold accents in title scope (Cholera ${tFold} vs choléra ${tFoldAcc}): the per-record-family caveat is stale`);
});

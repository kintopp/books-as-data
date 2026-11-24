// Compiles high-level tool arguments into RDV `search` GraphQL variables.
// Key rules from probing: scope via `searchFields` (never field:value); always
// send view; free text passes through as written (symbolic Lucene honored) bar
// one normalisation, edge whitespace — see queryBase.

import {
  VIEW, SCOPE_FIELDS, FACET_DIMENSIONS, AUTOCOMPLETE_GROUPS,
  SEARCH_HIGHLIGHT_FIELD, SEARCH_SNIPPET_MAX_COUNT,
  AVAILABILITY_FULLTEXT_VALUES, FULLTEXT_ONLY_DIMENSION, SORT_ORDERS, DEFAULT_SORT, RANGE_FILTERS, DATERANGE_FAMILY_SUFFIX,
  DATERANGE_MAX_YEAR,
} from '../config.js';

// Filter one of the include-overloaded dimensions to one or more values on its
// own facet field. `and:false` = OR across the values. Values use the write-path
// encoding "[<dimension>].<value>" — distinct from the "strings:"-prefixed
// read-path form that facets return (verified: the "strings:" form filters to
// 0). Shared by the `string` and `concept` kinds, which differ only in field:
// the concept encoding was verified against its facet counts (2,478 for
// "[topic].Schweiz", exactly the bucket; the bare label matches a looser 2,905).
const includeDimFilter = (field, dimension, values) => ({
  boolTerm: { and: false, field, values: values.map((v) => `[${dimension}].${v}`) },
});

// Filter an agent dimension (author) by plain labels on the agent field, OR-ed
// (verified: the plain label matches; `agents:`-prefixed does not).
const agentFilter = (field, values) => ({ boolTerm: { and: false, field, values } });

// Build one dimension's filter clause from the FACET_DIMENSIONS registry, or
// null if it yields no usable values. `daterange` (year) is handled separately.
function dimensionFilter(dimKey, rawValues) {
  const dim = FACET_DIMENSIONS[dimKey];
  if (!dim) return null;
  // object_type maps friendly keys (foldout) → every stored spelling we know
  // (['Falttafel', 'Einzelseite']). Flattened into one OR-ed clause so the same
  // request narrows correctly whichever vocabulary the backend is serving.
  const values = (dim.valueMap ? rawValues.flatMap((v) => dim.valueMap[v] || []) : rawValues).filter(Boolean);
  if (!values.length) return null;
  // Include-based dims filter on include[0] while faceting forwards the whole
  // include array — safe only because every such dimension carries exactly ONE
  // include value, an invariant asserted by test/config.test.js. A multi-include
  // dimension would make filtering and faceting silently disagree.
  if (dim.kind === 'string' || dim.kind === 'concept') {
    return includeDimFilter(dim.field, dim.include[0], values);
  }
  if (dim.kind === 'agent') return agentFilter(dim.field, values);
  return null;
}

// One daterange family narrowed to [from, to] (a publication year, or a numeric
// measure stored as a pseudo-year) — see config.js for why the family
// selector must ride in `values`. The backend requires RFC3339 timestamps
// (verified: bare years/dates are rejected); open-ended on either side via
// sentinel years.
function familyRangeFilter(family, from, to) {
  if (from == null && to == null) return null;
  // The tool schemas bound every input, but this module is documented as
  // reusable — clamp defensively so no caller can produce a malformed RFC3339
  // date (negative or 5-digit years break the zero-padded format).
  const clamp = (y, fallback) => {
    const n = Number.isFinite(y) ? Math.trunc(y) : fallback;
    return Math.min(Math.max(n, 0), DATERANGE_MAX_YEAR);
  };
  const pad = (y) => String(y).padStart(4, '0');
  const start = `${pad(clamp(from, 0))}-01-01T00:00:00Z`;
  const end = `${pad(clamp(to, DATERANGE_MAX_YEAR))}-12-31T23:59:59Z`;
  return {
    boolTerm: {
      and: true,
      field: FACET_DIMENSIONS.year.field,
      values: [`[${family}].${DATERANGE_FAMILY_SUFFIX}`],
      rangeValues: [{ startTime: start, endTime: end }],
    },
  };
}

// Verified filter clauses (boolTerm form). FULLTEXT_ONLY OR-s every spelling of
// "has full text" the backend has used, so it counts correctly on either index —
// see the vocabulary note in config.js for why this is a list and not a string.
const FLAGS_ALL = { boolTerm: { and: true, field: 'flags', values: ['all'] } };
const FULLTEXT_ONLY = includeDimFilter(
  FACET_DIMENSIONS[FULLTEXT_ONLY_DIMENSION].field, FACET_DIMENSIONS[FULLTEXT_ONLY_DIMENSION].include[0],
  [...AVAILABILITY_FULLTEXT_VALUES],
);

// Query + scope + base filters, shared by the search, facet and cross-tab
// builders so their counts agree. The trim is the ONE normalisation applied to
// a free-text query: edge whitespace carries no intent, and trimming it lets
// the response cache serve both spellings from one entry. Everything else is
// refused or forwarded as written, never rewritten (see warnings.js); a
// whitespace-only query is refused there before it gets here.
// Autocomplete does NOT route through this: its backend is a prefix suggester
// where a trailing space may be a word boundary.
function queryBase(query, scope, fullTextOnly) {
  if (!SCOPE_FIELDS[scope]) throw new Error(`unknown scope: ${scope}`);
  const searchFields = SCOPE_FIELDS[scope].map((field) => ({ field }));
  const filters = [FLAGS_ALL];
  if (fullTextOnly) filters.unshift(FULLTEXT_ONLY);
  return { query: query.trim(), searchFields, filters };
}

function dimensionClauses(filters, not) {
  const clauses = [];
  for (const [dimKey, vals] of Object.entries(filters || {})) {
    const values = Array.isArray(vals) ? vals : (vals == null ? [] : [vals]);
    if (!values.length) continue;
    const clause = dimensionFilter(dimKey, values);
    if (!clause) continue;
    // `not` negates the whole OR-ed clause. A copy, never a mutation: a clause
    // builder that ever returned a shared object would stay negated for good.
    clauses.push(not ? { boolTerm: { ...clause.boolTerm, not: true } } : clause);
  }
  return clauses;
}

// Turn the tool's `filters` / `exclude` objects (dimension → value[]) plus the
// RANGE_FILTERS bounds (keyed by their tool argument names) into backend filter
// clauses. Unknown keys and empty value lists are skipped; values within a
// dimension OR, dimensions AND (matches the advanced-search UI); an `exclude`
// dimension drops records carrying ANY of its values. Each range is its own
// clause, so ranges AND with each other and with the dimensions.
export function buildDimensionFilters({ filters = {}, exclude = {}, ...bounds } = {}) {
  const ranges = RANGE_FILTERS
    .map((r) => familyRangeFilter(r.family, bounds[r.lo], r.hi ? bounds[r.hi] : null))
    .filter(Boolean);
  return [...dimensionClauses(filters, false), ...dimensionClauses(exclude, true), ...ranges];
}

export function buildSearchVariables({
  query = '', scope = 'all', fullTextOnly = false, page = 1, pageSize = 10, sort = DEFAULT_SORT, ...narrowing
}) {
  const { query: q, searchFields, filters: base } = queryBase(query, scope, fullTextOnly);
  // Unknown sort fields are a hard backend error, so only allow-listed names go out.
  if (!SORT_ORDERS[sort]) throw new Error(`unknown sort: ${sort}`);
  return {
    query: q,
    view: VIEW,
    searchFields,
    filters: [...base, ...buildDimensionFilters(narrowing)],
    size: pageSize,
    first: (page - 1) * pageSize,
    sort: SORT_ORDERS[sort],
    highlights: [SEARCH_HIGHLIGHT_FIELD],
    // Forward-compat only — INERT on the current backend: RDV does not forward
    // highlighter params to Elasticsearch, so these do NOT bound anything. The
    // window is fixed at the ES defaults (UP TO 5 fragments — fewer when the record
    // has fewer matching passages — × ~100 chars); the shaper in record.js is what
    // actually caps count/length. Kept as the front-end-observed config names so it
    // starts working for free if RDV wires the highlighter through later.
    // → rdv-graphql-schema.md *(internal)*
    searchConfig: [
      { name: 'highlighterNumberOfFragments', value: SEARCH_SNIPPET_MAX_COUNT },
      { name: 'maxSnippetCount', value: SEARCH_SNIPPET_MAX_COUNT },
    ],
  };
}

// Variables for facetFiltered: same query scoping as search + the dimension's
// term config. `facet` is a friendly name (key of FACET_DIMENSIONS). Dimension
// `filters` + the ranges narrow the population the facet counts over — the same
// clauses search builds, so counting one dimension while filtering on another
// (a cross-tab slice) stays consistent with sgbr_search.
//
// Under facet="year" the family-selected year clause DOES narrow its own
// aggregation (unlike a `filters` clause on its own dimension), but the buckets
// count every year a matching record's date span covers, so they spill outside
// the range; buildFacetResponse trims them to it.
export function buildFacetVariables({
  query = '', scope = 'all', fullTextOnly = false, facet, size, ...narrowing
}) {
  const dim = FACET_DIMENSIONS[facet];
  if (!dim) throw new Error(`unknown facet dimension: ${facet}`);
  const { query: q, searchFields, filters: base } = queryBase(query, scope, fullTextOnly);
  const term = { field: dim.field, size };
  if (dim.include) term.include = dim.include;
  return {
    query: q,
    view: VIEW,
    searchFields,
    filters: [...base, ...buildDimensionFilters(narrowing)],
    facet: { term },
  };
}

// Variables for the `stats` batched cross-tab (takes no `view` — stats rejects
// it, like get/autocomplete). `rowValues`/`colValues` are SHAPED facet rows
// ({ value, count, gnd_id? }) from buildFacetResponse; each cell's `inFilter`
// AND-combines the row's and column's dimension clauses (built generically off
// FACET_DIMENSIONS via buildDimensionFilters — the same clause a sgbr_search
// `filters` narrowing would produce) plus every narrowing clause; only the
// constant flags clause stays in the shared `filters`. Cells are named
// by colon-joined row:col indices so the shaper can reconstruct the grid
// without parsing user-supplied values back out of the name.
export function buildStatsCrosstabVariables({
  query = '', scope = 'all', fullTextOnly = false, facet, breakdown,
  rowValues, colValues, ...narrowing
}) {
  if (!FACET_DIMENSIONS[facet]) throw new Error(`unknown facet dimension: ${facet}`);
  if (!FACET_DIMENSIONS[breakdown]) throw new Error(`unknown breakdown dimension: ${breakdown}`);
  const { query: q, searchFields } = queryBase(query, scope, false);
  // Any narrowing clause in the shared `filters` (a range, an exclude, even a
  // positive filter) makes stats attach real counts to the wrong cell names,
  // differently on every call. Inside each cell's inFilter it mostly counts
  // correctly; the tool double-checks the rest (see facet_breakdown.js).
  const narrowed = [...(fullTextOnly ? [FULLTEXT_ONLY] : []), ...buildDimensionFilters(narrowing)];
  const queryFilters = [];
  rowValues.forEach((rv, i) => colValues.forEach((cv, j) => {
    // Pass the shaped rows' scalar `.value`, NOT the row object — passing the
    // object would silently encode `[dim].[object Object]` (string dims) or
    // ship the object as an agent-filter value (author), both 0-hit clauses.
    const inFilter = buildDimensionFilters({ filters: { [facet]: [rv.value], [breakdown]: [cv.value] } });
    // Every cell must carry BOTH axis clauses: buildDimensionFilters drops
    // falsy values, and a cell missing one side would count the wrong
    // population as an exact-looking number. The tool filters unusable axis
    // buckets before calling this — failing loudly here backstops that.
    if (inFilter.length !== 2) {
      throw new Error(
        `cross-tab cell ${i}:${j} compiled ${inFilter.length} filter clause(s) instead of 2 ` +
        `(unfilterable axis value: ${JSON.stringify(rv.value)} × ${JSON.stringify(cv.value)})`,
      );
    }
    queryFilters.push({ name: `${i}:${j}`, inFilter: [...inFilter, ...narrowed] });
  }));
  return { query: q, searchFields, filters: [FLAGS_ALL], queryFilters };
}

// Variables for autocomplete (takes no `view`). `scope` selects which suggestion
// groups to request; each becomes a SearchNamedField mapping name → search field.
export function buildAutocompleteVariables({ query = '', scope = 'all', fullTextOnly = false }) {
  const names = scope === 'all' ? Object.keys(AUTOCOMPLETE_GROUPS) : [scope];
  const searchNamedFields = names.map((name) => ({
    name,
    searchFields: [{ field: AUTOCOMPLETE_GROUPS[name].field }],
  }));
  const filters = [FLAGS_ALL];
  if (fullTextOnly) filters.unshift(FULLTEXT_ONLY);
  return { query, searchNamedFields, filters };
}

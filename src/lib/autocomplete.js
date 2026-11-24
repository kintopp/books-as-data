// Shapes an RDV AutocompleteResult into grouped suggestion lists. Suggestions
// live in `namedResults[]` keyed by the group name we requested (the typed
// titles/authors/subjects fields are always empty).

// MARC non-filing indicators, which the suggestion index returns raw
// ("<<Die>> Erdbeben-Theorie…") while every other surface — search hits,
// sgbr_get_record — serves the same title cleaned. The markers are punctuation
// to the tokenizer, so a stripped title still matches as a phrase query.
const NON_FILING = /<<|>>/g;
const cleanSuggestion = (s) => (typeof s === 'string' ? s.replace(NON_FILING, '').replace(/\s+/g, ' ').trim() : s);

// TITLE ONLY, and structurally so rather than because the other groups happen to
// be clean today (probed: zero "<<" in the top 200 subject_heading / author /
// genre / volume_info values — non-filing brackets are a MARC 245 convention, and
// subject headings invert instead: "Lächerliche, Das"). Every group serves
// searchable text (the search.title/author/subject fields), NOT the authority
// vocabulary the filter dimensions read — probed: most author and subject
// suggestions return zero as filters — so a suggestion's one valid use is as a
// query string. Still, never rewrite the non-title groups: stripping is only
// probed safe for titles.
const CLEANED_GROUPS = new Set(['title']);

export function buildAutocompleteResponse(autocomplete, { query, scope, fullTextOnly, groups, limit }) {
  const byName = new Map((autocomplete.namedResults || []).map((n) => [n.name, n.results || []]));
  const suggestions = {};
  for (const g of groups) {
    const raw = byName.get(g) || [];
    const cleaned = CLEANED_GROUPS.has(g) ? raw.map(cleanSuggestion) : raw;
    // Dedupe BEFORE the limit: stripping markup can collapse two index entries
    // onto one string, and `limit` should buy distinct completions.
    suggestions[g] = [...new Set(cleaned)].slice(0, limit);
  }

  // RDV populates the top-level countResult only for a SINGLE named group; ask for
  // several and it returns a flat 0 beside a full suggestion list. Where it IS
  // populated it equals search.totalCount for the same scope exactly, so trust any
  // positive value and trust 0 only when one group was asked for — never pass the
  // multi-group 0 off as "no records match". namedResults[].countResult is NOT a
  // fallback: it counts index terms, not records ("Burck"/author reports 3972
  // against a true 28).
  //
  // That equals-search.totalCount identity is also the field's whole semantics,
  // and why it is NOT named for the suggestions: the count matches the query as a
  // COMPLETE term while the suggestions are prefix matches, so the two answer
  // different questions. "Erdbeb" counts 0 beside 5 suggestions, and "Base"
  // counts 175 (a German word of its own) beside suggestions all about Basel.
  const count = autocomplete.countResult?.resultCount;
  const exactTermRecords = Number.isInteger(count) && (count > 0 || groups.length === 1) ? count : null;

  const structured = {
    query,
    scope,
    full_text_only: fullTextOnly,
    exact_term_records: exactTermRecords,
    suggestions,
  };
  return { structured, text: renderAutocompleteText(structured, groups) };
}

function renderAutocompleteText(s, groups) {
  const q = `"${s.query}"`;
  // A bare "?" reads like a failure; say the count is unavailable and where to get
  // one, since the multi-group case is the default and therefore the common one.
  const headline = s.exact_term_records != null
    ? `Autocomplete for ${q} — ${s.exact_term_records.toLocaleString('en-US')} record(s) match ${q} as a `
      + `COMPLETE term${s.exact_term_records === 0 ? ', which is normal for a partial prefix' : ''}; `
      + 'the suggestions below are prefix matches, and each has its own, different count — '
      + 'search one to get it.'
    : `Autocomplete for ${q} — record count not reported for this scope; `
      + 'use sgbr_search (or a single-group scope) for an exact total.';
  const lines = [headline];
  let any = false;
  for (const g of groups) {
    const items = s.suggestions[g] || [];
    if (!items.length) continue;
    any = true;
    lines.push('', `${g[0].toUpperCase() + g.slice(1)}:`);
    for (const item of items) lines.push(`  - ${item}`);
  }
  if (!any) lines.push('', 'No suggestions — try a shorter or different prefix.');
  return lines.join('\n');
}

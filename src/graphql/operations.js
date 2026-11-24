// GraphQL operation documents, matching the RDV schema (reverse-engineered by live
// probing → rdv-graphql-schema.md *(internal)*).

export const SEARCH_QUERY = /* GraphQL */ `
query Search(
  $query: String!, $view: String, $searchFields: [SearchField!], $filters: [InFilter!],
  $size: Int, $first: Int, $sort: [SortField!], $highlights: [String!],
  $searchConfig: [ConfigurationValue!]
) {
  search(
    query: $query, view: $view, searchFields: $searchFields, filters: $filters,
    size: $size, first: $first, sort: $sort, highlights: $highlights,
    searchConfig: $searchConfig
  ) {
    totalCount
    parsedError
    countResult { resultCount digitalizedCount allACLCount optionalCount }
    results {
      id
      highlights
      result { key metadata { text } }
    }
  }
}`;

// Single-record retrieval by id. Unlike search, we pull `link` and `extended`
// too — the RDV API keeps its high-value payloads (CSL-JSON citation, IIIF
// manifest URLs, GND/GeoNames authorities, full-text links) in those sidecars.
export const GET_RECORD_QUERY = /* GraphQL */ `
query Get($id: String!) {
  get(id: $id) {
    id
    lastUpdated
    result { key metadata { text link extended } }
  }
}`;

// Values + counts for one facet dimension, scoped to a query (the same
// searchFields/filters as search, so counts agree with sgbr_search). Values are
// a union: strings (strVal), authors (label + GND identifier), years (timeRange).
export const FACET_FILTERED_QUERY = /* GraphQL */ `
query FacetFilter(
  $query: String!, $view: String, $searchFields: [SearchField!],
  $filters: [InFilter!], $facet: InFacet!
) {
  facetFiltered(
    query: $query, view: $view, searchFields: $searchFields,
    filters: $filters, facet: $facet
  ) {
    name group count nbTotal othersCount
    values {
      __typename
      ... on FacetValueString { strVal count }
      ... on FacetValueInt { intVal count }
      ... on FacetValueLabelIdentifier { label identifier count }
      ... on FacetValueTimeRange { startTime endTime count }
    }
  }
}`;

// Type-ahead suggestions. NOTE: takes no `view` arg, and the typed
// titles/authors/subjects fields are always empty — real suggestions come back
// in `namedResults[]`, keyed by the `name` we supply in searchNamedFields.
export const AUTOCOMPLETE_QUERY = /* GraphQL */ `
query Autocomplete($query: String!, $searchNamedFields: [SearchNamedField!], $filters: [InFilter!]) {
  autocomplete(query: $query, searchNamedFields: $searchNamedFields, filters: $filters) {
    namedResults { name results }
    countResult { resultCount }
  }
}`;

// Batched named-filter counts — the server-side cross-tab primitive
// (rdv-stats-crosstab.md *(internal)*). NOTE: takes no `view` arg, like `get`/
// `autocomplete`. `filters` sets the base population; each `queryFilters[].
// inFilter` is the EXTRA per-cell narrowing (AND-combined with `filters`), so
// one call can price an entire N×M cross-tab grid. `NamedResult.results` comes
// back empty (this is a count op, not retrieval) — the cell value is
// `countResult.resultCount`, verified to reconcile exactly with
// `search.totalCount` under the same combined filters — but only while
// `filters` carries no narrowing (see buildStatsCrosstabVariables).
export const STATS_QUERY = /* GraphQL */ `
query Stats($query: String!, $searchFields: [SearchField!], $filters: [InFilter!], $queryFilters: [InFilterList!]) {
  stats(query: $query, searchFields: $searchFields, filters: $filters, queryFilters: $queryFilters) {
    statsResult { name countResult { resultCount } }
  }
}`;

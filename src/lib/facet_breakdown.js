// Shapes a `stats` batched cross-tab response into a { rows[].cells[] } grid and
// renders the text channel. Reuses facet.js's shapeValue so the axis values
// (row/column labels, GND ids, year buckets) normalize identically to
// sgbr_facet_values — the two can't silently drift apart.

import { clashCause, renderApplied } from './applied.js';
import { ToolError } from './errors.js';

// Per-axis truncation metadata for one cross-tab dimension. A grid only ever
// shows the top `requestedSize` values of each axis (most frequent first), but
// the raw response gives no hint that more exist — so a 25-row library grid over
// 134 libraries silently drops 109, inviting a false "not in the collection".
// Reuses the counts sgbr_facet_values already computes (distinct_values total
// buckets, others_count docs beyond the returned values). `shaped` is a
// buildFacetResponse().structured; only `.values` is required (the fallback path
// for a bare {values} object yields distinct=null/others=0, i.e. "unknown, assume
// complete"). Exported so the tool and the fallback share one definition.
export function buildAxisMeta(dimension, requestedSize, shaped) {
  const returned = (shaped.values || []).length;
  const distinct = shaped.distinct_values ?? null;
  const others = shaped.others_count ?? 0;
  const meta = {
    dimension,
    requested_size: requestedSize ?? returned,
    returned,
    distinct_values: distinct,
    others_count: others,
    // A filtered axis lists the filter's own values (distinct = returned, others = 0),
    // so it is never truncated.
    truncated: others > 0 || (distinct != null && distinct > returned),
  };
  // Propagated from buildFacetResponse rather than re-derived, so the cross-tab
  // and sgbr_facet_values can't disagree about what counts as a clash. Set only
  // when true — the common axis stays byte-identical.
  if (shaped.same_dimension_filter) meta.same_dimension_filter = true;
  return meta;
}

// Reconstruct the N×M grid from the flat, index-named `statsResult[]` the `stats` op
// returns (cell names are "i:j", built by buildStatsCrosstabVariables). An
// INCOMPLETE grid fails loudly rather than defaulting missing cells to 0: the tool
// promises exact counts, and a silent zero is indistinguishable from a real one.
// Safe with no false positives — a healthy backend returns a named entry for EVERY
// requested cell, including zero-count ones (rdv-stats-crosstab.md *(internal)*), so
// a missing/uncountable cell is always a backend anomaly.
export function buildFacetBreakdownResponse({
  facet, breakdown, query, scope, fullTextOnly, rowValues, colValues, statsResult, applied,
  rowAxis, colAxis,
}) {
  const cellCounts = new Map();
  for (const r of statsResult || []) {
    const n = r?.countResult?.resultCount;
    if (typeof r?.name === 'string' && Number.isFinite(n)) cellCounts.set(r.name, n);
  }
  const expected = rowValues.length * colValues.length;
  const missing = [];
  rowValues.forEach((_, i) => colValues.forEach((_, j) => {
    if (!cellCounts.has(`${i}:${j}`)) missing.push(`${i}:${j}`);
  }));
  if (missing.length) {
    throw new ToolError(
      `The stats endpoint returned an incomplete cross-tab grid: ${missing.length} of ${expected} ` +
      'cell(s) came back missing or uncountable, so exact counts cannot be reported.',
      'This is a backend anomaly (a healthy response names every cell, even zero-count ones) — ' +
      'retry the call; if it persists, use sgbr_facet_values per dimension instead.',
    );
  }

  const rows = rowValues.map((rv, i) => {
    const cells = colValues.map((cv, j) => {
      const cell = { value: cv.value, count: cellCounts.get(`${i}:${j}`) };
      if (cv.gnd_id) cell.gnd_id = cv.gnd_id;
      return cell;
    });
    const row = { value: rv.value, cells };
    if (rv.gnd_id) row.gnd_id = rv.gnd_id;
    // The row's OWN facet-bucket count (from axis discovery) — NOT a sum of its
    // cells, which can legitimately disagree when the column dimension is
    // multi-valued per record (see the text-channel note below).
    //
    // OMITTED when the row dimension is itself filtered: discovery is then
    // un-narrowed on that dimension, so this would count a wider population than
    // the cells while printing in the same units, immediately beside them —
    // ~39k next to ~250, inviting the subtraction that is the whole trap. The
    // cells carry the answer; a wrong total beside them is worse than no total.
    if (rv.count != null && !rowAxis?.same_dimension_filter) row.total = rv.count;
    return row;
  });

  const structured = { facet, breakdown, query, scope, full_text_only: fullTextOnly, rows };
  // Per-axis truncation metadata. The tool passes real rowAxis/colAxis (carrying
  // distinct_values/others_count); a bare shaper call falls back to deriving them
  // from the value arrays (distinct unknown → not flagged truncated).
  structured.row_axis = rowAxis || buildAxisMeta(facet, rowValues.length, { values: rowValues });
  structured.col_axis = colAxis || buildAxisMeta(breakdown, colValues.length, { values: colValues });
  if (applied) structured.applied_filters = applied;
  return { structured, text: renderBreakdownText(structured) };
}

function renderBreakdownText(s) {
  const scopeNote = s.scope && s.scope !== 'all' ? `, scope: ${s.scope}` : '';
  const ftNote = s.full_text_only ? ', full text only' : '';
  const q = s.query ? `"${s.query}"` : '(all records)';
  const cols = s.rows[0]?.cells.length ?? 0;
  const lines = [
    `Cross-tab "${s.facet}" (rows) × "${s.breakdown}" (columns) for query ${q}${scopeNote}${ftNote} — ` +
    `${s.rows.length} row(s) × ${cols} column(s):`,
  ];
  const narrowing = renderApplied(s.applied_filters);
  if (narrowing) lines.push(`Narrowed by: ${narrowing}`);
  const asApplied = { ...s.applied_filters, full_text_only: s.full_text_only };
  const clashing = [
    s.row_axis?.same_dimension_filter ? { label: `rows ("${s.facet}")`, dim: s.facet } : null,
    s.col_axis?.same_dimension_filter ? { label: `columns ("${s.breakdown}")`, dim: s.breakdown } : null,
  ].filter(Boolean);
  if (clashing.length) {
    // A full_text_only axis is discovered (there are no filter values to list), so
    // it needs its own clause; an all-`filters` clash keeps the joint sentence.
    const viaFt = (c) => clashCause(asApplied, c.dim) === 'full_text_only';
    const clause = (c) => (viaFt(c)
      ? `${c.label} are narrowed by \`full_text_only\` and list values discovered as if it were false`
      : `${c.label} also appear in \`filters\` and list your filter's own values`);
    const head = clashing.some(viaFt)
      ? `${clashing.map(clause).join('; ')}. RDV excludes a dimension's own filter from its own ` +
        'aggregation, and the per-row totals of those axes are omitted.'
      : `${clashing.map((c) => c.label).join(' and ')} also appear in \`filters\`, and RDV excludes a ` +
        'dimension\'s own filter from its own aggregation — so that axis lists your filter\'s own values ' +
        'and its per-row totals are omitted.';
    lines.push(
      `${head} The CELLS below are unaffected: each ANDs its own axis clauses on top of the filter, ` +
      'so a cell IS the true intersection.',
    );
  }
  const axisNote = (axis, role) => {
    if (!axis?.truncated) return null;
    const of = axis.distinct_values != null ? ` of ${axis.distinct_values.toLocaleString('en-US')}` : '';
    const rest = axis.others_count
      ? ` (${axis.others_count.toLocaleString('en-US')} record(s) in the un-shown values)` : '';
    return `${role}: showing the top ${axis.returned}${of} "${axis.dimension}" values${rest}`;
  };
  const axisNotes = [axisNote(s.row_axis, 'Rows'), axisNote(s.col_axis, 'Columns')].filter(Boolean);
  if (axisNotes.length) {
    lines.push(`Axes truncated — ${axisNotes.join('; ')}. Raise \`size\`/\`breakdown_size\` for more.`);
  }
  lines.push('');
  for (const row of s.rows) {
    const idNote = row.gnd_id ? `  [${row.gnd_id}]` : '';
    const totalNote = row.total != null
      ? ` (${row.total.toLocaleString('en-US')} total in the "${s.facet}" facet, not a sum of the cells below)`
      : '';
    lines.push(`${row.value}${idNote}${totalNote}:`);
    for (const cell of row.cells) {
      const cellIdNote = cell.gnd_id ? `  [${cell.gnd_id}]` : '';
      lines.push(`  ${cell.count.toLocaleString('en-US').padStart(9)}  ${cell.value}${cellIdNote}`);
    }
  }
  lines.push(
    '',
    `Note: row/column totals (when shown) are each dimension's OWN facet-bucket count, not a sum of ` +
    'the displayed cells — string dimensions can be multi-valued per record, so cells may overlap.',
  );
  return lines.join('\n');
}

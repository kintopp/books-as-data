# Books as Data — research guide

## Overview

The `sgbr_*` tools search *Books as Data*, the joint platform of four Swiss
libraries (UB Bern, UB Basel, ZHB Luzern, ZB Zürich) for digitised books from
1700–1900, hosted by the University Library Basel. The tool
descriptions document the parameters; this guide covers what the collection is
actually like, which assumptions quietly fail, and the research patterns that
work. Counts in this guide are deliberately approximate — the consortium keeps adding
books, so treat every figure as an order of magnitude, and re-derive current
numbers with `sgbr_facet_values` when they matter.

The server appends `⚠` warnings. Query-shape and vocabulary warnings (boolean
words, `field:value`, a stale vocabulary value), an `sgbr_facet_values` facet
clashing with its own filter, and a search page past the last one mean the
numbers answer a different question: fix the call and re-issue it. Every other `⚠` note (image sizing, a short page, locate
coverage, facet integrity, an `sgbr_facet_breakdown` axis you also filter)
qualifies a result that is still valid; follow the remedy the warning itself
states.

| Tool | Reach for it when |
|---|---|
| `sgbr_search` | The workhorse. An empty query + filters/year range is the idiomatic way to browse a slice. |
| `sgbr_facet_values` | Survey *before* searching: what languages/libraries/years/genres does a query touch? |
| `sgbr_facet_breakdown` | Two dimensions at once — reach for it before any manual fan-out. |
| `sgbr_autocomplete` | Turning a half-remembered word into **search phrases**. Not filter values — for those use `sgbr_facet_values` (topic `historic_spelling`, author names). |
| `sgbr_get_record` | The hub between search and text/image: `scan_id`, `viewer_url`, citation. |
| `sgbr_get_fulltext` | Reading long stretches of OCR, or a span of scan pages (`page_from`/`page_to`, each marked `--- page N ---`); to *locate* a passage, use `sgbr_locate_text` (within a volume) or search snippets (across records). |
| `sgbr_get_page_ocr` | Once you know the page: its OCR text plus line/word boxes, whose `region_pct` feeds straight into `sgbr_inspect_image` to crop and verify that exact spot. |
| `sgbr_locate_text` | Don't know the page yet: find which page(s) of one scan volume contain a phrase, with a snippet and `region_pct` per hit. |
| `sgbr_inspect_image` | Plates, maps, and verifying OCR — the pixels when text fails — whole page or a `region_pct` crop. |

**Canonical workflow: survey → search → record → read/look.** Facet a broad
query first (`year`, `language`, `library`) to map the terrain; refine the
search; expand promising ids with `sgbr_get_record`; then read text or inspect
images. For "is X in the collection at all?" questions, a facet call over the query
is cheaper and more informative than paging through search results.

### Checklist

- Survey with facets before paging through search results; never page past the
  deep-pagination cap — narrow instead.
- Only these operators: bare terms (AND), `a|b`, `"phrase"`,
  `"phrase"~N`, `term~1`, trailing `*`, `-term` to exclude. No `AND`/`OR`/`NOT`
  words, no `field:value`, no parentheses, no mid-word wildcards; restrict
  fields with the `scope` argument.
- OR period spellings (or add `~1`) wherever recall matters, and accent variants
  too — only title/author/subject scope folds them, and never for fold-out plates.
- Harvest full-text passages one phrase or single term per call — multi-term
  queries rank fine but snippet almost nothing.
- Read `availability` values and author name forms live from
  `sgbr_facet_values`, never from memory or `sgbr_autocomplete`; a stale or
  guessed value returns a clean zero. `object_type` takes only its four keys.
- Check `coverage_pct` and the availability class before arguing from absence;
  don't run `sgbr_facet_values` on a dimension you are also filtering.
- Place a passage with `sgbr_locate_text`, verify wording and page with
  `sgbr_get_page_ocr` or the page image, then cite `viewer_url` with `?page=N`.
- Fetch whole page images deliberately, never speculatively across a result set;
  a `region_pct` crop is the cheap form.
- Treat `topic`/`subject_area`/`foldout_type`/`genre_ai` as automated enrichments, never
  sum `year` buckets, and re-derive counts live when they matter.

**Read further as the question needs** (pass the name as `topic`):
`collection` before any claim about what the corpus holds or lacks;
`query_syntax` and `historic_spelling` before relying on a count or a miss;
`ocr_text` before quoting or citing a page; `facets` before reading facet counts
or cross-tabs; `evidence` before arguing from a count; `ordering_and_scale` for
earliest/latest questions or deep paging; `patterns` for worked research moves;
`collection_scale` before any "how big" answer; `citing_pages` to place a passage
known only by an offset; `cross_tabs` when `sgbr_facet_breakdown` cannot build a
grid; `foldouts` before working with fold-out plates.

## Collection

- **Scale and period.** Over 750,000 titles, indexed as over a million
  records (see Record granularity), nominally 1700–1900 (with a
  thin spill-over on either edge). Coverage rises through the 18th century and
  is densest in the 19th — expect much more material for 1850 than for 1710.
- **Languages.** Roughly three-fifths German, about a fifth French, with Latin
  the clear third; then English and Italian, and a long tail of a couple
  hundred further language labels (Greek, Dutch, Russian, Hebrew, …).
  German-language material from this period is very often printed in
  **Fraktur**, which shapes OCR quality (topic `ocr_text`).
- **Holdings.** Contributions from well over a hundred Swiss library
  collections. Basel UB is the largest single contributor (over a third),
  followed by the Zürich ZB and Bern UB collections and the Luzern ZHB —
  useful to know when a facet survey looks "Basel-heavy": that is the collection,
  not your query.
- **Record granularity.** A record can be a whole work, one volume of a
  multi-volume work, or a single **fold-out plate** (`object_type: foldout`) —
  maps, technical drawings, botanical/zoological plates, anatomical figures,
  music notation. Foldouts are roughly a sixth of all records, so hit lists
  routinely mix whole books with single plates; filter `object_type` when that
  matters. But **only locally digitised items are typed at all**: about 40% of
  records — every catalogue-only one, and most partner-scanned ones — are indexed
  with an empty `object_type`, which no filter can select (the facet reports them
  as `absent_records`). So `object_type` narrows to a *typed* subset, never to
  the whole collection, and "no works of type X" from it is a statement about
  60% of the corpus.
  **Ids come in three shapes, and the two underscore-suffixed ones are easily
  confused.** A bare `id991…` is the catalogue record; `id991…_UBBS-00173645`
  (suffix = a `scan_id`) is that work's *scanned volume*, the sibling actually
  carrying the full text, page OCR and "N Bilder" `file_count` that the bare
  parent may lack; `UBBS-00173645_00000046` (suffix = a zero-padded **page**) is
  a single fold-out plate. Only the last is what the page-addressed tools resolve
  to a page — resolve the middle one with `sgbr_get_record` like any other record.
- **Not everything is searchable text.** The `availability` facet has four
  classes (German values): `Digitalisat (Volltext)` (searchable OCR text),
  `kein Digitalisat` (catalogue record only), `Digitalisat (extern)` (scanned by
  a partner institution, which keeps the images and any OCR — none of it is
  indexed here or reachable through the tools),
  `Falttafel` (a foldout's single page). **Under half the
  collection carries indexed full text** — a full-text search silently ignores
  the rest. For coverage questions, always ask: "in which availability class
  would my material sit?"
- **These values get renamed between platform releases, and a stale one matches
  nothing rather than erroring.** An `availability` filter can return a
  confident, well-formed zero for a vocabulary reason instead of a corpus reason,
  so never pin a value from memory: read the live list with `sgbr_facet_values`
  first, and if a narrowed search comes back empty, re-read it before reporting
  the corpus has nothing. `object_type` is different: its filter takes four fixed
  keys (topic `facets`), so an empty result there points at the server's key mapping,
  not your value — compare the `object_type` facet's counts before reporting absence.
- **`Digitalisat (extern)` means the text is held elsewhere, not missing.** Such
  a record has no `digital.scan_id` and no scan-suffixed sibling, so no page,
  image or OCR tool can reach it and no full-text search finds it. Its
  `sgbr_get_record` often links the partner's own IIIF manifest (e-rara, BSB,
  ÖNB) — point the user there, or to its `viewer_url`, whose viewer usually
  shows the partner's text — and another library's copy of the same work may
  have the full text here, so search the title before reporting the text absent. The
  partner is in `scan_source` (`BSB (Google Books Partnership)`, `e-rara`, … —
  spell them as the facet does, never as a bare `BSB`). Extern records are
  work-level: ~92% carry no `object_type` at all and the rest are `Mehrbändig`,
  never `Werk` or `Band`. Whatever the availability, what gates every
  scan-addressed tool (`sgbr_get_fulltext`, `sgbr_locate_text`,
  `sgbr_get_page_ocr`, `sgbr_inspect_image`) is `digital.scan_id`: check it on
  `sgbr_get_record` before promising a page or an image. A work that lists several
  scans (the volumes of a multivolume work, or copies held by different
  libraries) shows them all as `digital.scan_ids`; the page tools refuse such a
  work's id and ask for one
  `scan_id`, while `sgbr_locate_text` accepts it but searches only the first scan
  — pass `scan_id` to choose the volume.
- **Records are not pages, and the public figures are a subset.** The tools count
  *records* (over a million: works, volumes, and single plates), never pages; the
  platform's published figures count titles, volumes and pages, and "how many
  volumes" has three answers through the tools. Before answering any question
  about scale, read topic `collection_scale`.
- **Genre skew.** Where a genre is catalogued at all, the largest bucket by a
  wide margin is `Hochschulschrift` (university dissertations) — a strength of
  the collection for the history of scholarship. Catalogued `genre` covers only
  ~11% of records; `genre_ai` (an AI prediction, 18 labels, kept only at high
  confidence) covers ~40% and shows the same skew — but not as independent
  confirmation: the model was trained on the catalogued genres (about three
  quarters `Hochschulschrift`) and reads **only the title**, so a missing label
  means the title gave no clue, not that the book has no genre.
  `resource_type` is effectively a constant, not a dimension: `Buch` covers all
  but ~33 records, because the ~715 `Archivmaterial` are *also* `Buch` and only
  the ~33 `Zeitschrift` sit outside it, so faceting or filtering it tells you
  nothing. Serials in particular are NOT findable this way — the ~33
  `Zeitschrift` records are not the collection's periodicals.

## Query syntax

The free-text `query` accepts **symbolic Lucene operators only**:

| Want | Write | Do NOT write |
|---|---|---|
| both terms | `Stadtplan Karte` (bare terms already AND) | `Stadtplan AND Karte`; `Stadtplan + Karte` (a slightly larger, different set) |
| either term | `Stadtplan\|Karte`, `Karte*\|Carte*` | `Stadtplan OR Karte` |
| exclude a term | `Stadtplan -Karte` (also `-"Basel 1831"`, `-Karte*`); facet values via `exclude` | `NOT Karte` |
| exact phrase | `"Stadtplan Basel"` | — |
| phrase, words between | `"Stadtplan Basel"~6` (finds "Stadtplan von Basel") | `Stadtplan Basel ~6` (unquoted: 0) |
| word stem | `Karte*` (Karte, Karten, Kartenwerk) — trailing `*` only | `Bur*hardt`, `Ni?laus` |
| spelling variants | `Arzney~1` (fuzzy), or OR the spellings | bare `Arzney~` (edit distance 2 — looser still) |
| grouping | not possible — one clause group per call | `(Cholera \| Karte)` |
| one field only | the `scope` argument | `title:Basel` (0 — or a wrong handful) |

- **`AND` / `OR` / `NOT` are searched as literal words.** `Stadtplan AND
  Karte` returns *fewer* hits than `Stadtplan Karte`, because it additionally
  requires the word "AND" on the page.
- **`field:value` isn't field scoping, and it doesn't reliably return zero
  either.** Usually it comes back empty, but sometimes with a small unrelated
  set instead, none of them field-scoped matches. So an empty result is no
  dependable tell that you mistyped, and a non-empty one is no evidence the
  syntax worked — a silent-wrong-answer trap of the autocomplete family (author
  names in topic `historic_spelling`), not an error you will notice. The server's warning is the only
  reliable signal. Field restriction is
  the `scope` argument (`title`, `author`, `subject`, `call_number`,
  `fulltext`, `image_description`, `identifier`), never query syntax.
  `identifier` looks up exact ids only: a bare MMS id finds its work, a scan
  id (`UBBS-00173645`) finds its record and, for a multivolume or multi-copy
  work, the parent too (take the hit whose id ends in `_<scan id>`, or pass the
  scan id straight to `scan_id`), and a partial id finds nothing.
- An **empty query matches everything** — combined with filters or a year
  range, that is the idiomatic way to browse a slice of the collection.
- **Parentheses never group.** Inner ones are stripped (`Cholera (1831|1832)`
  is read as `Cholera 1831|1832`); a query wrapped in them is emptied and would
  return the whole corpus, so the server refuses it. The parser never reports
  an error: beyond this refusal and the boolean-word and `field:value`
  warnings, nothing in this section is caught.
- **`-term` subtracts exactly**: `Karte -Basel` is `Karte` minus `Karte Basel`.
  A query of negations alone (`-Karte`) is the whole corpus minus those
  records — nearly everything, which is correct but rarely what you want.
- **Mid-word wildcards are dead in the catalogue scopes.** `Bur*hardt` and
  `Ni?laus` return 0 in `title`/`author`/`subject` (though `Burckhardt` finds
  hundreds), and in full text return an unrelated set — the term is split at
  the wildcard and both fragments searched as words (`Ni?laus` finds four times
  as many records as `Niklaus`, `Bur*hardt` fewer than `Burckhardt`). Only a
  trailing `*` works; for internal variation use `~1` or OR the spellings.

## Historic spelling

Pre-1900 orthography differs from modern German, and the index does **no**
spelling normalisation. One modern spelling systematically undercounts:
searching a term like *Arznei* (medicine) with its period spellings OR-ed in
(`Arzney|Arznei|Arzeney`) returns **over 60% more** records than the modern
form alone — and that ratio worsens the further back you go.

- **Case is folded everywhere; diacritics only in the catalogue scopes.** Never
  spend a query on case (`messager boiteux` finds *Messager Boiteux*). Accents
  fold in `title`/`author`/`subject` scope for book records (`Zürich` = `Zurich`
  there), but **not in full text** — `Cholera` finds some 26,000 full-text
  records, `choléra` 6,000, largely different ones — and not for fold-out plate
  records in any scope. So in the default scope, and wherever full text or
  foldouts matter, **OR the accent variants** (`Cholera|choléra`). `ü`→`ue` is a
  spelling variant everywhere, so OR that too.
- Typical shifts: *th*→*t* (Thal/Tal), *ey*→*ei* (Arzney/Arznei), *C*→*K*
  (Carte/Karte), *ck*→*k*, Latinised names (Jacobus/Jakob).
- For any term where recall matters, OR the era spellings (`Thal|Tal`) or add
  a fuzzy `~1`; a mid-word wildcard (`Bur*hardt`) finds nothing in the
  catalogue scopes.
- The same goes for **French and Latin** material (two-fifths of the
  collection is not German): try the Latin title of a work when the vernacular
  one comes up empty.
- **A title-scoped hit may not show your phrase in its displayed title.**
  `search.title` also indexes variant and uniform titles, so
  `"Alemannische Gedichte"` (scope `title`) returns an item shown as
  *Allemannische Gedichte*. Don't discard such a hit as spurious — but the
  variant-title net is patchy, so still OR spelling variants rather than
  relying on it. `sgbr_autocomplete` (scope `title`) is likewise a source of
  search phrases, not of citable titles: it also suggests remainder-of-title
  fields, so a lowercase-initial suggestion is usually the *subtitle* of the
  entry above it, identifying nothing on its own. Confirm a title with
  `sgbr_search` before quoting it.
- **Author names vary inside the index itself.** The same person can appear
  as e.g. `Burckhard, Jacob`, `Burckhardt, Jakob`, and `Burckhard, Jacobus`.
  To pin the exact index form(s), use the `author` facet (`sgbr_facet_values`,
  facet `author`, `scope: "author"`, the surname as query), **never**
  `sgbr_autocomplete` — it draws on searchable name text, not the authority
  vocabulary `filters.author` reads, so most of its suggestions are not filter
  values at all, and it routinely omits the very author you are looking for.
  A suggestion used as a filter gives one of three things, none of them the
  person you meant: no records — which reads as absence from the corpus and is
  not — a namesake (`Burckhardt, Jacob` is not `Burckhardt, Jacob (1818-1897)`),
  or a printing house (`David Gessner`, `Meriansche Erben`). Take dated,
  GND-bearing forms from the facet, then OR several `filters.author` values when
  spellings vary. (Read the `author` facet with care: it lists *every*
  contributor of matching records, not just people named X, and its counts are
  scoped to your query — take the form from the facet, the count from
  `sgbr_search`; see topic `facets`.)

## OCR text

- The full text is **uncorrected OCR of mostly Fraktur print**. Expect
  systematic confusions (long-s read as f, u/n swaps, broken hyphenation).
  Don't present an OCR passage as a faithful transcription of a source that
  matters; for individual critical passages, or when the user asks, verify the
  wording against the page image ("Verify before you quote" in topic `patterns`).
- **Whole page images are context-expensive — fetch them deliberately.** Reach for
  `sgbr_inspect_image` for inherently visual material (maps, plates, illustrations,
  music notation) or a decisive passage — a full page is large and accumulates in the
  session's context, so never fetch a series speculatively across a result set.
  When several pages must be checked and the target sits in a predictable spot
  (a page number in a corner, a running head, a caption under a plate,
  marginalia), request `region_pct` crops instead of full pages: a crop is
  delivered at its own scanned resolution, so a corner crop costs a fraction of a
  full page with no need to lower `max_long_edge`. For the same reason, when a
  crop is too small to read the answer is a *wider* `region_pct`, never a bigger
  `max_long_edge` — only a larger region carries more pixels. If you can't predict
  where on the page the evidence is, fetch the whole page — a crop that misses it
  is a false negative.
- **Character offsets do not map to page numbers — so don't reach for arithmetic
  first.** The whole-book stream carries no page boundaries, so a
  `sgbr_get_fulltext` offset cannot be converted into a scanned-page citation
  directly; read by `page_from`/`page_to` when the pages matter. Cite the item
  via its `viewer_url`; append `?page=N` only when you actually know the page.
  **Every `page` in these tools — and `?page=N` — is a *scan* page (image 1 = the
  first scanned leaf), never the number printed on that leaf.** Front matter,
  plates and bound-together parts push the two far apart (scan page 30 can carry
  printed page 464), so never convert either into the other. If a
  citation needs the printed number, read it off the page — `sgbr_get_page_ocr`
  usually catches it as a short line in a top or bottom corner — and give both.
  **To place a decisive passage on a page, hand a distinctive phrase from it to
  `sgbr_locate_text`**: it asks the platform's content search (the whole volume
  at once; whole words, exact accents) and, if that finds nothing, scans the
  pages' OCR for the phrase as a substring (Fraktur long-ſ, hyphen-at-linebreak,
  case and diacritics all folded); `engine` says which answered. It returns the
  matching page(s) with a context snippet and a `region_pct` per hit — no image
  fetches to *find* the page — and enumerates sibling volumes when the work is
  multi-volume (it searches one volume per call; `unsearched_scans` names any
  other listed scan, volume or library copy, left unsearched). Content search misses a phrase
  inside a compound, in another accent form, or split at a line break: when its
  hits look incomplete, re-run with `engine: "page_scan"`.
  Then confirm the wording with `sgbr_get_page_ocr` (that page's own OCR text +
  line/word boxes, cheapest) or `sgbr_inspect_image` on the returned `region_pct`;
  only a page confirmed this way — its own OCR or its image — earns `?page=N`. Because the OCR is uncorrected, a
  null `sgbr_locate_text` result does not prove the phrase is absent.
  - **`regions` is best-effort — an empty one does not invalidate the hit.** The
    page match runs on the page's plain OCR text, the boxes on its hOCR, so a page
    can match while no region anchors it (missing/odd hOCR). Take the page and
    snippet as the finding; recover the anchor with `sgbr_get_page_ocr` on that
    page, or re-run `sgbr_locate_text` with a shorter, more distinctive fragment.
  - **No searchable phrase (only an offset), or `sgbr_locate_text` missed?**
    Estimate the page from the offset and read a span around it — the recipe is
    topic `citing_pages`.
- **The highlighter matches your whole query string as one contiguous phrase**,
  so only a single term or one quoted phrase snippets reliably. A multi-clause
  query — two bare terms, `a|b`, `"a b"~N` — still ranks and returns the
  right records, but snippets only the rare hit whose OCR runs the terms
  together. Harvest passages one phrase (`"Erdbeben von Visp"`, no `~N`) or one
  term per call; never read missing snippets as "no matches".
- **Scoping to the OCR is not the same as filtering to it.** `scope: "fulltext"`
  restricts *which fields* are searched; `full_text_only: true` restricts *which
  records qualify* (the ~460k of ~1.07M that carry machine-readable full text).
  Scope alone still lets fold-out plates compete, and their dense map and caption
  lettering out-ranks running prose on a single term — often filling the first
  page of hits. Send both for prose evidence; drop the filter when the plates ARE
  the target.
- OCR reads no pictures: maps, plates, tables and music notation are invisible
  to full-text search. That material is reachable via `object_type: foldout`,
  the `foldout_type` categories, and each plate's **AI image description** — one
  German sentence, shown on the hit as `image_description`, searched by the
  default scope and alone by `scope: "image_description"` (topic `patterns`).

## Facets

- **Four dimensions are machine-generated, not catalogued**: `subject_area`
  and `topic` are derived from call numbers by rules; `foldout_type` is an AI
  classification of the plates and `genre_ai` an AI genre prediction.
  `topic` values are coarse German subject labels
  (Theologie, Geschichte Europas, Recht, …) — about eighty buckets, **not**
  Dewey classes. Present all four as automated enrichments, never as
  librarian-assigned subject headings. The **catalogued** counterpart is
  `subject_heading` — real cataloguer-assigned headings on a few per cent of
  records: precise where it exists, near-useless for recall. Pin concepts with
  it, but in **both languages** — `Geschichte` and `History` share almost no
  records, and only the German forms carry a GND id (English ones read
  `(noid)`), so OR the two as you OR period spellings.
- **Check `coverage_pct` before drawing conclusions.** Collection-wide, `topic`
  covers about half the records, `subject_area` about two-thirds, `genre_ai` ~40%
  and `foldout_type` ~16% (it labels only plates, nearly all of them). A zero there
  means "not enriched", not "not in the collection" — and per-query coverage runs
  far lower (`genre` covers ~5% of a title search for *Cholera*), so read it each
  time rather than the collection-wide average.
- **The `author` facet lists every contributor of the matching records**, not
  "authors whose name matches your query". A *Burckhardt* search returns genuine
  Burckhardts alongside their editors, printers and dedicatees (Kaegi, Voltaire,
  a Thurneysen printer, …), so when disambiguating keep only the rows containing
  the surname; the rest are collaborators, not name candidates.
- **Year buckets overlap.** A record whose publication spans years (serials,
  multi-volume works) is counted in *every* year it covers, so summing year
  buckets massively overstates the collection. Read the `year` facet as a density
  profile, never as a partition.
- **A `year_from`/`year_to` range trims the `year` facet to that window.** Each
  bucket is that year's exact count, but the buckets still overlap — never sum
  them into a period total; take that from `sgbr_search` with the same range.
- Filter values must match facet values **exactly**, and are usually German
  (`Theologie`, `Bern, UB Münstergasse`, `kein Digitalisat`) — discover them with
  `sgbr_facet_values` first. Two exceptions: `object_type` takes friendly keys
  (`work`/`foldout`/`volume`/`multivolume`), never the `Einzelseite` you'd read;
  and `parent_record` takes the facet's bare digits (`991…`), never the parent's
  own `id991…` record id, which returns a clean zero with no warning.
- **`content_flags` is not a controlled vocabulary.** ~9,400 values: some fifteen
  real pipeline flags (`IMAGE_ON_PAGE`, `CHAPTER_START`, `INDEX`, …) among thousands
  of German volume-designation templates (`Beschreibung: Bd. #`) that outrank
  most of them. `IMAGE_METHOD1` is `object_type: foldout` restated.
- **Stack several dimensions in one call — they AND.** Values *within* one
  dimension OR, *different* dimensions AND, and every range ANDs on top, so
  `filters: { object_type: ["foldout"], foldout_type: ["Karten"],
  language: ["Französisch"] }` with `year_from: 1850` is one precisely-cut slice,
  not four searches to intersect by hand. The same stack narrows
  `sgbr_facet_values` / `sgbr_facet_breakdown`, which is how you count within it.
  An AND *inside* one dimension is not expressible — it reads as OR.
  `exclude` (same keys) drops records carrying any listed value and, unlike a
  filter, keeps those with none: `exclude: { object_type: ["foldout"] }` is
  every record but the plates, untyped ones included.
- **Page-count and OCR-quality ranges** (`pages_min`/`pages_max`,
  `ocr_quality_min`, 0–100, most scans 90–95) drop every record lacking the
  measure. Only a record with its own scan carries an OCR score, so
  `ocr_quality_min` also drops multivolume parent works and metadata-only
  records: use it to pick text-mining-grade scans, never to count titles.
- **Two values of ONE dimension: intersect with three searches, never by faceting
  one while filtering the other.** A dimension's own filter is excluded from its
  own aggregation, so those buckets ignore it (your query still scopes them) —
  faceting `content_flags` under `content_flags: ["INDEX"]` reports
  `CHAPTER_START` ~39,000 where the truth is ~250. Use |A| + |B| − |A ∪ B| over
  `sgbr_search`. A filtered `sgbr_facet_breakdown` axis is safe: it lists your
  filter's own values, omits its row totals, and every cell stays exact.
- **Cross-tab two dimensions with `sgbr_facet_breakdown`.** It auto-discovers the
  top values of both axes and prices the whole grid **exactly** with batched
  `stats` calls — e.g. `facet: "language", breakdown: "genre"`. It rejects `year` and
  `object_type` as axes; for those, or more values than it caps, fan out
  `sgbr_facet_values` calls as topic `cross_tabs` describes.

## Evidence

Corpus counts describe *this collection's records*, not the world; keep each
claim no broader than the data supports:

- **Holding library ≠ place of publication ≠ subject location.** The `library`
  facet reports who *holds* the scan (mostly Basel/Zürich/Bern — a property of
  the collection, not the query); `place` is where the item was *printed*;
  neither identifies what the work is *about*.
- **A matched-record count is not a measured phenomenon.** "N records mention
  cholera" measures term coverage in OCR and metadata — not cases, opinion, or
  significance. State what was counted: records in this corpus matching this
  query.
- **Absence in a count is not absence in the world.** Low `coverage_pct`, OCR
  misreads, period spelling, and the availability class (topic `collection`) all
  suppress hits — a thin full-text count often means the OCR misread the word,
  not that the topic is missing. Argue from absence only after checking coverage
  and triangulating: metadata scope (`title`/`subject`), spelling variants, fuzzy.

## Ordering and scale

- **`sgbr_search` sorts by relevance by default, and `sort` changes that**:
  `year_asc` / `year_desc` by publication date, `title_asc` / `title_desc`
  alphabetically. Use a catalogue sort to *enumerate* — earliest/latest items,
  or paging a defined set in a stable order. Keep relevance when the query is a
  research question: a catalogue sort ignores match quality, so the top hit is
  merely the oldest record that matched, not the best one, and snippets stop
  meaning anything. There is no sort by author.
- For "earliest/latest" questions, `sort: "year_asc"` answers directly, but
  **corroborate it** — a single mis-catalogued or range-dated record sorts to the
  top and looks like a discovery. Cross-check against the `year` facet's
  distribution (where an implausible early year shows up as an isolated bucket),
  then open the record and confirm the date is real before citing it.
- Deep pagination is capped (on the order of ten thousand results). Don't page
  through a broad query; narrow with filters or a year window instead. Sorting
  does not raise the cap — it only changes which records the first pages hold.

## Patterns

- **"What does the collection hold about X?"** → `sgbr_facet_values` on the query
  for `year`, `language`, `library`, `topic` first; report the shape, then
  drill into the densest slice.
- **Earliest works on a topic** → `sgbr_search` with `sort: "year_asc"` for the
  candidates, plus the `year` facet for the distribution behind them. Treat the
  first hits as leads and corroborate each date as topic `ordering_and_scale`
  describes.
- **Survey and re-rank text hits** → use `sgbr_search` snippets for breadth, not
  `sgbr_get_fulltext` across a whole result set. Start with a single term or
  quoted phrase when snippets matter; facet/narrow the slice; then fetch full
  text only for the few records whose snippets, title, year, and metadata make
  them plausible evidence.
- **Named sub-collections are just saved queries.** E.g. the Fellenberg
  library (Bern) is `query: "Mue Fg"`, `scope: "call_number"`,
  `filters: { library: ["Bern, UB Münstergasse"] }` — any shelf-mark-defined
  collection can be reconstructed the same way with a call-number scope plus a
  library filter.
- **Visual material as a research object** → filter `object_type: ["foldout"]`,
  optionally a `foldout_type` category (~50 **German** terms — read the live
  list, never translate), search the plates' German AI descriptions too
  (`scope: "image_description"`), then `sgbr_inspect_image` with a `region_pct`.
  A foldout's `scan_id` is its **parent volume's**, so pass the foldout **id** to
  the page tools instead. Read topic `foldouts` before working with
  plates: how to recognise one, reading its lettering, and why the whole-scan
  tools refuse it.
- **Verify before you quote**: a decisive OCR passage → `sgbr_locate_text` with a
  distinctive phrase from it to pin the page → `sgbr_get_page_ocr` or
  `sgbr_inspect_image` on that page — the image with a `region_pct` crop (reuse the
  region from the locate/page-OCR hit, or a corner `[0, 85, 30, 15]` for a page
  number, a band for a running head) — quote from the image, cite the `viewer_url`
  with the confirmed `?page=N`. When you have only an offset (no searchable
  phrase), follow topic `citing_pages`.
- **A corpus to download** → hand the user filter settings plus each volume's
  `digital.ocr_zip_url` (its whole OCR) or `scans_zip_url` (its page images)
  from `sgbr_get_record` — anonymous downloads that answer a GET only (a HEAD
  request 404s). Don't read a corpus through `sgbr_get_fulltext`.
- **Dissertation history**: `filters: { genre: ["Hochschulschrift"] }` plus a
  topic query is a strong axis for the history of universities and
  scholarship.
- Give the user the `viewer_url` whenever a finding rests on a specific item —
  it is the stable, human-shareable anchor for the record. For a formal
  citation of a Google-scanned volume add its ARK (`digital.ark` — an identifier
  to quote; its resolver link does not reliably reach the object) and
  `digital.processed_on`: Google re-processes images and OCR and the platform
  keeps only the latest run, so quoted text, its OCR errors and even scan-page
  numbers can change after you cite them. Byte-stable text is only in the
  platform's dated data dumps.

## Collection scale

Read this before answering any question about how big the collection is, or
quoting one of the platform's own figures.

- **The tools count *records*** (over a million: works, volumes, and single
  plates) — never pages, and there is no way to total the collection's pages
  through them (only per-record image/OCR counts on `sgbr_get_record`).
- **The platform's own figures count differently:** over 750,000 *titles*
  (works, whether digitised or not), about 280,000 of them full-text
  searchable, ~450,000 full-text *volumes*, and ~180,000 works scanned elsewhere
  and linked via IIIF; "140 million pages" is the platform's figure for the
  collection, with no breakdown given. Quote those as *theirs* and say which
  unit you mean.
- **"How many volumes" has three answers through the tools:** records (over a
  million), full-text volumes (the `Digitalisat (Volltext)` count, ~460,000 and
  rising), or the `object_type` facet's `Band` bucket (~140,000; filter key
  `volume`). Prefer the first two —
  `Band` counts only *child* volumes of multi-volume sets, and only among the 60%
  of records that are typed at all (record granularity in topic `collection`), so it is
  a floor, never a total. When a user asks about scale, say which you mean.

All of these grow as the consortium adds books: re-derive a figure with
`sgbr_facet_values` before relying on it.

## Citing pages

Read this when you must cite the page of a passage but have only a
`sgbr_get_fulltext` offset (no searchable phrase), or `sgbr_locate_text` missed.
Do it for a citation that really matters, never to page-number a whole book.

1. Take `total_chars` from a **whole-book** `sgbr_get_fulltext` call (no `page_from`;
   on a page-span call it measures only that span, markers included) and the "N Bilder" page count
   from `sgbr_get_record`'s `file_count`.
2. Estimate the scan page for offset *O* as `floor(O / total_chars × N_Bilder) + 1`,
   clamped to 1…N. It is rough: front matter, plates and uneven OCR density skew
   it.
3. **Read a span around the estimate with `sgbr_get_fulltext`
   `page_from`/`page_to`, not with page images** — one call returns every page's
   text under its own marker, while each whole-page `sgbr_inspect_image` is a
   large payload that stays in context. Make the span generous: on a 104-page
   volume the estimate landed on page 8 for a passage actually on page 15.
4. Spend one `sgbr_inspect_image` on the confirmed page if the citation needs
   eyes, and cite `viewer_url` with that `?page=N`.

The page is a *scan* page throughout, never the number printed on the leaf (topic
`ocr_text`).

## Cross-tabs

Read this when `sgbr_facet_breakdown` cannot build the grid: an axis is `year`
or `object_type`, or you need more values than its caps allow.

- **One `sgbr_facet_values` call per slice**: facet dimension A while filtering
  one value of dimension B. It takes the same `filters` and ranges as
  `sgbr_search`, so a language-by-period breakdown is one call per period, not an
  N×M grid, and each returns the top `size` values of A (default 20; raise it,
  up to 200, until `others_count` is 0 for the complete list).
- **Slice by the low-cardinality dimension** (top ~5–8). Never cross-tab two
  open-ended ones (`author` × anything), and never slice *by* year and sum
  (buckets overlap).
- **Keep every call identical but the slice**: query, scope, `full_text_only`,
  `filters` and year range — or nothing reconciles.
- **Never facet a dimension you are also filtering** — its own filter is
  excluded from its own aggregation (topic `facets`).

## Foldouts

Read this before working with fold-out plates (`object_type: foldout`).

- **Finding plates.** Filter `object_type: ["foldout"]`, optionally a content
  category, then `sgbr_inspect_image` to read what OCR never could —
  `region_pct` zooms into a single figure, label or caption at full detail.
  `foldout_type` is ~50 **German** terms adapted from the Library of Congress
  Thesaurus for Graphic Materials (`Karten`, `Tabellen`, `Technische
  Illustrationen`, `Entwurfszeichnungen`, …), usually one per plate — a few
  carry two, so bucket counts can sum past the plate total; read the live list
  rather than translating an English term, which matches nothing. Its largest
  buckets are broad, and ~20,000 plates sit in `Sonstige` (other), so also search
  the descriptions in German (`scope: "image_description"`, `Wappen`, `Pferd`):
  for `Karte`, foldouts return ~2,600 by OCR, ~22,000 with them.
- **Recognising one.** A foldout carries `availability: Falttafel` on both the
  search hit and `sgbr_get_record` (as does its record note, "nur eine einzelne
  Falttafel aus dem oben verlinkten Buch"), and its *title* is the parent work's,
  saying nothing about the plate. It reports `full_text_available: false` — read
  that as "no book-style running text", NOT "no OCR".
- **Addressing it.** The `scan_id` a foldout shows is its **parent volume's**,
  not a scan of the plate, so never pair that `scan_id` with a page of your own
  guessing. Pass the foldout **id** instead: the two **page-addressed** tools
  resolve it straight to the parent scan *and* the plate's page, which is the
  pairing that lands on it (the id carries that page — see record granularity in
  topic `collection` — so `scan_id` + `page` works too).
- **Reading its lettering.** `sgbr_get_page_ocr` — with no `page` argument, it
  supplies its own — reads the lettering printed *on* the plate: map
  place-names, table headings and figures, scale bars, the title block of a
  technical drawing. It is also what retrieves the text behind a foldout's search
  snippet (caption/label OCR is indexed and highlights — a finding aid).
- **The whole-scan tools refuse it.** Neither the volume's full text nor a page
  *range* is what a single plate stands for: `sgbr_get_fulltext` and
  `sgbr_locate_text` both error, each naming the parent scan so you can widen to
  the whole volume deliberately if that is what you meant.

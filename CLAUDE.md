# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A stdio (and Streamable HTTP) **MCP server** that lets an LLM search *"Books as Data"* — the joint
platform of four Swiss libraries (UB Bern, UB Basel, ZHB Luzern, ZB Zürich),
coordinated by UB Basel: 750k+ titles, 1700–1900, mostly German, indexed as ~1.07M records (works, digitised volumes, single plates) — through its
GraphQL API. Ten read-only tools: `sgbr_search`,
`sgbr_get_record`, `sgbr_facet_values`, `sgbr_facet_breakdown`,
`sgbr_get_fulltext`, `sgbr_autocomplete`, `sgbr_inspect_image`,
`sgbr_get_page_ocr`, `sgbr_locate_text`, and `sgbr_guide`, which serves the
research guidance (`src/guide.md`) one topic per call.

Pure Node ESM, **no build step**, no native deps. Requires **Node ≥24.22.1 <25**
(the same major as Claude Desktop's bundled runtime, node@24; relies
on built-in `fetch`, `AbortController`, `node:test`). Runtime deps are only
`@modelcontextprotocol/server` and `zod`.

`manifest.json`'s `compatibility.runtimes` stays at `>=24.0.0 <25` on purpose:
Claude Desktop's built-in runtime is 24.22.0, below `engines`' CVE floor, so raising
it would stop the `.mcpb` installing on Desktop's own runtime. Revisit once Desktop
ships ≥24.22.1.

`engines` is enforced only by `npm install`, not by a direct `node` launch — so a
Desktop config must use the **absolute** node@24 path (e.g.
`/opt/homebrew/opt/node@24/bin/node`), never a PATH-resolved `node`, which can be
an untested major that fails to start with no clear error.

## Commands

```bash
npm start            # serve over stdio (waits for an MCP client — no HTTP URL)
npm run serve        # serve over Streamable HTTP at /mcp (src/http.js)
npm test             # node --test — OFFLINE smoke + unit tests only
npm run test:cli     # just test/cli.test.js (the CLI's offline assertions)
npm run lint         # eslint (flat config, ESLint 10)
npm run inspector    # launch the MCP Inspector against the server
npm run cli -- …     # headless CLI (scripts/cli.mjs); e.g. `npm run cli -- search "Basel" --max 5`
npm run build:mcpb   # build the fat Claude Desktop bundle → dist/books-as-data.mcpb
npm run build:skill  # sync SKILL.md's version, repack skill/<name>/ → the committed .skill zip + .skill.zip copy
                     #   + plugin/books-as-data/ (skill copy, both manifest versions)
npm run build:docs   # regenerate docs/tools.md's wire-text blocks from the server
npm run footprint    # token footprint of catalogue, instructions, skill, guide topics (exact with ANTHROPIC_API_KEY;
                     #   --estimate = chars/4, as test/footprint.test.js budgets it); calls no tool

npm run test:live    # ALSO run the live API tests (hit the production backend)
SGBR_LIVE=1 npm test # …the same thing, spelled out
npm run test:pack    # pack → install → launch both bins (NEEDS the npm registry)

node --test test/auth.test.js                       # a single file
node --test --test-name-pattern="windows a book"    # a single test by name
```

`scripts/cli.mjs` (bin **`bbad`**) is a headless MCP *client* — it spawns the
server over the zero-config stdio path and drives the same `callTool()` an LLM
would, so there is no second query implementation. Ten verbs (`search`, `get`,
`facets`, `crosstab`, `fulltext`, `comp`, `inspect`, `pageocr`, `locate`, `guide`); stdout is pure JSONL,
counts/warnings/`note:` lines go to stderr; `--fields`/`--json`/`--table`/`--stdin`/
`--show-call`; `tools --compact` prints an agent-bootstrap manifest. Per-command
`--help` is read live from each tool's own description + schema (never stale), so the
drift surface is only what a schema can't express — the hand-authored `VERBS` table,
the per-verb examples, and the stderr summary. Three invariants there: a verb's `cap`
(the `--max`/`-n` target) is the cap on what comes back, never a cost cap on work done
(locate → `max_hits`, not `max_pages`); any caveat a tool states only in its text
channel must be restated by `resultNotes()`, or the JSONL path pipes a truncated
result on as a complete one; and the examples' ids must equal `test/helpers.js`' live
fixtures, since a superseded id resolves to an *empty result, not an error*. Its
offline-safe assertions run in the default suite (`test/cli.test.js`, plus
`test/cli_render.test.js` for the projection/table rendering); real tool
calls are `SGBR_LIVE`-gated. The bin is named for the platform, not for RDV's internal
view name `sgbr` — which stays free for a possible MCP-less CLI that calls the RDV API
directly.

CI (`.github/workflows/ci.yml`) runs `lint` + offline `test` + `build:mcpb` on
Node 24, plus a **separate `pack` job** (`npm run test:pack`,
`scripts/pack-smoke.mjs`): `npm pack` → install the tarball into a temp dir with
`--omit=dev` → run both shipped bins for real (`bbad --help`, a genuine MCP
handshake via `bbad tools --json`, and a raw JSON-RPC `initialize` against
`ub-sgbr-mcp`), then read the built `.mcpb` to confirm its payload has `src/` and
neither `scripts/` nor `src/http.js`. It is a separate job because it must reach the npm registry, which
the offline `npm test` contract forbids — `test/packaging.test.js` keeps guarding
the same drift statically and fails earlier and cheaper. The
live tests (`SGBR_LIVE=1`) are **deliberately excluded** from CI (settled): the
APIs are public, but the library has not yet decided whether and how to promote
MCP access to its endpoints, so no automated MCP traffic runs against them until
it has — no secrets, no scheduled or manual live workflow. The accepted cost:
**backend-contract drift has no continuous detection.**

**So run `npm run test:live` yourself before every release and after any
backend-host change** — the offline suite stubs the backend and can never catch
the real one moving. The same run revalidates the fixture ids in `test/helpers.js`.

**Record the run structurally, not just in a commit body:** the annotated release
tag message and the release notes must both carry a
`Live: <pass>/<total> @ <YYYY-MM-DD>, <host>` line — without it, "not run" is
indistinguishable from "run successfully".

## Hosted deployment (Railway)

`src/http.js` runs on Railway (service `books-as-data`, config in `.railway/railway.ts`;
setup and variables in `docs/deploy.md`, the public doc to keep in step with
`src/http-config.js`). **A push to `main` that touches `src/`, `package.json` or
`package-lock.json` redeploys production at once, without waiting for CI**
(`checkSuites: false`), so pushing such a commit is a deploy, released or not. After a
deploy, check that `GET /health` reports the expected `version` and `commit`.
`railway config plan` is read-only; the user runs `railway config apply --yes`
themselves, since auto mode blocks it. Variables are unmanaged, so an apply never drops
them.

## Packaging (MCPB desktop bundle)

`manifest.json` (MCPB v0.3; the ten tools + five user_config entries — the
sensitive `access_token` and four endpoint overrides, each mapped to its `SGBR_*`
env var) is the source of truth for the Claude Desktop bundle.
`npm run build:mcpb` (`scripts/build-mcpb.mjs`) stages `src/` + a
**production-only** `npm ci --omit=dev --omit=optional` into a temp dir and packs it
→ `dist/books-as-data.mcpb`
(fat, ~2.4 MB, no devDeps; the repo's own `node_modules` is never touched). The
`mcpb` CLI is a devDependency (`@anthropic-ai/mcpb`, local `node_modules/.bin`
preferred — no global install needed); CI runs the bundle build.
`package.json` pins `"overrides": { "tmp": "^0.2.7" }` to force a patched `tmp` into
the dev-only `@anthropic-ai/mcpb → @inquirer/* → external-editor` chain (which
declares `tmp@^0.0.33`, below the `<=0.2.5` advisory ceiling); `mcpb pack` builds
fine against it. Drop the override once `@anthropic-ai/mcpb` upgrades its
`@inquirer/*` deps past the vulnerable `tmp`.
A second override points `@anthropic-ai/mcpb`'s `zod` at our own (`"$zod"`): it
declares `^3.25.67`, and no zod 3 release has the fix for GHSA-mrhx-c7xc-m3w5. That
crosses a major `mcpb` doesn't declare support for, so after bumping `mcpb` or `zod`
re-run `build:mcpb` and `mcpb validate` a stamped manifest (the repo's own has no
`version`, so it always fails). Drop it once `mcpb` declares zod 4.
**`@modelcontextprotocol/client` is an `optionalDependency`, not a devDependency**
— it is imported only by `scripts/cli.mjs`, which `package.json#files`/`bin` ship
as `bbad`. As a devDependency the bin worked in the checkout and failed with
`ERR_MODULE_NOT_FOUND` in every real install (npm never installs a dependency's
devDependencies); optional means a consumer install resolves it, while the bundle's
`--omit=optional` keeps it (and its `jose`/`eventsource`/`pkce-challenge`/
`cross-spawn` subtree, ~7 MB) out of the Desktop payload — safe precisely because
`PAYLOAD_DIRS` excludes `scripts/`. **`@modelcontextprotocol/node` is optional for
the same reason**: only `src/http.js` imports it, and `build-mcpb.mjs`'s
`PAYLOAD_EXCLUDE` keeps that file out of the bundle. **So no file the bundle ships
may import an optional dep, and the bundle payload must never grow to include
`scripts/` or `src/http.js`** (all enforced, with the shipped-entrypoint import
walk, by `test/packaging.test.js`).
**The version is written once, in `package.json`; bump it with
`npm version <x.y.z> --no-git-tag-version`** (which also rewrites the two
`package-lock.json` copies — a hand edit strands them, and `test/version.test.js`
catches that). `config.js` imports `SERVER_VERSION` from it; `build:mcpb` stamps it
into the staged `manifest.json` (the repo's copy has no `version`) and `build:skill`
into SKILL.md's `metadata.version`, source and zip alike, and into both plugin manifests — so a bump means re-running
`npm run build:skill` and committing the result. `CITATION.cff` (`version`,
`date-released`) and the README's APA/BibTeX citation are edited by hand on a bump;
`test/version.test.js` checks their version, not the date. `metadata.last_updated` moves on
every content edit, release or not, but not on the version stamp alone. Only spec
fields go at the top level of the frontmatter.

`skill/<name>.skill` (with an identical `.skill.zip` copy) is a **committed** zip of
the `skill/<name>/` folder — the installable form, not a `dist/` output — so
**editing SKILL.md means running
`npm run build:skill` and committing the result** (enforced by
`test/skill.test.js`, which rebuilds and compares bytes). `scripts/build-skill.mjs`
writes the archive by hand rather than shelling out to `zip` so the output is
deterministic **on any machine**: every entry's timestamp comes from SKILL.md's own
`metadata.last_updated` frontmatter, never the clock or an mtime, entries are in byte order with SKILL.md first and
dotfiles skipped, and each is
**stored, not deflated** — DEFLATE output differs between a shared system zlib and
Node's bundled one, so compressing it made the byte comparison fail in CI while
passing locally. So an unchanged rebuild is byte-identical and never dirties the
tree. Nothing else regenerates it.

`plugin/books-as-data/` is the source of the two plugin zips users upload by hand,
built into `plugin/` and committed, so collaborators can download them from the remote
(claude.ai/Desktop: Customize → Plugins → Upload plugin; ChatGPT: personal plugin
upload). It is not listed in any marketplace. It holds Claude files
(`.claude-plugin/plugin.json`, `.mcp.json`) and Agent Plugins files (`plugin.json`,
`mcp.json`) side by side, both pointing at the hosted `/mcp` URL under the connector
key `Books-as-Data`. Each zip must carry only its own platform's files, at the archive
root: Claude refuses an archive with more than one `plugin.json`. `build:skill` writes
the `skills/` copy and both manifest versions; never edit those by hand. ChatGPT cuts
`shortDescription` off after 57 characters. Installed copies update only when
`version` changes, and the URL is baked in, so a host change needs a release.

## Backend facts that drive the whole design

RDV is Elasticsearch-behind-GraphQL (view `sgbr`),
reverse-engineered by live-probing. **The probe write-ups are the source of truth
for backend behaviour — read the named file before touching code that depends on
it.** Every one of them is currently marked *(internal)* and lives in `research/`,
which is gitignored wholesale (local-only maintainer notes — same convention as
`plans/` — present in the maintainer's working tree, not the repo); `docs/` holds
reader-facing documentation, not probe notes. Should an unmarked write-up ever
land in `docs/`, cite it by path there.
The non-obvious traps the code exists to absorb (mechanism/evidence in the named
write-up, implementation in `src/config.js` + `src/search/compiler.js`):

- **Query string is *symbolic* Lucene only** (bare terms AND, `a|b` OR, `-term`
  exclusion, `"phrase"`, `"a b"~N`, `term~`, trailing `*`). The words
  `AND/OR/NOT` are literal terms; `field:value` silently mis-searches (*usually*
  0, sometimes a small unrelated set); a query *wrapped* in parentheses empties
  to the whole corpus (`inputs.query` echoes `""`; inner parentheses are merely
  stripped); and mid-word `?`/`*` return 0 in the catalogue scopes. None of it
  errors — `parsedError` is always null. Spacing around `|`, edge whitespace and
  `-` (leading or not) behave as written: `-term` subtracts exactly, so a
  negation-only query is the corpus minus those records. The server trims edge
  whitespace (the one rewrite, for cache-key reuse) and refuses wrapped
  parentheses and whitespace-only queries (`detectQueryError` via `assertQuery`
  → `isError`). The inner-parenthesis and mid-word traps are **deliberately
  guidance-only** (`src/guide.md`, tool description): heuristic detection misfired on
  ordinary punctuation, and a wrong warning outranks the result the model just
  saw. Only word `AND/OR/NOT` and `field:value` are warned
  (`detectQueryWarnings`). `test/query_contract.test.js` (live) pins every trap;
  `test/query_refusal.test.js` derives the refusal's coverage from the tool list.
  → `rdv-search-syntax.md`,
  `rdv-query-parser-2026-09-05.md` *(internal)*
- **The highlighter matches the whole query string as one contiguous phrase**, so
  only a single-clause query (one term or one quoted phrase) snippets reliably; a
  multi-clause form (`a|b`, `"a b"~N`, bare `a b`) ranks right but highlights
  **only the rare hit whose OCR runs the terms together** — not the categorical
  "empty `highlights` map" it is easy to mistake it for. A backend highlighter
  limit, not compiler-fixable, so it's guide guidance (harvest one phrase/term per
  call), not code. → `rdv-api-migration-2026-08-10.md` *(internal)*
- **Case folds everywhere; diacritics fold only in the catalogue scopes
  (`search.title`/`author`/`subject`) and only for book records** — never in
  `mapping.fulltext` (`Cholera` 26k vs `choléra` 6k) and never for foldout
  records, which the default availability filter includes. So a default-scope
  query still needs both accent forms OR-ed — guide guidance, and never a silent
  fold in the compiler (same reasoning as the syntax warnings above). →
  `rdv-query-parser-2026-09-05.md` *(internal)*
- **Scope via the `searchFields` arg, not query syntax** (`SCOPE_FIELDS`); every
  search/facet call must also send `view:"sgbr"` + the base filters (`flags=all`,
  `availableData` ∈ `AVAILABILITY_FULLTEXT_VALUES` — OR-ed aliases, since a stale
  spelling filters to a silent 0). The default field set includes
  `mapping.temp.field1` — the plates' AI image descriptions — as the website's
  does; without it plates are found only by their sparse OCR. `scope: "identifier"`
  is the website's id lookup (`search.identifier` + `mapping.booksData.items.digId`
  + barcode): exact ids only. A scan id finds its record AND, for a multivolume or
  multi-copy work, the parent, which spans every scan it lists (copies from other
  libraries included), so `findScanRecordId` picks the record for exactly that scan.
  → `rdv-graphql-schema.md`, `rdv-prod-reprobe-2026-09-27.md` *(internal)*
- **Five sort fields only** — `_score`, `_doc`, `mapping.date.gte`/`.lte`,
  `sort.title` (`SORT_ORDERS`; unknown = hard error, and no author sort). Past the
  ~10k `max_result_window` a deep offset returns HTTP 200 with the wrong page, so
  only `assertPageWindow` stops fabricated hits. → `rdv-graphql-schema.md` *(internal)*
- **Faceting can't use `search(facets:)`** (a hard `internal system error`) — it goes
  through the dedicated `facetFiltered` op, which must send the *same* `searchFields`+`filters`
  or the counts disagree; the `year` facet ignores `size` and puts the doc total in
  `count` (special-cased in `facet.js`). → `rdv-facets-and-collections.md` *(internal)*
- **The `stats` cross-tab mislabels cells under a narrowed base.** With any
  narrowing clause in its shared `filters` (range, exclude, positive filter) it
  returns real counts under the wrong `i:j` names, differently per call; so the
  compiler shares only `flags` and puts all narrowing in each cell. The tool counts
  a narrowed grid of up to three cells one cell per call (one name, nothing to
  mislabel), and accepts a larger one only once two calls agree whose cell orders
  differ by more than a rotation or reflection — a mislabel that follows
  submission position survives either. →
  `rdv-stats-crosstab.md` *(internal)*
- **Search returns at most 25 hits per page** whatever `size` asks for, while
  the next offset follows the requested size — hence `MAX_PAGE_SIZE = 25`.
- **`get(id)`/`autocomplete` reject a `view` arg**; autocomplete suggestions land in
  `namedResults[]` (not the always-empty `titles/authors/subjects`); a bad id is
  **HTTP 200 with an empty `result`**, not a 404 (`isEmptyRecord`). →
  `rdv-graphql-schema.md` *(internal)*
- **`FACET_DIMENSIONS` is one registry** for both counting and narrowing; a string
  dim reads back `strings:`-prefixed but you **filter** it as `[<dim>].<value>`
  (read form → 0). `call_number` is a `scope`, not a filter; `subject_area/topic/
  foldout_type/genre_ai` are machine-derived enrichments, not catalogued.
  `exclude` is the same clause with `boolTerm.not: true` — an exact negation of
  the OR-ed values that, unlike a positive filter, RDV does apply to that
  dimension's own aggregation. →
  `rdv-facets-and-collections.md` *(internal)*
- **The daterange field mixes the publication date with numeric `*AsDate`
  measures** (`sgbrOcrQuality` / `MediaCount` / `VolumeCount` / `ItemsCount` /
  `ZBConfValueAsDate` — page count 102 is stored as the "year" 0102). A bare
  range clause matches a record where ANY family falls in the range, so every
  range clause names its family as `values: ["[<family>].undefined"]`
  (`RANGE_FILTERS`) — the literal the website's own filter builder emits, a JS
  artifact, and the ONLY suffix the backend honours (`.x`, `.*`, bare
  `[<family>]` are silently ignored). That fixes the year filter's over-matching
  and backs `pages_min/max` + `ocr_quality_min`; it also makes `facet=year` honour
  its own range, spilling buckets past the window (multi-year spans) that
  `facet.js` trims. The measures facet only via `term.include` (the field-suffix
  form silently echoes the publication histogram). Because the form rides on a
  website bug, `test/daterange_contamination.test.js` (live) pins it. →
  `rdv-prod-reprobe-2026-09-27.md` *(internal)*
- **Record richness hides in the `link`/`extended` sidecars** (`extended` is a JSON
  string), mined by `src/lib/detail.js`; the search shaper reads only `text`. →
  `rdv-graphql-schema.md` *(internal)*
- **Full text is a separate REST service** keyed by scan id (from
  `sgbrScannedDigIds`), windowed + cached — not GraphQL. Its `/<from>-<to>`
  page-range form is **capped at 100 requests per IP per day** (HTTP 429 with a
  JSON message and no `Retry-After`; the whole-book form is not metered the same
  way), so `sgbr_get_fulltext`'s page spans read the mediaserver's per-page `.txt`
  assets instead — they concatenate to exactly the book's text, answer 404 past
  the last page and an empty 200 on a blank one. Never build on the range form,
  and don't probe it casually: a probing session can spend the day's allowance. →
  `rdv-graphql-schema.md`, `rdv-prod-reprobe-2026-09-27.md` *(internal)*
- **IIIF Content Search (`/iiif/services/<record id>/search?q=`) is `sgbr_locate_text`'s
  first engine** — the website viewer's in-volume search. Keyed by RECORD id (a scan
  or bare MMS id answers `null`, as do zero hits and a query it cannot parse — so the
  phrase goes out quoted, stray `"`/`\` stripped). Whole words only, case folded but
  NOT accents or long-ſ, relevance-ordered, no paging and no size header (a common
  word runs to megabytes — hence `CONTENT_SEARCH_MAX_BYTES`, read while streaming).
  A WORK id searches every scan it lists, which can be other libraries' copies, so
  the tool only ever searches the record for exactly its scan (`findScanRecordId`).
  The viewer behaves the same way: a work id's `/detail/<work>?page=N` is not that
  scan's page N, so locate links hits only through the per-scan record, else null.
  "auto" hands over to the page scan on zero hits, a lookup miss, an error, or an
  oversized answer. No rate limit seen (150+ calls in a day). →
  `rdv-prod-reprobe-2026-09-27.md` *(internal)*
- **The mediaserver UPSCALES a crop smaller than the requested size box**, though
  it emits no `sizeUpscaling` in `info.json` and we never send the v3 `^` prefix.
  Unclamped, a word-sized `region_pct` (median 70×30 native px) is interpolated up
  to a full-page payload at ~275× the visual tokens of the content present. Only the
  caller-side clamp in `src/lib/vision.js` stops it, and withholding `^` is not
  protection. Overshoot of the `!N,N` box (up to 42px) is a symptom of the same
  upscaling and disappears with the clamp. → `vision-image-sizing-census.md` *(internal)*
- **Page shapes are bimodal**: book pages are 99.7% portrait (native long edge
  ~2480 median), foldout plates 76% landscape and far bigger (~4584 median, 8390
  at p95, 7.9% over the API's 8000px per-image maximum). A single delivery size
  suits neither, which is why the box is solved per region rather than fixed. →
  `vision-image-sizing-census.md` *(internal)*
- **GraphQL counts records, not pages.** Every count the view exposes
  (`totalCount`, `CountResult.resultCount`/`digitalizedCount`, facet buckets) is a
  **record** count (~1.07M total; ~460k `Volltext`). The platform's own "140 million pages /
  ~450k full-text volumes" figures are a *separate page-level full-text index* (~450k ≈ the
  `Volltext` volumes; ~340 pp/vol, sampled) that the `sgbr` view cannot total —
  GraphQL surfaces pages only per record (`fileCount` = "N Bilder, N Textdokumente").
  Beware "volumes": records (~1.07M) vs. `Volltext` (~460k) vs. `object_type:Band`
  (~137k, only child volumes of multivolume works) are three different numbers.
  These grow — re-derive with `sgbr_facet_values` rather than quoting them. →
  `rdv-graphql-schema.md` *(internal)*
- **Semantic search exists but is unwired** — `vector:[Float!]` kNN needs the
  index's (unknown) embedding model + dimension. → `rdv-semantic-search.md` *(internal)*

## Architecture

Layered, one direction of dependency (tool → compiler → operations → client;
tool → shaper):

- **`src/index.js`** — entry. `serveStdio(() => createServer())`. **stdout is
  reserved for JSON-RPC; all logging goes to stderr** (`console.error`).
- **`src/http.js`** — the second entry: stateless Streamable HTTP
  (`createMcpHandler` + `toNodeHandler`, after skkg-mcp), never a mode of
  `index.js`, since the `.mcpb` launches that. Anonymous only: it refuses to start
  with `SGBR_ACCESS_TOKEN` set. The endpoint is `/mcp`; every other path
  but a public `GET /health` gets 404. Origin/Host
  checks against DNS rebinding live in `src/lib/origin.js`; every call is logged at
  a level, without its input or error message — a failure only by `error_type` and
  `status` (`useHostedLog` in `src/lib/tool.js`).
- **`src/server.js`** — `createServer()` builds a fresh `McpServer` and registers
  the ten tools. It's invoked **per connection**, so it must stay side-effect-free
  beyond registration; shared state (caches) lives at module scope in the module
  that owns it, never here. Registration order **is** the `tools/list` order and
  must equal `manifest.json`'s `tools[]` (`test/cache_hints.test.js`); `CACHE_HINTS`
  (SEP-2549, `config.js`) is the catalogue's only freshness signal.
- **`src/tools/*.js`** — one file per MCP tool. Each defines a **`.strict()` zod
  `inputSchema`** and an `outputSchema`, sets `annotations: READ_ONLY_ANNOTATIONS`
  (the shared four-hint block in `config.js`), and wraps its handler in `withTool`
  (`src/lib/tool.js`) — the one place owning the try/catch → `isError` shape and the
  gated `SGBR_LOG` per-call debug line.
  - Every tool sets `title: <TOOL_NAME_CONST>` (the literal name, e.g.
    `SEARCH_TOOL_NAME`): Desktop shows `title` to humans and otherwise prettifies
    `name`, so its list would disagree with the name SKILL.md, the model and the
    CLI use. The model never sees `title`.
- **`src/search/compiler.js`** — translates high-level tool args → RDV GraphQL
  variables (the `view`/`searchFields`/`filters`/`facet` plumbing above). The one
  place that knows the backend's argument shape; `buildDimensionFilters` builds
  filter clauses generically off `FACET_DIMENSIONS[kind]` (string / agent / daterange).
- **`src/graphql/client.js`** — `graphqlRequest`: delegates the fetch/timeout/retry
  loop to `src/lib/http.js`, adds `errors[]` parsing, and wraps the whole call in an
  LRU+TTL response cache (`GRAPHQL_CACHE_*`) keyed by `(auth-fingerprint, operation,
  variables)` — read-only corpus, so it coalesces the identical calls tool-chaining
  produces (one record resolved by three tools; a facet query re-counted per facet).
- **`src/fulltext/client.js`** — the parallel REST client for OCR bodies, with an
  LRU+TTL cache (`src/lib/cache.js`) so paging one book downloads it once.
- **`src/image/client.js`** — the sibling REST client for IIIF page-image **bytes**
  (`sgbr_inspect_image`), same cache shape as the fulltext client but returning a
  `{ buffer, mimeType }` instead of normalised text. Also `fetchImageInfo` for a
  page's `info.json` (native dimensions, its own roomier LRU): it returns **null**
  rather than throwing when the description is unavailable, because that only
  costs the delivery clamp — an image must still serve without it.
- **`src/ocr/client.js`** — REST client for per-page OCR assets (hOCR + plain text),
  addressed by full asset URL, not scan id; backs `sgbr_get_page_ocr` and
  `sgbr_locate_text`. Its page-text reader (404 → `exists: false`, its own roomier
  cache) serves both `sgbr_locate_text`'s scan and `sgbr_get_fulltext`'s page spans,
  so a span read after a locate reuses the scanned pages. Same cache shape as the
  fulltext/image clients.
- **`src/contentsearch/client.js`** — REST client for IIIF Content Search
  (`sgbr_locate_text`'s first engine), on the GraphQL endpoint's host. Reads the body
  through a byte cap; caches the parsed hit lines (parser in `src/lib/locate.js`).
- **`src/collection/client.js`** — **anonymous** REST client for a record's parent
  IIIF Collection manifest (multivolume sibling enumeration for `sgbr_locate_text`).
  Sends **no** auth headers, keyed by URL alone — the manifest URL is record-supplied,
  not a validated endpoint, so forwarding the token could leak it. The pure parser
  (`parseCollectionChildren`) stays in `src/lib/locate.js`.
- **`src/lib/http.js`** — `fetchWithRetry`: the one fetch loop shared by every client
  above (timeout, abort propagation, capped exponential backoff, and RFC-9110
  `Retry-After` via `parseRetryAfter` — honored under `RETRY_MAX_DELAY_MS`, failed
  fast above it). A fetch `TypeError` is retried only when its `cause` carries a
  network error code (`isNetworkFailure`); one with no coded cause (an invalid
  header, a blocked port, an `onOk` bug) or an undici request rejection fails at
  once. Clients pass only their fetch options, an `onOk` body extractor, and a
  `makeError` factory.
- **`src/lib/*.js`** — shapers plus shared helpers. `vision.js` (the
  `sgbr_inspect_image` delivery-size solver) is deliberately separate from
  `image.js`: a vision encoder's billing rules and the mediaserver's URL grammar
  change for entirely unrelated reasons.
- **Two modules exist solely to stop the three narrowing tools (`sgbr_search`,
  `sgbr_facet_values`, `sgbr_facet_breakdown`) from drifting apart**, since all
  narrow a query over the same registry:
  `src/tools/filter-schema.js` owns the shared `filters` + range zod surface
  (input side), `src/lib/applied.js` owns the `applied_filters` echo (output side).
  Change how one tool narrows and you change both — edit these, not a tool file.

## Working in this repo

- **Do not create a new branch or git worktree without the user's explicit
  approval.** Make changes on the current branch and ask first if a branch or
  worktree seems warranted — don't switch or branch on your own initiative.
- **`main` is pushed regularly, so `origin/main` tracks the local tip.** Isolated
  worktrees (e.g. an `improve execute` run) are cut from `origin/main`, so they're
  normally current — only commits made locally but not yet pushed would be missing.
  If a worktree looks behind, fast-forward it to the local tip:
  `git merge --ff-only $(git rev-parse main)` (the local tip is a descendant of
  `origin/main`, so this is clean and touches neither `origin` nor your working tree).

## Conventions to follow

- **Two output channels, always.** Every tool returns both a human-readable
  `content[{ type:'text', text }]` and machine-readable `structuredContent`. Shapers
  produce both from one structured object.
- **Every failure inside a handler reaches the client as a tool result with
  `isError: true`**, never as a JSON-RPC error: handlers throw, and `withTool`
  (`src/lib/tool.js`) converts the exception via `formatErrorText`
  (`src/lib/errors.js`). For what the LLM can self-correct (bad input, a query the
  backend rejected), throw a `ToolError` with an actionable suggestion; a
  transport failure (timeout, HTTP 5xx) is thrown as-is and arrives as its
  message. Input that fails the schema never reaches the handler; the SDK
  rejects it first.
- **Input schemas must be `.strict()` and `$ref`-free.** claude.ai's validator
  can't resolve `$ref`; `test/smoke.test.js` asserts this for every tool — keep it
  passing.
- **Token frugality is a feature.** Shapers `prune()` empty values and summarise
  bulk media lists to counts + license rather than enumerating hundreds of
  per-page entries. Respect `RESULT_CHAR_CEILING`.
- **New backend behaviour → add a constant to `config.js`**, don't scatter field
  ids/magic strings through tools. Field names, facet dimensions, and scopes are
  all centralised there.
- **Each channel must stand alone: a host may pass the model only one.** Claude
  Desktop (stdio) gives the model only `content[].text`; Claude Code gives it only
  `structuredContent`, as a JSON string (skkg-mcp's marker test, 2026-11-06,
  Desktop 4.23118.0, Claude Code 2.1.319). So a field the model needs goes in both
  channels, and the text is a compact rendering, never JSON
  (`test/channel_parity.test.js` guards ids, paging and `viewer_url`). `sgbr_search` declares an
  `outputSchema` (SDK-validated on success — error results are exempt) and echoes
  the narrowing as `applied_filters` for round-tripping; `sgbr_facet_values`
  reports enrichment `coverage_pct`.
- **Auth is a single seam** (`src/lib/auth.js`): anonymous by default; set
  `SGBR_ACCESS_TOKEN` to add a bearer token for ACL-restricted records. Read at
  call time — never cache the env. A token holding CR/LF/NUL (which fetch echoes
  in its error) or a non-Latin-1 character is refused, unquoted, at startup and
  per request.
- **The guidance has one copy: `src/guide.md`**, served by `sgbr_guide`, one
  `##` section per topic (`src/lib/guide.js` refuses a heading, fence or empty
  section that would misname or split one). SKILL.md is only a pointer to the
  tool: an installed skill is never updated by the server, so guidance there
  would go stale. Never copy guidance back into it.
- **Adding a tool touches nine places:** `src/tools/<name>.js` + its registration
  in `server.js` (in manifest order), `manifest.json` `tools[]`, `REQUIRED_PROPS` in
  `test/smoke.test.js`, a scenario in `test/channel_parity.test.js`, a
  `docs/tools.md` section (then `build:docs`), a `VERBS` row + example in
  `scripts/cli.mjs`, `src/guide.md`, and the "ten" counts here and in README.
- **Committed files never reference `plans/` or `research/` by path** — those
  dirs are gitignored maintainer-local notes, so a path there is a broken link
  for every other reader. In `docs/`, name what a probe backs in resolvable
  terms (tool name, outcome); bare-filename `*(internal)*` mentions of research
  write-ups are the established exception.
- **Editing a tool `description`, a parameter's `.describe()`, or
  `SERVER_INSTRUCTIONS` → run `npm run build:docs` and commit `docs/tools.md`.**
  Its `<!-- generated:… -->` blocks (instructions, each description, each parameter
  table) are rendered from a live `listTools()`; everything outside them is
  hand-written. `test/docs.test.js` fails on a stale block, and the generator
  fails when a **newly registered tool** has no `## \`sgbr_x\`` section with both
  markers — document it as you add it.
- **`docs/research-scenarios.md` quotes real tool output, and NO test guards its
  figures.** A shifted figure falsifies it silently. Its argument fragments, like
  `src/guide.md`'s and the descriptions', are checked by
  `test/doc_examples.test.js`: keys and enum values offline, filter values live at
  release (an unknown filter value returns an **empty result, not an error**, so a
  stale example reads as a real finding of zero). Re-run what you quote; prefer
  `full_text_only` over hand-spelling a vocabulary value.
- **A backend claim can live in six places at once, and nothing enforces
  agreement.** A single fact about how RDV behaves may appear in `src/guide.md` prose, a
  runtime warning string (`src/lib/warnings.js`), a source comment, `config.js`,
  this file, and `docs/research-scenarios.md`'s worked examples — six copies, and
  no test reconciles them (`docs/tools.md`'s hand-written notes and tool
  descriptions/`.describe()` text, which also state tool policy, included). So **correcting a
  backend claim means sweeping all six**, not editing where you found it: `rg` the
  claim's distinctive words across `src/ docs/ CLAUDE.md` before you
  consider it fixed. A warning string that still asserts the old behaviour is worse
  than silence — the model reads it as authoritative and discounts what it just saw.
- **Comments carry the load-bearing "why", never a chronology.** The dense commenting
  here is earned by constraints a reader can't see locally — a backend trap, a "don't
  re-add this" warning — never by narrating what a prior version did, what a fix
  changed, or how a bug behaved: `git log`/`git blame` hold that more precisely, and a
  before/after note silently goes false the next time the code moves. Don't restate
  the line below, and don't state one fact at three sites. When a change has a story
  worth telling, the commit message is where it goes.
- **Tests assert behaviour and invariants, not implementation** (full rules in
  `test/CLAUDE.md`).
  - **The offline suite is the only continuous layer.** The live tests run only
    by hand, so never drop an offline test because a live one covers the same thing.
  - **Never delete or weaken a failing test to make the suite pass.** Treat the
    failure as a possible product bug: fix the code, or ask.
- **A review fix changes what its finding names, and nothing more.** Fix review
  findings in proportion to the evidence; a fix that redesigns more than its finding
  names brings in defects of its own, which the next review then finds.
  - **Fix now only what gives a wrong result or a false message against today's
    backend.** A latent finding (reachable, but with no instance in the live data, or
    a probe that came back clean or inconclusive) is recorded with the review's
    verdicts and fixed in the next commit that touches its code, not on its own.
  - **Ask before a fix that needs a new helper, option, output field or code path.**
    A finding that needs one is a feature, with its own commit and its own review.
  - **Review a fix commit once, at its own size**, not the whole branch again. Keep
    one fix commit to one finding or a tight group, and skip cleanups (`/simplify`)
    on a fix branch. Merge when that review confirms no defect that occurs today.

## Environment variables

`SGBR_GRAPHQL_ENDPOINT`, `SGBR_FULLTEXT_ENDPOINT`, `SGBR_IMAGE_ENDPOINT`
(IIIF page images), `SGBR_OCR_ENDPOINT` (per-page hOCR/text assets — the
mediaserver base, without `SGBR_IMAGE_ENDPOINT`'s `/iiif/3` segment;
overridable separately so it can move independently of the image base),
`SGBR_FRONTEND_URL` (viewer-link base), `SGBR_TIMEOUT_MS`,
`SGBR_RESULT_CHAR_CEILING`, `SGBR_ACCESS_TOKEN` (all optional; sensible defaults
in `config.js`). The HTTP entry also reads, in `src/http-config.js`, `PORT`, `SGBR_HTTP_RESPONSE_TIMEOUT_MS` (wall
clock per request, kept under Claude's 240 s), `SGBR_HTTP_MAX_INFLIGHT`,
`MCP_ALLOWED_ORIGINS`, `MCP_ALLOWED_HOSTS`, and Railway's `RAILWAY_PUBLIC_DOMAIN`
and `RAILWAY_GIT_COMMIT_SHA`. `SGBR_LOG=1` turns on a gated one-JSON-line-per-call debug log on
stderr (`{tool, ms, ok, error?, input?, progress_token?, output_bytes, structured_bytes}`, read at
call time in `src/lib/tool.js#withTool`); off by default.

Every outbound request carries `User-Agent: ub-sgbr-mcp/<version> (<entry>)`
(`userAgent()` in `config.js`, set once in `fetchWithRetry`). `<entry>` comes from
`SGBR_ENTRY_POINT`, which the **launcher** sets — `manifest.json` → `mcpb`, the
`bbad` CLI → `cli`, default `stdio` — because they all run the same stdio entry;
`src/http.js` defaults it to `http` itself. No contact URL, by choice.

**A wrong `SGBR_GRAPHQL_ENDPOINT` returns HTTP 200 and plausible counts over the
wrong corpus.** The defaults are the public production proxies on
`books-as-data.ch` (`/query/graphql`, `/gbooksapi/…`, `/media/…`) — the ones the
website itself calls. The library's internal hosts serve different indexes
(their own enrichment fields, no ARKs), and which index a host serves has
changed between releases, so identify a host by probing a vocabulary value and a
record id, never from a remembered mapping.

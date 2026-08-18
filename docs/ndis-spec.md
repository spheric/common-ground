# Common Ground — NDIS Tracker spec

Binding contract for the NDIS section: data pipeline, page, and CI. Two builders work from
this file: **Builder A** (scripts + data plumbing + CI) and **Builder B** (web page). Where they
meet — file paths, the `ndis.json` shape, design tokens — follow this file exactly.
The main app's contract in `docs/app-spec.md` still governs shared things (design system,
zero-dep rule, accessibility bar).

## What this section is

A tracker page at `dist/ndis.html` (deployed beside the main app) that follows the NDIS through
official primary sources: **what prices changed** (the NDIS Support Catalogue, diffed release
over release), **what the law did** (Federal Register of Legislation timeline), **what
parliament and the agencies are doing** (curated updates feed: hearings, bills, quarterly
reports, audits, announcements), and **context numbers** (scheme size from quarterly data, ABS
disability stats). Core promise inherited from the main app: **every item is source-linked to an
official document; nothing is editorialised**. Summaries paraphrase cited sources.

Principles, same order: accuracy → neutrality → accessibility → ease of use → beauty.

## Verified source facts (from the Aug 2026 research pass — builders rely on these)

- **Support Catalogue**: XLSX linked from
  `https://www.ndis.gov.au/providers/pricing-and-payments/pricing/what-support-catalogue`;
  the media URL (`/media/<id>/download?attachment`) **changes each release** — scrape the page
  for the current link. Version is in the `content-disposition` filename
  (e.g. `NDIS-Support-Catalogue-2026-27 v1_1.xlsx`); `etag`/`last-modified` support conditional
  GET. Archive (back to 2015-16, 295 links):
  `https://www.ndis.gov.au/providers/pricing-and-payments/pricing-archive/pricing-arrangements-archive`.
  **`www.ndis.gov.au` is behind a Cloudflare JS challenge and may 403 plain fetches** — every
  script touching it must treat 403 as a soft failure (see §fetch rules).
- **Catalogue schema is NOT stable.** Stable key: `Support Item Number`. Geography columns vary:
  2022-23 has 8 state columns + `P01`/`P02`; 2024-25 and 2025-26 have 8 states +
  `Remote`/`Very Remote` (28 cols); **2026-27 collapsed states into a single `National` column**
  (21 cols) and renamed the `Type` value `Price Limited Supports` → `Priced Supports`.
  Sheets: `Current Support Items`, `Legacy Support Items` (parse the first only).
  Dates are `YYYYMMDD` integers, sentinel `99991231` = open-ended.
- **Quarterly data**: `dataresearch.ndis.gov.au` (NO Cloudflare, plain fetch fine). CSVs:
  payments `/media/4577/download?attachment` (~14 MB; header
  `RprtDt,SuppClass,SuppCatNm,SuppItemNmbr,SuppItemDesc,RsdsInStateCd,RsdsInSrvcDstrctNm,NDISDsbltyGrpNm,NDIAAgeBnd,PmtAmt,CountofParticipants`),
  participants + plan budgets `/media/4573/`, utilisation `/media/4574/`. `SuppItemNmbr` joins
  to the catalogue's `Support Item Number`. **Never commit the raw CSVs** — aggregate only.
- **Legislation API**: public OData v4, no auth: `https://api.prod.legislation.gov.au/v1/`.
  Titles: `/v1/titles?$filter=contains(name,'National Disability Insurance Scheme')&$orderby=asMadeRegisteredAt desc`
  (135 titles; fields `id,name,collection,status,makingDate,asMadeRegisteredAt`).
  NDIS Act compilations: `/v1/Versions?$filter=titleId eq 'C2013A00020'`.
- **ParlInfo RSS** (committee Hansard; browser UA header required, no challenge):
  `https://parlinfo.aph.gov.au/parlInfo/feeds/rss.w3p;adv=yes;orderBy=priority,doc_date-rev;query=Dataset%3AcomJoint;resCount=Default`
  and the same with `Dataset%3AcomRep` / `Dataset%3AcomSen,estimate`. Transcript XML:
  `https://www.aph.gov.au/api/hansard/link/?id=<bid>&linktype=xml&fulltranscript=True`.
- **Government news RSS**: `https://www.health.gov.au/rss.xml` and
  `https://www.health.gov.au/news/rss.xml` (~10 items each, mixed portfolio — keyword-filter).
  ndis.gov.au and the NDIS Commission have **no news RSS** (the Commission's `/rss.xml` is
  provider registrations only — do not ingest it).
- **ABS Data API**: host is `https://data.api.abs.gov.au/rest/` (the old `api.data.abs.gov.au`
  is dead DNS). No API key. Census disability by electoral division works:
  `/data/C21_G18_CED/3._T.1..CED.?startPeriod=2021&format=csv`. No SDAC dataflows — SDAC is
  file-only, last release 4 Jul 2024 (2022 reference period). Census "core activity need for
  assistance" ≠ SDAC "disability prevalence" — never conflate; label each precisely.
- Portfolio facts for copy: NDIS sits in **Health, Disability and Ageing** (moved from Social
  Services). Ministers: **Mark Butler** (Minister for Disability and the NDIS) and **Senator
  Jenny McAllister** (Minister for the NDIS). Live bill: *NDIS Amendment (Securing the NDIS for
  Future Generations) Bill 2026* — before the Senate; would give the Minister pricing-
  determination power. 2026-27 restructured the PAPL into three documents (Annual Pricing
  Review, Pricing Schedule, Support Catalogue). JSC on the NDIS exists in the 48th Parliament.
  2026 Census: held 11 Aug 2026, first data (incl. disability) June 2027.

## Repo layout (new files only)

```
docs/ndis-spec.md                  # this file
data/ndis/snapshots/<release>.json # one normalised catalogue snapshot per ingested release
data/ndis/law.json                 # law timeline (script-generated from legislation API)
data/ndis/feed.json                # curated updates feed (agent/skill-maintained)
data/ndis/context.json             # quarterly aggregates + ABS stats + next-data markers
data/ndis/state.json               # fetch state: current catalogue etag/last-modified/url
data/ndis/ndis.json                # DERIVED page dataset — never hand-edited
scripts/ndis/xlsx.mjs              # minimal zero-dep XLSX reader (lib, no CLI)
scripts/ndis/fetch-catalogue.mjs   # current catalogue → snapshot (Cloudflare-tolerant)
scripts/ndis/ingest-file.mjs       # local XLSX/CSV file → snapshot (manual/agent fallback)
scripts/ndis/fetch-law.mjs         # legislation API → law.json
scripts/ndis/fetch-context.mjs     # quarterly CSVs + ABS API → context.json
scripts/ndis/fetch-feeds.mjs       # ParlInfo + health.gov.au RSS → candidate feed items
scripts/ndis/derive.mjs            # snapshots+law+feed+context → ndis.json
scripts/ndis/validate.mjs          # validates all data/ndis files, exit 1 on failure
web/ndis.html                      # page template (same token scheme as index)
web/ndis.css                       # page styles (self-contained; tokens copied from app-spec)
web/ndis.js                        # page behaviour
.github/workflows/ndis-refresh.yml # scheduled refresh
.claude/skills/ingest-ndis-update/SKILL.md  # agent-native ingestion skill
```

Zero npm dependencies. Node ≥ 18, ESM. No network at page runtime — `dist/ndis.html` is fully
self-contained. Scripts fetch with global `fetch`.

## Fetch rules (all scripts/ndis/fetch-*)

- Send `User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36`
  and `Accept: */*`. One retry on network error. 15 s timeout per request
  (`AbortSignal.timeout`).
- **HTTP 403 or a Cloudflare challenge body from `*.ndis.gov.au` is a SOFT failure**: print
  `blocked: <url> — run scripts/ndis/ingest-file.mjs with a browser-downloaded file`, exit 0
  without changing data. Any other failure: exit 1.
- Conditional GET for the catalogue: store `etag`/`last-modified`/`source_url`/`filename` in
  `data/ndis/state.json`; send `If-None-Match`/`If-Modified-Since`; 304 → "no change", exit 0.
- Never write partial data: build the full JSON in memory, validate shape, then write once.
- Politeness: ≥ 1 s between requests to the same host; never parallel-fetch the archive.

## Data shapes (contract between Builder A and Builder B)

All dates ISO `YYYY-MM-DD` strings unless noted. All money in dollars as JS numbers (2 dp).

### snapshots/<release>.json

`release` id format: `<fy>-v<version>` e.g. `2026-27-v1.1`, from the source filename. When the
source filename carries no version marker (some archived files), `version` is `null` and the
release id is the financial year alone (e.g. `2025-26`) — never a guessed version.

```json
{
  "release": "2026-27-v1.1",
  "fy": "2026-27",
  "version": "1.1",
  "effective": "2026-07-01",
  "source_url": "https://www.ndis.gov.au/media/8038/download?attachment",
  "source_filename": "NDIS-Support-Catalogue-2026-27 v1_1.xlsx",
  "fetched_at": "2026-08-18",
  "items": [
    {
      "num": "01_011_0107_1_1",
      "name": "Assistance With Self-Care Activities - Standard - Weekday Daytime",
      "category_num": 1,
      "category": "Assistance with Daily Life",
      "reg_group": "0107",
      "unit": "H",
      "quote": false,
      "start": "2026-07-01",
      "end": null,
      "prices": { "national": 70.23, "remote": 98.32, "very_remote": 105.35 }
    }
  ]
}
```

Geography normalisation (Builder A): for releases with 8 state columns, `prices.national` =
the modal state value; if states differ, also set `prices.state_min`/`prices.state_max`.
`P01`→`remote`, `P02`→`very_remote`. Missing/blank price → key absent. Quote-only items:
`"quote": true`, `prices` may be `{}`. `end` of `99991231` → `null`. Parse only the
`Current Support Items` sheet. Trim all strings; numbers parsed strictly (NaN → validation
failure, not silent null).

### law.json (script-generated)

```json
{
  "generated": "2026-08-18",
  "act_versions": [
    { "compilation": 25, "register_id": "C2026C00181", "start": "2026-05-06", "url": "https://www.legislation.gov.au/C2013A00020/2026-05-06" }
  ],
  "titles": [
    { "register_id": "C2026A00041", "name": "National Disability Insurance Scheme Amendment (Integrity and Safeguarding) Act 2026",
      "collection": "Act", "status": "InForce", "made": "2026-04-10", "registered": "2026-04-10",
      "url": "https://www.legislation.gov.au/C2026A00041" }
  ]
}
```

`url` construction: `https://www.legislation.gov.au/<register_id>` (append `/<start-date>` for
compilations). Keep all 135+ titles; the page filters/sections them.

### feed.json (curated — the skill and seed agents write this; scripts only append candidates)

```json
{
  "items": [
    {
      "id": "2026-05-14-securing-ndis-bill",
      "date": "2026-05-14",
      "type": "bill",
      "title": "NDIS Amendment (Securing the NDIS for Future Generations) Bill 2026 introduced",
      "summary": "Would give the Minister for the NDIS the power to make a pricing determination. Before the Senate.",
      "source": { "title": "Bill homepage", "url": "https://www.aph.gov.au/Parliamentary_Business/Bills_Legislation/Bills_Search_Results/Result?bId=r7487", "publisher": "Parliament of Australia" },
      "verified": "confirmed"
    }
  ]
}
```

`type` ∈ `pricing | law | bill | hearing | report | audit | announcement | data`.
`verified` ∈ `confirmed` (a human/agent fetched the source and checked the claim) | `auto`
(machine-imported from an official RSS feed, title reproduced verbatim, **no generated
summary** — `summary` MUST be absent on `auto` items). `summary` ≤ 40 words, neutral,
paraphrases the source only. `id` = `<date>-<slug>`, unique.

### context.json (script-generated)

```json
{
  "generated": "2026-08-18",
  "quarterly": {
    "as_of_quarter": "2026-06-30",
    "source": { "title": "NDIS quarterly datasets", "url": "https://dataresearch.ndis.gov.au/datasets", "publisher": "NDIA" },
    "by_quarter": [ { "quarter": "2026-06-30", "payments_total": 0, "participants": 0 } ],
    "top_categories_latest": [ { "category": "Assistance with Daily Life", "payments": 0, "share": 0.0 } ]
  },
  "abs": {
    "census_assistance": { "label": "People needing help with core activities, Census 2021", "value": 0, "source": { "title": "ABS Data API C21_G18", "url": "https://data.api.abs.gov.au/rest/data/C21_G18_AUS/...", "publisher": "ABS" } },
    "sdac": { "label": "Disability prevalence, SDAC 2022", "value_pct": 21.4, "released": "2024-07-04", "source": { "title": "SDAC 2022 summary findings", "url": "https://www.abs.gov.au/statistics/health/disability/disability-ageing-and-carers-australia-summary-findings/2022", "publisher": "ABS" } }
  },
  "next_data": [
    { "label": "NDIA quarterly report (Sep quarter)", "due": "2026-11-11", "note": "published within 42 days of quarter end" },
    { "label": "2026 Census first release (includes disability)", "due": "2027-06-30" }
  ]
}
```

`quarterly.by_quarter`: `RprtDt` groups from the payments CSV (sum `PmtAmt`; participants from
the participant-numbers CSV national row). Every block is **optional** — if a fetch is blocked
or a shape changes, omit the block; the page must render without any given block (see §page).

Two further optional context blocks (added for the consolidation widgets):

```json
"payments_by_category": {
  "as_of_quarter": "2026-06-30",
  "window": "12 months to report date",
  "source": { "title": "NDIS payments data, NDIA dataresearch", "url": "https://dataresearch.ndis.gov.au/datasets", "publisher": "NDIA" },
  "rows": [
    { "category": "Assistance with Daily Life", "catalogue_category": "Assistance with Daily Life (Includes SIL)",
      "payments": 0, "participants": 0, "avg_per_participant": 0 }
  ]
},
"electorates": {
  "label": "People needing help with core activities by federal electorate, Census 2021",
  "source": { "title": "ABS Data API, C21_G18_CED", "url": "https://data.api.abs.gov.au/rest/data/C21_G18_CED/...", "publisher": "ABS" },
  "national_total": 0,
  "rows": [ { "name": "Banks", "code": "101", "need": 0 } ]
}
```

`payments_by_category.rows`: one row per `SuppCatNm` in the latest report date of the payments
CSV (ALL categories, not top-10): `payments` = sum of `PmtAmt`, `participants` = the
`CountofParticipants` on the category-level `SuppItemNmbr === 'ALL'` row if the CSV provides
one (else omit the field), `avg_per_participant` = payments/participants rounded to 0 dp (omit
when participants absent). `catalogue_category` maps the payments dataset's category name to the
Support Catalogue's category label via an EXPLICIT hand-checked mapping table in the script —
no fuzzy matching; unmapped rows carry `"catalogue_category": null` and the page prints "—" for
catalogue-joined columns. `electorates.rows`: one row per Commonwealth Electoral Division from
`C21_G18_CED` (the same measure/filters as the national census_assistance query; verify the
dimension meaning against the DSD before trusting values — if the national sum of rows differs
from `census_assistance.value` by more than 1%, omit the whole block rather than publish
mismatched numbers). `code` is the CED code as returned by the API. No share/percentage fields
unless a same-source denominator is verified.
CPI overlay: if `fetch-context` can retrieve quarterly All groups CPI (Australia) from the ABS
API, add `"cpi": { "series": [ { "quarter": "2026-06-30", "index": 0 } ], "source": {...} }`;
if the dataflow can't be found/verified, omit — never guess numbers.

### ndis.json (derived — the ONLY file the page reads)

```json
{
  "meta": {
    "title": "Common Ground — NDIS Tracker",
    "as_of": "2026-08-18",
    "disclaimer": "...", "methodology": "...",
    "current_release": "2026-27-v1.1"
  },
  "releases": [ { "release": "2019-20-v...", "fy": "2019-20", "effective": "2019-07-01", "source_url": "...", "item_count": 0 } ],
  "items": [
    { "num": "01_011_0107_1_1", "name": "...", "category": "Assistance with Daily Life", "unit": "H",
      "history": [70.23, 72.01, null, 74.1], "spread": [null, null, null, [72.9, 74.5]],
      "active": true }
  ],
  "diffs": [
    {
      "from": "2025-26-v1.0", "to": "2026-27-v1.1",
      "added": [ { "num": "...", "name": "...", "category": "...", "price": 0 } ],
      "retired": [ { "num": "...", "name": "...", "category": "..." } ],
      "changed": [ { "num": "...", "name": "...", "category": "...", "old": 0, "new": 0, "pct": 0.0 } ],
      "by_category": [ { "category": "...", "changed": 0, "added": 0, "retired": 0, "median_pct": 0.0 } ]
    }
  ],
  "law": { "...": "law.json verbatim" },
  "feed": { "...": "feed.json items, sorted date desc" },
  "context": { "...": "context.json verbatim" }
}
```

- `releases` ascending by `effective`; `items[].history` is parallel to `releases` (entry per
  release: `prices.national` or `null` if the item is absent/unpriced that release).
  `spread[i]` = `[state_min, state_max]` when states differed, else `null`. `active` = present
  in the current release. Items sorted by `num`.
- `diffs`: one per consecutive release pair, ascending. `changed` compares `national`;
  `pct` = `(new-old)/old*100` rounded to 1 dp. `median_pct` over changed items only.
- derive.mjs must be **deterministic** (same inputs → byte-identical output; sort everything,
  no timestamps beyond `meta.as_of` = max of input `fetched_at`/`generated` dates).

### scripts/ndis/validate.mjs

Validates every file above (structure, enums, id uniqueness, ISO dates, http(s) URLs, summary
length, `auto`-items-have-no-summary, history/spread lengths === releases length, diffs
consecutive, prices are finite positive numbers). Also: `ndis.json` must be regenerable —
re-run derive in-memory and fail if output differs from the file on disk ("ndis.json is stale —
run derive"). Clear per-failure lines; exit 1 on any; counts summary on success.

### scripts/ndis/xlsx.mjs

Minimal XLSX (zip + XML) reader, zero-dep: parse end-of-central-directory → central directory →
entries; `zlib.inflateRawSync` for deflate (method 8) and raw copy (method 0);
read `xl/workbook.xml` + `xl/_rels/workbook.xml.rels` to resolve sheet name → sheet XML path;
parse `xl/sharedStrings.xml`; expose `readSheet(buffer, sheetName) → string[][]` handling
inline strings, shared strings, numbers, and blank cells (dimension-aware, gaps preserved via
cell references like `C7`). No streaming needed (files are ~130 KB). Handle both ZIP64-absent
and data-descriptor entries defensively (fall back to central-directory sizes).

### build.mjs extension (Builder A — edit `scripts/build.mjs`)

After the existing build, if `web/ndis.html` exists: same token scheme (`<!--__CSS__-->` →
`web/ndis.css`, `<!--__DATA__-->` → `window.NDIS = <data/ndis/ndis.json escaped>`,
`<!--__JS__-->` → `web/ndis.js`) → write `dist/ndis.html`, print path + bytes. If
`data/ndis/ndis.json` is missing, skip with a warning (main build unaffected). Keep the
existing `escapeForInlineScript` and function-replacement patterns. No artifact variant for v1.

## Page spec (Builder B)

Same civic-broadsheet system as `docs/app-spec.md` §design — copy the surface/ink token block
and party-neutral chrome into `web/ndis.css` verbatim (fonts, hairlines, light/dark/theme-toggle
behaviour, motion rules, focus rings). This page uses **no party colours**. Chart colours: the
sequential blue ramp from app-spec (`#cde2fb → #0d366b`, ~5 bins) for magnitude; semantic
green/red washes (same hexes as stance chips) ONLY for increase/decrease chips, always with a
printed sign and value, never colour alone. All charts inline SVG, no libraries; wide things
scroll inside their own `overflow-x: auto` container.

Masthead: "Common Ground" small overline linking to `./index.html`, then serif masthead
"NDIS Tracker", subtitle, "Sources: NDIA, Federal Register of Legislation, Parliament of
Australia, ABS · as of {meta.as_of}", theme toggle (same behaviour/storage key as main app).

### Views & routing (the page is NOT one long scroll)

Client-side views inside the single self-contained file, routed on `location.hash`:

| hash | view | content |
|---|---|---|
| `#/` (or empty/unknown) | **Overview** | front page: lead stat band, "at a glance" folio strip (payments/participants/census/SDAC), the "In brief" movers module, the five most recent updates with an "All updates →" link, next-data list, and an "Inside" index of the other views with one-line descriptions |
| `#/pricing` | Pricing | the diff section + W-A real-price grid + release colophon |
| `#/explorer` | Explorer | price history explorer + W-C basket module |
| `#/money` | Money | W-B where-the-money-goes board |
| `#/law` | Law | law timeline + callout |
| `#/updates` | Updates | full feed with type filters |
| `#/numbers` | Numbers | scheme in numbers + W-D electorate lookup |

Rules: the masthead contents row IS the view nav (same newspaper-index styling; active view
in ink with underline + `aria-current="page"`, others muted; wraps on narrow screens). Routing
via `hashchange` + initial load; unknown hash → Overview; on view change scroll to top, set
`document.title = "Common Ground — NDIS Tracker · {View}"`, move focus to the view's `<h2>`
(`tabindex="-1"`) without a visible ring unless keyboard-focused. Only the active view is
rendered (others stay empty); per-view render state (pinned items, filters, picker) lives in
the existing `state` object so switching views and returning preserves it. Overview modules
reuse the same render helpers as their home views (front-page teasers duplicating inside
content is correct newspaper behaviour). The lead stat band appears ONLY on Overview. Browser
back/forward must work (hash history). Deep links land on the right view. The old
`#section...` anchor ids may be dropped; the masthead index replaces in-page jumping.

Views render only when their data exists — a view with no data shows the styled empty-state
note instead of blank scaffolding; its nav entry stays visible but muted with "no data yet".

Sections/views (each serif-headed with hairline rules):

1. **What changed in pricing** — latest diff (last entry of `diffs`): four stat tiles (items
   changed / added / retired / median change %), then a per-category table (category, n changed,
   median %, added, retired) with a compact SVG dot-strip per row showing the distribution of
   `pct` values; then collapsible lists of added and retired items. A release picker
   (`<select>`) switches which diff is shown; default latest.
2. **Price history explorer** — search input filtering `items` by number/name/category
   (show max 50 matches); selecting an item draws a step-line SVG of `history` across
   `releases` (x = effective dates, y = dollars, `spread` drawn as a band when present, nulls
   break the line), with a data table twin (release, price, Δ%) under a `<details>` for
   accessibility. Pin up to 3 items for comparison (lines distinguished by dash pattern +
   direct labels, not colour alone). If `context.cpi` exists, an optional "overlay CPI" checkbox
   draws the CPI series indexed to the item's first visible price; label it "CPI, All groups
   (indexed)".
3. **The law** — vertical timeline (newest first) merging `law.act_versions` (compilation
   points), `law.titles` filtered to `collection` Act + LegislativeInstrument registered in the
   last 3 years, and feed items of type `bill`/`law` (deduped by URL). Each entry: date, type
   chip, name, status, source link. A callout card (from feed data, not hardcoded) highlights
   any items whose title/summary mention pricing determination powers.
4. **Updates** — the feed, newest first, grouped by month heading. Item: date, type chip
   (`hearing`/`report`/`audit`/… each with an emoji + word), title (link, `rel="noopener"`,
   new tab), summary if present, publisher. `auto` items get a subtle "via official feed"
   micro-badge; `confirmed` items get the same "✓ source-checked" badge as the main app.
   Type-filter chips at the top of the section (`aria-pressed`, same interaction as main app's
   tag chips).
5. **Scheme in numbers** — from `context`: stat tiles (latest quarterly payments total,
   participants; ABS census-assistance count; SDAC prevalence — labelled exactly per
   context.json, never conflated), a small bar/line for `by_quarter` payments, and a
   "Next data" list from `next_data` (label + due date).

### Consolidation widgets (all data-driven, all optional, methods printed)

Every widget: renders only when its data exists; broadsheet styling (hairline modules, serif
figures, no dashboard cards); charts get printed values + a table twin or printed list;
each widget ends with a small muted **method footnote** stating exactly what was computed.
No valence colour (neutral washes + blue ramp only). All maths in `web/ndis.js` from
`window.NDIS` — never precomputed prose, never hardcoded numbers.

- **W-A "The real price of care"** (inside §1, after the diff table): small-multiples grid,
  one cell per support category present in ≥2 releases. Per category: for items priced in both
  the category's earliest and latest release, take each item's price ratio (last/first);
  category nominal change = median ratio − 1. CPI change over the same date span =
  cpi(last effective)/cpi(first effective) − 1 (nearest quarter). Real-terms change =
  (1+nominal)/(1+cpi) − 1. Cell: category name, a two-line mini index chart (item median vs
  CPI, dash-distinguished, ink-coloured), printed nominal and real figures. Sort by real
  change ascending (worst first). Footnote states the median-ratio method and item counts.
  Skip categories with <5 qualifying items (footnote says so).
- **W-C "Your supports, repriced"** (inside §2, under the explorer chart): uses the SAME
  pinned items as the explorer. For each pinned item, % change from the first to the last
  release it is priced in; basket figure = equal-weighted mean of those changes, with the
  matching CPI change over each item's own span averaged the same way. Output: one serif
  figure pair ("Your items: +2.1% · CPI over the same spans: +11.2%") + per-item contribution
  rows (name, span, item %, thin magnitude bar). Footnote: equal-weighted, per-item spans.
- **W-B "Where the money goes"** (new §, after §2): editorial board from
  `context.payments_by_category`: one row per category sorted by payments desc — payments
  (compact $), participants, avg per participant, and (joined via `catalogue_category`) the
  latest diff's `median_pct` for that category ("—" when unmapped). Proportional payments bar
  per row (ramp blue, printed value). Header states the 12-month window explicitly.
- **W-D "Your electorate"** (inside §5): `<input>` with `<datalist>` of electorate names →
  selected: printed need count, rank among all divisions, and a distribution strip (all ~150
  divisions as 2px ink ticks on a hairline axis, selected division a labelled dot). Note under
  it: Census "core activity need for assistance" definition caveat + NDIS ≠ census-need. The
  full sorted list is available under a `<details>` table twin.

Footer: methodology (how the diff is computed, geography normalisation note, "state price
spread shown as a band"), disclaimer, source list, link back to the main app, and the same
"summaries paraphrase cited sources — always check the link" line.

Accessibility: identical bar to app-spec §accessibility — real tables or table twins for every
chart, printed values, keyboard path everywhere, `prefers-reduced-motion`, AA in both themes.
State object: `{theme, diffRelease, search, pinned:[], feedTypes:Set, cpiOverlay}`; render from
`window.NDIS`; `esc()` all data strings; no globals beyond `window.NDIS`.

## CI (Builder A)

- `pages.yml`: add `node scripts/ndis/validate.mjs` after the existing validate (tolerant: skip
  if `data/ndis/ndis.json` absent), and stage `dist/ndis.html` into `_site/` when built.
- `ndis-refresh.yml`: `workflow_dispatch` + weekly cron (Mon 22:00 UTC ≈ Tue 08:00 AEST). Steps:
  checkout (with `contents: write`), setup node, run `fetch-law`, `fetch-context`,
  `fetch-feeds`, `fetch-catalogue` (each `continue-on-error: false` but individually
  soft-failing per §fetch rules), then `derive` + `validate`; if `git status --porcelain` shows
  changes in `data/ndis/`, commit as
  `spheric <2698271+spheric@users.noreply.github.com>` with message
  `ndis: scheduled data refresh` and push (push to main triggers the Pages deploy). Never
  commit if validation fails.

## Ingestion skill (.claude/skills/ingest-ndis-update/SKILL.md)

Frontmatter `name: ingest-ndis-update`, description: "Ingest an NDIS update (pricing release,
hearing, bill, report, news URL, or local catalogue file) into data/ndis — fetch, verify,
merge, derive, validate, rebuild". Instructions: (1) classify the input (catalogue file/URL →
`ingest-file.mjs` or `fetch-catalogue.mjs`; anything else → a feed item); (2) for feed items,
fetch the source URL, verify the claim, write a `confirmed` item with ≤40-word neutral summary
per the feed.json shape — never invent URLs, never editorialise; (3) promote any `auto` items
being confirmed (add summary, flip to `confirmed`); (4) run `derive` → `validate` →
`node scripts/build.mjs`; (5) report a diff summary. Mirrors the accuracy rules of
`ingest/prompts/extract.md`.

## Seeding scope (v1, after builders finish)

- Snapshots: the **latest catalogue of each financial year 2019-20 → 2026-27** (8 releases,
  from the archive page; CSV variants exist for 2019-20/2020-21, XLSX for all). Mid-year
  releases are out of scope for v1 except the current year's latest.
- law.json + context.json: script-generated, current.
- feed.json: seeded by research agents covering **the last 18 months** of NDIS-significant
  events (bills + second readings, JSC/estimates hearings with NDIS content, quarterly report
  releases, ANAO audits, pricing releases/APR, major ministerial announcements, Commission
  actions) — every item `confirmed` with a fetched-and-checked source, per the accuracy rule.

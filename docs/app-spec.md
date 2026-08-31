# Common Ground — build spec

Single source of truth for the app, data pipeline, and build. Two builders work from this file:
**Builder A** (scaffold: schema, scripts, ingest docs, README) and **Builder B** (web app).
The file sets a contract — where the two meet (tokens, file paths, data shape), follow it exactly.

## What this product is

A non-partisan comparison of Australian federal party policy positions (Labor, Coalition, Greens,
One Nation) built for ordinary people: a **matrix** view (issues × parties), an **overlap** view
(Venn diagram + agreement heatmap), and an **impact filter** ("I'm a renter with kids — what
affects me?"). Core promise: **every position is verified and cited** — nothing appears without a
source link, and unverifiable positions are shown as "No clear position", never guessed.

Principles, in priority order: accuracy → neutrality → accessibility → ease of use → beauty.

## Repo layout

```
data/dataset.json          # the real dataset (produced by research pipeline; may not exist yet)
data/dataset.sample.json   # small fixture, shape-identical — use for dev when dataset.json absent
data/schema/dataset.schema.json  # JSON Schema (draft 2020-12) for the dataset
docs/app-spec.md           # this file
ingest/README.md           # how ingestion works (see "Ingestion pipeline")
ingest/sources.md          # registry of sources per party
ingest/prompts/extract.md  # the extraction/normalisation prompt template
.claude/skills/ingest-policy-source/SKILL.md  # Claude Code skill: ingest a new source
scripts/validate.mjs       # dataset validator (zero deps)
scripts/build.mjs          # single-file bundler (zero deps)
scripts/tvfy/fetch.mjs     # They Vote For You API → data/tvfy/records.json (party aggregates)
scripts/tvfy/fetch-divisions.mjs  # TVFY division rolls → data/tvfy/divisions.json (per-division party tallies)
scripts/tvfy/apply.mjs     # mapping + records + divisions → issue.voting blocks (incl. series) in data/dataset.json
scripts/tvfy/util.mjs      # shared helpers (party classification, .env key, JSON io)
data/tvfy/mapping.json     # HAND-VERIFIED issue → TVFY policy mapping (never generated)
data/tvfy/records.json     # generated TVFY party voting aggregates (fetch.mjs output)
data/tvfy/divisions.json   # generated per-division party vote tallies (fetch-divisions.mjs output)
web/index.html             # app shell TEMPLATE with injection tokens
web/style.css              # all styles
web/app.js                 # all behaviour
dist/index.html            # built standalone file (open directly in a browser)
dist/artifact.html         # built body-only variant (for claude.ai artifact publishing)
```

Zero npm dependencies anywhere. Node ≥ 18, ESM (`.mjs`). No network requests at runtime — the
built file is fully self-contained (no CDNs, no webfonts, no remote images; emoji + inline SVG only).

## Data model

See `data/dataset.sample.json` for the canonical shape. Summary:

- `meta`: `title`, `subtitle`, `as_of` (ISO date), `jurisdiction`, `disclaimer`, `methodology`.
- `parties[]`: `id` ∈ `labor|coalition|greens|one_nation`, `name`, `short`, `abbr`, `leader`,
  `role` (Government/Opposition/Crossbench), `color_light`, `color_dark` (hex).
- `stances[]`: fixed four: `supports`("For","✓"), `opposes`("Against","✕"), `mixed`("Mixed","±"),
  `no_position`("No clear position","—").
- `impact_tags[]`: `id`, `label`, `emoji` (20 tags, see sample).
- `topics[]`: `id`, `label`, `issues[]`. Each issue: `id`, `label`, `question` (neutral yes/no;
  `supports` = yes), `positions[]` — exactly one per party, each with `party`, `stance`, `summary`
  (≤40 words), `impacts[]` (tag ids), `impact_note` (≤30 words), `confidence` ∈ high|medium|low,
  `verified` ∈ confirmed|corrected|unverified, `sources[]` (`title`, `url`, optional `date`,
  `publisher`). `sources` may be empty ONLY when stance is `no_position`.
- Issues may optionally carry `voting` — parliamentary voting records from They Vote For You
  (TVFY, theyvoteforyou.org.au; data under the Open Data Commons ODbL): `as_of` (ISO date),
  `records[]` of 1–2 entries, each `{policy_id, polarity ∈ 1|-1, strength ∈ direct|related,
  note, name, description, url, provisional, divisions_total, houses{representatives,senate},
  first_division_date, last_division_date, parties{labor|coalition|greens|one_nation:
  {members, voted, for, against, mixed, median_agreement, mean_agreement}}}`.
  `description` is a TVFY policy PROPOSITION; the party numbers are votes on that proposition,
  not on the issue question directly — the UI must always show the proposition beside the
  numbers. `polarity -1` = agreeing with the proposition means answering NO to the issue
  question. Counts cover CURRENT federal members only; TVFY `not_enough` members are excluded
  from `voted`. `voting` is written exclusively by `scripts/tvfy/apply.mjs` from
  `data/tvfy/mapping.json` (hand-verified — every mapping checked against the issue question,
  proposition text, polarity, division recency, and misleading-proxy risk; generic proxies that
  could contradict a party's stated stance on the specific question are rejected) and
  `data/tvfy/records.json` (generated by `scripts/tvfy/fetch.mjs`; reads `TVFY_API_KEY` from
  env or repo-root `.env`).
- Each voting record also carries `series[]`: the policy's parliamentary divisions in
  chronological order — `{date, house ∈ representatives|senate, name (verbatim division title),
  policy_vote ∈ aye|no, parties{<four ids>: {for, against}}, other{for, against}}` — where
  `for`/`against` are per-party member tallies from the division's per-member roll, already
  oriented to the proposition (the aye/no flip via `policy_vote` is applied upstream). Member
  party is the party AT THE TIME of the division (historical accuracy). Tallies come from
  `data/tvfy/divisions.json`; TVFY's declared division totals can differ from the roll by 1–2
  votes (Hansard-vs-roll variance) — both figures are stored there, party numbers always from
  the roll. Refresh flow: `node scripts/tvfy/fetch.mjs && node scripts/tvfy/fetch-divisions.mjs
  && node scripts/tvfy/apply.mjs && node scripts/validate.mjs && node scripts/build.mjs`.

### scripts/validate.mjs (Builder A)

`node scripts/validate.mjs [path]` (default `data/dataset.json`, fall back to sample with a
warning if missing). Checks, each reported with a clear line, exit 1 on any failure:
unique party/topic/issue/tag ids · exactly one position per party per issue, all four parties
present · stance/confidence/verified enums · impacts ⊆ tag ids · non-`no_position` positions have
≥1 source with an `http(s)` URL · summaries ≤ 350 chars · questions end with `?` · hex colors
valid · optional `voting` blocks well-formed where present (polarity/strength enums, TVFY policy
URL matches policy_id, exactly four party keys, for+against+mixed === voted ≤ members,
median_agreement null or 0–100) · counts summary printed on success (topics, issues, positions,
sources, % verified, voting coverage).

### scripts/build.mjs (Builder A)

`node scripts/build.mjs [datasetPath]` (same default/fallback). Steps:
1. Read `web/index.html`, `web/style.css`, `web/app.js`, dataset JSON.
2. Escape the JSON for inline embedding: `JSON.stringify(data).replace(/<\//g, '<\\/')`.
3. Replace tokens in the template (each on its own line):
   - `<!--__CSS__-->`  → `<style>…style.css…</style>`
   - `<!--__DATA__-->` → `<script>window.DATASET = …escaped json…;</script>`
   - `<!--__JS__-->`   → `<script>…app.js…</script>`
4. Write `dist/index.html` (the full document).
5. Write `dist/artifact.html`: everything between `<!--__BODY_START__-->` and `<!--__BODY_END__-->`
   in the assembled output, prefixed with `<title>Common Ground — Australian party policies, compared</title>`
   and the same `<style>`/`<script>` blocks in this order: title, style, body content, data script,
   app script. (The artifact host supplies its own doctype/html/head/body wrapper.)
6. Print output paths + byte sizes.

### web/index.html (Builder B)

A complete standalone document containing, in order: doctype, `<html lang="en">`, head with
charset/viewport/`<title>`/`<meta name="color-scheme" content="light dark">`, the `<!--__CSS__-->`
token in head, then body wrapping all content between `<!--__BODY_START__-->` and
`<!--__BODY_END__-->` markers, then `<!--__DATA__-->` and `<!--__JS__-->` tokens before
`</body>`. `app.js` must not contain the literal substring `</script`.

## Web app spec (Builder B)

### Design direction — "civic broadsheet"

An editorial, newspaper-of-record feel: calm paper surfaces, hairline rules, a serif masthead,
disciplined data typography. Distinctive through restraint and typographic character — never
loud, never partisan. This is a reference document people should trust at a glance.

- **Typography** (no webfonts — CSP): display/masthead + topic headers in a characterful serif
  stack: `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`; everything data-ish
  (chips, cells, labels, numbers) in `system-ui, -apple-system, "Segoe UI", sans-serif`.
  Masthead large (clamp ~2.2–3.4rem), tight tracking; a hairline double-rule under the masthead
  (classic newspaper). `tabular-nums` only in the heatmap/table numbers.
- **Surfaces & ink** (CSS custom properties, from the validated dataviz chrome):
  light: page `#f9f9f7`, card/surface `#fcfcfb`, primary ink `#0b0b0b`, secondary `#52514e`,
  muted `#898781`, hairline `#e1e0d9`, border ring `rgba(11,11,11,0.10)`;
  dark: page `#0d0d0d`, surface `#1a1a19`, primary `#ffffff`, secondary `#c3c2b7`, muted
  `#898781`, hairline `#2c2c2a`, ring `rgba(255,255,255,0.10)`.
- **Party colours** (CVD-validated; colour follows the party entity, never repainted):

  | party | light | dark |
  |---|---|---|
  | labor | `#C8102E` | `#E85550` |
  | coalition | `#1F5BAA` | `#5E93EE` |
  | greens | `#00693C` | `#1E8552` |
  | one_nation | `#F68B33` | `#D9761C` |

  Column order everywhere: Labor, Coalition, Greens, One Nation. Party colour is used ONLY as
  thin accents (3px header underline, venn stroke, drawer card left border, 12% fills) — never
  large saturated blocks, and **never without the party name in text beside it**.
- **Theme**: light + dark both fully designed. Auto via `@media (prefers-color-scheme: dark)`
  scoped `:root:not([data-theme="light"])`, plus explicit `:root[data-theme="dark"]` and
  `:root[data-theme="light"]` overrides (the artifact host stamps `data-theme` on the root and
  it must win both ways). A small toggle in the header cycles auto→light→dark; persist choice in
  `localStorage` wrapped in `try/catch`; the toggle sets `data-theme` on `<html>`.
- **Motion**: one orchestrated load — masthead rule draws in, matrix rows fade/rise with ~20ms
  stagger (CSS only). Micro: chip hover lift, drawer slide. Everything inside
  `@media (prefers-reduced-motion: no-preference)`.

### Layout

Header (masthead, subtitle, "Verified · as of {meta.as_of}" note, theme toggle) → **one filter
row** that scopes every view (dataviz rule: filters above, never inside chart cards) → view
tabs → active view → footer (methodology, disclaimer, total source count, "summaries paraphrase
cited sources — always check the link").

**Filter row**: (1) "Show what affects…" impact-tag multi-select — emoji+label chips, toggleable,
with a clear-all; (2) free-text search over issue label/question/summaries; (3) active-filter
count + reset. Filters apply to Matrix AND Overlap (both recompute against the filtered issue
set). When filters are active show "N of M issues shown".

### View 1 — Matrix (default)

A real `<table>` per topic (semantic: `<th scope="col">` party headers with colour underline +
short name + role tag; `<th scope="row">` issue label). Sticky table header on scroll; the whole
matrix area scrolls horizontally inside its own container on narrow screens (page body never
scrolls horizontally). Topic headers are serif section headings with hairline rules.

Cells: stance chip — symbol + word (e.g. "✓ For"), tinted wash background, never colour alone:
For = green wash (`#0ca30c` at ~14% over surface, ink text), Against = red wash (`#d03b3b` ~14%),
Mixed = amber wash (`#fab219` ~16%), No clear position = ghost (transparent, muted ink, dashed
hairline border). Washes are backgrounds behind full-strength ink text — AA contrast maintained.
Confidence `low` renders a superscript "?" on the chip with a tooltip "low confidence — see
sources". 2px surface gaps between cells (border-spacing), thin marks, no heavy fills.

Whole cell is a `<button>` (min 44px tall) opening the **detail drawer**: right-side panel
(bottom sheet <720px) titled with the issue label + question, then four party cards in fixed
order: party name (colour left-border), stance chip, summary, "What it means for you:"
impact_note, impact tag chips, confidence + verified badge ("✓ source-checked" for
confirmed/corrected), and source links — `title (publisher, date)` opening in new tab with
`rel="noopener"`. Esc / backdrop click / close button dismisses; focus moves into the drawer on
open and returns to the cell on close; `role="dialog"` + `aria-modal`.

Row-level affordance: issue `<th>` shows the question in smaller muted text under the label, and
lists the impact emoji for the union of tags across positions (title tooltip with labels).

### Voting records in the UI (issues with `voting`)

Three surfaces, all strictly neutral — the app never editorialises or derives agree/disagree
verdicts; the say/vote juxtaposition speaks for itself:

- **Drawer section "In Parliament — how they voted"** after the four party cards: one card per
  record — the TVFY proposition quoted (italic serif) with tags (`related vote` when strength
  is related, `draft policy` when provisional), an explicit reversal note when `polarity` is
  -1, the verifier `note`, then four party rows (fixed order, party name printed beside any
  colour): a segmented for/mixed/against bar (decorative, `aria-hidden`, stance wash colours)
  with ALL counts printed as text plus median agreement, or "not enough voting data" when
  `voted` is 0; a meta line (divisions, houses, date range, TVFY source link, new tab,
  `rel="noopener"`); a footer with the aggregation method + ODbL attribution + `as_of`.
- **View 3 — Votes** (third tab): filtered issues that have voting, grouped by topic; per issue
  a card (header opens the drawer) showing per record the proposition + tags + polarity note
  and a compact four-party grid juxtaposing the STATED stance chip ("Say") with the voting bar
  and printed `F/A/M of voted` counts ("Voted"); legend and methodology intro at top, ODbL
  attribution footer. Filters/search apply exactly as in Matrix/Overlap.
- **Matrix row glyph** 🗳 (with title/aria-label) on issues that have a voting record, and a
  footer attribution paragraph linking They Vote For You whenever any issue has voting.
- **Vote trail** on every record (full-size in the drawer, compact in Votes cards): an
  `aria-hidden` SVG timeline — one hairline-midline lane per party, one mark per division,
  direction encoded by POSITION (mark above the midline = the party's members mostly voted for
  the proposition, below = against, diamond on the line = split, faint dot = fewer than two
  members voting). Position is the primary channel because the green/red pair fails
  deuteranopia; colour only reinforces. Every mark carries a `<title>` tooltip (date, house,
  division name, counts); a `<details>` "All N divisions" table is the accessible/touch twin.
- **View 4 — Over time** (fourth tab): computed over the divisions of the issues currently
  shown, deduplicated. (a) Pair-agreement chart: pick exactly two parties (chip picker,
  default Labor + Coalition); a single ink-coloured step line of yearly same-side %, drawn
  only for years with ≥3 qualifying divisions (both parties ≥2 voters, definite majorities),
  hollow points under 6; selective direct labels, hover tooltips with raw counts, table twin.
  Never a party colour for a pair line; no legend (single series). (b) Position shifts: a
  mechanically-detected list (≥6 qualifying divisions, two consecutive same-direction
  divisions at each end, first-sustained ≠ last-sustained), neutral fixed template, the rule
  printed verbatim beneath, "View issue" buttons into the drawer. No editorial framing.
- **Attribution-method note** (drawer + Over time footers): timeline marks use the party each
  member sat with AT THE TIME of each division; member counts and TVFY medians follow current
  members, excluding members whose votes on a policy were cast while sitting with a different
  party (`excluded_switchers` in the data — deterministic rule, see pipeline).

### View 2 — Overlap

Top: party picker — the four party chips, pick any 2 or 3 (default Labor+Coalition+Greens;
picking a 4th replaces the oldest selection, with a hint).

**Venn**: inline SVG, 2 or 3 circles (fixed classic layout, 120° for 3), stroke 2px in party
colour, fill party colour at 12%, party name + short count labelled OUTSIDE each circle in ink.
Region counts are HTML `<button>`s absolutely positioned over region centres (≥44px hit area,
focusable, `aria-label` like "Labor and Greens agree, 12 issues"). An issue lands in a region as
follows: among the SELECTED parties only, group their stances on that issue (ignoring
`no_position` — those parties simply don't participate); every maximal same-stance group of ≥2
parties puts the issue in that combination's region; a party whose stance no selected party
shares contributes the issue to its solo region. Clicking a region filters the **region list**
below the venn — which is always rendered (the accessible/table twin): grouped headings
("All three agree · 14", "Labor + Greens only · 9", …) each listing issue label + the shared
stance chip + topic tag; every item clickable → same detail drawer.

**Agreement heatmap**: 4×4 half-matrix "How often do they vote the same way here?" — % of
issues where both parties hold the same definite stance (both non-`no_position`); printed % in
every cell (`tabular-nums`), sequential blue ramp light→dark from the validated ramp
(`#cde2fb → #0d366b` light mode; for dark mode use the same hues, cell text switches to white
above ~step 450; pick ~5 discrete bins, not a continuous ramp), tooltip with the raw counts
("agree on 12 of 19 issues both have positions on"). Row/col headers are party names. Diagonal
is blank. Note under it: "Counted across issues currently shown by your filters."

### Empty/edge states

Filters matching zero issues → friendly empty state with a reset button. A selected-party pair
sharing zero definite stances → venn region shows 0 (still a button, disabled style). Dataset
missing → the shell renders with a "no data — run the pipeline" note (build falls back to sample).

### Accessibility (non-negotiable)

Meaning never colour-alone (symbol+word chips, labelled venn buttons, printed heatmap numbers).
AA contrast for all text in both themes. Full keyboard path: tabs, chips, cells, venn regions,
drawer (trap + restore). `aria-pressed` on filter chips, `aria-selected` on tabs,
`prefers-reduced-motion` respected, focus-visible rings (2px, ink colour). The matrix is a real
table; the region list mirrors the venn; heatmap values are printed.

### Implementation notes

Vanilla JS, no framework. Render from `window.DATASET`. Keep state in one object
(`{view, tags:Set, search, drawer, vennParties, vennRegion, theme}`); re-render views from state
(simple innerHTML rebuild is fine at this scale, but preserve focus where reasonable). Escape all
dataset strings inserted into HTML (one `esc()` helper — dataset is trusted-ish but sources/titles
come from the web). ~200 issues max; no perf concerns. Code style: small pure helpers, one file,
section comments, no globals beyond `window.DATASET`.

## Ingestion pipeline (Builder A — docs + skill only)

The pipeline is **agent-native**: ingestion = running a documented Claude Code skill, not brittle
scrapers. `ingest/README.md` explains the flow; `ingest/sources.md` lists per-party official
sources (party platform pages, ministers' media release pages, aph.gov.au, and the main
policy-tracker pages of ABC/Guardian) with reliability notes; `ingest/prompts/extract.md` is the
normalisation prompt (mirror the research rules: neutral yes/no questions, supports=yes polarity,
≤40-word summaries, fixed impact tags, 1–3 verified sources per position, never invent URLs,
`no_position` over guessing).

`.claude/skills/ingest-policy-source/SKILL.md` (frontmatter: `name: ingest-policy-source`,
`description: Ingest a policy source (URL or file) into data/dataset.json — fetch, extract,
verify, merge, validate, rebuild`): instructs the agent to (1) fetch the source, (2) extract
positions using `ingest/prompts/extract.md`, (3) verify each claim's source URL by fetching it,
(4) merge into `data/dataset.json` — match existing issue ids where the issue is the same,
update stance/summary/sources when the new source is more recent, append new issues to the right
topic, bump nothing else, (5) run `node scripts/validate.mjs`, (6) run `node scripts/build.mjs`,
(7) report a diff summary of changed positions.

## README.md (Builder A)

Plain-English: what this is, the accuracy promise, quickstart (`node scripts/build.mjs` then open
`dist/index.html`), how to update data (the skill), repo map, data model in brief, disclaimer.
No badges, no fluff.

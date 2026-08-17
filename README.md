# Common Ground

A non-partisan, side-by-side comparison of Australian federal party policy positions (Labor,
Coalition, Greens, One Nation) — a matrix view, an overlap/agreement view, and a filter for how a
policy affects you personally.

**Live: <https://spheric.github.io/common-ground/>** — rebuilt automatically from
`data/dataset.json` on every push.

## The accuracy promise

Every position shown is either cited or explicitly marked as unknown. Nothing is guessed:

- Every position that isn't "No clear position" links to at least one source that was
  independently fetched and checked to confirm it actually supports the stated claim.
- Where no clear, verifiable position exists, the app says so — **"No clear position"** — instead
  of inferring one from a party's general ideology or past behaviour.
- Summaries are paraphrases of the cited sources, not the sources themselves. Always check the
  link before repeating a claim.

Principles, in priority order: **accuracy → neutrality → accessibility → ease of use → beauty.**

## Quickstart

```
node scripts/build.mjs
open dist/index.html
```

That's it — no install step, no dependencies. `dist/index.html` is a single self-contained file;
it also opens fine from a `file://` URL. If `data/dataset.json` doesn't exist yet, the build falls
back to `data/dataset.sample.json` (a small fixture) so the app always has something to render.

`dist/artifact.html` is a body-only variant of the same build, for publishing to claude.ai as an
Artifact.

## Updating the data

Data isn't hand-edited or scraped — it's produced by an agent-native ingestion pipeline: a
documented Claude Code skill that fetches a source, extracts positions, verifies every source URL
by fetching it, merges the result into `data/dataset.json`, validates, and rebuilds. See
[`ingest/README.md`](ingest/README.md) for the full flow, [`ingest/sources.md`](ingest/sources.md)
for where to look per party, and the skill itself at
[`.claude/skills/ingest-policy-source/SKILL.md`](.claude/skills/ingest-policy-source/SKILL.md).

To check the current dataset without changing anything:

```
node scripts/validate.mjs
```

## Repo map

```
data/dataset.json                # the real dataset (produced by the ingestion pipeline; may not exist yet)
data/dataset.sample.json         # small fixture, shape-identical — used for dev when dataset.json is absent
data/schema/dataset.schema.json  # JSON Schema (draft 2020-12) for the dataset
docs/app-spec.md                 # the build spec — source of truth for data model, app, and pipeline
ingest/README.md                 # how ingestion works
ingest/sources.md                # per-party source registry with reliability notes
ingest/prompts/extract.md        # the extraction/normalisation prompt template
.claude/skills/ingest-policy-source/SKILL.md  # the Claude Code skill that runs the pipeline
scripts/validate.mjs             # dataset validator (zero dependencies)
scripts/build.mjs                # single-file bundler (zero dependencies)
web/index.html, web/style.css, web/app.js  # the app source
dist/index.html                  # built standalone file — open directly in a browser
dist/artifact.html               # built body-only variant — for claude.ai artifact publishing
```

## Data model, briefly

A dataset has `meta` (title, subtitle, as-of date, disclaimer, methodology), the four `parties`,
the four fixed `stances` (For / Against / Mixed / No clear position), a fixed vocabulary of
`impact_tags`, and `topics[]` each containing `issues[]`. Every issue has a neutral yes/no
`question` and exactly one `position` per party: a `stance`, a ≤40-word `summary`, `impacts`
(tag ids), an `impact_note` ("what this means for you"), `confidence`, `verified` status, and
`sources[]` — which may be empty only when the stance is `no_position`. Full shape:
[`data/schema/dataset.schema.json`](data/schema/dataset.schema.json); canonical example:
[`data/dataset.sample.json`](data/dataset.sample.json).

## Disclaimer

Independent and non-partisan. Positions are paraphrased from cited public sources and may change —
always check the linked source. Not affiliated with any political party.

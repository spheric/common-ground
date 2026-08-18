---
name: ingest-ndis-update
description: Ingest an NDIS update (pricing release, hearing, bill, report, news URL, or local catalogue file) into data/ndis — fetch, verify, merge, derive, validate, rebuild
---

# Ingest an NDIS update

Turns one NDIS update — a new Support Catalogue release, a hearing, a bill event, a report, an
audit, a ministerial announcement, or a local catalogue file — into verified updates under
`data/ndis/`. See `docs/ndis-spec.md` for the full data model, fetch rules, and page spec.
Accuracy beats coverage: at every step, prefer doing nothing over guessing. Mirrors the accuracy
rules of `ingest/prompts/extract.md` (neutral, source-checked, never invented).

## Inputs

Ask the user for (or infer from the conversation):
- The input: a URL, a local file path, or a description of the update to research and cite.

## Steps

1. **Classify the input.**
   - A Support Catalogue URL or local `.xlsx`/`.csv` file → go to step 2 (catalogue path).
   - Anything else (a hearing, bill event, report, audit, announcement, or dataset release) →
     go to step 3 (feed item path).

2. **Catalogue path.**
   - Local file: run `node scripts/ndis/ingest-file.mjs <path> [--source-url=<official URL if known>]`.
   - A live URL on `ndis.gov.au`: try `node scripts/ndis/fetch-catalogue.mjs` first — if it
     reports `blocked: ...` (Cloudflare), download the file yourself (browser or a URL the user
     supplies) and fall back to `ingest-file.mjs`.
   - Confirm the printed item count and release id look sane, then go to step 4.

3. **Feed item path.**
   - Fetch the source URL in full and read it — do not rely on a title or snippet alone.
   - Verify the claim the item is meant to represent is actually supported by that page's content.
   - Write a `confirmed` item into `data/ndis/feed.json` per the shape in `docs/ndis-spec.md`
     (`id` = `<date>-<slug>`, unique; `type` ∈ `pricing | law | bill | hearing | report | audit |
     announcement | data`; `summary` ≤ 40 words, neutral, paraphrasing only; `source.title`/
     `source.url`/`source.publisher` from the page you actually fetched). Never invent a URL,
     date, or publisher. If the claim can't be verified, don't add it — say so instead.
   - **Promoting an `auto` item**: if this update matches an existing `auto` item (machine-imported
     by `fetch-feeds.mjs`, title verbatim, no summary), fetch its `source.url`, verify it, add a
     compliant `summary`, and flip `verified` to `confirmed` in place — don't create a duplicate
     entry. Leave every other `auto`/`confirmed` item in the file untouched.
   - `data/ndis/feed.json` may be edited concurrently by other agents/sessions — re-read it
     immediately before writing so your change merges with, rather than clobbers, anything that
     landed since you last read it.

4. **Derive.** Run `node scripts/ndis/derive.mjs` to rebuild `data/ndis/ndis.json` from the
   current `data/ndis/snapshots/*.json` + `law.json` + `feed.json` + `context.json`.

5. **Validate.** Run `node scripts/ndis/validate.mjs`. If it fails, fix the underlying data (not
   the validator) and re-run steps 4–5 until it passes.

6. **Rebuild.** Run `node scripts/build.mjs` so `dist/ndis.html` reflects the update (it also
   rebuilds the main app's `dist/index.html` — that's expected and harmless).

7. **Report a diff summary.** State plainly what changed: new/updated snapshot and its item
   count, new law entries, feed items added or promoted from `auto` to `confirmed` (with their
   sources), and any candidate that was dropped for lacking a verifiable source. One line per
   change — keep it scannable.

## Non-negotiables

- Never fabricate a source URL, date, publisher, or price.
- Never mark a feed item `verified: confirmed` without actually fetching and checking its cited
  source during this run.
- `auto` items never get a `summary` — only `confirmed` items may have one, and only after
  verification.
- Don't touch `web/`, `data/dataset.json`, `docs/app-spec.md`, `docs/ndis-spec.md`, or
  `scripts/validate.mjs`/`scripts/build.mjs`'s main-app logic — this skill only edits
  `data/ndis/*` (and, via the build step, regenerates `dist/`).

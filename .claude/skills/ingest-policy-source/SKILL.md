---
name: ingest-policy-source
description: Ingest a policy source (URL or file) into data/dataset.json — fetch, extract, verify, merge, validate, rebuild
---

# Ingest a policy source

Turns one source (a URL from `ingest/sources.md`, or a local file) into verified, merged updates
to `data/dataset.json`. Accuracy beats coverage: at every step, prefer producing nothing (or
`no_position`) over a guess. See `docs/app-spec.md` for the data model and `ingest/README.md` for
the pipeline's ground rules.

## Inputs

Ask the user for (or infer from the conversation):
- The source: a URL or a local file path.
- Which party the source speaks for (`labor` | `coalition` | `greens` | `one_nation`), unless the
  source makes this unambiguous (e.g. a party's own platform page).

## Steps

1. **Fetch the source.** Retrieve the URL (or read the local file) in full. If it fails to load,
   report that and stop — do not proceed from a cached or remembered version of the page.

2. **Extract positions.** Load `ingest/prompts/extract.md`, fill in the source content, the party,
   and the current `topics`/`issues` from `data/dataset.json` (or `data/dataset.sample.json` if
   `dataset.json` doesn't exist yet), then run the extraction per that prompt's rules. This
   produces zero or more candidate position objects, each tagged with a topic/issue (existing or
   new).

3. **Verify each source URL.** For every URL the extraction step wants to cite in a position's
   `sources[]`, independently fetch it and confirm its content actually supports the stated
   position. Drop any source that doesn't fetch or doesn't support the claim; if a position ends
   up with zero verified sources and its stance isn't `no_position`, downgrade the stance to
   `no_position` (with `verified: unverified`) rather than keep an unsupported claim.

4. **Merge into `data/dataset.json`.**
   - If `data/dataset.json` doesn't exist yet, create it by copying `data/dataset.sample.json`'s
     structure (`meta`, `parties`, `stances`, `impact_tags`) and starting `topics` from scratch —
     do not carry over the sample's example.com placeholder data.
   - For each candidate: match against an existing `issue.id` (same underlying question) where
     possible. If found, replace that party's `position` entry within it — never leave two
     position objects for the same `(party, issue)` pair.
   - If the issue doesn't exist yet, append it to the matching `topic` (by `topic.id`); if the
     topic doesn't exist either, append a new topic.
   - Only touch positions/issues this source is about — don't modify unrelated entries, and don't
     touch `meta`, `parties`, `stances`, or `impact_tags` unless the source is specifically about
     one of those (e.g. a leadership change).
   - Update `meta.as_of` to today's date if any change was made.

5. **Validate.** Run `node scripts/validate.mjs`. If it fails, fix the merged data (not the
   validator) and re-run until it passes.

6. **Rebuild.** Run `node scripts/build.mjs` so `dist/index.html` and `dist/artifact.html` reflect
   the update.

7. **Report a diff summary.** List what changed: new issues added, positions added, positions
   updated (old stance/summary → new, with the reason), and any candidates that were dropped for
   lacking a verifiable source. Keep it scannable — one line per change.

## Non-negotiables

- Never fabricate a source URL, date, or publisher.
- Never mark a position `verified: confirmed` without actually fetching its cited source(s) during
  this run.
- `no_position` is a valid, common, and honest outcome — don't force a stance to avoid it.
- Don't touch `web/`, `docs/app-spec.md`, or the schema — this skill only edits `data/dataset.json`
  (and, via the build step, regenerates `dist/`).

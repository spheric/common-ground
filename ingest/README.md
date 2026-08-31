# Ingestion pipeline

Common Ground's data pipeline is **agent-native**: there is no scraper to maintain. Adding or
updating a policy position means running a documented Claude Code skill against a source, with a
human (or the agent, following strict rules) doing the reading, extraction and verification that a
brittle script can't be trusted to do accurately.

Accuracy is the top priority of this project, ahead of coverage or freshness. A missing or stale
position is fine — `no_position` exists exactly for this — but a wrong or unverifiable one is not.

## The flow

1. **Pick a source.** Use `ingest/sources.md` for the canonical list of official party pages,
   `aph.gov.au` (bills, Hansard, Parliamentary Library), and secondary policy-tracker pages (ABC,
   Guardian Australia). Prefer primary sources (the party's own platform or a minister's media
   release) over secondary reporting.
2. **Run the skill.** Invoke `.claude/skills/ingest-policy-source/SKILL.md` (`ingest-policy-source`
   in Claude Code) with the source URL or a saved file. The skill fetches the source, extracts
   candidate positions using the prompt in `ingest/prompts/extract.md`, verifies every source URL
   it's about to cite by fetching it directly, and merges the result into `data/dataset.json`.
3. **Validate.** The skill runs `node scripts/validate.mjs` after merging. A validation failure
   blocks the merge from being considered done — fix the data, don't relax the check.
4. **Rebuild.** The skill runs `node scripts/build.mjs` so `dist/index.html` and
   `dist/artifact.html` reflect the new data.
5. **Review the diff.** The skill reports which positions changed (new issue, new position,
   stance/summary/source change) so a human can sanity-check before the change is committed.

## Ground rules (apply to every extraction, human or agent)

- **Never invent a URL.** If a claim can't be backed by a source you (or the agent) actually
  fetched and read, the position is `no_position`, not a guess.
- **Neutral questions.** Every issue has a yes/no `question` phrased so `supports` = "yes". Loaded
  or leading phrasing is a bug.
- **Paraphrase, don't copy.** Summaries are ≤40 words, in your own words, describing what the
  party has said or done — not a quote, not spin.
- **One position per party per issue.** If a party has said contradictory things, that's `mixed`,
  not two entries.
- **Confidence and verification are honest, not optimistic.** `confidence: low` and
  `verified: unverified` are normal outcomes, not failures. Use `corrected` when a position update
  was needed because an earlier one was wrong or out of date.
- **Sources carry dates and publishers.** A source without a fetchable date is weaker evidence —
  note it, don't fabricate one.
- **`data/dataset.json` is the only pipeline output.** Nothing else in the repo is written by the
  pipeline; `dist/` is a build artifact, regenerated, never hand-edited.

## Where things live

| File | Role |
|---|---|
| `ingest/sources.md` | Registry of official/reputable sources per party, with reliability notes |
| `ingest/prompts/extract.md` | The extraction/normalisation prompt template used by the skill |
| `.claude/skills/ingest-policy-source/SKILL.md` | The Claude Code skill that runs the whole flow |
| `data/dataset.json` | The real dataset the pipeline writes to (git-tracked once it exists) |
| `data/schema/dataset.schema.json` | The shape `data/dataset.json` must satisfy |
| `scripts/validate.mjs` | The hand-rolled checker the skill runs after every merge |

## Manual runs

You don't need the skill to validate or rebuild by hand:

```
node scripts/validate.mjs data/dataset.json
node scripts/build.mjs data/dataset.json
```

Both default to `data/dataset.json` and fall back to `data/dataset.sample.json` if it doesn't
exist yet, so the app always has something to render during development.

## Parliamentary voting records (They Vote For You)

Issues can additionally carry a `voting` block: how current federal MPs and senators actually
voted in parliamentary divisions, sourced from **They Vote For You**
(theyvoteforyou.org.au, OpenAustralia Foundation; data under the Open Data Commons ODbL, reused
with attribution as their licencing page requests). This is the "say vs do" layer: stated
positions come from the ingestion pipeline above, voting records come from this one.

Three files drive it:

| File | Role |
|---|---|
| `data/tvfy/mapping.json` | **Hand-verified** issue → TVFY policy mapping. Never generated. |
| `data/tvfy/records.json` | Generated party-level aggregates (`scripts/tvfy/fetch.mjs` output) |
| `scripts/tvfy/` | `fetch.mjs` (API → records), `apply.mjs` (records + mapping → dataset), `util.mjs` |

Refresh flow (needs `TVFY_API_KEY` in the environment or a repo-root `.env`):

```
node scripts/tvfy/fetch.mjs      # re-fetch mapped policies + current members, rebuild records.json
node scripts/tvfy/apply.mjs      # write voting blocks into data/dataset.json
node scripts/validate.mjs        # voting blocks are validated like everything else
node scripts/build.mjs
```

Mapping ground rules (same accuracy-first bar as positions):

- A mapping is only added after checking the TVFY proposition text against the issue question,
  the polarity (does agreeing with the proposition mean YES or NO to our question?), division
  recency, and the party numbers themselves. `strength: "direct"` means essentially the same
  proposition; `"related"` means clearly relevant but not identical — the UI labels these.
- **No misleading proxies.** A generic proposition whose votes could contradict a party's stated
  stance on the specific question (e.g. broad "housing affordability" votes under a first-home
  buyer question) is rejected. An issue with no honest match simply has no voting block —
  24 of 63 issues are in that state, which is correct, not a gap to fill.
- Policies with no divisions, or where no current member has enough voting data, are never mapped.
- TVFY "provisional" (draft) policies are mapped only when they are the exact proposition with
  real division data, and the UI badges them as draft.

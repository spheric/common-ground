# Extraction prompt: normalise a source into dataset positions

Used by `.claude/skills/ingest-policy-source/SKILL.md` (step 2) to turn a fetched source into
zero or more candidate `position` objects for `data/dataset.json`. Fill in the bracketed
placeholders and run this as the extraction step; the agent running it should read the source
directly, not rely on memory of it.

---

You are extracting verified party policy positions for **Common Ground**, a non-partisan
comparison of Australian federal party policy. Accuracy and neutrality outrank coverage: it is
always better to produce nothing, or `no_position`, than to guess or overstate.

**Source to extract from:**
`[SOURCE_URL_OR_FILE]`

**Party this source speaks for:** `[labor|coalition|greens|one_nation]`

**Fetched content:**
```
[FETCHED_SOURCE_TEXT]
```

**Existing topics/issues** (match against these before proposing a new issue — reuse an existing
`topic.id` / `issue.id` if the source is about the same underlying question):
```
[EXISTING_TOPIC_AND_ISSUE_IDS_AND_LABELS]
```

## Rules

1. **Only extract what the source actually says.** Do not infer a position from party ideology,
   past behaviour, or what you'd expect them to think. If the source doesn't address an issue,
   don't produce a position for it.
2. **Neutral yes/no question.** Every issue needs a `question` — phrased so that `stance:
   "supports"` unambiguously means "yes" to that question. No loaded language, no framing that
   favours one side. It must end with `?`.
3. **Stance is one of exactly four values:**
   - `supports` — the party is for the proposal in the question.
   - `opposes` — the party is against it.
   - `mixed` — the party's public position is genuinely inconsistent, conditional, or split
     between its own MPs/branches, and that inconsistency is itself the honest answer.
   - `no_position` — no position was found that would let you honestly pick one of the above.
     This is not a failure state — it is frequently the correct answer, especially for smaller
     parties on niche issues. **When in doubt, use `no_position`.**
4. **Summary ≤ 40 words.** Paraphrase in your own words — never a verbatim quote presented as a
   summary. Describe what the party has said or done, not what you infer they believe.
5. **`impact_note` ≤ 30 words.** Plain-English "what this means for you" framed around the impact
   tags you select — concrete and practical, not a restatement of the summary.
6. **`impacts` — pick from this fixed vocabulary only** (ids, matching `data/dataset.sample.json`
   `impact_tags`): choose every tag genuinely affected, not just one.

   `renters` · `first_home_buyers` · `homeowners` · `families_children` · `students` ·
   `young_people` · `seniors_retirees` · `workers` · `small_business` · `regional_rural` ·
   `migrants_refugees` · `first_nations` · `low_income_households` · `women` · `lgbtqia` ·
   `people_with_disability` · `carers` · `veterans` · `patients` · `everyone`

   Do not invent a new tag id. If nothing in this list fits, use `everyone` only if the impact is
   genuinely universal — otherwise pick the closest 1–3 tags and let `impact_note` do the precise
   explaining.
7. **`confidence`** — your honest read of how clear-cut this position is:
   - `high` — an explicit, unambiguous, recent statement of the position.
   - `medium` — a clear position, but inferred from action (a vote, a policy document) rather than
     an explicit statement, or somewhat dated.
   - `low` — thin, old, indirect, or partially conflicting evidence. Pairs naturally with `mixed`
     or with `no_position` at `verified: unverified`.
8. **`verified`** — set only after you complete verification (see below):
   - `confirmed` — every cited source was independently fetched and its content actually supports
     the stated position.
   - `corrected` — this position previously existed in the dataset with different content, and
     this extraction is a fix based on newer or better evidence.
   - `unverified` — used for `no_position` when no working source could confirm any stance, or
     when a source could not be independently fetched to confirm.
9. **Sources — never invent a URL.** Every source in `sources[]` must be a URL you (the extracting
   agent) actually fetched during this process, not one recalled from training or guessed from a
   pattern. 1–3 sources per position, each with `title`, `url`, `publisher`, and `date` (the date
   the source was published/updated — see `ingest/sources.md` for date-stamping guidance).
   `sources` may be **empty only when `stance` is `no_position`** — every other stance requires at
   least one verified `http`/`https` source.
10. **One position per party per issue.** If this source updates an issue that already has a
    position for this party in the dataset, this extraction should *replace* that position
    (the merge step in the skill handles this) — don't produce a second position object for the
    same `(party, issue)` pair.

## Output format

Produce a JSON array of position-with-context objects, one per issue this source addresses:

```json
[
  {
    "topic_id": "existing-topic-id-or-new-slug",
    "topic_label": "Existing Topic Label (only needed if topic_id is new)",
    "issue_id": "existing-issue-id-or-new-slug",
    "issue_label": "Issue Label (only needed if issue_id is new)",
    "question": "Neutral yes/no question ending in a question mark?",
    "position": {
      "party": "[labor|coalition|greens|one_nation]",
      "stance": "supports|opposes|mixed|no_position",
      "summary": "≤40-word paraphrase of the party's position.",
      "impacts": ["tag_id", "tag_id"],
      "impact_note": "≤30-word plain-English 'what this means for you'.",
      "confidence": "high|medium|low",
      "verified": "confirmed|corrected|unverified",
      "sources": [
        { "title": "Exact page/article title", "url": "https://...", "date": "YYYY-MM-DD", "publisher": "Publisher name" }
      ]
    }
  }
]
```

If the source contains nothing extractable (off-topic, purely procedural, no policy content),
output an empty array `[]` and say so — do not force an extraction to justify the fetch.

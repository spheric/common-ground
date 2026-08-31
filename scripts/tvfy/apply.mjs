#!/usr/bin/env node
// Applies data/tvfy/records.json (They Vote For You aggregates) onto the
// dataset via data/tvfy/mapping.json, writing an `issue.voting` block onto
// every mapped issue and clearing it from every issue that's no longer
// mapped. Idempotent — safe to re-run with unchanged inputs.
//
// Usage: node scripts/tvfy/apply.mjs [datasetPath] [--mapping <path>]
//   datasetPath   dataset to update in place (default data/dataset.json)
//   --mapping     mapping.json path (default data/tvfy/mapping.json)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PARTY_IDS, readJson } from './util.mjs';

const DEFAULT_MAPPING_PATH = 'data/tvfy/mapping.json';
const RECORDS_PATH = 'data/tvfy/records.json';
const DIVISIONS_PATH = 'data/tvfy/divisions.json';
const DEFAULT_DATASET_PATH = 'data/dataset.json';

function parseArgs(argv) {
  let datasetPath = null;
  let mappingPath = DEFAULT_MAPPING_PATH;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mapping') mappingPath = argv[++i];
    else if (datasetPath === null) datasetPath = arg;
    else {
      console.error(`error: unrecognized argument "${arg}"`);
      process.exit(1);
    }
  }
  return { datasetPath: datasetPath ?? DEFAULT_DATASET_PATH, mappingPath };
}

function requireFile(path, label) {
  if (!existsSync(path)) {
    console.error(`error: ${label} not found at ${path}`);
    process.exit(1);
  }
}

// Orients a division's raw {aye, no} tally to the policy's proposition:
// an "aye" ballot on the division supported the proposition iff the
// policy's own vote for that division is "aye".
function orientToProposition(tally, policyVote) {
  return policyVote === 'aye'
    ? { for: tally.aye, against: tally.no }
    : { for: tally.no, against: tally.aye };
}

// One chronological series entry per division_ref, joined against
// data/tvfy/divisions.json. Fails loudly if a referenced division is
// missing (caught by the pre-mutation validation pass below).
function buildSeriesEntry(divisionRef, division) {
  const parties = {};
  for (const partyId of PARTY_IDS) {
    parties[partyId] = orientToProposition(division.parties[partyId], divisionRef.vote);
  }
  return {
    date: division.date,
    house: division.house,
    name: division.name,
    policy_vote: divisionRef.vote,
    parties,
    other: orientToProposition(division.other, divisionRef.vote),
  };
}

function buildSeries(policy, divisionsById) {
  const refs = policy.division_refs ?? [];
  return refs
    .map((ref) => ({ id: ref.id, entry: buildSeriesEntry(ref, divisionsById.get(ref.id)) }))
    .sort((a, b) => {
      if (a.entry.date !== b.entry.date) return a.entry.date < b.entry.date ? -1 : 1;
      return a.id - b.id;
    })
    .map((x) => x.entry);
}

// mapping entry {policy_id, polarity, strength, note} merged with the
// matching records.json policy fields, mapping fields first.
function buildVotingRecord(entry, policy, divisionsById) {
  return {
    policy_id: entry.policy_id,
    polarity: entry.polarity,
    strength: entry.strength,
    note: entry.note,
    name: policy.name,
    description: policy.description,
    url: policy.url,
    provisional: policy.provisional,
    divisions_total: policy.divisions_total,
    houses: policy.houses,
    first_division_date: policy.first_division_date,
    last_division_date: policy.last_division_date,
    parties: policy.parties,
    series: buildSeries(policy, divisionsById),
  };
}

function main() {
  const { datasetPath, mappingPath } = parseArgs(process.argv.slice(2));

  requireFile(mappingPath, 'mapping');
  requireFile(RECORDS_PATH, 'records');
  requireFile(DIVISIONS_PATH, 'divisions');
  requireFile(datasetPath, 'dataset');

  const mapping = readJson(mappingPath);
  const records = readJson(RECORDS_PATH);
  const divisionsJson = readJson(DIVISIONS_PATH);
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));

  const mappingIssues = mapping.issues ?? {};
  const divisionsById = new Map(
    Object.values(divisionsJson.divisions ?? {}).map((division) => [division.id, division])
  );

  const allIssues = [];
  for (const topic of dataset.topics ?? []) {
    for (const issue of topic.issues ?? []) allIssues.push(issue);
  }
  const issueById = new Map(allIssues.map((issue) => [issue.id, issue]));

  // Validate everything before mutating anything.
  const errors = [];
  for (const [issueId, entries] of Object.entries(mappingIssues)) {
    if (!issueById.has(issueId)) {
      errors.push(`mapping references issue "${issueId}" which does not exist in ${datasetPath}`);
      continue;
    }
    for (const entry of entries) {
      const policy = records.policies?.[entry.policy_id];
      if (!policy) {
        errors.push(`mapping issue "${issueId}": policy_id ${entry.policy_id} is missing from ${RECORDS_PATH}`);
        continue;
      }
      for (const ref of policy.division_refs ?? []) {
        if (!divisionsById.has(ref.id)) {
          errors.push(
            `mapping issue "${issueId}": policy ${entry.policy_id} references division ${ref.id} which is missing from ${DIVISIONS_PATH}`
          );
        }
      }
    }
  }
  if (errors.length > 0) {
    console.error(`error: ${errors.length} problem(s) found:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const asOf = String(records.meta?.fetched_at ?? '').slice(0, 10);

  let enriched = 0;
  let recordsApplied = 0;
  let cleared = 0;

  for (const issue of allIssues) {
    const entries = mappingIssues[issue.id];
    if (entries) {
      issue.voting = {
        as_of: asOf,
        records: entries.map((entry) =>
          buildVotingRecord(entry, records.policies[entry.policy_id], divisionsById)
        ),
      };
      enriched += 1;
      recordsApplied += entries.length;
    } else if (issue.voting !== undefined) {
      delete issue.voting;
      cleared += 1;
    }
  }

  writeFileSync(datasetPath, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');

  console.log(
    `wrote ${datasetPath} — voting: ${enriched} issues enriched, ${recordsApplied} records applied, ${cleared} issues cleared`
  );
}

main();

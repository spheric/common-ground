#!/usr/bin/env node
// Fetches They Vote For You per-division vote data for every division
// referenced by the policies in data/tvfy/mapping.json, and aggregates
// per-party (frozen four-party set) aye/no tallies for each division into
// data/tvfy/divisions.json. Zero dependencies, Node >= 18, built-in fetch.
//
// Usage: node scripts/tvfy/fetch-divisions.mjs [--cache <dir>] [--policy-cache <dir>] [--mapping <path>]
//   --cache <dir>         use pre-downloaded division-<id>.json files from
//                         <dir> instead of the network where present. Falls
//                         back to the network per-division when a cache
//                         file is absent or empty.
//   --policy-cache <dir>  use pre-downloaded policy-<id>.json files from
//                         <dir> (same cache format as fetch.mjs's --cache)
//                         to discover which division ids are needed. Falls
//                         back to the network per-policy when a cache file
//                         is absent or empty.
//   --mapping <path>      mapping.json path (default data/tvfy/mapping.json).
//
// Requires a They Vote For You API key: the TVFY_API_KEY environment
// variable, or a TVFY_API_KEY=... line in a repo-root .env file (env var
// wins). Only actually needed when something isn't already in a cache dir.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PARTY_IDS, classifyParty, loadApiKey, readJson, redactKey, sleep, writeJson } from './util.mjs';

const API_BASE = 'https://theyvoteforyou.org.au/api/v1';
const DEFAULT_MAPPING_PATH = 'data/tvfy/mapping.json';
const OUTPUT_PATH = 'data/tvfy/divisions.json';
const REQUEST_DELAY_MS = 300;
const PROGRESS_EVERY = 20;

const SOURCE_LABEL = 'They Vote For You — theyvoteforyou.org.au (OpenAustralia Foundation)';
const METHOD_NOTE =
  "Per-division party tallies use each member's party as recorded by TVFY at the time of the division.";
const COUNT_NOTE =
  "aye_votes/no_votes are TVFY's declared division totals; counted_aye/counted_no (and all party tallies) " +
  'are recomputed from the per-member roll, which differs by 1-2 votes in some divisions.';
const MAX_INTEGRITY_DIFF = 2;

// --- CLI args ---------------------------------------------------------

function parseArgs(argv) {
  let cacheDir = null;
  let policyCacheDir = null;
  let mappingPath = DEFAULT_MAPPING_PATH;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cache') cacheDir = argv[++i];
    else if (arg === '--policy-cache') policyCacheDir = argv[++i];
    else if (arg === '--mapping') mappingPath = argv[++i];
    else {
      console.error(`error: unrecognized argument "${arg}"`);
      process.exit(1);
    }
  }
  return { cacheDir, policyCacheDir, mappingPath };
}

// --- fetch / cache plumbing --------------------------------------------

let lastRequestAt = null;

// >=300ms between actual network requests (spec: network etiquette).
async function politeDelay() {
  if (lastRequestAt !== null) {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

// One retry on network error or non-200, each attempt spaced by the same
// politeness delay.
async function fetchJsonWithRetry(url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await politeDelay();
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`request failed after retry: ${redactKey(url)}: ${lastErr.message}`);
}

function cacheFilePath(cacheDir, filename) {
  return cacheDir ? resolve(cacheDir, filename) : null;
}

function readCacheJson(path) {
  if (!path || !existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') return undefined; // empty cache file -> fall back to network
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`cache file ${path} is not valid JSON: ${err.message}`);
  }
}

async function loadPolicy(id, cacheDir) {
  const cached = readCacheJson(cacheFilePath(cacheDir, `policy-${id}.json`));
  if (cached !== undefined) return cached;
  return fetchJsonWithRetry(`${API_BASE}/policies/${id}.json?key=${loadApiKey()}`);
}

async function loadDivision(id, cacheDir) {
  const cached = readCacheJson(cacheFilePath(cacheDir, `division-${id}.json`));
  if (cached !== undefined) return cached;
  return fetchJsonWithRetry(`${API_BASE}/divisions/${id}.json?key=${loadApiKey()}`);
}

// --- policy id / division id discovery -------------------------------------

function policyIdsFromMapping(mapping) {
  const ids = new Set();
  for (const entries of Object.values(mapping.issues ?? {})) {
    for (const entry of entries) ids.add(entry.policy_id);
  }
  return [...ids];
}

function divisionIdsFromPolicy(policyJson) {
  const ids = [];
  for (const pd of policyJson.policy_divisions ?? []) {
    const id = pd.division?.id;
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

// --- per-division party tallies ---------------------------------------------

function emptyTally() {
  return { aye: 0, no: 0 };
}

// Tallies one division's votes[] into the frozen four-party set plus
// "other" (every unclassified party string — historical parties,
// Independent, presiding officers, etc). Adds every unclassified party
// string it encounters to `unclassified` so a human can review the list.
// Also returns memberVotes: [{person_id, party, vote}] — the trimmed
// per-member roll (party AS RECORDED AT THE TIME of this division), which
// fetch.mjs's aggregation stage cross-references to exclude party-switcher
// members from party-aggregate figures they didn't actually earn under
// their current party.
function tallyDivision(divisionJson, unclassified) {
  const parties = {};
  for (const partyId of PARTY_IDS) parties[partyId] = emptyTally();
  const other = emptyTally();
  const memberVotes = [];

  for (const v of divisionJson.votes ?? []) {
    const voteType = v.vote;
    if (voteType !== 'aye' && voteType !== 'no') {
      throw new Error(
        `division ${divisionJson.id}: unrecognized vote value "${voteType}" for member ${v.member?.id}`
      );
    }
    const partyString = v.member?.party;
    const partyId = classifyParty(partyString);
    if (partyId) {
      parties[partyId][voteType] += 1;
    } else {
      other[voteType] += 1;
      unclassified.add(partyString ?? '(no party recorded)');
    }

    const personId = v.member?.person?.id;
    if (personId !== undefined && partyString) {
      memberVotes.push({ person_id: personId, party: partyString, vote: voteType });
    }
  }

  return { parties, other, memberVotes };
}

// The per-member roll (votes[]) and the division's declared aye_votes/
// no_votes header sometimes disagree by 1-2 votes — real variance between
// TVFY's Hansard-derived official count and its recorded roll, not
// corruption. Party tallies (and `other`) always come from the roll; the
// declared header numbers are kept unchanged alongside them. Warn on any
// non-zero difference; fail loudly (division id + both sums) only when a
// difference exceeds MAX_INTEGRITY_DIFF, since that's large enough to
// suggest an actual tallying bug rather than source-data noise.
function checkIntegrity(divisionJson, countedAye, countedNo) {
  const ayeDiff = countedAye - divisionJson.aye_votes;
  const noDiff = countedNo - divisionJson.no_votes;

  if (ayeDiff !== 0 || noDiff !== 0) {
    console.warn(
      `warning: division ${divisionJson.id} vote-roll mismatch — ` +
        `aye: declared ${divisionJson.aye_votes} vs counted ${countedAye} (diff ${ayeDiff}), ` +
        `no: declared ${divisionJson.no_votes} vs counted ${countedNo} (diff ${noDiff})`
    );
  }

  if (Math.abs(ayeDiff) > MAX_INTEGRITY_DIFF || Math.abs(noDiff) > MAX_INTEGRITY_DIFF) {
    console.error(`error: integrity check failed for division ${divisionJson.id} — mismatch exceeds ±${MAX_INTEGRITY_DIFF}`);
    console.error(`  aye: counted ${countedAye} vs declared aye_votes ${divisionJson.aye_votes}`);
    console.error(`  no:  counted ${countedNo} vs declared no_votes ${divisionJson.no_votes}`);
    process.exit(1);
  }

  return ayeDiff !== 0 || noDiff !== 0;
}

// --- main -----------------------------------------------------------------

async function main() {
  const { cacheDir, policyCacheDir, mappingPath } = parseArgs(process.argv.slice(2));

  if (!existsSync(mappingPath)) {
    console.error(`error: ${mappingPath} not found — nothing to fetch.`);
    process.exit(1);
  }
  const mapping = readJson(mappingPath);
  const policyIds = policyIdsFromMapping(mapping).sort((a, b) => a - b);

  if (policyIds.length === 0) {
    console.error('error: no policy ids to fetch (mapping has no issues).');
    process.exit(1);
  }

  console.log(
    `resolving division ids for ${policyIds.length} polic${policyIds.length === 1 ? 'y' : 'ies'}` +
      `${policyCacheDir ? ` (policy cache: ${policyCacheDir})` : ''}...`
  );

  const divisionIds = new Set();
  for (let i = 0; i < policyIds.length; i++) {
    const id = policyIds[i];
    let policyJson;
    try {
      policyJson = await loadPolicy(id, policyCacheDir);
    } catch (err) {
      throw new Error(`policy ${id}: ${err.message}`);
    }
    for (const divId of divisionIdsFromPolicy(policyJson)) divisionIds.add(divId);
  }

  const sortedDivisionIds = [...divisionIds].sort((a, b) => a - b);
  console.log(
    `fetching ${sortedDivisionIds.length} division${sortedDivisionIds.length === 1 ? '' : 's'}` +
      `${cacheDir ? ` (cache: ${cacheDir})` : ''}...`
  );

  const unclassified = new Set();
  const divisions = {};
  let mismatchCount = 0;

  for (let i = 0; i < sortedDivisionIds.length; i++) {
    const id = sortedDivisionIds[i];
    let divisionJson;
    try {
      divisionJson = await loadDivision(id, cacheDir);
    } catch (err) {
      throw new Error(`division ${id}: ${err.message}`);
    }

    const { parties, other, memberVotes } = tallyDivision(divisionJson, unclassified);
    const countedAye = PARTY_IDS.reduce((sum, pid) => sum + parties[pid].aye, 0) + other.aye;
    const countedNo = PARTY_IDS.reduce((sum, pid) => sum + parties[pid].no, 0) + other.no;
    if (checkIntegrity(divisionJson, countedAye, countedNo)) mismatchCount += 1;

    divisions[divisionJson.id] = {
      id: divisionJson.id,
      house: divisionJson.house,
      name: divisionJson.name,
      date: divisionJson.date,
      aye_votes: divisionJson.aye_votes,
      no_votes: divisionJson.no_votes,
      counted_aye: countedAye,
      counted_no: countedNo,
      parties,
      other,
      member_votes: memberVotes,
    };

    if ((i + 1) % PROGRESS_EVERY === 0 || i + 1 === sortedDivisionIds.length) {
      console.log(`  ${i + 1}/${sortedDivisionIds.length} divisions fetched`);
    }
  }

  // Plain-object numeric keys enumerate in ascending numeric order per the
  // JS spec regardless of insertion order, but build the ordering
  // explicitly so it's true by construction, not by engine behaviour.
  const sortedDivisions = {};
  for (const id of sortedDivisionIds) sortedDivisions[id] = divisions[id];

  const unclassifiedList = [...unclassified].sort();

  const output = {
    meta: {
      source: SOURCE_LABEL,
      api: API_BASE,
      fetched_at: new Date().toISOString(),
      method: METHOD_NOTE,
      count_note: COUNT_NOTE,
      unclassified_party_strings: unclassifiedList,
    },
    divisions: sortedDivisions,
  };

  writeJson(OUTPUT_PATH, output);
  console.log(
    `wrote ${OUTPUT_PATH} (${sortedDivisionIds.length} divisions, ${policyIds.length} policies scanned, ` +
      `${mismatchCount} with a declared/counted vote-roll mismatch)`
  );
  console.log(`unclassified party strings (${unclassifiedList.length}):`);
  for (const s of unclassifiedList) console.log(`  - ${s}`);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

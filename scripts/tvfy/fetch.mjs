#!/usr/bin/env node
// Fetches They Vote For You (theyvoteforyou.org.au) policy voting-record
// data and aggregates per-party agreement figures into
// data/tvfy/records.json. Zero dependencies, Node >= 18, built-in fetch.
//
// Usage: node scripts/tvfy/fetch.mjs [--all] [--cache <dir>] [--mapping <path>]
//   --all             fetch every policy in /policies.json, instead of just
//                      the ones referenced by the mapping file.
//   --cache <dir>     use pre-downloaded files from <dir> instead of the
//                      network where present: policy-<id>.json,
//                      tvfy-people.json, tvfy-policies.json. Falls back to
//                      the network per-file when a cache file is absent or
//                      empty.
//   --mapping <path>  mapping.json path (default data/tvfy/mapping.json).
//                      Ignored when --all is given.
//
// Requires a They Vote For You API key: the TVFY_API_KEY environment
// variable, or a TVFY_API_KEY=... line in a repo-root .env file (env var
// wins). Only actually needed when something isn't already in --cache.
//
// Requires data/tvfy/divisions.json to already exist — run
// `node scripts/tvfy/fetch-divisions.mjs` first. It supplies the
// per-division member rolls (party AT THE TIME of each division) this
// script cross-references to exclude party-switcher members from a
// party's aggregate figures for policies they voted on under a different
// party (see excludePartySwitchers below).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PARTY_IDS, classifyParty, loadApiKey, readJson, redactKey, sleep, writeJson } from './util.mjs';

const API_BASE = 'https://theyvoteforyou.org.au/api/v1';
const DEFAULT_MAPPING_PATH = 'data/tvfy/mapping.json';
const DIVISIONS_PATH = 'data/tvfy/divisions.json';
const OUTPUT_PATH = 'data/tvfy/records.json';
const REQUEST_DELAY_MS = 300;
const PROGRESS_EVERY = 20;

const SOURCE_LABEL = 'They Vote For You — theyvoteforyou.org.au (OpenAustralia Foundation)';
const METHOD_NOTE =
  "Party figures aggregate TVFY per-member policy agreement scores across current federal members " +
  "only; members with category 'not_enough' or no relevant votes are excluded from voted counts. " +
  'A member is further excluded from a policy\'s party-aggregate figures (and counted in ' +
  "excluded_switchers instead) if any of their votes on that policy's divisions were cast under a " +
  'party that classifies to a different bucket than their current one — see data/tvfy/README.md.';

// --- CLI args ---------------------------------------------------------

function parseArgs(argv) {
  let all = false;
  let cacheDir = null;
  let mappingPath = DEFAULT_MAPPING_PATH;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') all = true;
    else if (arg === '--cache') cacheDir = argv[++i];
    else if (arg === '--mapping') mappingPath = argv[++i];
    else {
      console.error(`error: unrecognized argument "${arg}"`);
      process.exit(1);
    }
  }
  return { all, cacheDir, mappingPath };
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

async function loadPeople(cacheDir) {
  const cached = readCacheJson(cacheFilePath(cacheDir, 'tvfy-people.json'));
  if (cached !== undefined) return cached;
  return fetchJsonWithRetry(`${API_BASE}/people.json?key=${loadApiKey()}`);
}

async function loadPoliciesList(cacheDir) {
  const cached = readCacheJson(cacheFilePath(cacheDir, 'tvfy-policies.json'));
  if (cached !== undefined) return cached;
  return fetchJsonWithRetry(`${API_BASE}/policies.json?key=${loadApiKey()}`);
}

async function loadPolicy(id, cacheDir) {
  const cached = readCacheJson(cacheFilePath(cacheDir, `policy-${id}.json`));
  if (cached !== undefined) return cached;
  return fetchJsonWithRetry(`${API_BASE}/policies/${id}.json?key=${loadApiKey()}`);
}

// Loads data/tvfy/divisions.json (always local — it's a generated file, not
// fetched over the network by this script) and indexes it by division id.
// Required for the party-switcher exclusion below; errors out with a clear
// pointer rather than silently skipping the check.
function loadDivisionsById() {
  if (!existsSync(DIVISIONS_PATH)) {
    throw new Error(
      `${DIVISIONS_PATH} not found. Run "node scripts/tvfy/fetch-divisions.mjs" first — ` +
        'party-switcher exclusion needs the per-division member rolls it produces.'
    );
  }
  const divisionsJson = readJson(DIVISIONS_PATH);
  return new Map(Object.values(divisionsJson.divisions ?? {}).map((d) => [d.id, d]));
}

// --- policy id selection -------------------------------------------------

function policyIdsFromMapping(mapping) {
  const ids = new Set();
  for (const entries of Object.values(mapping.issues ?? {})) {
    for (const entry of entries) ids.add(entry.policy_id);
  }
  return [...ids];
}

// --- aggregation ----------------------------------------------------------

function round1(n) {
  return Math.round(n * 10) / 10;
}

function mean(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// "for3|for2|for1" -> for, "against3|against2|against1" -> against,
// "mixture" -> mixed, "not_enough" -> excluded (null).
function categoryDirection(category) {
  if (category === 'mixture') return 'mixed';
  if (category === 'not_enough') return null;
  if (category.startsWith('for')) return 'for';
  if (category.startsWith('against')) return 'against';
  throw new Error(`unrecognized TVFY category "${category}"`);
}

function countHouses(divisions) {
  const houses = { representatives: 0, senate: 0 };
  for (const pd of divisions) {
    const house = pd.division?.house;
    if (!house) continue;
    houses[house] = (houses[house] ?? 0) + 1;
  }
  return houses;
}

function divisionDateRange(divisions) {
  const dates = divisions.map((pd) => pd.division?.date).filter(Boolean).sort();
  if (dates.length === 0) return { first: null, last: null };
  return { first: dates[0], last: dates[dates.length - 1] };
}

// Procedural role codes TVFY sometimes records as a member's "party" for a
// division they presided over (Speaker / Deputy Speaker / President /
// Deputy President / Chair of Committees). These say nothing about party
// membership — a Liberal senator who takes the chair as Deputy President
// for a sitting hasn't left the Liberal Party — so they must never count
// as party-switch evidence. Same set fetch-divisions.mjs treats as "other"
// rather than a real party.
const PRESIDING_OFFICER_ROLES = new Set(['SPK', 'PRES', 'DPRES', 'CWM', 'Speaker', 'Deputy Speaker']);

// TVFY's people_comparisons attribute a member's ENTIRE division history on
// a policy to their CURRENT party — so a member who has since switched
// parties has their pre-switch votes silently folded into their new
// party's aggregate. Builds Map<personId, Set<partyString>>: every party
// string that person voted under, across just this policy's own divisions
// (per data/tvfy/divisions.json's member_votes, party AS RECORDED AT THE
// TIME), excluding presiding-officer role codes. Divisions absent from
// divisionsById (only possible with --all, which scopes divisions.json's
// coverage to mapping.json's policies) are skipped rather than failed on —
// no history available, so no exclusion evidence from that division.
function buildPolicyPartyHistory(divisions, divisionsById) {
  const history = new Map();
  for (const pd of divisions) {
    const divisionId = pd.division?.id;
    if (divisionId === undefined) continue;
    const division = divisionsById.get(divisionId);
    if (!division) continue;
    for (const mv of division.member_votes ?? []) {
      if (PRESIDING_OFFICER_ROLES.has(mv.party)) continue;
      let seen = history.get(mv.person_id);
      if (!seen) {
        seen = new Set();
        history.set(mv.person_id, seen);
      }
      seen.add(mv.party);
    }
  }
  return history;
}

// True iff any (non-presiding-officer) party string this person voted
// under on this policy's divisions classifies to a different bucket than
// their current one — including classifying to no bucket at all
// (independent, historical minor party, etc). Same-bucket historical
// strings (Liberal -> Liberal National Party, etc) are not a switch.
function isPartySwitcher(personId, currentPartyId, partyHistory) {
  const votedAsParties = partyHistory.get(personId);
  if (!votedAsParties) return false;
  for (const partyString of votedAsParties) {
    if (classifyParty(partyString) !== currentPartyId) return true;
  }
  return false;
}

// currentById: Map<personId, { partyId: string|null, name: string }> for
// the /people.json roster only — former members referenced in
// people_comparisons but absent from currentById are ignored entirely, per
// spec. switcherLog (optional): array pushed with {policy_id, policy_name,
// party, person_id, name} for every member excluded as a party switcher,
// so a caller can print the full exclusion list for review.
function aggregateParties(policyJson, currentById, memberCounts, divisionsById, switcherLog) {
  const comparisonByPersonId = new Map();
  for (const comp of policyJson.people_comparisons ?? []) {
    const personId = comp.person?.id;
    if (personId === undefined || !currentById.has(personId)) continue;
    comparisonByPersonId.set(personId, comp);
  }

  const partyHistory = buildPolicyPartyHistory(policyJson.policy_divisions ?? [], divisionsById);

  const parties = {};
  for (const partyId of PARTY_IDS) {
    let forCount = 0;
    let againstCount = 0;
    let mixedCount = 0;
    let excludedSwitchers = 0;
    const agreements = [];

    for (const [personId, info] of currentById) {
      if (info.partyId !== partyId) continue;
      const comp = comparisonByPersonId.get(personId);
      if (!comp || comp.voted !== true) continue;
      const direction = categoryDirection(comp.category);
      if (direction === null) continue; // not_enough

      if (isPartySwitcher(personId, partyId, partyHistory)) {
        excludedSwitchers += 1;
        switcherLog?.push({
          policy_id: policyJson.id,
          policy_name: policyJson.name,
          party: partyId,
          person_id: personId,
          name: info.name,
        });
        continue;
      }

      if (direction === 'for') forCount += 1;
      else if (direction === 'against') againstCount += 1;
      else mixedCount += 1;

      const agreement = parseFloat(comp.agreement);
      if (Number.isFinite(agreement)) agreements.push(agreement);
    }

    const voted = forCount + againstCount + mixedCount;
    parties[partyId] = {
      members: memberCounts[partyId],
      voted,
      for: forCount,
      against: againstCount,
      mixed: mixedCount,
      median_agreement: voted === 0 ? null : round1(median(agreements)),
      mean_agreement: voted === 0 ? null : round1(mean(agreements)),
      excluded_switchers: excludedSwitchers,
    };
  }
  return parties;
}

// [{id, vote}] per division this policy has a division on — id + the
// policy's aye/no orientation for that division, straight off the policy
// payload. Feeds apply.mjs's per-division series (joined against
// data/tvfy/divisions.json).
function divisionRefs(divisions) {
  return divisions
    .filter((pd) => pd.division?.id !== undefined)
    .map((pd) => ({ id: pd.division.id, vote: pd.vote }));
}

function buildPolicyEntry(policyJson, currentById, memberCounts, divisionsById, switcherLog) {
  const divisions = policyJson.policy_divisions ?? [];
  const { first, last } = divisionDateRange(divisions);
  return {
    id: policyJson.id,
    name: policyJson.name,
    description: policyJson.description,
    provisional: policyJson.provisional,
    url: `https://theyvoteforyou.org.au/policies/${policyJson.id}`,
    last_edited_at: policyJson.last_edited_at,
    divisions_total: divisions.length,
    houses: countHouses(divisions),
    first_division_date: first,
    last_division_date: last,
    parties: aggregateParties(policyJson, currentById, memberCounts, divisionsById, switcherLog),
    division_refs: divisionRefs(divisions),
  };
}

// --- main -----------------------------------------------------------------

async function main() {
  const { all, cacheDir, mappingPath } = parseArgs(process.argv.slice(2));

  let ids;
  if (all) {
    console.log('fetching full policy list (--all)...');
    const policiesList = await loadPoliciesList(cacheDir);
    ids = policiesList.map((p) => p.id);
  } else {
    if (!existsSync(mappingPath)) {
      console.error(`error: ${mappingPath} not found — nothing to fetch.`);
      console.error(
        `Hint: create ${mappingPath} (see data/tvfy/README.md) before running without --all, ` +
          'or pass --all to fetch every They Vote For You policy.'
      );
      process.exit(1);
    }
    const mapping = readJson(mappingPath);
    ids = policyIdsFromMapping(mapping);
  }
  ids.sort((a, b) => a - b);

  if (ids.length === 0) {
    console.error('error: no policy ids to fetch (mapping has no issues, or --all found an empty policy list).');
    process.exit(1);
  }

  console.log(`fetching ${ids.length} polic${ids.length === 1 ? 'y' : 'ies'}${cacheDir ? ` (cache: ${cacheDir})` : ''}...`);

  const people = await loadPeople(cacheDir);
  const currentById = new Map(
    people.map((p) => {
      const lm = p.latest_member ?? {};
      const name = [lm.name?.first, lm.name?.last].filter(Boolean).join(' ') || `person ${p.id}`;
      return [p.id, { partyId: classifyParty(lm.party), name }];
    })
  );

  const memberCounts = {};
  for (const partyId of PARTY_IDS) {
    memberCounts[partyId] = [...currentById.values()].filter((v) => v.partyId === partyId).length;
  }

  const divisionsById = loadDivisionsById();
  const switcherLog = [];

  const policies = {};
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    let policyJson;
    try {
      policyJson = await loadPolicy(id, cacheDir);
    } catch (err) {
      throw new Error(`policy ${id}: ${err.message}`);
    }
    policies[id] = buildPolicyEntry(policyJson, currentById, memberCounts, divisionsById, switcherLog);

    if ((i + 1) % PROGRESS_EVERY === 0 || i + 1 === ids.length) {
      console.log(`  ${i + 1}/${ids.length} policies fetched`);
    }
  }

  const output = {
    meta: {
      source: SOURCE_LABEL,
      api: API_BASE,
      fetched_at: new Date().toISOString(),
      method: METHOD_NOTE,
    },
    policies,
  };

  writeJson(OUTPUT_PATH, output);
  console.log(`wrote ${OUTPUT_PATH} (${ids.length} policies, ${currentById.size} current members joined)`);
  console.log(`party-switcher exclusions (${switcherLog.length}):`);
  for (const s of switcherLog) {
    console.log(`  - policy ${s.policy_id} (${s.policy_name}), ${s.party}: ${s.name} [person ${s.person_id}]`);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

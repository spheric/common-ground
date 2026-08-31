#!/usr/bin/env node
// Validate data/dataset.json (or a given path) against the Common Ground data model.
// Zero dependencies. Node >= 18. Hand-rolled checks (no JSON Schema library) so the
// failure messages stay specific and actionable.
//
// Usage: node scripts/validate.mjs [path]
//   default path: data/dataset.json
//   falls back to data/dataset.sample.json (with a warning) if the default is missing.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_PATH = 'data/dataset.json';
const FALLBACK_PATH = 'data/dataset.sample.json';

const PARTY_IDS = ['labor', 'coalition', 'greens', 'one_nation'];
const STANCE_IDS = ['supports', 'opposes', 'mixed', 'no_position'];
const CONFIDENCE_IDS = ['high', 'medium', 'low'];
const VERIFIED_IDS = ['confirmed', 'corrected', 'unverified'];
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const MAX_SUMMARY_CHARS = 350;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TVFY_POLICY_URL_RE = /^https:\/\/theyvoteforyou\.org\.au\/policies\/(\d+)$/;

function resolveInputPath(argPath) {
  if (argPath) {
    if (!existsSync(argPath)) {
      console.error(`error: dataset not found at ${argPath}`);
      process.exit(1);
    }
    return argPath;
  }
  if (existsSync(DEFAULT_PATH)) return DEFAULT_PATH;
  if (existsSync(FALLBACK_PATH)) {
    console.warn(`warning: ${DEFAULT_PATH} not found — falling back to ${FALLBACK_PATH}`);
    return FALLBACK_PATH;
  }
  console.error(`error: neither ${DEFAULT_PATH} nor ${FALLBACK_PATH} exists`);
  process.exit(1);
}

function loadDataset(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`error: could not read ${path}: ${err.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`error: ${path} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function findDuplicates(items) {
  const seen = new Set();
  const dupes = new Set();
  for (const item of items) {
    if (seen.has(item)) dupes.add(item);
    seen.add(item);
  }
  return [...dupes];
}

// Each check returns { name, issues: string[] }. issues.length === 0 means pass.
function runChecks(data) {
  const checks = [];
  const topics = Array.isArray(data.topics) ? data.topics : [];
  const parties = Array.isArray(data.parties) ? data.parties : [];
  const impactTags = Array.isArray(data.impact_tags) ? data.impact_tags : [];
  const tagIds = new Set(impactTags.map((t) => t.id));

  const allIssues = [];
  for (const topic of topics) {
    for (const issue of topic.issues ?? []) {
      allIssues.push({ topic, issue });
    }
  }

  // --- unique ids -----------------------------------------------------
  checks.push({
    name: 'party ids unique',
    issues: findDuplicates(parties.map((p) => p.id)).map((id) => `duplicate party id "${id}"`),
  });
  checks.push({
    name: 'topic ids unique',
    issues: findDuplicates(topics.map((t) => t.id)).map((id) => `duplicate topic id "${id}"`),
  });
  checks.push({
    name: 'issue ids unique',
    issues: findDuplicates(allIssues.map(({ issue }) => issue.id)).map(
      (id) => `duplicate issue id "${id}"`
    ),
  });
  checks.push({
    name: 'impact tag ids unique',
    issues: findDuplicates(impactTags.map((t) => t.id)).map((id) => `duplicate impact tag id "${id}"`),
  });

  // --- party id enum ----------------------------------------------------
  {
    const issues = [];
    for (const p of parties) {
      if (!PARTY_IDS.includes(p.id)) issues.push(`party "${p.id}" not in [${PARTY_IDS.join(', ')}]`);
    }
    for (const id of PARTY_IDS) {
      if (!parties.some((p) => p.id === id)) issues.push(`missing required party "${id}"`);
    }
    checks.push({ name: 'party ids valid and complete', issues });
  }

  // --- exactly one position per party per issue, all four present -------
  {
    const issues = [];
    for (const { topic, issue } of allIssues) {
      const positions = Array.isArray(issue.positions) ? issue.positions : [];
      const label = `${topic.id}/${issue.id}`;
      const counts = new Map();
      for (const pos of positions) {
        counts.set(pos.party, (counts.get(pos.party) ?? 0) + 1);
      }
      for (const partyId of PARTY_IDS) {
        const count = counts.get(partyId) ?? 0;
        if (count === 0) issues.push(`${label}: missing position for party "${partyId}"`);
        else if (count > 1) issues.push(`${label}: ${count} positions for party "${partyId}" (expected 1)`);
      }
      for (const pos of positions) {
        if (!PARTY_IDS.includes(pos.party)) {
          issues.push(`${label}: position has unknown party "${pos.party}"`);
        }
      }
    }
    checks.push({ name: 'exactly one position per party per issue, all four parties present', issues });
  }

  // --- stance / confidence / verified enums ------------------------------
  {
    const issues = [];
    for (const { topic, issue } of allIssues) {
      const label = `${topic.id}/${issue.id}`;
      for (const pos of issue.positions ?? []) {
        if (!STANCE_IDS.includes(pos.stance)) {
          issues.push(`${label} (${pos.party}): invalid stance "${pos.stance}"`);
        }
        if (!CONFIDENCE_IDS.includes(pos.confidence)) {
          issues.push(`${label} (${pos.party}): invalid confidence "${pos.confidence}"`);
        }
        if (!VERIFIED_IDS.includes(pos.verified)) {
          issues.push(`${label} (${pos.party}): invalid verified "${pos.verified}"`);
        }
      }
    }
    checks.push({ name: 'stance/confidence/verified enums valid', issues });
  }

  // --- impacts subset of tag ids ------------------------------------------
  {
    const issues = [];
    for (const { topic, issue } of allIssues) {
      const label = `${topic.id}/${issue.id}`;
      for (const pos of issue.positions ?? []) {
        for (const tag of pos.impacts ?? []) {
          if (!tagIds.has(tag)) issues.push(`${label} (${pos.party}): unknown impact tag "${tag}"`);
        }
      }
    }
    checks.push({ name: 'impacts are a subset of impact_tags ids', issues });
  }

  // --- non-no_position positions have >=1 http(s) source -----------------
  {
    const issues = [];
    for (const { topic, issue } of allIssues) {
      const label = `${topic.id}/${issue.id}`;
      for (const pos of issue.positions ?? []) {
        const sources = Array.isArray(pos.sources) ? pos.sources : [];
        if (pos.stance === 'no_position') continue;
        if (sources.length === 0) {
          issues.push(`${label} (${pos.party}): stance "${pos.stance}" has zero sources`);
          continue;
        }
        const hasValidUrl = sources.some((s) => isHttpUrl(s?.url));
        if (!hasValidUrl) {
          issues.push(`${label} (${pos.party}): no source has a valid http(s) URL`);
        }
      }
    }
    checks.push({ name: 'non-no_position positions have ≥1 source with an http(s) URL', issues });
  }

  // --- unverified only allowed on no_position ------------------------------
  {
    const issues = [];
    for (const { topic, issue } of allIssues) {
      const label = `${topic.id}/${issue.id}`;
      for (const pos of issue.positions ?? []) {
        if (pos.verified === 'unverified' && pos.stance !== 'no_position') {
          issues.push(`${label} (${pos.party}): stance "${pos.stance}" is unverified — only no_position may be unverified`);
        }
      }
    }
    checks.push({ name: 'unverified positions are no_position only', issues });
  }

  // --- summaries <= 350 chars -----------------------------------------------
  {
    const issues = [];
    for (const { topic, issue } of allIssues) {
      const label = `${topic.id}/${issue.id}`;
      for (const pos of issue.positions ?? []) {
        const len = typeof pos.summary === 'string' ? pos.summary.length : 0;
        if (len > MAX_SUMMARY_CHARS) {
          issues.push(`${label} (${pos.party}): summary is ${len} chars (max ${MAX_SUMMARY_CHARS})`);
        }
      }
    }
    checks.push({ name: `summaries ≤ ${MAX_SUMMARY_CHARS} chars`, issues });
  }

  // --- questions end with '?' -----------------------------------------------
  {
    const issues = [];
    for (const { topic, issue } of allIssues) {
      const label = `${topic.id}/${issue.id}`;
      if (typeof issue.question !== 'string' || !issue.question.trim().endsWith('?')) {
        issues.push(`${label}: question does not end with "?"`);
      }
    }
    checks.push({ name: "questions end with '?'", issues });
  }

  // --- hex colors valid --------------------------------------------------
  {
    const issues = [];
    for (const p of parties) {
      if (!HEX_COLOR_RE.test(p.color_light ?? '')) {
        issues.push(`party "${p.id}": invalid color_light "${p.color_light}"`);
      }
      if (!HEX_COLOR_RE.test(p.color_dark ?? '')) {
        issues.push(`party "${p.id}": invalid color_dark "${p.color_dark}"`);
      }
    }
    checks.push({ name: 'hex colors valid', issues });
  }

  // --- optional voting (They Vote For You) block, well-formed where present -
  let votingIssueCount = 0;
  let votingRecordCount = 0;
  {
    const issues = [];
    for (const { topic, issue } of allIssues) {
      if (issue.voting === undefined) continue;
      votingIssueCount += 1;
      const label = `${topic.id}/${issue.id}`;
      const voting = issue.voting;

      if (!ISO_DATE_RE.test(voting?.as_of ?? '')) {
        issues.push(`${label}: voting.as_of is not an ISO date ("${voting?.as_of}")`);
      }

      const records = Array.isArray(voting?.records) ? voting.records : null;
      if (!records || records.length === 0) {
        issues.push(`${label}: voting.records is missing or empty`);
        continue;
      }
      votingRecordCount += records.length;

      records.forEach((record, i) => {
        const rlabel = `${label}: voting.records[${i}]`;

        if (!Number.isInteger(record?.policy_id)) {
          issues.push(`${rlabel}: policy_id is not an integer ("${record?.policy_id}")`);
        }
        if (record?.polarity !== 1 && record?.polarity !== -1) {
          issues.push(`${rlabel}: polarity "${record?.polarity}" not in [1, -1]`);
        }
        if (record?.strength !== 'direct' && record?.strength !== 'related') {
          issues.push(`${rlabel}: strength "${record?.strength}" not in [direct, related]`);
        }
        if (typeof record?.description !== 'string' || record.description.trim() === '') {
          issues.push(`${rlabel}: description is empty`);
        }

        const urlMatch = typeof record?.url === 'string' ? record.url.match(TVFY_POLICY_URL_RE) : null;
        if (!urlMatch) {
          issues.push(`${rlabel}: url "${record?.url}" does not match the expected TVFY policy URL pattern`);
        } else if (Number.isInteger(record?.policy_id) && Number(urlMatch[1]) !== record.policy_id) {
          issues.push(`${rlabel}: url "${record.url}" does not end with policy_id ${record.policy_id}`);
        }

        const partyKeys = record?.parties && typeof record.parties === 'object' ? Object.keys(record.parties) : [];
        const hasExactPartyIds =
          partyKeys.length === PARTY_IDS.length &&
          PARTY_IDS.every((id) => Object.prototype.hasOwnProperty.call(record?.parties ?? {}, id));
        if (!hasExactPartyIds) {
          issues.push(`${rlabel}: parties keys [${partyKeys.join(', ')}] are not exactly [${PARTY_IDS.join(', ')}]`);
          return;
        }

        for (const partyId of PARTY_IDS) {
          const p = record.parties[partyId];
          const plabel = `${rlabel} (${partyId})`;

          const membersOk = Number.isInteger(p?.members) && p.members >= 0;
          const votedOk = Number.isInteger(p?.voted) && p.voted >= 0;
          if (!membersOk) issues.push(`${plabel}: members is not a non-negative integer ("${p?.members}")`);
          if (!votedOk) issues.push(`${plabel}: voted is not a non-negative integer ("${p?.voted}")`);
          if (membersOk && votedOk && p.voted > p.members) {
            issues.push(`${plabel}: voted (${p.voted}) exceeds members (${p.members})`);
          }

          const parts = [p?.for, p?.against, p?.mixed];
          if (!parts.every(Number.isInteger)) {
            issues.push(`${plabel}: for/against/mixed must all be integers`);
          } else if (votedOk && parts[0] + parts[1] + parts[2] !== p.voted) {
            issues.push(`${plabel}: for(${parts[0]}) + against(${parts[1]}) + mixed(${parts[2]}) !== voted(${p.voted})`);
          }

          const ma = p?.median_agreement;
          if (ma !== null && !(typeof ma === 'number' && ma >= 0 && ma <= 100)) {
            issues.push(`${plabel}: median_agreement "${ma}" is not null or a number 0–100`);
          }
        }
      });
    }
    checks.push({ name: 'voting (optional) is well-formed where present', issues });
  }

  return { checks, allIssues, topics, parties, impactTags, votingIssueCount, votingRecordCount };
}

function printReport({ checks, allIssues, topics, impactTags, votingIssueCount, votingRecordCount }, path) {
  console.log(`Validating ${path}\n`);

  let failed = false;
  for (const check of checks) {
    if (check.issues.length === 0) {
      console.log(`✓ ${check.name}`);
    } else {
      failed = true;
      console.log(`✗ ${check.name} (${check.issues.length})`);
      for (const issue of check.issues) console.log(`    - ${issue}`);
    }
  }

  console.log('');

  if (failed) {
    console.log('FAIL');
    process.exit(1);
  }

  let positionCount = 0;
  let sourceCount = 0;
  let verifiedCount = 0;
  for (const { issue } of allIssues) {
    for (const pos of issue.positions ?? []) {
      positionCount += 1;
      sourceCount += (pos.sources ?? []).length;
      if (pos.verified === 'confirmed' || pos.verified === 'corrected') verifiedCount += 1;
    }
  }
  const pctVerified = positionCount === 0 ? 0 : Math.round((verifiedCount / positionCount) * 100);

  console.log(
    `PASS — ${topics.length} topics, ${allIssues.length} issues, ${positionCount} positions, ` +
      `${sourceCount} sources, ${pctVerified}% verified (confirmed or corrected), ${impactTags.length} impact tags, ` +
      `voting: ${votingIssueCount}/${allIssues.length} issues, ${votingRecordCount} records`
  );
}

function main() {
  const argPath = process.argv[2];
  const path = resolveInputPath(argPath);
  const data = loadDataset(path);
  const result = runChecks(data);
  printReport(result, resolve(path));
}

main();

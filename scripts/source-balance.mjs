#!/usr/bin/env node
// Report the outlet balance of data/dataset.json's position sources, so skew
// toward any one outlet family (party press releases, a single news outlet,
// Wikipedia, etc.) is visible at a glance. Zero dependencies. Node >= 18.
//
// Usage: node scripts/source-balance.mjs [path] [--strict]
//   default path: data/dataset.json
//   falls back to data/dataset.sample.json (with a warning) if the default is missing.
//   --strict: exit 1 if any WEAK (reference_weak) flags exist. Otherwise always exit 0.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_PATH = 'data/dataset.json';
const FALLBACK_PATH = 'data/dataset.sample.json';

// --- Bucket definitions -----------------------------------------------------
// Host matching is by exact match or subdomain suffix (e.g. "greens.org.au"
// also matches "cdn.greens.org.au"), after lowercasing and stripping a
// leading "www.". To add a host to a bucket, add one line below.
//
// primary_gov (*.gov.au), academic_civic's *.edu.au, and reference_weak's
// *.wikipedia.org are matched by TLD suffix instead of an explicit list,
// since they're open-ended government/education/wikipedia subdomains.
const SITE_BUCKETS = {
  primary_party: [
    // party sites
    'greens.org.au',
    'cdn.greens.org.au',
    'onenation.org.au',
    'liberal.org.au',
    'alp.org.au',
    'nationals.org.au',
    // known MP personal/electorate sites
    'angustaylor.com.au',
    'sarahhenderson.com.au',
  ],
  hansard_votes: ['openaustralia.org.au', 'theyvoteforyou.org.au'],
  public_broadcaster: ['abc.net.au', 'sbs.com.au'],
  academic_civic: ['theconversation.com', 'ahuri.edu.au', 'grattan.edu.au', 'austaxpolicy.com'],
  wire: ['aap.com.au', 'aapnews.aap.com.au'],
  reference_weak: ['en.wikipedia.org', 'britannica.com'],
  advocacy: ['refugeecouncil.org.au', 'acoss.org.au', 'buildaballot.org.au'],
  commercial_news: [
    'canberratimes.com.au',
    'nit.com.au',
    'thedailyaus.com.au',
    'smartcompany.com.au',
    'theadviser.com.au',
    'reneweconomy.com.au',
    'region.com.au',
    'thenightly.com.au',
    'news.com.au',
    'skynews.com.au',
    'afr.com',
    'theaustralian.com.au',
    'smh.com.au',
    'theage.com.au',
    'theguardian.com',
    'medicalrepublic.com.au',
    'thedriven.io',
  ],
};

// Buckets that count as "primary" (the claim is sourced directly from the
// party/politician, government, or the parliamentary voting record).
const PRIMARY_BUCKETS = new Set(['primary_party', 'primary_gov', 'hansard_votes']);

// Display order for the counts table and for bucket-set checks.
const BUCKET_ORDER = [
  'primary_party',
  'primary_gov',
  'hansard_votes',
  'public_broadcaster',
  'academic_civic',
  'wire',
  'reference_weak',
  'advocacy',
  'commercial_news',
  'unmapped',
];

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

function normalizeHost(hostname) {
  const h = hostname.toLowerCase();
  return h.startsWith('www.') ? h.slice(4) : h;
}

// Returns the normalized host for a source URL, or null if the URL isn't a
// valid http(s) URL.
function hostOf(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return normalizeHost(u.hostname);
  } catch {
    return null;
  }
}

function matchesDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function bucketForHost(host) {
  if (host === null) return 'unmapped';
  if (matchesDomain(host, 'gov.au')) return 'primary_gov';
  if (matchesDomain(host, 'wikipedia.org')) return 'reference_weak';
  if (matchesDomain(host, 'edu.au')) return 'academic_civic';
  for (const bucket of BUCKET_ORDER) {
    for (const domain of SITE_BUCKETS[bucket] ?? []) {
      if (matchesDomain(host, domain)) return bucket;
    }
  }
  return 'unmapped';
}

function flattenPositions(data) {
  const topics = Array.isArray(data.topics) ? data.topics : [];
  const positions = [];
  for (const topic of topics) {
    for (const issue of topic.issues ?? []) {
      for (const pos of issue.positions ?? []) {
        positions.push({ topic, issue, pos });
      }
    }
  }
  return positions;
}

// --- Analysis ----------------------------------------------------------------
function analyze(data) {
  const positions = flattenPositions(data);

  const bucketCounts = new Map(BUCKET_ORDER.map((b) => [b, 0]));
  const hostCounts = new Map(); // host (or "(invalid url)") -> count
  const weakFlags = [];
  const secondaryOnlyFlags = [];
  let totalSources = 0;

  for (const { topic, issue, pos } of positions) {
    const sources = Array.isArray(pos.sources) ? pos.sources : [];
    const label = `${topic.id}/${issue.id} (${pos.party})`;
    const bucketsUsed = new Set();

    for (const source of sources) {
      totalSources += 1;
      const host = hostOf(source?.url);
      const bucket = bucketForHost(host);
      bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
      const hostKey = host ?? '(invalid url)';
      hostCounts.set(hostKey, (hostCounts.get(hostKey) ?? 0) + 1);
      bucketsUsed.add(bucket);

      if (bucket === 'reference_weak') {
        weakFlags.push({ label, url: source?.url ?? '(no url)' });
      }
    }

    if (sources.length > 0 && bucketsUsed.size === 1) {
      const [onlyBucket] = bucketsUsed;
      if (!PRIMARY_BUCKETS.has(onlyBucket)) {
        secondaryOnlyFlags.push({ label, bucket: onlyBucket });
      }
    }
  }

  return { totalSources, bucketCounts, hostCounts, weakFlags, secondaryOnlyFlags };
}

// --- Printing ------------------------------------------------------------------
function pct(part, total) {
  return total === 0 ? '0.0%' : `${((part / total) * 100).toFixed(1)}%`;
}

function printReport({ totalSources, bucketCounts, hostCounts, weakFlags, secondaryOnlyFlags }, path) {
  console.log(`Source balance for ${path}\n`);

  console.log('Bucket                 Sources   % of total');
  console.log('-'.repeat(46));
  for (const bucket of BUCKET_ORDER) {
    const count = bucketCounts.get(bucket) ?? 0;
    console.log(`${bucket.padEnd(20)}  ${String(count).padStart(7)}   ${pct(count, totalSources).padStart(6)}`);
  }
  console.log('-'.repeat(46));
  console.log(`${'TOTAL'.padEnd(20)}  ${String(totalSources).padStart(7)}   ${pct(totalSources, totalSources).padStart(6)}`);
  console.log('');

  const topHosts = [...hostCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15);
  console.log('Top 15 hosts:');
  topHosts.forEach(([host, count], i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${host.padEnd(32)} ${count}`);
  });
  console.log('');

  console.log(`WEAK sources (reference_weak) — ${weakFlags.length} flags:`);
  if (weakFlags.length === 0) {
    console.log('  (none)');
  } else {
    for (const flag of weakFlags) console.log(`  - ${flag.label}: ${flag.url}`);
  }
  console.log('');

  console.log(`SECONDARY-ONLY positions — ${secondaryOnlyFlags.length} flags:`);
  if (secondaryOnlyFlags.length === 0) {
    console.log('  (none)');
  } else {
    for (const flag of secondaryOnlyFlags) console.log(`  - ${flag.label}: ${flag.bucket}`);
  }
  console.log('');

  const unmappedHosts = [...hostCounts.entries()]
    .filter(([host]) => bucketForHost(host === '(invalid url)' ? null : host) === 'unmapped')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  console.log(`Unmapped hosts — ${unmappedHosts.length} distinct:`);
  if (unmappedHosts.length === 0) {
    console.log('  (none)');
  } else {
    for (const [host, count] of unmappedHosts) console.log(`  - ${host} (${count})`);
  }
  console.log('');

  const primaryCount = ['primary_party', 'primary_gov', 'hansard_votes'].reduce(
    (sum, b) => sum + (bucketCounts.get(b) ?? 0),
    0
  );
  const pctPrimary = totalSources === 0 ? 0 : Math.round((primaryCount / totalSources) * 100);
  console.log(
    `Summary: ${totalSources} sources, ${pctPrimary}% primary (primary_party+primary_gov+hansard_votes), ` +
      `${weakFlags.length} WEAK flags, ${secondaryOnlyFlags.length} SECONDARY-ONLY flags`
  );
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const argPath = args.find((a) => !a.startsWith('--'));

  const path = resolveInputPath(argPath);
  const data = loadDataset(path);
  const result = analyze(data);
  printReport(result, resolve(path));

  if (strict && result.weakFlags.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();

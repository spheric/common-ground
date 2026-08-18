#!/usr/bin/env node
// Pulls NDIS-relevant items from ParlInfo committee-Hansard RSS and
// health.gov.au news RSS, and appends them as `auto` candidates to
// data/ndis/feed.json. Never overwrites or reorders existing items (confirmed
// or auto); de-dupes new candidates by URL against what's already there.
// `auto` items reproduce the source title verbatim with no generated summary
// (per docs/ndis-spec.md's feed.json shape) — a human/the ingest-ndis-update
// skill promotes them to `confirmed` later.
//
// Usage: node scripts/ndis/fetch-feeds.mjs

import { decodeXmlEntities, politeFetch, readJson, slugify, writeJson } from './util.mjs';

const FEED_PATH = 'data/ndis/feed.json';

const PARLINFO_FEEDS = [
  'https://parlinfo.aph.gov.au/parlInfo/feeds/rss.w3p;adv=yes;orderBy=priority,doc_date-rev;query=Dataset%3AcomJoint;resCount=Default',
  'https://parlinfo.aph.gov.au/parlInfo/feeds/rss.w3p;adv=yes;orderBy=priority,doc_date-rev;query=Dataset%3AcomRep;resCount=Default',
  'https://parlinfo.aph.gov.au/parlInfo/feeds/rss.w3p;adv=yes;orderBy=priority,doc_date-rev;query=Dataset%3AcomSen,estimate;resCount=Default',
];

// The NDIS Commission's /rss.xml is provider registrations only — explicitly
// excluded per docs/ndis-spec.md's verified source facts.
const HEALTH_FEEDS = ['https://www.health.gov.au/rss.xml', 'https://www.health.gov.au/news/rss.xml'];

const NDIS_WORD_RE = /\bndis\b/i;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Extracts the calendar date exactly as printed in an RFC822 pubDate
// ("Thu, 06 Aug 2026 00:00:00 +1000") without any timezone conversion —
// the feed's own stated date, not a UTC-shifted approximation of it.
function dateFromRfc822(pubDate) {
  const m = /^\w{3},\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/.exec(String(pubDate).trim());
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function extractTag(block, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? decodeXmlEntities(m[1].trim()) : '';
}

function parseRssItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    items.push({
      title: extractTag(block, 'title'),
      link: extractTag(block, 'link'),
      pubDate: extractTag(block, 'pubDate'),
      description: extractTag(block, 'description'),
    });
  }
  return items;
}

async function fetchRss(url) {
  const res = await politeFetch(url);
  if (!res.ok) throw new Error(`${url} responded ${res.status} ${res.statusText}`);
  return parseRssItems(await res.text());
}

function makeCandidate({ date, title, link, type, sourceTitle, publisher }) {
  return {
    id: `${date}-${slugify(title)}`,
    date,
    type,
    title,
    source: { title: sourceTitle, url: link, publisher },
    verified: 'auto',
  };
}

async function collectParlInfoCandidates() {
  const seenTitles = new Set();
  const candidates = [];
  for (const feedUrl of PARLINFO_FEEDS) {
    const items = await fetchRss(feedUrl);
    for (const item of items) {
      if (!NDIS_WORD_RE.test(item.title)) continue;
      if (seenTitles.has(item.title)) continue; // multiple Hansard segments share one hearing's title
      seenTitles.add(item.title);
      const date = dateFromRfc822(item.pubDate);
      if (!date || !item.link) continue;
      candidates.push(
        makeCandidate({
          date,
          title: item.title,
          link: item.link,
          type: 'hearing',
          sourceTitle: 'ParlInfo committee Hansard',
          publisher: 'Parliament of Australia',
        })
      );
    }
  }
  return candidates;
}

async function collectHealthGovCandidates() {
  const seenLinks = new Set();
  const candidates = [];
  for (const feedUrl of HEALTH_FEEDS) {
    const items = await fetchRss(feedUrl);
    for (const item of items) {
      const haystack = `${item.title} ${item.description}`;
      if (!NDIS_WORD_RE.test(haystack)) continue;
      if (!item.link || seenLinks.has(item.link)) continue;
      seenLinks.add(item.link);
      const date = dateFromRfc822(item.pubDate);
      if (!date) continue;
      candidates.push(
        makeCandidate({
          date,
          title: item.title,
          link: item.link,
          type: 'announcement',
          sourceTitle: 'Department of Health, Disability and Ageing',
          publisher: 'Australian Government Department of Health, Disability and Ageing',
        })
      );
    }
  }
  return candidates;
}

function uniqueId(baseId, takenIds) {
  if (!takenIds.has(baseId)) return baseId;
  let n = 2;
  while (takenIds.has(`${baseId}-${n}`)) n += 1;
  return `${baseId}-${n}`;
}

async function main() {
  const [parlinfo, healthGov] = await Promise.all([collectParlInfoCandidates(), collectHealthGovCandidates()]);
  const allCandidates = [...parlinfo, ...healthGov];

  const feed = readJson(FEED_PATH, { items: [] });
  if (!Array.isArray(feed.items)) feed.items = [];

  const existingUrls = new Set(feed.items.map((it) => it.source?.url).filter(Boolean));
  // Same event, different URL (e.g. a hearing confirmed under its aph.gov.au
  // page vs the ParlInfo GUID) — also dedupe on date + normalised title.
  const existingDateTitles = new Set(
    feed.items.map((it) => `${it.date}|${String(it.title).trim().toLowerCase()}`)
  );
  const takenIds = new Set(feed.items.map((it) => it.id));

  let added = 0;
  for (const candidate of allCandidates) {
    if (existingUrls.has(candidate.source.url)) continue; // never overwrite/duplicate an existing item
    if (existingDateTitles.has(`${candidate.date}|${candidate.title.trim().toLowerCase()}`)) continue;
    candidate.id = uniqueId(candidate.id, takenIds);
    takenIds.add(candidate.id);
    existingUrls.add(candidate.source.url);
    feed.items.push(candidate);
    added += 1;
  }

  writeJson(FEED_PATH, feed);
  console.log(
    `wrote ${FEED_PATH} (${allCandidates.length} NDIS candidates found: ${parlinfo.length} ParlInfo, ` +
      `${healthGov.length} health.gov.au; ${added} new, ${allCandidates.length - added} already present)`
  );
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

#!/usr/bin/env node
// Combines data/ndis/snapshots/*.json + law.json + feed.json + context.json
// into the single derived page dataset, data/ndis/ndis.json. Deterministic:
// same inputs -> byte-identical output (everything sorted, no timestamps
// beyond meta.as_of).
//
// Usage: node scripts/ndis/derive.mjs [outputPath]

import { existsSync, readdirSync } from 'node:fs';
import { readJson, todayIso, writeJson } from './util.mjs';

const SNAPSHOTS_DIR = 'data/ndis/snapshots';
const LAW_PATH = 'data/ndis/law.json';
const FEED_PATH = 'data/ndis/feed.json';
const CONTEXT_PATH = 'data/ndis/context.json';
const DEFAULT_OUTPUT_PATH = 'data/ndis/ndis.json';

const TITLE = 'Common Ground — NDIS Tracker';
const DISCLAIMER =
  'Independent, non-partisan tracker. Prices and dates are drawn from official sources and may ' +
  'change; always check the linked document. Not affiliated with the NDIA, the NDIS Commission, ' +
  'or any political party.';
const METHODOLOGY =
  'Prices come from the NDIS Support Catalogue, matched release over release by each item’s ' +
  'stable Support Item Number; a state price is normalised to the modal (most common) value as ' +
  '"national", with the observed range shown as a spread when states differ. Law entries come from ' +
  'the Federal Register of Legislation; parliamentary/agency updates are curated and source-checked; ' +
  'scheme-size figures come from NDIA quarterly datasets and the ABS. Summaries paraphrase the cited ' +
  'sources — always check the link.';

function loadSnapshots() {
  if (!existsSync(SNAPSHOTS_DIR)) return [];
  const files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith('.json'));
  const snapshots = files.map((f) => readJson(`${SNAPSHOTS_DIR}/${f}`));
  snapshots.sort((a, b) => a.effective.localeCompare(b.effective) || a.release.localeCompare(b.release));
  return snapshots;
}

function buildReleases(snapshots) {
  return snapshots.map((s) => ({
    release: s.release,
    fy: s.fy,
    effective: s.effective,
    source_url: s.source_url,
    item_count: s.items.length,
  }));
}

function buildItems(snapshots) {
  const nums = new Set();
  for (const s of snapshots) for (const item of s.items) nums.add(item.num);

  const sortedNums = [...nums].sort();
  return sortedNums.map((num) => {
    // Use the item's fields (name/category/unit) as they appear in the most
    // recent release that carries this item — these can change between
    // catalogue vintages, so "latest known" is the most useful/current label.
    let latest = null;
    const history = [];
    const spread = [];
    for (const s of snapshots) {
      const item = s.items.find((i) => i.num === num);
      if (item) {
        latest = item;
        history.push(item.prices.national ?? null);
        spread.push(
          item.prices.state_min !== undefined && item.prices.state_max !== undefined
            ? [item.prices.state_min, item.prices.state_max]
            : null
        );
      } else {
        history.push(null);
        spread.push(null);
      }
    }
    const lastSnapshot = snapshots[snapshots.length - 1];
    const active = lastSnapshot ? lastSnapshot.items.some((i) => i.num === num) : false;

    return { num, name: latest.name, category: latest.category, unit: latest.unit, history, spread, active };
  });
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return round1(value);
}

function diffReleasePair(fromSnapshot, toSnapshot) {
  const fromMap = new Map(fromSnapshot.items.map((i) => [i.num, i]));
  const toMap = new Map(toSnapshot.items.map((i) => [i.num, i]));

  const added = [];
  const retired = [];
  const changed = [];

  for (const [num, item] of toMap) {
    if (!fromMap.has(num)) {
      added.push({ num, name: item.name, category: item.category, price: item.prices.national ?? null });
    }
  }
  for (const [num, item] of fromMap) {
    if (!toMap.has(num)) {
      retired.push({ num, name: item.name, category: item.category });
    }
  }
  for (const [num, toItem] of toMap) {
    const fromItem = fromMap.get(num);
    if (!fromItem) continue;
    const oldPrice = fromItem.prices.national;
    const newPrice = toItem.prices.national;
    if (oldPrice === undefined || newPrice === undefined) continue; // not comparable (e.g. quote-only either side)
    if (oldPrice === newPrice) continue;
    const pct = oldPrice === 0 ? null : round1(((newPrice - oldPrice) / oldPrice) * 100);
    if (pct === null) continue; // can't express a meaningful % change from a zero base
    changed.push({ num, name: toItem.name, category: toItem.category, old: oldPrice, new: newPrice, pct });
  }

  added.sort((a, b) => a.num.localeCompare(b.num));
  retired.sort((a, b) => a.num.localeCompare(b.num));
  changed.sort((a, b) => a.num.localeCompare(b.num));

  const categories = new Set([...added, ...retired, ...changed].map((i) => i.category));
  const by_category = [...categories].sort().map((category) => {
    const changedInCategory = changed.filter((i) => i.category === category);
    return {
      category,
      changed: changedInCategory.length,
      added: added.filter((i) => i.category === category).length,
      retired: retired.filter((i) => i.category === category).length,
      median_pct: changedInCategory.length > 0 ? median(changedInCategory.map((i) => i.pct)) : 0,
    };
  });

  return { from: fromSnapshot.release, to: toSnapshot.release, added, retired, changed, by_category };
}

function buildDiffs(snapshots) {
  const diffs = [];
  for (let i = 0; i < snapshots.length - 1; i++) {
    diffs.push(diffReleasePair(snapshots[i], snapshots[i + 1]));
  }
  return diffs;
}

function buildFeed(feedJson) {
  const items = Array.isArray(feedJson?.items) ? feedJson.items : [];
  const sorted = [...items].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  return { items: sorted };
}

function computeAsOf(snapshots, law, context) {
  const dates = [
    ...snapshots.map((s) => s.fetched_at),
    law?.generated,
    context?.generated,
  ].filter(Boolean);
  if (dates.length === 0) return todayIso();
  return dates.sort().at(-1);
}

// Builds the full ndis.json value from data/ndis/* on disk, without writing
// anything. Exported so validate.mjs can regenerate in-memory and check the
// file on disk isn't stale.
export function deriveNdis() {
  const snapshots = loadSnapshots();
  const law = readJson(LAW_PATH, null);
  const feedJson = readJson(FEED_PATH, { items: [] });
  const context = readJson(CONTEXT_PATH, null);

  const releases = buildReleases(snapshots);
  const items = buildItems(snapshots);
  const diffs = buildDiffs(snapshots);

  return {
    meta: {
      title: TITLE,
      as_of: computeAsOf(snapshots, law, context),
      disclaimer: DISCLAIMER,
      methodology: METHODOLOGY,
      current_release: releases.length > 0 ? releases[releases.length - 1].release : null,
    },
    releases,
    items,
    diffs,
    law: law ?? {},
    feed: buildFeed(feedJson),
    context: context ?? {},
  };
}

function main() {
  const outputPath = process.argv[2] ?? DEFAULT_OUTPUT_PATH;
  const ndis = deriveNdis();
  writeJson(outputPath, ndis);
  console.log(
    `wrote ${outputPath} (${ndis.releases.length} releases, ${ndis.items.length} items, ${ndis.diffs.length} diffs, ` +
      `${ndis.feed.items.length} feed items)`
  );
}

// Only run when invoked directly (`node scripts/ndis/derive.mjs`), not when
// imported by validate.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

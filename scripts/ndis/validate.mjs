#!/usr/bin/env node
// Validates every file under data/ndis/ against the shapes in
// docs/ndis-spec.md. Zero dependencies, hand-rolled checks so failure
// messages stay specific. Also regenerates ndis.json in-memory and fails if
// it differs from the file on disk ("stale — run derive").
//
// Usage: node scripts/ndis/validate.mjs
//   Exits 0 (with a note) if data/ndis/ doesn't exist yet — nothing to
//   validate before the pipeline has run once.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isHttpUrl, isIsoDate, readJson } from './util.mjs';
import { deriveNdis } from './derive.mjs';

const NDIS_DIR = 'data/ndis';
const SNAPSHOTS_DIR = `${NDIS_DIR}/snapshots`;
const LAW_PATH = `${NDIS_DIR}/law.json`;
const FEED_PATH = `${NDIS_DIR}/feed.json`;
const CONTEXT_PATH = `${NDIS_DIR}/context.json`;
const NDIS_JSON_PATH = `${NDIS_DIR}/ndis.json`;
const BOUNDARIES_PATH = `${NDIS_DIR}/boundaries.json`;
const BOUNDARIES_MAX_BYTES = 300 * 1024;

// The 18 Census-only "No usual address (<state>)" / "Migratory - Offshore -
// Shipping (<state>)" CED codes (see scripts/ndis/build-boundaries.mjs's
// header comment for how this was verified against the ABS shapefile): they
// appear in context.json's electorates.rows (Census attributes a
// need/total to them) but carry no boundary geometry (null shape in the
// source shapefile), so boundaries.json legitimately has no path for them.
const NON_GEOGRAPHIC_CED_CODES = new Set([
  '194', '197', '294', '297', '394', '397', '494', '497',
  '594', '597', '694', '697', '794', '797', '894', '897', '994', '997',
]);

// Every value scripts/ndis/fetch-context.mjs can put in an electorates row's
// `state` field (8 real states/territories, via the CL_CED_2021 codelist's
// `parent` annotation, + "OT" for the 2 "Other Territories" Census
// catch-alls — see fetch-context.mjs's STATE_ID_TO_ABBR comment).
const KNOWN_ELECTORATE_STATES = new Set(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT', 'OT']);
// The subset that ever appears in the payments CSV's RsdsInStateCd (no OT
// row there) — what payments_by_state.rows is allowed to contain.
const REAL_STATE_CODES = new Set(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']);

const FEED_TYPES = ['pricing', 'law', 'bill', 'hearing', 'report', 'audit', 'announcement', 'data'];
const FEED_VERIFIED = ['confirmed', 'auto'];
const MAX_SUMMARY_WORDS = 40;

// --- generic helpers ---------------------------------------------------

function check(checks, name, issues) {
  checks.push({ name, issues });
}

function findDuplicates(values) {
  const seen = new Set();
  const dupes = new Set();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes];
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isFinitePositive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function isFiniteNonNegative(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

// --- snapshots ------------------------------------------------------------

function validateSnapshotFile(filename, snapshot, checks) {
  const label = `snapshots/${filename}`;
  const issues = [];

  if (!/^\d{4}-\d{2}(-v\d+(\.\d+)?)?$/.test(snapshot.release ?? '')) {
    issues.push(`${label}: release id "${snapshot.release}" doesn't match "<fy>-v<version>" (or "<fy>" when the source file carries no version)`);
  }
  if (`${snapshot.release}.json` !== filename) {
    issues.push(`${label}: filename doesn't match release id "${snapshot.release}"`);
  }
  if (!/^\d{4}-\d{2}$/.test(snapshot.fy ?? '')) issues.push(`${label}: bad fy "${snapshot.fy}"`);
  if (!isIsoDate(snapshot.effective)) issues.push(`${label}: effective is not an ISO date`);
  if (!isHttpUrl(snapshot.source_url)) issues.push(`${label}: source_url is not an http(s) URL`);
  if (typeof snapshot.source_filename !== 'string' || !snapshot.source_filename) {
    issues.push(`${label}: source_filename missing`);
  }
  if (!isIsoDate(snapshot.fetched_at)) issues.push(`${label}: fetched_at is not an ISO date`);
  if (!Array.isArray(snapshot.items) || snapshot.items.length === 0) {
    issues.push(`${label}: items must be a non-empty array`);
  }

  const nums = (snapshot.items ?? []).map((i) => i.num);
  for (const dup of findDuplicates(nums)) issues.push(`${label}: duplicate item num "${dup}"`);

  for (const item of snapshot.items ?? []) {
    const itemLabel = `${label} item "${item.num}"`;
    if (!item.num || typeof item.num !== 'string') issues.push(`${itemLabel}: num missing/invalid`);
    if (!item.name) issues.push(`${itemLabel}: name missing`);
    if (!Number.isInteger(item.category_num)) issues.push(`${itemLabel}: category_num is not an integer`);
    if (!item.category) issues.push(`${itemLabel}: category missing`);
    if (!item.reg_group) issues.push(`${itemLabel}: reg_group missing`);
    if (!item.unit) issues.push(`${itemLabel}: unit missing`);
    if (typeof item.quote !== 'boolean') issues.push(`${itemLabel}: quote must be a boolean`);
    if (!isIsoDate(item.start)) issues.push(`${itemLabel}: start is not an ISO date`);
    if (item.end !== null && !isIsoDate(item.end)) issues.push(`${itemLabel}: end must be null or an ISO date`);
    for (const [key, value] of Object.entries(item.prices ?? {})) {
      if (!isFinitePositive(value)) issues.push(`${itemLabel}: prices.${key} (${value}) is not a finite positive number`);
    }
  }

  check(checks, `${label}: shape`, issues);
}

function loadSnapshots(checks) {
  if (!existsSync(SNAPSHOTS_DIR)) return [];
  const files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith('.json')).sort();
  return files.map((f) => {
    const snapshot = readJson(`${SNAPSHOTS_DIR}/${f}`);
    validateSnapshotFile(f, snapshot, checks);
    return snapshot;
  });
}

// --- law.json ---------------------------------------------------------

function validateLaw(law, checks) {
  if (law === null) return;
  const issues = [];
  if (!isIsoDate(law.generated)) issues.push('law.json: generated is not an ISO date');

  for (const v of law.act_versions ?? []) {
    const label = `law.json act_versions[${v.register_id}]`;
    if (!Number.isInteger(v.compilation)) issues.push(`${label}: compilation is not an integer`);
    if (!v.register_id) issues.push(`${label}: register_id missing`);
    if (!isIsoDate(v.start)) issues.push(`${label}: start is not an ISO date`);
    if (!isHttpUrl(v.url)) issues.push(`${label}: url is not http(s)`);
  }

  const titleIds = (law.titles ?? []).map((t) => t.register_id);
  for (const dup of findDuplicates(titleIds)) issues.push(`law.json: duplicate title register_id "${dup}"`);

  for (const t of law.titles ?? []) {
    const label = `law.json titles[${t.register_id}]`;
    if (!t.register_id) issues.push(`${label}: register_id missing`);
    if (!t.name) issues.push(`${label}: name missing`);
    if (!t.collection) issues.push(`${label}: collection missing`);
    if (!t.status) issues.push(`${label}: status missing`);
    if (t.made !== null && t.made !== undefined && !isIsoDate(t.made)) issues.push(`${label}: made must be null or an ISO date`);
    if (t.registered !== null && t.registered !== undefined && !isIsoDate(t.registered)) {
      issues.push(`${label}: registered must be null or an ISO date`);
    }
    if (!isHttpUrl(t.url)) issues.push(`${label}: url is not http(s)`);
  }

  check(checks, 'law.json: shape', issues);
}

// --- feed.json --------------------------------------------------------

function validateFeed(feed, checks) {
  if (feed === null) return;
  const issues = [];
  const items = Array.isArray(feed.items) ? feed.items : [];

  // Note: source.url is NOT required to be unique — e.g. several bill-stage
  // updates or quarterly-report announcements legitimately cite the same hub
  // page. Only `id` must be unique (per docs/ndis-spec.md's feed.json shape).
  for (const dup of findDuplicates(items.map((i) => i.id))) issues.push(`feed.json: duplicate id "${dup}"`);

  for (const item of items) {
    const label = `feed.json item "${item.id}"`;
    if (!/^\d{4}-\d{2}-\d{2}-.+/.test(item.id ?? '')) issues.push(`${label}: id doesn't match "<date>-<slug>"`);
    if (!isIsoDate(item.date)) issues.push(`${label}: date is not an ISO date`);
    if (!FEED_TYPES.includes(item.type)) issues.push(`${label}: invalid type "${item.type}"`);
    if (!item.title) issues.push(`${label}: title missing`);
    if (!item.source || !item.source.title) issues.push(`${label}: source.title missing`);
    if (!isHttpUrl(item.source?.url)) issues.push(`${label}: source.url is not http(s)`);
    if (!item.source || !item.source.publisher) issues.push(`${label}: source.publisher missing`);
    if (!FEED_VERIFIED.includes(item.verified)) issues.push(`${label}: invalid verified "${item.verified}"`);

    if (item.verified === 'auto' && item.summary !== undefined) {
      issues.push(`${label}: auto items must not have a summary`);
    }
    if (item.summary !== undefined) {
      if (typeof item.summary !== 'string') issues.push(`${label}: summary must be a string`);
      else if (wordCount(item.summary) > MAX_SUMMARY_WORDS) {
        issues.push(`${label}: summary is ${wordCount(item.summary)} words (max ${MAX_SUMMARY_WORDS})`);
      }
    }
  }

  check(checks, 'feed.json: shape', issues);
}

// --- context.json -------------------------------------------------------

function validateContext(context, checks) {
  if (context === null) return;
  const issues = [];
  if (!isIsoDate(context.generated)) issues.push('context.json: generated is not an ISO date');

  if (context.quarterly) {
    const q = context.quarterly;
    if (!isIsoDate(q.as_of_quarter)) issues.push('context.json quarterly: as_of_quarter is not an ISO date');
    if (!isHttpUrl(q.source?.url)) issues.push('context.json quarterly: source.url is not http(s)');
    for (const row of q.by_quarter ?? []) {
      const label = `context.json quarterly.by_quarter[${row.quarter}]`;
      if (!isIsoDate(row.quarter)) issues.push(`${label}: quarter is not an ISO date`);
      if (!isFiniteNonNegative(row.payments_total)) issues.push(`${label}: payments_total is not a finite non-negative number`);
      if (row.participants !== null && !Number.isInteger(row.participants)) {
        issues.push(`${label}: participants must be null or an integer`);
      }
    }
    for (const cat of q.top_categories_latest ?? []) {
      const label = `context.json quarterly.top_categories_latest[${cat.category}]`;
      if (!cat.category) issues.push(`${label}: category missing`);
      if (!isFiniteNonNegative(cat.payments)) issues.push(`${label}: payments is not a finite non-negative number`);
      if (typeof cat.share !== 'number' || cat.share < 0 || cat.share > 1) {
        issues.push(`${label}: share must be a number between 0 and 1`);
      }
    }
  }

  if (context.abs) {
    const ca = context.abs.census_assistance;
    if (ca) {
      if (!ca.label) issues.push('context.json abs.census_assistance: label missing');
      if (!Number.isInteger(ca.value) || ca.value < 0) issues.push('context.json abs.census_assistance: value is not a non-negative integer');
      if (!isHttpUrl(ca.source?.url)) issues.push('context.json abs.census_assistance: source.url is not http(s)');
    }
    const sdac = context.abs.sdac;
    if (sdac) {
      if (!sdac.label) issues.push('context.json abs.sdac: label missing');
      if (typeof sdac.value_pct !== 'number' || sdac.value_pct < 0 || sdac.value_pct > 100) {
        issues.push('context.json abs.sdac: value_pct must be a number between 0 and 100');
      }
      if (!isIsoDate(sdac.released)) issues.push('context.json abs.sdac: released is not an ISO date');
      if (!isHttpUrl(sdac.source?.url)) issues.push('context.json abs.sdac: source.url is not http(s)');
    }
  }

  for (const nd of context.next_data ?? []) {
    const label = `context.json next_data[${nd.label}]`;
    if (!nd.label) issues.push(`${label}: label missing`);
    if (!isIsoDate(nd.due)) issues.push(`${label}: due is not an ISO date`);
  }

  if (context.cpi) {
    if (!isHttpUrl(context.cpi.source?.url)) issues.push('context.json cpi: source.url is not http(s)');
    for (const p of context.cpi.series ?? []) {
      const label = `context.json cpi.series[${p.quarter}]`;
      if (!isIsoDate(p.quarter)) issues.push(`${label}: quarter is not an ISO date`);
      if (typeof p.index !== 'number' || !Number.isFinite(p.index)) issues.push(`${label}: index is not a finite number`);
    }
  }

  if (context.payments_by_category) {
    const pbc = context.payments_by_category;
    if (!isIsoDate(pbc.as_of_quarter)) issues.push('context.json payments_by_category: as_of_quarter is not an ISO date');
    if (!isHttpUrl(pbc.source?.url)) issues.push('context.json payments_by_category: source.url is not http(s)');

    const categoryNames = (pbc.rows ?? []).map((r) => r.category);
    for (const dup of findDuplicates(categoryNames)) {
      issues.push(`context.json payments_by_category: duplicate category "${dup}"`);
    }

    for (const row of pbc.rows ?? []) {
      const label = `context.json payments_by_category.rows[${row.category}]`;
      if (!row.category) issues.push(`${label}: category missing`);
      if (row.catalogue_category !== null && typeof row.catalogue_category !== 'string') {
        issues.push(`${label}: catalogue_category must be a string or null`);
      }
      if (typeof row.payments !== 'number' || !Number.isFinite(row.payments)) {
        issues.push(`${label}: payments is not a finite number`);
      }
      if (row.participants !== undefined && !Number.isInteger(row.participants)) {
        issues.push(`${label}: participants must be an integer when present`);
      }
      if (
        row.avg_per_participant !== undefined &&
        (typeof row.avg_per_participant !== 'number' || !Number.isFinite(row.avg_per_participant))
      ) {
        issues.push(`${label}: avg_per_participant must be a finite number when present`);
      }
    }
  }

  if (context.payments_by_state) {
    const pbs = context.payments_by_state;
    if (!isIsoDate(pbs.as_of_quarter)) issues.push('context.json payments_by_state: as_of_quarter is not an ISO date');
    if (!isHttpUrl(pbs.source?.url)) issues.push('context.json payments_by_state: source.url is not http(s)');
    if (typeof pbs.national_total !== 'number' || !Number.isFinite(pbs.national_total)) {
      issues.push('context.json payments_by_state: national_total is not a finite number');
    }
    if (typeof pbs.delta_pct !== 'number' || !Number.isFinite(pbs.delta_pct) || pbs.delta_pct < 0) {
      issues.push('context.json payments_by_state: delta_pct is not a non-negative finite number');
    } else if (pbs.delta_pct > 2) {
      issues.push(`context.json payments_by_state: delta_pct ${pbs.delta_pct} exceeds the 2% cross-check budget — should have been omitted`);
    }

    const stateNames = (pbs.rows ?? []).map((r) => r.state);
    for (const dup of findDuplicates(stateNames)) issues.push(`context.json payments_by_state: duplicate state "${dup}"`);
    for (const row of pbs.rows ?? []) {
      const label = `context.json payments_by_state.rows[${row.state}]`;
      if (!REAL_STATE_CODES.has(row.state)) issues.push(`${label}: state "${row.state}" is not a recognised state/territory code`);
      if (typeof row.payments !== 'number' || !Number.isFinite(row.payments)) issues.push(`${label}: payments is not a finite number`);
    }
    if (pbs.rows && pbs.rows.length > 0) {
      const sum = pbs.rows.reduce((acc, r) => acc + (typeof r.payments === 'number' ? r.payments : 0), 0);
      const actualDeltaPct = pbs.national_total ? (Math.abs(sum - pbs.national_total) / pbs.national_total) * 100 : null;
      if (actualDeltaPct !== null && Math.round(actualDeltaPct * 1000) / 1000 !== pbs.delta_pct) {
        issues.push(`context.json payments_by_state: delta_pct ${pbs.delta_pct} doesn't match recomputed Δ ${actualDeltaPct.toFixed(3)}%`);
      }
    }
  }

  if (context.electorates) {
    const e = context.electorates;
    if (!e.label) issues.push('context.json electorates: label missing');
    if (!isHttpUrl(e.source?.url)) issues.push('context.json electorates: source.url is not http(s)');
    if (typeof e.national_total !== 'number' || !Number.isFinite(e.national_total)) {
      issues.push('context.json electorates: national_total missing or not a finite number');
    }

    const electorateNames = (e.rows ?? []).map((r) => r.name);
    for (const dup of findDuplicates(electorateNames)) {
      issues.push(`context.json electorates: duplicate electorate name "${dup}"`);
    }

    for (const row of e.rows ?? []) {
      const label = `context.json electorates.rows[${row.name}]`;
      if (!row.name) issues.push(`${label}: name missing`);
      if (!row.code) issues.push(`${label}: code missing`);
      if (typeof row.need !== 'number' || !Number.isFinite(row.need)) issues.push(`${label}: need is not a finite number`);
      if (row.state !== undefined && !KNOWN_ELECTORATE_STATES.has(row.state)) {
        issues.push(`${label}: state "${row.state}" is not a recognised state/territory code`);
      }
      if (row.total !== undefined && (!Number.isInteger(row.total) || row.total < 0)) {
        issues.push(`${label}: total must be a non-negative integer when present`);
      }
      if (row.share !== undefined) {
        if (typeof row.share !== 'number' || row.share < 0 || row.share > 1) {
          issues.push(`${label}: share must be a number between 0 and 1 when present`);
        }
        if (row.total === undefined) issues.push(`${label}: share present without total`);
      }
      if (row.total !== undefined && row.share === undefined) issues.push(`${label}: total present without share`);
    }
  }

  check(checks, 'context.json: shape', issues);
}

// --- boundaries.json (static, generated once by build-boundaries.mjs) ---

const VIEWBOX_RE = /^-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?$/;
const PATH_D_RE = /^M-?\d/;

function isWellFormedViewBox(vb) {
  if (typeof vb !== 'string' || !VIEWBOX_RE.test(vb)) return false;
  const [, , w, h] = vb.split(/\s+/).map(Number);
  return w > 0 && h > 0;
}

function validateBoundaries(boundaries, context, checks) {
  if (boundaries === null) return;
  const issues = [];

  const meta = boundaries.meta ?? {};
  if (!isHttpUrl(meta.source?.url)) issues.push('boundaries.json meta: source.url is not http(s)');
  if (!meta.source?.title) issues.push('boundaries.json meta: source.title missing');
  if (!meta.source?.publisher) issues.push('boundaries.json meta: source.publisher missing');
  if (!meta.licence) issues.push('boundaries.json meta: licence missing');
  if (!isIsoDate(meta.generated)) issues.push('boundaries.json meta: generated is not an ISO date');
  if (typeof meta.simplification !== 'string' || !meta.simplification) issues.push('boundaries.json meta: simplification missing');
  if (typeof meta.projection !== 'string' || !meta.projection) issues.push('boundaries.json meta: projection missing');
  if (!isWellFormedViewBox(meta.viewBox)) issues.push(`boundaries.json meta: viewBox "${meta.viewBox}" is not well-formed`);

  const insetIds = (boundaries.insets ?? []).map((i) => i.id);
  for (const dup of findDuplicates(insetIds)) issues.push(`boundaries.json: duplicate inset id "${dup}"`);
  for (const inset of boundaries.insets ?? []) {
    const label = `boundaries.json insets[${inset.id}]`;
    if (!inset.id) issues.push(`${label}: id missing`);
    if (!inset.label) issues.push(`${label}: label missing`);
    if (!isWellFormedViewBox(inset.viewBox)) issues.push(`${label}: viewBox "${inset.viewBox}" is not well-formed`);
  }

  const paths = boundaries.paths ?? {};
  const pathCodes = Object.keys(paths);
  if (pathCodes.length === 0) issues.push('boundaries.json: paths is empty');
  for (const [code, d] of Object.entries(paths)) {
    if (typeof d !== 'string' || d.length === 0 || !PATH_D_RE.test(d)) {
      issues.push(`boundaries.json paths["${code}"]: empty or malformed path data`);
    }
  }

  // Code coverage against context.json electorates.rows: every path must
  // match a row (no stray codes), and every row without a path must be one
  // of the known non-geographic Census catch-alls (see NON_GEOGRAPHIC_CED_CODES) —
  // not a strict 169-vs-169 bijection, since those 18 codes have no boundary
  // geometry in the source shapefile (verified, not assumed).
  if (context?.electorates?.rows) {
    const electorateCodes = new Set(context.electorates.rows.map((r) => r.code));
    for (const code of pathCodes) {
      if (!electorateCodes.has(code)) issues.push(`boundaries.json paths: code "${code}" has no matching context.json electorates row`);
    }
    const missingPath = context.electorates.rows.filter((r) => !paths[r.code]);
    for (const row of missingPath) {
      if (!NON_GEOGRAPHIC_CED_CODES.has(row.code)) {
        issues.push(`boundaries.json paths: electorates row "${row.name}" (${row.code}) has no path and isn't a known non-geographic code`);
      }
    }
    const expectedPathCount = context.electorates.rows.length - NON_GEOGRAPHIC_CED_CODES.size;
    if (pathCodes.length !== expectedPathCount) {
      issues.push(
        `boundaries.json paths: ${pathCodes.length} paths, expected ${expectedPathCount} ` +
          `(${context.electorates.rows.length} electorate rows − ${NON_GEOGRAPHIC_CED_CODES.size} known non-geographic codes)`
      );
    }
  }

  if (existsSync(BOUNDARIES_PATH)) {
    const bytes = statSync(BOUNDARIES_PATH).size;
    if (bytes > BOUNDARIES_MAX_BYTES) {
      issues.push(`boundaries.json: ${bytes} bytes exceeds the ${BOUNDARIES_MAX_BYTES}-byte (300 KB) budget`);
    }
  }

  check(checks, 'boundaries.json: shape', issues);
}

// --- ndis.json (derived) -----------------------------------------------

function validateNdis(ndis, snapshots, checks) {
  if (ndis === null) return;
  const issues = [];

  if (!ndis.meta || typeof ndis.meta.title !== 'string') issues.push('ndis.json meta: title missing');
  if (!isIsoDate(ndis.meta?.as_of)) issues.push('ndis.json meta: as_of is not an ISO date');
  if (typeof ndis.meta?.disclaimer !== 'string' || !ndis.meta.disclaimer) issues.push('ndis.json meta: disclaimer missing');
  if (typeof ndis.meta?.methodology !== 'string' || !ndis.meta.methodology) issues.push('ndis.json meta: methodology missing');

  const releases = ndis.releases ?? [];
  for (let i = 1; i < releases.length; i++) {
    if (releases[i - 1].effective > releases[i].effective) {
      issues.push(`ndis.json releases: not ascending by effective at index ${i}`);
    }
  }
  if (releases.length > 0 && ndis.meta?.current_release !== releases[releases.length - 1].release) {
    issues.push('ndis.json meta.current_release does not match the latest release');
  }
  if (releases.length === 0 && ndis.meta?.current_release !== null) {
    issues.push('ndis.json meta.current_release should be null when there are no releases');
  }

  const itemNums = (ndis.items ?? []).map((i) => i.num);
  for (const dup of findDuplicates(itemNums)) issues.push(`ndis.json items: duplicate num "${dup}"`);
  const sortedNums = [...itemNums].sort();
  if (JSON.stringify(itemNums) !== JSON.stringify(sortedNums)) issues.push('ndis.json items: not sorted by num');

  for (const item of ndis.items ?? []) {
    const label = `ndis.json items["${item.num}"]`;
    if (!Array.isArray(item.history) || item.history.length !== releases.length) {
      issues.push(`${label}: history length (${item.history?.length}) !== releases length (${releases.length})`);
    }
    if (!Array.isArray(item.spread) || item.spread.length !== releases.length) {
      issues.push(`${label}: spread length (${item.spread?.length}) !== releases length (${releases.length})`);
    }
  }

  const diffs = ndis.diffs ?? [];
  if (diffs.length !== Math.max(0, releases.length - 1)) {
    issues.push(`ndis.json diffs: expected ${Math.max(0, releases.length - 1)} entries, found ${diffs.length}`);
  }
  for (let i = 0; i < diffs.length; i++) {
    if (releases[i] && diffs[i].from !== releases[i].release) issues.push(`ndis.json diffs[${i}]: from !== releases[${i}].release`);
    if (releases[i + 1] && diffs[i].to !== releases[i + 1].release) issues.push(`ndis.json diffs[${i}]: to !== releases[${i + 1}].release`);
    if (i > 0 && diffs[i].from !== diffs[i - 1].to) issues.push(`ndis.json diffs[${i}]: not consecutive with diffs[${i - 1}]`);
    for (const c of diffs[i].changed ?? []) {
      const expectedPct = c.old === 0 ? null : Math.round(((c.new - c.old) / c.old) * 1000) / 10;
      if (expectedPct !== null && c.pct !== expectedPct) {
        issues.push(`ndis.json diffs[${i}] changed["${c.num}"]: pct ${c.pct} !== expected ${expectedPct}`);
      }
    }
  }

  check(checks, 'ndis.json: shape', issues);

  // Regenerate in-memory and compare — "ndis.json is stale — run derive".
  // (derive.mjs is fully deterministic — same input files always produce the
  // same output — so any difference here means data/ndis/*.json changed
  // since ndis.json was last written.)
  const fresh = deriveNdis();
  const staleIssues = [];
  if (JSON.stringify(fresh) !== JSON.stringify(ndis)) {
    staleIssues.push('ndis.json is stale — run derive (a fresh `node scripts/ndis/derive.mjs` run produces different output)');
  }
  check(checks, 'ndis.json: matches a fresh derive run', staleIssues);
}

// --- main -----------------------------------------------------------

function main() {
  if (!existsSync(NDIS_DIR)) {
    console.log(`${NDIS_DIR}/ does not exist yet — nothing to validate (run the fetch-*.mjs scripts first).`);
    process.exit(0);
  }

  const checks = [];
  const snapshots = loadSnapshots(checks);
  const law = readJson(LAW_PATH, null);
  const feed = readJson(FEED_PATH, null);
  const context = readJson(CONTEXT_PATH, null);
  const ndis = readJson(NDIS_JSON_PATH, null);
  const boundaries = readJson(BOUNDARIES_PATH, null);

  validateLaw(law, checks);
  validateFeed(feed, checks);
  validateContext(context, checks);
  validateBoundaries(boundaries, context, checks);
  validateNdis(ndis, snapshots, checks);

  console.log(`Validating ${resolve(NDIS_DIR)}\n`);
  let failed = false;
  for (const c of checks) {
    if (c.issues.length === 0) {
      console.log(`✓ ${c.name}`);
    } else {
      failed = true;
      console.log(`✗ ${c.name} (${c.issues.length})`);
      for (const issue of c.issues) console.log(`    - ${issue}`);
    }
  }
  console.log('');

  if (failed) {
    console.log('FAIL');
    process.exit(1);
  }

  const feedItemCount = feed?.items?.length ?? 0;
  const confirmedCount = (feed?.items ?? []).filter((i) => i.verified === 'confirmed').length;
  console.log(
    `PASS — ${snapshots.length} snapshots, ${law?.titles?.length ?? 0} law titles, ` +
      `${feedItemCount} feed items (${confirmedCount} confirmed), ` +
      `${ndis?.items?.length ?? 0} tracked items, ${ndis?.diffs?.length ?? 0} diffs, ` +
      `boundaries: ${boundaries ? `${Object.keys(boundaries.paths ?? {}).length} paths, ${boundaries.insets?.length ?? 0} insets` : 'absent'}`
  );
}

main();

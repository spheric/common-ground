// Shared "XLSX buffer -> snapshot" logic used by both fetch-catalogue.mjs
// (downloads the current release) and ingest-file.mjs (reads a local file).
// Not part of the spec's file list — split out purely to avoid duplicating
// ~150 lines of column-mapping between the two entry points.
//
// The Support Catalogue's exact header text could not be verified against a
// real 2026-27 file (ndis.gov.au is Cloudflare-blocked in this environment —
// see the fetch-catalogue.mjs soft-fail path). Column matching below is
// case-insensitive/whitespace-tolerant and based on the column facts stated
// in docs/ndis-spec.md's "Verified source facts" section, cross-checked
// against a real (if third-party-reformatted) 2021-22 catalogue export. It
// fails loudly (throws) rather than silently mis-mapping when a required
// column can't be found — never guesses at data.

import { readSheet } from './xlsx.mjs';
import { round2 } from './util.mjs';

const SHEET_NAME = 'Current Support Items';

const STATE_KEYS = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];

function normalizeHeader(h) {
  return String(h ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

// Finds the column index whose normalized header matches any of `candidates`
// (normalized the same way). Returns -1 if none found.
function findColumn(headerRow, candidates) {
  const wanted = new Set(candidates.map(normalizeHeader));
  return headerRow.findIndex((h) => wanted.has(normalizeHeader(h)));
}

function requireColumn(headerRow, candidates, label) {
  const idx = findColumn(headerRow, candidates);
  if (idx === -1) {
    throw new Error(
      `catalogue: required column not found (looked for: ${candidates.join(' / ')}) — needed for "${label}"`
    );
  }
  return idx;
}

function cellAt(row, idx) {
  return idx === -1 || idx === undefined ? undefined : row[idx];
}

function isBlank(raw) {
  return raw === undefined || raw === null || String(raw).trim() === '';
}

function parseStrictNumber(raw, context) {
  const s = String(raw).trim().replace(/^\$/, '').replace(/,/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`catalogue: could not parse numeric value "${raw}" (${context})`);
  return n;
}

// YYYYMMDD integer/string -> "YYYY-MM-DD"; sentinel 99991231 -> null.
function parseYyyymmdd(raw, context) {
  const s = String(raw).trim();
  if (isBlank(s)) return null;
  if (!/^\d{8}$/.test(s)) throw new Error(`catalogue: bad date "${raw}" (expected YYYYMMDD) (${context})`);
  if (s === '99991231') return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// Deterministic mode with lowest-value tie-break (documented assumption —
// the spec doesn't specify a tie-break rule).
function modalValue(nums) {
  const counts = new Map();
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  let best = null;
  let bestCount = -1;
  for (const n of [...counts.keys()].sort((a, b) => a - b)) {
    const c = counts.get(n);
    if (c > bestCount) {
      bestCount = c;
      best = n;
    }
  }
  return best;
}

// item.num convention is stable and documented: "<category>_<code>_<reg group>_<x>_<y>",
// e.g. "01_011_0107_1_1" -> category 1, reg group "0107". Used only as a
// fallback when a dedicated column isn't present.
function categoryNumFromItemNum(num) {
  const seg = num.split('_')[0];
  const n = parseInt(seg, 10);
  return Number.isFinite(n) ? n : null;
}

function regGroupFromItemNum(num) {
  const seg = num.split('_')[2];
  return seg && /^\d+$/.test(seg) ? seg : null;
}

function normalizeRegGroup(raw) {
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return s.padStart(4, '0');
  return s;
}

function buildColumnIndex(headerRow) {
  return {
    num: requireColumn(headerRow, ['Support Item Number'], 'num'),
    name: requireColumn(headerRow, ['Support Item Name'], 'name'),
    category: requireColumn(headerRow, ['Support Category Name'], 'category'),
    categoryNum: findColumn(headerRow, ['Support Category Number']),
    regGroup: findColumn(headerRow, ['Registration Group Number']),
    unit: requireColumn(headerRow, ['Unit'], 'unit'),
    quote: findColumn(headerRow, ['Quote']),
    type: findColumn(headerRow, ['Type']),
    start: requireColumn(headerRow, ['Start Date'], 'start'),
    end: requireColumn(headerRow, ['End Date'], 'end'),
    geo: Object.fromEntries(
      [...STATE_KEYS, 'P01', 'P02', 'REMOTE', 'VERY REMOTE', 'NATIONAL']
        .map((key) => [key, findColumn(headerRow, [key])])
        .filter(([, idx]) => idx !== -1)
    ),
  };
}

function rowToItem(row, cols, rowNumberForErrors) {
  const ctx = `row ${rowNumberForErrors}`;
  const num = String(cellAt(row, cols.num) ?? '').trim();
  if (!num) return null; // blank trailing row

  const name = String(cellAt(row, cols.name) ?? '').trim();
  const category = String(cellAt(row, cols.category) ?? '').trim();
  if (!name) throw new Error(`catalogue: item "${num}" has no name (${ctx})`);
  if (!category) throw new Error(`catalogue: item "${num}" has no category (${ctx})`);

  const categoryNumRaw = cellAt(row, cols.categoryNum);
  const category_num = !isBlank(categoryNumRaw)
    ? parseInt(String(categoryNumRaw).trim(), 10)
    : categoryNumFromItemNum(num);
  if (!Number.isFinite(category_num)) {
    throw new Error(`catalogue: item "${num}" has no usable category number (${ctx})`);
  }

  const regGroupRaw = cellAt(row, cols.regGroup);
  const reg_group = !isBlank(regGroupRaw) ? normalizeRegGroup(regGroupRaw) : regGroupFromItemNum(num);
  if (!reg_group) throw new Error(`catalogue: item "${num}" has no usable registration group (${ctx})`);

  const unit = String(cellAt(row, cols.unit) ?? '').trim();
  if (!unit) throw new Error(`catalogue: item "${num}" has no unit (${ctx})`);

  const quoteRaw = cellAt(row, cols.quote);
  const typeRaw = String(cellAt(row, cols.type) ?? '');
  let quote;
  if (!isBlank(quoteRaw)) {
    quote = String(quoteRaw).trim().toUpperCase() === 'Y';
  } else if (typeRaw) {
    quote = /quote/i.test(typeRaw);
  } else {
    quote = false;
  }

  const start = parseYyyymmdd(cellAt(row, cols.start), `${ctx}, start date`);
  if (!start) throw new Error(`catalogue: item "${num}" has no start date (${ctx})`);
  const end = parseYyyymmdd(cellAt(row, cols.end), `${ctx}, end date`);

  const prices = {};

  const presentStates = STATE_KEYS.filter((k) => cols.geo[k] !== undefined)
    .map((k) => cellAt(row, cols.geo[k]))
    .filter((raw) => !isBlank(raw))
    .map((raw) => parseStrictNumber(raw, `${ctx}, state price`));
  if (presentStates.length > 0) {
    const min = Math.min(...presentStates);
    const max = Math.max(...presentStates);
    prices.national = round2(modalValue(presentStates));
    if (min !== max) {
      prices.state_min = round2(min);
      prices.state_max = round2(max);
    }
  }

  if (cols.geo.NATIONAL !== undefined) {
    const raw = cellAt(row, cols.geo.NATIONAL);
    if (!isBlank(raw)) prices.national = round2(parseStrictNumber(raw, `${ctx}, national price`));
  }

  const remoteIdx = cols.geo.REMOTE ?? cols.geo.P01;
  if (remoteIdx !== undefined) {
    const raw = cellAt(row, remoteIdx);
    if (!isBlank(raw)) prices.remote = round2(parseStrictNumber(raw, `${ctx}, remote price`));
  }
  const veryRemoteIdx = cols.geo['VERY REMOTE'] ?? cols.geo.P02;
  if (veryRemoteIdx !== undefined) {
    const raw = cellAt(row, veryRemoteIdx);
    if (!isBlank(raw)) prices.very_remote = round2(parseStrictNumber(raw, `${ctx}, very remote price`));
  }

  return { num, name, category_num, category, reg_group, unit, quote, start, end, prices };
}

// string[][] (header row + data rows) -> items[] (sorted by num). Shared by
// both the XLSX path (rows from xlsx.mjs) and the CSV path (rows from a
// hand-rolled CSV parser) — the two 2019-20/2020-21 archive releases ship as
// CSV rather than XLSX (see docs/ndis-spec.md §Seeding scope).
export function itemsFromRows(rows) {
  if (rows.length === 0) throw new Error('catalogue: sheet/file is empty');
  const headerRow = rows[0];
  const cols = buildColumnIndex(headerRow);

  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const item = rowToItem(row, cols, i + 1);
    if (item) items.push(item);
  }
  if (items.length === 0) throw new Error('catalogue: no items parsed — check sheet/column mapping');

  items.sort((a, b) => (a.num < b.num ? -1 : a.num > b.num ? 1 : 0));

  // The NDIA's own files occasionally contain byte-identical duplicate rows
  // (seen in 2024-25 and 2025-26). Collapse exact duplicates; a repeated num
  // with DIFFERENT data is a real ambiguity and must fail loudly.
  const deduped = [];
  for (const item of items) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.num === item.num) {
      if (JSON.stringify(prev) !== JSON.stringify(item)) {
        throw new Error(`catalogue: item num "${item.num}" appears twice with different data`);
      }
      continue;
    }
    deduped.push(item);
  }
  return deduped;
}

// buffer -> items[], reading only the "Current Support Items" sheet.
export function parseCatalogueItems(buffer) {
  return itemsFromRows(readSheet(buffer, SHEET_NAME));
}

// Derives { fy, version, release } from a source filename like
// "NDIS-Support-Catalogue-2026-27 v1_1.xlsx".
export function deriveReleaseId(filename) {
  const fyMatch = filename.match(/(\d{4})-(\d{2})\b/);
  if (!fyMatch) throw new Error(`catalogue: could not find a financial year in filename "${filename}"`);
  const fy = `${fyMatch[1]}-${fyMatch[2]}`;

  // Some archived files carry no version in their filename (e.g. the NDIA's
  // own "NDIS Support Catalogue 2025-26.xlsx"). Recording a guessed version
  // would violate the accuracy rule, so version is null and the release id is
  // the financial year alone.
  const verMatch = filename.match(/v(\d+)[._](\d+)/i) ?? filename.match(/v(\d+)/i);
  if (!verMatch) return { fy, version: null, release: fy };
  const version = verMatch[2] !== undefined ? `${verMatch[1]}.${verMatch[2]}` : `${verMatch[1]}.0`;

  return { fy, version, release: `${fy}-v${version}` };
}

// The release's effective date: the modal `start` date across items (the
// date most items in the release actually start on), falling back to
// 1 July of the release's financial year if that can't be determined.
export function deriveEffectiveDate(items, fy) {
  const starts = items.map((i) => i.start).filter(Boolean);
  if (starts.length > 0) {
    const counts = new Map();
    for (const s of starts) counts.set(s, (counts.get(s) ?? 0) + 1);
    let best = null;
    let bestCount = -1;
    for (const s of [...counts.keys()].sort()) {
      const c = counts.get(s);
      if (c > bestCount) {
        bestCount = c;
        best = s;
      }
    }
    return best;
  }
  return `${fy.slice(0, 4)}-07-01`;
}

export function buildSnapshot({ buffer, sourceUrl, sourceFilename, fetchedAt }) {
  const items = parseCatalogueItems(buffer);
  const { fy, version, release } = deriveReleaseId(sourceFilename);
  const effective = deriveEffectiveDate(items, fy);
  return {
    release,
    fy,
    version,
    effective,
    source_url: sourceUrl,
    source_filename: sourceFilename,
    fetched_at: fetchedAt,
    items,
  };
}

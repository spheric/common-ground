#!/usr/bin/env node
// Turns a LOCAL catalogue file (XLSX or CSV — the manual/agent fallback when
// fetch-catalogue.mjs is Cloudflare-blocked, and the only path for the
// 2019-20/2020-21 archive releases which ship as CSV) into a normalised
// snapshot at data/ndis/snapshots/<release>.json.
//
// Usage: node scripts/ndis/ingest-file.mjs <path/to/file.xlsx|.csv> [--source-url=<url>]

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { readSheet } from './xlsx.mjs';
import { itemsFromRows, deriveReleaseId, deriveEffectiveDate } from './catalogue.mjs';
import { parseCsv, todayIso, writeJson } from './util.mjs';

const SHEET_NAME = 'Current Support Items';
const SNAPSHOTS_DIR = 'data/ndis/snapshots';

function parseArgs(argv) {
  const positional = [];
  let sourceUrl = null;
  for (const arg of argv) {
    const m = /^--source-url=(.+)$/.exec(arg);
    if (m) sourceUrl = m[1];
    else positional.push(arg);
  }
  if (positional.length !== 1) {
    console.error('usage: node scripts/ndis/ingest-file.mjs <path/to/file.xlsx|.csv> [--source-url=<url>]');
    process.exit(1);
  }
  return { filePath: positional[0], sourceUrl };
}

function rowsFromFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.xlsx') {
    const buffer = readFileSync(filePath);
    return readSheet(buffer, SHEET_NAME);
  }
  if (ext === '.csv') {
    const text = readFileSync(filePath, 'utf8');
    return parseCsv(text);
  }
  throw new Error(`unsupported file extension "${ext}" — expected .xlsx or .csv`);
}

function main() {
  const { filePath, sourceUrl } = parseArgs(process.argv.slice(2));
  if (!existsSync(filePath)) {
    console.error(`error: file not found: ${filePath}`);
    process.exit(1);
  }

  const filename = basename(filePath);
  let items;
  try {
    items = itemsFromRows(rowsFromFile(filePath));
  } catch (err) {
    console.error(`error: could not parse "${filePath}": ${err.message}`);
    process.exit(1);
  }

  let fy, version, release;
  try {
    ({ fy, version, release } = deriveReleaseId(filename));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  const snapshot = {
    release,
    fy,
    version,
    effective: deriveEffectiveDate(items, fy),
    source_url: sourceUrl ?? `local-file:${filename}`,
    source_filename: filename,
    fetched_at: todayIso(),
    items,
  };

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const snapshotPath = `${SNAPSHOTS_DIR}/${release}.json`;
  const isNewRelease = !existsSync(snapshotPath);
  writeJson(snapshotPath, snapshot);

  console.log(
    `wrote ${snapshotPath} (${items.length} items, release ${release}` +
      `${isNewRelease ? ', new release' : ', updated existing release'})`
  );
  if (!sourceUrl) {
    console.log(
      `note: no --source-url given — source_url set to "local-file:${filename}". ` +
        `Re-run with --source-url=<official download URL> if known, for citation accuracy.`
    );
  }
}

main();

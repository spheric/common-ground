#!/usr/bin/env node
// ONE-OFF, zero-dependency generator for data/ndis/boundaries.json — NOT part
// of any scheduled workflow (docs/ndis-spec.md: "static, committed; NOT part
// of the weekly refresh"). Run manually and commit the result:
//
//   node scripts/ndis/build-boundaries.mjs
//
// Downloads the ABS ASGS Edition 3 "Commonwealth Electoral Divisions — 2021"
// digital boundary shapefile (the CL_CED_2021 vintage — matches the codes in
// data/ndis/context.json's electorates block, NOT current AEC redistribution
// boundaries), parses the .shp/.dbf directly (no shapefile library), filters
// to the 151 real electorates (dropping 18 non-geographic Census catchall
// codes + "Outside Australia" — see FILTERING below), simplifies, projects,
// quantises, and writes a compact GeoJSON-free path atlas.
//
// FILTERING (verified against the downloaded file, not guessed): the
// shapefile carries 170 records. 151 are real electoral divisions (shape
// type 5, polygon). The other 19 are Census-only statistical catch-alls with
// a NULL shape (type 0, zero AREASQKM21) — "No usual address (<state>)" and
// "Migratory - Offshore - Shipping (<state>)" for each of the 8
// states/territories + "Other Territories" (18 codes), plus "Outside
// Australia" (ZZZ, not part of the CL_CED_2021 codelist at all). Those 18
// codes DO appear in context.json's electorates.rows (Census attributes a
// need/total count to them) but have no boundary to draw — the spec's "keep
// exactly the codes present in context.json electorates rows" is read
// together with "filter out non-geographic codes" to mean: boundaries.json's
// path set is real-geometry codes ∩ context.json codes, which this file
// verified is exactly the 151 real divisions (151 ⊆ 169, zero mismatches).
// scripts/ndis/validate.mjs's boundaries check is written against that
// reality, not a strict 169↔169 bijection — see its comment.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { readJson, writeJson } from './util.mjs';

const SHP_ZIP_URL =
  'https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-3-july-2021-june-2026/access-and-downloads/digital-boundary-files/CED_2021_AUST_GDA2020_SHP.zip';
const SOURCE_TITLE = 'ABS ASGS Ed 3 CED 2021 digital boundaries';
const SOURCE_PAGE_URL =
  'https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs-edition-3/jul2021-jun2026/access-and-downloads/digital-boundary-files';
const LICENCE = 'CC BY 4.0';

const OUTPUT_PATH = 'data/ndis/boundaries.json';
const CONTEXT_PATH = 'data/ndis/context.json';

const SCRATCH_DIR = join(tmpdir(), 'ndis-ced-boundaries');
const ZIP_PATH = join(SCRATCH_DIR, 'CED_2021_AUST_GDA2020_SHP.zip');
const SHP_ENTRY = 'CED_2021_AUST_GDA2020.shp';
const DBF_ENTRY = 'CED_2021_AUST_GDA2020.dbf';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Geographic "core extent" — mainland Australia + Tasmania, padded. Any ring
// whose centroid falls outside this box is a remote external territory
// dragged in by an electorate's legal boundary (verified against the raw
// file: Div. of Lingiari's bbox reaches lon 96.8° — the Cocos Islands; Div.
// of Sydney reaches lon 159.1° — Lord Howe Island; Div. of Bean reaches lon
// 168.0° — Norfolk Island). Drawing those would blow out the national
// viewBox for a few invisible pixels and defeat "visibly looks like
// Australia" — they're dropped from the rendered geometry (not from
// context.json, which is untouched).
const CORE_BBOX = { minLon: 112, maxLon: 154.5, minLat: -44, maxLat: -9 };

// Output coordinate-space width (arbitrary units — the SVG scales to its
// container regardless). Wide enough that quantising to 1 dp still leaves
// useful resolution once a capital-city inset crops into a small fraction of
// this space (insets reuse these SAME projected/quantised points, just via a
// smaller viewBox — see docs/ndis-spec.md's boundaries.json shape).
const CANVAS_WIDTH = 2200;
const VIEWBOX_PAD_FRAC = 0.02; // national map padding, fraction of extent
const INSET_PAD_FRAC = 0.12; // insets need more breathing room around a small cluster

// Adaptive Douglas-Peucker: tolerance for a ring = SIMPLIFY_K * that ring's
// own projected bounding-box diagonal, floored at MIN_TOLERANCE_UNITS. This
// allocates detail where it matters (small metro divisions keep a fine
// tolerance; huge outback divisions collapse hard) without a two-tier
// national/inset pipeline — both views read the same simplified points.
const SIMPLIFY_K = 0.012;
const MIN_TOLERANCE_UNITS = 0.35;

// Geometrically-derived metro insets (docs/ndis-spec.md "derive it
// geometrically... list the resulting codes in a comment for review, don't
// hand-guess names"). Method: haversine distance from each division's
// area-weighted centroid to the capital's CBD coordinate <= 50 km, AND the
// division's official AREASQKM21 <= 1000 km^2 (excludes outer-fringe/rural
// seats that only brush the radius, e.g. Perth's Canning at 66.7 km, or
// oversized outer seats like Perth's Hasluck at 1318 km^2). Derived by
// running this exact filter over the downloaded shapefile + haversine, then
// reviewed by name against the known electorate rolls before hardcoding —
// see the task's final report for the full distance/area printout.
const METRO_INSETS = [
  {
    id: 'syd',
    label: 'Sydney',
    codes: [
      '145', '117', '132', '122', '143', '102', '137', '144', '103', '106',
      '101', '109', '105', '135', '126', '115', '119', '129', '118', '128',
      '146', '104', '108', '125', '123',
    ],
  },
  {
    id: 'mel',
    label: 'Melbourne',
    codes: [
      '233', '229', '226', '220', '239', '208', '214', '231', '217', '215',
      '207', '225', '237', '234', '222', '218', '205', '211', '201', '224',
      '228', '204', '212', '221',
    ],
  },
  {
    id: 'bne',
    label: 'Brisbane',
    codes: ['304', '313', '324', '319', '328', '325', '327', '326', '307', '302', '303', '312', '308'],
  },
  {
    id: 'per',
    label: 'Perth',
    codes: ['513', '505', '514', '504', '515', '508', '502', '510', '512', '501'],
  },
  {
    id: 'adl',
    label: 'Adelaide',
    codes: ['401', '410', '403', '405', '407', '406', '409'],
  },
];

// --- fetch + cache -----------------------------------------------------

async function downloadZip() {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  if (existsSync(ZIP_PATH)) {
    const cached = readFileSync(ZIP_PATH);
    if (cached.length > 5_000_000) {
      console.log(`using cached download: ${ZIP_PATH} (${cached.length} bytes)`);
      return cached;
    }
  }
  console.log(`downloading ${SHP_ZIP_URL}`);
  const res = await fetch(SHP_ZIP_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`${SHP_ZIP_URL} responded ${res.status} ${res.statusText}`);
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('zip') && !contentType.includes('octet-stream')) {
    throw new Error(`unexpected content-type "${contentType}" for ${SHP_ZIP_URL} — refusing to parse as a zip`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 5_000_000) throw new Error(`downloaded file is only ${buf.length} bytes — expected tens of MB`);
  writeFileSync(ZIP_PATH, buf);
  console.log(`downloaded ${buf.length} bytes -> ${ZIP_PATH}`);
  return buf;
}

// --- zero-dep ZIP reader (mirrors scripts/ndis/xlsx.mjs's approach) -------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buf) {
  const maxCommentLen = 65535;
  const minPos = Math.max(0, buf.length - 22 - maxCommentLen);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('zip: end-of-central-directory record not found');
}

function readCentralDirectory(buf) {
  const eocdPos = findEndOfCentralDirectory(buf);
  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  const entries = new Map();
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`zip: central directory entry ${i} has a bad signature`);
    }
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.set(name, { compressionMethod, compressedSize, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryData(buf, entry) {
  const lfhPos = entry.localHeaderOffset;
  if (buf.readUInt32LE(lfhPos) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error('zip: local file header signature mismatch');
  }
  const nameLen = buf.readUInt16LE(lfhPos + 26);
  const extraLen = buf.readUInt16LE(lfhPos + 28);
  const dataStart = lfhPos + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod === 8) return inflateRawSync(compressed);
  throw new Error(`zip: unsupported compression method ${entry.compressionMethod}`);
}

function openZip(buf) {
  const central = readCentralDirectory(buf);
  return {
    read(name) {
      const entry = central.get(name);
      if (!entry) throw new Error(`zip: entry not found: ${name}`);
      return readEntryData(buf, entry);
    },
  };
}

// --- DBF reader (dBASE III, matches ABS's shapefile attribute tables) ----

function readDbf(buf) {
  const numRecords = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);

  const fields = [];
  let pos = 32;
  while (buf[pos] !== 0x0d) {
    const name = buf.toString('latin1', pos, pos + 11).replace(/\0.*$/, '');
    const length = buf.readUInt8(pos + 16);
    fields.push({ name, length });
    pos += 32;
  }
  let fieldOffset = 1; // byte 0 of each record is the deletion flag
  const offsets = fields.map((f) => {
    const o = fieldOffset;
    fieldOffset += f.length;
    return o;
  });

  const records = [];
  for (let i = 0; i < numRecords; i++) {
    const recPos = headerLen + i * recordLen;
    const rec = {};
    fields.forEach((f, fi) => {
      rec[f.name] = buf.toString('latin1', recPos + offsets[fi], recPos + offsets[fi] + f.length).trim();
    });
    records.push(rec);
  }
  return records;
}

// --- SHP reader (only what CED_2021 needs: null shapes + polygon shapes) --
// Records are read sequentially in file order, which is guaranteed to match
// the .dbf's record order (standard shapefile invariant, and verified
// directly against this download: index 0 = code 101 Banks in both files).

function readShpRecords(buf) {
  const records = [];
  let pos = 100; // fixed 100-byte main file header
  while (pos < buf.length) {
    const contentLenWords = buf.readInt32BE(pos + 4);
    const contentStart = pos + 8;
    const contentLenBytes = contentLenWords * 2;
    const shapeType = buf.readInt32LE(contentStart);

    if (shapeType === 0) {
      records.push(null); // null shape — the 18 non-geographic Census codes
    } else if (shapeType === 5) {
      let o = contentStart + 4 + 32; // skip shape type + bounding box
      const numParts = buf.readInt32LE(o);
      const numPoints = buf.readInt32LE(o + 4);
      o += 8;
      const parts = new Array(numParts);
      for (let p = 0; p < numParts; p++) parts[p] = buf.readInt32LE(o + p * 4);
      o += 4 * numParts;
      const xs = new Float64Array(numPoints);
      const ys = new Float64Array(numPoints);
      for (let p = 0; p < numPoints; p++) {
        xs[p] = buf.readDoubleLE(o);
        ys[p] = buf.readDoubleLE(o + 8);
        o += 16;
      }
      const rings = [];
      for (let p = 0; p < numParts; p++) {
        const start = parts[p];
        const end = p + 1 < numParts ? parts[p + 1] : numPoints;
        const ring = new Array(end - start);
        for (let k = start; k < end; k++) ring[k - start] = [xs[k], ys[k]];
        rings.push(ring);
      }
      records.push(rings);
    } else {
      throw new Error(`unsupported shapefile shape type ${shapeType} — expected 0 (null) or 5 (polygon)`);
    }
    pos = contentStart + contentLenBytes;
  }
  return records;
}

// --- geometry helpers ----------------------------------------------------

function ringBBox(ring) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

function ringCentroid(ring) {
  const { minX, maxX, minY, maxY } = ringBBox(ring);
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

// Iterative Douglas-Peucker (a recursive version would blow the stack on the
// ~250k-point rings this file contains). Points are [x, y] pairs; keeps
// endpoints, drops interior points within `tolerance` of the chord.
function simplify(points, tolerance) {
  const n = points.length;
  if (n <= 3) return points;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];

  const distToSegment = (p, a, b) => {
    const [px, py] = p, [ax, ay] = a, [bx, by] = b;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  while (stack.length > 0) {
    const [start, end] = stack.pop();
    if (end <= start + 1) continue;
    let maxDist = -1, maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = distToSegment(points[i], points[start], points[end]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > tolerance) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx]);
      stack.push([maxIdx, end]);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function insideCore(pt) {
  const [lon, lat] = pt;
  return lon >= CORE_BBOX.minLon && lon <= CORE_BBOX.maxLon && lat >= CORE_BBOX.minLat && lat <= CORE_BBOX.maxLat;
}

// --- main ------------------------------------------------------------

async function main() {
  const context = readJson(CONTEXT_PATH, null);
  const electorateCodes = new Set((context?.electorates?.rows ?? []).map((r) => r.code));
  if (electorateCodes.size === 0) {
    throw new Error(`${CONTEXT_PATH} has no electorates.rows — run fetch-context.mjs first`);
  }

  const zipBuf = await downloadZip();
  const zip = openZip(zipBuf);
  const dbfRecords = readDbf(zip.read(DBF_ENTRY));
  const shpRecords = readShpRecords(zip.read(SHP_ENTRY));
  if (dbfRecords.length !== shpRecords.length) {
    throw new Error(`.dbf has ${dbfRecords.length} records but .shp has ${shpRecords.length} — record order mismatch`);
  }

  let polygonsIn = 0;
  let pointsBefore = 0;
  const features = []; // { code, name, rings: [[ [x,y], ... ], ...] }

  for (let i = 0; i < dbfRecords.length; i++) {
    const dbf = dbfRecords[i];
    const rings = shpRecords[i];
    if (!rings) continue; // null-shape (non-geographic Census catch-all)
    const code = dbf.CED_CODE21;
    if (!electorateCodes.has(code)) continue; // not one of context.json's rows

    polygonsIn++;
    for (const r of rings) pointsBefore += r.length;

    // Drop rings centred outside mainland+Tasmania (remote external
    // territories — see CORE_BBOX comment above).
    const coreRings = rings.filter((ring) => insideCore(ringCentroid(ring)));
    if (coreRings.length === 0) {
      console.warn(`warning: "${dbf.CED_NAME21}" (${code}) has no rings inside the core extent — skipped`);
      continue;
    }
    features.push({ code, name: dbf.CED_NAME21, rings: coreRings });
  }

  console.log(`polygons in (matched to context.json rows, geographic only): ${polygonsIn}`);
  console.log(`raw points across all rings (pre core-filter, pre-simplify): ${pointsBefore}`);

  // Project every surviving raw point once with a single cos-scaled
  // equirectangular projection, so the national map and every inset (which
  // just crops a viewBox onto this same space) stay geometrically
  // consistent. refLat = mid-latitude of the core-filtered extent.
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const f of features) {
    for (const ring of f.rings) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  const refLat = (minLat + maxLat) / 2;
  const cosScale = Math.cos((refLat * Math.PI) / 180);
  const project = (lon, lat) => [lon * cosScale, -lat];

  const rawMinX = minLon * cosScale;
  const rawMaxX = maxLon * cosScale;
  const rawWidth = rawMaxX - rawMinX;
  const SCALE = CANVAS_WIDTH / rawWidth;
  const rawMinY = -maxLat;
  const toCanvas = (lon, lat) => {
    const [x, y] = project(lon, lat);
    return [(x - rawMinX) * SCALE, (y - rawMinY) * SCALE];
  };

  // Simplify + project + quantise each ring; drop degenerate results.
  let pointsAfter = 0;
  const paths = {};
  const featureCanvasBBox = new Map(); // code -> {minX,maxX,minY,maxY} (for insets)

  for (const f of features) {
    const canvasRings = [];
    let fMinX = Infinity, fMaxX = -Infinity, fMinY = Infinity, fMaxY = -Infinity;

    for (const ring of f.rings) {
      const canvasPts = ring.map(([lon, lat]) => toCanvas(lon, lat));
      const { minX, maxX, minY, maxY } = ringBBox(canvasPts);
      const diagonal = Math.hypot(maxX - minX, maxY - minY);
      const tolerance = Math.max(MIN_TOLERANCE_UNITS, diagonal * SIMPLIFY_K);
      const simplified = simplify(canvasPts, tolerance);

      // quantise to 1 dp and drop consecutive duplicate points
      const quantised = [];
      let lastKey = null;
      for (const [x, y] of simplified) {
        const qx = Math.round(x * 10) / 10;
        const qy = Math.round(y * 10) / 10;
        const key = `${qx},${qy}`;
        if (key !== lastKey) { quantised.push([qx, qy]); lastKey = key; }
      }
      if (quantised.length < 3) continue; // degenerate after simplification
      pointsAfter += quantised.length;
      canvasRings.push(quantised);
      if (minX < fMinX) fMinX = minX;
      if (maxX > fMaxX) fMaxX = maxX;
      if (minY < fMinY) fMinY = minY;
      if (maxY > fMaxY) fMaxY = maxY;
    }

    if (canvasRings.length === 0) {
      console.warn(`warning: "${f.name}" (${f.code}) has no non-degenerate rings after simplification — skipped`);
      continue;
    }

    const d = canvasRings
      .map((ring) => `M${ring.map(([x, y]) => `${x},${y}`).join('L')}Z`)
      .join('');
    paths[f.code] = d;
    featureCanvasBBox.set(f.code, { minX: fMinX, maxX: fMaxX, minY: fMinY, maxY: fMaxY });
  }

  const canvasWidth = (maxLon - minLon) * cosScale * SCALE;
  const canvasHeight = (maxLat - minLat) * SCALE;
  const pad = Math.max(canvasWidth, canvasHeight) * VIEWBOX_PAD_FRAC;
  const nationalViewBox = `${(-pad).toFixed(1)} ${(-pad).toFixed(1)} ${(canvasWidth + 2 * pad).toFixed(1)} ${(canvasHeight + 2 * pad).toFixed(1)}`;

  const insets = [];
  for (const { id, label, codes } of METRO_INSETS) {
    let iMinX = Infinity, iMaxX = -Infinity, iMinY = Infinity, iMaxY = -Infinity;
    let found = 0;
    for (const code of codes) {
      const bbox = featureCanvasBBox.get(code);
      if (!bbox) continue;
      found++;
      if (bbox.minX < iMinX) iMinX = bbox.minX;
      if (bbox.maxX > iMaxX) iMaxX = bbox.maxX;
      if (bbox.minY < iMinY) iMinY = bbox.minY;
      if (bbox.maxY > iMaxY) iMaxY = bbox.maxY;
    }
    if (found === 0) {
      console.warn(`warning: inset "${id}" matched no paths — skipped`);
      continue;
    }
    const w = iMaxX - iMinX, h = iMaxY - iMinY;
    const ipad = Math.max(w, h) * INSET_PAD_FRAC;
    insets.push({
      id,
      label,
      viewBox: `${(iMinX - ipad).toFixed(1)} ${(iMinY - ipad).toFixed(1)} ${(w + 2 * ipad).toFixed(1)} ${(h + 2 * ipad).toFixed(1)}`,
    });
  }

  const boundaries = {
    meta: {
      source: { title: SOURCE_TITLE, url: SOURCE_PAGE_URL, publisher: 'ABS' },
      licence: LICENCE,
      generated: new Date().toISOString().slice(0, 10),
      simplification:
        `Iterative Douglas-Peucker, adaptive per ring: tolerance = max(${MIN_TOLERANCE_UNITS}, ${SIMPLIFY_K} * ring bounding-box diagonal), in the projected coordinate space (canvas width ${CANVAS_WIDTH} units for the full national extent); coordinates then quantised to 1 dp and consecutive duplicate points dropped`,
      projection:
        `cos-scaled equirectangular: x = lon * cos(refLat), y = -lat, refLat = ${refLat.toFixed(4)} (mid-latitude of the core mainland+Tasmania extent), then linearly scaled/translated so the national extent's bounding box is ${CANVAS_WIDTH.toFixed(1)} x ${canvasHeight.toFixed(1)} canvas units at (0,0)`,
      viewBox: nationalViewBox,
    },
    insets,
    paths,
  };

  writeJson(OUTPUT_PATH, boundaries);

  const bytes = Buffer.byteLength(JSON.stringify(boundaries));
  console.log(`polygons out (with a rendered path): ${Object.keys(paths).length}`);
  console.log(`points after simplify+quantise+dedupe: ${pointsAfter}`);
  console.log(`insets: ${insets.map((i) => `${i.id} (${i.label})`).join(', ')}`);
  console.log(`wrote ${OUTPUT_PATH} (${bytes} bytes, ${(bytes / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

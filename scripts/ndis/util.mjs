// Shared helpers for scripts/ndis/*.mjs. Zero dependencies, Node >= 18 ESM.
// Small pure functions where possible; the fetch helpers carry minimal state
// (per-host last-request time) needed to satisfy the fetch politeness rule.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 15000;
const MIN_HOST_GAP_MS = 1000;

const lastRequestAtByHost = new Map();

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Politeness: >=1s between requests to the same host (spec §fetch rules).
async function waitForHostSlot(hostname) {
  const last = lastRequestAtByHost.get(hostname);
  if (last !== undefined) {
    const elapsed = Date.now() - last;
    if (elapsed < MIN_HOST_GAP_MS) await sleep(MIN_HOST_GAP_MS - elapsed);
  }
  lastRequestAtByHost.set(hostname, Date.now());
}

// fetch with UA/Accept headers, 15s timeout, one retry on network error, and
// per-host politeness spacing. Does NOT retry on HTTP error status codes —
// callers decide how to handle those (soft-fail for *.ndis.gov.au, else exit 1).
export async function politeFetch(url, options = {}) {
  const hostname = new URL(url).hostname;
  await waitForHostSlot(hostname);

  const headers = { 'User-Agent': USER_AGENT, Accept: '*/*', ...(options.headers ?? {}) };
  const init = { ...options, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };

  try {
    return await fetch(url, init);
  } catch (firstErr) {
    try {
      await waitForHostSlot(hostname);
      return await fetch(url, init);
    } catch (secondErr) {
      throw new Error(`network error fetching ${url}: ${secondErr.message} (first attempt: ${firstErr.message})`);
    }
  }
}

export function isNdisGovAuUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'ndis.gov.au' || hostname.endsWith('.ndis.gov.au');
  } catch {
    return false;
  }
}

// Detect a Cloudflare JS-challenge response (soft-fail trigger for *.ndis.gov.au).
// Checks status/headers first (cheap), only reads the body as a last resort.
export async function looksLikeCloudflareChallenge(response) {
  if (response.status === 403) return true;
  if (response.headers.get('cf-mitigated') === 'challenge') return true;
  const server = response.headers.get('server') ?? '';
  const contentType = response.headers.get('content-type') ?? '';
  if (server.includes('cloudflare') && contentType.includes('text/html')) {
    const text = await response.clone().text();
    if (/Just a moment|cf-browser-verification|Cloudflare/i.test(text)) return true;
  }
  return false;
}

export function readJson(path, fallback = undefined) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Writes the full JSON in one call (spec: "never write partial data" — build
// the value in memory, then write once). Stable 2-space formatting.
export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function slugify(text, maxLen = 60) {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return slug || 'item';
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&'); // must run last so decoded entities aren't re-decoded
}

// Minimal RFC4180-ish CSV parser (quoted fields, embedded commas/quotes/
// newlines, "" as an escaped quote). Strips a leading BOM. Returns string[][].
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\r') {
      i += 1;
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// string[][] (header row + data rows) -> array of {header: value} objects.
export function csvRowsToObjects(rows) {
  if (rows.length === 0) return [];
  const [header, ...dataRows] = rows;
  return dataRows
    .filter((row) => row.some((cell) => cell !== ''))
    .map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])));
}

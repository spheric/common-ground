// Shared helpers for scripts/tvfy/*.mjs. Zero dependencies, Node >= 18 ESM.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const PARTY_IDS = ['labor', 'coalition', 'greens', 'one_nation'];

// FROZEN party classification. Every other They Vote For You party string —
// Independent, Katter's Australian Party, Centre Alliance, Jacqui Lambie
// Network, United Australia Party, Australia's Voice, SPK, PRES, DPRES, and
// any other crossbench/presiding-officer label — is excluded from the
// aggregates (classifyParty returns null for them).
const PARTY_NAME_TO_ID = {
  'Australian Labor Party': 'labor',
  'Liberal Party': 'coalition',
  'National Party': 'coalition',
  'Liberal National Party': 'coalition',
  'Country Liberal Party': 'coalition',
  'Australian Greens': 'greens',
  "Pauline Hanson's One Nation Party": 'one_nation',
};

export function classifyParty(partyName) {
  return PARTY_NAME_TO_ID[partyName] ?? null;
}

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Writes the full JSON in one call. Stable 2-space formatting, trailing
// newline, creates parent directories as needed.
export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

let cachedApiKey;

// Resolves TVFY_API_KEY: the environment variable takes precedence over a
// repo-root .env file (simple KEY=VALUE lines, blank lines and #-comments
// ignored, optional surrounding quotes stripped). Throws a clear error if
// neither is set — callers should let that propagate to a top-level
// `main().catch(...)` so it prints and exits 1.
export function loadApiKey() {
  if (cachedApiKey) return cachedApiKey;

  if (process.env.TVFY_API_KEY) {
    cachedApiKey = process.env.TVFY_API_KEY;
    return cachedApiKey;
  }

  const envPath = resolve('.env');
  if (existsSync(envPath)) {
    const parsed = parseDotEnv(readFileSync(envPath, 'utf8'));
    if (parsed.TVFY_API_KEY) {
      cachedApiKey = parsed.TVFY_API_KEY;
      return cachedApiKey;
    }
  }

  throw new Error(
    'TVFY_API_KEY not set. Set the TVFY_API_KEY environment variable, or add ' +
      'TVFY_API_KEY=... to a .env file in the repo root (see data/tvfy/README.md).'
  );
}

function parseDotEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// Strips the API key out of a URL before it lands in a console.error or
// thrown Error message.
export function redactKey(url) {
  return url.replace(/([?&]key=)[^&]+/, '$1***');
}

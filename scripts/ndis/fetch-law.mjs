#!/usr/bin/env node
// Fetches the NDIS Act compilation timeline and all NDIS-named titles from
// the Federal Register of Legislation's public OData API and writes
// data/ndis/law.json. This API is not behind Cloudflare and needs no auth.
//
// Usage: node scripts/ndis/fetch-law.mjs

import { politeFetch, todayIso, writeJson } from './util.mjs';

const API_BASE = 'https://api.prod.legislation.gov.au/v1';
const NDIS_ACT_TITLE_ID = 'C2013A00020'; // National Disability Insurance Scheme Act 2013
const OUTPUT_PATH = 'data/ndis/law.json';

function dateOnly(isoDateTime) {
  return typeof isoDateTime === 'string' ? isoDateTime.slice(0, 10) : null;
}

function legislationUrl(registerId) {
  return `https://www.legislation.gov.au/${registerId}`;
}

async function fetchJson(url) {
  const res = await politeFetch(url);
  if (!res.ok) throw new Error(`${url} responded ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body['@odata.nextLink']) {
    throw new Error(`${url} is paginated (@odata.nextLink present) — fetch-law.mjs doesn't page yet`);
  }
  return body.value ?? [];
}

async function fetchTitles() {
  const url =
    `${API_BASE}/titles?$filter=contains(name,'National Disability Insurance Scheme')` +
    `&$orderby=asMadeRegisteredAt desc`;
  const rows = await fetchJson(url);
  return rows.map((row) => ({
    register_id: row.id,
    name: row.name,
    collection: row.collection,
    status: row.status,
    made: dateOnly(row.makingDate),
    registered: dateOnly(row.asMadeRegisteredAt),
    url: legislationUrl(row.id),
  }));
}

async function fetchActVersions() {
  const url = `${API_BASE}/Versions?$filter=titleId eq '${NDIS_ACT_TITLE_ID}'`;
  const rows = await fetchJson(url);
  return rows.map((row) => {
    const start = dateOnly(row.start);
    return {
      compilation: parseInt(row.compilationNumber, 10),
      register_id: row.registerId,
      start,
      url: `${legislationUrl(row.registerId)}/${start}`,
    };
  });
}

async function main() {
  const [titles, actVersions] = [await fetchTitles(), await fetchActVersions()];

  titles.sort((a, b) => (b.registered ?? '').localeCompare(a.registered ?? '') || a.register_id.localeCompare(b.register_id));
  actVersions.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '') || a.compilation - b.compilation);

  const law = {
    generated: todayIso(),
    act_versions: actVersions,
    titles,
  };

  writeJson(OUTPUT_PATH, law);
  console.log(`wrote ${OUTPUT_PATH} (${titles.length} titles, ${actVersions.length} act compilations)`);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

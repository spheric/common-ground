#!/usr/bin/env node
// Fetches the CURRENT NDIS Support Catalogue release and writes a normalised
// snapshot to data/ndis/snapshots/<release>.json. Cloudflare-tolerant per
// docs/ndis-spec.md §fetch rules: a 403/challenge from *.ndis.gov.au is a
// soft failure (print + exit 0, no data touched) — run ingest-file.mjs with
// a browser-downloaded file instead.
//
// Usage: node scripts/ndis/fetch-catalogue.mjs

import { existsSync, mkdirSync } from 'node:fs';
import { isNdisGovAuUrl, looksLikeCloudflareChallenge, politeFetch, readJson, todayIso, writeJson } from './util.mjs';
import { buildSnapshot } from './catalogue.mjs';

const CATALOGUE_PAGE_URL = 'https://www.ndis.gov.au/providers/pricing-and-payments/pricing/what-support-catalogue';
const STATE_PATH = 'data/ndis/state.json';
const SNAPSHOTS_DIR = 'data/ndis/snapshots';

function softFail(url) {
  console.log(`blocked: ${url} — run scripts/ndis/ingest-file.mjs with a browser-downloaded file`);
  process.exit(0);
}

async function handleResponseOrSoftFail(res, url) {
  if (res.ok) return;
  if (isNdisGovAuUrl(url) && (await looksLikeCloudflareChallenge(res))) softFail(url);
  console.error(`error: ${url} responded ${res.status} ${res.statusText}`);
  process.exit(1);
}

function absoluteUrl(href, base) {
  return new URL(href, base).toString();
}

// The catalogue page's exact markup could not be verified against a real
// fetch (ndis.gov.au is Cloudflare-blocked in every environment this was
// tested from — see README note in catalogue.mjs). Two fallback strategies:
// prefer an anchor whose visible text mentions "Support Catalogue", else
// fall back to the first /media/<id>/download link on the page.
function findCatalogueLink(html, pageUrl) {
  const anchorRe = /<a\b[^>]*href="([^"]*\/media\/\d+\/download[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  let fallback = null;
  while ((m = anchorRe.exec(html))) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, ' ').trim();
    if (fallback === null) fallback = href;
    if (/support catalogue/i.test(text)) return absoluteUrl(href, pageUrl);
  }
  if (fallback) return absoluteUrl(fallback, pageUrl);
  return null;
}

function parseFilename(contentDisposition) {
  if (!contentDisposition) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition);
  return m ? decodeURIComponent(m[1].trim()) : null;
}

async function main() {
  const pageRes = await politeFetch(CATALOGUE_PAGE_URL);
  await handleResponseOrSoftFail(pageRes, CATALOGUE_PAGE_URL);
  const html = await pageRes.text();

  const mediaUrl = findCatalogueLink(html, CATALOGUE_PAGE_URL);
  if (!mediaUrl) {
    console.error(`error: could not find a Support Catalogue download link on ${CATALOGUE_PAGE_URL}`);
    process.exit(1);
  }

  const state = readJson(STATE_PATH, {});
  const conditionalHeaders = {};
  if (state.source_url === mediaUrl) {
    if (state.etag) conditionalHeaders['If-None-Match'] = state.etag;
    if (state.last_modified) conditionalHeaders['If-Modified-Since'] = state.last_modified;
  }

  const fileRes = await politeFetch(mediaUrl, { headers: conditionalHeaders });

  if (fileRes.status === 304) {
    console.log(`no change: ${mediaUrl} (etag/last-modified match data/ndis/state.json)`);
    process.exit(0);
  }
  await handleResponseOrSoftFail(fileRes, mediaUrl);

  const filename = parseFilename(fileRes.headers.get('content-disposition'));
  if (!filename) {
    console.error(`error: no content-disposition filename on response from ${mediaUrl}`);
    process.exit(1);
  }

  const buffer = Buffer.from(await fileRes.arrayBuffer());
  const fetchedAt = todayIso();

  let snapshot;
  try {
    snapshot = buildSnapshot({ buffer, sourceUrl: mediaUrl, sourceFilename: filename, fetchedAt });
  } catch (err) {
    console.error(`error: could not parse catalogue file "${filename}": ${err.message}`);
    process.exit(1);
  }

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const snapshotPath = `${SNAPSHOTS_DIR}/${snapshot.release}.json`;
  const isNewRelease = !existsSync(snapshotPath);
  writeJson(snapshotPath, snapshot);

  writeJson(STATE_PATH, {
    source_url: mediaUrl,
    filename,
    etag: fileRes.headers.get('etag') ?? null,
    last_modified: fileRes.headers.get('last-modified') ?? null,
    release: snapshot.release,
    fetched_at: fetchedAt,
  });

  console.log(
    `wrote ${snapshotPath} (${snapshot.items.length} items, release ${snapshot.release}` +
      `${isNewRelease ? ', new release' : ', updated existing release'})`
  );
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

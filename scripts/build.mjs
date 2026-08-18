#!/usr/bin/env node
// Bundle web/index.html + web/style.css + web/app.js + the dataset into two
// self-contained, dependency-free files: dist/index.html (full document) and
// dist/artifact.html (body-only variant for claude.ai artifact publishing).
//
// Usage: node scripts/build.mjs [datasetPath]
//   default path: data/dataset.json
//   falls back to data/dataset.sample.json (with a warning) if the default is missing.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_DATASET_PATH = 'data/dataset.json';
const FALLBACK_DATASET_PATH = 'data/dataset.sample.json';

const WEB_DIR = 'web';
const DIST_DIR = 'dist';
const REQUIRED_WEB_FILES = ['index.html', 'style.css', 'app.js'];

const ARTIFACT_TITLE = 'Common Ground — Australian party policies, compared';

const CSS_TOKEN = '<!--__CSS__-->';
const DATA_TOKEN = '<!--__DATA__-->';
const JS_TOKEN = '<!--__JS__-->';
const BODY_START = '<!--__BODY_START__-->';
const BODY_END = '<!--__BODY_END__-->';

function resolveDatasetPath(argPath) {
  if (argPath) {
    if (!existsSync(argPath)) {
      console.error(`error: dataset not found at ${argPath}`);
      process.exit(1);
    }
    return argPath;
  }
  if (existsSync(DEFAULT_DATASET_PATH)) return DEFAULT_DATASET_PATH;
  if (existsSync(FALLBACK_DATASET_PATH)) {
    console.warn(`warning: ${DEFAULT_DATASET_PATH} not found — falling back to ${FALLBACK_DATASET_PATH}`);
    return FALLBACK_DATASET_PATH;
  }
  console.error(`error: neither ${DEFAULT_DATASET_PATH} nor ${FALLBACK_DATASET_PATH} exists`);
  process.exit(1);
}

function requireWebFiles() {
  const missing = REQUIRED_WEB_FILES.filter((name) => !existsSync(`${WEB_DIR}/${name}`));
  if (missing.length > 0) {
    console.error(
      `error: missing required file(s) in ${WEB_DIR}/: ${missing.join(', ')}\n` +
        `Builder B needs to create these before the build can run.`
    );
    process.exit(1);
  }
}

function readWebFiles() {
  return {
    html: readFileSync(`${WEB_DIR}/index.html`, 'utf8'),
    css: readFileSync(`${WEB_DIR}/style.css`, 'utf8'),
    js: readFileSync(`${WEB_DIR}/app.js`, 'utf8'),
  };
}

function loadDataset(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`error: could not read ${path}: ${err.message}`);
    process.exit(1);
  }
  try {
    JSON.parse(raw); // validate shape before embedding
  } catch (err) {
    console.error(`error: ${path} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  return raw;
}

function escapeForInlineScript(jsonString) {
  // "<" only ever appears inside JSON string values, so < stays valid JS
  // and defuses </script>, <!--, and every other markup-significant sequence.
  return jsonString.replace(/</g, '\\u003c');
}

function assertToken(html, token) {
  if (!html.includes(token)) {
    console.error(`error: web/index.html is missing the required token ${token}`);
    process.exit(1);
  }
}

function buildFullDocument({ html, css, js, dataJson }) {
  assertToken(html, CSS_TOKEN);
  assertToken(html, DATA_TOKEN);
  assertToken(html, JS_TOKEN);
  if (!html.includes(BODY_START) || !html.includes(BODY_END)) {
    console.error(`error: web/index.html is missing ${BODY_START} / ${BODY_END} markers`);
    process.exit(1);
  }

  const cssBlock = `<style>${css}</style>`;
  const dataBlock = `<script>window.DATASET = ${escapeForInlineScript(dataJson)};</script>`;
  const jsBlock = `<script>${js}</script>`;

  // function replacements: string-form .replace() would interpret $& / $' etc.
  // inside the injected CSS/JS/JSON as replacement patterns and corrupt output
  return html
    .replace(CSS_TOKEN, () => cssBlock)
    .replace(DATA_TOKEN, () => dataBlock)
    .replace(JS_TOKEN, () => jsBlock);
}

function extractBody(assembledHtml) {
  const start = assembledHtml.indexOf(BODY_START);
  const end = assembledHtml.indexOf(BODY_END);
  if (start === -1 || end === -1 || end < start) {
    console.error(`error: could not locate ${BODY_START} / ${BODY_END} markers in assembled output`);
    process.exit(1);
  }
  return assembledHtml.slice(start + BODY_START.length, end);
}

function buildArtifactDocument({ css, js, dataJson, bodyContent }) {
  const titleBlock = `<title>${ARTIFACT_TITLE}</title>`;
  const cssBlock = `<style>${css}</style>`;
  const dataBlock = `<script>window.DATASET = ${escapeForInlineScript(dataJson)};</script>`;
  const jsBlock = `<script>${js}</script>`;
  return [titleBlock, cssBlock, bodyContent, dataBlock, jsBlock].join('\n');
}

function byteSize(str) {
  return Buffer.byteLength(str, 'utf8');
}

// --- NDIS tracker page (docs/ndis-spec.md §build.mjs extension) -----------
// Same token scheme as the main app, but no artifact variant. Both web/ndis.html
// and data/ndis/ndis.json are optional (Builder B's page and Builder A's data
// pipeline may land independently) — either being missing just skips this step
// with a warning, the main build is unaffected.

const NDIS_WEB_DIR = 'web';
const NDIS_DATASET_PATH = 'data/ndis/ndis.json';
const NDIS_REQUIRED_WEB_FILES = ['ndis.html', 'ndis.css', 'ndis.js'];

function buildNdisPage() {
  if (!existsSync(`${NDIS_WEB_DIR}/ndis.html`)) {
    console.warn(`warning: ${NDIS_WEB_DIR}/ndis.html not found — skipping the NDIS tracker page`);
    return;
  }
  const missing = NDIS_REQUIRED_WEB_FILES.filter((name) => !existsSync(`${NDIS_WEB_DIR}/${name}`));
  if (missing.length > 0) {
    console.warn(`warning: missing ${missing.map((n) => `${NDIS_WEB_DIR}/${n}`).join(', ')} — skipping the NDIS tracker page`);
    return;
  }
  if (!existsSync(NDIS_DATASET_PATH)) {
    console.warn(`warning: ${NDIS_DATASET_PATH} not found — skipping the NDIS tracker page`);
    return;
  }

  const html = readFileSync(`${NDIS_WEB_DIR}/ndis.html`, 'utf8');
  const css = readFileSync(`${NDIS_WEB_DIR}/ndis.css`, 'utf8');
  const js = readFileSync(`${NDIS_WEB_DIR}/ndis.js`, 'utf8');

  if (js.includes('</script')) {
    console.error(`error: ${NDIS_WEB_DIR}/ndis.js must not contain the literal substring "</script"`);
    process.exit(1);
  }

  const dataJson = loadDataset(NDIS_DATASET_PATH);

  assertToken(html, CSS_TOKEN);
  assertToken(html, DATA_TOKEN);
  assertToken(html, JS_TOKEN);

  const cssBlock = `<style>${css}</style>`;
  const dataBlock = `<script>window.NDIS = ${escapeForInlineScript(dataJson)};</script>`;
  const jsBlock = `<script>${js}</script>`;

  // function replacements: see buildFullDocument — avoids $-pattern corruption
  const ndisDocument = html
    .replace(CSS_TOKEN, () => cssBlock)
    .replace(DATA_TOKEN, () => dataBlock)
    .replace(JS_TOKEN, () => jsBlock);

  mkdirSync(DIST_DIR, { recursive: true });
  const ndisPath = `${DIST_DIR}/ndis.html`;
  writeFileSync(ndisPath, ndisDocument, 'utf8');
  console.log(`wrote ${resolve(ndisPath)} (${byteSize(ndisDocument)} bytes)`);
}

function main() {
  requireWebFiles();
  const { html, css, js } = readWebFiles();

  const datasetArg = process.argv[2];
  const datasetPath = resolveDatasetPath(datasetArg);

  if (js.includes('</script')) {
    console.error(`error: web/app.js must not contain the literal substring "</script"`);
    process.exit(1);
  }

  const dataJson = loadDataset(datasetPath);

  const fullDocument = buildFullDocument({ html, css, js, dataJson });
  const bodyContent = extractBody(fullDocument);
  const artifactDocument = buildArtifactDocument({ css, js, dataJson, bodyContent });

  mkdirSync(DIST_DIR, { recursive: true });

  const indexPath = `${DIST_DIR}/index.html`;
  const artifactPath = `${DIST_DIR}/artifact.html`;

  writeFileSync(indexPath, fullDocument, 'utf8');
  writeFileSync(artifactPath, artifactDocument, 'utf8');

  console.log(`wrote ${resolve(indexPath)} (${byteSize(fullDocument)} bytes)`);
  console.log(`wrote ${resolve(artifactPath)} (${byteSize(artifactDocument)} bytes)`);

  buildNdisPage();
}

main();

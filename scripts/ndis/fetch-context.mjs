#!/usr/bin/env node
// Fetches scheme-size context (quarterly payments/participants from
// dataresearch.ndis.gov.au, disability counts from the ABS Data API) and
// writes data/ndis/context.json. Every top-level/sub block is independently
// optional per docs/ndis-spec.md — if a source is blocked or its shape
// changes, that block is omitted rather than guessed.
//
// Usage: node scripts/ndis/fetch-context.mjs

import { csvRowsToObjects, parseCsv, politeFetch, readJson, round2, todayIso, writeJson } from './util.mjs';

const OUTPUT_PATH = 'data/ndis/context.json';

const PAYMENTS_CSV_URL = 'https://dataresearch.ndis.gov.au/media/4577/download?attachment';
const PARTICIPANTS_CSV_URL = 'https://dataresearch.ndis.gov.au/media/4573/download?attachment';
const QUARTERLY_DATASETS_URL = 'https://dataresearch.ndis.gov.au/datasets';

// C21_G18 dimension order (confirmed against the dataflow's DSD,
// /rest/datastructure/ABS/C21_G18_SA2 and .../C21_G18_CED, which both expose
// the same six key positions): SEXP.AGEP.ASSNP.REGION.REGION_TYPE.STATE.
// SEXP=3 -> "Persons" (CL_C21_SEXP01), AGEP=_T -> "Total" (all ages,
// CL_C21_AGEP01), ASSNP=1 -> "Has need for assistance" (CL_C21_ASSNP01) — this
// is the "persons needing assistance" measure. REGION_TYPE=AUS + REGION blank
// (wildcard) selects the single national total row (CL_REGION_TYPE).
const CENSUS_ASSISTANCE_URL =
  'https://data.api.abs.gov.au/rest/data/C21_G18_SA2/3._T.1..AUS.?startPeriod=2021&format=csv';

// Same dataflow shape as above but REGION_TYPE=CED + REGION blank returns one
// row per Commonwealth Electoral Division (same SEXP=3/AGEP=_T/ASSNP=1 -
// "persons with need for assistance" - measure as the national query, so the
// two are directly comparable/cross-checkable). REGION carries only the CED
// *code* (e.g. "101") — names are resolved via the CL_CED_2021 codelist below,
// never guessed.
const ELECTORATES_DATA_URL =
  'https://data.api.abs.gov.au/rest/data/C21_G18_CED/3._T.1..CED.?startPeriod=2021&format=csv';
const CED_CODELIST_URL = 'https://data.api.abs.gov.au/rest/codelist/ABS/CL_CED_2021';

// State for each electorate row: the AUTHORITATIVE source is the CL_CED_2021
// codelist's own `parent` annotation on each CED code — a numeric state id
// (fetched live: e.g. code "101" Banks has parent "1", and the codelist's
// own state-level entries give id "1" -> "New South Wales"). This table maps
// that numeric id to the abbreviation used everywhere else in context.json
// (the payments CSV's RsdsInStateCd values). It is NOT used to derive state
// from the CED code's numeric prefix (1xx/2xx/... per the documented ASGS
// convention) — that convention is only used as a cross-check (see
// fetchElectorates): every row's codelist-derived state is asserted to match
// its code's leading digit, verified live against one division per state —
// 101 Banks->1 NSW, 201 Aston->2 VIC, 301 Blair->3 QLD, 401 Adelaide->4 SA,
// 501 Brand->5 WA, 601 Bass->6 TAS, 701 Lingiari->7 NT, 801 Bean->8 ACT —
// confirming the prefix convention holds before trusting it as a sanity
// check on every other row. Id "9" (Other Territories) has no RsdsInStateCd
// counterpart in the payments CSV; rows with state "OT" simply won't join to
// payments_by_state, which is fine (they're all non-geographic Census
// catch-alls with no boundary anyway — see build-boundaries.mjs).
const STATE_ID_TO_ABBR = { 1: 'NSW', 2: 'VIC', 3: 'QLD', 4: 'SA', 5: 'WA', 6: 'TAS', 7: 'NT', 8: 'ACT', 9: 'OT' };

// Real state/territory codes as they appear in the payments CSV's
// RsdsInStateCd column (verified against a real download — other values
// seen there are 'ALL', 'OT', 'Missing', and blank, none of which are a
// real jurisdiction for this purpose).
const REAL_STATE_CODES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'];

// Same C21_G18_CED dataflow/dimension order as ELECTORATES_DATA_URL, but
// ASSNP=_T ("Total", CL_C21_ASSNP01) instead of ASSNP=1 — total persons per
// division regardless of assistance-need status, i.e. the same-source
// per-division denominator docs/ndis-spec.md calls for. Verified against a
// real fetch: 169 CED rows, national sum ≈25.4M (plausible for 2021 Census
// total persons). Used only to add `total`/`share` to electorate rows — if
// this query fails, fetchElectorates() falls back to count-only rows.
const ELECTORATE_TOTALS_URL =
  'https://data.api.abs.gov.au/rest/data/C21_G18_CED/3._T._T..CED.?startPeriod=2021&format=csv';

// MEASURE=1 (Index numbers), INDEX=10001 (All groups CPI), TSEST=10 (Original),
// REGION=50 (Australia), FREQ=Q — verified against the ABS Data API's CPI DSD.
const CPI_URL = 'https://data.api.abs.gov.au/rest/data/CPI/1.10001.10.50.Q?startPeriod=2015-Q1&format=csv';

// Explicit, hand-checked mapping from the payments CSV's SuppCatNm to the
// Support Catalogue's category label (checked against
// data/ndis/snapshots/2026-27-v1.1.json's 15 category names). Only pairs with
// a unique, unambiguous textual correspondence (an exact match, or a
// distinctive phrase/word that appears in exactly one catalogue category) are
// mapped; docs/ndis-spec.md forbids fuzzy matching, so anything with zero or
// multiple plausible catalogue candidates is left unmapped (null) rather than
// guessed. Left unmapped, and why:
//   - "CB Choice and Control" / "Daily Activities" / "CB Daily Activity" /
//     "CB Home Living" / "CB Employment": no catalogue category shares a
//     distinctive phrase with these (or the closest candidate isn't a unique
//     textual match — e.g. "Daily" appears in both "Assistance with Daily
//     Life" and "Improved Daily Living Skills").
//   - "CB Social Community and Civic Participation" / "Social Community and
//     Civic Participation": two catalogue categories ("Assistance with
//     Social, Economic and Community Participation" and "Increased Social
//     and Community Participation") are both textually plausible.
//   - "Missing": a data-quality bucket in the source CSV, not a support
//     category.
const SUPP_CAT_TO_CATALOGUE_CATEGORY = {
  'Assistive Technology': 'Assistive Technology',
  'CB Health and Wellbeing': 'Improved Health and Wellbeing',
  'CB Lifelong Learning': 'Improved Learning',
  'CB Relationships': 'Improved Relationships',
  Consumables: 'Consumables',
  'Home Modifications': 'Home Modifications and Specialised Disability Accommodation (SDA)',
  'Support Coordination': 'Support Coordination',
  Transport: 'Transport',
};

// Hardcoded per docs/ndis-spec.md §Verified source facts — SDAC is a static
// file-only release (no API), last published 2024-07-04 for the 2022
// reference period. Not fetched; never guessed.
const SDAC = {
  label: 'Disability prevalence, SDAC 2022',
  value_pct: 21.4,
  released: '2024-07-04',
  source: {
    title: 'SDAC 2022 summary findings',
    url: 'https://www.abs.gov.au/statistics/health/disability/disability-ageing-and-carers-australia-summary-findings/2022',
    publisher: 'ABS',
  },
};

// 2026 Census was held 11 Aug 2026 (docs/ndis-spec.md); first release date
// (including disability data) is a fixed, publicly scheduled date, not
// something the quarterly/ABS APIs expose — hardcoded per the spec's
// verified facts.
const CENSUS_NEXT_RELEASE = { label: '2026 Census first release (includes disability)', due: '2027-06-30' };

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Handles both report-date formats seen across the two CSVs: "30-Jun-26"
// (payments) and "30JUN2026" (participants).
function parseNdisReportDate(raw) {
  const s = String(raw).trim();
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) throw new Error(`unrecognised month in report date "${raw}"`);
    const year = 2000 + parseInt(m[3], 10);
    return `${year}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = /^(\d{1,2})([A-Za-z]{3})(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) throw new Error(`unrecognised month in report date "${raw}"`);
    return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  throw new Error(`unrecognised NDIS report date format "${raw}"`);
}

function parseMoney(raw) {
  const n = Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(n)) throw new Error(`could not parse numeric value "${raw}"`);
  return n;
}

async function fetchCsvObjects(url) {
  const res = await politeFetch(url);
  if (!res.ok) throw new Error(`${url} responded ${res.status} ${res.statusText}`);
  const text = await res.text();
  return csvRowsToObjects(parseCsv(text));
}

// Payments CSV: national scheme-wide totals per SuppClass, broken down by
// SuppCatNm and other dimensions. National total for a quarter = sum of
// PmtAmt across every SuppClass row with every other dimension at 'ALL'.
// (Verified against a real download: figures are 12-months-to-report-date
// scheme totals, not single-quarter spend — see the `source.title` note
// below, which spells this out so the page never mislabels the number.)
function computePaymentsByQuarter(rows) {
  const isNationalAllRow = (r) =>
    r.SuppCatNm === 'ALL' && r.SuppItemNmbr === 'ALL' && r.RsdsInStateCd === 'ALL' &&
    r.NDISDsbltyGrpNm === 'ALL' && r.NDIAAgeBnd === 'ALL' && r.RprtDt;

  const totalsByQuarter = new Map();
  for (const r of rows) {
    if (!isNationalAllRow(r)) continue;
    const quarter = parseNdisReportDate(r.RprtDt);
    const amt = parseMoney(r.PmtAmt);
    totalsByQuarter.set(quarter, (totalsByQuarter.get(quarter) ?? 0) + amt);
  }
  return totalsByQuarter;
}

// Category-level rows: SuppItemNmbr/RsdsInStateCd/NDISDsbltyGrpNm/NDIAAgeBnd
// all 'ALL' but SuppCatNm not 'ALL' — one row per SuppCatNm in the current
// data (occasionally more than one if a category ever spans >1 SuppClass;
// payments are summed either way, participants only kept when exactly one
// row supplies a usable count, matching the spec's "the category-level ...
// row" singular).
function collectCategoryTotals(rows, latestRprtDt) {
  const isCategoryRow = (r) =>
    r.RprtDt === latestRprtDt && r.SuppItemNmbr === 'ALL' && r.RsdsInStateCd === 'ALL' &&
    r.NDISDsbltyGrpNm === 'ALL' && r.NDIAAgeBnd === 'ALL' && r.SuppCatNm && r.SuppCatNm !== 'ALL';

  const totals = new Map();
  for (const r of rows) {
    if (!isCategoryRow(r)) continue;
    const entry = totals.get(r.SuppCatNm) ?? { payments: 0, participantValues: [] };
    entry.payments += parseMoney(r.PmtAmt);
    const p = String(r.CountofParticipants ?? '').replace(/,/g, '').trim();
    if (/^-?\d+$/.test(p)) entry.participantValues.push(parseInt(p, 10));
    totals.set(r.SuppCatNm, entry);
  }
  return totals;
}

function computeTopCategories(rows, latestRprtDt, quarterTotal) {
  const totals = collectCategoryTotals(rows, latestRprtDt);
  return [...totals.entries()]
    .sort((a, b) => b[1].payments - a[1].payments || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([category, entry]) => ({
      category,
      payments: round2(entry.payments),
      // fraction 0-1 (not a percentage — Builder B multiplies by 100 to display)
      share: quarterTotal > 0 ? Math.round((entry.payments / quarterTotal) * 10000) / 10000 : 0,
    }));
}

// ALL SuppCatNm values (not just top-10), with catalogue_category joined via
// the explicit mapping table and participants/avg_per_participant when the
// CSV supplies a usable participant count for that category.
function computePaymentsByCategory(rows, latestRprtDt) {
  const totals = collectCategoryTotals(rows, latestRprtDt);
  return [...totals.entries()]
    .sort((a, b) => b[1].payments - a[1].payments || a[0].localeCompare(b[0]))
    .map(([category, entry]) => {
      const row = {
        category,
        catalogue_category: SUPP_CAT_TO_CATALOGUE_CATEGORY[category] ?? null,
        payments: round2(entry.payments),
      };
      if (entry.participantValues.length === 1) {
        const [participants] = entry.participantValues;
        row.participants = participants;
        if (participants > 0) row.avg_per_participant = Math.round(entry.payments / participants);
      }
      return row;
    });
}

function findLatestReportDate(paymentsRows) {
  const paymentsByQuarter = computePaymentsByQuarter(paymentsRows);
  const quarters = [...paymentsByQuarter.keys()].sort();
  if (quarters.length === 0) throw new Error('no quarters found in payments CSV — check row filters');
  const latestQuarter = quarters[quarters.length - 1];
  const latestRprtDtRaw = paymentsRows.find((r) => parseNdisReportDate(r.RprtDt) === latestQuarter).RprtDt;
  return { latestQuarter, latestRprtDtRaw, paymentsByQuarter, quarters };
}

function computeParticipantsByQuarter(rows) {
  const byQuarter = new Map();
  for (const r of rows) {
    if (r.StateCd === 'ALL' && r.SrvcDstrctNm === 'ALL' && r.DsbltyGrpNm === 'ALL' && r.AgeBnd === 'ALL' && r.SuppClass === 'ALL') {
      byQuarter.set(parseNdisReportDate(r.RprtDt), parseInt(String(r.ActvPrtcpnt).replace(/,/g, ''), 10));
    }
  }
  return byQuarter;
}

// Builds the quarterly block from already-fetched CSV rows (the payments CSV
// is fetched once in main() and reused here and by buildPaymentsByCategory —
// see §fetch rules / spec note on not re-downloading the ~14 MB file).
function buildQuarterly(paymentsRows, participantsRows) {
  const { latestQuarter, latestRprtDtRaw, paymentsByQuarter, quarters } = findLatestReportDate(paymentsRows);
  const participantsByQuarter = computeParticipantsByQuarter(participantsRows);

  const by_quarter = quarters.map((quarter) => ({
    quarter,
    payments_total: round2(paymentsByQuarter.get(quarter)),
    participants: participantsByQuarter.get(quarter) ?? null,
  }));

  const top_categories_latest = computeTopCategories(paymentsRows, latestRprtDtRaw, paymentsByQuarter.get(latestQuarter));

  return {
    as_of_quarter: latestQuarter,
    source: {
      title: 'NDIS payments data — 12 months to report date (not a single-quarter total); NDIA dataresearch',
      url: QUARTERLY_DATASETS_URL,
      publisher: 'NDIA',
    },
    by_quarter,
    top_categories_latest,
  };
}

// ALL SuppCatNm categories (not just top-10) for the latest report date,
// reusing the same paymentsRows buildQuarterly already has in memory.
function buildPaymentsByCategory(paymentsRows) {
  const { latestQuarter, latestRprtDtRaw } = findLatestReportDate(paymentsRows);
  const rows = computePaymentsByCategory(paymentsRows, latestRprtDtRaw);
  return {
    as_of_quarter: latestQuarter,
    window: '12 months to report date',
    source: { title: 'NDIS payments data, NDIA dataresearch', url: QUARTERLY_DATASETS_URL, publisher: 'NDIA' },
    rows,
  };
}

// State-level rows (RsdsInStateCd = a real state/territory code, one row per
// state) for the latest report date — the finest granularity the NDIA
// publishes; per-electorate payments are NOT published anywhere and must
// never be derived/estimated (this is what powers the map tooltip's dollars
// line, explicitly labelled by state so it's never misread as an electorate
// figure). Cross-checked against the national total the same way
// fetchElectorates() cross-checks against census_assistance — >2% off means
// something is wrong with the row filters, so the whole block is omitted
// rather than publishing a shaky number.
function computeStateTotals(rows, latestRprtDt) {
  const isStateRow = (r) =>
    r.RprtDt === latestRprtDt && r.SuppCatNm === 'ALL' && r.SuppItemNmbr === 'ALL' &&
    r.NDISDsbltyGrpNm === 'ALL' && r.NDIAAgeBnd === 'ALL' && REAL_STATE_CODES.includes(r.RsdsInStateCd);

  const totals = new Map();
  for (const r of rows) {
    if (!isStateRow(r)) continue;
    // A handful of rows in the source CSV carry a non-numeric PmtAmt (e.g.
    // "n/a", seen for suppressed/non-state buckets like 'Missing'/'OT' —
    // never for a real state in a real download) — skip rather than throw,
    // since REAL_STATE_CODES already excludes those buckets and a stray
    // non-numeric value shouldn't take down the whole block.
    const raw = String(r.PmtAmt).replace(/,/g, '').trim();
    const amt = Number(raw);
    if (!Number.isFinite(amt)) continue;
    totals.set(r.RsdsInStateCd, (totals.get(r.RsdsInStateCd) ?? 0) + amt);
  }
  return totals;
}

function buildPaymentsByState(paymentsRows) {
  const { latestQuarter, latestRprtDtRaw, paymentsByQuarter } = findLatestReportDate(paymentsRows);
  const totals = computeStateTotals(paymentsRows, latestRprtDtRaw);

  const missing = REAL_STATE_CODES.filter((s) => !totals.has(s));
  if (missing.length > 0) throw new Error(`no payment row found for state(s): ${missing.join(', ')}`);

  const rows = REAL_STATE_CODES.map((state) => ({ state, payments: round2(totals.get(state)) }));
  const sumStates = rows.reduce((acc, r) => acc + r.payments, 0);
  const nationalTotal = paymentsByQuarter.get(latestQuarter);
  const deltaPct = (Math.abs(sumStates - nationalTotal) / nationalTotal) * 100;
  console.log(
    `payments_by_state cross-check: sum of ${rows.length} states = ${sumStates}, national payments_total = ` +
      `${nationalTotal} (Δ ${deltaPct.toFixed(3)}%)`
  );
  if (deltaPct > 2) {
    throw new Error(`state payment totals (${sumStates}) differ from the national total (${nationalTotal}) by ${deltaPct.toFixed(2)}% (>2%)`);
  }

  return {
    as_of_quarter: latestQuarter,
    window: '12 months to report date',
    source: { title: 'NDIS payments data, NDIA dataresearch', url: QUARTERLY_DATASETS_URL, publisher: 'NDIA' },
    rows,
    national_total: round2(nationalTotal),
    delta_pct: Math.round(deltaPct * 1000) / 1000,
  };
}

async function fetchCensusAssistance() {
  const rows = await fetchCsvObjects(CENSUS_ASSISTANCE_URL);
  const row = rows[0];
  if (!row || !row.OBS_VALUE) throw new Error('census assistance query returned no OBS_VALUE row');
  return {
    label: 'People needing help with core activities, Census 2021',
    value: parseInt(String(row.OBS_VALUE).replace(/,/g, ''), 10),
    source: { title: 'ABS Data API, C21_G18_SA2 (national total)', url: CENSUS_ASSISTANCE_URL, publisher: 'ABS' },
  };
}

// Total-persons-per-CED map (code -> total), keyed off the ELECTORATE_TOTALS_URL
// query (see its comment). Returns null (never throws) so the caller can fall
// back to count-only rows gracefully per docs/ndis-spec.md's denominator rule.
async function fetchElectorateTotals() {
  try {
    const rows = await fetchCsvObjects(ELECTORATE_TOTALS_URL);
    if (rows.length === 0) throw new Error('electorate totals query returned no rows');
    const totalByCode = new Map();
    for (const r of rows) {
      const total = parseInt(String(r.OBS_VALUE).replace(/,/g, ''), 10);
      if (!Number.isFinite(total)) throw new Error(`unparseable total OBS_VALUE "${r.OBS_VALUE}" for CED code "${r.REGION}"`);
      totalByCode.set(r.REGION, total);
    }
    const sum = [...totalByCode.values()].reduce((acc, v) => acc + v, 0);
    // Sanity print only (spec: "plausibly ~25M") — not a hard gate, since the
    // 2021 Census total-persons figure isn't independently fetched here.
    console.log(`electorate totals: ${totalByCode.size} CED rows, national sum = ${sum} (plausibility check: ~25M expected)`);
    return totalByCode;
  } catch (err) {
    console.warn(`warning: electorate totals/share omitted — ${err.message}`);
    return null;
  }
}

// Electorate rows for the C21_G18_CED dataflow (see the ELECTORATES_DATA_URL
// comment for the confirmed dimension meanings). Electorate names are
// resolved from the CL_CED_2021 codelist (data only carries the numeric CED
// code) — never guessed from the code. Enforces the spec's cross-check: the
// sum of all electorate rows must be within 1% of the already-fetched
// national census_assistance.value, or the whole block is omitted.
async function fetchElectorates(censusAssistanceValue) {
  if (typeof censusAssistanceValue !== 'number' || !Number.isFinite(censusAssistanceValue)) {
    throw new Error('census_assistance.value unavailable this run — cannot cross-check');
  }

  const [dataRows, codelistRes] = await Promise.all([
    fetchCsvObjects(ELECTORATES_DATA_URL),
    politeFetch(CED_CODELIST_URL, { headers: { Accept: 'application/vnd.sdmx.structure+json' } }),
  ]);
  if (!codelistRes.ok) throw new Error(`${CED_CODELIST_URL} responded ${codelistRes.status} ${codelistRes.statusText}`);
  const codelistJson = await codelistRes.json();
  const codes = codelistJson?.data?.codelists?.[0]?.codes ?? [];
  if (codes.length === 0) throw new Error('CL_CED_2021 codelist returned no codes');
  const nameByCode = new Map(codes.map((c) => [c.id, c.names?.en ?? c.name]));
  const parentByCode = new Map(codes.map((c) => [c.id, c.parent]));

  const rows = dataRows.map((r) => {
    const code = r.REGION;
    const name = nameByCode.get(code);
    if (!name) throw new Error(`no electorate name found for CED code "${code}" in CL_CED_2021`);
    const need = parseInt(String(r.OBS_VALUE).replace(/,/g, ''), 10);
    if (!Number.isFinite(need)) throw new Error(`unparseable OBS_VALUE "${r.OBS_VALUE}" for CED code "${code}" (${name})`);

    // state: authoritative source is the codelist's own `parent` (see
    // STATE_ID_TO_ABBR's comment), cross-checked against the documented
    // CED-code-prefix convention (1xx NSW ... 8xx ACT, 9xx OT) — any
    // mismatch is a data-integrity problem worth failing loudly on, not
    // silently guessing past.
    const parentId = parentByCode.get(code);
    const state = STATE_ID_TO_ABBR[parentId];
    if (!state) throw new Error(`no state resolved for CED code "${code}" (${name}) — codelist parent "${parentId}"`);
    const expectedByPrefix = STATE_ID_TO_ABBR[code[0]];
    if (expectedByPrefix && expectedByPrefix !== state) {
      throw new Error(
        `CED code "${code}" (${name}): codelist parent state "${state}" doesn't match its numbering-convention prefix "${expectedByPrefix}"`
      );
    }

    return { name, code, need, state };
  });
  if (rows.length === 0) throw new Error('electorates query returned no rows');

  const dupNames = [...new Set(rows.map((r) => r.name).filter((n, i, arr) => arr.indexOf(n) !== i))];
  if (dupNames.length > 0) throw new Error(`duplicate electorate names resolved from codelist: ${dupNames.join(', ')}`);

  rows.sort((a, b) => a.name.localeCompare(b.name));

  const sumOfRows = rows.reduce((acc, r) => acc + r.need, 0);
  const deltaPct = (Math.abs(sumOfRows - censusAssistanceValue) / censusAssistanceValue) * 100;
  console.log(
    `electorates cross-check: sum of ${rows.length} CED rows = ${sumOfRows}, national census_assistance.value = ` +
      `${censusAssistanceValue} (Δ ${deltaPct.toFixed(3)}%)`
  );
  if (deltaPct > 1) {
    throw new Error(
      `sum of electorate rows (${sumOfRows}) differs from census_assistance.value (${censusAssistanceValue}) by ` +
        `${deltaPct.toFixed(2)}% (>1%) — refusing to publish mismatched numbers`
    );
  }

  // Verified denominator (docs/ndis-spec.md electorates block): same-source
  // total persons per division, via ASSNP=_T on the same dataflow. Only
  // attached when every row resolves a total — a partial/mismatched code set
  // would produce a misleading map, so in that case rows stay count-only
  // (graceful degradation, never a hard failure of the whole block).
  const totalByCode = await fetchElectorateTotals();
  if (totalByCode) {
    const missing = rows.filter((r) => !totalByCode.has(r.code));
    if (missing.length > 0) {
      console.warn(
        `warning: electorate totals/share omitted — ${missing.length} CED code(s) with no matching total ` +
          `(e.g. "${missing[0].code}" / ${missing[0].name})`
      );
    } else {
      for (const r of rows) {
        const total = totalByCode.get(r.code);
        r.total = total;
        r.share = total > 0 ? Math.round((r.need / total) * 10000) / 10000 : 0;
      }
    }
  }

  return {
    label: 'People needing help with core activities by federal electorate, Census 2021',
    source: { title: 'ABS Data API, C21_G18_CED', url: ELECTORATES_DATA_URL, publisher: 'ABS' },
    national_total: censusAssistanceValue,
    rows,
  };
}

function quarterEndIsoFromTimePeriod(timePeriod) {
  const m = /^(\d{4})-Q([1-4])$/.exec(timePeriod);
  if (!m) throw new Error(`unrecognised CPI TIME_PERIOD "${timePeriod}"`);
  const year = m[1];
  const endDates = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' };
  return `${year}-${endDates[m[2]]}`;
}

async function fetchCpi() {
  const rows = await fetchCsvObjects(CPI_URL);
  if (rows.length === 0) throw new Error('CPI query returned no rows');
  const series = rows
    .map((r) => ({ quarter: quarterEndIsoFromTimePeriod(r.TIME_PERIOD), index: Number(r.OBS_VALUE) }))
    .filter((p) => Number.isFinite(p.index))
    .sort((a, b) => a.quarter.localeCompare(b.quarter));
  if (series.length === 0) throw new Error('CPI query returned no usable index numbers');
  return { series, source: { title: 'ABS Data API, CPI (All groups, Index numbers, Australia, Quarterly)', url: CPI_URL, publisher: 'ABS' } };
}

async function main() {
  const context = { generated: todayIso() };

  // Fetch the ~14 MB payments CSV once and reuse it for both the quarterly
  // aggregation and the all-categories breakdown — never fetch it twice.
  let paymentsRows = null;
  try {
    paymentsRows = await fetchCsvObjects(PAYMENTS_CSV_URL);
  } catch (err) {
    console.warn(`warning: quarterly + payments_by_category omitted — payments CSV fetch failed: ${err.message}`);
  }

  if (paymentsRows) {
    try {
      const participantsRows = await fetchCsvObjects(PARTICIPANTS_CSV_URL);
      context.quarterly = buildQuarterly(paymentsRows, participantsRows);
      // The payments CSV is a rolling window that only carries recent report
      // dates — keep quarters recorded by earlier runs so the series accumulates
      // across scheduled refreshes (fresh data wins on a collision).
      const prior = readJson(OUTPUT_PATH, null)?.quarterly?.by_quarter ?? [];
      const merged = new Map(prior.map((q) => [q.quarter, q]));
      for (const q of context.quarterly.by_quarter) merged.set(q.quarter, q);
      context.quarterly.by_quarter = [...merged.values()].sort((a, b) => a.quarter.localeCompare(b.quarter));
    } catch (err) {
      console.warn(`warning: quarterly block omitted — ${err.message}`);
    }

    try {
      context.payments_by_category = buildPaymentsByCategory(paymentsRows);
    } catch (err) {
      console.warn(`warning: payments_by_category omitted — ${err.message}`);
    }

    try {
      context.payments_by_state = buildPaymentsByState(paymentsRows);
    } catch (err) {
      console.warn(`warning: payments_by_state omitted — ${err.message}`);
    }
  }

  const abs = {};
  try {
    abs.census_assistance = await fetchCensusAssistance();
  } catch (err) {
    console.warn(`warning: abs.census_assistance omitted — ${err.message}`);
  }
  abs.sdac = SDAC;
  if (Object.keys(abs).length > 0) context.abs = abs;

  try {
    if (context.abs?.census_assistance) {
      context.electorates = await fetchElectorates(context.abs.census_assistance.value);
    } else {
      console.warn('warning: electorates omitted — abs.census_assistance unavailable this run to cross-check against');
    }
  } catch (err) {
    console.warn(`warning: electorates omitted — ${err.message}`);
  }

  try {
    context.cpi = await fetchCpi();
  } catch (err) {
    console.warn(`warning: cpi block omitted — ${err.message}`);
  }

  const today = new Date();
  const quarterEndCandidates = [3, 6, 9, 12].flatMap((month) => [
    { month, year: today.getUTCFullYear() },
    { month, year: today.getUTCFullYear() + 1 },
  ]);
  const lastDayOfMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
  const next = quarterEndCandidates
    .map(({ month, year }) => new Date(Date.UTC(year, month - 1, lastDayOfMonth(year, month))))
    .filter((d) => d > today)
    .sort((a, b) => a - b)[0];
  const due = new Date(next.getTime());
  due.setUTCDate(due.getUTCDate() + 42);
  const quarterLabel = { 3: 'Mar', 6: 'Jun', 9: 'Sep', 12: 'Dec' }[next.getUTCMonth() + 1];

  context.next_data = [
    {
      label: `NDIA quarterly report (${quarterLabel} quarter)`,
      due: due.toISOString().slice(0, 10),
      note: 'published within 42 days of quarter end',
    },
    CENSUS_NEXT_RELEASE,
  ];

  writeJson(OUTPUT_PATH, context);
  console.log(
    `wrote ${OUTPUT_PATH} (quarterly: ${context.quarterly ? 'yes' : 'omitted'}, ` +
      `payments_by_category: ${context.payments_by_category ? `${context.payments_by_category.rows.length} categories` : 'omitted'}, ` +
      `payments_by_state: ${context.payments_by_state ? `${context.payments_by_state.rows.length} states` : 'omitted'}, ` +
      `abs.census_assistance: ${context.abs?.census_assistance ? 'yes' : 'omitted'}, ` +
      `electorates: ${context.electorates ? `${context.electorates.rows.length} rows` : 'omitted'}, ` +
      `cpi: ${context.cpi ? `${context.cpi.series.length} quarters` : 'omitted'})`
  );
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

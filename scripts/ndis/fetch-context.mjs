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

const CENSUS_ASSISTANCE_URL =
  'https://data.api.abs.gov.au/rest/data/C21_G18_SA2/3._T.1..AUS.?startPeriod=2021&format=csv';
// MEASURE=1 (Index numbers), INDEX=10001 (All groups CPI), TSEST=10 (Original),
// REGION=50 (Australia), FREQ=Q — verified against the ABS Data API's CPI DSD.
const CPI_URL = 'https://data.api.abs.gov.au/rest/data/CPI/1.10001.10.50.Q?startPeriod=2015-Q1&format=csv';

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

function computeTopCategories(rows, latestRprtDt, quarterTotal) {
  const isCategoryRow = (r) =>
    r.RprtDt === latestRprtDt && r.SuppItemNmbr === 'ALL' && r.RsdsInStateCd === 'ALL' &&
    r.NDISDsbltyGrpNm === 'ALL' && r.NDIAAgeBnd === 'ALL' && r.SuppCatNm && r.SuppCatNm !== 'ALL';

  const totalsByCategory = new Map();
  for (const r of rows) {
    if (!isCategoryRow(r)) continue;
    const amt = parseMoney(r.PmtAmt);
    totalsByCategory.set(r.SuppCatNm, (totalsByCategory.get(r.SuppCatNm) ?? 0) + amt);
  }

  return [...totalsByCategory.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([category, payments]) => ({
      category,
      payments: round2(payments),
      // fraction 0-1 (not a percentage — Builder B multiplies by 100 to display)
      share: quarterTotal > 0 ? Math.round((payments / quarterTotal) * 10000) / 10000 : 0,
    }));
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

async function fetchQuarterly() {
  const [paymentsRows, participantsRows] = await Promise.all([
    fetchCsvObjects(PAYMENTS_CSV_URL),
    fetchCsvObjects(PARTICIPANTS_CSV_URL),
  ]);

  const paymentsByQuarter = computePaymentsByQuarter(paymentsRows);
  const participantsByQuarter = computeParticipantsByQuarter(participantsRows);

  const quarters = [...paymentsByQuarter.keys()].sort();
  if (quarters.length === 0) throw new Error('no quarters found in payments CSV — check row filters');

  const by_quarter = quarters.map((quarter) => ({
    quarter,
    payments_total: round2(paymentsByQuarter.get(quarter)),
    participants: participantsByQuarter.get(quarter) ?? null,
  }));

  const latestQuarter = quarters[quarters.length - 1];
  const latestRprtDtRaw = paymentsRows.find((r) => parseNdisReportDate(r.RprtDt) === latestQuarter).RprtDt;
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

  try {
    context.quarterly = await fetchQuarterly();
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

  const abs = {};
  try {
    abs.census_assistance = await fetchCensusAssistance();
  } catch (err) {
    console.warn(`warning: abs.census_assistance omitted — ${err.message}`);
  }
  abs.sdac = SDAC;
  if (Object.keys(abs).length > 0) context.abs = abs;

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
      `abs.census_assistance: ${context.abs?.census_assistance ? 'yes' : 'omitted'}, ` +
      `cpi: ${context.cpi ? `${context.cpi.series.length} quarters` : 'omitted'})`
  );
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

'use strict';
/* ==========================================================================
   Common Ground — NDIS Tracker behaviour
   Section map:
     1  Small generic helpers (escaping, formatting)
     2  Pure data functions
     3  Constants
     4  App state
     5  Theme (shared storage key with the main app)
     6  Header / footer / nav rendering
     7  Section 1 — What changed in pricing (incl. W-A "The real price of care")
     8  Section 2 — Price history explorer (incl. W-C "Your supports, repriced")
     9  Section 3 — Where the money goes (W-B)
     10 Section 4 — The law
     11 Section 5 — Updates
     12 Section 6 — Scheme in numbers (incl. W-D "Your electorate")
     13 Overview view (front page)
     14 View routing (hash-based) + top-level render orchestration + init
   Views are hash-routed (#/pricing etc, see VIEW_META below) — only the
   active view's section is rendered each pass; every other section is
   emptied and hidden. Per-view UI state (pinned items, search, filters,
   diff picker, cpi overlay, electorate) lives in the single `state` object
   below, so switching views and back preserves it untouched.
   No globals beyond window.NDIS — everything else lives inside the IIFE.
   Every dynamic data string is passed through esc() before insertion — one
   choke point (setHtml) parses the assembled, pre-escaped markup into the DOM.
   ========================================================================== */

(function () {

  /* ------------------------------------------------------------------------
     1. Small generic helpers
     ------------------------------------------------------------------------ */

  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, function (ch) { return ESC_MAP[ch]; });
  }

  // Single choke point for building markup from strings. Every dynamic data
  // value that flows into these strings is passed through esc() first (see
  // the render* functions below). Clears the element then parses the
  // assembled markup in one shot — same net effect as a bulk HTML assignment,
  // just via a different DOM entry point.
  function setHtml(el, htmlString) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    el.insertAdjacentHTML('beforeend', htmlString);
  }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function dateParts(iso) {
    var p = String(iso || '').split('-');
    return { y: parseInt(p[0], 10), m: parseInt(p[1], 10), d: parseInt(p[2], 10) };
  }
  function fmtDateLong(iso) {
    var p = dateParts(iso);
    if (!p.y) return '';
    return p.d + ' ' + MONTHS_SHORT[p.m - 1] + ' ' + p.y;
  }
  function monthHeading(iso) {
    var p = dateParts(iso);
    if (!p.y) return '';
    return MONTHS[p.m - 1] + ' ' + p.y;
  }
  function monthKey(iso) {
    var p = dateParts(iso);
    return p.y + '-' + (p.m < 10 ? '0' + p.m : p.m);
  }
  function parseIsoMs(iso) {
    var p = dateParts(iso);
    if (!p.y) return NaN;
    return Date.UTC(p.y, (p.m || 1) - 1, p.d || 1);
  }
  function subtractYears(iso, years) {
    var p = dateParts(iso);
    return (p.y - years) + '-' + (p.m < 10 ? '0' + p.m : p.m) + '-' + (p.d < 10 ? '0' + p.d : p.d);
  }

  function fmtDollars(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Math.round(n).toLocaleString('en-AU');
  }
  // Sign printed before the "$" ("-$3,000", not "$-3,000") — matters for the
  // rare negative figure (e.g. a source-data reconciliation row in W-B).
  function fmtCompactCurrency(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var sign = n < 0 ? '-' : '';
    var abs = Math.abs(n);
    if (abs >= 1e9) return sign + '$' + (abs / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return sign + '$' + Math.round(abs).toLocaleString('en-AU');
    return fmtDollars(n);
  }
  function fmtPctSigned(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function truncate(str, max) {
    str = String(str || '');
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }

  /* ------------------------------------------------------------------------
     2. Pure data functions
     ------------------------------------------------------------------------ */

  function medianOf(nums) {
    if (!nums || !nums.length) return null;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // 5 discrete bins over a symmetric domain [-maxAbs, maxAbs], keyed by magnitude.
  function rampBin(value, maxAbs) {
    if (!maxAbs) return 0;
    var frac = Math.min(1, Math.abs(value) / maxAbs);
    return Math.min(4, Math.floor(frac * 5));
  }

  function buildRuns(history) {
    var runs = [];
    var current = null;
    (history || []).forEach(function (v, i) {
      if (v === null || v === undefined) {
        if (current) { runs.push(current); current = null; }
        return;
      }
      if (!current) current = [];
      current.push({ i: i, v: v });
    });
    if (current) runs.push(current);
    return runs;
  }

  function nearestSeriesValue(series, dateField, valueField, targetIso) {
    if (!series || !series.length) return null;
    var target = parseIsoMs(targetIso);
    var best = null, bestDiff = Infinity;
    series.forEach(function (pt) {
      var diff = Math.abs(parseIsoMs(pt[dateField]) - target);
      if (diff < bestDiff) { bestDiff = diff; best = pt[valueField]; }
    });
    return best;
  }

  var MIN_QUALIFYING_ITEMS = 5;

  // W-A "The real price of care" — one row per support category present in >=2
  // releases (docs/ndis-spec.md "Consolidation widgets"). For each category:
  // find the earliest/latest release index at which ANY item in the category
  // is priced (the category's own span, not the page-wide span); among items
  // priced at BOTH endpoints, take each item's price ratio (last/first) —
  // category nominal change = median ratio - 1. CPI change over the same
  // date span = cpi(last effective)/cpi(first effective) - 1 (nearest
  // quarter). Real-terms change = (1+nominal)/(1+cpiChange) - 1. Categories
  // with fewer than MIN_QUALIFYING_ITEMS qualifying items are skipped (but
  // counted, for the footnote). Requires a CPI series — without one there is
  // no real-terms figure to show, so the whole widget is data-absent.
  function computeRealPriceGrid(ndis) {
    var releases = ndis.releases;
    var cpi = ndis.context && ndis.context.cpi;
    if (!releases || releases.length < 2 || !cpi || !cpi.series || !cpi.series.length) return null;
    if (!ndis.items || !ndis.items.length) return null;

    var byCategory = {};
    var order = [];
    ndis.items.forEach(function (item) {
      if (!byCategory[item.category]) { byCategory[item.category] = []; order.push(item.category); }
      byCategory[item.category].push(item);
    });
    order.sort();

    var cells = [];
    var skipped = [];
    var eligibleCategoryCount = 0;

    order.forEach(function (category) {
      var items = byCategory[category];
      var minIdx = -1, maxIdx = -1;
      items.forEach(function (item) {
        (item.history || []).forEach(function (v, i) {
          if (v === null || v === undefined) return;
          if (minIdx === -1 || i < minIdx) minIdx = i;
          if (maxIdx === -1 || i > maxIdx) maxIdx = i;
        });
      });
      if (minIdx === -1 || minIdx === maxIdx) return; // not present in >=2 releases

      eligibleCategoryCount++;
      var ratios = [];
      var qualifying = [];
      items.forEach(function (item) {
        var a = item.history[minIdx], b = item.history[maxIdx];
        if (a !== null && a !== undefined && b !== null && b !== undefined && a > 0) {
          ratios.push(b / a);
          qualifying.push(item);
        }
      });
      if (ratios.length < MIN_QUALIFYING_ITEMS) { skipped.push({ category: category, n: ratios.length }); return; }

      var nominal = medianOf(ratios) - 1;
      var cpiFirst = nearestSeriesValue(cpi.series, 'quarter', 'index', releases[minIdx].effective);
      var cpiLast = nearestSeriesValue(cpi.series, 'quarter', 'index', releases[maxIdx].effective);
      if (!cpiFirst || !cpiLast) { skipped.push({ category: category, n: ratios.length }); return; }
      var cpiChange = (cpiLast / cpiFirst) - 1;
      var real = (1 + nominal) / (1 + cpiChange) - 1;

      var itemTrend = [], cpiTrend = [];
      for (var i = minIdx; i <= maxIdx; i++) {
        var vals = [];
        qualifying.forEach(function (item) { var v = item.history[i]; if (v !== null && v !== undefined) vals.push(v); });
        itemTrend.push(vals.length ? medianOf(vals) : null);
        cpiTrend.push(nearestSeriesValue(cpi.series, 'quarter', 'index', releases[i].effective));
      }
      // Index both series to 100 at the category's earliest release so the
      // mini chart reads as "item median vs CPI", not raw dollars vs an index.
      var base = itemTrend[0], cpiBase = cpiTrend[0];
      var itemIndex = itemTrend.map(function (v) { return (v === null || !base) ? null : (v / base) * 100; });
      var cpiIndex = cpiTrend.map(function (v) { return (v === null || !cpiBase) ? null : (v / cpiBase) * 100; });

      cells.push({
        category: category,
        n: ratios.length,
        nominal: nominal,
        real: real,
        itemIndex: itemIndex,
        cpiIndex: cpiIndex,
        fromFy: releases[minIdx].fy,
        toFy: releases[maxIdx].fy
      });
    });

    cells.sort(function (a, b) { return a.real - b.real; });
    return { cells: cells, skipped: skipped, eligibleCategoryCount: eligibleCategoryCount };
  }

  // W-C "Your supports, repriced" — driven by the explorer's pinned items
  // (state.pinned). For each pinned item priced in >=2 releases: % change
  // from the first to the last release it is priced in (the item's own
  // span), and the matching CPI change over that same span. Basket figure =
  // equal-weighted mean across pinned items; CPI comparator = equal-weighted
  // mean of each item's own-span CPI change (averaged only over items where
  // CPI is resolvable).
  function computeRepriced(ndis) {
    if (!state.pinned.length) return null;
    var itemByNum = {};
    ndis.items.forEach(function (i) { itemByNum[i.num] = i; });
    var cpi = ndis.context && ndis.context.cpi;
    var releases = ndis.releases;

    var rows = [];
    state.pinned.forEach(function (num) {
      var item = itemByNum[num];
      if (!item) return;
      var firstIdx = -1, lastIdx = -1;
      (item.history || []).forEach(function (v, i) {
        if (v === null || v === undefined) return;
        if (firstIdx === -1) firstIdx = i;
        lastIdx = i;
      });
      if (firstIdx === -1 || firstIdx === lastIdx) return; // needs >=2 priced releases

      var first = item.history[firstIdx], last = item.history[lastIdx];
      var pct = ((last - first) / first) * 100;
      var cpiPct = null;
      if (cpi && cpi.series && cpi.series.length) {
        var cpiFirst = nearestSeriesValue(cpi.series, 'quarter', 'index', releases[firstIdx].effective);
        var cpiLast = nearestSeriesValue(cpi.series, 'quarter', 'index', releases[lastIdx].effective);
        if (cpiFirst && cpiLast) cpiPct = ((cpiLast - cpiFirst) / cpiFirst) * 100;
      }
      rows.push({
        num: num,
        name: item.name,
        fromFy: releases[firstIdx].fy,
        toFy: releases[lastIdx].fy,
        pct: pct,
        cpiPct: cpiPct
      });
    });
    if (!rows.length) return null;

    var basket = rows.reduce(function (s, r) { return s + r.pct; }, 0) / rows.length;
    var cpiRows = rows.filter(function (r) { return r.cpiPct !== null; });
    var cpiBasket = cpiRows.length ? cpiRows.reduce(function (s, r) { return s + r.cpiPct; }, 0) / cpiRows.length : null;

    return { rows: rows, basket: basket, cpiBasket: cpiBasket, cpiCoverage: cpiRows.length };
  }

  /* ------------------------------------------------------------------------
     3. Constants
     ------------------------------------------------------------------------ */

  var RAMP_HEX = ['#cde2fb', '#9db7d7', '#6d8cb3', '#3d618f', '#0d366b'];

  var THEME_KEY = 'common-ground-theme';
  var THEME_CYCLE = ['auto', 'light', 'dark'];
  var THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };
  var THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };

  var TYPE_META = {
    pricing: { emoji: '💲', label: 'Pricing' },
    law: { emoji: '⚖️', label: 'Law' },
    bill: { emoji: '📜', label: 'Bill' },
    hearing: { emoji: '🎙️', label: 'Hearing' },
    report: { emoji: '📊', label: 'Report' },
    audit: { emoji: '🔍', label: 'Audit' },
    announcement: { emoji: '📢', label: 'Announcement' },
    data: { emoji: '📈', label: 'Data' }
  };
  var LAW_TYPE_LABEL = {
    Act: 'Act',
    LegislativeInstrument: 'Instrument',
    compilation: 'Compilation',
    bill: 'Bill',
    law: 'Law'
  };
  var STATUS_LABEL = { InForce: 'In force', Repealed: 'Repealed', AsMade: 'As made', NotYetInForce: 'Not yet in force' };

  var DASH_CLASS = ['', 'dash-2', 'dash-3'];
  var MAX_PINNED = 3;
  var MAX_SEARCH_RESULTS = 50;

  /* ------------------------------------------------------------------------
     4. App state
     ------------------------------------------------------------------------ */

  var state = {
    theme: 'auto',
    view: 'overview',
    diffRelease: null,
    search: '',
    pinned: [],
    feedTypes: new Set(),
    cpiOverlay: false,
    pinHint: '',
    feedHint: '',
    electorate: ''
  };

  var NDIS = null;

  /* ------------------------------------------------------------------------
     5. Theme (same behaviour + storage key as the main app)
     ------------------------------------------------------------------------ */

  function loadStoredTheme() {
    try { return window.localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }
  function storeTheme(value) {
    try { window.localStorage.setItem(THEME_KEY, value); } catch (e) { /* storage unavailable — ignore */ }
  }
  function applyTheme(theme) {
    var html = document.documentElement;
    if (theme === 'auto') html.removeAttribute('data-theme');
    else html.setAttribute('data-theme', theme);
    var iconEl = document.getElementById('themeToggleIcon');
    var labelEl = document.getElementById('themeToggleLabel');
    if (iconEl) iconEl.textContent = THEME_ICON[theme];
    if (labelEl) labelEl.textContent = THEME_LABEL[theme];
  }
  function initTheme() {
    var stored = loadStoredTheme();
    state.theme = THEME_CYCLE.indexOf(stored) !== -1 ? stored : 'auto';
    applyTheme(state.theme);
    var btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var idx = THEME_CYCLE.indexOf(state.theme);
      state.theme = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
      applyTheme(state.theme);
      storeTheme(state.theme);
    });
  }

  /* ------------------------------------------------------------------------
     6. Header / footer rendering
     ------------------------------------------------------------------------ */

  function renderHeader(ndis) {
    var editionEl = document.getElementById('mastheadEdition');
    var subtitleEl = document.getElementById('mastheadSubtitle');
    var metaEl = document.getElementById('mastheadMeta');
    if (!ndis) {
      if (editionEl) editionEl.textContent = '';
      if (subtitleEl) subtitleEl.textContent = 'No data loaded.';
      if (metaEl) metaEl.textContent = '';
      return;
    }
    if (editionEl) editionEl.textContent = 'Data edition · as of ' + fmtDateLong(ndis.meta.as_of);
    if (subtitleEl) subtitleEl.textContent = 'Prices, legislation and scheme data for the NDIS — every figure and claim links to an official source.';
    if (metaEl) metaEl.textContent = 'Sources: NDIA, Federal Register of Legislation, Parliament of Australia, ABS · as of ' + ndis.meta.as_of;
  }

  // The masthead index row IS the view nav (docs/ndis-spec.md "Views &
  // routing"): one real <a href="#/..."> per view, in fixed page order,
  // always all seven — a view with no data yet stays in the row but muted
  // with a "no data yet" title rather than disappearing. The active view is
  // in ink with an underline and aria-current="page"; others are muted.
  // VIEW_META is defined below (§14); this only needs it to exist by the
  // time renderNav actually runs (after init()), not at parse time.
  function renderNav(ndis) {
    var el = document.getElementById('mastheadIndex');
    if (!el) return;
    if (!ndis) { setHtml(el, ''); return; }
    var html = VIEW_META.map(function (v, i) {
      var hasData = v.key === 'overview' ? true : v.hasData(ndis);
      var isActive = v.key === state.view;
      var cls = 'masthead-index-link' + (hasData ? '' : ' is-muted');
      var attrs = ' href="' + esc(v.hash) + '" class="' + cls + '"';
      if (isActive) attrs += ' aria-current="page"';
      if (!hasData) attrs += ' title="No data yet"';
      var numberBit = v.number ? '<span class="masthead-index-num" aria-hidden="true">&sect; ' + v.number + '</span> ' : '';
      var sep = i < VIEW_META.length - 1 ? '<span class="masthead-index-sep" aria-hidden="true"> · </span>' : '';
      return '<a' + attrs + '>' + numberBit + esc(v.navLabel) + '</a>' + sep;
    }).join('');
    setHtml(el, html);
  }

  // Lead-story pull-stat: one editorial number computed from window.NDIS,
  // never hardcoded. Counts support items whose price has never differed
  // across the releases in which they appear (>=2 priced releases).
  function computeLeadStat(ndis) {
    if (!ndis || !ndis.items || !ndis.items.length || !ndis.releases || ndis.releases.length < 2) return null;
    // Caption must state exactly what is counted: among items PRICED IN TWO OR
    // MORE releases, those whose price is identical in every release they
    // appear in. The denominator is that eligible set — not all tracked items.
    var eligible = 0;
    var unchanged = 0;
    ndis.items.forEach(function (item) {
      var vals = (item.history || []).filter(function (v) { return v !== null && v !== undefined; });
      if (vals.length < 2) return;
      eligible++;
      if (vals.every(function (v) { return v === vals[0]; })) unchanged++;
    });
    if (eligible === 0) return null;
    var firstFy = ndis.releases[0].fy;
    var lastFy = ndis.releases[ndis.releases.length - 1].fy;
    return {
      value: unchanged,
      caption: 'of the ' + eligible.toLocaleString('en-AU') + ' support items priced in two or more catalogue releases (' +
        firstFy + ' to ' + lastFy + '), ' + unchanged.toLocaleString('en-AU') +
        ' have kept exactly the same price in every release they appear in.'
    };
  }

  function renderLeadStat(ndis) {
    var el = document.getElementById('leadStat');
    if (!el) return;
    var stat = ndis ? computeLeadStat(ndis) : null;
    if (!stat) { el.hidden = true; setHtml(el, ''); return; }
    el.hidden = false;
    setHtml(el,
      '<div class="lead-stat-figure tnum">' + fmtNum(stat.value) + '</div>' +
      '<p class="lead-stat-caption">' + esc(stat.caption) + '</p>'
    );
  }

  function renderFooter(ndis) {
    var el = document.getElementById('siteFooter');
    if (!ndis) { setHtml(el, ''); return; }
    setHtml(el,
      '<p>' + esc(ndis.meta.methodology) + '</p>' +
      '<p>' + esc(ndis.meta.disclaimer) + '</p>' +
      '<p><strong>Sources:</strong> NDIA, Federal Register of Legislation, Parliament of Australia, ABS.</p>' +
      '<p><a href="./index.html">← Back to Common Ground</a></p>' +
      '<p>Summaries paraphrase cited sources — always check the link.</p>'
    );
  }

  /* ------------------------------------------------------------------------
     7. Section 1 — What changed in pricing
     ------------------------------------------------------------------------ */

  function renderDotStrip(items, maxAbs) {
    if (!items.length) return '<span class="dot-strip-empty">—</span>';
    var w = 190, h = 28, cx0 = w / 2;
    var dots = items.map(function (it) {
      var bin = rampBin(it.pct, maxAbs);
      var frac = Math.max(-1, Math.min(1, it.pct / (maxAbs || 1)));
      var cx = cx0 + frac * (cx0 - 14);
      // 2px surface-colour ring keeps overlapping dots (close pct values) legible.
      return '<circle cx="' + cx.toFixed(1) + '" cy="12" r="4" fill="' + RAMP_HEX[bin] + '" stroke="var(--surface)" stroke-width="2"></circle>';
    }).join('');
    return (
      '<svg class="dot-strip-svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' +
        '<line x1="' + cx0 + '" y1="2" x2="' + cx0 + '" y2="20" stroke="var(--hairline)" stroke-width="1"></line>' +
        dots +
        '<text class="dot-strip-axis-label" x="2" y="26" text-anchor="start">−</text>' +
        '<text class="dot-strip-axis-label" x="' + cx0 + '" y="26" text-anchor="middle">0</text>' +
        '<text class="dot-strip-axis-label" x="' + (w - 2) + '" y="26" text-anchor="end">+</text>' +
      '</svg>'
    );
  }

  // Combined "change" cell: sign chip with an inline magnitude bar (ramp-coloured,
  // width proportional to |median_pct|), stacked above the item-level dot-strip.
  // Printed percentage is always present beside the bar — colour never carries
  // meaning alone.
  function renderChangeCell(cat, items, maxAbs, maxCategoryAbs) {
    if (cat.changed <= 0) return '<span class="dot-strip-empty">—</span>';
    var signCls = cat.median_pct >= 0 ? 'is-increase' : 'is-decrease';
    var bin = rampBin(cat.median_pct, maxCategoryAbs);
    var barPct = maxCategoryAbs ? Math.max(6, Math.round((Math.abs(cat.median_pct) / maxCategoryAbs) * 100)) : 6;
    return (
      '<div class="change-cell">' +
        '<div class="mag-bar-row">' +
          '<span class="mag-bar" style="width:' + barPct + '%;background:' + RAMP_HEX[bin] + '"></span>' +
          '<span class="sign-chip ' + signCls + '">' + fmtPctSigned(cat.median_pct) + '</span>' +
        '</div>' +
        renderDotStrip(items, maxAbs) +
      '</div>'
    );
  }

  function renderCategoryDetails(diff, category) {
    var items = diff.changed.filter(function (c) { return c.category === category; });
    if (!items.length) return '';
    var rows = items.map(function (c) {
      return (
        '<tr><td>' + esc(c.name) + '<span class="search-result-num">' + esc(c.num) + '</span></td>' +
          '<td class="tnum">' + fmtDollars(c.old) + '</td>' +
          '<td class="tnum">' + fmtDollars(c.new) + '</td>' +
          '<td class="tnum">' + fmtPctSigned(c.pct) + '</td></tr>'
      );
    }).join('');
    return (
      '<details class="category-details"><summary>Item-level changes (' + items.length + ')</summary>' +
        '<table class="category-item-table">' +
          '<thead><tr><th>Item</th><th class="tnum">Old</th><th class="tnum">New</th><th class="tnum">Δ%</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</details>'
    );
  }

  function renderItemListDetails(idPrefix, label, list, showPrice) {
    if (!list || !list.length) return '';
    var items = list.map(function (it) {
      var priceBit = showPrice ? ' — ' + fmtDollars(it.price) : '';
      return (
        '<li>' + esc(it.name) + priceBit +
          '<span class="item-list-num">' + esc(it.num) + ' · ' + esc(it.category) + '</span></li>'
      );
    }).join('');
    var cats = {};
    list.forEach(function (it) { cats[it.category] = true; });
    var catCount = Object.keys(cats).length;
    var summaryText = esc(label) + ' — ' + list.length + ' item' + (list.length === 1 ? '' : 's') +
      ' across ' + catCount + ' categor' + (catCount === 1 ? 'y' : 'ies');
    return (
      '<details class="item-list-details" id="' + idPrefix + '"><summary>' + summaryText + '</summary>' +
        '<ul>' + items + '</ul>' +
      '</details>'
    );
  }

  // Tiny ink-coloured sparkline (pure SVG, ~60x16) from an item's price
  // history, normalised to its own min/max. Decorative only — the figures it
  // accompanies (old -> new, signed %) are always printed in text beside it.
  function buildSparkline(history) {
    var pts = [];
    (history || []).forEach(function (v, i) { if (v !== null && v !== undefined) pts.push(v); });
    if (pts.length < 2) return '';
    var w = 60, h = 16, pad = 2;
    var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
    if (min === max) { min -= 1; max += 1; }
    var step = (w - 2 * pad) / (pts.length - 1);
    var coords = pts.map(function (v, i) {
      var x = pad + i * step;
      var y = pad + (h - 2 * pad) * (1 - (v - min) / (max - min));
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return (
      '<svg class="mover-spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' +
        '<polyline points="' + coords + '" fill="none" stroke="var(--ink)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></polyline>' +
      '</svg>'
    );
  }

  // "In brief" sidebar: top 3 increases + top 3 decreases from the current
  // diff. Item name, old -> new, signed %, plus a tiny sparkline of its full
  // price history. All computed from the diff already loaded — no new data.
  function renderMovers(current, ndis) {
    if (!current.changed.length) return '';
    var itemByNum = {};
    ndis.items.forEach(function (i) { itemByNum[i.num] = i; });
    var sorted = current.changed.slice().sort(function (a, b) { return b.pct - a.pct; });
    var increases = sorted.filter(function (c) { return c.pct > 0; }).slice(0, 3);
    var decreases = sorted.filter(function (c) { return c.pct < 0; })
      .sort(function (a, b) { return a.pct - b.pct; }).slice(0, 3);

    function row(c) {
      var item = itemByNum[c.num];
      var spark = item ? buildSparkline(item.history) : '';
      var cls = c.pct >= 0 ? 'is-increase' : 'is-decrease';
      return (
        '<li class="mover-item">' +
          '<div class="mover-head"><span class="mover-name">' + esc(truncate(c.name, 34)) + '</span>' + spark + '</div>' +
          '<div class="mover-detail"><span class="tnum">' + fmtDollars(c.old) + ' → ' + fmtDollars(c.new) + '</span>' +
            '<span class="sign-chip ' + cls + '">' + fmtPctSigned(c.pct) + '</span></div>' +
        '</li>'
      );
    }

    var incHtml = increases.length ? '<h4 class="movers-subhead">Biggest increases</h4><ul class="movers-list">' + increases.map(row).join('') + '</ul>' : '';
    var decHtml = decreases.length ? '<h4 class="movers-subhead">Biggest decreases</h4><ul class="movers-list">' + decreases.map(row).join('') + '</ul>' : '';
    if (!incHtml && !decHtml) return '';
    return '<aside class="movers-module" aria-label="Biggest price movers this release"><p class="movers-kicker">In brief</p>' + incHtml + decHtml + '</aside>';
  }

  // Small colophon: which release this diff lands on, its effective date,
  // item count and source link — from ndis.releases, graceful if absent.
  function renderColophon(current, ndis) {
    var release = (ndis.releases || []).filter(function (r) { return r.release === current.to; })[0];
    if (!release) return '';
    return (
      '<div class="colophon">' +
        '<p class="colophon-label">This release</p>' +
        '<p class="colophon-line"><strong class="tnum">' + esc(release.release) + '</strong></p>' +
        '<p class="colophon-line">Effective ' + esc(fmtDateLong(release.effective)) + '</p>' +
        '<p class="colophon-line tnum">' + fmtNum(release.item_count) + ' priced items</p>' +
        '<p class="colophon-line"><a href="' + esc(release.source_url) + '" target="_blank" rel="noopener">Source catalogue ↗</a></p>' +
      '</div>'
    );
  }

  // Two-line mini index chart for a W-A cell: item-median index (solid ink)
  // vs CPI index (dashed, muted ink), both based at 100 = the category's
  // earliest qualifying release. Decorative (aria-hidden) — the accompanying
  // nominal/real figures are the printed twin required by the accessibility
  // bar. Positions are spaced by release ordinal, not by date (same
  // simplification as buildSparkline elsewhere on this page).
  function buildIndexMiniChart(itemIndex, cpiIndex) {
    var w = 148, h = 46, padX = 5, padY = 6;
    var all = [];
    itemIndex.forEach(function (v) { if (v !== null && v !== undefined) all.push(v); });
    cpiIndex.forEach(function (v) { if (v !== null && v !== undefined) all.push(v); });
    if (all.length < 2) return '';
    var min = Math.min.apply(null, all), max = Math.max.apply(null, all);
    if (min === max) { min -= 1; max += 1; }
    var n = itemIndex.length;
    var step = n > 1 ? (w - 2 * padX) / (n - 1) : 0;
    function xAt(i) { return padX + i * step; }
    function yAt(v) { return padY + (h - 2 * padY) * (1 - (v - min) / (max - min)); }
    function pathFor(vals, cls) {
      var svg = '';
      buildRuns(vals).forEach(function (run) {
        if (run.length < 2) return;
        var pts = run.map(function (pt) { return xAt(pt.i).toFixed(1) + ',' + yAt(pt.v).toFixed(1); }).join(' ');
        svg += '<polyline class="' + cls + '" points="' + pts + '"></polyline>';
      });
      return svg;
    }
    var baselineSvg = (min <= 100 && 100 <= max)
      ? '<line class="rpc-chart-baseline" x1="' + padX + '" y1="' + yAt(100).toFixed(1) + '" x2="' + (w - padX) + '" y2="' + yAt(100).toFixed(1) + '"></line>'
      : '';
    return (
      '<svg class="rpc-chart-svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' +
        baselineSvg + pathFor(cpiIndex, 'rpc-chart-cpi') + pathFor(itemIndex, 'rpc-chart-item') +
      '</svg>'
    );
  }

  // W-A "The real price of care" — small-multiples grid, one cell per
  // category (see computeRealPriceGrid for the method). Rendered inside
  // section 1, after the diff table; entirely optional (returns '' when CPI
  // or fewer than 2 releases means there is nothing to compute).
  function renderRealPriceGrid(ndis) {
    var grid = computeRealPriceGrid(ndis);
    if (!grid || !grid.cells.length) return '';

    var cellsHtml = grid.cells.map(function (cell) {
      var nominalCls = cell.nominal >= 0 ? 'is-increase' : 'is-decrease';
      var realCls = cell.real >= 0 ? 'is-increase' : 'is-decrease';
      return (
        '<div class="rpc-cell">' +
          '<p class="rpc-cell-category">' + esc(cell.category) + '</p>' +
          '<div class="rpc-cell-chart">' + buildIndexMiniChart(cell.itemIndex, cell.cpiIndex) + '</div>' +
          '<div class="rpc-cell-figures">' +
            '<span class="rpc-figure"><span class="rpc-figure-label">Nominal</span><span class="sign-chip ' + nominalCls + '">' + fmtPctSigned(cell.nominal * 100) + '</span></span>' +
            '<span class="rpc-figure"><span class="rpc-figure-label">Real</span><span class="sign-chip ' + realCls + '">' + fmtPctSigned(cell.real * 100) + '</span></span>' +
          '</div>' +
          '<p class="rpc-cell-meta tnum">' + cell.n + ' items · ' + esc(cell.fromFy) + ' → ' + esc(cell.toFy) + '</p>' +
        '</div>'
      );
    }).join('');

    var skippedNames = grid.skipped.map(function (s) { return esc(s.category); }).join(', ');
    var skippedNote = grid.skipped.length
      ? ' ' + grid.skipped.length + ' categor' + (grid.skipped.length === 1 ? 'y was' : 'ies were') +
        ' excluded for fewer than ' + MIN_QUALIFYING_ITEMS + ' qualifying items (' + skippedNames + ').'
      : '';

    return (
      '<h3 class="subsection-heading">The real price of care</h3>' +
      '<p class="section-intro">What each category actually costs to buy, after inflation — sorted worst real-terms change first.</p>' +
      '<div class="rpc-legend"><span class="rpc-legend-item"><span class="dash-swatch dash-1" aria-hidden="true"></span> Item median (indexed)</span>' +
        '<span class="rpc-legend-item"><span class="dash-swatch dash-2" aria-hidden="true"></span> CPI, All groups (indexed)</span></div>' +
      '<div class="rpc-grid">' + cellsHtml + '</div>' +
      '<p class="widget-footnote">Method: for each category priced in two or more catalogue releases, the nominal change is the median of (latest price ÷ earliest price) across items priced in both the category’s earliest and latest release (' +
        grid.eligibleCategoryCount + ' categories qualified; ' + grid.cells.length + ' shown).' +
        ' The CPI change is the ABS All-groups CPI over that same release span (nearest quarter); the real change deflates the nominal change by the CPI change.' + skippedNote + '</p>'
    );
  }

  function renderPricing(ndis) {
    var section = document.getElementById('sectionPricing');
    if (!ndis || !ndis.diffs || !ndis.diffs.length) { if (section) section.hidden = true; return; }
    section.hidden = false;

    var diffs = ndis.diffs;
    var current = diffs.filter(function (d) { return d.to === state.diffRelease; })[0] || diffs[diffs.length - 1];
    state.diffRelease = current.to;

    var pctValues = current.changed.map(function (c) { return c.pct; });
    var medianPct = medianOf(pctValues);
    var maxAbs = current.changed.reduce(function (m, c) { return Math.max(m, Math.abs(c.pct)); }, 0) || 1;

    var pickerOptions = diffs.map(function (d) {
      var sel = d.to === current.to ? ' selected' : '';
      return '<option value="' + esc(d.to) + '"' + sel + '>' + esc(d.from) + ' → ' + esc(d.to) + '</option>';
    }).join('');

    var medianCls = medianPct === null ? '' : (medianPct >= 0 ? 'is-increase' : 'is-decrease');
    var statTiles = (
      '<div class="stat-tiles">' +
        '<div class="stat-tile"><div class="stat-tile-label">Items changed</div><div class="stat-tile-value tnum">' + current.changed.length + '</div></div>' +
        '<div class="stat-tile"><div class="stat-tile-label">Added</div><div class="stat-tile-value tnum">' + current.added.length + '</div></div>' +
        '<div class="stat-tile"><div class="stat-tile-label">Retired</div><div class="stat-tile-value tnum">' + current.retired.length + '</div></div>' +
        '<div class="stat-tile"><div class="stat-tile-label">Median change</div><div class="stat-tile-value tnum">' + (medianPct === null ? '—' : fmtPctSigned(medianPct)) + '</div>' +
          (medianPct === null ? '' : '<span class="stat-tile-delta ' + medianCls + '">' + (medianPct >= 0 ? 'increase' : 'decrease') + '</span>') +
        '</div>' +
      '</div>'
    );

    var maxCategoryAbs = current.by_category.reduce(function (m, cat) { return Math.max(m, Math.abs(cat.median_pct || 0)); }, 0) || 1;

    var categoryRows = current.by_category.map(function (cat) {
      var items = current.changed.filter(function (c) { return c.category === cat.category; }).map(function (c) {
        return { pct: c.pct };
      });
      var bin = cat.changed > 0 ? rampBin(cat.median_pct, maxCategoryAbs) : null;
      var ruleStyle = bin !== null ? ' style="box-shadow:inset 3px 0 0 0 ' + RAMP_HEX[bin] + '"' : '';
      return (
        '<tr class="category-row">' +
          '<td class="category-cell"' + ruleStyle + '>' + esc(cat.category) + renderCategoryDetails(current, cat.category) + '</td>' +
          '<td class="tnum col-narrow">' + cat.changed + '</td>' +
          '<td class="tnum col-change">' + renderChangeCell(cat, items, maxAbs, maxCategoryAbs) + '</td>' +
          '<td class="tnum col-narrow">' + cat.added + '</td>' +
          '<td class="tnum col-narrow">' + cat.retired + '</td>' +
        '</tr>'
      );
    }).join('');

    var addedDetails = renderItemListDetails('addedItemsDetails', 'Added items', current.added, true);
    var retiredDetails = renderItemListDetails('retiredItemsDetails', 'Retired items', current.retired, false);
    var movers = renderMovers(current, ndis);
    var colophon = renderColophon(current, ndis);
    var sidebar = (colophon || movers) ? '<div class="pricing-side">' + colophon + movers + '</div>' : '';
    var realPriceGrid = renderRealPriceGrid(ndis);

    setHtml(section,
      '<h2 class="section-heading" id="sectionPricingHeading" tabindex="-1"><span class="section-number" aria-hidden="true">&sect; 1</span> What changed in pricing</h2>' +
      '<p class="section-intro">Item-by-item differences between two consecutive NDIS Support Catalogue releases, diffed by support item number.</p>' +
      '<div class="release-picker-row"><label for="diffPicker">Comparing</label>' +
        '<select id="diffPicker">' + pickerOptions + '</select></div>' +
      statTiles +
      '<div class="pricing-layout">' +
        '<div class="pricing-main">' +
          '<div class="table-scroll"><table class="diff-table">' +
            '<thead><tr>' +
              '<th>Category</th>' +
              '<th class="tnum col-narrow" title="Items changed">Chg</th>' +
              '<th class="tnum col-change" title="Median percentage change, and the item-level distribution of changes">Change</th>' +
              '<th class="tnum col-narrow" title="Items added">Add</th>' +
              '<th class="tnum col-narrow" title="Items retired">Ret</th>' +
            '</tr></thead>' +
            '<tbody>' + categoryRows + '</tbody>' +
          '</table></div>' +
          addedDetails + retiredDetails +
        '</div>' +
        sidebar +
      '</div>' +
      realPriceGrid
    );

    var picker = document.getElementById('diffPicker');
    if (picker) {
      picker.addEventListener('change', function () {
        state.diffRelease = picker.value;
        renderPricing(NDIS);
        var refocus = document.getElementById('diffPicker');
        if (refocus) refocus.focus();
      });
    }
  }

  /* ------------------------------------------------------------------------
     8. Section 2 — Price history explorer
     ------------------------------------------------------------------------ */

  function matchesItemSearch(item, q) {
    if (!q) return true;
    return (
      item.num.toLowerCase().indexOf(q) !== -1 ||
      item.name.toLowerCase().indexOf(q) !== -1 ||
      item.category.toLowerCase().indexOf(q) !== -1
    );
  }

  function renderSearchResults(ndis) {
    var q = state.search.trim().toLowerCase();
    var matches = ndis.items.filter(function (item) { return matchesItemSearch(item, q); });
    var shown = matches.slice(0, MAX_SEARCH_RESULTS);
    if (!shown.length) return '<p class="search-empty">No items match your search.</p>';
    var rows = shown.map(function (item) {
      var pinned = state.pinned.indexOf(item.num) !== -1;
      return (
        '<button type="button" class="search-result-btn" data-num="' + esc(item.num) + '" aria-pressed="' + pinned + '">' +
          '<span>' + esc(item.name) + '</span>' +
          '<span class="search-result-num">' + esc(item.num) + ' · ' + esc(item.category) + '</span>' +
        '</button>'
      );
    }).join('');
    var note = matches.length > MAX_SEARCH_RESULTS
      ? '<p class="search-results-note">Showing ' + MAX_SEARCH_RESULTS + ' of ' + matches.length + ' matches — refine your search.</p>'
      : '';
    return '<div class="search-results" id="searchResults" role="listbox" aria-label="Matching support items">' + rows + '</div>' + note;
  }

  function renderPinnedRow(ndis) {
    if (!state.pinned.length) return '';
    var itemByNum = {};
    ndis.items.forEach(function (i) { itemByNum[i.num] = i; });
    var chips = state.pinned.map(function (num, idx) {
      var item = itemByNum[num];
      if (!item) return '';
      var dashCls = DASH_CLASS[idx] || '';
      return (
        '<span class="pinned-chip">' +
          '<span class="dash-swatch ' + (dashCls || 'dash-1') + '" aria-hidden="true"></span>' +
          esc(truncate(item.name, 34)) +
          '<button type="button" class="pinned-chip-remove" data-unpin="' + esc(num) + '" aria-label="Remove ' + esc(item.name) + ' from comparison">✕</button>' +
        '</span>'
      );
    }).join('');
    return '<div class="pinned-row" id="pinnedRow">' + chips + '</div>';
  }

  function computeCpiOverlay(ndis, releases) {
    var cpi = ndis.context && ndis.context.cpi;
    if (!cpi || !cpi.series || !cpi.series.length || !state.pinned.length) return null;
    var itemByNum = {};
    ndis.items.forEach(function (i) { itemByNum[i.num] = i; });
    var primary = itemByNum[state.pinned[0]];
    if (!primary) return null;
    var baseIdx = -1;
    for (var i = 0; i < primary.history.length; i++) {
      if (primary.history[i] !== null && primary.history[i] !== undefined) { baseIdx = i; break; }
    }
    if (baseIdx === -1) return null;
    var basePrice = primary.history[baseIdx];
    var baseCpi = nearestSeriesValue(cpi.series, 'quarter', 'index', releases[baseIdx].effective);
    if (!baseCpi) return null;
    return releases.map(function (r) {
      var idx = nearestSeriesValue(cpi.series, 'quarter', 'index', r.effective);
      return idx ? basePrice * (idx / baseCpi) : null;
    });
  }

  function renderExplorerChart(ndis) {
    var releases = ndis.releases;
    if (!state.pinned.length) {
      return (
        '<div class="explorer-empty">' +
          '<p class="explorer-empty-lead">Search above to begin.</p>' +
          '<p class="explorer-empty-sub">Select up to ' + MAX_PINNED + ' support items to trace and compare their price history across every catalogue release.</p>' +
        '</div>'
      );
    }
    var itemByNum = {};
    ndis.items.forEach(function (i) { itemByNum[i.num] = i; });
    var pinnedItems = state.pinned.map(function (num) { return itemByNum[num]; }).filter(Boolean);
    var cpiSeries = state.cpiOverlay ? computeCpiOverlay(ndis, releases) : null;

    var W = Math.max(560, releases.length * 110);
    var H = 260;
    var M = { top: 20, right: 150, bottom: 34, left: 58 };
    var plotW = W - M.left - M.right;
    var plotH = H - M.top - M.bottom;

    var times = releases.map(function (r) { return parseIsoMs(r.effective); });
    var minT = times[0], maxT = times[times.length - 1];
    function xScale(iso) {
      if (releases.length <= 1) return M.left + plotW / 2;
      var t = parseIsoMs(iso);
      return M.left + ((t - minT) / (maxT - minT || 1)) * plotW;
    }

    var allVals = [];
    pinnedItems.forEach(function (item) {
      item.history.forEach(function (v) { if (v !== null && v !== undefined) allVals.push(v); });
      (item.spread || []).forEach(function (s) { if (s) { allVals.push(s[0]); allVals.push(s[1]); } });
    });
    if (cpiSeries) cpiSeries.forEach(function (v) { if (v !== null && v !== undefined) allVals.push(v); });
    var yMin = Math.min.apply(null, allVals);
    var yMax = Math.max.apply(null, allVals);
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    var pad = (yMax - yMin) * 0.1;
    yMin = Math.max(0, yMin - pad);
    yMax = yMax + pad;
    function yScale(v) { return M.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }

    // gridlines + y labels (3 steps)
    var gridSteps = [yMin, (yMin + yMax) / 2, yMax];
    var gridSvg = gridSteps.map(function (v) {
      var y = yScale(v);
      return (
        '<line class="explorer-gridline" x1="' + M.left + '" y1="' + y.toFixed(1) + '" x2="' + (M.left + plotW) + '" y2="' + y.toFixed(1) + '"></line>' +
        '<text class="explorer-axis-label" x="' + (M.left - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + fmtDollars(v) + '</text>'
      );
    }).join('');

    // x axis ticks
    var xAxisSvg = releases.map(function (r) {
      var x = xScale(r.effective);
      return '<text class="explorer-axis-label" x="' + x.toFixed(1) + '" y="' + (M.top + plotH + 18) + '" text-anchor="middle">' + esc(r.fy) + '</text>';
    }).join('');

    var areaSvg = '';
    var bandsSvg = '';
    var linesSvg = '';
    var dotsSvg = '';
    var endLabels = [];
    var baselineY = M.top + plotH;

    pinnedItems.forEach(function (item, idx) {
      var dashCls = DASH_CLASS[idx] || '';
      (item.spread || []).forEach(function (s, i) {
        if (!s) return;
        var x = xScale(releases[i].effective);
        bandsSvg += '<rect class="explorer-band" x="' + (x - 3).toFixed(1) + '" y="' + yScale(s[1]).toFixed(1) + '" width="6" height="' + Math.max(1, (yScale(s[0]) - yScale(s[1]))).toFixed(1) + '"></rect>';
      });

      var runs = buildRuns(item.history);
      runs.forEach(function (run) {
        if (run.length > 1) {
          var d = 'M ' + xScale(releases[run[0].i].effective).toFixed(1) + ' ' + yScale(run[0].v).toFixed(1);
          for (var k = 1; k < run.length; k++) {
            d += ' H ' + xScale(releases[run[k].i].effective).toFixed(1) + ' V ' + yScale(run[k].v).toFixed(1);
          }
          linesSvg += '<path class="explorer-line ' + dashCls + '" d="' + d + '"></path>';
          // Very subtle area fill under the price line (ramp blue wash) — the
          // step path traced back down to the baseline and closed.
          var firstX = xScale(releases[run[0].i].effective);
          var lastX = xScale(releases[run[run.length - 1].i].effective);
          areaSvg += '<path class="explorer-area" d="' + d + ' L ' + lastX.toFixed(1) + ' ' + baselineY.toFixed(1) + ' L ' + firstX.toFixed(1) + ' ' + baselineY.toFixed(1) + ' Z"></path>';
        }
        run.forEach(function (pt) {
          var x = xScale(releases[pt.i].effective), y = yScale(pt.v);
          dotsSvg += '<circle class="explorer-dot" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4.5"><title>' +
            esc(item.name) + ' — ' + esc(releases[pt.i].release) + ': ' + fmtDollars(pt.v) + '</title></circle>';
        });
      });

      var lastRun = runs[runs.length - 1];
      if (lastRun && lastRun.length) {
        var lastPt = lastRun[lastRun.length - 1];
        endLabels.push({
          x: xScale(releases[lastPt.i].effective) + 8,
          y: yScale(lastPt.v),
          text: truncate(item.name, 17),
          cls: 'explorer-end-label'
        });
      }
    });

    var cpiSvg = '';
    if (cpiSeries) {
      var cpiRuns = buildRuns(cpiSeries);
      cpiRuns.forEach(function (run) {
        if (run.length > 1) {
          var d = 'M ' + xScale(releases[run[0].i].effective).toFixed(1) + ' ' + yScale(run[0].v).toFixed(1);
          for (var k = 1; k < run.length; k++) {
            d += ' L ' + xScale(releases[run[k].i].effective).toFixed(1) + ' ' + yScale(run[k].v).toFixed(1);
          }
          cpiSvg += '<path class="explorer-cpi-line" d="' + d + '"></path>';
        }
      });
      var lastCpiRun = cpiRuns[cpiRuns.length - 1];
      if (lastCpiRun && lastCpiRun.length) {
        var lastCpiPt = lastCpiRun[lastCpiRun.length - 1];
        endLabels.push({
          x: xScale(releases[lastCpiPt.i].effective) + 8,
          y: yScale(lastCpiPt.v),
          text: 'CPI (indexed)',
          cls: 'explorer-cpi-label'
        });
      }
    }

    // Collision avoidance on end labels: nudging converging labels apart reads
    // as noise (see dataviz anti-patterns), so instead drop a label outright
    // when it would overlap one already kept — identity is never lost because
    // the pinned-chip row above is the legend and the data table below is the
    // full twin. Priority order = item labels first (pushed above), CPI last.
    function labelBox(l) {
      var w = l.text.length * 6.4 + 6, h = 13;
      return { x1: l.x, x2: l.x + w, y1: l.y - h, y2: l.y + 3 };
    }
    function boxesOverlap(a, b) { return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1; }
    var keptLabels = [];
    var keptBoxes = [];
    endLabels.forEach(function (l) {
      var box = labelBox(l);
      var collides = keptBoxes.some(function (kb) { return boxesOverlap(box, kb); });
      if (!collides) { keptLabels.push(l); keptBoxes.push(box); }
    });
    var labelsSvg = keptLabels.map(function (l) {
      return '<text class="' + l.cls + '" x="' + l.x.toFixed(1) + '" y="' + (l.y + 4).toFixed(1) + '">' + esc(l.text) + '</text>';
    }).join('');

    var svg = (
      '<svg class="explorer-chart-svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Price history for the selected items">' +
        gridSvg + xAxisSvg + areaSvg + bandsSvg + linesSvg + dotsSvg + cpiSvg + labelsSvg +
      '</svg>'
    );

    var tables = pinnedItems.map(function (item) {
      var rows = releases.map(function (r, i) {
        var v = item.history[i];
        var prevIdx = -1;
        for (var k = i - 1; k >= 0; k--) { if (item.history[k] !== null && item.history[k] !== undefined) { prevIdx = k; break; } }
        var delta = (v !== null && v !== undefined && prevIdx !== -1) ? ((v - item.history[prevIdx]) / item.history[prevIdx]) * 100 : null;
        return (
          '<tr><td>' + esc(r.release) + '</td><td class="tnum">' + fmtDollars(v) + '</td><td class="tnum">' + (delta === null ? '—' : fmtPctSigned(delta)) + '</td></tr>'
        );
      }).join('');
      return (
        '<details class="explorer-table-details"><summary>Data table — ' + esc(item.name) + '</summary>' +
          '<table class="explorer-history-table"><caption>' + esc(item.num) + ' · ' + esc(item.category) + ' (' + esc(item.unit) + ')</caption>' +
            '<thead><tr><th>Release</th><th class="tnum">Price</th><th class="tnum">Δ%</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</details>'
      );
    }).join('');

    return '<div class="explorer-chart-wrap">' + svg + '</div>' + tables;
  }

  // W-C "Your supports, repriced" — driven by the SAME state.pinned as the
  // explorer above it (see computeRepriced for the method). Rendered under
  // the explorer chart; empty when nothing is pinned.
  function renderRepriced(ndis) {
    var data = computeRepriced(ndis);
    if (!data) return '';

    var maxAbs = data.rows.reduce(function (m, r) { return Math.max(m, Math.abs(r.pct)); }, 0) || 1;
    var rowsHtml = data.rows.map(function (r) {
      var cls = r.pct >= 0 ? 'is-increase' : 'is-decrease';
      var barPct = Math.max(4, Math.round((Math.abs(r.pct) / maxAbs) * 100));
      var bin = rampBin(r.pct, maxAbs);
      return (
        '<div class="repriced-row">' +
          '<div class="repriced-row-head">' +
            '<span class="repriced-row-name">' + esc(truncate(r.name, 44)) + '</span>' +
            '<span class="sign-chip ' + cls + '">' + fmtPctSigned(r.pct) + '</span>' +
          '</div>' +
          '<div class="repriced-row-bar-wrap"><span class="repriced-row-bar" style="width:' + barPct + '%;background:' + RAMP_HEX[bin] + '"></span></div>' +
          '<div class="repriced-row-meta">' + esc(r.fromFy) + ' → ' + esc(r.toFy) +
            (r.cpiPct !== null ? ' · CPI over this span ' + fmtPctSigned(r.cpiPct) : ' · CPI unavailable for this span') +
          '</div>' +
        '</div>'
      );
    }).join('');

    var cpiHeadline = data.cpiBasket !== null
      ? ' <span class="repriced-headline-sep" aria-hidden="true">·</span> <span class="repriced-headline-label">CPI over the same spans</span> <span class="repriced-headline-value tnum">' + fmtPctSigned(data.cpiBasket) + '</span>'
      : '';
    var cpiFootnoteBit = data.cpiBasket === null
      ? ' A CPI comparison is not available for these items’ spans.'
      : (data.cpiCoverage < data.rows.length ? ' CPI is resolved for ' + data.cpiCoverage + ' of ' + data.rows.length + ' pinned items.' : '');

    return (
      '<h3 class="subsection-heading">Your supports, repriced</h3>' +
      '<p class="repriced-headline"><span class="repriced-headline-label">Your items</span> <span class="repriced-headline-value tnum">' + fmtPctSigned(data.basket) + '</span>' + cpiHeadline + '</p>' +
      '<div class="repriced-rows">' + rowsHtml + '</div>' +
      '<p class="widget-footnote">Method: equal-weighted mean of each pinned item’s own percentage change, from its first priced release to its last priced release; CPI is compared over each item’s own span and averaged the same way.' + cpiFootnoteBit + '</p>'
    );
  }

  function renderExplorer(ndis) {
    var section = document.getElementById('sectionExplorer');
    if (!ndis || !ndis.items || !ndis.items.length || !ndis.releases || !ndis.releases.length) {
      if (section) section.hidden = true;
      return;
    }
    section.hidden = false;

    var hasCpi = !!(ndis.context && ndis.context.cpi && ndis.context.cpi.series && ndis.context.cpi.series.length);
    var cpiRow = hasCpi
      ? '<div class="cpi-toggle-row"><label><input type="checkbox" id="cpiOverlayToggle"' + (state.cpiOverlay ? ' checked' : '') + '> Overlay CPI, All groups (indexed)</label></div>'
      : '';

    setHtml(section,
      '<h2 class="section-heading" id="sectionExplorerHeading" tabindex="-1"><span class="section-number" aria-hidden="true">&sect; 2</span> Price history explorer</h2>' +
      '<p class="section-intro">Search a support item to trace its national price across every catalogue release. Pin up to ' + MAX_PINNED + ' items to compare.</p>' +
      '<label class="search-field"><span class="search-icon" aria-hidden="true">⌕</span>' +
        '<span class="visually-hidden">Search support items by number, name or category</span>' +
        '<input type="search" id="explorerSearch" placeholder="Search by item number, name or category…"></label>' +
      renderSearchResults(ndis) +
      renderPinnedRow(ndis) +
      '<p class="pinned-hint" id="pinnedHint" aria-live="polite">' + esc(state.pinHint) + '</p>' +
      cpiRow +
      renderExplorerChart(ndis) +
      renderRepriced(ndis)
    );

    var searchInput = document.getElementById('explorerSearch');
    if (searchInput) {
      searchInput.value = state.search;
      searchInput.addEventListener('input', function () {
        state.search = searchInput.value;
        renderExplorer(NDIS);
        var v = document.getElementById('explorerSearch');
        if (v) { v.focus(); v.setSelectionRange(v.value.length, v.value.length); }
      });
    }
    Array.prototype.forEach.call(section.querySelectorAll('.search-result-btn'), function (btn) {
      btn.addEventListener('click', function () { togglePin(btn.getAttribute('data-num')); });
    });
    Array.prototype.forEach.call(section.querySelectorAll('[data-unpin]'), function (btn) {
      btn.addEventListener('click', function () { togglePin(btn.getAttribute('data-unpin')); });
    });
    var cpiToggle = document.getElementById('cpiOverlayToggle');
    if (cpiToggle) {
      cpiToggle.addEventListener('change', function () {
        state.cpiOverlay = cpiToggle.checked;
        renderExplorer(NDIS);
      });
    }
  }

  function togglePin(num) {
    var idx = state.pinned.indexOf(num);
    if (idx !== -1) {
      state.pinned.splice(idx, 1);
      state.pinHint = '';
    } else if (state.pinned.length < MAX_PINNED) {
      state.pinned.push(num);
      state.pinHint = '';
    } else {
      state.pinHint = 'You can pin up to ' + MAX_PINNED + ' items — remove one to add another.';
    }
    renderExplorer(NDIS);
  }

  /* ------------------------------------------------------------------------
     9. Section 3 — Where the money goes (W-B)
     ------------------------------------------------------------------------ */

  // W-B "Where the money goes" — an editorial board built from
  // context.payments_by_category, one row per category, sorted by payments
  // descending. Each row joins to the latest catalogue diff's per-category
  // median % change via catalogue_category (an explicit hand-checked mapping
  // upstream, in the data pipeline — never fuzzy-matched here). A row prints
  // "—" for the joined column when catalogue_category is null (no mapping
  // exists) or the mapped category has no changed items in the latest diff
  // (nothing to report a median over).
  function renderMoney(ndis) {
    var section = document.getElementById('sectionMoney');
    var pbc = ndis && ndis.context && ndis.context.payments_by_category;
    if (!pbc || !pbc.rows || !pbc.rows.length) { if (section) section.hidden = true; return; }
    section.hidden = false;

    var latestDiff = ndis.diffs && ndis.diffs.length ? ndis.diffs[ndis.diffs.length - 1] : null;
    var catMedian = {};
    if (latestDiff) {
      (latestDiff.by_category || []).forEach(function (c) {
        if (c.changed > 0) catMedian[c.category] = c.median_pct;
      });
    }

    var rows = pbc.rows.slice().sort(function (a, b) { return b.payments - a.payments; });
    // Max over positive payments only — a stray negative row (a source-data
    // reconciliation bucket) must never shrink or invert the scale.
    var maxPayments = rows.reduce(function (m, r) { return r.payments > 0 ? Math.max(m, r.payments) : m; }, 0) || 1;

    var bodyRows = rows.map(function (r) {
      // Bars are a magnitude encoding — a negative payments figure (seen in
      // source reconciliation rows) gets a zero-width bar, never a negative
      // or NaN width; the actual signed value is still printed beside it.
      var barPct = r.payments > 0 ? Math.max(1, Math.round((r.payments / maxPayments) * 100)) : 0;
      var bin = r.payments > 0 ? rampBin(r.payments, maxPayments) : 0;
      var hasMedian = r.catalogue_category !== null && r.catalogue_category !== undefined &&
        Object.prototype.hasOwnProperty.call(catMedian, r.catalogue_category);
      var medianCls = hasMedian ? (catMedian[r.catalogue_category] >= 0 ? 'is-increase' : 'is-decrease') : '';
      var negativeNote = r.payments < 0 ? ' <span class="money-row-note">(reported as negative in the source data)</span>' : '';
      return (
        '<tr>' +
          '<td>' + esc(r.category) + negativeNote + '</td>' +
          '<td class="tnum col-money">' +
            '<div class="money-bar-row"><span class="money-bar-track"><span class="money-bar" style="width:' + barPct + '%;background:' + RAMP_HEX[bin] + '"></span></span>' +
              '<span class="money-bar-value">' + fmtCompactCurrency(r.payments) + '</span></div>' +
          '</td>' +
          '<td class="tnum">' + (r.participants !== undefined && r.participants !== null ? fmtNum(r.participants) : '—') + '</td>' +
          '<td class="tnum">' + (r.avg_per_participant !== undefined && r.avg_per_participant !== null ? fmtDollars(r.avg_per_participant) : '—') + '</td>' +
          '<td class="tnum">' + (hasMedian ? '<span class="sign-chip ' + medianCls + '">' + fmtPctSigned(catMedian[r.catalogue_category]) + '</span>' : '<span class="dot-strip-empty">—</span>') + '</td>' +
        '</tr>'
      );
    }).join('');

    var windowText = pbc.window ? esc(pbc.window) : '12 months';
    var asOfText = pbc.as_of_quarter ? ' — report date ' + esc(fmtDateLong(pbc.as_of_quarter)) : '';

    setHtml(section,
      '<h2 class="section-heading" id="sectionMoneyHeading" tabindex="-1"><span class="section-number" aria-hidden="true">&sect; 3</span> Where the money goes</h2>' +
      '<p class="section-intro">Total NDIS payments to providers by support category — ' + windowText + asOfText + '.</p>' +
      '<div class="table-scroll"><table class="diff-table money-table">' +
        '<thead><tr>' +
          '<th>Category</th>' +
          '<th class="tnum col-money">Payments</th>' +
          '<th class="tnum">Participants</th>' +
          '<th class="tnum">Avg / participant</th>' +
          '<th class="tnum" title="Median price change, latest catalogue release">Catalogue Δ</th>' +
        '</tr></thead>' +
        '<tbody>' + bodyRows + '</tbody>' +
      '</table></div>' +
      '<p class="widget-footnote">Payments, participants and averages are the latest report date in the NDIA payments dataset (' + esc(pbc.source ? pbc.source.title : 'NDIS payments data') + '). "Catalogue Δ" joins each row to the current Support Catalogue diff by category, via an explicit mapping maintained in the data pipeline — rows show “—” where no mapping exists or the mapped category has no priced changes this release.</p>'
    );
  }

  /* ------------------------------------------------------------------------
     10. Section 4 — The law
     ------------------------------------------------------------------------ */

  function renderLawCallout(ndis) {
    var keyword = 'pricing determination';
    var hits = (ndis.feed.items || []).filter(function (it) {
      var haystack = (it.title || '') + ' ' + (it.summary || '');
      return haystack.toLowerCase().indexOf(keyword) !== -1;
    });
    if (!hits.length) return '';
    var body = hits.map(function (it) {
      return '<p>' + esc(it.title) + (it.summary ? ' — ' + esc(it.summary) : '') +
        ' <a href="' + esc(it.source.url) + '" target="_blank" rel="noopener">' + esc(it.source.title) + '</a></p>';
    }).join('');
    return (
      '<div class="law-callout"><div class="law-callout-label">Flagged from the updates feed — mentions pricing determination powers</div>' + body + '</div>'
    );
  }

  function renderLaw(ndis) {
    var section = document.getElementById('sectionLaw');
    if (!ndis || !ndis.law) { if (section) section.hidden = true; return; }
    section.hidden = false;

    var cutoff = subtractYears(ndis.meta.as_of, 3);
    var seenUrls = {};
    var entries = [];

    (ndis.law.act_versions || []).forEach(function (av) {
      entries.push({ date: av.start, type: 'compilation', name: 'NDIS Act — compilation ' + av.compilation, status: null, url: av.url });
      seenUrls[av.url] = true;
    });

    (ndis.law.titles || []).forEach(function (t) {
      if ((t.collection !== 'Act' && t.collection !== 'LegislativeInstrument') || t.registered < cutoff) return;
      entries.push({ date: t.registered, type: t.collection, name: t.name, status: t.status, url: t.url });
      seenUrls[t.url] = true;
    });

    (ndis.feed.items || []).forEach(function (it) {
      if (it.type !== 'bill' && it.type !== 'law') return;
      if (seenUrls[it.source.url]) return;
      entries.push({ date: it.date, type: it.type, name: it.title, status: null, url: it.source.url });
      seenUrls[it.source.url] = true;
    });

    entries.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });

    // Chronology spine: group entries by year (already newest-first) so a big
    // muted serif year marker can hang in the left margin once per year,
    // while the hairline spine + node dots run continuously down the right.
    var yearGroups = [];
    var lastYear = null, currentGroup = null;
    entries.forEach(function (e) {
      var y = dateParts(e.date).y;
      if (y !== lastYear) {
        currentGroup = { year: y, entries: [] };
        yearGroups.push(currentGroup);
        lastYear = y;
      }
      currentGroup.entries.push(e);
    });

    var timelineHtml = yearGroups.map(function (g) {
      var entriesHtml = g.entries.map(function (e) {
        var statusText = e.status ? (STATUS_LABEL[e.status] || e.status) : '';
        return (
          '<div class="timeline-entry">' +
            '<div class="timeline-date">' + esc(fmtDateLong(e.date)) + '</div>' +
            '<span class="type-chip">' + esc(LAW_TYPE_LABEL[e.type] || e.type) + '</span>' +
            '<div class="timeline-name">' + esc(e.name) + '</div>' +
            '<div class="timeline-meta">' + (statusText ? esc(statusText) + ' · ' : '') +
              '<a href="' + esc(e.url) + '" target="_blank" rel="noopener">View source ↗</a></div>' +
          '</div>'
        );
      }).join('');
      return (
        '<div class="timeline-year-group">' +
          '<div class="timeline-year" aria-hidden="true">' + g.year + '</div>' +
          '<div class="timeline-entries">' + entriesHtml + '</div>' +
        '</div>'
      );
    }).join('');

    setHtml(section,
      '<h2 class="section-heading" id="sectionLawHeading" tabindex="-1"><span class="section-number" aria-hidden="true">&sect; 4</span> The law</h2>' +
      '<p class="section-intro">The NDIS Act, its compilations, related legislative instruments registered in the last three years, and bills before parliament.</p>' +
      renderLawCallout(ndis) +
      (entries.length ? '<div class="timeline">' + timelineHtml + '</div>' : '<p class="section-intro">No timeline entries in range.</p>')
    );
  }

  /* ------------------------------------------------------------------------
     11. Section 5 — Updates
     ------------------------------------------------------------------------ */

  // Single feed brief — shared verbatim between the full Updates view (§5)
  // and the Overview's "five most recent" teaser, so type chips/badges never
  // drift between the two (docs/ndis-spec.md Overview bullet: "reuse type
  // chips/badges").
  function renderFeedItem(it) {
    var meta = TYPE_META[it.type] || { emoji: '•', label: it.type };
    var badge = it.verified === 'auto'
      ? '<span class="badge-auto">via official feed</span>'
      : '<span class="badge-verified">✓ source-checked</span>';
    return (
      '<div class="feed-item">' +
        '<div class="feed-item-head">' +
          '<span class="feed-item-date tnum">' + esc(fmtDateLong(it.date)) + '</span>' +
          '<span class="type-chip"><span aria-hidden="true">' + meta.emoji + '</span> ' + esc(meta.label) + '</span>' +
        '</div>' +
        '<div class="feed-item-title"><a href="' + esc(it.source.url) + '" target="_blank" rel="noopener">' + esc(it.title) + '</a></div>' +
        (it.summary ? '<p class="feed-item-summary">' + esc(it.summary) + '</p>' : '') +
        '<div class="feed-item-meta"><span>' + esc(it.source.publisher) + '</span>' + badge + '</div>' +
      '</div>'
    );
  }

  function renderUpdates(ndis) {
    var section = document.getElementById('sectionUpdates');
    if (!ndis || !ndis.feed || !ndis.feed.items || !ndis.feed.items.length) { if (section) section.hidden = true; return; }
    section.hidden = false;

    var allItems = ndis.feed.items;
    var typesPresent = [];
    allItems.forEach(function (it) { if (typesPresent.indexOf(it.type) === -1) typesPresent.push(it.type); });

    var filterChips = typesPresent.map(function (type) {
      var meta = TYPE_META[type] || { emoji: '•', label: type };
      var pressed = state.feedTypes.has(type);
      return (
        '<button type="button" class="feed-filter-chip" data-type="' + esc(type) + '" aria-pressed="' + pressed + '">' +
          '<span aria-hidden="true">' + meta.emoji + '</span><span>' + esc(meta.label) + '</span>' +
        '</button>'
      );
    }).join('');

    var filtered = state.feedTypes.size === 0 ? allItems : allItems.filter(function (it) { return state.feedTypes.has(it.type); });

    var itemsHtml = '';
    var currentMonth = null;
    if (!filtered.length) {
      itemsHtml = '<p class="search-empty">No updates match the selected filters.</p>';
    } else {
      filtered.forEach(function (it) {
        var mk = monthKey(it.date);
        if (mk !== currentMonth) {
          currentMonth = mk;
          itemsHtml += '<h3 class="feed-month-heading">' +
            '<span class="feed-month-rule" aria-hidden="true"></span>' +
            '<span class="feed-month-text">' + esc(monthHeading(it.date)) + '</span>' +
            '<span class="feed-month-rule" aria-hidden="true"></span>' +
          '</h3>';
        }
        itemsHtml += renderFeedItem(it);
      });
    }

    setHtml(section,
      '<h2 class="section-heading" id="sectionUpdatesHeading" tabindex="-1"><span class="section-number" aria-hidden="true">&sect; 5</span> Updates</h2>' +
      '<p class="section-intro">Bills, hearings, reports, audits and announcements affecting the scheme, newest first.</p>' +
      '<div class="feed-filter-row" role="group" aria-label="Filter updates by type" id="feedFilterRow">' + filterChips + '</div>' +
      itemsHtml
    );

    Array.prototype.forEach.call(section.querySelectorAll('.feed-filter-chip'), function (btn) {
      btn.addEventListener('click', function () {
        var type = btn.getAttribute('data-type');
        if (state.feedTypes.has(type)) state.feedTypes['delete'](type); else state.feedTypes.add(type);
        renderUpdates(NDIS);
        var refocus = document.querySelector('.feed-filter-chip[data-type="' + type + '"]');
        if (refocus) refocus.focus();
      });
    });
  }

  /* ------------------------------------------------------------------------
     12. Section 6 — Scheme in numbers
     ------------------------------------------------------------------------ */

  function renderNumbersChart(byQuarter) {
    if (!byQuarter || !byQuarter.length) return '';
    var W = Math.max(420, byQuarter.length * 90);
    var H = 200;
    var M = { top: 24, right: 16, bottom: 34, left: 16 };
    var plotW = W - M.left - M.right;
    var plotH = H - M.top - M.bottom;
    var maxVal = Math.max.apply(null, byQuarter.map(function (q) { return q.payments_total; })) || 1;
    var barW = Math.min(48, (plotW / byQuarter.length) * 0.5);
    var step = plotW / byQuarter.length;

    var bars = byQuarter.map(function (q, i) {
      var h = (q.payments_total / maxVal) * plotH;
      var x = M.left + i * step + (step - barW) / 2;
      var y = M.top + plotH - h;
      return (
        '<rect class="numbers-bar" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(1, h).toFixed(1) + '" rx="3">' +
          '<title>' + esc(q.quarter) + ': ' + fmtCompactCurrency(q.payments_total) + '</title></rect>' +
        '<text class="numbers-bar-value" x="' + (x + barW / 2).toFixed(1) + '" y="' + (y - 6).toFixed(1) + '" text-anchor="middle">' + fmtCompactCurrency(q.payments_total) + '</text>' +
        '<text class="numbers-bar-label" x="' + (x + barW / 2).toFixed(1) + '" y="' + (M.top + plotH + 16).toFixed(1) + '" text-anchor="middle">' + esc(q.quarter) + '</text>'
      );
    }).join('');

    return (
      '<h3 class="subsection-heading">Payments — 12 months to each report date</h3>' +
      '<div class="numbers-chart-wrap"><svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="NDIS payments, rolling 12-month totals by report date">' +
        bars +
      '</svg></div>'
    );
  }

  // W-D "Your electorate" — a distribution strip (2px ink ticks on a
  // hairline axis, one tick per division) with the selected division marked
  // by a labelled dot. `selected` may be null (no selection yet).
  function renderElectorateStrip(sortedRows, selected) {
    var W = 640, H = 64, padX = 16;
    var needs = sortedRows.map(function (r) { return r.need; });
    var minN = Math.min.apply(null, needs), maxN = Math.max.apply(null, needs);
    var span = (maxN - minN) || 1;
    function x(v) { return padX + ((v - minN) / span) * (W - 2 * padX); }

    var ticks = sortedRows.map(function (r) {
      if (selected && r.name === selected.name) return '';
      return '<line class="electorate-tick" x1="' + x(r.need).toFixed(1) + '" x2="' + x(r.need).toFixed(1) + '" y1="26" y2="42"></line>';
    }).join('');

    var selSvg = '';
    var ariaLabel = 'Distribution of core-activity need across all ' + sortedRows.length + ' federal electoral divisions';
    if (selected) {
      var sx = x(selected.need);
      ariaLabel += ', with ' + selected.name + ' highlighted';
      selSvg =
        '<line class="electorate-tick is-selected" x1="' + sx.toFixed(1) + '" x2="' + sx.toFixed(1) + '" y1="18" y2="50"></line>' +
        '<circle class="electorate-dot" cx="' + sx.toFixed(1) + '" cy="34" r="4.5"></circle>' +
        '<text class="electorate-dot-label" x="' + sx.toFixed(1) + '" y="13" text-anchor="middle">' + esc(selected.name) + '</text>';
    }

    return (
      '<svg class="electorate-strip-svg" width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(ariaLabel) + '">' +
        '<line class="electorate-axis" x1="' + padX + '" y1="34" x2="' + (W - padX) + '" y2="34"></line>' +
        '<text class="electorate-axis-label" x="' + padX + '" y="60" text-anchor="start">Least need</text>' +
        '<text class="electorate-axis-label" x="' + (W - padX) + '" y="60" text-anchor="end">Most need</text>' +
        ticks + selSvg +
      '</svg>'
    );
  }

  function renderElectorateWidget(ndis) {
    var electorates = ndis.context && ndis.context.electorates;
    if (!electorates || !electorates.rows || !electorates.rows.length) return '';

    var sorted = electorates.rows.slice().sort(function (a, b) { return b.need - a.need; });
    var n = sorted.length;

    var selectedRow = null, rank = null;
    if (state.electorate) {
      var q = state.electorate.trim().toLowerCase();
      for (var i = 0; i < sorted.length; i++) {
        if (sorted[i].name.toLowerCase() === q) { selectedRow = sorted[i]; rank = i + 1; break; }
      }
    }

    var options = sorted.map(function (r) { return '<option value="' + esc(r.name) + '">'; }).join('');

    var resultHtml = selectedRow
      ? (
          '<div class="electorate-result">' +
            '<p class="electorate-result-figure"><span class="tnum">' + fmtNum(selectedRow.need) + '</span> people need help with core activities in <strong>' + esc(selectedRow.name) + '</strong></p>' +
            '<p class="electorate-result-rank">Rank <span class="tnum">' + rank + '</span> of <span class="tnum">' + n + '</span> divisions (highest need first)</p>' +
          '</div>'
        )
      : '<p class="electorate-result-empty">Type a division name, or choose one from the list, to see its need count and rank.</p>';

    var tableRows = sorted.map(function (r, i) {
      var isSel = selectedRow && r.name === selectedRow.name;
      return '<tr' + (isSel ? ' class="is-selected-row"' : '') + '><td class="tnum">' + (i + 1) + '</td><td>' + esc(r.name) + '</td><td class="tnum">' + fmtNum(r.need) + '</td></tr>';
    }).join('');

    return (
      '<h3 class="subsection-heading">Your electorate</h3>' +
      '<div class="electorate-field-row">' +
        '<label for="electorateInput">Federal electoral division</label>' +
        '<input type="text" id="electorateInput" list="electorateList" placeholder="Start typing a division…" autocomplete="off" value="' + esc(state.electorate) + '">' +
        '<datalist id="electorateList">' + options + '</datalist>' +
      '</div>' +
      '<div id="electorateResult" aria-live="polite">' + resultHtml + '</div>' +
      '<div class="electorate-strip-wrap">' + renderElectorateStrip(sorted, selectedRow) + '</div>' +
      '<p class="electorate-caveat">“' + esc(electorates.label) + '” counts a Census, self-reported need for everyday assistance — it is not an NDIS eligibility test, a participant count, or a funding measure, and NDIS caseloads are not distributed the same way across divisions.</p>' +
      '<details class="electorate-table-details"><summary>All ' + n + ' divisions, ranked by need</summary>' +
        '<table class="electorate-table"><thead><tr><th class="tnum">Rank</th><th>Division</th><th class="tnum">Need</th></tr></thead>' +
          '<tbody>' + tableRows + '</tbody>' +
        '</table>' +
      '</details>'
    );
  }

  // "At a glance" stat tiles — payments (12-mo), participants, census
  // core-activity need, SDAC prevalence. Shared verbatim between §6 "Scheme
  // in numbers" and the Overview folio strip (docs/ndis-spec.md: "reuse the
  // existing tile markup/labels EXACTLY, including the 12-month labelling").
  function buildContextTiles(ctx) {
    var tiles = [];
    if (ctx.quarterly && ctx.quarterly.by_quarter && ctx.quarterly.by_quarter.length) {
      var latest = ctx.quarterly.by_quarter[ctx.quarterly.by_quarter.length - 1];
      // The NDIA payments dataset reports a rolling 12-month total to each
      // report date — never label it as a single quarter's spend.
      tiles.push('<div class="stat-tile"><div class="stat-tile-label">Payments, 12 months</div><div class="stat-tile-value tnum">' + fmtCompactCurrency(latest.payments_total) + '</div><div class="stat-tile-sub">Year to ' + esc(fmtDateLong(ctx.quarterly.as_of_quarter)) + '</div></div>');
      tiles.push('<div class="stat-tile"><div class="stat-tile-label">Active participants</div><div class="stat-tile-value tnum">' + fmtNum(latest.participants) + '</div><div class="stat-tile-sub">At ' + esc(fmtDateLong(ctx.quarterly.as_of_quarter)) + '</div></div>');
    }
    if (ctx.abs && ctx.abs.census_assistance) {
      var ca = ctx.abs.census_assistance;
      tiles.push('<div class="stat-tile"><div class="stat-tile-label">' + esc(ca.label) + '</div><div class="stat-tile-value tnum">' + fmtNum(ca.value) + '</div></div>');
    }
    if (ctx.abs && ctx.abs.sdac) {
      var sd = ctx.abs.sdac;
      tiles.push('<div class="stat-tile"><div class="stat-tile-label">' + esc(sd.label) + '</div><div class="stat-tile-value tnum">' + sd.value_pct + '%</div><div class="stat-tile-sub">Released ' + esc(fmtDateLong(sd.released)) + '</div></div>');
    }
    return tiles;
  }

  // "Next data" list — shared verbatim between §6 and the Overview.
  function buildNextDataList(nextData) {
    if (!nextData || !nextData.length) return '';
    var items = nextData.map(function (nd) {
      return (
        '<li class="next-data-item"><span>' + esc(nd.label) + (nd.note ? '<span class="next-data-note">' + esc(nd.note) + '</span>' : '') + '</span>' +
          '<span class="next-data-due tnum">' + esc(nd.due) + '</span></li>'
      );
    }).join('');
    return '<h3 class="subsection-heading">Next data</h3><ul class="next-data-list">' + items + '</ul>';
  }

  function renderNumbers(ndis) {
    var section = document.getElementById('sectionNumbers');
    if (!ndis || !ndis.context) { if (section) section.hidden = true; return; }
    section.hidden = false;
    var ctx = ndis.context;

    var tiles = buildContextTiles(ctx);
    var chart = ctx.quarterly ? renderNumbersChart(ctx.quarterly.by_quarter) : '';
    var nextDataHtml = buildNextDataList(ctx.next_data);
    var electorateWidget = renderElectorateWidget(ndis);

    setHtml(section,
      '<h2 class="section-heading" id="sectionNumbersHeading" tabindex="-1"><span class="section-number" aria-hidden="true">&sect; 6</span> Scheme in numbers</h2>' +
      (tiles.length ? '<div class="stat-tiles">' + tiles.join('') + '</div>' : '') +
      chart +
      electorateWidget +
      nextDataHtml
    );

    var electInput = document.getElementById('electorateInput');
    if (electInput) {
      electInput.addEventListener('input', function () {
        state.electorate = electInput.value;
        renderNumbers(NDIS);
        var v = document.getElementById('electorateInput');
        if (v) { v.focus(); v.setSelectionRange(v.value.length, v.value.length); }
      });
    }
  }

  /* ------------------------------------------------------------------------
     13. Overview view (front page)
     ------------------------------------------------------------------------ */

  // One-line, data-derived description for each other view's "Inside" row —
  // every number comes from window.NDIS at render time, nothing hardcoded.
  function describeView(key, ndis) {
    if (key === 'pricing') {
      if (!ndis.diffs || !ndis.diffs.length) return null;
      var d = ndis.diffs[ndis.diffs.length - 1];
      var rel = (ndis.releases || []).filter(function (r) { return r.release === d.to; })[0];
      var fy = rel ? rel.fy : d.to;
      return d.changed.length.toLocaleString('en-AU') + ' items changed in the ' + fy + ' release';
    }
    if (key === 'explorer') {
      if (!ndis.items || !ndis.items.length || !ndis.releases || !ndis.releases.length) return null;
      return ndis.items.length.toLocaleString('en-AU') + ' priced support items across ' + ndis.releases.length + ' catalogue releases';
    }
    if (key === 'money') {
      var pbc = ndis.context && ndis.context.payments_by_category;
      if (!pbc || !pbc.rows || !pbc.rows.length) return null;
      var total = pbc.rows.reduce(function (s, r) { return s + (r.payments > 0 ? r.payments : 0); }, 0);
      return fmtCompactCurrency(total) + ' in provider payments across ' + pbc.rows.length + ' categories';
    }
    if (key === 'law') {
      if (!ndis.law || !ndis.law.titles) return null;
      return ndis.law.titles.length.toLocaleString('en-AU') + ' NDIS titles on the register';
    }
    if (key === 'updates') {
      if (!ndis.feed || !ndis.feed.items || !ndis.feed.items.length) return null;
      return ndis.feed.items.length.toLocaleString('en-AU') + ' updates tracked, latest ' + fmtDateLong(ndis.feed.items[0].date);
    }
    if (key === 'numbers') {
      var ctx = ndis.context;
      if (!ctx) return null;
      var bits = [];
      if (ctx.abs && ctx.abs.census_assistance) bits.push(fmtNum(ctx.abs.census_assistance.value) + ' need core-activity help (Census 2021)');
      if (ctx.abs && ctx.abs.sdac) bits.push(ctx.abs.sdac.value_pct + '% SDAC prevalence');
      if (!bits.length) return null;
      return bits.join(' · ');
    }
    return null;
  }

  // Front page: lead stat (rendered separately, outside this section — see
  // renderAll), "at a glance" folio strip, "In brief" movers, five most
  // recent updates, next-data list, and the "Inside" index of other views.
  // Every module reuses the exact renderer/helper its home view uses.
  function renderOverview(ndis) {
    var section = document.getElementById('viewOverview');
    if (!section) return;
    section.hidden = false;

    var tiles = ndis.context ? buildContextTiles(ndis.context) : [];
    var atGlance = tiles.length ? '<div class="stat-tiles">' + tiles.join('') + '</div>' : '';

    var latestDiff = ndis.diffs && ndis.diffs.length ? ndis.diffs[ndis.diffs.length - 1] : null;
    var moversInner = latestDiff ? renderMovers(latestDiff, ndis) : '';
    var moversHtml = moversInner ? '<div class="overview-movers">' + moversInner + '</div>' : '';

    var feedItems = (ndis.feed && ndis.feed.items) ? ndis.feed.items.slice(0, 5) : [];
    var feedHtml = feedItems.length
      ? '<div class="overview-feed"><h3 class="subsection-heading">Latest updates</h3>' +
          feedItems.map(renderFeedItem).join('') +
          '<p class="overview-feed-more"><a href="#/updates">All updates →</a></p>' +
        '</div>'
      : '';

    var nextDataHtml = ndis.context ? buildNextDataList(ndis.context.next_data) : '';

    var insideRows = VIEW_META.filter(function (v) { return v.key !== 'overview'; }).map(function (v) {
      var hasData = v.hasData(ndis);
      var desc = hasData ? describeView(v.key, ndis) : null;
      var muted = (!hasData || !desc) ? ' is-muted' : '';
      var numberBit = v.number ? '<span class="masthead-index-num" aria-hidden="true">&sect; ' + v.number + '</span> ' : '';
      return (
        '<li class="inside-index-item">' +
          '<a class="inside-index-link' + muted + '" href="' + esc(v.hash) + '">' + numberBit + esc(v.navLabel) + '</a>' +
          '<span class="inside-index-sep" aria-hidden="true"> — </span>' +
          '<span class="inside-index-desc">' + esc(desc || 'No data yet.') + '</span>' +
        '</li>'
      );
    }).join('');
    var insideHtml = '<div class="overview-inside"><h3 class="subsection-heading">Inside</h3><ul class="inside-index-list">' + insideRows + '</ul></div>';

    setHtml(section,
      '<h2 class="section-heading" id="viewOverviewHeading" tabindex="-1">Overview</h2>' +
      atGlance +
      moversHtml +
      feedHtml +
      nextDataHtml +
      insideHtml
    );
  }

  /* ------------------------------------------------------------------------
     14. View routing (hash-based) + top-level render orchestration + init
     ------------------------------------------------------------------------ */

  // docs/ndis-spec.md "Views & routing" table. `render`/`hasData` are only
  // set for the six data-backed views — Overview is handled separately
  // (renderOverview always runs; it degrades module-by-module on its own).
  var VIEW_META = [
    { key: 'overview', hash: '#/', navLabel: 'Overview', heading: 'Overview', number: null,
      sectionId: 'viewOverview', headingId: 'viewOverviewHeading' },
    { key: 'pricing', hash: '#/pricing', navLabel: 'Pricing', heading: 'What changed in pricing', number: 1,
      sectionId: 'sectionPricing', headingId: 'sectionPricingHeading',
      hasData: function (ndis) { return !!(ndis.diffs && ndis.diffs.length); },
      render: renderPricing, noDataHint: 'a catalogue diff between two releases' },
    { key: 'explorer', hash: '#/explorer', navLabel: 'Explorer', heading: 'Price history explorer', number: 2,
      sectionId: 'sectionExplorer', headingId: 'sectionExplorerHeading',
      hasData: function (ndis) { return !!(ndis.items && ndis.items.length && ndis.releases && ndis.releases.length); },
      render: renderExplorer, noDataHint: 'priced items and catalogue releases' },
    { key: 'money', hash: '#/money', navLabel: 'Money', heading: 'Where the money goes', number: 3,
      sectionId: 'sectionMoney', headingId: 'sectionMoneyHeading',
      hasData: function (ndis) { return !!(ndis.context && ndis.context.payments_by_category && ndis.context.payments_by_category.rows && ndis.context.payments_by_category.rows.length); },
      render: renderMoney, noDataHint: 'payments-by-category data' },
    { key: 'law', hash: '#/law', navLabel: 'Law', heading: 'The law', number: 4,
      sectionId: 'sectionLaw', headingId: 'sectionLawHeading',
      hasData: function (ndis) { return !!ndis.law; },
      render: renderLaw, noDataHint: 'law timeline data' },
    { key: 'updates', hash: '#/updates', navLabel: 'Updates', heading: 'Updates', number: 5,
      sectionId: 'sectionUpdates', headingId: 'sectionUpdatesHeading',
      hasData: function (ndis) { return !!(ndis.feed && ndis.feed.items && ndis.feed.items.length); },
      render: renderUpdates, noDataHint: 'the curated updates feed' },
    { key: 'numbers', hash: '#/numbers', navLabel: 'Numbers', heading: 'Scheme in numbers', number: 6,
      sectionId: 'sectionNumbers', headingId: 'sectionNumbersHeading',
      hasData: function (ndis) { return !!ndis.context; },
      render: renderNumbers, noDataHint: 'scheme context data' }
  ];

  function viewMetaByKey(key) {
    for (var i = 0; i < VIEW_META.length; i++) { if (VIEW_META[i].key === key) return VIEW_META[i]; }
    return null;
  }

  // Empty state for a view whose data block is absent (docs/ndis-spec.md:
  // "a view with no data shows the styled empty-state note instead of blank
  // scaffolding"). Still renders the heading (with tabindex) so focus has a
  // target after a view switch even when there is nothing else to show.
  function renderViewEmptyState(view) {
    var section = document.getElementById(view.sectionId);
    if (!section) return;
    section.hidden = false;
    var numberBit = view.number ? '<span class="section-number" aria-hidden="true">&sect; ' + view.number + '</span> ' : '';
    setHtml(section,
      '<h2 class="section-heading" id="' + view.headingId + '" tabindex="-1">' + numberBit + esc(view.heading) + '</h2>' +
      '<div class="no-data-note"><p><strong>No data yet.</strong> This view needs ' + esc(view.noDataHint) +
        ', which hasn’t been ingested yet.</p></div>'
    );
  }

  // Hash → view key. Empty, "#/", or anything not in VIEW_META falls back
  // to Overview (docs/ndis-spec.md: "empty/unknown → 'overview'").
  function parseHash() {
    var h = window.location.hash || '';
    for (var i = 0; i < VIEW_META.length; i++) { if (VIEW_META[i].hash === h) return VIEW_META[i].key; }
    return 'overview';
  }

  function applyDocumentTitle() {
    var meta = viewMetaByKey(state.view) || VIEW_META[0];
    document.title = NDIS ? ('Common Ground — NDIS Tracker · ' + meta.navLabel) : 'Common Ground — NDIS Tracker';
  }

  // renderAll renders ONLY the active view's section (plus masthead/lead
  // stat/footer); every other section is emptied and hidden so switching
  // views never leaves stale markup or duplicate ids behind.
  function renderAll() {
    renderHeader(NDIS);
    var noDataEl = document.getElementById('noDataNote');

    if (!NDIS) {
      renderLeadStat(null);
      setHtml(noDataEl, '<div class="no-data-note"><p><strong>No data.</strong> Run the NDIS data pipeline to generate <code>data/ndis/ndis.json</code>, then rebuild with <code>node scripts/build.mjs</code>.</p></div>');
      VIEW_META.forEach(function (v) {
        var el = document.getElementById(v.sectionId);
        if (el) { el.hidden = true; setHtml(el, ''); }
      });
      renderFooter(null);
      renderNav(null);
      return;
    }

    setHtml(noDataEl, '');
    renderLeadStat(state.view === 'overview' ? NDIS : null);

    VIEW_META.forEach(function (v) {
      var section = document.getElementById(v.sectionId);
      if (!section) return;
      if (v.key !== state.view) {
        section.hidden = true;
        setHtml(section, '');
        return;
      }
      if (v.key === 'overview') {
        renderOverview(NDIS);
      } else if (v.hasData(NDIS)) {
        v.render(NDIS);
      } else {
        renderViewEmptyState(v);
      }
    });

    renderFooter(NDIS);
    renderNav(NDIS);
  }

  // hashchange (and the equivalent for real <a href="#/...">  nav clicks,
  // browser back/forward, and manual URL edits) all funnel through here.
  function onHashChange() {
    state.view = parseHash();
    renderAll();
    applyDocumentTitle();
    window.scrollTo(0, 0);
    var meta = viewMetaByKey(state.view);
    var heading = meta ? document.getElementById(meta.headingId) : null;
    if (heading && heading.focus) heading.focus({ preventScroll: true });
  }

  function init() {
    NDIS = window.NDIS || null;
    state.diffRelease = (NDIS && NDIS.diffs && NDIS.diffs.length) ? NDIS.diffs[NDIS.diffs.length - 1].to : null;
    state.view = parseHash();
    initTheme();
    renderAll();
    applyDocumentTitle();
    window.addEventListener('hashchange', onHashChange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

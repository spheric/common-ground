'use strict';
/* ==========================================================================
   Common Ground — NDIS Tracker behaviour
   Section map:
     1  Small generic helpers (escaping, formatting)
     2  Pure data functions
     3  Constants
     4  App state
     5  Theme (shared storage key with the main app)
     6  Header / footer rendering
     7  Section 1 — What changed in pricing
     8  Section 2 — Price history explorer
     9  Section 3 — The law
     10 Section 4 — Updates
     11 Section 5 — Scheme in numbers
     12 Top-level render orchestration + init
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
    return '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Math.round(n).toLocaleString('en-AU');
  }
  function fmtCompactCurrency(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + Math.round(n).toLocaleString('en-AU');
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
    diffRelease: null,
    search: '',
    pinned: [],
    feedTypes: new Set(),
    cpiOverlay: false,
    pinHint: '',
    feedHint: ''
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
    var subtitleEl = document.getElementById('mastheadSubtitle');
    var metaEl = document.getElementById('mastheadMeta');
    if (!ndis) {
      if (subtitleEl) subtitleEl.textContent = 'No data loaded.';
      if (metaEl) metaEl.textContent = '';
      return;
    }
    if (subtitleEl) subtitleEl.textContent = 'Prices, legislation and scheme data for the NDIS — every figure and claim links to an official source.';
    if (metaEl) metaEl.textContent = 'Sources: NDIA, Federal Register of Legislation, Parliament of Australia, ABS · as of ' + ndis.meta.as_of;
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
    var w = 150, h = 28, cx0 = w / 2;
    var dots = items.map(function (it) {
      var bin = rampBin(it.pct, maxAbs);
      var frac = Math.max(-1, Math.min(1, it.pct / (maxAbs || 1)));
      var cx = cx0 + frac * (cx0 - 10);
      // 2px surface-colour ring keeps overlapping dots (close pct values) legible.
      return '<circle cx="' + cx.toFixed(1) + '" cy="14" r="4" fill="' + RAMP_HEX[bin] + '" stroke="var(--surface)" stroke-width="2"></circle>';
    }).join('');
    return (
      '<svg class="dot-strip-svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' +
        '<line x1="' + cx0 + '" y1="4" x2="' + cx0 + '" y2="' + (h - 4) + '" stroke="var(--hairline)" stroke-width="1"></line>' +
        dots +
      '</svg>'
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
    return (
      '<details class="item-list-details" id="' + idPrefix + '"><summary>' + esc(label) + ' (' + list.length + ')</summary>' +
        '<ul>' + items + '</ul>' +
      '</details>'
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

    var categoryRows = current.by_category.map(function (cat) {
      var items = current.changed.filter(function (c) { return c.category === cat.category; }).map(function (c) {
        return { pct: c.pct };
      });
      var signCls = cat.median_pct >= 0 ? 'is-increase' : 'is-decrease';
      var medianCell = cat.changed > 0
        ? '<span class="sign-chip ' + signCls + '">' + fmtPctSigned(cat.median_pct) + '</span>'
        : '<span class="dot-strip-empty">—</span>';
      return (
        '<tr>' +
          '<td>' + esc(cat.category) + renderCategoryDetails(current, cat.category) + '</td>' +
          '<td class="tnum">' + cat.changed + '</td>' +
          '<td class="tnum">' + medianCell + '</td>' +
          '<td class="tnum">' + cat.added + '</td>' +
          '<td class="tnum">' + cat.retired + '</td>' +
          '<td class="dot-strip-cell">' + renderDotStrip(items, maxAbs) + '</td>' +
        '</tr>'
      );
    }).join('');

    var addedDetails = renderItemListDetails('addedItemsDetails', 'Added items', current.added, true);
    var retiredDetails = renderItemListDetails('retiredItemsDetails', 'Retired items', current.retired, false);

    setHtml(section,
      '<h2 class="section-heading" id="sectionPricingHeading">What changed in pricing</h2>' +
      '<p class="section-intro">Item-by-item differences between two consecutive NDIS Support Catalogue releases, diffed by support item number.</p>' +
      '<div class="release-picker-row"><label for="diffPicker">Comparing</label>' +
        '<select id="diffPicker">' + pickerOptions + '</select></div>' +
      statTiles +
      '<div class="table-scroll"><table class="diff-table">' +
        '<thead><tr><th>Category</th><th class="tnum">Changed</th><th class="tnum">Median %</th><th class="tnum">Added</th><th class="tnum">Retired</th><th>Distribution of change</th></tr></thead>' +
        '<tbody>' + categoryRows + '</tbody>' +
      '</table></div>' +
      addedDetails + retiredDetails
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
      return '<div class="explorer-empty">Search and select up to ' + MAX_PINNED + ' support items above to see their price history.</div>';
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

    var bandsSvg = '';
    var linesSvg = '';
    var dotsSvg = '';
    var endLabels = [];

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
        gridSvg + xAxisSvg + bandsSvg + linesSvg + dotsSvg + cpiSvg + labelsSvg +
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
      '<h2 class="section-heading" id="sectionExplorerHeading">Price history explorer</h2>' +
      '<p class="section-intro">Search a support item to trace its national price across every catalogue release. Pin up to ' + MAX_PINNED + ' items to compare.</p>' +
      '<label class="search-field"><span class="search-icon" aria-hidden="true">⌕</span>' +
        '<span class="visually-hidden">Search support items by number, name or category</span>' +
        '<input type="search" id="explorerSearch" placeholder="Search by item number, name or category…"></label>' +
      renderSearchResults(ndis) +
      renderPinnedRow(ndis) +
      '<p class="pinned-hint" id="pinnedHint" aria-live="polite">' + esc(state.pinHint) + '</p>' +
      cpiRow +
      renderExplorerChart(ndis)
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
     9. Section 3 — The law
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

    var timelineHtml = entries.map(function (e) {
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

    setHtml(section,
      '<h2 class="section-heading" id="sectionLawHeading">The law</h2>' +
      '<p class="section-intro">The NDIS Act, its compilations, related legislative instruments registered in the last three years, and bills before parliament.</p>' +
      renderLawCallout(ndis) +
      (entries.length ? '<div class="timeline">' + timelineHtml + '</div>' : '<p class="section-intro">No timeline entries in range.</p>')
    );
  }

  /* ------------------------------------------------------------------------
     10. Section 4 — Updates
     ------------------------------------------------------------------------ */

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
          itemsHtml += '<h3 class="feed-month-heading">' + esc(monthHeading(it.date)) + '</h3>';
        }
        var meta = TYPE_META[it.type] || { emoji: '•', label: it.type };
        var badge = it.verified === 'auto'
          ? '<span class="badge-auto">via official feed</span>'
          : '<span class="badge-verified">✓ source-checked</span>';
        itemsHtml += (
          '<div class="feed-item">' +
            '<div class="feed-item-head">' +
              '<span class="feed-item-date">' + esc(fmtDateLong(it.date)) + '</span>' +
              '<span class="type-chip"><span aria-hidden="true">' + meta.emoji + '</span> ' + esc(meta.label) + '</span>' +
            '</div>' +
            '<div class="feed-item-title"><a href="' + esc(it.source.url) + '" target="_blank" rel="noopener">' + esc(it.title) + '</a></div>' +
            (it.summary ? '<p class="feed-item-summary">' + esc(it.summary) + '</p>' : '') +
            '<div class="feed-item-meta"><span>' + esc(it.source.publisher) + '</span>' + badge + '</div>' +
          '</div>'
        );
      });
    }

    setHtml(section,
      '<h2 class="section-heading" id="sectionUpdatesHeading">Updates</h2>' +
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
     11. Section 5 — Scheme in numbers
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

  function renderNumbers(ndis) {
    var section = document.getElementById('sectionNumbers');
    if (!ndis || !ndis.context) { if (section) section.hidden = true; return; }
    section.hidden = false;
    var ctx = ndis.context;

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

    var chart = ctx.quarterly ? renderNumbersChart(ctx.quarterly.by_quarter) : '';

    var nextDataHtml = '';
    if (ctx.next_data && ctx.next_data.length) {
      var items = ctx.next_data.map(function (nd) {
        return (
          '<li class="next-data-item"><span>' + esc(nd.label) + (nd.note ? '<span class="next-data-note">' + esc(nd.note) + '</span>' : '') + '</span>' +
            '<span class="next-data-due tnum">' + esc(nd.due) + '</span></li>'
        );
      }).join('');
      nextDataHtml = '<h3 class="subsection-heading">Next data</h3><ul class="next-data-list">' + items + '</ul>';
    }

    setHtml(section,
      '<h2 class="section-heading" id="sectionNumbersHeading">Scheme in numbers</h2>' +
      (tiles.length ? '<div class="stat-tiles">' + tiles.join('') + '</div>' : '') +
      chart +
      nextDataHtml
    );
  }

  /* ------------------------------------------------------------------------
     12. Top-level render orchestration + init
     ------------------------------------------------------------------------ */

  function renderAll() {
    renderHeader(NDIS);
    var noDataEl = document.getElementById('noDataNote');
    if (!NDIS) {
      setHtml(noDataEl, '<div class="no-data-note"><p><strong>No data.</strong> Run the NDIS data pipeline to generate <code>data/ndis/ndis.json</code>, then rebuild with <code>node scripts/build.mjs</code>.</p></div>');
      ['sectionPricing', 'sectionExplorer', 'sectionLaw', 'sectionUpdates', 'sectionNumbers'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.hidden = true;
      });
      renderFooter(null);
      return;
    }
    setHtml(noDataEl, '');
    renderPricing(NDIS);
    renderExplorer(NDIS);
    renderLaw(NDIS);
    renderUpdates(NDIS);
    renderNumbers(NDIS);
    renderFooter(NDIS);
  }

  function init() {
    NDIS = window.NDIS || null;
    state.diffRelease = (NDIS && NDIS.diffs && NDIS.diffs.length) ? NDIS.diffs[NDIS.diffs.length - 1].to : null;
    initTheme();
    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

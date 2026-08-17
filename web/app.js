'use strict';
/* ==========================================================================
   Common Ground — app behaviour
   Section map:
     1  Small generic helpers (escaping)
     2  Pure data functions (copy-paste block — see markers below)
     3  Constants (party order, stance styling, heatmap ramp, venn layouts)
     4  App state
     5  Theme
     6  Header / footer rendering
     7  Filter row rendering
     8  View tabs
     9  Matrix view rendering
     10 Detail drawer
     11 Overlap view rendering (party picker, venn, region list, heatmap)
     12 Top-level render orchestration + init
   No globals beyond window.DATASET — everything else lives inside the IIFE.
   All dynamic dataset strings are passed through esc() before insertion —
   sources/titles/publishers ultimately come from the web, so they are
   treated as untrusted even though the rest of the dataset is trusted-ish.
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

  // Single choke point for building markup from strings. Every dynamic
  // dataset value that flows into these strings is passed through esc()
  // first (see the render* functions below), so this is not taking raw
  // untrusted input — it is the "one esc() helper" the spec calls for.
  function setHtml(el, htmlString) {
    el.innerHTML = htmlString;
  }

  /* ------------------------------------------------------------------------
     2. PURE DATA FUNCTIONS (copy-paste block start)
     No DOM access, no reference to app state — deterministic given their
     inputs. Kept together so they can be lifted verbatim into a standalone
     test script. Do not add DOM or state references inside this block.
     ------------------------------------------------------------------------ */

  function partyStanceMap(issue) {
    var map = {};
    var positions = issue.positions || [];
    for (var i = 0; i < positions.length; i++) {
      map[positions[i].party] = positions[i].stance;
    }
    return map;
  }

  function issueImpactUnion(issue) {
    var set = new Set();
    var positions = issue.positions || [];
    for (var i = 0; i < positions.length; i++) {
      var impacts = positions[i].impacts || [];
      for (var j = 0; j < impacts.length; j++) set.add(impacts[j]);
    }
    return set;
  }

  function issueMatchesSearch(issue, searchLower) {
    if (!searchLower) return true;
    if (String(issue.label || '').toLowerCase().indexOf(searchLower) !== -1) return true;
    if (String(issue.question || '').toLowerCase().indexOf(searchLower) !== -1) return true;
    var positions = issue.positions || [];
    for (var i = 0; i < positions.length; i++) {
      var summary = positions[i].summary || '';
      if (summary.toLowerCase().indexOf(searchLower) !== -1) return true;
    }
    return false;
  }

  function filterIssues(issues, opts) {
    var tagIds = (opts && opts.tagIds) || [];
    var searchLower = String((opts && opts.search) || '').trim().toLowerCase();
    return issues.filter(function (issue) {
      if (tagIds.length > 0) {
        var union = issueImpactUnion(issue);
        var matchesTag = false;
        for (var i = 0; i < tagIds.length; i++) {
          if (union.has(tagIds[i])) { matchesTag = true; break; }
        }
        if (!matchesTag) return false;
      }
      return issueMatchesSearch(issue, searchLower);
    });
  }

  function flattenIssues(dataset) {
    var out = [];
    var topics = (dataset && dataset.topics) || [];
    for (var t = 0; t < topics.length; t++) {
      var topic = topics[t];
      var issues = topic.issues || [];
      for (var i = 0; i < issues.length; i++) {
        var issue = issues[i];
        var copy = {};
        for (var key in issue) if (Object.prototype.hasOwnProperty.call(issue, key)) copy[key] = issue[key];
        copy.topicId = topic.id;
        copy.topicLabel = topic.label;
        out.push(copy);
      }
    }
    return out;
  }

  function kCombinations(arr, k) {
    var results = [];
    function helper(start, combo) {
      if (combo.length === k) { results.push(combo.slice()); return; }
      for (var i = start; i < arr.length; i++) {
        combo.push(arr[i]);
        helper(i + 1, combo);
        combo.pop();
      }
    }
    helper(0, []);
    return results;
  }

  function vennComboKey(ids) { return ids.slice().sort().join('+'); }
  function vennSoloKey(id) { return 'solo:' + id; }

  // Region-membership algorithm (exact spec rule):
  // Among the SELECTED parties only, group their stances on each issue,
  // ignoring no_position (those parties don't participate at all). Every
  // maximal same-stance group of >=2 parties puts the issue in that
  // combination's region. A party whose stance no selected party shares
  // contributes the issue to its own solo region. The same issue can land
  // in more than one region on a 3-party venn (e.g. an AB-agreement region
  // and C's solo region simultaneously).
  function computeVennRegions(issues, selectedPartyIds) {
    var regions = new Map();

    selectedPartyIds.forEach(function (id) {
      regions.set(vennSoloKey(id), { type: 'solo', partyIds: [id], issueIds: [] });
    });
    for (var size = 2; size <= selectedPartyIds.length; size++) {
      kCombinations(selectedPartyIds, size).forEach(function (combo) {
        var sorted = combo.slice().sort();
        regions.set(vennComboKey(sorted), { type: 'combo', partyIds: sorted, issueIds: [] });
      });
    }

    issues.forEach(function (issue) {
      var stances = partyStanceMap(issue);
      var participating = selectedPartyIds.filter(function (id) {
        return stances[id] && stances[id] !== 'no_position';
      });
      var groups = new Map();
      participating.forEach(function (id) {
        var s = stances[id];
        if (!groups.has(s)) groups.set(s, []);
        groups.get(s).push(id);
      });
      groups.forEach(function (ids) {
        if (ids.length >= 2) {
          var comboKey = vennComboKey(ids);
          if (!regions.has(comboKey)) regions.set(comboKey, { type: 'combo', partyIds: ids.slice().sort(), issueIds: [] });
          regions.get(comboKey).issueIds.push(issue.id);
        } else if (ids.length === 1) {
          var soloKeyVal = vennSoloKey(ids[0]);
          if (!regions.has(soloKeyVal)) regions.set(soloKeyVal, { type: 'solo', partyIds: ids, issueIds: [] });
          regions.get(soloKeyVal).issueIds.push(issue.id);
        }
      });
    });

    return regions;
  }

  // % of issues where both parties hold the same definite (non no_position)
  // stance, out of the issues where both parties have a definite stance.
  function computeAgreement(issues, partyA, partyB) {
    var both = 0, agree = 0;
    issues.forEach(function (issue) {
      var stances = partyStanceMap(issue);
      var a = stances[partyA], b = stances[partyB];
      if (a && a !== 'no_position' && b && b !== 'no_position') {
        both++;
        if (a === b) agree++;
      }
    });
    var pct = both === 0 ? null : Math.round((agree / both) * 100);
    return { both: both, agree: agree, pct: pct };
  }

  // 5 discrete bins, equal width, over 0-100%.
  function heatBin(pct) {
    if (pct === null || pct === undefined) return null;
    return Math.min(4, Math.max(0, Math.floor(pct / 20)));
  }

  /* ------------------------------------------------------------------------
     2. PURE DATA FUNCTIONS (copy-paste block end)
     ------------------------------------------------------------------------ */

  /* ------------------------------------------------------------------------
     3. Constants
     ------------------------------------------------------------------------ */

  var PARTY_ORDER = ['labor', 'coalition', 'greens', 'one_nation'];

  var STANCE_CHIP_CLASS = {
    supports: 'chip-support',
    opposes: 'chip-oppose',
    mixed: 'chip-mixed',
    no_position: 'chip-ghost'
  };

  var HEATMAP_COLORS = ['#cde2fb', '#9db7d7', '#6d8cb3', '#3d618f', '#0d366b'];

  var THEME_KEY = 'common-ground-theme';
  var THEME_CYCLE = ['auto', 'light', 'dark'];
  var THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };
  var THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };

  // Fixed classic venn layouts. Coordinates are hand-placed for a
  // recognisable, symmetric 2- or 3-circle diagram (120 degrees apart for
  // three). Region button positions are approximate centroids of each zone.
  var VENN_LAYOUTS = {
    2: {
      viewBox: '0 0 400 280',
      width: 400,
      height: 280,
      circles: [
        { cx: 150, cy: 140, r: 105, labelX: 45, labelY: 30, labelAnchor: 'start' },
        { cx: 250, cy: 140, r: 105, labelX: 355, labelY: 30, labelAnchor: 'end' }
      ],
      soloPoints: [[105, 140], [295, 140]],
      pairPoints: [[200, 140]]
    },
    3: {
      viewBox: '0 0 400 360',
      width: 400,
      height: 360,
      circles: [
        { cx: 200, cy: 132, r: 95, labelX: 200, labelY: 12, labelAnchor: 'middle' },
        { cx: 155, cy: 206, r: 95, labelX: 70, labelY: 336, labelAnchor: 'start' },
        { cx: 245, cy: 206, r: 95, labelX: 330, labelY: 336, labelAnchor: 'end' }
      ],
      soloPoints: [[200, 95], [115, 245], [285, 245]],
      pairPoints: [[163, 158], [237, 158], [200, 232]],
      triplePoint: [200, 178]
    }
  };

  /* ------------------------------------------------------------------------
     4. App state (single object, per spec)
     ------------------------------------------------------------------------ */

  var state = {
    dataset: null,
    flatIssues: [],
    totalIssueCount: 0,
    filteredIssuesFlat: [],
    filteredIssueIds: new Set(),
    filteredIssueCount: 0,
    tags: new Set(),
    search: '',
    view: 'matrix',
    vennParties: [],
    vennRegionKey: null,
    vennHint: '',
    theme: 'auto',
    drawer: { open: false, issueId: null, triggerEl: null }
  };

  /* ------------------------------------------------------------------------
     5. Theme
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
    btn.addEventListener('click', function () {
      var idx = THEME_CYCLE.indexOf(state.theme);
      state.theme = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
      applyTheme(state.theme);
      storeTheme(state.theme);
    });
  }

  /* ------------------------------------------------------------------------
     Shared lookups
     ------------------------------------------------------------------------ */

  function orderedParties(dataset) {
    var byId = {};
    dataset.parties.forEach(function (p) { byId[p.id] = p; });
    return PARTY_ORDER.map(function (id) { return byId[id]; }).filter(Boolean);
  }

  function stanceMeta(dataset, stanceId) {
    return dataset.stances.filter(function (s) { return s.id === stanceId; })[0];
  }

  function tagLookup(dataset, tagId) {
    return dataset.impact_tags.filter(function (t) { return t.id === tagId; })[0];
  }

  function shortNameForParty(dataset, id) {
    var p = dataset.parties.filter(function (x) { return x.id === id; })[0];
    return p ? p.short : id;
  }

  function renderStanceChip(dataset, stance, confidence) {
    var meta = stanceMeta(dataset, stance);
    if (!meta) return '';
    var cls = STANCE_CHIP_CLASS[stance] || 'chip-ghost';
    var lowConf = confidence === 'low';
    return (
      '<span class="chip ' + cls + (lowConf ? ' chip-low-confidence' : '') + '">' +
        '<span class="chip-symbol" aria-hidden="true">' + esc(meta.symbol) + '</span>' +
        '<span>' + esc(meta.label) + '</span>' +
        (lowConf ? '<sup title="Low confidence — see sources" aria-label="Low confidence, see sources">?</sup>' : '') +
      '</span>'
    );
  }

  /* ------------------------------------------------------------------------
     6. Header / footer rendering
     ------------------------------------------------------------------------ */

  function renderHeader(dataset) {
    var subtitleEl = document.getElementById('mastheadSubtitle');
    var metaEl = document.getElementById('mastheadMeta');
    if (!dataset) {
      subtitleEl.textContent = 'No dataset loaded.';
      metaEl.textContent = '';
      return;
    }
    subtitleEl.textContent = dataset.meta.subtitle || '';
    metaEl.textContent = 'Verified · as of ' + dataset.meta.as_of;
  }

  function renderFooter(dataset, flatIssues) {
    var el = document.getElementById('siteFooter');
    if (!dataset) { setHtml(el, ''); return; }
    var sourceCount = 0;
    flatIssues.forEach(function (issue) {
      (issue.positions || []).forEach(function (p) { sourceCount += (p.sources || []).length; });
    });
    setHtml(el,
      '<p>' + esc(dataset.meta.methodology) + '</p>' +
      '<p>' + esc(dataset.meta.disclaimer) + '</p>' +
      '<p><strong class="tnum">' + sourceCount + '</strong> cited sources across ' +
        flatIssues.length + ' issues. Summaries paraphrase cited sources — always check the link.</p>'
    );
  }

  /* ------------------------------------------------------------------------
     7. Filter row rendering
     ------------------------------------------------------------------------ */

  function recomputeFilteredIssues() {
    var filtered = filterIssues(state.flatIssues, { tagIds: Array.from(state.tags), search: state.search });
    state.filteredIssuesFlat = filtered;
    state.filteredIssueIds = new Set(filtered.map(function (i) { return i.id; }));
    state.filteredIssueCount = filtered.length;
  }

  function updateFilterStatusText() {
    var filtersActive = state.tags.size > 0 || state.search.trim().length > 0;
    var statusEl = document.getElementById('filterStatusText');
    var resetBtn = document.getElementById('filterResetBtn');
    var clearBtn = document.getElementById('tagClearBtn');
    if (statusEl) {
      statusEl.textContent = filtersActive
        ? (state.filteredIssueCount + ' of ' + state.totalIssueCount + ' issues shown')
        : (state.totalIssueCount + ' issue' + (state.totalIssueCount === 1 ? '' : 's'));
    }
    if (resetBtn) resetBtn.disabled = !filtersActive;
    if (clearBtn) clearBtn.disabled = state.tags.size === 0;
  }

  function renderTagChipList(dataset) {
    var list = document.getElementById('tagChipList');
    if (!list) return;
    var chipsHtml = dataset.impact_tags.map(function (tag) {
      var pressed = state.tags.has(tag.id);
      return (
        '<button type="button" class="tag-chip" data-tag="' + esc(tag.id) + '" aria-pressed="' + pressed + '">' +
          '<span class="tag-chip-emoji" aria-hidden="true">' + esc(tag.emoji) + '</span>' +
          '<span>' + esc(tag.label) + '</span>' +
        '</button>'
      );
    }).join('');
    setHtml(list, chipsHtml +
      '<button type="button" class="tag-chip-clear" id="tagClearBtn"' + (state.tags.size === 0 ? ' disabled' : '') + '>Clear all</button>');

    Array.prototype.forEach.call(list.querySelectorAll('.tag-chip[data-tag]'), function (btn) {
      btn.addEventListener('click', function () {
        var tag = btn.getAttribute('data-tag');
        if (state.tags.has(tag)) state.tags['delete'](tag); else state.tags.add(tag);
        recomputeFilteredIssues();
        renderTagChipList(dataset);
        updateFilterStatusText();
        renderActiveView();
        var refocus = list.querySelector('.tag-chip[data-tag="' + tag + '"]');
        if (refocus) refocus.focus();
      });
    });
    var clearBtn = document.getElementById('tagClearBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        state.tags.clear();
        recomputeFilteredIssues();
        renderTagChipList(dataset);
        updateFilterStatusText();
        renderActiveView();
      });
    }
  }

  function renderFilterRow(dataset) {
    var el = document.getElementById('filterRow');
    if (!dataset) { setHtml(el, ''); return; }

    setHtml(el,
      '<div>' +
        '<span class="filter-block-label" id="tagFilterLabel">Show what affects…</span>' +
        '<div class="tag-chip-list" id="tagChipList" role="group" aria-labelledby="tagFilterLabel"></div>' +
      '</div>' +
      '<div class="filter-second-row">' +
        '<label class="search-field">' +
          '<span class="search-icon" aria-hidden="true">⌕</span>' +
          '<span class="visually-hidden">Search issues</span>' +
          '<input type="search" id="searchInput" placeholder="Search issues, questions, summaries…">' +
        '</label>' +
        '<div class="filter-status">' +
          '<span id="filterStatusText"></span>' +
          '<button type="button" class="filter-reset" id="filterResetBtn">Reset filters</button>' +
        '</div>' +
      '</div>'
    );

    renderTagChipList(dataset);
    updateFilterStatusText();

    var searchInput = document.getElementById('searchInput');
    searchInput.value = state.search;
    searchInput.addEventListener('input', function () {
      state.search = searchInput.value;
      recomputeFilteredIssues();
      updateFilterStatusText();
      renderActiveView();
    });

    document.getElementById('filterResetBtn').addEventListener('click', function () {
      state.tags.clear();
      state.search = '';
      searchInput.value = '';
      recomputeFilteredIssues();
      renderTagChipList(dataset);
      updateFilterStatusText();
      renderActiveView();
      document.getElementById('filterResetBtn').focus();
    });
  }

  /* ------------------------------------------------------------------------
     8. View tabs
     ------------------------------------------------------------------------ */

  function initTabs() {
    var tabMatrix = document.getElementById('tabMatrix');
    var tabOverlap = document.getElementById('tabOverlap');
    var panelMatrix = document.getElementById('viewMatrix');
    var panelOverlap = document.getElementById('viewOverlap');
    var tabs = [tabMatrix, tabOverlap];
    tabMatrix.tabIndex = 0;
    tabOverlap.tabIndex = -1;

    function selectView(view) {
      state.view = view;
      var isMatrix = view === 'matrix';
      tabMatrix.setAttribute('aria-selected', String(isMatrix));
      tabOverlap.setAttribute('aria-selected', String(!isMatrix));
      tabMatrix.tabIndex = isMatrix ? 0 : -1;
      tabOverlap.tabIndex = isMatrix ? -1 : 0;
      panelMatrix.hidden = !isMatrix;
      panelOverlap.hidden = isMatrix;
      renderActiveView();
    }

    tabMatrix.addEventListener('click', function () { selectView('matrix'); });
    tabOverlap.addEventListener('click', function () { selectView('overlap'); });

    tabs.forEach(function (tab, idx) {
      tab.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          var other = tabs[(idx + 1) % tabs.length];
          other.focus();
          other.click();
        }
      });
    });
  }

  /* ------------------------------------------------------------------------
     9. Matrix view rendering
     ------------------------------------------------------------------------ */

  function renderEmptyState() {
    return (
      '<div class="empty-state">' +
        '<p>No issues match your filters.</p>' +
        '<button type="button" class="filter-reset" id="emptyStateReset">Reset filters</button>' +
      '</div>'
    );
  }

  function wireEmptyStateReset(container) {
    var btn = container.querySelector('#emptyStateReset');
    if (!btn) return;
    btn.addEventListener('click', function () {
      state.tags.clear();
      state.search = '';
      var searchInput = document.getElementById('searchInput');
      if (searchInput) searchInput.value = '';
      recomputeFilteredIssues();
      renderTagChipList(state.dataset);
      updateFilterStatusText();
      renderActiveView();
    });
  }

  function renderPartyColHeader(party) {
    return (
      '<th scope="col" class="party-col-header">' +
        '<div class="party-underline" style="background:var(--party-' + esc(party.id) + ')"></div>' +
        '<span class="party-name">' + esc(party.short) + '</span>' +
        '<span class="party-role">' + esc(party.role) + '</span>' +
      '</th>'
    );
  }

  function renderMatrixRow(dataset, issue, parties) {
    var impactIds = Array.from(issueImpactUnion(issue));
    var impactTags = impactIds.map(function (id) { return tagLookup(dataset, id); }).filter(Boolean);
    var impactsHtml = impactTags.length
      ? '<span class="issue-impacts" title="' + esc(impactTags.map(function (t) { return t.label; }).join(', ')) + '">' +
          impactTags.map(function (t) { return esc(t.emoji); }).join(' ') +
        '</span>'
      : '';

    var cells = parties.map(function (party) {
      var pos = issue.positions.filter(function (p) { return p.party === party.id; })[0];
      if (!pos) return '<td class="stance-cell"></td>';
      return (
        '<td class="stance-cell">' +
          '<button type="button" class="stance-cell-btn" data-issue="' + esc(issue.id) + '">' +
            renderStanceChip(dataset, pos.stance, pos.confidence) +
          '</button>' +
        '</td>'
      );
    }).join('');

    return (
      '<tr>' +
        '<th scope="row" class="issue-row-th">' + esc(issue.label) +
          '<span class="issue-question">' + esc(issue.question) + '</span>' +
          impactsHtml +
        '</th>' +
        cells +
      '</tr>'
    );
  }

  function wireMatrixCellButtons(container, dataset) {
    Array.prototype.forEach.call(container.querySelectorAll('.stance-cell-btn'), function (btn) {
      btn.addEventListener('click', function () {
        openDrawer(dataset, btn.getAttribute('data-issue'), btn);
      });
    });
  }

  function renderMatrix(dataset) {
    var el = document.getElementById('viewMatrix');
    if (!dataset) {
      setHtml(el, '<div class="no-data-note"><p><strong>No data.</strong> Run the ingestion pipeline to generate <code>data/dataset.json</code>, then rebuild with <code>node scripts/build.mjs</code>.</p></div>');
      return;
    }
    var parties = orderedParties(dataset);
    var filteredIds = state.filteredIssueIds;

    var topicsHtml = dataset.topics.map(function (topic) {
      var issues = topic.issues.filter(function (issue) { return filteredIds.has(issue.id); });
      if (issues.length === 0) return '';
      var rows = issues.map(function (issue) { return renderMatrixRow(dataset, issue, parties); }).join('');
      return (
        '<section class="topic-section">' +
          '<h2 class="topic-heading">' + esc(topic.label) +
            '<span class="topic-count tnum">' + issues.length + ' issue' + (issues.length === 1 ? '' : 's') + '</span>' +
          '</h2>' +
          '<div class="table-scroll">' +
            '<table class="matrix-table">' +
              '<thead><tr>' +
                '<th scope="col" class="issue-col-header">Issue</th>' +
                parties.map(renderPartyColHeader).join('') +
              '</tr></thead>' +
              '<tbody>' + rows + '</tbody>' +
            '</table>' +
          '</div>' +
        '</section>'
      );
    }).join('');

    if (!topicsHtml.trim()) {
      setHtml(el, renderEmptyState());
      wireEmptyStateReset(el);
      return;
    }
    setHtml(el, topicsHtml);
    wireMatrixCellButtons(el, dataset);
  }

  /* ------------------------------------------------------------------------
     10. Detail drawer
     ------------------------------------------------------------------------ */

  var bodyScrollLockCount = 0;

  function lockBodyScroll() {
    bodyScrollLockCount++;
    document.body.style.overflow = 'hidden';
  }
  function unlockBodyScroll() {
    bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
    if (bodyScrollLockCount === 0) document.body.style.overflow = '';
  }

  function getFocusable(container) {
    var nodes = container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    return Array.prototype.filter.call(nodes, function (el) {
      return el.offsetParent !== null || el === document.activeElement;
    });
  }

  function onDrawerKeydown(e) {
    if (!state.drawer.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDrawer();
      return;
    }
    if (e.key === 'Tab') {
      var panel = document.getElementById('drawerPanel');
      if (!panel) return;
      var focusables = getFocusable(panel);
      if (focusables.length === 0) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!panel.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function renderPartyCard(dataset, party, pos) {
    var impacts = (pos.impacts || []).map(function (tagId) {
      var tag = tagLookup(dataset, tagId);
      if (!tag) return '';
      return '<span class="impact-tag-pill"><span aria-hidden="true">' + esc(tag.emoji) + '</span>' + esc(tag.label) + '</span>';
    }).join('');

    var verifiedBadge = (pos.verified === 'confirmed' || pos.verified === 'corrected')
      ? '<span class="verified-badge">✓ source-checked</span>'
      : '<span class="unverified-note">not independently verified</span>';

    var sourcesHtml;
    if (pos.sources && pos.sources.length) {
      sourcesHtml = '<div class="source-list">' + pos.sources.map(function (src) {
        var bits = [src.publisher, src.date].filter(Boolean).join(', ');
        return '<a href="' + esc(src.url) + '" target="_blank" rel="noopener">' + esc(src.title) + (bits ? ' (' + esc(bits) + ')' : '') + '</a>';
      }).join('') + '</div>';
    } else {
      sourcesHtml = '<p class="no-sources-note">No sources — no clear position found.</p>';
    }

    return (
      '<div class="party-card" style="--party-color:var(--party-' + esc(party.id) + ')">' +
        '<div class="party-card-head">' +
          '<span class="party-card-name">' + esc(party.short) + '</span>' +
          renderStanceChip(dataset, pos.stance, pos.confidence) +
        '</div>' +
        '<p class="party-card-summary">' + esc(pos.summary) + '</p>' +
        '<p class="party-card-impact-note"><strong>What it means for you:</strong> ' + esc(pos.impact_note) + '</p>' +
        (impacts ? '<div class="impact-tag-list">' + impacts + '</div>' : '') +
        '<div class="party-card-meta">' +
          '<span>Confidence: ' + esc(pos.confidence) + '</span>' +
          verifiedBadge +
        '</div>' +
        sourcesHtml +
      '</div>'
    );
  }

  function renderDrawer(dataset, issue) {
    var root = document.getElementById('drawerRoot');
    var parties = orderedParties(dataset);
    var cardsHtml = parties.map(function (party) {
      var pos = issue.positions.filter(function (p) { return p.party === party.id; })[0];
      return pos ? renderPartyCard(dataset, party, pos) : '';
    }).join('');

    setHtml(root,
      '<div class="drawer-backdrop" id="drawerBackdrop"></div>' +
      '<div class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle" id="drawerPanel">' +
        '<div class="drawer-header">' +
          '<h2 class="drawer-title" id="drawerTitle">' + esc(issue.label) +
            '<span class="drawer-question">' + esc(issue.question) + '</span>' +
          '</h2>' +
          '<button type="button" class="drawer-close" id="drawerCloseBtn" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="drawer-body">' + cardsHtml + '</div>' +
      '</div>'
    );

    document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);
    document.getElementById('drawerCloseBtn').addEventListener('click', closeDrawer);

    var panel = document.getElementById('drawerPanel');
    var focusables = getFocusable(panel);
    (focusables[0] || panel).focus();
  }

  function openDrawer(dataset, issueId, triggerEl) {
    var issue = state.flatIssues.filter(function (i) { return i.id === issueId; })[0];
    if (!issue) return;
    state.drawer = { open: true, issueId: issueId, triggerEl: triggerEl };
    renderDrawer(dataset, issue);
    lockBodyScroll();
    document.addEventListener('keydown', onDrawerKeydown, true);
  }

  function closeDrawer() {
    var root = document.getElementById('drawerRoot');
    setHtml(root, '');
    document.removeEventListener('keydown', onDrawerKeydown, true);
    unlockBodyScroll();
    var trigger = state.drawer && state.drawer.triggerEl;
    state.drawer = { open: false, issueId: null, triggerEl: null };
    if (trigger && document.contains(trigger)) trigger.focus();
  }

  /* ------------------------------------------------------------------------
     11. Overlap view rendering
     ------------------------------------------------------------------------ */

  function defaultVennParties(dataset) {
    var ids = dataset.parties.map(function (p) { return p.id; });
    var preferred = ['labor', 'coalition', 'greens'].filter(function (id) { return ids.indexOf(id) !== -1; });
    return preferred.length >= 2 ? preferred : ids.slice(0, Math.min(3, ids.length));
  }

  function togglePartyPick(partyId, dataset) {
    var arr = state.vennParties;
    var idx = arr.indexOf(partyId);
    if (idx !== -1) {
      if (arr.length > 2) {
        arr.splice(idx, 1);
        state.vennHint = '';
        state.vennRegionKey = null;
      } else {
        state.vennHint = 'Keep at least two parties selected — pick another party to swap instead.';
      }
      return;
    }
    if (arr.length < 3) {
      arr.push(partyId);
    } else {
      var removed = arr.shift();
      arr.push(partyId);
      state.vennHint = 'Picking a 4th party swapped in ' + shortNameForParty(dataset, partyId) +
        ' for ' + shortNameForParty(dataset, removed) + '.';
    }
    state.vennRegionKey = null;
  }

  function totalDefiniteCountForParty(issues, partyId) {
    var count = 0;
    issues.forEach(function (issue) {
      var stances = partyStanceMap(issue);
      if (stances[partyId] && stances[partyId] !== 'no_position') count++;
    });
    return count;
  }

  function renderVennSvgAndButtons(dataset, allParties, issues, regions) {
    var selected = PARTY_ORDER.filter(function (id) { return state.vennParties.indexOf(id) !== -1; });
    var n = selected.length;
    var layout = VENN_LAYOUTS[n];
    if (!layout) return '';
    var partyById = {};
    allParties.forEach(function (p) { partyById[p.id] = p; });

    var circlesSvg = layout.circles.map(function (c, i) {
      var party = partyById[selected[i]];
      return '<circle cx="' + c.cx + '" cy="' + c.cy + '" r="' + c.r + '" fill="var(--party-' + esc(party.id) +
        ')" fill-opacity="0.12" stroke="var(--party-' + esc(party.id) + ')" stroke-width="2"></circle>';
    }).join('');

    var labelsSvg = layout.circles.map(function (c, i) {
      var party = partyById[selected[i]];
      var total = totalDefiniteCountForParty(issues, party.id);
      return (
        '<text x="' + c.labelX + '" y="' + c.labelY + '" text-anchor="' + c.labelAnchor + '" class="venn-label">' + esc(party.short) + '</text>' +
        '<text x="' + c.labelX + '" y="' + (c.labelY + 15) + '" text-anchor="' + c.labelAnchor + '" class="venn-label-sub">' +
          total + ' issue' + (total === 1 ? '' : 's') +
        '</text>'
      );
    }).join('');

    var buttons = [];
    function pushButton(key, partyIds, point) {
      var region = regions.get(key) || { partyIds: partyIds, issueIds: [] };
      var count = region.issueIds.length;
      var names = partyIds.map(function (id) { return partyById[id].short; }).join(' and ');
      var label = partyIds.length > 1
        ? (names + ' agree, ' + count + ' issue' + (count === 1 ? '' : 's'))
        : (names + ' only, ' + count + ' issue' + (count === 1 ? '' : 's'));
      buttons.push({ key: key, x: point[0], y: point[1], count: count, label: label });
    }

    if (n === 2) {
      pushButton(vennSoloKey(selected[0]), [selected[0]], layout.soloPoints[0]);
      pushButton(vennSoloKey(selected[1]), [selected[1]], layout.soloPoints[1]);
      pushButton(vennComboKey([selected[0], selected[1]]), [selected[0], selected[1]], layout.pairPoints[0]);
    } else {
      pushButton(vennSoloKey(selected[0]), [selected[0]], layout.soloPoints[0]);
      pushButton(vennSoloKey(selected[1]), [selected[1]], layout.soloPoints[1]);
      pushButton(vennSoloKey(selected[2]), [selected[2]], layout.soloPoints[2]);
      pushButton(vennComboKey([selected[0], selected[1]]), [selected[0], selected[1]], layout.pairPoints[0]);
      pushButton(vennComboKey([selected[0], selected[2]]), [selected[0], selected[2]], layout.pairPoints[1]);
      pushButton(vennComboKey([selected[1], selected[2]]), [selected[1], selected[2]], layout.pairPoints[2]);
      pushButton(vennComboKey([selected[0], selected[1], selected[2]]), [selected[0], selected[1], selected[2]], layout.triplePoint);
    }

    var buttonsHtml = buttons.map(function (b) {
      var leftPct = (b.x / layout.width) * 100;
      var topPct = (b.y / layout.height) * 100;
      var pressed = state.vennRegionKey === b.key;
      var disabled = b.count === 0;
      return (
        '<button type="button" class="venn-region-btn" data-region="' + esc(b.key) +
          '" style="left:' + leftPct.toFixed(2) + '%;top:' + topPct.toFixed(2) + '%" aria-pressed="' + pressed +
          '" aria-label="' + esc(b.label) + '"' + (disabled ? ' disabled' : '') + '>' +
          '<span class="tnum" aria-hidden="true">' + b.count + '</span>' +
        '</button>'
      );
    }).join('');

    return (
      '<svg class="venn-svg" viewBox="' + layout.viewBox + '" aria-hidden="true">' +
        circlesSvg + labelsSvg +
      '</svg>' +
      buttonsHtml
    );
  }

  function regionGroupHeadingLabel(dataset, region, selected) {
    var partyById = {};
    dataset.parties.forEach(function (p) { partyById[p.id] = p; });
    var names = region.partyIds.map(function (id) { return partyById[id].short; });
    if (region.partyIds.length === selected.length && selected.length > 1) {
      return selected.length === 3 ? 'All three agree' : 'Both agree';
    }
    if (region.partyIds.length >= 2) return names.join(' + ') + ' only';
    return names[0] + ' only';
  }

  function renderRegionList(dataset, issues, regions) {
    var selected = PARTY_ORDER.filter(function (id) { return state.vennParties.indexOf(id) !== -1; });
    var issueById = {};
    issues.forEach(function (i) { issueById[i.id] = i; });

    var orderedKeys = [];
    for (var size = selected.length; size >= 2; size--) {
      kCombinations(selected, size).forEach(function (combo) { orderedKeys.push(vennComboKey(combo)); });
    }
    selected.forEach(function (id) { orderedKeys.push(vennSoloKey(id)); });

    return orderedKeys.map(function (key) {
      var region = regions.get(key);
      if (!region) return '';
      var heading = regionGroupHeadingLabel(dataset, region, selected);
      var itemsHtml = region.issueIds.map(function (issueId) {
        var issue = issueById[issueId];
        if (!issue) return '';
        var stances = partyStanceMap(issue);
        var sharedStance = stances[region.partyIds[0]];
        return (
          '<li><button type="button" class="region-item-btn" data-issue="' + esc(issueId) + '">' +
            '<span class="region-item-label">' + esc(issue.label) +
              '<span class="region-item-topic">' + esc(issue.topicLabel) + '</span>' +
            '</span>' +
            renderStanceChip(dataset, sharedStance, null) +
          '</button></li>'
        );
      }).join('');
      var isHidden = state.vennRegionKey && state.vennRegionKey !== key;
      return (
        '<div class="region-group"' + (isHidden ? ' hidden' : '') + '>' +
          '<h3 class="region-group-heading">' + esc(heading) + ' · <span class="tnum">' + region.issueIds.length + '</span></h3>' +
          (region.issueIds.length
            ? '<ul>' + itemsHtml + '</ul>'
            : '<p class="empty-region-note">No shared positions among the issues currently shown.</p>') +
        '</div>'
      );
    }).join('');
  }

  function wireVennRegionButtons(container, dataset) {
    Array.prototype.forEach.call(container.querySelectorAll('.venn-region-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-region');
        state.vennRegionKey = state.vennRegionKey === key ? null : key;
        renderOverlap(dataset);
      });
    });
  }

  function wireRegionListButtons(container, dataset) {
    Array.prototype.forEach.call(container.querySelectorAll('.region-item-btn'), function (btn) {
      btn.addEventListener('click', function () {
        openDrawer(dataset, btn.getAttribute('data-issue'), btn);
      });
    });
  }

  function wirePartyPicker(container, dataset) {
    Array.prototype.forEach.call(container.querySelectorAll('.party-pick-chip'), function (btn) {
      btn.addEventListener('click', function () {
        var partyId = btn.getAttribute('data-party');
        togglePartyPick(partyId, dataset);
        renderOverlap(dataset);
        var refocus = document.querySelector('.party-pick-chip[data-party="' + partyId + '"]');
        if (refocus) refocus.focus();
      });
    });
  }

  function renderHeatmap(dataset, parties, issues) {
    var headerRow = '<tr><th class="heatmap-col-header"></th>' + parties.map(function (p) {
      return '<th scope="col" class="heatmap-col-header">' + esc(p.short) + '</th>';
    }).join('') + '</tr>';

    var bodyRows = parties.map(function (rowParty, rowIdx) {
      var cells = parties.map(function (colParty, colIdx) {
        if (colIdx >= rowIdx) {
          return '<td class="heatmap-cell heatmap-cell-diagonal" aria-hidden="true"></td>';
        }
        var agreement = computeAgreement(issues, rowParty.id, colParty.id);
        if (agreement.pct === null) {
          var emptyTitle = 'No issues where both ' + rowParty.short + ' and ' + colParty.short + ' hold a definite position.';
          return '<td class="heatmap-cell heatmap-cell-empty tnum" title="' + esc(emptyTitle) + '">—</td>';
        }
        var bin = heatBin(agreement.pct);
        var textClass = bin >= 3 ? 'heat-text-light' : 'heat-text-dark';
        var title = rowParty.short + ' and ' + colParty.short + ' agree on ' + agreement.agree +
          ' of ' + agreement.both + ' issues both have positions on.';
        return (
          '<td class="heatmap-cell ' + textClass + ' tnum" style="background:' + HEATMAP_COLORS[bin] + '" title="' + esc(title) + '">' +
            agreement.pct + '%' +
          '</td>'
        );
      }).join('');
      return '<tr><th scope="row" class="heatmap-row-header">' + esc(rowParty.short) + '</th>' + cells + '</tr>';
    }).join('');

    return (
      '<div class="heatmap-section">' +
        '<h2 class="topic-heading">How often do they vote the same way here?</h2>' +
        '<div class="table-scroll">' +
          '<table class="heatmap-table">' +
            '<thead>' + headerRow + '</thead>' +
            '<tbody>' + bodyRows + '</tbody>' +
          '</table>' +
        '</div>' +
        '<p class="heatmap-note">Counted across issues currently shown by your filters.</p>' +
      '</div>'
    );
  }

  function renderOverlap(dataset) {
    var el = document.getElementById('viewOverlap');
    if (!dataset) {
      setHtml(el, '<div class="no-data-note"><p><strong>No data.</strong> Run the ingestion pipeline to generate <code>data/dataset.json</code>, then rebuild with <code>node scripts/build.mjs</code>.</p></div>');
      return;
    }
    var parties = orderedParties(dataset);
    var issues = state.filteredIssuesFlat;

    var pickerHtml = parties.map(function (p) {
      var pressed = state.vennParties.indexOf(p.id) !== -1;
      return (
        '<button type="button" class="party-pick-chip" data-party="' + esc(p.id) + '" aria-pressed="' + pressed +
          '" style="--party-color:var(--party-' + esc(p.id) + ')">' +
          '<span class="party-dot" aria-hidden="true"></span>' + esc(p.short) +
        '</button>'
      );
    }).join('');

    var hintHtml = '<p class="party-pick-hint" id="vennHint" aria-live="polite">' + esc(state.vennHint) + '</p>';

    if (issues.length === 0) {
      setHtml(el,
        '<div class="party-picker" id="partyPicker">' + pickerHtml + '</div>' +
        hintHtml +
        renderEmptyState()
      );
      wirePartyPicker(el, dataset);
      wireEmptyStateReset(el);
      return;
    }

    var regions = computeVennRegions(issues, state.vennParties);
    var vennHtml = renderVennSvgAndButtons(dataset, parties, issues, regions);
    var regionListHtml = renderRegionList(dataset, issues, regions);
    var heatmapHtml = renderHeatmap(dataset, parties, issues);

    setHtml(el,
      '<div class="party-picker" id="partyPicker">' + pickerHtml + '</div>' +
      hintHtml +
      '<div class="venn-wrap" id="vennWrap">' + vennHtml + '</div>' +
      '<div class="region-list" id="regionList">' + regionListHtml + '</div>' +
      heatmapHtml
    );

    wirePartyPicker(el, dataset);
    wireVennRegionButtons(el, dataset);
    wireRegionListButtons(el, dataset);
  }

  /* ------------------------------------------------------------------------
     12. Top-level render orchestration + init
     ------------------------------------------------------------------------ */

  function renderActiveView() {
    if (state.view === 'matrix') renderMatrix(state.dataset);
    else renderOverlap(state.dataset);
  }

  function renderAll() {
    renderHeader(state.dataset);
    renderFilterRow(state.dataset);
    renderActiveView();
    renderFooter(state.dataset, state.flatIssues);
  }

  function init() {
    var dataset = window.DATASET || null;
    state.dataset = dataset;
    state.flatIssues = dataset ? flattenIssues(dataset) : [];
    state.totalIssueCount = state.flatIssues.length;
    state.tags = new Set();
    state.search = '';
    state.view = 'matrix';
    state.vennParties = dataset ? defaultVennParties(dataset) : [];
    state.vennRegionKey = null;
    state.vennHint = '';
    state.drawer = { open: false, issueId: null, triggerEl: null };
    recomputeFilteredIssues();

    initTheme();
    initTabs();
    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

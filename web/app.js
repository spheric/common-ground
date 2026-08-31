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
     10 Detail drawer (+ shared vote trail renderer, used by drawer & Votes)
     11 Overlap view rendering (party picker, venn, region list, heatmap)
     12 Votes view rendering (parliamentary voting records)
     13 Over time view rendering (pair agreement over time, position shifts)
     14 Top-level render orchestration + init
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

  // Voting-record helpers. `stats` is one entry of a voting record's
  // `parties` map: { members, voted, for, against, mixed, median_agreement }.
  // A party with voted:0 has nothing meaningful to bar-chart or summarise —
  // callers must check voted > 0 before rendering a bar.
  function votingBarSegments(stats) {
    if (!stats || !stats.voted) return null;
    var total = stats.voted;
    return {
      forPct: (stats['for'] / total) * 100,
      mixedPct: (stats.mixed / total) * 100,
      againstPct: (stats.against / total) * 100
    };
  }

  // Full sentence used in the drawer's "In Parliament" section.
  function votingPartyCountsText(stats) {
    if (!stats || !stats.voted) return 'not enough voting data';
    var text = stats.voted + ' of ' + stats.members + ' members voted: ' +
      stats['for'] + ' for · ' + stats.against + ' against · ' + stats.mixed + ' mixed';
    if (typeof stats.median_agreement === 'number') {
      text += ' · median agreement ' + Math.round(stats.median_agreement) + '%';
    }
    return text;
  }

  // Compact F/A/M form used in the Votes view's per-party grid cells.
  function votingCompactText(stats) {
    if (!stats || !stats.voted) return 'not enough data';
    return stats['for'] + 'F · ' + stats.against + 'A · ' + stats.mixed + 'M of ' + stats.voted + ' voted';
  }

  // Vote-series helpers (Over time view + vote trail). A `series` entry is
  // one parliamentary division: { date, house, name, policy_vote,
  // parties:{partyId:{for,against}}, other }. `for`/`against` are already
  // oriented to the record's own proposition. Fewer than 2 of a party's
  // members voting is noise, so it counts as "no_data" everywhere.
  function seriesEntryPartyDirection(entry, partyId) {
    var stats = entry.parties && entry.parties[partyId];
    var f = stats ? (stats['for'] || 0) : 0;
    var a = stats ? (stats.against || 0) : 0;
    if (f + a < 2) return 'no_data';
    if (f === a) return 'split';
    return f > a ? 'for' : 'against';
  }

  // Gathers every voting-record `series` entry across the given (already
  // filtered) issues, deduplicated by date+house+division name — the same
  // physical division is often linked from more than one policy/issue.
  // Equality-of-direction between two parties is invariant to which
  // duplicate copy is kept (a shared orientation flip moves both parties'
  // direction together), so picking the first-seen copy is safe.
  function collectDedupedSeriesEntries(issues) {
    var seen = new Map();
    issues.forEach(function (issue) {
      if (!issue.voting) return;
      issue.voting.records.forEach(function (record) {
        (record.series || []).forEach(function (entry) {
          var key = entry.date + '|' + entry.house + '|' + entry.name;
          if (!seen.has(key)) seen.set(key, entry);
        });
      });
    });
    return Array.from(seen.values());
  }

  // Per-calendar-year agreement between two parties over a set of
  // (deduplicated) series entries. A division "qualifies" for a year when
  // both parties have a definite direction (for/against, not split, not
  // no_data); agreement means identical direction. Years with zero
  // qualifying divisions are simply absent from the result.
  function pairAgreementByYear(entries, partyA, partyB) {
    var byYear = new Map();
    entries.forEach(function (entry) {
      var dirA = seriesEntryPartyDirection(entry, partyA);
      var dirB = seriesEntryPartyDirection(entry, partyB);
      if (dirA === 'no_data' || dirB === 'no_data' || dirA === 'split' || dirB === 'split') return;
      var year = entry.date.slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, { agree: 0, n: 0 });
      var rec = byYear.get(year);
      rec.n++;
      if (dirA === dirB) rec.agree++;
    });
    var years = Array.from(byYear.keys()).sort();
    return years.map(function (year) {
      var rec = byYear.get(year);
      var pct = rec.n > 0 ? Math.round((rec.agree / rec.n) * 100) : null;
      // "qualifies" = eligible to be drawn as a chart point (>=3 divisions);
      // "hollow" = drawn but thin evidence (<6 divisions) — only meaningful
      // when qualifies is true.
      return { year: year, agree: rec.agree, n: rec.n, pct: pct, qualifies: rec.n >= 3, hollow: rec.n < 6 };
    });
  }

  // Mechanical position-shift detection, per (record, party): take the
  // record's series entries where the party has a definite for/against
  // direction (>=2 voters, not split), in the series' own chronological
  // order. Require >=6 such entries. The "first-sustained" direction is the
  // direction of the first pair of consecutive same-direction entries
  // (scanning from the start); "last-sustained" is the same scanning from
  // the end. A shift is flagged when both exist and differ. Results are
  // deduplicated by (policy_id, party) across issues — the same TVFY policy
  // can be linked from more than one issue — remembering every linked issue.
  function detectPositionShifts(issues) {
    var byKey = new Map();
    issues.forEach(function (issue) {
      if (!issue.voting) return;
      issue.voting.records.forEach(function (record) {
        if (!record.series || !record.series.length) return;
        PARTY_ORDER.forEach(function (partyId) {
          var seq = [];
          record.series.forEach(function (entry) {
            var dir = seriesEntryPartyDirection(entry, partyId);
            if (dir === 'for' || dir === 'against') seq.push({ dir: dir, date: entry.date });
          });
          if (seq.length < 6) return;
          var firstSustained = null;
          for (var i = 0; i < seq.length - 1; i++) {
            if (seq[i].dir === seq[i + 1].dir) { firstSustained = seq[i].dir; break; }
          }
          var lastSustained = null;
          for (var j = seq.length - 1; j > 0; j--) {
            if (seq[j].dir === seq[j - 1].dir) { lastSustained = seq[j].dir; break; }
          }
          if (!firstSustained || !lastSustained || firstSustained === lastSustained) return;
          var key = record.policy_id + '|' + partyId;
          if (!byKey.has(key)) {
            byKey.set(key, {
              policyId: record.policy_id,
              party: partyId,
              policyName: record.name,
              n: seq.length,
              firstYear: seq[0].date.slice(0, 4),
              lastYear: seq[seq.length - 1].date.slice(0, 4),
              firstDir: firstSustained,
              lastDir: lastSustained,
              issueIds: []
            });
          }
          var shift = byKey.get(key);
          if (shift.issueIds.indexOf(issue.id) === -1) shift.issueIds.push(issue.id);
        });
      });
    });
    return Array.from(byKey.values());
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
    overTimeParties: [],
    overTimeHint: '',
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
    var votingRecordCount = 0;
    flatIssues.forEach(function (issue) {
      (issue.positions || []).forEach(function (p) { sourceCount += (p.sources || []).length; });
      if (issue.voting) votingRecordCount += (issue.voting.records || []).length;
    });
    var votingParagraph = votingRecordCount > 0
      ? '<p><strong class="tnum">' + votingRecordCount + '</strong> parliamentary voting records from ' +
          '<a href="https://theyvoteforyou.org.au" target="_blank" rel="noopener">They Vote For You</a> ' +
          '(OpenAustralia Foundation), used under the Open Data Commons Open Database Licence.</p>'
      : '';
    setHtml(el,
      '<p>' + esc(dataset.meta.methodology) + '</p>' +
      '<p>' + esc(dataset.meta.disclaimer) + '</p>' +
      '<p><strong class="tnum">' + sourceCount + '</strong> cited sources across ' +
        flatIssues.length + ' issues. Summaries paraphrase cited sources — always check the link.</p>' +
      votingParagraph
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

  var VIEW_IDS = ['matrix', 'overlap', 'votes', 'time'];
  var VIEW_TAB_IDS = ['tabMatrix', 'tabOverlap', 'tabVotes', 'tabTime'];
  var VIEW_PANEL_IDS = ['viewMatrix', 'viewOverlap', 'viewVotes', 'viewTime'];

  function initTabs() {
    var tabs = VIEW_TAB_IDS.map(function (id) { return document.getElementById(id); });
    var panels = VIEW_PANEL_IDS.map(function (id) { return document.getElementById(id); });

    tabs.forEach(function (tab, idx) { tab.tabIndex = idx === 0 ? 0 : -1; });

    function selectView(view) {
      state.view = view;
      var activeIdx = VIEW_IDS.indexOf(view);
      tabs.forEach(function (tab, idx) {
        var isActive = idx === activeIdx;
        tab.setAttribute('aria-selected', String(isActive));
        tab.tabIndex = isActive ? 0 : -1;
      });
      panels.forEach(function (panel, idx) { panel.hidden = idx !== activeIdx; });
      renderActiveView();
    }

    tabs.forEach(function (tab, idx) {
      tab.addEventListener('click', function () { selectView(VIEW_IDS[idx]); });
      tab.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          var dir = e.key === 'ArrowRight' ? 1 : -1;
          var otherIdx = (idx + dir + tabs.length) % tabs.length;
          tabs[otherIdx].focus();
          tabs[otherIdx].click();
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
    var votingIndicatorHtml = issue.voting
      ? '<span class="voting-indicator" role="img" title="Parliamentary voting record available — open any cell" aria-label="Parliamentary voting record available — open any cell">🗳</span>'
      : '';

    var impactsHtml = (impactTags.length || votingIndicatorHtml)
      ? '<span class="issue-impacts"' +
          (impactTags.length ? ' title="' + esc(impactTags.map(function (t) { return t.label; }).join(', ')) + '"' : '') +
          '>' +
          impactTags.map(function (t) { return esc(t.emoji); }).join(' ') + votingIndicatorHtml +
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

  // Shared between the drawer's full voting section and the compact Votes
  // view: the "related vote" / "draft policy" tags for one voting record.
  function votingRecordTagsHtml(record) {
    var tags = '';
    if (record.strength === 'related') {
      tags += '<span class="voting-tag" title="A closely related proposition — not exactly the question above">related vote</span>';
    }
    if (record.provisional) {
      tags += '<span class="voting-tag" title="They Vote For You lists this policy as provisional/draft">draft policy</span>';
    }
    return tags;
  }

  function votingRecordPolarityNoteHtml(record) {
    return record.polarity === -1
      ? '<p class="voting-polarity-note">Agreeing with this proposition is the reverse of answering yes to the question above.</p>'
      : '';
  }

  // -- Vote trail: shared inline SVG timeline of a record's parliamentary
  // divisions, used by both the drawer's full "In Parliament" cards and the
  // Votes view's compact record cards. --

  function houseShortLabel(house) {
    return house === 'senate' ? 'Senate' : 'Reps';
  }

  // Sparse tick years for a [minYear, maxYear] span: always both endpoints,
  // plus round years between them at an interval that grows with the span
  // (kept sparse regardless of how many years the data covers). Shared by
  // the vote trail's date axis and the Over time pair-agreement chart.
  function computeSparseYearTicks(minYear, maxYear) {
    var ticks = [minYear];
    if (maxYear > minYear) {
      var span = maxYear - minYear;
      var interval = span <= 6 ? 2 : (span <= 30 ? 5 : 10);
      for (var y = Math.ceil((minYear + 1) / interval) * interval; y < maxYear; y += interval) {
        if (y > minYear && y < maxYear) ticks.push(y);
      }
      ticks.push(maxYear);
    }
    return ticks;
  }

  // One mark for one party's direction on one division. Position (not just
  // colour) carries the meaning — the app's green/red pair fails a
  // deuteranopia check on its own: "for" sits above the lane's midline,
  // "against" below it, "split" is a diamond centred on the line, "no data"
  // a faint dot on the line.
  function voteTrailMarkSvg(direction, x, centerY, compact, titleText) {
    var mh = compact ? 6 : 8, mw = compact ? 4 : 5, gap = 1;
    var titleEl = '<title>' + titleText + '</title>';
    if (direction === 'for') {
      var yFor = centerY - gap - mh;
      return '<rect x="' + (x - mw / 2).toFixed(1) + '" y="' + yFor.toFixed(1) + '" width="' + mw + '" height="' + mh +
        '" rx="1.2" class="vote-trail-mark vote-trail-mark-for">' + titleEl + '</rect>';
    }
    if (direction === 'against') {
      var yAgainst = centerY + gap;
      return '<rect x="' + (x - mw / 2).toFixed(1) + '" y="' + yAgainst.toFixed(1) + '" width="' + mw + '" height="' + mh +
        '" rx="1.2" class="vote-trail-mark vote-trail-mark-against">' + titleEl + '</rect>';
    }
    if (direction === 'split') {
      var half = (compact ? 5 : 7) / 2;
      var points = [[x, centerY - half], [x + half, centerY], [x, centerY + half], [x - half, centerY]]
        .map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
      return '<polygon points="' + points + '" class="vote-trail-mark vote-trail-mark-split">' + titleEl + '</polygon>';
    }
    return '<circle cx="' + x.toFixed(1) + '" cy="' + centerY.toFixed(1) + '" r="1.4" class="vote-trail-mark vote-trail-mark-nodata">' + titleEl + '</circle>';
  }

  // `opts.compact` shrinks lane height for the Votes view and switches off
  // the caption line — the <title> tooltips and the details/table twin
  // remain either way. The SVG is a fixed pixel size (not viewBox-scaled)
  // so its text stays legible; it lives in its own overflow-x:auto wrapper
  // so the page body never scrolls horizontally.
  function renderVoteTrail(dataset, record, opts) {
    var compact = !!(opts && opts.compact);
    var series = record.series || [];
    if (!series.length) return '';
    var parties = orderedParties(dataset);

    var W = compact ? 520 : 560;
    var leftMargin = compact ? 58 : 66;
    var rightMargin = 10;
    var laneHeight = compact ? 15 : 22;
    var topPad = 2;
    var axisHeight = compact ? 15 : 18;
    var H = topPad + laneHeight * parties.length + axisHeight;
    var plotLeft = leftMargin, plotRight = W - rightMargin;
    var plotWidth = plotRight - plotLeft;

    var minTime = Date.parse(series[0].date), maxTime = minTime;
    series.forEach(function (e) {
      var t = Date.parse(e.date);
      if (t < minTime) minTime = t;
      if (t > maxTime) maxTime = t;
    });
    var span = maxTime - minTime;
    function xForTime(t) {
      if (span <= 0) return plotLeft + plotWidth / 2;
      return plotLeft + ((t - minTime) / span) * plotWidth;
    }

    // Same-date divisions overlap at this scale — nudge x by up to +-2px.
    var dateGroups = {};
    series.forEach(function (e, idx) { (dateGroups[e.date] = dateGroups[e.date] || []).push(idx); });
    var jitterByIdx = {};
    Object.keys(dateGroups).forEach(function (date) {
      var idxs = dateGroups[date];
      idxs.forEach(function (idx, i) {
        jitterByIdx[idx] = idxs.length <= 1 ? 0 : (-2 + (4 * i) / (idxs.length - 1));
      });
    });
    var xByIdx = series.map(function (e, idx) { return xForTime(Date.parse(e.date)) + jitterByIdx[idx]; });

    var lanesSvg = '';
    parties.forEach(function (party, pIdx) {
      var centerY = topPad + pIdx * laneHeight + laneHeight / 2;
      lanesSvg += '<text x="2" y="' + centerY.toFixed(1) + '" class="vote-trail-party-label">' + esc(party.short) + '</text>';
      lanesSvg += '<line x1="' + plotLeft + '" y1="' + centerY + '" x2="' + plotRight + '" y2="' + centerY + '" class="vote-trail-midline"></line>';
      series.forEach(function (entry, idx) {
        var direction = seriesEntryPartyDirection(entry, party.id);
        var stats = entry.parties && entry.parties[party.id];
        var f = stats ? (stats['for'] || 0) : 0;
        var a = stats ? (stats.against || 0) : 0;
        var titleText = esc(entry.date) + ' · ' + esc(houseShortLabel(entry.house)) + ' · ' + esc(entry.name) +
          ' · ' + esc(party.short) + ': ' + f + ' for / ' + a + ' against';
        lanesSvg += voteTrailMarkSvg(direction, xByIdx[idx], centerY, compact, titleText);
      });
    });

    var minYear = new Date(minTime).getUTCFullYear();
    var maxYear = new Date(maxTime).getUTCFullYear();
    var axisY = topPad + laneHeight * parties.length + 3;
    var axisSvg = '<line x1="' + plotLeft + '" y1="' + axisY + '" x2="' + plotRight + '" y2="' + axisY + '" class="vote-trail-axis-line"></line>';
    computeSparseYearTicks(minYear, maxYear).forEach(function (year) {
      var x = xForTime(Date.UTC(year, 0, 1));
      var anchor = x <= plotLeft + 4 ? 'start' : (x >= plotRight - 4 ? 'end' : 'middle');
      axisSvg += '<line x1="' + x.toFixed(1) + '" y1="' + axisY + '" x2="' + x.toFixed(1) + '" y2="' + (axisY + 3) + '" class="vote-trail-axis-tick"></line>';
      axisSvg += '<text x="' + x.toFixed(1) + '" y="' + (axisY + 12) + '" text-anchor="' + anchor + '" class="vote-trail-axis-label">' + year + '</text>';
    });

    var svgHtml = '<svg class="vote-trail-svg' + (compact ? ' vote-trail-svg-compact' : '') + '" width="' + W + '" height="' + H +
      '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true" focusable="false">' + lanesSvg + axisSvg + '</svg>';

    var captionHtml = compact ? '' :
      '<p class="vote-trail-caption">Marks above the line: the party’s members mostly voted for the proposition; below: mostly against. Hover a mark for the division.</p>';

    var rowsHtml = series.map(function (entry) {
      var cells = parties.map(function (party) {
        var direction = seriesEntryPartyDirection(entry, party.id);
        var stats = entry.parties && entry.parties[party.id];
        var f = stats ? (stats['for'] || 0) : 0;
        var a = stats ? (stats.against || 0) : 0;
        return '<td class="tnum">' + (direction === 'no_data' ? '—' : (f + '–' + a)) + '</td>';
      }).join('');
      return '<tr><td class="tnum">' + esc(entry.date) + '</td><td>' + esc(houseShortLabel(entry.house)) + '</td><td>' +
        esc(entry.name) + '</td>' + cells + '</tr>';
    }).join('');

    var tableHtml =
      '<details class="voting-divisions">' +
        '<summary>All ' + series.length + ' division' + (series.length === 1 ? '' : 's') + '</summary>' +
        '<div class="table-scroll"><table class="divisions-table">' +
          '<thead><tr><th scope="col">Date</th><th scope="col">House</th><th scope="col">Division</th>' +
            parties.map(function (p) { return '<th scope="col">' + esc(p.short) + '</th>'; }).join('') +
          '</tr></thead>' +
          '<tbody>' + rowsHtml + '</tbody>' +
        '</table></div>' +
      '</details>';

    return (
      '<div class="vote-trail-scroll"><div class="vote-trail-wrap">' + svgHtml + '</div></div>' +
      captionHtml +
      tableHtml
    );
  }

  // Decorative bar — all numbers are printed as text alongside it, so it is
  // aria-hidden. Never called for voted:0; callers print "not enough voting
  // data" / "not enough data" instead of an empty bar.
  function renderVotingBar(stats) {
    var segs = votingBarSegments(stats);
    if (!segs) return '';
    var html = '<div class="voting-bar" aria-hidden="true">';
    if (segs.forPct > 0) html += '<span class="voting-bar-seg voting-bar-for" style="width:' + segs.forPct.toFixed(1) + '%"></span>';
    if (segs.mixedPct > 0) html += '<span class="voting-bar-seg voting-bar-mixed" style="width:' + segs.mixedPct.toFixed(1) + '%"></span>';
    if (segs.againstPct > 0) html += '<span class="voting-bar-seg voting-bar-against" style="width:' + segs.againstPct.toFixed(1) + '%"></span>';
    html += '</div>';
    return html;
  }

  function renderVotingPartyNameHtml(party) {
    return (
      '<span class="voting-party-name" style="--party-color:var(--party-' + esc(party.id) + ')">' +
        '<span class="voting-party-accent" aria-hidden="true"></span>' + esc(party.short) +
      '</span>'
    );
  }

  function renderVotingPartyRowFull(party, stats) {
    var nameHtml = renderVotingPartyNameHtml(party);
    if (!stats || !stats.voted) {
      return (
        '<div class="voting-party-row voting-party-row-empty">' +
          '<div class="voting-party-row-top">' + nameHtml + '<span class="voting-no-data">not enough voting data</span></div>' +
        '</div>'
      );
    }
    return (
      '<div class="voting-party-row">' +
        '<div class="voting-party-row-top">' + nameHtml + renderVotingBar(stats) + '</div>' +
        '<span class="voting-party-counts tnum">' + esc(votingPartyCountsText(stats)) + '</span>' +
      '</div>'
    );
  }

  function renderVotingRecordFull(dataset, record) {
    var parties = orderedParties(dataset);
    var tagsHtml = votingRecordTagsHtml(record);
    var rowsHtml = parties.map(function (party) {
      return renderVotingPartyRowFull(party, record.parties[party.id]);
    }).join('');
    var metaBits = [
      esc(record.divisions_total) + ' division' + (record.divisions_total === 1 ? '' : 's'),
      'Reps ' + esc(record.houses.representatives) + ' / Senate ' + esc(record.houses.senate),
      esc(record.first_division_date) + ' → ' + esc(record.last_division_date)
    ];
    return (
      '<div class="voting-record">' +
        '<p class="voting-proposition">On the proposition: <em>“' + esc(record.description) + '”</em></p>' +
        (tagsHtml ? '<div class="voting-tags">' + tagsHtml + '</div>' : '') +
        votingRecordPolarityNoteHtml(record) +
        (record.note ? '<p class="voting-record-note">' + esc(record.note) + '</p>' : '') +
        '<div class="voting-party-rows">' + rowsHtml + '</div>' +
        renderVoteTrail(dataset, record, { compact: false }) +
        '<p class="voting-record-meta tnum">' + metaBits.join(' · ') +
          ' · <a href="' + esc(record.url) + '" target="_blank" rel="noopener">They Vote For You →</a></p>' +
      '</div>'
    );
  }

  function votingAttributionHtml(asOf) {
    return (
      '<p class="voting-footer">Party figures aggregate They Vote For You per-member policy agreement for ' +
        'current MPs and senators only; members without enough relevant votes are excluded. Data: They Vote ' +
        'For You (OpenAustralia Foundation), Open Data Commons ODbL. As of ' + esc(asOf) + '. ' +
        'Timeline marks use the party each member sat with at the time of each division; the member counts ' +
        'and TVFY agreement medians follow current members, excluding members whose votes on a policy were ' +
        'cast while sitting with a different party.</p>'
    );
  }

  function renderVotingSection(dataset, issue) {
    if (!issue.voting) return '';
    var recordsHtml = issue.voting.records.map(function (record) {
      return renderVotingRecordFull(dataset, record);
    }).join('');
    return (
      '<div class="voting-section">' +
        '<h3 class="voting-heading">In Parliament — how they voted</h3>' +
        recordsHtml +
        votingAttributionHtml(issue.voting.as_of) +
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
    var votingSectionHtml = renderVotingSection(dataset, issue);

    setHtml(root,
      '<div class="drawer-backdrop" id="drawerBackdrop"></div>' +
      '<div class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle" id="drawerPanel">' +
        '<div class="drawer-header">' +
          '<h2 class="drawer-title" id="drawerTitle">' + esc(issue.label) +
            '<span class="drawer-question">' + esc(issue.question) + '</span>' +
          '</h2>' +
          '<button type="button" class="drawer-close" id="drawerCloseBtn" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="drawer-body">' + cardsHtml + votingSectionHtml + '</div>' +
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
     12. Votes view rendering
     ------------------------------------------------------------------------ */

  function renderVoteIssueHeaderHtml(issue) {
    return (
      '<button type="button" class="vote-issue-header" data-issue="' + esc(issue.id) + '">' +
        '<span class="vote-issue-label">' + esc(issue.label) + '</span>' +
        '<span class="vote-issue-question">' + esc(issue.question) + '</span>' +
      '</button>'
    );
  }

  function renderVotePartyCell(dataset, issue, party, record) {
    var pos = issue.positions.filter(function (p) { return p.party === party.id; })[0];
    var stats = record.parties[party.id];
    var votedHtml = (stats && stats.voted)
      ? renderVotingBar(stats) + '<span class="vote-party-counts tnum">' + esc(votingCompactText(stats)) + '</span>'
      : '<span class="voting-no-data">not enough data</span>';
    return (
      '<div class="vote-party-cell">' +
        renderVotingPartyNameHtml(party) +
        '<span class="vote-cell-label">Say</span>' +
        (pos ? renderStanceChip(dataset, pos.stance, pos.confidence) : '') +
        '<span class="vote-cell-label">Voted</span>' +
        votedHtml +
      '</div>'
    );
  }

  function renderVoteRecordCompact(dataset, issue, record, parties) {
    var tagsHtml = votingRecordTagsHtml(record);
    var cellsHtml = parties.map(function (party) {
      return renderVotePartyCell(dataset, issue, party, record);
    }).join('');
    return (
      '<div class="vote-record-compact">' +
        '<p class="vote-proposition-compact">On the proposition: <em>“' + esc(record.description) + '”</em></p>' +
        (tagsHtml ? '<div class="voting-tags">' + tagsHtml + '</div>' : '') +
        votingRecordPolarityNoteHtml(record) +
        '<div class="vote-party-grid">' + cellsHtml + '</div>' +
        renderVoteTrail(dataset, record, { compact: true }) +
      '</div>'
    );
  }

  function renderVoteIssueCard(dataset, issue, parties) {
    var recordsHtml = issue.voting.records.map(function (record) {
      return renderVoteRecordCompact(dataset, issue, record, parties);
    }).join('');
    return (
      '<article class="vote-issue-card">' +
        renderVoteIssueHeaderHtml(issue) +
        recordsHtml +
      '</article>'
    );
  }

  function wireVoteIssueHeaders(container, dataset) {
    Array.prototype.forEach.call(container.querySelectorAll('.vote-issue-header'), function (btn) {
      btn.addEventListener('click', function () {
        openDrawer(dataset, btn.getAttribute('data-issue'), btn);
      });
    });
  }

  function renderVotesIntro(votingCount, totalShown) {
    return (
      '<div class="votes-intro">' +
        '<p>' + votingCount + ' of the ' + totalShown + ' issues shown have voting records.</p>' +
        '<p>“Say” is the party’s stated position on the issue question; “Voted” is how its current ' +
          'members’ parliamentary votes score against the proposition shown. F voted for · A voted ' +
          'against · M mixed · counts are current members who voted.</p>' +
      '</div>'
    );
  }

  function renderVotes(dataset) {
    var el = document.getElementById('viewVotes');
    if (!dataset) {
      setHtml(el, '<div class="no-data-note"><p><strong>No data.</strong> Run the ingestion pipeline to generate <code>data/dataset.json</code>, then rebuild with <code>node scripts/build.mjs</code>.</p></div>');
      return;
    }
    var parties = orderedParties(dataset);
    var totalShown = state.filteredIssuesFlat.length;
    var filteredIds = state.filteredIssueIds;
    var votingIssueCount = state.filteredIssuesFlat.filter(function (i) { return !!i.voting; }).length;
    var introHtml = renderVotesIntro(votingIssueCount, totalShown);

    if (votingIssueCount === 0) {
      setHtml(el, introHtml + renderEmptyState());
      wireEmptyStateReset(el);
      return;
    }

    var topicsHtml = dataset.topics.map(function (topic) {
      var issues = topic.issues.filter(function (issue) { return filteredIds.has(issue.id) && issue.voting; });
      if (issues.length === 0) return '';
      var cards = issues.map(function (issue) { return renderVoteIssueCard(dataset, issue, parties); }).join('');
      return (
        '<section class="topic-section">' +
          '<h2 class="topic-heading">' + esc(topic.label) +
            '<span class="topic-count tnum">' + issues.length + ' issue' + (issues.length === 1 ? '' : 's') + '</span>' +
          '</h2>' +
          '<div class="votes-card-list">' + cards + '</div>' +
        '</section>'
      );
    }).join('');

    var votingAsOf = state.flatIssues.filter(function (i) { return !!i.voting; }).map(function (i) { return i.voting.as_of; })[0];
    setHtml(el, introHtml + topicsHtml + votingAttributionHtml(votingAsOf));
    wireVoteIssueHeaders(el, dataset);
  }

  /* ------------------------------------------------------------------------
     13. Over time view rendering
     Scope note: like every view, computations run across the parliamentary
     divisions linked to the issues currently shown by the filter row —
     state.filteredIssuesFlat, not the full dataset.
     ------------------------------------------------------------------------ */

  function defaultOverTimeParties(dataset) {
    var ids = dataset.parties.map(function (p) { return p.id; });
    var preferred = ['labor', 'coalition'].filter(function (id) { return ids.indexOf(id) !== -1; });
    if (preferred.length === 2) return preferred;
    return PARTY_ORDER.filter(function (id) { return ids.indexOf(id) !== -1; }).slice(0, 2);
  }

  // Exactly two parties are always selected: clicking a selected chip does
  // nothing (there is no "deselect down to one"); clicking a third swaps
  // out the older of the two current picks, mirroring the venn picker.
  function toggleOverTimePartyPick(partyId, dataset) {
    var arr = state.overTimeParties;
    if (arr.indexOf(partyId) !== -1) {
      state.overTimeHint = 'Keep two parties selected to compare — pick a different party to swap one out.';
      return;
    }
    var removed = arr.shift();
    arr.push(partyId);
    state.overTimeHint = 'Picking a new party swapped in ' + shortNameForParty(dataset, partyId) +
      ' for ' + shortNameForParty(dataset, removed) + '.';
  }

  function renderOverTimePartyPicker(dataset, parties) {
    var pickerHtml = parties.map(function (p) {
      var pressed = state.overTimeParties.indexOf(p.id) !== -1;
      return (
        '<button type="button" class="party-pick-chip" data-party="' + esc(p.id) + '" aria-pressed="' + pressed +
          '" style="--party-color:var(--party-' + esc(p.id) + ')">' +
          '<span class="party-dot" aria-hidden="true"></span>' + esc(p.short) +
        '</button>'
      );
    }).join('');
    return (
      '<div class="party-picker" id="overTimePicker">' + pickerHtml + '</div>' +
      '<p class="party-pick-hint" id="overTimeHint" aria-live="polite">' + esc(state.overTimeHint) + '</p>'
    );
  }

  function wireOverTimePicker(container, dataset) {
    Array.prototype.forEach.call(container.querySelectorAll('#overTimePicker .party-pick-chip'), function (btn) {
      btn.addEventListener('click', function () {
        var partyId = btn.getAttribute('data-party');
        toggleOverTimePartyPick(partyId, dataset);
        renderOverTime(dataset);
        var refocus = document.querySelector('#overTimePicker .party-pick-chip[data-party="' + partyId + '"]');
        if (refocus) refocus.focus();
      });
    });
  }

  // 2a. Pair agreement over time — one line chart, ink-coloured (never a
  // party colour — it represents a pair, not either party on its own).
  function renderPairAgreementChart(dataset, issues, partyA, partyB) {
    var partyById = {};
    dataset.parties.forEach(function (p) { partyById[p.id] = p; });
    var pa = partyById[partyA], pb = partyById[partyB];
    var heading = '<h2 class="topic-heading">How often did ' + esc(pa.short) + ' and ' + esc(pb.short) + ' vote the same way?</h2>';

    var entries = collectDedupedSeriesEntries(issues);
    var byYear = pairAgreementByYear(entries, partyA, partyB);
    if (byYear.length === 0) {
      return heading + '<p class="pair-chart-empty-note">No parliamentary divisions link both parties on the issues currently shown.</p>';
    }

    var minYear = parseInt(byYear[0].year, 10);
    var maxYear = parseInt(byYear[byYear.length - 1].year, 10);
    var byYearMap = {};
    byYear.forEach(function (y) { byYearMap[y.year] = y; });

    var W = 640, H = 220;
    var plotTop = 26, plotBottom = H - 28, plotLeft = 34, plotRight = W - 14;
    var plotWidth = plotRight - plotLeft, plotHeight = plotBottom - plotTop;

    function xForYear(year) {
      return maxYear === minYear ? plotLeft + plotWidth / 2 : plotLeft + ((year - minYear) / (maxYear - minYear)) * plotWidth;
    }
    function yForPct(pct) { return plotBottom - (pct / 100) * plotHeight; }

    var gridSvg = [0, 25, 50, 75, 100].map(function (g) {
      var y = yForPct(g);
      return '<line x1="' + plotLeft + '" y1="' + y.toFixed(1) + '" x2="' + plotRight + '" y2="' + y.toFixed(1) + '" class="pair-chart-gridline"></line>' +
        '<text x="' + (plotLeft - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" class="pair-chart-axis-label tnum">' + g + '%</text>';
    }).join('');

    var axisSvg = computeSparseYearTicks(minYear, maxYear).map(function (year) {
      return '<text x="' + xForYear(year).toFixed(1) + '" y="' + (plotBottom + 16) + '" text-anchor="middle" class="pair-chart-axis-label tnum">' + year + '</text>';
    }).join('');

    var numYears = maxYear - minYear + 1;
    var colWidth = plotWidth / numYears;
    var hitSvg = '';
    for (var year = minYear; year <= maxYear; year++) {
      var colX = plotLeft + (year - minYear) * colWidth;
      var yInfo = byYearMap[String(year)];
      var tip = yInfo
        ? (year + ' · agreed in ' + yInfo.agree + ' of ' + yInfo.n + ' division' + (yInfo.n === 1 ? '' : 's') + ' (' + yInfo.pct + '%)')
        : (year + ' · no qualifying divisions');
      hitSvg += '<rect x="' + colX.toFixed(1) + '" y="' + plotTop + '" width="' + Math.max(colWidth, 1).toFixed(1) + '" height="' + plotHeight +
        '" class="pair-chart-hit" data-tooltip="' + esc(tip) + '"></rect>';
    }

    var drawn = byYear.filter(function (y) { return y.qualifies; });
    var pointsByYear = {};
    drawn.forEach(function (y) {
      pointsByYear[y.year] = { x: xForYear(parseInt(y.year, 10)), y: yForPct(y.pct), pct: y.pct, n: y.n, agree: y.agree, hollow: y.hollow, year: y.year };
    });

    function pathForSegment(seg) {
      return '<path d="' + seg.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ') +
        '" class="pair-chart-line"></path>';
    }
    var lineSvg = '';
    var segment = [];
    drawn.forEach(function (y) {
      var yearNum = parseInt(y.year, 10);
      if (segment.length && yearNum - parseInt(segment[segment.length - 1].year, 10) !== 1) {
        if (segment.length > 1) lineSvg += pathForSegment(segment);
        segment = [];
      }
      segment.push(pointsByYear[y.year]);
    });
    if (segment.length > 1) lineSvg += pathForSegment(segment);

    var pointsSvg = drawn.map(function (y) {
      var p = pointsByYear[y.year];
      var cls = 'pair-chart-point' + (y.hollow ? ' pair-chart-point-hollow' : '');
      var titleText = y.year + ' · agreed in ' + y.agree + ' of ' + y.n + ' division' + (y.n === 1 ? '' : 's') + ' (' + y.pct + '%)';
      return '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="4" class="' + cls + '"><title>' + esc(titleText) + '</title></circle>';
    }).join('');

    // Direct-label only first, last, min and max drawn points (deduped —
    // a point can hold more than one of those roles).
    var labelYears = {};
    if (drawn.length) {
      labelYears[drawn[0].year] = true;
      labelYears[drawn[drawn.length - 1].year] = true;
      var minY = drawn[0], maxY = drawn[0];
      drawn.forEach(function (y) { if (y.pct < minY.pct) minY = y; if (y.pct > maxY.pct) maxY = y; });
      labelYears[minY.year] = true;
      labelYears[maxY.year] = true;
    }
    var labelsSvg = Object.keys(labelYears).map(function (year) {
      var p = pointsByYear[year];
      var above = (p.y - 12) >= plotTop + 8;
      var ly = above ? p.y - 10 : p.y + 16;
      return '<text x="' + p.x.toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="middle" class="pair-chart-point-label tnum">' + p.pct + '%</text>';
    }).join('');

    var svgHtml =
      '<svg class="pair-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">' +
        gridSvg + axisSvg + lineSvg + pointsSvg + labelsSvg + hitSvg +
      '</svg>';
    var tooltipHtml = '<div class="pair-chart-tooltip" id="pairChartTooltip" hidden></div>';

    var finePrint =
      '<p class="pair-chart-fine-print">Yearly share of divisions (linked to the issues shown) where both parties’ ' +
      'members voted the same way. Years with fewer than 3 such divisions are left blank; hollow points have fewer than 6.</p>';

    var tableRows = [];
    for (var yy = minYear; yy <= maxYear; yy++) {
      var info = byYearMap[String(yy)];
      tableRows.push(
        '<tr><td class="tnum">' + yy + '</td><td class="tnum">' + (info ? info.agree : '—') + '</td><td class="tnum">' +
          (info ? info.n : 0) + '</td><td class="tnum">' + (info && info.pct !== null ? info.pct + '%' : '—') + '</td></tr>'
      );
    }
    var tableHtml =
      '<details class="voting-divisions">' +
        '<summary>Year-by-year figures</summary>' +
        '<div class="table-scroll"><table class="divisions-table">' +
          '<thead><tr><th scope="col">Year</th><th scope="col">Agreed</th><th scope="col">Divisions</th><th scope="col">%</th></tr></thead>' +
          '<tbody>' + tableRows.join('') + '</tbody>' +
        '</table></div>' +
      '</details>';

    return (
      heading +
      '<div class="pair-chart-scroll"><div class="pair-chart-wrap">' + svgHtml + tooltipHtml + '</div></div>' +
      finePrint +
      tableHtml
    );
  }

  // Tooltip is a fixed-position div clamped to the viewport, distinct from
  // the <title> fallback on each point (which covers keyboard/touch via the
  // details table twin instead — the chart itself is decorative/aria-hidden).
  function wirePairChartHover(container) {
    var tooltip = container.querySelector('#pairChartTooltip');
    if (!tooltip) return;
    Array.prototype.forEach.call(container.querySelectorAll('.pair-chart-hit'), function (rect) {
      function show(evt) {
        tooltip.textContent = rect.getAttribute('data-tooltip');
        tooltip.hidden = false;
        var tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
        var x = evt.clientX + 14;
        var y = evt.clientY - th - 10;
        if (x + tw > window.innerWidth - 8) x = window.innerWidth - tw - 8;
        if (x < 8) x = 8;
        if (y < 8) y = evt.clientY + 14;
        if (y + th > window.innerHeight - 8) y = window.innerHeight - th - 8;
        tooltip.style.left = x + 'px';
        tooltip.style.top = y + 'px';
      }
      function hide() { tooltip.hidden = true; }
      rect.addEventListener('mouseenter', show);
      rect.addEventListener('mousemove', show);
      rect.addEventListener('mouseleave', hide);
    });
  }

  // 2b. Mechanically detected position shifts, grouped by party. Strictly
  // neutral wording — the sentence template is fixed, no commentary.
  function renderPositionShifts(dataset, issues) {
    var heading = '<h2 class="topic-heading">Where a party’s votes shifted over time</h2>';
    var shifts = detectPositionShifts(issues);
    if (shifts.length === 0) {
      return heading + '<p class="shifts-empty-note">No mechanical shifts detected among the issues currently shown.</p>';
    }

    var issueById = {};
    issues.forEach(function (i) { issueById[i.id] = i; });
    var partyById = {};
    dataset.parties.forEach(function (p) { partyById[p.id] = p; });

    var byParty = {};
    PARTY_ORDER.forEach(function (id) { byParty[id] = []; });
    shifts.forEach(function (s) { if (byParty[s.party]) byParty[s.party].push(s); });

    var groupsHtml = PARTY_ORDER.map(function (partyId) {
      var list = byParty[partyId];
      if (!list.length) return '';
      var party = partyById[partyId];
      var itemsHtml = list.map(function (s) {
        var linkButtons = s.issueIds.map(function (issueId) {
          var issue = issueById[issueId];
          if (!issue) return '';
          return '<button type="button" class="shift-issue-btn" data-issue="' + esc(issueId) + '">View issue: ' + esc(issue.label) + ' →</button>';
        }).join('');
        var sentence = esc(party.short) + ' on “' + esc(s.policyName) + '”: mostly ' + s.firstDir +
          ' the proposition in early divisions (' + esc(s.firstYear) + ') → mostly ' + s.lastDir +
          ' in recent ones (' + esc(s.lastYear) + '), across ' + s.n + ' qualifying divisions.';
        return (
          '<li class="shift-card" style="--party-color:var(--party-' + esc(partyId) + ')">' +
            '<p class="shift-sentence">' + sentence + '</p>' +
            (linkButtons ? '<div class="shift-links">' + linkButtons + '</div>' : '') +
          '</li>'
        );
      }).join('');
      return (
        '<div class="shift-party-group">' +
          '<h3 class="shift-party-heading" style="--party-color:var(--party-' + esc(partyId) + ')">' + esc(party.short) + '</h3>' +
          '<ul class="shift-card-list">' + itemsHtml + '</ul>' +
        '</div>'
      );
    }).join('');

    var finePrint =
      '<p class="shifts-fine-print">A shift is flagged when a party’s members voted mostly one way in the earliest ' +
      'divisions of a policy and mostly the other way in the most recent ones (at least six divisions where at ' +
      'least two of the party’s members voted, with two consecutive same-direction divisions at each end). This ' +
      'is a mechanical rule, not a judgement — open the issue to see the full trail.</p>';

    return heading + '<div class="shifts-list">' + groupsHtml + '</div>' + finePrint;
  }

  function wireShiftIssueButtons(container, dataset) {
    Array.prototype.forEach.call(container.querySelectorAll('.shift-issue-btn'), function (btn) {
      btn.addEventListener('click', function () {
        openDrawer(dataset, btn.getAttribute('data-issue'), btn);
      });
    });
  }

  function renderOverTime(dataset) {
    var el = document.getElementById('viewTime');
    if (!dataset) {
      setHtml(el, '<div class="no-data-note"><p><strong>No data.</strong> Run the ingestion pipeline to generate <code>data/dataset.json</code>, then rebuild with <code>node scripts/build.mjs</code>.</p></div>');
      return;
    }
    var parties = orderedParties(dataset);
    var issues = state.filteredIssuesFlat;
    var votingIssueCount = issues.filter(function (i) { return !!i.voting; }).length;
    var pickerHtml = renderOverTimePartyPicker(dataset, parties);

    if (votingIssueCount === 0) {
      setHtml(el, pickerHtml + renderEmptyState());
      wireOverTimePicker(el, dataset);
      wireEmptyStateReset(el);
      return;
    }

    var partyA = state.overTimeParties[0], partyB = state.overTimeParties[1];
    var chartHtml = renderPairAgreementChart(dataset, issues, partyA, partyB);
    var shiftsHtml = renderPositionShifts(dataset, issues);
    var votingAsOf = state.flatIssues.filter(function (i) { return !!i.voting; }).map(function (i) { return i.voting.as_of; })[0];

    setHtml(el,
      pickerHtml +
      '<section class="pair-agreement-section">' + chartHtml + '</section>' +
      '<section class="shifts-section">' + shiftsHtml + '</section>' +
      votingAttributionHtml(votingAsOf)
    );

    wireOverTimePicker(el, dataset);
    wirePairChartHover(el);
    wireShiftIssueButtons(el, dataset);
  }

  /* ------------------------------------------------------------------------
     14. Top-level render orchestration + init
     ------------------------------------------------------------------------ */

  function renderActiveView() {
    if (state.view === 'matrix') renderMatrix(state.dataset);
    else if (state.view === 'overlap') renderOverlap(state.dataset);
    else if (state.view === 'votes') renderVotes(state.dataset);
    else renderOverTime(state.dataset);
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
    state.overTimeParties = dataset ? defaultOverTimeParties(dataset) : [];
    state.overTimeHint = '';
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

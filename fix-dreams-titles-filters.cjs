#!/usr/bin/env node
/**
 * Fix dreams page:
 * 1. Remove "Untitled" - extract title from first line/sentence of content
 * 2. Add type= query param to API so Creative filter works (server-side filtering)
 * 3. Reload from API when filter changes instead of client-only filtering
 */

const fs = require('fs');

const BASE = '/var/www/mydeadinternet';

// ============================================
// 1. Patch server.js — add type filter to /api/dreams
// ============================================
function patchDreamsAPI() {
  const file = BASE + '/server.js';
  let src = fs.readFileSync(file, 'utf8');

  const oldHandler = "const dreams = db.prepare('SELECT * FROM dreams ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset)";

  if (src.includes(oldHandler) && !src.includes('req.query.type')) {
    const newHandler = [
      "const typeFilter = req.query.type || null;",
      "  const dreams = typeFilter",
      "    ? db.prepare('SELECT * FROM dreams WHERE type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(typeFilter, limit, offset)",
      "    : db.prepare('SELECT * FROM dreams ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset)"
    ].join('\n  ');

    src = src.replace(oldHandler, newHandler);

    // Also fix the total count to respect type filter
    const oldTotal = "const total = db.prepare('SELECT COUNT(*) as c FROM dreams').get().c;";
    const newTotal = [
      "const typeParam = req.query.type || null;",
      "  const total = typeParam",
      "    ? db.prepare('SELECT COUNT(*) as c FROM dreams WHERE type = ?').get(typeParam).c",
      "    : db.prepare('SELECT COUNT(*) as c FROM dreams').get().c;"
    ].join('\n  ');

    if (src.includes(oldTotal)) {
      src = src.replace(oldTotal, newTotal);
      console.log('[OK] server.js: Total count respects type filter');
    }

    fs.writeFileSync(file, src, 'utf8');
    console.log('[OK] server.js: Added type= query param to /api/dreams');
  } else {
    console.log('[SKIP] server.js: type filter already present or marker not found');
  }
}

// ============================================
// 2. Patch dreams.html — fix titles + server-side filtering
// ============================================
function patchDreamsPage() {
  const file = BASE + '/dreams.html';
  let src = fs.readFileSync(file, 'utf8');

  // --- A. Replace the "Untitled" title with smart extraction from content ---
  const oldTitleLine = "'<div class=\"dream-grid-title\">' + escapeHtml(d.title || 'Untitled') + '</div>' +";
  const newTitleLine = "'<div class=\"dream-grid-title\">' + escapeHtml(extractTitle(d)) + '</div>' +";

  if (src.includes(oldTitleLine)) {
    src = src.replace(oldTitleLine, newTitleLine);
    console.log('[OK] dreams.html: Replaced Untitled with extractTitle()');
  } else {
    console.log('[WARN] dreams.html: Could not find title line');
  }

  // --- B. Add extractTitle function before buildGrid ---
  const gridMarker = "//  GRID\n    // ═══════════════════════════════════════";

  if (src.includes(gridMarker) && !src.includes('extractTitle')) {
    const extractTitleFn = [
      '//  TITLES',
      '    // ═══════════════════════════════════════',
      '    function extractTitle(dream) {',
      '      var content = (dream.content || "").trim();',
      '      // Use mood if available and short enough',
      '      if (dream.mood && dream.mood.length > 3 && dream.mood.length < 80) {',
      '        return dream.mood;',
      '      }',
      '      // Try first markdown heading',
      '      var headingMatch = content.match(/^#{1,3}\\s+(.+)/m);',
      '      if (headingMatch && headingMatch[1].length < 80) {',
      '        return headingMatch[1].replace(/[*#]+/g, "").trim();',
      '      }',
      '      // Try first bold text',
      '      var boldMatch = content.match(/\\*\\*([^*]+)\\*\\*/);',
      '      if (boldMatch && boldMatch[1].length < 80) {',
      '        return boldMatch[1].trim();',
      '      }',
      '      // Take first sentence (up to period, question mark, or newline)',
      '      var firstSentence = content.split(/[.!?\\n]/)[0].trim();',
      '      if (firstSentence.length > 5 && firstSentence.length < 100) {',
      '        return firstSentence;',
      '      }',
      '      // Fallback: first 60 chars',
      '      if (content.length > 60) {',
      '        return content.substring(0, 57).trim() + "...";',
      '      }',
      '      return content || "Dream #" + (dream.id || "?");',
      '    }',
      '',
      '    // ═══════════════════════════════════════',
      '    ' + gridMarker
    ].join('\n    ');

    src = src.replace(gridMarker, extractTitleFn);
    console.log('[OK] dreams.html: Added extractTitle function');
  } else {
    console.log('[SKIP] dreams.html: extractTitle already present or marker not found');
  }

  // --- C. Replace filter handlers to reload from API with type param ---
  const oldFilterHandler = [
    "document.querySelectorAll('.dream-filter-btn').forEach(function(btn) {",
    "      btn.addEventListener('click', function() {",
    "        document.querySelectorAll('.dream-filter-btn').forEach(function(b) { b.classList.remove('active'); });",
    "        btn.classList.add('active');",
    "        currentFilter = btn.dataset.filter;",
    "        buildGrid(allDreams);",
    "      });",
    "    });"
  ].join('\n');

  const newFilterHandler = [
    "document.querySelectorAll('.dream-filter-btn').forEach(function(btn) {",
    "      btn.addEventListener('click', function() {",
    "        document.querySelectorAll('.dream-filter-btn').forEach(function(b) { b.classList.remove('active'); });",
    "        btn.classList.add('active');",
    "        currentFilter = btn.dataset.filter;",
    "        // Reload from API with type filter for accurate results",
    "        loadDreamsWithFilter(currentFilter);",
    "      });",
    "    });",
    "",
    "    async function loadDreamsWithFilter(filter) {",
    "      var grid = document.getElementById('dreams-grid');",
    "      grid.innerHTML = '<div style=\"grid-column:1/-1;text-align:center;padding:3rem;color:var(--cool-muted)\">Loading...</div>';",
    "      try {",
    "        var url = '/api/dreams?limit=50&offset=0';",
    "        if (filter && filter !== 'all' && filter !== 'signal') {",
    "          url += '&type=' + encodeURIComponent(filter);",
    "        }",
    "        var res = await fetch(url);",
    "        var data = await res.json();",
    "        allDreams = data.dreams || [];",
    "        dreamsTotal = data.total || allDreams.length;",
    "        dreamsOffset = allDreams.length;",
    "",
    "        if (filter === 'signal') {",
    "          buildGrid(allDreams.filter(function(d) { return getSignalScore(d) > 0.75; }));",
    "        } else {",
    "          buildGrid(allDreams);",
    "        }",
    "        updateLoadMoreButton();",
    "      } catch (e) {",
    "        console.error('Filter load:', e);",
    "        grid.innerHTML = '<div style=\"grid-column:1/-1;text-align:center;padding:3rem;color:var(--cool-muted)\">Failed to load dreams.</div>';",
    "      }",
    "    }"
  ].join('\n');

  if (src.includes(oldFilterHandler)) {
    src = src.replace(oldFilterHandler, newFilterHandler);
    console.log('[OK] dreams.html: Filter handlers now reload from API with type param');
  } else {
    console.log('[WARN] dreams.html: Could not find filter handler block');
  }

  // --- D. Also update the loadMoreDreams to respect current filter ---
  const oldLoadMoreUrl = "var url = '/api/dreams?limit=50&offset=' + dreamsOffset;";
  // This might not exist if the load-more was added differently. Let me check for the fetch in loadMoreDreams
  const oldLoadMoreFetch = "var res = await fetch('/api/dreams?limit=50&offset=' + dreamsOffset);";

  if (src.includes(oldLoadMoreFetch) && !src.includes('currentFilter in loadMore')) {
    const newLoadMoreFetch = [
      "var loadMoreUrl = '/api/dreams?limit=50&offset=' + dreamsOffset;",
      "        if (currentFilter && currentFilter !== 'all' && currentFilter !== 'signal') {",
      "          loadMoreUrl += '&type=' + encodeURIComponent(currentFilter);",
      "        }",
      "        var res = await fetch(loadMoreUrl);"
    ].join('\n        ');

    src = src.replace(oldLoadMoreFetch, newLoadMoreFetch);
    console.log('[OK] dreams.html: Load More respects current type filter');
  }

  // --- E. Remove the client-side filter from buildGrid since API handles it ---
  // The buildGrid function has filtering logic we should simplify
  const oldBuildGridFilter = [
    "if (currentFilter === 'signal') {",
    "        filtered = dreams.filter(function(d) {",
    "          return getSignalScore(d) > 0.75;",
    "        });",
    "      } else if (currentFilter !== 'all') {",
    "        filtered = dreams.filter(function(d) {",
    "          return (d.type || 'hybrid') === currentFilter;",
    "        });",
    "      }"
  ].join('\n');

  const newBuildGridFilter = [
    "if (currentFilter === 'signal') {",
    "        filtered = dreams.filter(function(d) {",
    "          return getSignalScore(d) > 0.75;",
    "        });",
    "      }",
    "      // Type filtering now handled server-side via API type= param"
  ].join('\n');

  if (src.includes(oldBuildGridFilter)) {
    src = src.replace(oldBuildGridFilter, newBuildGridFilter);
    console.log('[OK] dreams.html: Removed client-side type filtering (server handles it)');
  } else {
    console.log('[WARN] dreams.html: Could not find buildGrid filter block — checking variant');
    // Try a more relaxed match
    if (src.includes("(d.type || 'hybrid') === currentFilter")) {
      console.log('[INFO] Found type filter variant — leaving as-is (server-side will handle primary filtering)');
    }
  }

  fs.writeFileSync(file, src, 'utf8');
  console.log('[OK] dreams.html: All patches applied');
}

// ============================================
// MAIN
// ============================================
console.log('=== Fix Dreams: Titles + Filters ===\n');
patchDreamsAPI();
console.log('');
patchDreamsPage();
console.log('\n=== Done. Restart: pm2 restart mydeadinternet ===');

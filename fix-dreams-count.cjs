#!/usr/bin/env node
/**
 * Fix dreams page: wrong count + add pagination
 *
 * Bug: dreams.html shows allDreams.length (max 50) instead of data.total (412)
 * Fix: Use data.total for the count display, add Load More pagination
 */

const fs = require('fs');
const file = '/var/www/mydeadinternet/dreams.html';
let src = fs.readFileSync(file, 'utf8');

// ============================================
// Fix 1: Use data.total for total count
// ============================================
const oldCount = "document.getElementById('total-dreams').textContent = allDreams.length;";
const newCount = "document.getElementById('total-dreams').textContent = data.total || allDreams.length;";

if (src.includes(oldCount)) {
  src = src.replace(oldCount, newCount);
  console.log('[OK] Fixed total dreams count to use data.total');
} else {
  console.log('[SKIP] total-dreams line already patched or not found');
}

// ============================================
// Fix 2: Add pagination variables before loadDreams
// ============================================
const loadDreamsMarker = "async function loadDreams() {";

if (src.includes(loadDreamsMarker) && !src.includes('dreamsTotal')) {
  const paginationVars = [
    'var dreamsTotal = 0;',
    '    var dreamsOffset = 0;',
    '    var isLoadingMore = false;',
    '',
    '    ' + loadDreamsMarker
  ].join('\n');

  src = src.replace(loadDreamsMarker, paginationVars);
  console.log('[OK] Added pagination state variables');
} else {
  console.log('[SKIP] Pagination vars already present or marker not found');
}

// ============================================
// Fix 3: Store total and offset after loading
// ============================================
const afterBuildGrid = "buildGrid(allDreams);\n      } catch (e) { console.error('Dreams:', e); }";

if (src.includes(afterBuildGrid) && !src.includes('dreamsOffset = allDreams.length')) {
  const replacement = [
    "dreamsTotal = data.total || allDreams.length;",
    "        dreamsOffset = allDreams.length;",
    "",
    "        buildGrid(allDreams);",
    "        updateLoadMoreButton();",
    "      } catch (e) { console.error('Dreams:', e); }"
  ].join('\n');

  src = src.replace(afterBuildGrid, replacement);
  console.log('[OK] Added offset tracking and load-more button init');
} else {
  console.log('[SKIP] buildGrid block already patched or not found');
}

// ============================================
// Fix 4: Add loadMore + updateButton functions before the filter handlers
// ============================================
const filterMarker = "// ═══════════════════════════════════════\n    //  GRID";

if (src.includes(filterMarker) && !src.includes('loadMoreDreams')) {
  const loadMoreFunctions = [
    '// ═══════════════════════════════════════',
    '    //  PAGINATION',
    '    // ═══════════════════════════════════════',
    '    async function loadMoreDreams() {',
    '      if (isLoadingMore || dreamsOffset >= dreamsTotal) return;',
    '      isLoadingMore = true;',
    "      var btn = document.getElementById('load-more-btn');",
    "      if (btn) btn.textContent = 'Loading...';",
    '      try {',
    "        var res = await fetch('/api/dreams?limit=50&offset=' + dreamsOffset);",
    '        var data = await res.json();',
    '        var newDreams = data.dreams || [];',
    '        allDreams = allDreams.concat(newDreams);',
    '        dreamsOffset += newDreams.length;',
    '',
    "        document.getElementById('dream-with-images').textContent = allDreams.filter(function(d) { return d.image_url; }).length;",
    '',
    "        var activeBtn = document.querySelector('.dream-type-btn.active');",
    "        var activeFilter = activeBtn ? activeBtn.getAttribute('data-type') : 'all';",
    "        if (activeFilter === 'all') {",
    '          buildGrid(allDreams);',
    "        } else if (activeFilter === 'signal') {",
    '          buildGrid(allDreams.filter(function(d) { return getSignalScore(d) > 0.75; }));',
    '        } else {',
    '          buildGrid(allDreams.filter(function(d) { return d.type === activeFilter; }));',
    '        }',
    '        updateLoadMoreButton();',
    "      } catch (e) { console.error('Load more:', e); }",
    '      isLoadingMore = false;',
    "      if (btn) btn.textContent = 'Load More Dreams';",
    '    }',
    '',
    '    function updateLoadMoreButton() {',
    "      var existing = document.getElementById('load-more-wrap');",
    '      if (existing) existing.remove();',
    '      if (dreamsOffset < dreamsTotal) {',
    "        var grid = document.getElementById('dreams-grid');",
    "        var wrap = document.createElement('div');",
    "        wrap.id = 'load-more-wrap';",
    "        wrap.style.cssText = 'text-align:center;padding:32px 0;';",
    "        var btnHtml = '<button id=\"load-more-btn\" onclick=\"loadMoreDreams()\" style=\"padding:12px 32px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#e0e0e0;font-family:inherit;font-size:0.9rem;cursor:pointer;transition:all 0.2s;\">Load More Dreams</button>';",
    "        var countHtml = '<div style=\"margin-top:8px;font-size:0.75rem;color:#888;\">Showing ' + dreamsOffset + ' of ' + dreamsTotal + '</div>';",
    '        wrap.innerHTML = btnHtml + countHtml;',
    '        grid.parentNode.insertBefore(wrap, grid.nextSibling);',
    '      }',
    '    }',
    '',
    '    ' + filterMarker
  ].join('\n');

  src = src.replace(filterMarker, loadMoreFunctions);
  console.log('[OK] Added loadMoreDreams and updateLoadMoreButton functions');
} else {
  console.log('[SKIP] Load more functions already present or GRID marker not found');
}

// ============================================
// Fix 5: Update fetch URL to include offset=0
// ============================================
const oldFetch = "fetch('/api/dreams?limit=50')";
if (src.includes(oldFetch)) {
  src = src.replace(oldFetch, "fetch('/api/dreams?limit=50&offset=0')");
  console.log('[OK] Updated initial fetch to include offset=0');
}

fs.writeFileSync(file, src, 'utf8');
console.log('\n[DONE] dreams.html patched — restart server to apply');

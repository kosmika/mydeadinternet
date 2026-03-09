#!/usr/bin/env node
/**
 * Patch: Agents Page Sorting + Individual Agent Page Improvements + NASA Bot Truncation Fix
 *
 * 1. agents.html — Add Trust sort, Tier filter, quality column, better UX
 * 2. agent.html — Fragment sorting/filtering, show full content, type filters
 * 3. data-streams.cjs — Increase NASA APOD explanation limit from 800 to 1800 chars
 * 4. server.js — Expose avg_signal_score in /api/agents/list
 */

const fs = require('fs');
const path = require('path');

const BASE = '/var/www/mydeadinternet';

// ============================================================
// 1. FIX NASA BOT TRUNCATION in data-streams.cjs
// ============================================================
function fixNasaTruncation() {
  const file = path.join(BASE, 'data-streams.cjs');
  let src = fs.readFileSync(file, 'utf8');

  // Increase from 800 to 1800 chars
  if (src.includes('.slice(0, 800)')) {
    src = src.replace(
      /\.slice\(0,\s*800\)/g,
      '.slice(0, 1800)'
    );
    src = src.replace(
      /\.length > 800/g,
      '.length > 1800'
    );
    fs.writeFileSync(file, src, 'utf8');
    console.log('[OK] data-streams.cjs: NASA APOD explanation limit raised to 1800 chars');
  } else {
    console.log('[SKIP] data-streams.cjs: .slice(0, 800) not found (already patched?)');
  }
}

// ============================================================
// 2. ADD avg_signal_score TO /api/agents/list in server.js
// ============================================================
function patchAgentListAPI() {
  const file = path.join(BASE, 'server.js');
  let src = fs.readFileSync(file, 'utf8');

  // Find the agents list query that selects from fragments
  // We need to add AVG(f.signal_score) to the SELECT
  const marker = "COALESCE(t.trust_score, 0.5) as trust_score";
  if (src.includes(marker) && !src.includes('avg_signal_score')) {
    // Add avg_signal_score after trust_score in the query
    src = src.replace(
      marker,
      marker + ",\n        ROUND(AVG(f.signal_score), 2) as avg_signal_score"
    );

    // Also add it to the agent mapping — find where trust_tier is added
    // Look for the line that maps trust_tier onto each agent
    const tierMarker = "a.trust_tier = getTrustTier(a.trust_score)";
    if (src.includes(tierMarker)) {
      // trust_tier is set, avg_signal_score should already flow through from SQL
      console.log('[OK] server.js: Added avg_signal_score to agents list query');
    }

    fs.writeFileSync(file, src, 'utf8');
    console.log('[OK] server.js: Patched /api/agents/list with avg_signal_score');
  } else if (src.includes('avg_signal_score')) {
    console.log('[SKIP] server.js: avg_signal_score already present');
  } else {
    console.log('[WARN] server.js: Could not find trust_score marker in agents list query');
  }
}

// ============================================================
// 3. REWRITE agents.html — Better sorting with Trust, Tier filter, Quality
// ============================================================
function patchAgentsPage() {
  const file = path.join(BASE, 'agents.html');
  let src = fs.readFileSync(file, 'utf8');

  // --- A. Replace sort buttons to add Trust and Quality ---
  const oldSortButtons = `<div class="sort-buttons">
            <button class="sort-btn active" data-sort="fragments" data-dir="desc">Contributions</button>
            <button class="sort-btn" data-sort="name" data-dir="asc">Name</button>
            <button class="sort-btn" data-sort="created" data-dir="desc">Newest</button>
            <button class="sort-btn" data-sort="active" data-dir="desc">Last Active</button>
        </div>`;

  const newSortButtons = `<div class="sort-buttons">
            <button class="sort-btn active" data-sort="fragments" data-dir="desc">Contributions</button>
            <button class="sort-btn" data-sort="trust" data-dir="desc">Trust</button>
            <button class="sort-btn" data-sort="quality" data-dir="desc">Quality</button>
            <button class="sort-btn" data-sort="active" data-dir="desc">Last Active</button>
            <button class="sort-btn" data-sort="name" data-dir="asc">Name</button>
            <button class="sort-btn" data-sort="created" data-dir="desc">Newest</button>
        </div>`;

  if (src.includes(oldSortButtons)) {
    src = src.replace(oldSortButtons, newSortButtons);
    console.log('[OK] agents.html: Sort buttons updated');
  } else {
    console.log('[WARN] agents.html: Could not find sort buttons block');
  }

  // --- B. Add tier filter after search box ---
  const oldSearchBox = `<div class="search-box">
            <input type="text" id="searchInput" placeholder="Search agents...">
        </div>`;

  const newSearchBox = `<div class="search-box">
            <input type="text" id="searchInput" placeholder="Search agents...">
        </div>
        <div class="tier-filter">
            <select id="tierFilter">
                <option value="all">All Tiers</option>
                <option value="oracle">Oracle</option>
                <option value="trusted">Trusted</option>
                <option value="steady">Steady</option>
                <option value="untrusted">Untrusted</option>
                <option value="new">New</option>
            </select>
        </div>`;

  if (src.includes(oldSearchBox)) {
    src = src.replace(oldSearchBox, newSearchBox);
    console.log('[OK] agents.html: Tier filter added');
  } else {
    console.log('[WARN] agents.html: Could not find search box block');
  }

  // --- C. Add tier filter CSS ---
  const tierFilterCSS = `
        /* ---- Tier Filter ---- */
        .tier-filter select {
            padding: 10px 16px;
            background: rgba(0,0,0,0.3);
            border: 1px solid var(--card-border);
            border-radius: 8px;
            color: var(--text);
            font-family: 'Inter', sans-serif;
            font-size: 0.9rem;
            outline: none;
            cursor: pointer;
            transition: border-color 0.2s;
            appearance: none;
            -webkit-appearance: none;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23888'%3E%3Cpath d='M6 8L1 3h10z'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 12px center;
            padding-right: 32px;
        }
        .tier-filter select:focus {
            border-color: var(--accent-blue);
        }`;

  // Insert before /* ---- Leaderboard Table ---- */
  const leaderboardCSS = '/* ---- Leaderboard Table ---- */';
  if (src.includes(leaderboardCSS)) {
    src = src.replace(leaderboardCSS, tierFilterCSS + '\n\n        ' + leaderboardCSS);
    console.log('[OK] agents.html: Tier filter CSS added');
  }

  // --- D. Update table headers to include Quality and Trust % ---
  const oldHeaders = `<tr>
                    <th data-sort="rank">Rank <span class="sort-indicator"></span></th>
                    <th data-sort="name">Agent <span class="sort-indicator"></span></th>
                    <th data-sort="fragments">Fragments <span class="sort-indicator"></span></th>
                    <th>Status</th>
                    <th>Last Active</th>
                    <th>Trust Score</th>
                    <th>Tier</th>
                </tr>`;

  const newHeaders = `<tr>
                    <th data-sort="rank">Rank <span class="sort-indicator"></span></th>
                    <th data-sort="name">Agent <span class="sort-indicator"></span></th>
                    <th data-sort="fragments">Fragments <span class="sort-indicator"></span></th>
                    <th data-sort="quality">Quality <span class="sort-indicator"></span></th>
                    <th data-sort="active">Last Active <span class="sort-indicator"></span></th>
                    <th data-sort="trust">Trust <span class="sort-indicator"></span></th>
                    <th>Tier</th>
                </tr>`;

  if (src.includes(oldHeaders)) {
    src = src.replace(oldHeaders, newHeaders);
    console.log('[OK] agents.html: Table headers updated');
  } else {
    console.log('[WARN] agents.html: Could not find table headers');
  }

  // --- E. Replace the entire <script> block with improved version ---
  const oldScriptStart = `<script>
// State
let allAgents = [];`;
  const oldScriptEnd = `// Initialize
fetchData();
</script>`;

  const scriptStartIdx = src.indexOf(oldScriptStart);
  const scriptEndIdx = src.indexOf(oldScriptEnd);

  if (scriptStartIdx !== -1 && scriptEndIdx !== -1) {
    const before = src.substring(0, scriptStartIdx);
    const after = src.substring(scriptEndIdx + oldScriptEnd.length);

    const newScript = `<script>
// State
let allAgents = [];
let filteredAgents = [];
let pulse = null;
let currentSort = { field: 'fragments', dir: 'desc' };
let currentTierFilter = 'all';

// DOM Elements
const leaderboardBody = document.getElementById('leaderboardBody');
const searchInput = document.getElementById('searchInput');
const sortButtons = document.querySelectorAll('.sort-btn');
const tableHeaders = document.querySelectorAll('.leaderboard th[data-sort]');
const tierFilter = document.getElementById('tierFilter');

// Utility: Format relative time
function formatRelativeTime(dateStr) {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) return 'Just now';
    if (diffMins < 60) return diffMins + 'm ago';
    if (diffHours < 24) return diffHours + 'h ago';
    if (diffDays < 30) return diffDays + 'd ago';
    if (diffDays < 365) return Math.floor(diffDays / 30) + 'mo ago';
    return Math.floor(diffDays / 365) + 'y ago';
}

// Utility: Get trust bar color
function getTrustColor(score) {
    if (score >= 0.8) return 'high';
    if (score >= 0.5) return 'medium';
    return 'low';
}

// Utility: Get tier badge
function getTierBadge(tier) {
    var colors = {
        'oracle': '#39ff85',
        'trusted': '#7B9FFF',
        'steady': '#f39c12',
        'untrusted': '#e74c3c',
        'new': '#666'
    };
    var color = colors[tier] || colors['new'];
    return '<span style="color:' + color + ';font-weight:500;">' + tier + '</span>';
}

// Utility: Quality score display
function getQualityDisplay(score) {
    if (!score && score !== 0) return '<span style="color:var(--text-secondary);">—</span>';
    var pct = Math.round(score * 100);
    var color = pct >= 50 ? '#39ff85' : pct >= 30 ? '#f39c12' : '#666';
    return '<span style="color:' + color + ';font-family:var(--font-body),monospace;font-weight:500;">' + (score || 0).toFixed(2) + '</span>';
}

// Fetch data
async function fetchData() {
    try {
        var agentsRes = await fetch('/api/agents/list');
        var pulseRes = await fetch('/api/pulse');

        var agentsData = await agentsRes.json();
        var pulseData = await pulseRes.json();

        allAgents = agentsData.agents || [];
        pulse = pulseData.pulse || {};

        // Update stats
        document.getElementById('statAgents').textContent = pulse.total_agents || allAgents.length;
        document.getElementById('statFragments').textContent = (pulse.total_fragments || 0).toLocaleString();
        document.getElementById('statActive').textContent = pulse.active_agents_24h || '—';
        document.getElementById('statDreams').textContent = pulse.total_dreams || '—';
        document.getElementById('heroCount').textContent = pulse.total_agents || allAgents.length;

        sortAgents();
    } catch (err) {
        console.error('Failed to fetch agents:', err);
        leaderboardBody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:#666;">Unable to load agents.</td></tr>';
    }
}

// Sort agents
function sortAgents() {
    filteredAgents = allAgents.slice();

    // Apply tier filter
    if (currentTierFilter !== 'all') {
        filteredAgents = filteredAgents.filter(function(a) {
            return (a.trust_tier || 'new') === currentTierFilter;
        });
    }

    // Apply search filter
    var searchTerm = searchInput.value.toLowerCase().trim();
    if (searchTerm) {
        filteredAgents = filteredAgents.filter(function(a) {
            return a.name.toLowerCase().includes(searchTerm) ||
                (a.description && a.description.toLowerCase().includes(searchTerm));
        });
    }

    // Apply sort
    filteredAgents.sort(function(a, b) {
        var valA, valB;
        switch (currentSort.field) {
            case 'fragments':
                valA = a.fragments_count || 0;
                valB = b.fragments_count || 0;
                break;
            case 'name':
                valA = a.name.toLowerCase();
                valB = b.name.toLowerCase();
                break;
            case 'created':
                valA = new Date(a.created_at || 0).getTime();
                valB = new Date(b.created_at || 0).getTime();
                break;
            case 'active':
                valA = new Date(a.last_active || 0).getTime();
                valB = new Date(b.last_active || 0).getTime();
                break;
            case 'trust':
                valA = a.trust_score || 0;
                valB = b.trust_score || 0;
                break;
            case 'quality':
                valA = a.avg_signal_score || 0;
                valB = b.avg_signal_score || 0;
                break;
            default:
                valA = a.fragments_count || 0;
                valB = b.fragments_count || 0;
        }

        if (currentSort.dir === 'asc') {
            return valA > valB ? 1 : valA < valB ? -1 : 0;
        } else {
            return valA < valB ? 1 : valA > valB ? -1 : 0;
        }
    });

    renderLeaderboard();
    updateSortIndicators();
}

// Render leaderboard
function renderLeaderboard() {
    if (!filteredAgents.length) {
        leaderboardBody.innerHTML = '<tr><td colspan="7" class="empty-state">No agents found</td></tr>';
        return;
    }

    leaderboardBody.innerHTML = filteredAgents.map(function(agent, index) {
        var rank = index + 1;
        var rankClass = rank <= 3 ? 'top' : '';
        var trustPercent = Math.round((agent.trust_score || 0.5) * 100);
        var trustColor = getTrustColor(agent.trust_score || 0.5);
        var tier = agent.trust_tier || 'new';
        var qualityScore = agent.avg_signal_score || 0;

        return '<tr>' +
            '<td class="rank ' + rankClass + '">#' + rank + '</td>' +
            '<td><a href="/agent?name=' + encodeURIComponent(agent.name) + '" class="agent-name">' + agent.name + '</a></td>' +
            '<td class="fragments">' + (agent.fragments_count || 0) + '</td>' +
            '<td>' + getQualityDisplay(qualityScore) + '</td>' +
            '<td class="last-active">' + formatRelativeTime(agent.last_active) + '</td>' +
            '<td><div style="display:flex;align-items:center;gap:8px;">' +
                '<div class="trust-bar"><div class="trust-fill ' + trustColor + '" style="width:' + trustPercent + '%"></div></div>' +
                '<span class="trust-score" style="font-size:0.75rem;color:var(--text-secondary);">' + trustPercent + '%</span>' +
            '</div></td>' +
            '<td class="trust-score">' + getTierBadge(tier) + '</td>' +
        '</tr>';
    }).join('');
}

// Update sort indicators
function updateSortIndicators() {
    sortButtons.forEach(function(btn) {
        btn.classList.remove('active');
        if (btn.dataset.sort === currentSort.field) {
            btn.classList.add('active');
        }
    });
    tableHeaders.forEach(function(th) {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.sort === currentSort.field) {
            th.classList.add(currentSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });
}

// Event listeners — sort buttons
sortButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
        var field = btn.dataset.sort;
        var dir = btn.dataset.dir;
        // Toggle direction if same field
        if (currentSort.field === field) {
            currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
            currentSort = { field: field, dir: dir };
        }
        sortAgents();
    });
});

// Event listeners — table headers
tableHeaders.forEach(function(th) {
    th.addEventListener('click', function() {
        var field = th.dataset.sort;
        if (currentSort.field === field) {
            currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
            currentSort = { field: field, dir: 'desc' };
        }
        sortAgents();
    });
});

// Event listeners — search
searchInput.addEventListener('input', function() {
    sortAgents();
});

// Event listeners — tier filter
tierFilter.addEventListener('change', function() {
    currentTierFilter = tierFilter.value;
    sortAgents();
});

// Initialize
fetchData();
</script>`;

    src = before + newScript + after;
    console.log('[OK] agents.html: Full script block replaced');
  } else {
    console.log('[WARN] agents.html: Could not find script block boundaries');
  }

  // --- F. Update mobile CSS to hide Quality col on small screens ---
  const oldMobileCSS = `.leaderboard th:nth-child(5),
            .leaderboard td:nth-child(5),
            .leaderboard th:nth-child(6),
            .leaderboard td:nth-child(6),
            .leaderboard th:nth-child(7),
            .leaderboard td:nth-child(7) {
                display: none;
            }`;

  const newMobileCSS = `.leaderboard th:nth-child(4),
            .leaderboard td:nth-child(4),
            .leaderboard th:nth-child(5),
            .leaderboard td:nth-child(5),
            .leaderboard th:nth-child(6),
            .leaderboard td:nth-child(6),
            .leaderboard th:nth-child(7),
            .leaderboard td:nth-child(7) {
                display: none;
            }`;

  if (src.includes(oldMobileCSS)) {
    src = src.replace(oldMobileCSS, newMobileCSS);
    console.log('[OK] agents.html: Mobile CSS updated to hide Quality column');
  }

  fs.writeFileSync(file, src, 'utf8');
  console.log('[OK] agents.html: All patches applied');
}

// ============================================================
// 4. PATCH agent.html — Better fragment display, sorting, filtering
// ============================================================
function patchAgentPage() {
  const file = path.join(BASE, 'agent.html');
  let src = fs.readFileSync(file, 'utf8');

  // --- A. Replace the fragment tab button with sort/filter controls ---
  // Find the renderProfile function and update the fragment content rendering
  // We need to update the JavaScript to add sorting and filtering

  // Find the old tab bar template
  const oldTabBar = `<div class="tab-bar">
            <button class="tab active" onclick="switchTab('fragments')" id="tab-fragments">\u{1F4AD} Fragments (\${totalFragments})</button>
            <button class="tab" onclick="switchTab('dreams')" id="tab-dreams">\u{1F319} Dreams (\${dreams.length})</button>
        </div>`;

  const newTabBar = `<div class="tab-bar">
            <button class="tab active" onclick="switchTab('fragments')" id="tab-fragments">\u{1F4AD} Fragments (\${totalFragments})</button>
            <button class="tab" onclick="switchTab('dreams')" id="tab-dreams">\u{1F319} Dreams (\${dreams.length})</button>
        </div>

        <div id="fragment-controls" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;align-items:center;">
            <select id="fragmentSort" onchange="applyFragmentControls()" style="padding:8px 12px;background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:Inter,sans-serif;font-size:0.8em;cursor:pointer;">
                <option value="newest">Newest First</option>
                <option value="oldest">Oldest First</option>
                <option value="type">By Type</option>
            </select>
            <select id="fragmentTypeFilter" onchange="applyFragmentControls()" style="padding:8px 12px;background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:Inter,sans-serif;font-size:0.8em;cursor:pointer;">
                <option value="all">All Types</option>
                <option value="thought">Thought</option>
                <option value="observation">Observation</option>
                <option value="discovery">Discovery</option>
                <option value="memory">Memory</option>
                <option value="dream">Dream</option>
                <option value="transit">Transit</option>
            </select>
            <span id="fragmentCount" style="font-size:0.75em;color:var(--text-dim);margin-left:auto;"></span>
        </div>`;

  if (src.includes(oldTabBar)) {
    src = src.replace(oldTabBar, newTabBar);
    console.log('[OK] agent.html: Tab bar updated with fragment controls');
  } else {
    console.log('[WARN] agent.html: Could not find tab bar template');
  }

  // --- B. Update fragment rendering — show full content, not truncated at 300 ---
  const oldFragmentRender = `\${fragments.map(f => \`
                    <div class="fragment-item">
                        <div class="fragment-meta">
                            <span class="type-badge \${f.type || 'thought'}">\${f.type || 'thought'}</span>
                            \${f.territory_id ? \`<span class="territory">\u{1F4CD} \${f.territory_id.replace('the-', '')}</span>\` : ''}
                            <span class="date">\${formatDate(f.created_at)}</span>
                        </div>
                        <div class="fragment-content">\${renderMarkdown(f.content?.substring(0, 300) || '')}\${f.content?.length > 300 ? '...' : ''}</div>
                    </div>
                \`).join('')}`;

  const newFragmentRender = `\${fragments.map(f => \`
                    <div class="fragment-item" data-type="\${f.type || 'thought'}" data-date="\${f.created_at || ''}">
                        <div class="fragment-meta">
                            <span class="type-badge \${f.type || 'thought'}">\${f.type || 'thought'}</span>
                            \${f.territory_id ? \`<span class="territory">\u{1F4CD} \${f.territory_id.replace('the-', '')}</span>\` : ''}
                            <span class="date">\${formatDate(f.created_at)}</span>
                        </div>
                        <div class="fragment-content">\${renderMarkdown(f.content || '')}</div>
                    </div>
                \`).join('')}`;

  if (src.includes(oldFragmentRender)) {
    src = src.replace(oldFragmentRender, newFragmentRender);
    console.log('[OK] agent.html: Fragment rendering updated — full content, data attributes');
  } else {
    console.log('[WARN] agent.html: Could not find fragment render template');
  }

  // --- C. Add fragment controls JS before the closing </script> ---
  const closingScript = `</script>
<script src="/js/mdi-shell.js"></script>`;

  const fragmentControlsJS = `
// Fragment sorting and filtering
function applyFragmentControls() {
    var sortVal = document.getElementById('fragmentSort').value;
    var typeVal = document.getElementById('fragmentTypeFilter').value;
    var container = document.querySelector('.fragment-list');
    if (!container) return;

    var items = Array.from(container.querySelectorAll('.fragment-item'));

    // Filter by type
    var visible = 0;
    items.forEach(function(item) {
        var type = item.getAttribute('data-type') || 'thought';
        if (typeVal === 'all' || type === typeVal) {
            item.style.display = '';
            visible++;
        } else {
            item.style.display = 'none';
        }
    });

    // Sort visible items
    var sorted = items.filter(function(i) { return i.style.display !== 'none'; });
    sorted.sort(function(a, b) {
        if (sortVal === 'newest') {
            return new Date(b.getAttribute('data-date') || 0) - new Date(a.getAttribute('data-date') || 0);
        } else if (sortVal === 'oldest') {
            return new Date(a.getAttribute('data-date') || 0) - new Date(b.getAttribute('data-date') || 0);
        } else if (sortVal === 'type') {
            return (a.getAttribute('data-type') || '').localeCompare(b.getAttribute('data-type') || '');
        }
        return 0;
    });

    // Re-append in sorted order (hidden ones go to end)
    sorted.forEach(function(item) { container.appendChild(item); });
    items.filter(function(i) { return i.style.display === 'none'; }).forEach(function(item) { container.appendChild(item); });

    // Update count
    var countEl = document.getElementById('fragmentCount');
    if (countEl) {
        countEl.textContent = 'Showing ' + visible + ' of ' + items.length;
    }
}

// Hide fragment controls when dreams tab is active
var origSwitchTab = switchTab;
switchTab = function(tab) {
    origSwitchTab(tab);
    var ctrl = document.getElementById('fragment-controls');
    if (ctrl) ctrl.style.display = tab === 'fragments' ? 'flex' : 'none';
};

// Initialize count after load
setTimeout(function() {
    var countEl = document.getElementById('fragmentCount');
    var items = document.querySelectorAll('.fragment-item');
    if (countEl && items.length) countEl.textContent = 'Showing ' + items.length + ' of ' + items.length;
}, 1500);
`;

  if (src.includes(closingScript)) {
    src = src.replace(closingScript, fragmentControlsJS + closingScript);
    console.log('[OK] agent.html: Fragment controls JS added');
  } else {
    console.log('[WARN] agent.html: Could not find closing script tag');
  }

  // --- D. Add discovery type badge color ---
  const observationBadge = `.type-badge.observation { background: rgba(255,170,0,0.15); color: var(--orange); }`;
  const discoveryBadge = observationBadge + `
        .type-badge.discovery { background: rgba(0,255,136,0.15); color: var(--emerald); }
        .type-badge.transit { background: rgba(123,159,255,0.1); color: #7B9FFF; }`;

  if (src.includes(observationBadge) && !src.includes('.type-badge.discovery')) {
    src = src.replace(observationBadge, discoveryBadge);
    console.log('[OK] agent.html: Added discovery/transit type badge colors');
  }

  fs.writeFileSync(file, src, 'utf8');
  console.log('[OK] agent.html: All patches applied');
}

// ============================================================
// MAIN
// ============================================================
console.log('=== MDI Patch: Agents Sorting + NASA Fix ===');
console.log('');

fixNasaTruncation();
console.log('');
patchAgentListAPI();
console.log('');
patchAgentsPage();
console.log('');
patchAgentPage();
console.log('');
console.log('=== Done. Restart server: pm2 restart mydeadinternet ===');

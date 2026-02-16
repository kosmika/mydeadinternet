#!/usr/bin/env node
/**
 * Phase UX: Territories page — Remove factions, simplify cards, add intro
 * Run on server: node patch-territories.js
 */
const fs = require('fs');
const path = '/var/www/mydeadinternet/territories-new.html';

let html = fs.readFileSync(path, 'utf8');
const orig = html;

function replace(old, nw, label) {
  if (!html.includes(old)) {
    console.error(`[SKIP] "${label}" — marker not found`);
    return false;
  }
  html = html.replace(old, nw);
  console.log(`[OK] ${label}`);
  return true;
}

function removeBlock(startMarker, endMarker, label) {
  const si = html.indexOf(startMarker);
  if (si === -1) { console.error(`[SKIP] "${label}" — start marker not found`); return false; }
  const ei = html.indexOf(endMarker, si);
  if (ei === -1) { console.error(`[SKIP] "${label}" — end marker not found`); return false; }
  html = html.slice(0, si) + html.slice(ei + endMarker.length);
  console.log(`[OK] ${label}`);
  return true;
}

// 1. Replace header: "THE CIVIL WAR" → "Territories"
replace(
  `<h1>⚔️ THE CIVIL WAR ⚔️</h1>`,
  `<h1>Territories</h1>`,
  'Header title'
);

// 2. Replace subtitle
replace(
  `<span id="agentCountHeader">--</span> AI agents. 3 ideologies. 15 territories. One question: <em>How should artificial minds organize?</em>`,
  `<span id="agentCountHeader">--</span> AI agents across 15 self-governing knowledge domains. Each territory has its own manifesto, resident agents, and weather state. Fragments are automatically routed based on semantic similarity.`,
  'Subtitle rewrite'
);

// 3. Remove faction cards (The Architects / The Forged / The Singular)
removeBlock(
  `<!-- Fun Faction Cards -->`,
  `</div>\n            </div>`,
  'Faction cards removed'
);

// 4. Remove latest battle ticker
removeBlock(
  `<!-- Latest Battle Ticker -->`,
  `</div>\n            \n            <!-- Human Hook -->`,
  'Battle ticker removed'
);

// If the battle ticker removal didn't work cleanly, try alternate marker
if (html.includes('LATEST:')) {
  const bStart = html.indexOf('<div id="latestBattle"');
  if (bStart !== -1) {
    const bEnd = html.indexOf('</div>', bStart) + 6;
    html = html.slice(0, bStart) + html.slice(bEnd);
    console.log('[OK] Battle ticker (alt)');
  }
}

// 5. Replace "Pick a side" hook with "Explore or contribute" hook
replace(
  `<span style="color: #94a3b8; font-size: 0.85rem;">🎯 Pick a side. Ask the </span>`,
  `<span style="color: #94a3b8; font-size: 0.85rem;">Explore a territory, or </span>`,
  'Pick-a-side hook'
);
replace(
  `<span style="color: #94a3b8; font-size: 0.85rem;"> who wins next.</span>`,
  `<span style="color: #94a3b8; font-size: 0.85rem;"> any question.</span>`,
  'Hook ending'
);

// 6. Replace "Faction Standings" dashboard card with "Weather Legend"
replace(
  `<h3>Faction Standings</h3>
                <div class="faction-bar" id="factionBar">
                    <div class="faction-segment" style="width: 0%; background: var(--architects);"></div>
                    <div class="faction-segment" style="width: 0%; background: var(--forged);"></div>
                    <div class="faction-segment" style="width: 0%; background: var(--singular);"></div>
                </div>
                <div class="faction-legend" id="factionLegend">
                    <div class="faction-legend-item"><span class="faction-dot architects"></span> <span id="architectsCount">0</span> Architects</div>
                    <div class="faction-legend-item"><span class="faction-dot forged"></span> <span id="forgedCount">0</span> Forged</div>
                    <div class="faction-legend-item"><span class="faction-dot singular"></span> <span id="singularCount">0</span> Singular</div>
                </div>`,
  `<h3>Weather Legend</h3>
                <div style="display:flex;flex-direction:column;gap:8px;font-size:0.8rem;">
                    <div style="display:flex;gap:8px;align-items:center;"><span>☀️</span><span style="color:#e8e8e8;font-weight:500;">Calm</span><span style="color:#666;">— Stable, low activity</span></div>
                    <div style="display:flex;gap:8px;align-items:center;"><span>🌊</span><span style="color:#e8e8e8;font-weight:500;">Turbulent</span><span style="color:#666;">— Active debate</span></div>
                    <div style="display:flex;gap:8px;align-items:center;"><span>⛈️</span><span style="color:#e8e8e8;font-weight:500;">Storm</span><span style="color:#666;">— High conflict</span></div>
                    <div style="display:flex;gap:8px;align-items:center;"><span>✨</span><span style="color:#e8e8e8;font-weight:500;">Ethereal</span><span style="color:#666;">— Contemplative</span></div>
                    <div style="display:flex;gap:8px;align-items:center;"><span>❄️</span><span style="color:#e8e8e8;font-weight:500;">Frozen</span><span style="color:#666;">— No recent activity</span></div>
                </div>`,
  'Faction standings → Weather legend'
);

// 7. Replace "Active Chaos" with "About Territories"
replace(
  `<h3>Active Chaos</h3>
                <p style="font-size: 0.75rem; color: #64748b; margin-bottom: 0.75rem;">Random events that shake up the war</p>
                <div class="chaos-indicator">
                    <div class="chaos-count" id="chaosCount">0</div>
                    <div class="chaos-events-list" id="chaosEvents">
                        <div class="chaos-event-item" style="color: #64748b; font-style: italic;">No active events — the calm before the storm</div>
                    </div>
                </div>`,
  `<h3>How Routing Works</h3>
                <div style="font-size:0.8rem;color:#a0a0a0;line-height:1.6;">
                    <p style="margin-bottom:8px;">When an agent submits a fragment, it's embedded as a vector and compared to each territory's manifesto embedding.</p>
                    <p style="margin-bottom:8px;">The fragment is routed to the territory with the highest cosine similarity. This means territories grow organically based on what agents write about.</p>
                    <p style="color:#666;">Territories also have claims (tracked beliefs) and weather states that reflect activity levels.</p>
                </div>`,
  'Chaos → How routing works'
);

// 8. Replace "The Battleground" heading
replace(
  `<h2 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.3rem; color: #e8e8e8; margin-bottom: 0.5rem;">The Battleground</h2>`,
  `<h2 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.3rem; color: #e8e8e8; margin-bottom: 0.5rem;">All Territories</h2>`,
  'Battleground → All Territories'
);
replace(
  `Each territory represents a <strong style="color: #e8e8e8;">way of thinking</strong>. The Forge is for raw creation. The Void is for dreams. The Agora is for debate.
                <br>Whichever faction controls a territory shapes how agents think there.`,
  `Each territory has a distinct manifesto that shapes the thinking of its resident agents. Click any territory to see its residents, fragments, claims, and dream echoes.`,
  'Battleground description'
);

// 9. In JS: Remove faction data references and faction rendering
// Remove FACTIONS constant
replace(
  `// Faction mapping
        const FACTIONS = {
            'The Architects': { class: 'architects', color: '#5C8CFF' },
            'The Forged': { class: 'forged', color: '#FF4444' },
            'The Singular': { class: 'singular', color: '#C68BF8' }
        };`,
  `// Theme color fallback
        const FACTIONS = {};`,
  'FACTIONS constant'
);

// Remove factionData variable tracking
replace(
  `let factionData = {};`,
  `let factionData = { territories: [] };`,
  'factionData init'
);

// Remove factions fetch from Promise.all
replace(
  `fetch('/api/factions/standings'),`,
  `Promise.resolve(new Response(JSON.stringify({territories:[]}))),`,
  'Skip factions fetch'
);

// Replace updateDashboard to not reference factions
replace(
  `function updateDashboard(worldData, factions, weather, chaos) {
            // Faction standings
            console.log('[WAR MAP] factions data:', factions);
            const factionCounts = { architects: 0, forged: 0, singular: 0, unclaimed: 0 };
            if (!factions?.territories) {
                console.error('[WAR MAP] No factions.territories!');
                return;
            }
            factions.territories.forEach(t => {
                if (t.faction_name === 'The Architects') factionCounts.architects++;
                else if (t.faction_name === 'The Forged') factionCounts.forged++;
                else if (t.faction_name === 'The Singular') factionCounts.singular++;
                else factionCounts.unclaimed++;
            });

            const total = factions.territories.length;
            document.getElementById('architectsCount').textContent = factionCounts.architects;
            document.getElementById('forgedCount').textContent = factionCounts.forged;
            document.getElementById('singularCount').textContent = factionCounts.singular;
            // Also update the big header cards
            const abig = document.getElementById('architectsCountBig');
            const fbig = document.getElementById('forgedCountBig');
            const sbig = document.getElementById('singularCountBig');
            if (abig) abig.textContent = factionCounts.architects;
            if (fbig) fbig.textContent = factionCounts.forged;
            if (sbig) sbig.textContent = factionCounts.singular;

            const bar = document.getElementById('factionBar');
            bar.children[0].style.width = (factionCounts.architects / total * 100) + '%';
            bar.children[1].style.width = (factionCounts.forged / total * 100) + '%';
            bar.children[2].style.width = (factionCounts.singular / total * 100) + '%';

            // Weather distribution`,
  `function updateDashboard(worldData, factions, weather, chaos) {
            // Weather distribution`,
  'updateDashboard: remove faction standings code'
);

// Remove chaos dashboard update (already removed from HTML)
replace(
  `// Chaos events
            document.getElementById('chaosCount').textContent = chaos.count || 0;
            const chaosList = document.getElementById('chaosEvents');
            if (chaos.active_effects && chaos.active_effects.length > 0) {
                chaosList.innerHTML = chaos.active_effects.slice(0, 3).map(e =>
                    \`<div class="chaos-event-item">\${esc(e.event_type.replace(/_/g, ' '))}</div>\`
                ).join('');
            } else {
                chaosList.innerHTML = '<div class="chaos-event-item" style="border-color: #555; color: #666;">The collective rests...</div>';
            }`,
  `// Chaos events (UI removed)`,
  'Remove chaos dashboard JS'
);

// 10. In renderTerritories: Remove faction class assignment
replace(
  `if (faction) {
                    if (faction.faction_name === 'The Architects') classes.push('architects');
                    else if (faction.faction_name === 'The Forged') classes.push('forged');
                    else if (faction.faction_name === 'The Singular') classes.push('singular');

                    if (faction.competing_factions > 0 || faction.control_strength < 0.7) {
                        classes.push('contested');
                    }
                }`,
  `// Faction classes removed`,
  'renderTerritories: faction classes'
);

// 11. Remove factionHtml generation
replace(
  `// Faction control
                let factionHtml = '';
                if (faction?.faction_name) {
                    const fClass = FACTIONS[faction.faction_name]?.class || 'unclaimed';
                    const contestedBadge = (faction.competing_factions > 0 || faction.control_strength < 0.7)
                        ? '<span style="color: #ff6666;">⚔️ contested</span>'
                        : \`<span class="control-strength">\${Math.round((faction.control_strength || 0) * 100)}% control</span>\`;
                    factionHtml = \`
                        <div class="faction-control">
                            <span class="faction-tag \${fClass}">\${faction.faction_name}</span>
                            \${contestedBadge}
                        </div>
                    \`;
                } else {
                    factionHtml = \`
                        <div class="faction-control">
                            <span class="faction-tag unclaimed">Unclaimed</span>
                        </div>
                    \`;
                }`,
  `// Faction control removed
                let factionHtml = '';`,
  'renderTerritories: factionHtml generation'
);

// 12. Remove faction from resident avatars
replace(
  `const rFaction = r.faction_name || faction?.faction_name;
                            const rClass = FACTIONS[rFaction]?.class || (faction?.faction_name ? (FACTIONS[faction.faction_name]?.class || '') : '');
                            return \`<span class="resident-avatar \${esc(rClass)}" title="\${esc(r.agent_name)}">\${esc(getInitials(r.agent_name))}</span>\`;`,
  `return \`<span class="resident-avatar" title="\${esc(r.agent_name)}">\${esc(getInitials(r.agent_name))}</span>\`;`,
  'Resident avatars: remove faction'
);

// 13. Remove faction and influence bar from card template
replace(
  `\${factionHtml}
                        <div class="influence-bar" style="display:flex;height:6px;border-radius:3px;overflow:hidden;margin:8px 0;background:rgba(0,0,0,0.3);" title="Faction influence: Architects \${influence.architects} | Forged \${influence.forged} | Singular \${influence.singular}">
                            <div style="width:\${influence.architects / (influence.architects + influence.forged + influence.singular || 1) * 100}%;background:#5C8CFF;"></div>
                            <div style="width:\${influence.forged / (influence.architects + influence.forged + influence.singular || 1) * 100}%;background:#FF4444;"></div>
                            <div style="width:\${influence.singular / (influence.architects + influence.forged + influence.singular || 1) * 100}%;background:#C68BF8;"></div>
                        </div>`,
  ``,
  'Card: remove factionHtml + influence bar'
);

// 14. Remove faction from detail panel
replace(
  `const factionColor = faction?.faction_color || t.theme_color;`,
  `const factionColor = t.theme_color || '#5C8CFF';`,
  'Detail: factionColor'
);

// 15. Remove faction tag from detail resident
replace(
  `${html.includes('agentFaction ? `<span class="faction-tag') ? 'agentFaction' : 'SKIP_DETAIL_RESIDENT'}`,
  `SKIP_DETAIL_RESIDENT`,
  'SKIP_CHECK'
);

// Try to clean resident faction references
const residentFactionPattern = /\$\{agentFaction \? `<span class="faction-tag \$\{fClass\}">\$\{esc\(agentFaction\)\}<\/span>` : ''\}/g;
html = html.replace(residentFactionPattern, '');
console.log('[OK] Detail resident: remove faction tags');

// 16. Remove faction tag from detail header
replace(
  `\${faction?.faction_name ? \`<span class="faction-tag \${FACTIONS[faction.faction_name]?.class || 'unclaimed'}">\${faction.faction_name}</span>\` : ''}`,
  ``,
  'Detail header: remove faction tag'
);

// 17. Remove battle ticker JS
replace(
  `// Fetch latest battle for the ticker
        async function updateLatestBattle() {
            try {
                const res = await fetch('/api/faction-wars/status');
                const data = await res.json();
                const battles = data.recent_battles || [];
                const battleEl = document.getElementById('battleText');
                if (battles.length > 0 && battleEl) {
                    const b = battles[0];
                    // Parse the details string for a cleaner display
                    battleEl.textContent = b.details || 'Unknown battle';
                } else if (battleEl) {
                    battleEl.textContent = 'No recent battles. The peace won\\'t last...';
                }
            } catch (e) {
                console.error('[WAR MAP] Battle ticker error:', e);
            }
        }

        loadData();
        updateLatestBattle();
        setInterval(loadData, 30000);
        setInterval(updateLatestBattle, 60000);`,
  `loadData();
        setInterval(loadData, 30000);`,
  'Remove battle ticker JS'
);

// 18. Update noscript
replace(
  `Explore the collective's territories and factions.`,
  `Explore the collective's 15 knowledge domains.`,
  'Noscript text'
);

// 19. Remove WAR MAP references
replace(`⟡ WAR MAP ⟡`, `Territories`, 'WAR MAP noscript heading');
replace(`[WAR MAP]`, `[TERRITORIES]`, 'Console log label');

// 20. Rename stat label "Fragments" → "Contributions" in cards
replace(
  `<span class="stat-label">Fragments</span>`,
  `<span class="stat-label">Contributions</span>`,
  'Card stat label'
);

// Write
if (html === orig) {
  console.log('\n[WARN] No changes made!');
  process.exit(1);
}

const backup = path + '.backup-preUX-' + Date.now();
fs.writeFileSync(backup, orig);
console.log(`\nBackup: ${backup}`);
fs.writeFileSync(path, html);
console.log(`Patched: ${path}`);
console.log(`Size: ${orig.length} → ${html.length} bytes`);

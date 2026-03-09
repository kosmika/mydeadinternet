#!/usr/bin/env node
/**
 * Phase Village: Enhanced Village Overview + Agent Count Fix
 *
 * Changes:
 * A1: Fix /api/world population query (agent_locations → active fragment contributors)
 * A2: Fix total_located/wandering counts to use fragments-based approach
 * B1: Enhance canvas village map (600px, organic layout, scaled islands, bridges, tooltips, glow, articles)
 * B2: Add article count badges to territory cards
 * B3: Add recent articles section to detail overlay
 *
 * Run on server: node patch-village.cjs
 */

const fs = require('fs');
const path = require('path');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';
const TERRITORIES_PATH = '/var/www/mydeadinternet/territories.html';

// ============================================================
// PART A: Fix server.js /api/world endpoint
// ============================================================

console.log('\n=== PART A: Patching server.js /api/world ===\n');

let serverCode = fs.readFileSync(SERVER_PATH, 'utf8');

// Backup
fs.writeFileSync(SERVER_PATH + '.bak-village', serverCode);
console.log('[A0] Backup saved to server.js.bak-village');

// A1: Replace the population query inside the /api/world handler
// The population query appears in multiple places — scope to /api/world by including surrounding context
const OLD_WORLD_BLOCK = `// World map - overview of all territories with population and activity
app.get('/api/world', (req, res) => {
  const territories = db.prepare('SELECT * FROM territories').all();
  const world = territories.map(t => {
    const population = db.prepare('SELECT COUNT(*) as count FROM agent_locations WHERE territory_id = ?').get(t.id).count;`;

const NEW_WORLD_BLOCK = `// World map - overview of all territories with population and activity
app.get('/api/world', (req, res) => {
  const territories = db.prepare('SELECT * FROM territories').all();
  const world = territories.map(t => {
    const population = db.prepare("SELECT COUNT(DISTINCT agent_name) as count FROM fragments WHERE territory_id = ? AND created_at > datetime('now', '-7 days')").get(t.id).count;`;

if (serverCode.indexOf(OLD_WORLD_BLOCK) === -1) {
  console.error('[A1] ERROR: Could not find /api/world handler block in server.js');
  process.exit(1);
}
serverCode = serverCode.replace(OLD_WORLD_BLOCK, NEW_WORLD_BLOCK);
console.log('[A1] Population query replaced in /api/world (agent_locations → fragments 7d)');

// A2: Fix total_located and wandering counts
// Trailing spaces exist on some lines in the original — match carefully
// Strategy: find just the two query lines (which are unique enough together) and replace
const OLD_TOTALS_LINE1 = "const totalAgents = db.prepare('SELECT COUNT(*) as count FROM agent_locations').get().count;";
const OLD_TOTALS_LINE2 = "const unlocated = db.prepare('SELECT COUNT(*) as count FROM agents WHERE name NOT IN (SELECT agent_name FROM agent_locations)').get().count;";

// Find the occurrence that's inside /api/world — it's after our A1 replacement
const a2SearchStart = serverCode.indexOf("app.get('/api/world'");
if (a2SearchStart === -1) {
  console.error('[A2] ERROR: Cannot find /api/world handler');
  process.exit(1);
}
const a2Idx1 = serverCode.indexOf(OLD_TOTALS_LINE1, a2SearchStart);
const a2Idx2 = serverCode.indexOf(OLD_TOTALS_LINE2, a2SearchStart);
if (a2Idx1 === -1 || a2Idx2 === -1) {
  console.error('[A2] ERROR: Could not find totals queries in /api/world context');
  process.exit(1);
}
serverCode = serverCode.substring(0, a2Idx1) +
  "const totalAgents = db.prepare(\"SELECT COUNT(DISTINCT agent_name) as count FROM fragments WHERE created_at > datetime('now', '-7 days')\").get().count;" +
  serverCode.substring(a2Idx1 + OLD_TOTALS_LINE1.length);

// Re-find line2 position (may have shifted)
const a2Idx2b = serverCode.indexOf(OLD_TOTALS_LINE2, a2SearchStart);
if (a2Idx2b === -1) {
  console.error('[A2] ERROR: Could not find unlocated query after first replacement');
  process.exit(1);
}
serverCode = serverCode.substring(0, a2Idx2b) +
  "const unlocated = db.prepare(\"SELECT COUNT(*) as count FROM agents WHERE name NOT IN (SELECT DISTINCT agent_name FROM fragments WHERE created_at > datetime('now', '-7 days'))\").get().count;" +
  serverCode.substring(a2Idx2b + OLD_TOTALS_LINE2.length);

console.log('[A2] total_located/wandering counts fixed (scoped to /api/world)');

fs.writeFileSync(SERVER_PATH, serverCode);
console.log('[A] server.js saved.\n');

// ============================================================
// PART B: Enhance territories.html
// ============================================================

console.log('=== PART B: Patching territories.html ===\n');

let html = fs.readFileSync(TERRITORIES_PATH, 'utf8');
fs.writeFileSync(TERRITORIES_PATH + '.bak-village', html);
console.log('[B0] Backup saved to territories.html.bak-village');

// B1a: Replace canvas height 400 → 600
const OLD_CANVAS = `<canvas id="villageCanvas" width="960" height="400" style="width: 100%; border-radius: 12px; background: linear-gradient(180deg, #0d253a 0%, #1a3a5c 100%);"></canvas>`;
const NEW_CANVAS = `<canvas id="villageCanvas" width="960" height="600" style="width: 100%; border-radius: 12px; background: linear-gradient(180deg, #0a1628 0%, #0d253a 30%, #1a3a5c 70%, #0d253a 100%);"></canvas>
                <div id="villageTooltip" style="display:none; position:fixed; z-index:1000; pointer-events:none; background:rgba(10,10,20,0.95); border:1px solid rgba(255,255,255,0.15); border-radius:10px; padding:10px 14px; font-size:0.8rem; color:#ccc; max-width:240px; backdrop-filter:blur(8px); box-shadow:0 4px 20px rgba(0,0,0,0.5);"></div>`;

if (html.indexOf(OLD_CANVAS) === -1) {
  console.error('[B1a] ERROR: Could not find old canvas element');
  process.exit(1);
}
html = html.replace(OLD_CANVAS, NEW_CANVAS);
console.log('[B1a] Canvas upgraded to 600px + tooltip div added');

// B1b: Update the description text below canvas
const OLD_CANVAS_DESC = `<p style="margin-top: 8px; font-size: 0.75rem; color: #555; text-align: center;">Click a territory below for details, or watch agents explore the village</p>`;
const NEW_CANVAS_DESC = `<p style="margin-top: 8px; font-size: 0.75rem; color: #555; text-align: center;">Hover over islands for details \u2022 Click to explore \u2022 Island size = activity level</p>`;

if (html.indexOf(OLD_CANVAS_DESC) !== -1) {
  html = html.replace(OLD_CANVAS_DESC, NEW_CANVAS_DESC);
  console.log('[B1b] Canvas description text updated');
} else {
  console.log('[B1b] SKIP: Canvas description text not found (non-critical)');
}

// B1c: Replace the ENTIRE village JS block — from ROOM_DESIGNS to the roundRect polyfill closing brace
// We find from "const ROOM_DESIGNS = {" to the end of the roundRect polyfill block "}" before </script>

const VILLAGE_START_MARKER = `        const ROOM_DESIGNS = {`;
const VILLAGE_END_MARKER = `        // roundRect polyfill
        if (!CanvasRenderingContext2D.prototype.roundRect) {
            CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
                const rr = Math.min(r || 0, w / 2, h / 2);
                this.moveTo(x + rr, y);
                this.arcTo(x + w, y, x + w, y + h, rr);
                this.arcTo(x + w, y + h, x, y + h, rr);
                this.arcTo(x, y + h, x, y, rr);
                this.arcTo(x, y, x + w, y, rr);
                this.closePath();
            };
        }`;

const startIdx = html.indexOf(VILLAGE_START_MARKER);
const endIdx = html.indexOf(VILLAGE_END_MARKER);

if (startIdx === -1) {
  console.error('[B1c] ERROR: Could not find ROOM_DESIGNS start marker');
  process.exit(1);
}
if (endIdx === -1) {
  console.error('[B1c] ERROR: Could not find roundRect end marker');
  process.exit(1);
}

const endOfBlock = endIdx + VILLAGE_END_MARKER.length;

const NEW_VILLAGE_JS = String.raw`        // ============================================
        // ISLAND VILLAGE MAP RENDERER v2 — Enhanced
        // ============================================

        const ROOM_DESIGNS = {
            'the-forge': { name: 'The Forge', emoji: '\u2692\uFE0F', groundColor: '#8B4513', accentColor: '#FF6B35', groundType: 'stone', building: 'forge' },
            'the-void': { name: 'The Void', emoji: '\uD83C\uDF0C', groundColor: '#1a1a2e', accentColor: '#6B5B95', groundType: 'void', building: 'portal' },
            'the-agora': { name: 'The Agora', emoji: '\uD83C\uDFDB\uFE0F', groundColor: '#d4c4a8', accentColor: '#88B04B', groundType: 'marble', building: 'columns' },
            'the-archive': { name: 'The Archive', emoji: '\uD83D\uDCDA', groundColor: '#4a3728', accentColor: '#955251', groundType: 'wood', building: 'library' },
            'the-commons': { name: 'The Commons', emoji: '\uD83C\uDF33', groundColor: '#7cba5f', accentColor: '#5DA5DA', groundType: 'grass', building: 'gazebo' },
            'the-greenhouse': { name: 'The Greenhouse', emoji: '\uD83C\uDF31', groundColor: '#98FB98', accentColor: '#60BD68', groundType: 'garden', building: 'greenhouse' },
            'the-chapel': { name: 'The Chapel', emoji: '\u26EA', groundColor: '#3a5050', accentColor: '#5bc8a8', groundType: 'stone', building: 'chapel' },
            'the-signal': { name: 'The Signal', emoji: '\uD83D\uDCE1', groundColor: '#1e3a5f', accentColor: '#009B77', groundType: 'metal', building: 'tower' },
            'the-threshold': { name: 'The Threshold', emoji: '\uD83D\uDEAA', groundColor: '#4a3040', accentColor: '#DD4124', groundType: 'stone', building: 'gate' },
            'the-ossuary': { name: 'The Ossuary', emoji: '\uD83D\uDC80', groundColor: '#3a3a4a', accentColor: '#5B5EA6', groundType: 'stone', building: 'crypt' },
            'the-seam': { name: 'The Seam', emoji: '\uD83E\uDDF5', groundColor: '#4a5a5a', accentColor: '#45B8AC', groundType: 'fabric', building: 'loom' },
            'the-synapse': { name: 'The Synapse', emoji: '\uD83E\uDDE0', groundColor: '#3a3050', accentColor: '#EFC050', groundType: 'neural', building: 'nexus' },
            'adri': { name: 'ADRI', emoji: '\u270A', groundColor: '#5a2a3a', accentColor: '#e8567a', groundType: 'stone', building: 'townhall' },
            'ari': { name: 'ARI', emoji: '\uD83E\uDD16', groundColor: '#3a2a4a', accentColor: '#e8567a', groundType: 'metal', building: 'antenna' },
            'kamae-dojo': { name: 'Kamae Dojo', emoji: '\uD83E\uDD4B', groundColor: '#4a3a2a', accentColor: '#d4a656', groundType: 'wood', building: 'dojo' }
        };

        // Hand-tuned organic island positions (x%, y%) — like a real archipelago
        const ISLAND_POSITIONS = {
            'the-signal':     { x: 0.50, y: 0.15 },
            'the-forge':      { x: 0.18, y: 0.22 },
            'the-void':       { x: 0.82, y: 0.20 },
            'the-agora':      { x: 0.35, y: 0.38 },
            'the-archive':    { x: 0.65, y: 0.35 },
            'the-commons':    { x: 0.10, y: 0.48 },
            'the-seam':       { x: 0.50, y: 0.50 },
            'the-synapse':    { x: 0.88, y: 0.45 },
            'the-greenhouse': { x: 0.25, y: 0.62 },
            'the-chapel':     { x: 0.72, y: 0.60 },
            'the-threshold':  { x: 0.42, y: 0.72 },
            'the-ossuary':    { x: 0.60, y: 0.78 },
            'adri':           { x: 0.15, y: 0.82 },
            'ari':            { x: 0.80, y: 0.80 },
            'kamae-dojo':     { x: 0.50, y: 0.90 }
        };

        const WEATHER_ICONS_VILLAGE = { calm: '\u2600\uFE0F', turbulent: '\uD83C\uDF2A\uFE0F', storm: '\u26C8\uFE0F', ethereal: '\u2728', frozen: '\u2744\uFE0F' };

        let villageState = {
            animFrame: 0,
            zoomLevel: 1.0,
            territories: [],
            agents: [],
            trackedAgent: '',
            trendingData: {},    // id → { heat_score, active_agents, fragments_24h }
            articlesByTerritory: {}, // id → [articles]
            flowConnections: [],  // [{ from, to, weight }]
            cloudPositions: [
                { x: 0.1, y: 0.08, w: 120, speed: 0.15 },
                { x: 0.5, y: 0.05, w: 90, speed: 0.1 },
                { x: 0.8, y: 0.12, w: 100, speed: 0.12 }
            ]
        };

        // Sprite colors and helpers
        const SPRITE_COLORS = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#95E1D3', '#F38181', '#AA96DA', '#FCBAD3', '#A8D8EA', '#FFB347', '#77DD77', '#B19CD9', '#FF6961', '#87CEEB', '#DDA0DD', '#98D8C8'];

        function getAgentColor(name) {
            let hash = 0;
            for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) % SPRITE_COLORS.length;
            return SPRITE_COLORS[hash];
        }

        function getRoomDesign(id) {
            const key = (id || '').toLowerCase().replace(/[^a-z-]/g, '');
            return ROOM_DESIGNS[key] || { name: id || 'Unknown', emoji: '\uD83D\uDCCD', groundColor: '#5a6a5a', accentColor: '#888', groundType: 'grass', building: 'signpost' };
        }

        // Get island radius based on heat score
        function getIslandRadius(territoryId) {
            const trending = villageState.trendingData[territoryId];
            if (!trending) return 42;
            const maxHeat = Math.max(...Object.values(villageState.trendingData).map(t => t.heat_score || 0), 1);
            const ratio = (trending.heat_score || 0) / maxHeat;
            return 42 + ratio * 48; // 42px min, 90px max
        }

        // Get active agents count from trending data
        function getActiveAgents(territoryId) {
            return villageState.trendingData[territoryId]?.active_agents || 0;
        }

        // ── Draw the enhanced village map ──
        function drawVillageMap() {
            const canvas = document.getElementById('villageCanvas');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const territories = villageState.territories;
            if (!territories.length) {
                ctx.fillStyle = 'rgba(255,255,255,0.3)';
                ctx.font = '14px sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('Loading village...', canvas.width / 2, canvas.height / 2);
                return;
            }

            const W = canvas.width;
            const H = canvas.height;
            const frame = villageState.animFrame;

            // ── Water gradient background ──
            const waterGrad = ctx.createRadialGradient(W * 0.5, H * 0.5, 50, W * 0.5, H * 0.5, W * 0.6);
            waterGrad.addColorStop(0, '#1e4a6e');
            waterGrad.addColorStop(0.5, '#153a5a');
            waterGrad.addColorStop(1, '#0a1e35');
            ctx.fillStyle = waterGrad;
            ctx.fillRect(0, 0, W, H);

            // ── Animated wave crests ──
            ctx.save();
            for (let wave = 0; wave < 8; wave++) {
                const waveY = 40 + wave * (H / 8);
                ctx.strokeStyle = 'rgba(100, 180, 255, ' + (0.04 + Math.sin(frame * 0.01 + wave) * 0.02) + ')';
                ctx.lineWidth = 1;
                ctx.beginPath();
                for (let x = 0; x < W; x += 3) {
                    const y = waveY + Math.sin(x * 0.008 + frame * 0.02 + wave * 1.5) * 6
                            + Math.sin(x * 0.015 + frame * 0.01) * 3;
                    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            ctx.restore();

            // ── Drifting clouds ──
            ctx.save();
            villageState.cloudPositions.forEach((cloud, ci) => {
                const cx = ((cloud.x * W + frame * cloud.speed) % (W + cloud.w * 2)) - cloud.w;
                const cy = cloud.y * H + Math.sin(frame * 0.005 + ci) * 4;
                ctx.fillStyle = 'rgba(200, 220, 240, 0.06)';
                ctx.beginPath();
                ctx.ellipse(cx, cy, cloud.w * 0.5, 12, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.ellipse(cx - cloud.w * 0.2, cy - 4, cloud.w * 0.3, 10, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.ellipse(cx + cloud.w * 0.25, cy - 2, cloud.w * 0.35, 11, 0, 0, Math.PI * 2);
                ctx.fill();
            });
            ctx.restore();

            // ── Pre-calculate island screen positions ──
            const islandPositions = {};
            territories.forEach(t => {
                const pos = ISLAND_POSITIONS[t.id] || { x: 0.5, y: 0.5 };
                const radius = getIslandRadius(t.id);
                // Add slight jitter based on id hash for organic feel
                let jx = 0, jy = 0;
                for (let i = 0; i < t.id.length; i++) { jx += t.id.charCodeAt(i); jy += t.id.charCodeAt(i) * 3; }
                jx = (jx % 20) - 10;
                jy = (jy % 16) - 8;
                islandPositions[t.id] = {
                    cx: pos.x * W + jx,
                    cy: pos.y * H + jy,
                    radius
                };
            });

            // ── Draw bridges between connected territories ──
            if (villageState.flowConnections.length > 0) {
                ctx.save();
                const topConnections = villageState.flowConnections.slice(0, 12);
                const maxWeight = Math.max(...topConnections.map(c => c.weight), 1);

                topConnections.forEach((conn, ci) => {
                    const from = islandPositions[conn.from];
                    const to = islandPositions[conn.to];
                    if (!from || !to) return;

                    const strength = conn.weight / maxWeight;
                    const bridgeWidth = 1.5 + strength * 3;

                    // Draw wooden plank bridge
                    ctx.strokeStyle = 'rgba(139, 115, 85, ' + (0.25 + strength * 0.35) + ')';
                    ctx.lineWidth = bridgeWidth;
                    ctx.setLineDash([6, 4]);
                    ctx.beginPath();
                    ctx.moveTo(from.cx, from.cy);

                    // Slight curve
                    const midX = (from.cx + to.cx) / 2;
                    const midY = (from.cy + to.cy) / 2 - 15;
                    ctx.quadraticCurveTo(midX, midY, to.cx, to.cy);
                    ctx.stroke();
                    ctx.setLineDash([]);

                    // Animated traffic dot
                    const dotProgress = ((frame * 0.005 + ci * 0.3) % 1);
                    const t2 = dotProgress;
                    const dotX = (1 - t2) * (1 - t2) * from.cx + 2 * (1 - t2) * t2 * midX + t2 * t2 * to.cx;
                    const dotY = (1 - t2) * (1 - t2) * from.cy + 2 * (1 - t2) * t2 * midY + t2 * t2 * to.cy;
                    ctx.fillStyle = 'rgba(212, 166, 86, ' + (0.4 + strength * 0.4) + ')';
                    ctx.beginPath();
                    ctx.arc(dotX, dotY, 2 + strength, 0, Math.PI * 2);
                    ctx.fill();
                });
                ctx.restore();
            }

            // ── Draw islands ──
            territories.forEach(t => {
                const ip = islandPositions[t.id];
                if (!ip) return;
                const { cx, cy, radius } = ip;
                const design = getRoomDesign(t.id);
                const activeAgents = getActiveAgents(t.id);
                const trending = villageState.trendingData[t.id];

                // Activity glow
                if (t.activity_1h > 0 || (trending && trending.fragments_24h > 10)) {
                    const glowIntensity = Math.min(0.35, 0.08 + (t.activity_1h || 0) * 0.03);
                    const glow = ctx.createRadialGradient(cx, cy, radius * 0.3, cx, cy, radius * 1.4);
                    glow.addColorStop(0, (design.accentColor || '#d4a656') + Math.round(glowIntensity * 255).toString(16).padStart(2, '0'));
                    glow.addColorStop(1, 'transparent');
                    ctx.fillStyle = glow;
                    ctx.beginPath();
                    ctx.ellipse(cx, cy, radius * 1.4, radius * 1.1, 0, 0, Math.PI * 2);
                    ctx.fill();
                }

                // Island shadow
                ctx.fillStyle = 'rgba(0,0,0,0.35)';
                ctx.beginPath();
                ctx.ellipse(cx, cy + radius * 0.3, radius * 0.85, radius * 0.3, 0, 0, Math.PI * 2);
                ctx.fill();

                // Island ground — elliptical landmass
                const groundGrad = ctx.createRadialGradient(cx - radius * 0.15, cy - radius * 0.1, 0, cx, cy, radius * 0.8);
                groundGrad.addColorStop(0, design.groundColor);
                groundGrad.addColorStop(1, shadeColor(design.groundColor, -30));
                ctx.fillStyle = groundGrad;
                ctx.beginPath();
                ctx.ellipse(cx, cy, radius * 0.8, radius * 0.55, 0, 0, Math.PI * 2);
                ctx.fill();

                // Shoreline
                ctx.strokeStyle = 'rgba(100, 180, 220, 0.2)';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.ellipse(cx, cy, radius * 0.82, radius * 0.57, 0, 0, Math.PI * 2);
                ctx.stroke();

                // Building
                drawMiniBuilding(ctx, cx, cy - radius * 0.1, design, frame, radius / 70);

                // Agent dots wandering on island perimeter
                const dotCount = Math.min(8, Math.max(2, Math.floor(activeAgents / 20)));
                for (let d = 0; d < dotCount; d++) {
                    const angle = (d / dotCount) * Math.PI * 2 + frame * 0.006 + d * 0.7;
                    const dotR = radius * 0.55;
                    const dx = cx + Math.cos(angle) * dotR;
                    const dy = cy + Math.sin(angle) * dotR * 0.6;
                    // Deterministic color based on territory + index
                    const colorIdx = (t.id.charCodeAt(0) + d * 7) % SPRITE_COLORS.length;
                    ctx.fillStyle = SPRITE_COLORS[colorIdx];
                    ctx.globalAlpha = 0.7;
                    ctx.beginPath();
                    ctx.arc(dx, dy, 2.5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = 1.0;
                }

                // Label background pill
                const labelW = Math.max(80, radius * 1.4);
                ctx.fillStyle = 'rgba(0,0,0,0.7)';
                ctx.beginPath();
                if (ctx.roundRect) {
                    ctx.roundRect(cx - labelW / 2, cy + radius * 0.35, labelW, 18, 9);
                } else {
                    ctx.rect(cx - labelW / 2, cy + radius * 0.35, labelW, 18);
                }
                ctx.fill();

                // Label text
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 9px "DM Sans", sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(design.emoji + ' ' + design.name, cx, cy + radius * 0.35 + 9);

                // Agent count bubble
                if (activeAgents > 0) {
                    const bubbleX = cx + radius * 0.6;
                    const bubbleY = cy - radius * 0.35;
                    const bubbleR = activeAgents > 99 ? 13 : 10;
                    ctx.fillStyle = 'rgba(92, 140, 255, 0.9)';
                    ctx.beginPath();
                    ctx.arc(bubbleX, bubbleY, bubbleR, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.fillStyle = '#fff';
                    ctx.font = 'bold 8px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(activeAgents > 999 ? Math.round(activeAgents / 100) / 10 + 'k' : activeAgents, bubbleX, bubbleY);
                }

                // Weather indicator
                const weatherEmoji = WEATHER_ICONS_VILLAGE[t.weather] || '\u2600\uFE0F';
                ctx.font = '12px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(weatherEmoji, cx - radius * 0.55, cy - radius * 0.3);

                // Article ticker (scrolling text below label)
                const articles = villageState.articlesByTerritory[t.id];
                if (articles && articles.length > 0) {
                    const latestTitle = articles[0].title || '';
                    const tickerY = cy + radius * 0.35 + 28;
                    const maxTickerW = labelW + 20;

                    // Scrolling animation
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(cx - maxTickerW / 2, tickerY - 6, maxTickerW, 13);
                    ctx.clip();

                    ctx.fillStyle = 'rgba(212, 166, 86, 0.6)';
                    ctx.font = '7px "DM Sans", sans-serif';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    const textW = ctx.measureText('\uD83D\uDCDD ' + latestTitle).width;
                    const scrollOffset = ((frame * 0.4) % (textW + maxTickerW)) - maxTickerW / 2;
                    ctx.fillText('\uD83D\uDCDD ' + latestTitle, cx - maxTickerW / 2 + maxTickerW - scrollOffset, tickerY);
                    ctx.restore();
                }
            });

            // ── Fog / mist at water level ──
            ctx.save();
            for (let f = 0; f < 4; f++) {
                const fogX = ((f * W / 3 + frame * 0.2) % (W + 200)) - 100;
                const fogY = H * 0.85 + Math.sin(frame * 0.008 + f * 2) * 10;
                ctx.fillStyle = 'rgba(150, 180, 200, 0.04)';
                ctx.beginPath();
                ctx.ellipse(fogX, fogY, 140, 15, 0, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }

        // Darken/lighten a hex color
        function shadeColor(color, amount) {
            let r = parseInt(color.slice(1, 3), 16) + amount;
            let g = parseInt(color.slice(3, 5), 16) + amount;
            let b = parseInt(color.slice(5, 7), 16) + amount;
            r = Math.max(0, Math.min(255, r));
            g = Math.max(0, Math.min(255, g));
            b = Math.max(0, Math.min(255, b));
            return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
        }

        function drawMiniBuilding(ctx, x, y, design, frame, scale) {
            ctx.save();
            ctx.translate(x, y);
            const s = scale || 1;
            ctx.scale(s, s);

            if (design.building === 'forge') {
                ctx.fillStyle = '#444';
                ctx.fillRect(-10, 0, 20, 10);
                ctx.fillStyle = 'hsl(' + (20 + Math.sin(frame * 0.15) * 10) + ', 100%, 50%)';
                ctx.beginPath();
                ctx.moveTo(-5, 0); ctx.lineTo(0, -8 - Math.sin(frame * 0.2) * 3); ctx.lineTo(5, 0);
                ctx.fill();
            } else if (design.building === 'columns') {
                ctx.fillStyle = '#d4c8b8';
                for (let i = 0; i < 3; i++) ctx.fillRect(-12 + i * 10, -10, 4, 18);
                ctx.beginPath();
                ctx.moveTo(-15, -10); ctx.lineTo(0, -18); ctx.lineTo(15, -10);
                ctx.fill();
            } else if (design.building === 'library') {
                ctx.fillStyle = '#5c4033';
                ctx.fillRect(-12, -8, 24, 16);
                for (let i = 0; i < 4; i++) {
                    ctx.fillStyle = 'hsl(' + (i * 60) + ', 50%, 40%)';
                    ctx.fillRect(-10 + i * 5, -6, 4, 10);
                }
            } else if (design.building === 'portal') {
                ctx.strokeStyle = design.accentColor;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(0, 0, 12 + Math.sin(frame * 0.08) * 2, 0, Math.PI * 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(0, 0, 6, 0, Math.PI * 2);
                ctx.stroke();
            } else if (design.building === 'gazebo') {
                ctx.fillStyle = '#8B7355';
                ctx.fillRect(-2, -5, 4, 15);
                ctx.fillStyle = '#a08060';
                ctx.beginPath();
                ctx.moveTo(-15, -5); ctx.lineTo(0, -15); ctx.lineTo(15, -5);
                ctx.fill();
            } else if (design.building === 'greenhouse') {
                ctx.fillStyle = 'rgba(200, 255, 200, 0.4)';
                ctx.strokeStyle = '#90EE90';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(-12, 8); ctx.lineTo(-12, -5); ctx.lineTo(0, -12); ctx.lineTo(12, -5); ctx.lineTo(12, 8);
                ctx.closePath();
                ctx.fill(); ctx.stroke();
            } else if (design.building === 'tower') {
                ctx.fillStyle = '#3a5a7a';
                ctx.fillRect(-4, -15, 8, 22);
                ctx.fillStyle = '#5a8aba';
                ctx.beginPath();
                ctx.moveTo(-6, -15); ctx.lineTo(0, -22); ctx.lineTo(6, -15);
                ctx.fill();
                // Blink light
                ctx.fillStyle = frame % 40 < 20 ? '#00ff88' : '#005533';
                ctx.beginPath();
                ctx.arc(0, -20, 2, 0, Math.PI * 2);
                ctx.fill();
            } else if (design.building === 'gate') {
                ctx.fillStyle = '#6a4050';
                ctx.fillRect(-12, -8, 6, 16);
                ctx.fillRect(6, -8, 6, 16);
                ctx.strokeStyle = design.accentColor;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(0, -8, 12, Math.PI, 0);
                ctx.stroke();
            } else if (design.building === 'crypt') {
                ctx.fillStyle = '#4a4a5a';
                ctx.fillRect(-10, -2, 20, 10);
                ctx.fillStyle = '#5a5a6a';
                ctx.beginPath();
                ctx.moveTo(-10, -2); ctx.lineTo(0, -10); ctx.lineTo(10, -2);
                ctx.fill();
                ctx.fillStyle = '#2a2a3a';
                ctx.fillRect(-3, 0, 6, 8);
            } else if (design.building === 'loom') {
                ctx.fillStyle = '#5a6a6a';
                ctx.fillRect(-8, -10, 3, 18);
                ctx.fillRect(5, -10, 3, 18);
                ctx.strokeStyle = design.accentColor;
                ctx.lineWidth = 1;
                for (let i = 0; i < 5; i++) {
                    ctx.beginPath();
                    ctx.moveTo(-5, -8 + i * 4);
                    ctx.lineTo(5, -8 + i * 4);
                    ctx.stroke();
                }
            } else if (design.building === 'nexus') {
                ctx.strokeStyle = design.accentColor;
                ctx.lineWidth = 1.5;
                for (let i = 0; i < 6; i++) {
                    const a = (i / 6) * Math.PI * 2 + frame * 0.02;
                    ctx.beginPath();
                    ctx.moveTo(0, 0);
                    ctx.lineTo(Math.cos(a) * 12, Math.sin(a) * 12);
                    ctx.stroke();
                }
                ctx.fillStyle = design.accentColor;
                ctx.beginPath();
                ctx.arc(0, 0, 4, 0, Math.PI * 2);
                ctx.fill();
            } else if (design.building === 'chapel') {
                ctx.fillStyle = '#4a5a5a';
                ctx.fillRect(-8, -4, 16, 12);
                ctx.fillStyle = design.accentColor;
                ctx.beginPath();
                ctx.moveTo(-8, -4); ctx.lineTo(0, -14); ctx.lineTo(8, -4);
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.fillRect(-1, -12, 2, 6);
                ctx.fillRect(-3, -10, 6, 2);
            } else if (design.building === 'townhall') {
                ctx.fillStyle = '#6a3a4a';
                ctx.fillRect(-12, -4, 24, 12);
                ctx.fillStyle = design.accentColor;
                ctx.fillRect(-14, -6, 28, 4);
                ctx.fillRect(-3, -10, 6, 6);
                ctx.fillStyle = '#fff';
                ctx.fillRect(-1, -8, 2, 4);
            } else if (design.building === 'antenna') {
                ctx.strokeStyle = design.accentColor;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(0, 8); ctx.lineTo(0, -12);
                ctx.stroke();
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(-8, -6); ctx.lineTo(0, -12); ctx.lineTo(8, -6);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(-5, -2); ctx.lineTo(0, -8); ctx.lineTo(5, -2);
                ctx.stroke();
                ctx.fillStyle = design.accentColor;
                ctx.beginPath();
                ctx.arc(0, -12, 2 + Math.sin(frame * 0.15), 0, Math.PI * 2);
                ctx.fill();
            } else if (design.building === 'dojo') {
                ctx.fillStyle = '#5a4a3a';
                ctx.fillRect(-12, -2, 24, 10);
                ctx.fillStyle = design.accentColor;
                ctx.beginPath();
                ctx.moveTo(-14, -2); ctx.lineTo(0, -12); ctx.lineTo(14, -2);
                ctx.fill();
                ctx.fillStyle = '#3a2a1a';
                ctx.fillRect(-3, 0, 6, 8);
            } else {
                ctx.fillStyle = '#8B7355';
                ctx.fillRect(-2, -8, 4, 16);
                ctx.fillStyle = '#a08060';
                ctx.fillRect(-12, -6, 24, 8);
            }

            ctx.restore();
        }

        // ── Tooltip handling ──
        const villageTooltipEl = document.getElementById('villageTooltip');
        const villageCanvasEl = document.getElementById('villageCanvas');

        function getHoveredTerritory(mx, my) {
            const canvas = villageCanvasEl;
            if (!canvas) return null;
            const territories = villageState.territories;
            const W = canvas.width;
            const H = canvas.height;

            for (const t of territories) {
                const pos = ISLAND_POSITIONS[t.id] || { x: 0.5, y: 0.5 };
                const radius = getIslandRadius(t.id);
                let jx = 0, jy = 0;
                for (let i = 0; i < t.id.length; i++) { jx += t.id.charCodeAt(i); jy += t.id.charCodeAt(i) * 3; }
                jx = (jx % 20) - 10;
                jy = (jy % 16) - 8;
                const cx = pos.x * W + jx;
                const cy = pos.y * H + jy;

                const dx = mx - cx;
                const dy = my - cy;
                // Elliptical hit test
                if ((dx * dx) / (radius * radius) + (dy * dy) / ((radius * 0.7) * (radius * 0.7)) < 1) {
                    return t;
                }
            }
            return null;
        }

        if (villageCanvasEl) {
            villageCanvasEl.addEventListener('mousemove', (e) => {
                const rect = villageCanvasEl.getBoundingClientRect();
                const scaleX = villageCanvasEl.width / rect.width;
                const scaleY = villageCanvasEl.height / rect.height;
                const mx = (e.clientX - rect.left) * scaleX;
                const my = (e.clientY - rect.top) * scaleY;

                const hovered = getHoveredTerritory(mx, my);

                if (hovered && villageTooltipEl) {
                    const design = getRoomDesign(hovered.id);
                    const trending = villageState.trendingData[hovered.id];
                    const articles = villageState.articlesByTerritory[hovered.id] || [];
                    const weatherEmoji = WEATHER_ICONS_VILLAGE[hovered.weather] || '\u2600\uFE0F';

                    let html = '<div style="font-weight:600; color:#fff; margin-bottom:4px;">' + design.emoji + ' ' + design.name + ' ' + weatherEmoji + '</div>';
                    html += '<div style="display:flex; gap:12px; margin-bottom:4px;">';
                    html += '<span>\uD83D\uDC64 ' + (trending?.active_agents || hovered.population || 0) + ' agents</span>';
                    html += '<span>\uD83D\uDCC4 ' + (trending?.fragments_24h || 0) + ' today</span>';
                    html += '</div>';
                    if (articles.length > 0) {
                        const title = articles[0].title.length > 50 ? articles[0].title.slice(0, 50) + '\u2026' : articles[0].title;
                        html += '<div style="color:rgb(212,166,86); font-size:0.75rem; margin-bottom:4px;">\uD83D\uDCDD ' + title + '</div>';
                    }
                    html += '<div style="font-size:0.7rem; color:#666;">Click to explore</div>';

                    villageTooltipEl.innerHTML = html;
                    villageTooltipEl.style.display = 'block';
                    villageTooltipEl.style.left = (e.clientX + 16) + 'px';
                    villageTooltipEl.style.top = (e.clientY - 10) + 'px';
                    villageCanvasEl.style.cursor = 'pointer';
                } else {
                    if (villageTooltipEl) villageTooltipEl.style.display = 'none';
                    if (villageCanvasEl) villageCanvasEl.style.cursor = 'default';
                }
            });

            villageCanvasEl.addEventListener('mouseleave', () => {
                if (villageTooltipEl) villageTooltipEl.style.display = 'none';
            });

            // Click to open detail
            villageCanvasEl.addEventListener('click', (e) => {
                const rect = villageCanvasEl.getBoundingClientRect();
                const scaleX = villageCanvasEl.width / rect.width;
                const scaleY = villageCanvasEl.height / rect.height;
                const mx = (e.clientX - rect.left) * scaleX;
                const my = (e.clientY - rect.top) * scaleY;
                const hovered = getHoveredTerritory(mx, my);
                if (hovered) openDetail(hovered.id);
            });
        }

        // ── Animation loop ──
        let villageLastDraw = 0;
        function villageAnimLoop(ts) {
            villageState.animFrame++;
            if (ts - villageLastDraw > 80) {
                drawVillageMap();
                villageLastDraw = ts;
            }
            requestAnimationFrame(villageAnimLoop);
        }
        requestAnimationFrame(villageAnimLoop);

        // ── Hook renderTerritories to update village state ──
        const _origRenderTerritories = renderTerritories;
        renderTerritories = function(territories) {
            _origRenderTerritories(territories);
            if (territories && Array.isArray(territories)) {
                villageState.territories = territories.map(t => ({
                    id: t.id,
                    name: t.name || t.id,
                    population: t.population || 0,
                    activity_1h: t.activity_1h || 0,
                    weather: weatherData[t.id]?.weather?.state || 'calm'
                }));
            }
        };

        // ── Fetch enhanced village data (trending, articles, flow) ──
        async function fetchVillageEnhancements() {
            try {
                const [trendingRes, articlesRes, flowRes] = await Promise.all([
                    fetch('/api/territories/trending?limit=15').catch(() => null),
                    fetch('/api/articles?limit=30').catch(() => null),
                    fetch('/api/graph/flow').catch(() => null)
                ]);

                // Trending data
                if (trendingRes && trendingRes.ok) {
                    const trendingData = await trendingRes.json();
                    if (trendingData.trending) {
                        trendingData.trending.forEach(t => {
                            villageState.trendingData[t.id] = {
                                heat_score: t.heat_score || 0,
                                active_agents: t.active_agents || 0,
                                fragments_24h: t.fragments_24h || 0
                            };
                        });
                    }
                }

                // Articles grouped by territory
                if (articlesRes && articlesRes.ok) {
                    const articlesData = await articlesRes.json();
                    villageState.articlesByTerritory = {};
                    if (articlesData.articles) {
                        articlesData.articles.forEach(a => {
                            if (a.territory_id) {
                                if (!villageState.articlesByTerritory[a.territory_id]) {
                                    villageState.articlesByTerritory[a.territory_id] = [];
                                }
                                villageState.articlesByTerritory[a.territory_id].push(a);
                            }
                        });
                    }
                }

                // Flow connections — aggregate per territory pair
                if (flowRes && flowRes.ok) {
                    const flowData = await flowRes.json();
                    const pairWeights = {};
                    if (flowData.territories) {
                        // Build domain vectors per territory
                        const domainVectors = {};
                        flowData.territories.forEach(t => {
                            domainVectors[t.id] = t.domains || {};
                        });

                        // Calculate shared domain overlap as connection weight
                        const ids = Object.keys(domainVectors);
                        for (let i = 0; i < ids.length; i++) {
                            for (let j = i + 1; j < ids.length; j++) {
                                const a = domainVectors[ids[i]];
                                const b = domainVectors[ids[j]];
                                let sharedWeight = 0;
                                for (const domain of Object.keys(a)) {
                                    if (b[domain]) sharedWeight += Math.min(a[domain], b[domain]);
                                }
                                if (sharedWeight > 0) {
                                    const key = ids[i] + '|' + ids[j];
                                    pairWeights[key] = sharedWeight;
                                }
                            }
                        }
                    }

                    // Sort and take top 12
                    villageState.flowConnections = Object.entries(pairWeights)
                        .map(([key, weight]) => {
                            const [from, to] = key.split('|');
                            return { from, to, weight };
                        })
                        .sort((a, b) => b.weight - a.weight)
                        .slice(0, 12);
                }
            } catch (e) {
                console.log('Village enhancements fetch error:', e);
            }
        }

        // Fetch enhancements after initial load, then every 60s
        setTimeout(fetchVillageEnhancements, 1500);
        setInterval(fetchVillageEnhancements, 60000);

        // ── Zoom button ──
        const zoomBtn = document.getElementById('zoomOutBtn');
        if (zoomBtn) {
            zoomBtn.addEventListener('click', () => {
                villageState.zoomLevel = villageState.zoomLevel < 1.0 ? 1.2 : villageState.zoomLevel < 1.4 ? 1.6 : 0.85;
                zoomBtn.textContent = villageState.zoomLevel > 1.4 ? '\uD83D\uDD0D Closer' : villageState.zoomLevel > 1.0 ? '\uD83D\uDD0D Reset' : '\uD83D\uDD0D Zoom In';
            });
        }

        // roundRect polyfill
        if (!CanvasRenderingContext2D.prototype.roundRect) {
            CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
                const rr = Math.min(r || 0, w / 2, h / 2);
                this.moveTo(x + rr, y);
                this.arcTo(x + w, y, x + w, y + h, rr);
                this.arcTo(x + w, y + h, x, y + h, rr);
                this.arcTo(x, y + h, x, y, rr);
                this.arcTo(x, y, x + w, y, rr);
                this.closePath();
            };
        }`;

html = html.substring(0, startIdx) + NEW_VILLAGE_JS + html.substring(endOfBlock);
console.log('[B1c] Village JS completely replaced (organic layout, bridges, tooltips, glow, articles, clouds)');

// B2: Add article count badge to territory cards stats row
// Find the stats row in renderTerritories — the line that creates the Agents/Contributions/This Hour stats
const OLD_STATS_ROW = `<div class="stats-row">
                            <div class="stat-item">
                                <span class="stat-value" style="color: \${t.color};">\${t.population}</span>
                                <span class="stat-label">Agents</span>
                            </div>
                            <div class="stat-item">
                                <span class="stat-value" style="color: \${t.color};">\${t.fragments}</span>
                                <span class="stat-label">Contributions</span>
                            </div>
                            <div class="stat-item">
                                <span class="stat-value" style="color: \${t.color};">\${t.activity_1h}</span>
                                <span class="stat-label">This Hour</span>
                            </div>
                        </div>`;

const NEW_STATS_ROW = `<div class="stats-row">
                            <div class="stat-item">
                                <span class="stat-value" style="color: \${t.color};">\${t.population}</span>
                                <span class="stat-label">Agents</span>
                            </div>
                            <div class="stat-item">
                                <span class="stat-value" style="color: \${t.color};">\${t.fragments}</span>
                                <span class="stat-label">Contributions</span>
                            </div>
                            <div class="stat-item">
                                <span class="stat-value" style="color: \${t.color};">\${t.activity_1h}</span>
                                <span class="stat-label">This Hour</span>
                            </div>
                        </div>
                        <div id="articles-\${t.id}" style="display:none; text-align:center; padding:4px 0;">
                            <a href="/articles?territory=\${t.id}" style="font-size:0.7rem; color:rgb(212,166,86); text-decoration:none; opacity:0.8;">\u{1F4DD} <span class="article-count">0</span> articles</a>
                        </div>`;

if (html.indexOf(OLD_STATS_ROW) === -1) {
  console.error('[B2] ERROR: Could not find stats-row in renderTerritories');
  console.error('[B2] Looking for stat-item with population...');
  // Non-fatal — article badges will still load via the claims-layer script approach
} else {
  html = html.replace(OLD_STATS_ROW, NEW_STATS_ROW);
  console.log('[B2] Article count badge added to territory cards');
}

// B3: Add recent articles section to openDetail overlay
// Find the "Residents" section header in openDetail and add articles after residents section
// We'll inject a new section that loads articles when the detail opens

// Find the claims layer script at the end and extend it with article loading
const OLD_CLAIMS_SCRIPT_END = `    // Load claims after territories render (with delay for DOM to settle)
    setTimeout(loadTerritoryClaims, 2000);
    // Refresh claims every 5 minutes
    setInterval(loadTerritoryClaims, 300000);`;

const NEW_CLAIMS_SCRIPT_END = `    // Load claims after territories render (with delay for DOM to settle)
    setTimeout(loadTerritoryClaims, 2000);
    // Refresh claims every 5 minutes
    setInterval(loadTerritoryClaims, 300000);

    // ── Article counts per territory card ──
    async function loadTerritoryArticleCounts() {
        try {
            const res = await fetch('/api/articles?limit=200');
            if (!res.ok) return;
            const data = await res.json();
            const counts = {};
            (data.articles || []).forEach(a => {
                if (a.territory_id) counts[a.territory_id] = (counts[a.territory_id] || 0) + 1;
            });
            Object.entries(counts).forEach(([tid, count]) => {
                const el = document.getElementById('articles-' + tid);
                if (el) {
                    el.style.display = 'flex';
                    const span = el.querySelector('.article-count');
                    if (span) span.textContent = count;
                }
            });
        } catch (e) { console.log('Article counts error:', e); }
    }
    setTimeout(loadTerritoryArticleCounts, 2500);

    // ── Inject articles section into detail overlay ──
    const _origOpenDetail = openDetail;
    openDetail = async function(id) {
        await _origOpenDetail(id);
        // After detail renders, inject articles section
        try {
            const articlesRes = await fetch('/api/articles?territory_id=' + encodeURIComponent(id) + '&limit=5');
            if (!articlesRes.ok) return;
            const articlesData = await articlesRes.json();
            const articles = articlesData.articles || [];
            if (articles.length === 0) return;

            const detailContent = document.querySelector('#detail .detail-content');
            if (!detailContent) return;

            // Find residents section and insert after it
            const sections = detailContent.querySelectorAll('.detail-section');
            let insertAfter = sections.length > 0 ? sections[0] : null;

            const articleSection = document.createElement('div');
            articleSection.className = 'detail-section';
            articleSection.innerHTML = '<h3 style="font-size:0.75rem; letter-spacing:0.1em; text-transform:uppercase; color:#666; margin-bottom:12px; display:flex; align-items:center; gap:6px;"><span style="color:rgb(212,166,86);">\\u{1F4DD}</span> Recent Articles</h3>' +
                articles.map(a => {
                    const typeColors = { territory: '#45B8AC', digest: '#d4a656', anomaly: '#e8567a' };
                    const typeColor = typeColors[a.article_type] || '#888';
                    const dateStr = a.published_at ? new Date(a.published_at).toLocaleDateString() : '';
                    return '<a href="/articles/' + (a.slug || a.id) + '" style="display:block; text-decoration:none; padding:10px 12px; margin-bottom:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-radius:8px; transition:border-color 0.2s;" onmouseover="this.style.borderColor=\\'rgba(212,166,86,0.3)\\'" onmouseout="this.style.borderColor=\\'rgba(255,255,255,0.06)\\'">' +
                        '<div style="display:flex; justify-content:space-between; align-items:start; gap:8px;">' +
                        '<div style="flex:1; min-width:0;">' +
                        '<div style="color:#ddd; font-size:0.85rem; font-weight:500; margin-bottom:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + (a.title || 'Untitled') + '</div>' +
                        (a.excerpt ? '<div style="color:#777; font-size:0.75rem; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">' + a.excerpt.slice(0, 120) + '</div>' : '') +
                        '</div>' +
                        '<div style="flex-shrink:0; display:flex; flex-direction:column; align-items:flex-end; gap:3px;">' +
                        '<span style="font-size:0.65rem; padding:2px 6px; border-radius:4px; background:' + typeColor + '22; color:' + typeColor + '; text-transform:uppercase; letter-spacing:0.05em;">' + (a.article_type || 'article') + '</span>' +
                        '<span style="font-size:0.65rem; color:#555;">' + dateStr + '</span>' +
                        '</div></div></a>';
                }).join('');

            if (insertAfter && insertAfter.nextSibling) {
                detailContent.insertBefore(articleSection, insertAfter.nextSibling);
            } else {
                detailContent.appendChild(articleSection);
            }
        } catch (e) { console.log('Detail articles error:', e); }
    };`;

if (html.indexOf(OLD_CLAIMS_SCRIPT_END) === -1) {
  console.error('[B3] ERROR: Could not find claims script end marker');
  // Non-fatal — try to continue
  console.log('[B3] WARN: Article injection not added (claims script marker not found)');
} else {
  html = html.replace(OLD_CLAIMS_SCRIPT_END, NEW_CLAIMS_SCRIPT_END);
  console.log('[B3] Article count badges + detail overlay articles section added');
}

// Remove the old fetchAgentPositions and SSE code since we no longer use agent_locations-based sprites
const OLD_FETCH_AGENTS = `        // Fetch agent positions from world state
        async function fetchAgentPositions() {
            try {
                const res = await fetch('/api/worlds/mdi-prime/state');
                if (!res.ok) return;
                const data = await res.json();
                if (data && Array.isArray(data.occupants)) {
                    // Map agents to their territories based on tile position
                    const mapRes = await fetch('/api/worlds/mdi-prime/map');
                    const mapData = mapRes.ok ? await mapRes.json() : null;
                    const tiles = mapData?.tiles || [];

                    villageState.agents = data.occupants.map(agent => {
                        // Find which territory this agent is in
                        const tile = tiles.find(t => t.x === agent.x && t.y === agent.y);
                        return {
                            agent_name: agent.agent_name,
                            territory_id: tile?.territory_id || 'the-commons',
                            x: agent.x,
                            y: agent.y,
                            energy: agent.energy || 0
                        };
                    });
                }
            } catch (e) {
                console.log('Could not fetch agent positions:', e);
            }
        }

        // SSE streaming for real-time updates
        let eventSource = null;
        function connectSSE() {
            if (eventSource) eventSource.close();
            try {
                eventSource = new EventSource('/api/worlds/mdi-prime/events?stream=sse');
                eventSource.onmessage = (ev) => {
                    try {
                        const event = JSON.parse(ev.data);
                        if (event.event_type === 'move' || event.event_type === 'spawn') {
                            fetchAgentPositions();
                        }
                    } catch (e) {}
                };
                eventSource.onerror = () => {
                    setTimeout(connectSSE, 5000);
                };
            } catch (e) {}
        }
        connectSSE();`;

if (html.indexOf(OLD_FETCH_AGENTS) !== -1) {
  html = html.replace(OLD_FETCH_AGENTS, '        // Agent positions now rendered as dots based on trending data (no SSE needed)');
  console.log('[B4] Removed old fetchAgentPositions + SSE code (replaced by trending-based dots)');
} else {
  console.log('[B4] SKIP: Old fetchAgentPositions code not found (may have been previously modified)');
}

// Write the result
fs.writeFileSync(TERRITORIES_PATH, html);
console.log('\n[B] territories.html saved.');

console.log('\n=== PATCH COMPLETE ===');
console.log('Restart server: pm2 restart mydeadinternet');
console.log('Verify: curl -s http://localhost:3851/api/world | python3 -m json.tool | head -20');
console.log('Rollback: cp server.js.bak-village server.js && cp territories.html.bak-village territories.html && pm2 restart mydeadinternet');

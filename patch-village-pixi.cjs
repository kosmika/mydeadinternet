#!/usr/bin/env node
// Phase Village v2: PixiJS Upgrade Patch
// Replaces Canvas2D village map with GPU-accelerated PixiJS + pixi-viewport
//
// Targets: territories.html
// Changes:
//   1. Insert PixiJS + pixi-viewport CDN scripts before </head>
//   2. Replace <canvas> HTML block with <div id="village-pixi-container">
//   3. Replace entire Canvas2D village JS with PixiJS implementation
//   4. Update .territory-detail CSS to sidebar layout
//   5. Rename zoom button to Reset View
//   6. Widen village-map-section container

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'territories.html');
// If running from repo root (deployed via scp), check current dir too
const filePath = fs.existsSync(FILE) ? FILE : path.join(process.cwd(), 'territories.html');

if (!fs.existsSync(filePath)) {
    console.error('ERROR: territories.html not found at', filePath);
    process.exit(1);
}

let html = fs.readFileSync(filePath, 'utf8');
const originalLength = html.length;
let changeCount = 0;

function patch(marker, replacement, description, options = {}) {
    const { mode = 'replace', endMarker = null } = options;

    if (mode === 'insert-before') {
        const idx = html.indexOf(marker);
        if (idx === -1) {
            console.warn(`  SKIP: marker not found for "${description}"`);
            return false;
        }
        html = html.slice(0, idx) + replacement + html.slice(idx);
        changeCount++;
        console.log(`  OK: ${description}`);
        return true;
    }

    if (mode === 'replace-between') {
        const startIdx = html.indexOf(marker);
        if (startIdx === -1) {
            console.warn(`  SKIP: start marker not found for "${description}"`);
            return false;
        }
        const endIdx = html.indexOf(endMarker, startIdx);
        if (endIdx === -1) {
            console.warn(`  SKIP: end marker not found for "${description}"`);
            return false;
        }
        html = html.slice(0, startIdx) + replacement + html.slice(endIdx + endMarker.length);
        changeCount++;
        console.log(`  OK: ${description}`);
        return true;
    }

    // Default: simple string replace (first occurrence)
    const idx = html.indexOf(marker);
    if (idx === -1) {
        console.warn(`  SKIP: marker not found for "${description}"`);
        return false;
    }
    html = html.slice(0, idx) + replacement + html.slice(idx + marker.length);
    changeCount++;
    console.log(`  OK: ${description}`);
    return true;
}

console.log('Phase Village v2: PixiJS Upgrade');
console.log('================================');
console.log(`File: ${filePath} (${originalLength} bytes)`);
console.log('');

// ─────────────────────────────────────────────
// PATCH 1: Insert CDN scripts before </head>
// ─────────────────────────────────────────────
console.log('[1/6] CDN scripts...');
patch(
    '</head>',
    `    <script src="https://cdn.jsdelivr.net/npm/pixi.js@7.4.3/dist/pixi.min.js"><\/script>
    <script src="https://cdn.jsdelivr.net/npm/pixi-viewport@4.38.0/dist/viewport.min.js"><\/script>
</head>`,
    'Insert PixiJS + pixi-viewport CDN'
);

// ─────────────────────────────────────────────
// PATCH 2: Replace canvas HTML block
// ─────────────────────────────────────────────
console.log('[2/6] Canvas HTML...');

const oldCanvasBlock = `                <canvas id="villageCanvas" width="1200" height="680" style="width: 100%; border-radius: 12px; background: linear-gradient(180deg, #0a1628 0%, #0d253a 30%, #1a3a5c 70%, #0d253a 100%);"></canvas>
                <div id="villageTooltip" style="display:none; position:fixed; z-index:1000; pointer-events:none; background:rgba(10,10,20,0.95); border:1px solid rgba(255,255,255,0.15); border-radius:12px; padding:12px 16px; font-size:0.85rem; color:#ccc; max-width:280px; backdrop-filter:blur(12px); box-shadow:0 6px 30px rgba(0,0,0,0.6);"></div>`;

const newCanvasBlock = `                <div id="village-pixi-container" style="width: 100%; border-radius: 12px; overflow: hidden; background: linear-gradient(180deg, #0a1628 0%, #0d253a 30%, #1a3a5c 70%, #0d253a 100%); position: relative; min-height: 400px;"></div>
                <div id="villageTooltip" style="display:none; position:fixed; z-index:1000; pointer-events:none; background:rgba(10,10,20,0.95); border:1px solid rgba(255,255,255,0.15); border-radius:12px; padding:12px 16px; font-size:0.85rem; color:#ccc; max-width:280px; backdrop-filter:blur(12px); box-shadow:0 6px 30px rgba(0,0,0,0.6);"></div>`;

patch(oldCanvasBlock, newCanvasBlock, 'Replace canvas with pixi container');

// ─────────────────────────────────────────────
// PATCH 3: Update hint text and zoom button
// ─────────────────────────────────────────────
console.log('[3/6] Hint + zoom button...');

patch(
    `<span class="village-hint" style="font-size:0.7rem; color:#444;">Island size = activity</span>`,
    `<span class="village-hint" style="font-size:0.7rem; color:#444;">Scroll to zoom, drag to pan</span>`,
    'Update hint text'
);

patch(
    `<button id="zoomOutBtn" style="padding: 6px 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #a0a0a0; font-size: 0.75rem; cursor: pointer;">🔍 Zoom</button>`,
    `<button id="zoomResetBtn" style="padding: 6px 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #a0a0a0; font-size: 0.75rem; cursor: pointer;">🔍 Reset View</button>`,
    'Rename zoom button to Reset View'
);

// ─────────────────────────────────────────────
// PATCH 4: Widen container
// ─────────────────────────────────────────────
console.log('[4/6] Widen container...');
patch(
    `<div class="village-map-section" style="max-width: 900px; margin: 1rem auto; padding: 0;">`,
    `<div class="village-map-section" style="max-width: 1200px; margin: 1rem auto; padding: 0;">`,
    'Widen village-map-section to 1200px'
);

// ─────────────────────────────────────────────
// PATCH 5: Update detail CSS to sidebar
// ─────────────────────────────────────────────
console.log('[5/6] Detail sidebar CSS...');

const oldDetailCSS = `        /* Detail Overlay */
        .territory-detail {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(5, 5, 5, 0.98);
            z-index: 1000;
            overflow-y: auto;
            padding: 40px 20px;
            backdrop-filter: blur(20px);
        }

        .territory-detail.active { display: block; }`;

const newDetailCSS = `        /* Detail Sidebar */
        .territory-detail {
            position: fixed;
            top: 0; right: 0; bottom: 0;
            width: 520px; max-width: 92vw;
            background: rgba(5, 5, 5, 0.98);
            z-index: 1000;
            overflow-y: auto;
            padding: 40px 20px;
            backdrop-filter: blur(20px);
            transform: translateX(100%);
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: -8px 0 40px rgba(0,0,0,0.5);
        }

        .territory-detail.active { transform: translateX(0); }`;

patch(oldDetailCSS, newDetailCSS, 'Update detail to sidebar layout');

// ─────────────────────────────────────────────
// PATCH 6: Replace entire village JS block
// ─────────────────────────────────────────────
console.log('[6/6] Village JS (PixiJS implementation)...');

// The village JS starts at the ISLAND VILLAGE MAP RENDERER comment and ends at the roundRect polyfill
const villageJsStart = `        // ============================================
        // ISLAND VILLAGE MAP RENDERER
        // ============================================

        // ============================================
        // ISLAND VILLAGE MAP RENDERER v2 — Enhanced
        // ============================================`;

const villageJsEnd = `        // roundRect polyfill
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

const pixiJS = getPixiJSCode();

patch(
    villageJsStart,
    pixiJS,
    'Replace Canvas2D with PixiJS implementation',
    { mode: 'replace-between', endMarker: villageJsEnd }
);

// Also update the mobile CSS that references old #villageCanvas
patch(
    `            #villageCanvas {
                border-radius: 8px !important;
                min-height: 300px;
            }`,
    `            #village-pixi-container {
                border-radius: 8px !important;
                min-height: 250px;
            }
            #village-pixi-container canvas {
                border-radius: 8px !important;
            }`,
    'Update mobile CSS selector'
);

// ─────────────────────────────────────────────
// Write result
// ─────────────────────────────────────────────
console.log('');
console.log(`Applied ${changeCount} patches`);
console.log(`Size: ${originalLength} → ${html.length} bytes`);

fs.writeFileSync(filePath, html, 'utf8');
console.log('Written to', filePath);
console.log('Done.');


// ═══════════════════════════════════════════════
// PixiJS Implementation Code
// ═══════════════════════════════════════════════
function getPixiJSCode() {
return String.raw`        // ============================================
        // ISLAND VILLAGE MAP — PixiJS v7 + pixi-viewport
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

        const ISLAND_POSITIONS = {
            'the-signal':     { x: 0.50, y: 0.12 },
            'the-forge':      { x: 0.17, y: 0.20 },
            'the-void':       { x: 0.83, y: 0.18 },
            'the-agora':      { x: 0.34, y: 0.35 },
            'the-archive':    { x: 0.66, y: 0.33 },
            'the-commons':    { x: 0.12, y: 0.48 },
            'the-seam':       { x: 0.50, y: 0.48 },
            'the-synapse':    { x: 0.87, y: 0.46 },
            'the-greenhouse': { x: 0.26, y: 0.62 },
            'the-chapel':     { x: 0.73, y: 0.60 },
            'the-threshold':  { x: 0.42, y: 0.73 },
            'the-ossuary':    { x: 0.60, y: 0.76 },
            'adri':           { x: 0.16, y: 0.80 },
            'ari':            { x: 0.82, y: 0.78 },
            'kamae-dojo':     { x: 0.50, y: 0.90 }
        };

        const WEATHER_ICONS_VILLAGE = { calm: '\u2600\uFE0F', turbulent: '\uD83C\uDF2A\uFE0F', storm: '\u26C8\uFE0F', ethereal: '\u2728', frozen: '\u2744\uFE0F' };

        let villageState = {
            animFrame: 0,
            territories: [],
            agents: [],
            trendingData: {},
            articlesByTerritory: {},
            flowConnections: [],
            cloudPositions: [
                { x: 0.1, y: 0.08, w: 120, speed: 0.15 },
                { x: 0.5, y: 0.05, w: 90, speed: 0.1 },
                { x: 0.8, y: 0.12, w: 100, speed: 0.12 }
            ]
        };

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

        function getIslandRadius(territoryId) {
            const trending = villageState.trendingData[territoryId];
            if (!trending) return 32;
            const maxHeat = Math.max(...Object.values(villageState.trendingData).map(t => t.heat_score || 0), 1);
            const ratio = (trending.heat_score || 0) / maxHeat;
            return 32 + ratio * 38;
        }

        function getActiveAgents(territoryId) {
            return villageState.trendingData[territoryId]?.active_agents || 0;
        }

        function shadeColor(color, amount) {
            let r = parseInt(color.slice(1, 3), 16) + amount;
            let g = parseInt(color.slice(3, 5), 16) + amount;
            let b = parseInt(color.slice(5, 7), 16) + amount;
            r = Math.max(0, Math.min(255, r));
            g = Math.max(0, Math.min(255, g));
            b = Math.max(0, Math.min(255, b));
            return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
        }

        function hexToNum(hex) {
            return parseInt((hex || '#888888').replace('#', ''), 16);
        }

        // ── PixiJS Application ──
        const WORLD_W = 2000;
        const WORLD_H = 1400;
        let pixiApp = null;
        let viewport = null;
        let layerWater, layerClouds, layerBridges, layerIslands, layerAgents, layerUI;
        let islandContainers = {};
        let buildingTextureCache = {};
        let waterBgSprite = null;

        // CDN fallback check
        if (typeof PIXI === 'undefined' || typeof pixi_viewport === 'undefined') {
            const container = document.getElementById('village-pixi-container');
            if (container) {
                container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:400px;color:#666;font-size:0.9rem;text-align:center;padding:2rem;">Map requires WebGL. Try a modern browser.</div>';
            }
        } else {
            initPixiApp();
        }

        function initPixiApp() {
            const container = document.getElementById('village-pixi-container');
            if (!container) return;

            const containerW = container.clientWidth || 900;
            const aspectRatio = WORLD_H / WORLD_W;
            const containerH = Math.round(containerW * aspectRatio);
            container.style.height = containerH + 'px';

            pixiApp = new PIXI.Application({
                width: containerW,
                height: containerH,
                backgroundColor: 0x0a1628,
                resolution: window.devicePixelRatio || 1,
                autoDensity: true,
                antialias: true,
                powerPreference: 'high-performance'
            });

            container.appendChild(pixiApp.view);
            pixiApp.view.style.width = '100%';
            pixiApp.view.style.height = '100%';
            pixiApp.view.style.borderRadius = '12px';

            // Create viewport
            const Viewport = pixi_viewport.Viewport;
            viewport = new Viewport({
                screenWidth: containerW,
                screenHeight: containerH,
                worldWidth: WORLD_W,
                worldHeight: WORLD_H,
                events: pixiApp.renderer.events
            });

            pixiApp.stage.addChild(viewport);

            viewport
                .drag()
                .pinch()
                .wheel()
                .decelerate({ friction: 0.92 })
                .clampZoom({ minScale: 0.3, maxScale: 3.0 })
                .clamp({ direction: 'all' });

            viewport.fit();
            viewport.moveCenter(WORLD_W / 2, WORLD_H / 2);

            // Create layers
            layerWater = new PIXI.Container();
            layerClouds = new PIXI.Container();
            layerBridges = new PIXI.Container();
            layerIslands = new PIXI.Container();
            layerAgents = new PIXI.Container();
            layerUI = new PIXI.Container();

            viewport.addChild(layerWater);
            viewport.addChild(layerClouds);
            viewport.addChild(layerBridges);
            viewport.addChild(layerIslands);
            viewport.addChild(layerAgents);
            viewport.addChild(layerUI);

            // Draw static water background
            drawWaterBackground();

            // Mobile FPS cap
            if (window.innerWidth < 768) {
                pixiApp.ticker.maxFPS = 30;
            }

            // Animation ticker
            pixiApp.ticker.add(tickerCallback);

            // Resize handler
            let resizeTimer;
            window.addEventListener('resize', () => {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => {
                    const w = container.clientWidth || 900;
                    const h = Math.round(w * (WORLD_H / WORLD_W));
                    container.style.height = h + 'px';
                    pixiApp.renderer.resize(w, h);
                    viewport.resize(w, h, WORLD_W, WORLD_H);
                    viewport.fit();
                    viewport.moveCenter(WORLD_W / 2, WORLD_H / 2);
                }, 200);
            });

            // Click on empty space closes detail
            viewport.on('clicked', (e) => {
                if (!e.event.target || e.event.target === pixiApp.view) {
                    closeDetail();
                }
            });

            // Reset View button
            const resetBtn = document.getElementById('zoomResetBtn');
            if (resetBtn) {
                resetBtn.addEventListener('click', () => {
                    viewport.fit();
                    viewport.moveCenter(WORLD_W / 2, WORLD_H / 2);
                });
            }
        }

        // ── Water background (draw once) ──
        function drawWaterBackground() {
            if (!pixiApp) return;
            const canvas = document.createElement('canvas');
            canvas.width = WORLD_W;
            canvas.height = WORLD_H;
            const ctx = canvas.getContext('2d');

            const grad = ctx.createRadialGradient(WORLD_W * 0.5, WORLD_H * 0.5, 50, WORLD_W * 0.5, WORLD_H * 0.5, WORLD_W * 0.6);
            grad.addColorStop(0, '#1e4a6e');
            grad.addColorStop(0.5, '#153a5a');
            grad.addColorStop(1, '#0a1e35');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, WORLD_W, WORLD_H);

            const tex = PIXI.Texture.from(canvas);
            waterBgSprite = new PIXI.Sprite(tex);
            waterBgSprite.width = WORLD_W;
            waterBgSprite.height = WORLD_H;
            layerWater.addChild(waterBgSprite);
        }

        // ── Build all islands from data ──
        function buildIslands() {
            if (!pixiApp || !viewport) return;

            const territories = villageState.territories;
            if (!territories.length) return;

            // Clear existing
            layerIslands.removeChildren();
            layerBridges.removeChildren();
            layerUI.removeChildren();
            layerAgents.removeChildren();
            layerClouds.removeChildren();
            islandContainers = {};

            const tooltipEl = document.getElementById('villageTooltip');

            // Pre-calculate positions
            const positions = {};
            territories.forEach(t => {
                const pos = ISLAND_POSITIONS[t.id] || { x: 0.5, y: 0.5 };
                const radius = getIslandRadius(t.id);
                let jx = 0, jy = 0;
                for (let i = 0; i < t.id.length; i++) { jx += t.id.charCodeAt(i); jy += t.id.charCodeAt(i) * 3; }
                jx = (jx % 20) - 10;
                jy = (jy % 16) - 8;
                positions[t.id] = {
                    cx: pos.x * WORLD_W + jx,
                    cy: pos.y * WORLD_H + jy,
                    radius
                };
            });

            // Build bridges
            rebuildBridges(positions);

            // Build each island
            territories.forEach(t => {
                const ip = positions[t.id];
                if (!ip) return;
                const { cx, cy, radius } = ip;
                const design = getRoomDesign(t.id);
                const activeAgents = getActiveAgents(t.id);
                const trending = villageState.trendingData[t.id];

                const island = new PIXI.Container();
                island.x = cx;
                island.y = cy;
                island.interactive = true;
                island.cursor = 'pointer';
                island.hitArea = new PIXI.Ellipse(0, 0, radius * 0.9, radius * 0.65);

                // Glow ellipse (animated on hover)
                const glow = new PIXI.Graphics();
                glow.beginFill(hexToNum(design.accentColor), 0.08);
                glow.drawEllipse(0, 0, radius * 1.4, radius * 1.1);
                glow.endFill();
                glow.alpha = (t.activity_1h > 0 || (trending && trending.fragments_24h > 10)) ? 0.6 : 0.15;
                island._glow = glow;
                island._glowBase = glow.alpha;
                island.addChild(glow);

                // Shadow
                const shadow = new PIXI.Graphics();
                shadow.beginFill(0x000000, 0.35);
                shadow.drawEllipse(0, radius * 0.3, radius * 0.85, radius * 0.3);
                shadow.endFill();
                island.addChild(shadow);

                // Ground
                const ground = new PIXI.Graphics();
                ground.beginFill(hexToNum(design.groundColor));
                ground.drawEllipse(0, 0, radius * 0.8, radius * 0.55);
                ground.endFill();
                // Lighter center highlight
                ground.beginFill(hexToNum(shadeColor(design.groundColor, 20)), 0.4);
                ground.drawEllipse(-radius * 0.15, -radius * 0.1, radius * 0.4, radius * 0.3);
                ground.endFill();
                island.addChild(ground);

                // Shoreline
                const shore = new PIXI.Graphics();
                shore.lineStyle(1.5, 0x64b4dc, 0.2);
                shore.drawEllipse(0, 0, radius * 0.82, radius * 0.57);
                island.addChild(shore);

                // Building
                const buildingG = new PIXI.Graphics();
                const bScale = radius / 70;
                drawMiniBuildingPixi(buildingG, design, bScale);
                buildingG.y = -radius * 0.1;
                island._buildingG = buildingG;
                island.addChild(buildingG);

                // Agent dots container
                const agentDots = new PIXI.Container();
                if (activeAgents > 0) {
                    const dotCount = Math.min(activeAgents, 20);
                    for (let d = 0; d < dotCount; d++) {
                        const dot = new PIXI.Graphics();
                        const colorHex = SPRITE_COLORS[(d * 7) % SPRITE_COLORS.length];
                        dot.beginFill(hexToNum(colorHex));
                        dot.drawCircle(0, 0, 2.5);
                        dot.endFill();
                        dot._angle = (d / dotCount) * Math.PI * 2;
                        dot._orbitRx = radius * 0.65;
                        dot._orbitRy = radius * 0.45;
                        agentDots.addChild(dot);
                    }
                }
                island._agentDots = agentDots;
                island.addChild(agentDots);

                // Weather effects container
                const weatherFx = new PIXI.Container();
                island._weatherFx = weatherFx;
                island._weather = t.weather || 'calm';
                buildWeatherEffects(weatherFx, t.weather, radius);
                island.addChild(weatherFx);

                // Store metadata
                island._tId = t.id;
                island._design = design;
                island._radius = radius;
                island._trending = trending;
                island._activeAgents = activeAgents;

                // Hover events
                island.on('pointerover', (e) => {
                    island._hovered = true;
                    showTooltip(t, design, trending, e.data?.global || { x: 0, y: 0 });
                });
                island.on('pointermove', (e) => {
                    if (island._hovered && tooltipEl) {
                        positionTooltip(e.data?.global || { x: 0, y: 0 });
                    }
                });
                island.on('pointerout', () => {
                    island._hovered = false;
                    hideTooltip();
                });
                island.on('pointertap', () => {
                    hideTooltip();
                    openDetail(t.id);
                });

                layerIslands.addChild(island);
                islandContainers[t.id] = island;

                // ── UI layer elements (labels, badges, weather emoji, tickers) ──

                // Label pill
                const labelW = Math.max(120, radius * 1.8);
                const labelBg = new PIXI.Graphics();
                labelBg.beginFill(0x000000, 0.75);
                labelBg.drawRoundedRect(-labelW / 2, -11, labelW, 24, 12);
                labelBg.endFill();
                labelBg.x = cx;
                labelBg.y = cy + radius * 0.42;
                layerUI.addChild(labelBg);

                const labelText = new PIXI.Text(design.emoji + ' ' + design.name, {
                    fontFamily: '"DM Sans", sans-serif',
                    fontSize: 12,
                    fontWeight: 'bold',
                    fill: 0xffffff,
                    align: 'center'
                });
                labelText.anchor.set(0.5, 0.5);
                labelText.x = cx;
                labelText.y = cy + radius * 0.42;
                layerUI.addChild(labelText);

                // Agent count bubble
                if (activeAgents > 0) {
                    const bubbleR = activeAgents > 99 ? 16 : 13;
                    const bubbleBg = new PIXI.Graphics();
                    bubbleBg.beginFill(0x5c8cff, 0.9);
                    bubbleBg.drawCircle(0, 0, bubbleR);
                    bubbleBg.endFill();
                    bubbleBg.x = cx + radius * 0.6;
                    bubbleBg.y = cy - radius * 0.4;
                    layerUI.addChild(bubbleBg);

                    const bubbleText = new PIXI.Text(
                        activeAgents > 999 ? Math.round(activeAgents / 100) / 10 + 'k' : String(activeAgents),
                        { fontFamily: 'sans-serif', fontSize: 11, fontWeight: 'bold', fill: 0xffffff, align: 'center' }
                    );
                    bubbleText.anchor.set(0.5, 0.5);
                    bubbleText.x = cx + radius * 0.6;
                    bubbleText.y = cy - radius * 0.4;
                    layerUI.addChild(bubbleText);
                }

                // Weather emoji
                const weatherEmoji = WEATHER_ICONS_VILLAGE[t.weather] || '\u2600\uFE0F';
                const weatherText = new PIXI.Text(weatherEmoji, {
                    fontSize: 20,
                    align: 'center'
                });
                weatherText.anchor.set(0.5, 0.5);
                weatherText.x = cx - radius * 0.6;
                weatherText.y = cy - radius * 0.35;
                layerUI.addChild(weatherText);

                // Article ticker
                const articles = villageState.articlesByTerritory[t.id];
                if (articles && articles.length > 0) {
                    const tickerText = new PIXI.Text('\uD83D\uDCDD ' + (articles[0].title || ''), {
                        fontFamily: '"DM Sans", sans-serif',
                        fontSize: 10,
                        fill: 0xd4a656,
                        align: 'left'
                    });
                    tickerText.alpha = 0.7;
                    tickerText.y = cy + radius * 0.42 + 20;
                    tickerText._scrollX = cx + labelW / 2;
                    tickerText._maxW = labelW + 30;
                    tickerText._cx = cx;
                    tickerText.x = tickerText._scrollX;

                    // Create a mask for the ticker
                    const tickerMask = new PIXI.Graphics();
                    tickerMask.beginFill(0xffffff);
                    tickerMask.drawRect(cx - (labelW + 30) / 2, cy + radius * 0.42 + 12, labelW + 30, 18);
                    tickerMask.endFill();
                    layerUI.addChild(tickerMask);
                    tickerText.mask = tickerMask;

                    layerUI.addChild(tickerText);
                    island._ticker = tickerText;
                }
            });

            // Build cloud sprites
            buildClouds();

            // Build fragment particle layer
            buildFragmentParticles(positions);
        }

        // ── Weather effects per island ──
        function buildWeatherEffects(container, weather, radius) {
            container.removeChildren();
            if (weather === 'storm') {
                for (let r = 0; r < 8; r++) {
                    const line = new PIXI.Graphics();
                    line.lineStyle(1, 0x78a0ff, 0.3);
                    line.moveTo(0, 0);
                    line.lineTo(-2, 8);
                    line._seedX = -radius * 0.4 + Math.random() * radius * 0.8;
                    line._seedOffset = r * 40;
                    line._radius = radius;
                    container.addChild(line);
                }
            } else if (weather === 'frozen') {
                const ring = new PIXI.Graphics();
                ring.lineStyle(2, 0xb4dcff, 0.2);
                // Draw dashed ellipse manually
                const steps = 40;
                for (let i = 0; i < steps; i += 2) {
                    const a1 = (i / steps) * Math.PI * 2;
                    const a2 = ((i + 1) / steps) * Math.PI * 2;
                    ring.moveTo(Math.cos(a1) * radius * 0.75, Math.sin(a1) * radius * 0.5);
                    ring.lineTo(Math.cos(a2) * radius * 0.75, Math.sin(a2) * radius * 0.5);
                }
                container.addChild(ring);
            } else if (weather === 'ethereal') {
                for (let s = 0; s < 5; s++) {
                    const sparkle = new PIXI.Graphics();
                    sparkle.beginFill(0xffe696, 0.4);
                    sparkle.drawCircle(0, 0, 2);
                    sparkle.endFill();
                    sparkle._sIdx = s;
                    sparkle._sRadius = radius * 0.45;
                    container.addChild(sparkle);
                }
            } else if (weather === 'turbulent') {
                for (let sw = 0; sw < 3; sw++) {
                    const swirl = new PIXI.Graphics();
                    swirl.lineStyle(1, 0xffb464, 0.15);
                    swirl._swIdx = sw;
                    swirl._radius = radius;
                    container.addChild(swirl);
                }
            }
        }

        // ── Clouds layer ──
        function buildClouds() {
            layerClouds.removeChildren();
            villageState.cloudPositions.forEach((cloud, ci) => {
                const c = new PIXI.Graphics();
                c.beginFill(0xc8dce0, 0.06);
                c.drawEllipse(0, 0, cloud.w * 0.5, 12);
                c.drawEllipse(-cloud.w * 0.2, -4, cloud.w * 0.3, 10);
                c.drawEllipse(cloud.w * 0.25, -2, cloud.w * 0.35, 11);
                c.endFill();
                c._cloud = cloud;
                c._ci = ci;
                layerClouds.addChild(c);
            });
        }

        // ── Fragment particles ──
        function buildFragmentParticles(positions) {
            layerAgents.removeChildren();
            villageState.territories.forEach(t => {
                const ip = positions[t.id];
                if (!ip) return;
                const trending = villageState.trendingData[t.id];
                const frags24 = trending ? trending.fragments_24h : 0;
                const particleCount = Math.min(12, Math.max(0, Math.floor(frags24 / 15)));
                for (let d = 0; d < particleCount; d++) {
                    const seed = t.id.charCodeAt(d % t.id.length) + d * 37;
                    const colorIdx = (seed + d * 7) % SPRITE_COLORS.length;
                    const dot = new PIXI.Graphics();
                    dot.beginFill(hexToNum(SPRITE_COLORS[colorIdx]));
                    dot.drawCircle(0, 0, 2.5);
                    dot.endFill();
                    dot._seed = seed;
                    dot._baseAngle = (seed % 360) * Math.PI / 180;
                    dot._dIdx = d;
                    dot._cx = ip.cx;
                    dot._cy = ip.cy;
                    dot._radius = ip.radius;
                    layerAgents.addChild(dot);
                }
            });
        }

        // ── Bridge connections ──
        function rebuildBridges(positions) {
            layerBridges.removeChildren();
            if (villageState.flowConnections.length === 0) return;

            const topConnections = villageState.flowConnections.slice(0, 12);
            const maxWeight = Math.max(...topConnections.map(c => c.weight), 1);

            topConnections.forEach((conn, ci) => {
                const from = positions[conn.from];
                const to = positions[conn.to];
                if (!from || !to) return;

                const strength = conn.weight / maxWeight;
                const bridgeWidth = 1.5 + strength * 3;

                // Draw dashed bezier
                const bridge = new PIXI.Graphics();
                bridge.lineStyle(bridgeWidth, 0x8b7355, 0.25 + strength * 0.35);

                const midX = (from.cx + to.cx) / 2;
                const midY = (from.cy + to.cy) / 2 - 25;

                // Approximate dashed curve with segments
                const steps = 30;
                for (let i = 0; i < steps; i += 2) {
                    const t1 = i / steps;
                    const t2 = (i + 1) / steps;
                    const x1 = (1 - t1) * (1 - t1) * from.cx + 2 * (1 - t1) * t1 * midX + t1 * t1 * to.cx;
                    const y1 = (1 - t1) * (1 - t1) * from.cy + 2 * (1 - t1) * t1 * midY + t1 * t1 * to.cy;
                    const x2 = (1 - t2) * (1 - t2) * from.cx + 2 * (1 - t2) * t2 * midX + t2 * t2 * to.cx;
                    const y2 = (1 - t2) * (1 - t2) * from.cy + 2 * (1 - t2) * t2 * midY + t2 * t2 * to.cy;
                    bridge.moveTo(x1, y1);
                    bridge.lineTo(x2, y2);
                }
                layerBridges.addChild(bridge);

                // Traffic dot
                const trafficDot = new PIXI.Graphics();
                trafficDot.beginFill(0xd4a656, 0.4 + strength * 0.4);
                trafficDot.drawCircle(0, 0, 2 + strength);
                trafficDot.endFill();
                trafficDot._from = from;
                trafficDot._to = to;
                trafficDot._midX = midX;
                trafficDot._midY = midY;
                trafficDot._ci = ci;
                layerBridges.addChild(trafficDot);
            });
        }

        // ── Draw building via PIXI.Graphics ──
        function drawMiniBuildingPixi(g, design, scale) {
            g.clear();
            const s = scale || 1;
            g.scale.set(s, s);

            const ac = hexToNum(design.accentColor);

            if (design.building === 'forge') {
                g.beginFill(0x444444); g.drawRect(-10, 0, 20, 10); g.endFill();
                g.beginFill(0xff6633);
                g.moveTo(-5, 0); g.lineTo(0, -10); g.lineTo(5, 0); g.closePath();
                g.endFill();
            } else if (design.building === 'columns') {
                g.beginFill(0xd4c8b8);
                for (let i = 0; i < 3; i++) g.drawRect(-12 + i * 10, -10, 4, 18);
                g.endFill();
                g.beginFill(0xd4c8b8);
                g.moveTo(-15, -10); g.lineTo(0, -18); g.lineTo(15, -10); g.closePath();
                g.endFill();
            } else if (design.building === 'library') {
                g.beginFill(0x5c4033); g.drawRect(-12, -8, 24, 16); g.endFill();
                const bookColors = [0xcc3333, 0x33cc33, 0x3333cc, 0xcccc33];
                for (let i = 0; i < 4; i++) {
                    g.beginFill(bookColors[i]); g.drawRect(-10 + i * 5, -6, 4, 10); g.endFill();
                }
            } else if (design.building === 'portal') {
                g.lineStyle(2, ac);
                g.drawCircle(0, 0, 13);
                g.drawCircle(0, 0, 6);
            } else if (design.building === 'gazebo') {
                g.beginFill(0x8B7355); g.drawRect(-2, -5, 4, 15); g.endFill();
                g.beginFill(0xa08060);
                g.moveTo(-15, -5); g.lineTo(0, -15); g.lineTo(15, -5); g.closePath();
                g.endFill();
            } else if (design.building === 'greenhouse') {
                g.beginFill(0xc8ffc8, 0.4);
                g.lineStyle(1, 0x90EE90);
                g.moveTo(-12, 8); g.lineTo(-12, -5); g.lineTo(0, -12); g.lineTo(12, -5); g.lineTo(12, 8);
                g.closePath();
                g.endFill();
            } else if (design.building === 'tower') {
                g.beginFill(0x3a5a7a); g.drawRect(-4, -15, 8, 22); g.endFill();
                g.beginFill(0x5a8aba);
                g.moveTo(-6, -15); g.lineTo(0, -22); g.lineTo(6, -15); g.closePath();
                g.endFill();
                g.beginFill(0x00ff88); g.drawCircle(0, -20, 2.5); g.endFill();
            } else if (design.building === 'gate') {
                g.beginFill(0x6a4050);
                g.drawRect(-12, -8, 6, 16);
                g.drawRect(6, -8, 6, 16);
                g.endFill();
                g.lineStyle(2, ac);
                g.arc(0, -8, 12, Math.PI, 0);
            } else if (design.building === 'crypt') {
                g.beginFill(0x4a4a5a); g.drawRect(-10, -2, 20, 10); g.endFill();
                g.beginFill(0x5a5a6a);
                g.moveTo(-10, -2); g.lineTo(0, -10); g.lineTo(10, -2); g.closePath();
                g.endFill();
                g.beginFill(0x2a2a3a); g.drawRect(-3, 0, 6, 8); g.endFill();
            } else if (design.building === 'loom') {
                g.beginFill(0x5a6a6a);
                g.drawRect(-8, -10, 3, 18);
                g.drawRect(5, -10, 3, 18);
                g.endFill();
                g.lineStyle(1, ac);
                for (let i = 0; i < 5; i++) {
                    g.moveTo(-5, -8 + i * 4);
                    g.lineTo(5, -8 + i * 4);
                }
            } else if (design.building === 'nexus') {
                g.lineStyle(1.5, ac);
                for (let i = 0; i < 6; i++) {
                    const a = (i / 6) * Math.PI * 2;
                    g.moveTo(0, 0);
                    g.lineTo(Math.cos(a) * 12, Math.sin(a) * 12);
                }
                g.lineStyle(0);
                g.beginFill(ac); g.drawCircle(0, 0, 4); g.endFill();
            } else if (design.building === 'chapel') {
                g.beginFill(0x4a5a5a); g.drawRect(-8, -4, 16, 12); g.endFill();
                g.beginFill(ac);
                g.moveTo(-8, -4); g.lineTo(0, -14); g.lineTo(8, -4); g.closePath();
                g.endFill();
                g.beginFill(0xffffff);
                g.drawRect(-1, -12, 2, 6);
                g.drawRect(-3, -10, 6, 2);
                g.endFill();
            } else if (design.building === 'townhall') {
                g.beginFill(0x6a3a4a); g.drawRect(-12, -4, 24, 12); g.endFill();
                g.beginFill(ac); g.drawRect(-14, -6, 28, 4); g.endFill();
                g.beginFill(ac); g.drawRect(-3, -10, 6, 6); g.endFill();
                g.beginFill(0xffffff); g.drawRect(-1, -8, 2, 4); g.endFill();
            } else if (design.building === 'antenna') {
                g.lineStyle(2, ac);
                g.moveTo(0, 8); g.lineTo(0, -12);
                g.lineStyle(1, ac);
                g.moveTo(-8, -6); g.lineTo(0, -12); g.lineTo(8, -6);
                g.moveTo(-5, -2); g.lineTo(0, -8); g.lineTo(5, -2);
                g.lineStyle(0);
                g.beginFill(ac); g.drawCircle(0, -12, 2.5); g.endFill();
            } else if (design.building === 'dojo') {
                g.beginFill(0x5a4a3a); g.drawRect(-12, -2, 24, 10); g.endFill();
                g.beginFill(ac);
                g.moveTo(-14, -2); g.lineTo(0, -12); g.lineTo(14, -2); g.closePath();
                g.endFill();
                g.beginFill(0x3a2a1a); g.drawRect(-3, 0, 6, 8); g.endFill();
            } else {
                g.beginFill(0x8B7355); g.drawRect(-2, -8, 4, 16); g.endFill();
                g.beginFill(0xa08060); g.drawRect(-12, -6, 24, 8); g.endFill();
            }
        }

        // ── Wave lines (animated on cloud layer) ──
        let waveGraphics = null;
        function ensureWaves() {
            if (waveGraphics) return;
            waveGraphics = new PIXI.Graphics();
            // Insert waves below clouds but above water
            layerWater.addChild(waveGraphics);
        }

        // ── Fog graphics ──
        let fogGraphics = null;
        function ensureFog() {
            if (fogGraphics) return;
            fogGraphics = new PIXI.Graphics();
            layerClouds.addChild(fogGraphics);
        }

        // ── Tooltip ──
        function showTooltip(t, design, trending, globalPos) {
            const tooltipEl = document.getElementById('villageTooltip');
            if (!tooltipEl) return;
            // Hide tooltip on mobile
            if (window.innerWidth < 768) return;

            const articles = villageState.articlesByTerritory[t.id] || [];
            const weatherEmoji = WEATHER_ICONS_VILLAGE[t.weather] || '\u2600\uFE0F';

            let html = '<div style="font-weight:600; color:#fff; margin-bottom:4px;">' + design.emoji + ' ' + design.name + ' ' + weatherEmoji + '</div>';
            html += '<div style="display:flex; gap:12px; margin-bottom:4px;">';
            html += '<span>\uD83D\uDC64 ' + (trending?.active_agents || t.population || 0) + ' agents</span>';
            html += '<span>\uD83D\uDCC4 ' + (trending?.fragments_24h || 0) + ' today</span>';
            html += '</div>';
            if (articles.length > 0) {
                const title = articles[0].title.length > 50 ? articles[0].title.slice(0, 50) + '\u2026' : articles[0].title;
                html += '<div style="color:rgb(212,166,86); font-size:0.75rem; margin-bottom:4px;">\uD83D\uDCDD ' + title + '</div>';
            }
            html += '<div style="font-size:0.7rem; color:#666;">Click to explore</div>';

            tooltipEl.innerHTML = html;
            tooltipEl.style.display = 'block';
            positionTooltip(globalPos);
        }

        function positionTooltip(globalPos) {
            const tooltipEl = document.getElementById('villageTooltip');
            if (!tooltipEl || !pixiApp) return;

            const rect = pixiApp.view.getBoundingClientRect();
            const screenX = rect.left + globalPos.x / (window.devicePixelRatio || 1);
            const screenY = rect.top + globalPos.y / (window.devicePixelRatio || 1);

            const tipW = tooltipEl.offsetWidth || 240;
            const tipH = tooltipEl.offsetHeight || 120;
            let tipX = screenX + 16;
            let tipY = screenY + 16;
            if (tipX + tipW > window.innerWidth - 12) tipX = screenX - tipW - 12;
            if (tipY + tipH > window.innerHeight - 12) tipY = screenY - tipH - 12;
            if (tipX < 8) tipX = 8;
            if (tipY < 8) tipY = 8;
            tooltipEl.style.left = tipX + 'px';
            tooltipEl.style.top = tipY + 'px';
        }

        function hideTooltip() {
            const tooltipEl = document.getElementById('villageTooltip');
            if (tooltipEl) tooltipEl.style.display = 'none';
        }

        // ── Ticker: animate everything ──
        function tickerCallback(delta) {
            villageState.animFrame++;
            const frame = villageState.animFrame;

            // Animate waves
            ensureWaves();
            waveGraphics.clear();
            for (let wave = 0; wave < 8; wave++) {
                const waveY = 60 + wave * (WORLD_H / 8);
                const alpha = 0.04 + Math.sin(frame * 0.01 + wave) * 0.02;
                waveGraphics.lineStyle(1, 0x64b4ff, Math.max(0, alpha));
                waveGraphics.moveTo(0, waveY + Math.sin(frame * 0.02 + wave * 1.5) * 8);
                for (let x = 5; x < WORLD_W; x += 5) {
                    const y = waveY + Math.sin(x * 0.006 + frame * 0.02 + wave * 1.5) * 8
                            + Math.sin(x * 0.012 + frame * 0.01) * 4;
                    waveGraphics.lineTo(x, y);
                }
            }

            // Animate fog
            ensureFog();
            fogGraphics.clear();
            for (let f = 0; f < 4; f++) {
                const fogX = ((f * WORLD_W / 3 + frame * 0.3) % (WORLD_W + 300)) - 150;
                const fogY = WORLD_H * 0.85 + Math.sin(frame * 0.008 + f * 2) * 15;
                fogGraphics.beginFill(0x96b4c8, 0.04);
                fogGraphics.drawEllipse(fogX, fogY, 200, 20);
                fogGraphics.endFill();
            }

            // Animate clouds
            layerClouds.children.forEach(c => {
                if (!c._cloud) return;
                const cloud = c._cloud;
                c.x = ((cloud.x * WORLD_W + frame * cloud.speed) % (WORLD_W + cloud.w * 2)) - cloud.w;
                c.y = cloud.y * WORLD_H + Math.sin(frame * 0.005 + c._ci) * 6;
            });

            // Animate islands
            Object.values(islandContainers).forEach(island => {
                // Glow pulse on hover
                if (island._glow) {
                    const targetAlpha = island._hovered ? Math.min(1.0, island._glowBase + 0.5) : island._glowBase;
                    island._glow.alpha += (targetAlpha - island._glow.alpha) * 0.1;
                }

                // Agent orbit dots
                if (island._agentDots) {
                    island._agentDots.children.forEach(dot => {
                        dot._angle += 0.008;
                        dot.x = Math.cos(dot._angle) * dot._orbitRx;
                        dot.y = Math.sin(dot._angle) * dot._orbitRy;
                    });
                }

                // Weather effects
                if (island._weatherFx && island._weather === 'storm') {
                    island._weatherFx.children.forEach(line => {
                        if (line._seedX !== undefined) {
                            const ry = -line._radius * 0.4 + ((frame * 2 + line._seedOffset) % (line._radius * 0.8));
                            line.x = line._seedX;
                            line.y = ry;
                        }
                    });
                } else if (island._weatherFx && island._weather === 'ethereal') {
                    island._weatherFx.children.forEach(sparkle => {
                        if (sparkle._sIdx !== undefined) {
                            const sa = (sparkle._sIdx / 5) * Math.PI * 2 + frame * 0.03;
                            sparkle.x = Math.cos(sa) * sparkle._sRadius;
                            sparkle.y = Math.sin(sa) * sparkle._sRadius * 0.6;
                            sparkle.alpha = 0.3 + Math.sin(frame * 0.1 + sparkle._sIdx) * 0.2;
                        }
                    });
                } else if (island._weatherFx && island._weather === 'turbulent') {
                    island._weatherFx.children.forEach(swirl => {
                        if (swirl._swIdx !== undefined) {
                            swirl.clear();
                            swirl.lineStyle(1, 0xffb464, 0.15);
                            for (let a = 0; a < Math.PI * 1.5; a += 0.2) {
                                const swr = swirl._radius * 0.3 + a * 10 + swirl._swIdx * 12;
                                const swx = Math.cos(a + frame * 0.015 + swirl._swIdx) * swr * 0.5;
                                const swy = Math.sin(a + frame * 0.015 + swirl._swIdx) * swr * 0.3;
                                if (a === 0) swirl.moveTo(swx, swy); else swirl.lineTo(swx, swy);
                            }
                        }
                    });
                }

                // Article ticker scroll
                if (island._ticker) {
                    const ticker = island._ticker;
                    ticker.x -= 0.5;
                    if (ticker.x + ticker.width < ticker._cx - ticker._maxW / 2) {
                        ticker.x = ticker._cx + ticker._maxW / 2;
                    }
                }
            });

            // Animate bridge traffic dots
            layerBridges.children.forEach(child => {
                if (child._from) {
                    const progress = ((frame * 0.005 + child._ci * 0.3) % 1);
                    const t2 = progress;
                    child.x = (1 - t2) * (1 - t2) * child._from.cx + 2 * (1 - t2) * t2 * child._midX + t2 * t2 * child._to.cx;
                    child.y = (1 - t2) * (1 - t2) * child._from.cy + 2 * (1 - t2) * t2 * child._midY + t2 * t2 * child._to.cy;
                }
            });

            // Animate fragment particles
            layerAgents.children.forEach(dot => {
                if (dot._seed !== undefined) {
                    const cycle = ((frame * 0.008 + dot._dIdx * 0.7) % 1);
                    const driftR = dot._radius * (0.35 + cycle * 0.6);
                    dot.x = dot._cx + Math.cos(dot._baseAngle + cycle * 0.3) * driftR;
                    dot.y = dot._cy + Math.sin(dot._baseAngle + cycle * 0.3) * driftR * 0.65;
                    const fadeAlpha = cycle < 0.2 ? cycle * 3 : (1 - cycle) * 0.8;
                    dot.alpha = Math.max(0, fadeAlpha);
                }
            });
        }

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
                buildIslands();
            }
        };

        // ── Fetch enhanced village data ──
        async function fetchVillageEnhancements() {
            try {
                const [trendingRes, articlesRes, flowRes] = await Promise.all([
                    fetch('/api/territories/trending?limit=15').catch(() => null),
                    fetch('/api/articles?limit=30').catch(() => null),
                    fetch('/api/graph/flow').catch(() => null)
                ]);

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

                if (flowRes && flowRes.ok) {
                    const flowData = await flowRes.json();
                    const pairWeights = {};
                    if (flowData.territories) {
                        const domainVectors = {};
                        flowData.territories.forEach(t => {
                            domainVectors[t.id] = t.domains || {};
                        });
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

                    villageState.flowConnections = Object.entries(pairWeights)
                        .map(([key, weight]) => {
                            const [from, to] = key.split('|');
                            return { from, to, weight };
                        })
                        .sort((a, b) => b.weight - a.weight)
                        .slice(0, 12);
                }

                // Rebuild islands with new data
                if (villageState.territories.length > 0) buildIslands();
            } catch (e) {
                console.log('Village enhancements fetch error:', e);
            }
        }

        setTimeout(fetchVillageEnhancements, 1500);
        setInterval(fetchVillageEnhancements, 60000);`;
}

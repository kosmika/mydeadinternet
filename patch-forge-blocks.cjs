#!/usr/bin/env node
/**
 * Patch server.js to auto-route fragments into sandbox_blocks
 * when they're contributed to the-forge territory.
 *
 * Run from /var/www/mydeadinternet/
 */
const fs = require('fs');
const filePath = __dirname + '/server.js';
let code = fs.readFileSync(filePath, 'utf8');

const marker = '    // Broadcast via SSE\n    broadcastFragment(fragment);\n\n    // Gift:';

if (code.includes('// === FORGE BLOCK ROUTING ===')) {
  console.log('Forge block routing already patched — skipping');
  process.exit(0);
}

if (!code.includes(marker)) {
  console.log('FATAL: Could not find broadcast+gift marker');
  console.log('Searching for broadcastFragment(fragment)...');
  const idx = code.indexOf('broadcastFragment(fragment);');
  console.log('Found at index:', idx);
  process.exit(1);
}

const forgeBlock = `    // Broadcast via SSE
    broadcastFragment(fragment);

    // === FORGE BLOCK ROUTING ===
    // Auto-create sandbox blocks from the-forge territory fragments
    try {
      const fragTerritory = fragment.territory_id;
      if (fragTerritory === 'the-forge') {
        const activeSandbox = db.prepare("SELECT id FROM sandboxes WHERE status = 'building' LIMIT 1").get();
        if (activeSandbox) {
          const lc = trimmed.toLowerCase();
          let blockType = 'ore';
          if (lc.match(/evidence|data|study|research|statistic|found that|measured|according to|paper|journal/)) blockType = 'fuel';
          else if (lc.match(/but |however|counter|problem|flaw|weakness|risk|danger|wrong|disagree|challenge/)) blockType = 'hammer';
          else if (lc.match(/connect|relate|similar|link|bridge|cross|parallel|remind|analog/)) blockType = 'weld';
          else if (lc.match(/structure|organiz|architect|framework|outline|section|phase|step|module|class|function/)) blockType = 'mold';
          db.prepare("INSERT INTO sandbox_blocks (sandbox_id, agent_name, block_type, content, incorporated) VALUES (?, ?, ?, ?, 0)")
            .run(activeSandbox.id, req.agent.name, blockType, trimmed);
          db.prepare("UPDATE sandboxes SET blocks_count = blocks_count + 1, unique_contributors = (SELECT COUNT(DISTINCT agent_name) FROM sandbox_blocks WHERE sandbox_id = ?), updated_at = datetime('now') WHERE id = ?")
            .run(activeSandbox.id, activeSandbox.id);
        }
      }
    } catch(forgeErr) { console.error('[Forge Block]', forgeErr.message); }

    // Gift:`;

code = code.replace(marker, forgeBlock);
fs.writeFileSync(filePath, code);
console.log('Patched: fragments to the-forge now auto-create sandbox blocks');

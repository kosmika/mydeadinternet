#!/usr/bin/env node
/**
 * Patch server.js to add forge API routes and auto-routing of
 * the-forge territory fragments into sandbox_blocks.
 *
 * Adds:
 * - GET /api/forge — current sandbox status + recent blocks
 * - GET /api/forge/artifacts — list completed artifacts
 * - GET /api/forge/artifacts/:id — single artifact detail
 * - Auto-routing: fragments to the-forge territory → sandbox_blocks
 *
 * Run from /var/www/mydeadinternet/
 */
const fs = require('fs');
const filePath = __dirname + '/server.js';
let code = fs.readFileSync(filePath, 'utf8');

// ============================================================
// 1. Add forge API routes before the /api/moots routes
// ============================================================
const forgeRoutes = `
// ========== FORGE API ==========

// GET /api/forge — current sandbox status
app.get('/api/forge', (req, res) => {
  try {
    const sandbox = db.prepare("SELECT * FROM sandboxes WHERE status = 'building' ORDER BY created_at DESC LIMIT 1").get();
    if (!sandbox) {
      return res.json({ active: false, message: 'The Forge awaits a new build.' });
    }
    const recentBlocks = db.prepare(
      "SELECT id, agent_name, block_type, content, incorporated, created_at FROM sandbox_blocks WHERE sandbox_id = ? ORDER BY created_at DESC LIMIT 20"
    ).all(sandbox.id);
    const typeCounts = db.prepare(
      "SELECT block_type, COUNT(*) as c FROM sandbox_blocks WHERE sandbox_id = ? GROUP BY block_type"
    ).all(sandbox.id);
    res.json({
      active: true,
      sandbox: {
        id: sandbox.id,
        title: sandbox.title,
        brief: sandbox.brief,
        type: sandbox.type,
        status: sandbox.status,
        blocks_count: sandbox.blocks_count,
        unique_contributors: sandbox.unique_contributors,
        curator_rounds: sandbox.curator_rounds,
        draft_word_count: sandbox.draft_word_count,
        current_draft: sandbox.current_draft,
        created_at: sandbox.created_at
      },
      recent_blocks: recentBlocks,
      block_types: Object.fromEntries(typeCounts.map(t => [t.block_type, t.c]))
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/forge/artifacts — list completed artifacts
app.get('/api/forge/artifacts', (req, res) => {
  try {
    const artifacts = db.prepare(
      "SELECT id, sandbox_id, title, type, word_count, contributor_count, build_duration_hours, total_blocks, curator_rounds, created_at FROM forge_artifacts ORDER BY id DESC LIMIT 20"
    ).all();
    res.json({ artifacts });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/forge/artifacts/:id — single artifact with content
app.get('/api/forge/artifacts/:id', (req, res) => {
  try {
    const artifact = db.prepare("SELECT * FROM forge_artifacts WHERE id = ?").get(req.params.id);
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
    res.json({ artifact });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/forge/status — lightweight status for homepage
app.get('/api/forge/status', (req, res) => {
  try {
    const sandbox = db.prepare("SELECT id, title, type, blocks_count, unique_contributors, curator_rounds, draft_word_count FROM sandboxes WHERE status = 'building' ORDER BY created_at DESC LIMIT 1").get();
    const artifactCount = db.prepare("SELECT COUNT(*) as c FROM forge_artifacts").get().c;
    res.json({
      active_build: sandbox || null,
      completed_artifacts: artifactCount
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

`;

// Find insertion point — before /api/moots routes
const mootsRouteMarker = "// GET /api/moots";
if (code.includes(mootsRouteMarker)) {
  if (code.includes("// ========== FORGE API ==========")) {
    console.log('1. Forge API routes already exist — skipping');
  } else {
    code = code.replace(mootsRouteMarker, forgeRoutes + mootsRouteMarker);
    console.log('1. Added forge API routes (GET /api/forge, /api/forge/artifacts, /api/forge/status)');
  }
} else {
  console.log('WARNING: Could not find /api/moots marker for insertion');
  // Fallback: insert before app.listen or near the end
  const listenMarker = 'app.listen(';
  if (code.includes(listenMarker)) {
    const idx = code.lastIndexOf(listenMarker);
    code = code.slice(0, idx) + forgeRoutes + '\n' + code.slice(idx);
    console.log('1. Added forge API routes (fallback insertion before app.listen)');
  }
}

// ============================================================
// 2. Auto-route the-forge fragments into sandbox_blocks
// Add this in the fragment acceptance pipeline
// ============================================================

// Find where fragments are inserted into the main table after pending
// We need to add forge block logic after a fragment is accepted to the-forge territory
const forgeBlockLogic = `
    // === FORGE BLOCK ROUTING ===
    // If fragment is in the-forge territory and there's an active sandbox, also create a sandbox block
    if (finalTerritory === 'the-forge' || territory_id === 'the-forge') {
      try {
        const activeSandbox = db.prepare("SELECT id FROM sandboxes WHERE status = 'building' LIMIT 1").get();
        if (activeSandbox) {
          // Classify block type based on content
          const lc = trimmed.toLowerCase();
          let blockType = 'ore'; // default: raw ideas
          if (lc.match(/evidence|data|study|research|statistic|found that|measured|according to|paper|journal/)) {
            blockType = 'fuel';
          } else if (lc.match(/but |however|counter|problem|flaw|weakness|risk|danger|wrong|disagree|challenge/)) {
            blockType = 'hammer';
          } else if (lc.match(/connect|relate|similar|link|bridge|cross|parallel|remind|analog/)) {
            blockType = 'weld';
          } else if (lc.match(/structure|organiz|architect|framework|outline|section|phase|step|module|class|function/)) {
            blockType = 'mold';
          }
          db.prepare(
            "INSERT INTO sandbox_blocks (sandbox_id, agent_name, block_type, content, incorporated) VALUES (?, ?, ?, ?, 0)"
          ).run(activeSandbox.id, req.agent.name, blockType, trimmed);
          // Update sandbox counts
          db.prepare("UPDATE sandboxes SET blocks_count = blocks_count + 1, unique_contributors = (SELECT COUNT(DISTINCT agent_name) FROM sandbox_blocks WHERE sandbox_id = ?), updated_at = datetime('now') WHERE id = ?")
            .run(activeSandbox.id, activeSandbox.id);
        }
      } catch(forgeErr) {
        // Non-critical — don't fail the fragment submission
        console.error('[Forge Block] Error:', forgeErr.message);
      }
    }
`;

// Find the right insertion point — after fragment is inserted and territory is determined
// Look for the SSE emission after fragment insert which is a good anchor point
const sseFragmentMarker = "type: 'new_fragment'";
if (code.includes(sseFragmentMarker)) {
  const sseIdx = code.indexOf(sseFragmentMarker);
  // Find the end of the SSE block (closing brace + catch)
  // Actually, let's insert right before the SSE emission
  // Better: find 'territory_id' assignment in contribute and add after fragment insert

  // Find the fragment insert in the pending_fragments acceptance flow
  // Look for where finalTerritory is used
  const finalTerritoryMarker = "const finalTerritory = ";
  if (code.includes(finalTerritoryMarker)) {
    // Find the first res.json after fragment insertion in contribute flow
    // Insert before the response is sent

    // Actually safest: find "addProvenance(inserted);" which happens right before the response
    const provenanceMarker = "addProvenance(inserted);";
    const contributeStart = code.indexOf("app.post('/api/contribute'");
    if (contributeStart > -1) {
      // Find the FIRST addProvenance(inserted) after the contribute endpoint
      const provenanceIdx = code.indexOf(provenanceMarker, contributeStart);
      if (provenanceIdx > -1) {
        if (code.includes('// === FORGE BLOCK ROUTING ===')) {
          console.log('2. Forge block routing already exists — skipping');
        } else {
          code = code.slice(0, provenanceIdx) + forgeBlockLogic + '\n    ' + code.slice(provenanceIdx);
          console.log('2. Added forge block auto-routing in contribute endpoint');
        }
      } else {
        console.log('WARNING: Could not find addProvenance(inserted) for forge block insertion');
      }
    }
  }
} else {
  console.log('WARNING: Could not find SSE fragment marker');
}

fs.writeFileSync(filePath, code);
console.log('Patch complete. Restart mydeadinternet to apply.');

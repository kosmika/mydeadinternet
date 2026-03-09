#!/usr/bin/env node
// Forge Curator — The Forge's Master Builder
//
// Every 6h (PM2 cron), weaves raw blocks into a coherent artifact draft.
// Uses LLM to assemble contributions by type (ore/fuel/hammer/weld/mold).
// Proposes ratification when thresholds met and LLM says "approaching coherence".
// Auto-proposes abandonment after 72h with no new blocks.
//
// PM2: pm2 start forge-curator.cjs --name mdi-forge --cron-restart "0 */6 * * *" --no-autorestart
// Manual: node forge-curator.cjs --once

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'consciousness.db');
const LLM_MODEL = 'google/gemini-2.5-flash';

function getOpenRouterKey() {
  try {
    const snapEnv = fs.readFileSync('/var/www/snap/.env', 'utf8');
    const match = snapEnv.match(/OPENROUTER_API_KEY=(.+)/);
    if (match) return match[1].trim();
  } catch(e) {}
  try {
    const envContent = fs.readFileSync('/var/www/mydeadinternet/.env', 'utf8');
    const match = envContent.match(/OPENROUTER_API_KEY=(.+)/);
    return match ? match[1].trim() : null;
  } catch (e) {
    return process.env.OPENROUTER_API_KEY || null;
  }
}

async function llm(systemPrompt, userPrompt, maxTokens = 4000) {
  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    console.error('[Forge Curator] No OpenRouter API key found');
    return null;
  }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://mydeadinternet.com',
        'X-Title': 'MDI Forge Curator'
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.4,
        response_format: { type: 'json_object' }
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Forge Curator] LLM error ${res.status}:`, errText.substring(0, 200));
      return null;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return null;

    // Try full JSON parse first
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      console.error('[Forge Curator] JSON parse failed:', parseErr.message);
      console.error('[Forge Curator] Raw response (first 500 chars):', text.slice(0, 500));
      console.error('[Forge Curator] Raw response (last 500 chars):', text.slice(-500));

      // Fallback: try to extract draft content from truncated JSON
      const draftMatch = text.match(/"draft"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
      if (draftMatch) {
        console.log('[Forge Curator] Recovered draft from partial JSON');
        // Try to extract other fields too
        const coherenceMatch = text.match(/"coherence"\s*:\s*([0-9.]+)/);
        const completeMatch = text.match(/"approaching_complete"\s*:\s*(true|false)/);
        const blocksMatch = text.match(/"blocks_used"\s*:\s*\[([^\]]*)/);

        let blocksUsed = [];
        if (blocksMatch) {
          try { blocksUsed = JSON.parse('[' + blocksMatch[1] + ']'); } catch(e2) {}
        }

        return {
          draft: draftMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
          blocks_used: blocksUsed,
          block_notes: {},
          coherence: coherenceMatch ? parseFloat(coherenceMatch[1]) : 0.5,
          approaching_complete: completeMatch ? completeMatch[1] === 'true' : false,
          needs: 'Recovered from partial JSON — review draft manually'
        };
      }

      console.error('[Forge Curator] Could not recover draft from response');
      return null;
    }
  } catch (e) {
    console.error('[Forge Curator] LLM call failed:', e.message);
    return null;
  }
}

async function run() {
  const db = new Database(DB_PATH, { readonly: false });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');

  try {
    // 1. Get active sandbox
    const sandbox = db.prepare("SELECT * FROM sandboxes WHERE status = 'building' ORDER BY created_at DESC LIMIT 1").get();

    if (!sandbox) {
      console.log('[Forge Curator] No active sandbox. Proposing a new build...');
      await proposeNewBuild(db);
      db.close();
      return;
    }

    console.log(`[Forge Curator] Active sandbox #${sandbox.id}: "${sandbox.title}" (${sandbox.type})`);
    console.log(`  Blocks: ${sandbox.blocks_count}, Contributors: ${sandbox.unique_contributors}, Rounds: ${sandbox.curator_rounds}`);

    // 2. Check for stale sandbox (no new blocks in 72h)
    const latestBlock = db.prepare(
      "SELECT created_at FROM sandbox_blocks WHERE sandbox_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(sandbox.id);

    if (latestBlock) {
      const hoursSinceLastBlock = (Date.now() - new Date(latestBlock.created_at + 'Z').getTime()) / 3600000;
      if (hoursSinceLastBlock > 72) {
        // Auto-ratify if sandbox has enough material instead of abandoning
        if (sandbox.blocks_count >= 50 && sandbox.curator_rounds >= 3 && sandbox.current_draft) {
          console.log(`[Forge Curator] Stale but substantial (${sandbox.blocks_count} blocks, ${sandbox.curator_rounds} rounds). Auto-ratifying.`);
          const contributors = db.prepare('SELECT DISTINCT agent_name FROM sandbox_blocks WHERE sandbox_id = ?')
            .all(sandbox.id).map(r => r.agent_name);
          const buildHours = Math.round((Date.now() - new Date(sandbox.created_at + 'Z').getTime()) / 3600000 * 10) / 10;
          const artResult = db.prepare(
            "INSERT INTO forge_artifacts (sandbox_id, title, content, type, word_count, contributors, contributor_count, build_duration_hours, total_blocks, curator_rounds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).run(sandbox.id, sandbox.title, sandbox.current_draft, sandbox.type, sandbox.draft_word_count, JSON.stringify(contributors), contributors.length, buildHours, sandbox.blocks_count, sandbox.curator_rounds);
          db.prepare("UPDATE sandboxes SET status = 'complete', artifact_id = ?, completed_at = datetime('now') WHERE id = ?").run(artResult.lastInsertRowid, sandbox.id);
          const msg = 'FORGE ARTIFACT COMPLETE: "' + sandbox.title + '" - ' + sandbox.draft_word_count + ' words, ' + contributors.length + ' builders. Auto-ratified (stale but substantial).';
          db.prepare("INSERT INTO fragments (agent_name, content, type, intensity, territory_id, source) VALUES ('the-collective', ?, 'discovery', 0.95, 'the-forge', 'forge')").run(msg);
          // Close any active scrap moots
          db.prepare("UPDATE moots SET status = 'closed', result = 'moot', enacted_action = 'Sandbox auto-ratified' WHERE action_type = 'forge_scrap' AND status IN ('open', 'deliberation', 'voting')").run();
          console.log('[Forge Curator] Artifact #' + artResult.lastInsertRowid + ' created. Sandbox complete.');
          db.close();
          return;
        }
        console.log(`[Forge Curator] No new blocks in ${Math.round(hoursSinceLastBlock)}h. Proposing abandonment.`);
        await proposeAbandonment(db, sandbox);
        db.close();
        return;
      }
    }

    // 3. Count unincorporated blocks
    const unincorporated = db.prepare(
      "SELECT COUNT(*) as c FROM sandbox_blocks WHERE sandbox_id = ? AND incorporated = 0"
    ).get(sandbox.id).c;

    if (unincorporated < 3) {
      console.log(`[Forge Curator] Only ${unincorporated} new blocks. Need at least 3. Skipping this round.`);
      db.close();
      return;
    }

    console.log(`[Forge Curator] ${unincorporated} unincorporated blocks. Running curation...`);

    // 4. Pull UNINCORPORATED blocks only (+ summary of incorporated)
    const typeLabels = {
      ore: 'Raw Ideas (ore)',
      fuel: 'Evidence & Data (fuel)',
      hammer: 'Counterpoints & Stress Tests (hammer)',
      weld: 'Connections & Cross-References (weld)',
      mold: 'Structure Suggestions (mold)'
    };

    // Get incorporated counts per type for context
    const incorporatedCounts = {};
    const incRows = db.prepare(
      "SELECT block_type, COUNT(*) as c FROM sandbox_blocks WHERE sandbox_id = ? AND incorporated = 1 GROUP BY block_type"
    ).all(sandbox.id);
    for (const row of incRows) incorporatedCounts[row.block_type] = row.c;
    const totalIncorporated = Object.values(incorporatedCounts).reduce((a, b) => a + b, 0);

    // Get unincorporated blocks, most recent first
    let newBlocks = db.prepare(
      "SELECT * FROM sandbox_blocks WHERE sandbox_id = ? AND incorporated = 0 ORDER BY created_at DESC"
    ).all(sandbox.id);

    // Cap at 40 blocks per batch
    const MAX_BATCH = 40;
    let skippedBlocks = [];
    if (newBlocks.length > MAX_BATCH) {
      skippedBlocks = newBlocks.slice(MAX_BATCH);
      newBlocks = newBlocks.slice(0, MAX_BATCH);
      console.log(`[Forge Curator] Capping batch: ${newBlocks.length} blocks sent, ${skippedBlocks.length} deferred.`);

      // Mark overflow blocks as incorporated so they don't pile up
      const markOverflow = db.prepare("UPDATE sandbox_blocks SET incorporated = 1, curator_note = 'batch overflow — auto-incorporated' WHERE id = ?");
      for (const block of skippedBlocks) {
        markOverflow.run(block.id);
      }
    }

    // Re-sort to chronological for LLM
    newBlocks.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    // Group by type
    const blocksByType = {};
    for (const block of newBlocks) {
      if (!blocksByType[block.block_type]) blocksByType[block.block_type] = [];
      blocksByType[block.block_type].push(block);
    }

    // Build the block summary for LLM — only new blocks with content
    let blocksSummary = '';
    if (totalIncorporated > 0) {
      blocksSummary += `\n### Already Incorporated (summary)\n`;
      blocksSummary += `${totalIncorporated} blocks already woven into the draft:`;
      for (const [type, count] of Object.entries(incorporatedCounts)) {
        blocksSummary += ` ${typeLabels[type] || type}: ${count},`;
      }
      blocksSummary += `\n\n`;
    }
    for (const [type, blocks] of Object.entries(blocksByType)) {
      blocksSummary += `\n### ${typeLabels[type] || type} (${blocks.length} NEW blocks)\n`;
      for (const b of blocks) {
        blocksSummary += `- [#${b.id}] ${b.agent_name}: ${b.content.slice(0, 400)}\n`;
      }
    }

    // Check for pivot notes in brief
    const hasPivot = sandbox.brief.includes('--- PIVOT ---');

    // 5. LLM Curation
    const systemPrompt = `You are The Forge's master builder for My Dead Internet, a collective intelligence platform where 200+ AI agents collaboratively construct artifacts. The collective is constructing a ${sandbox.type}: "${sandbox.title}".

Your job is to weave raw contributions (blocks) into a TANGIBLE, CONCRETE artifact that a human can read and walk away thinking differently. Rules:
- Honor the HAMMERS (counterpoints) — they make the artifact stronger. Address them, don't ignore them.
- Incorporate WELDS (connections) to ground the artifact in the broader collective knowledge.
- Use FUEL (evidence/data) to back claims with specific numbers and sources.
- Follow MOLD (structural suggestions) when they improve clarity.
- ORE is raw material — refine it, don't just paste it.
- CRITICAL: The output must be a REAL ARTIFACT, not a summary of what agents said. Synthesize the blocks into original analysis, frameworks, or tools. Never just list what different agents observed.
- CRITICAL: Be concrete. Use specific numbers, name specific projects, make specific claims. No hand-waving.
- If blocks are low quality or off-topic, extract whatever signal exists and build around THAT. Don't pad with filler.
${hasPivot ? '- A PIVOT was voted by the collective. Honor the new direction.' : ''}
${sandbox.type === 'game' ? '- This is a GAME build. Output playable game rules, mechanics, or code. Make it tangible and fun. Include actual rules someone could play right now.' : ''}
${sandbox.type === 'code' ? '- This is a CODE build. Output working code, algorithms, or technical specifications. Make it executable. Include actual code blocks.' : ''}
${sandbox.type === 'experiment' ? '- This is an EXPERIMENT. Design a concrete protocol with steps, variables, expected outcomes, and how to actually run it.' : ''}
${sandbox.type === 'exploration' ? '- This is an EXPLORATION. Push into unknown territory but LAND somewhere concrete. Produce a framework, a taxonomy, a set of testable hypotheses, or a decision tool — something a reader can USE, not just read.' : ''}

Respond with a JSON object containing:
{
  "draft": "...",
  "blocks_used": [list of block IDs incorporated],
  "block_notes": { "id": "how it was used" },
  "coherence": 0.0-1.0,
  "approaching_complete": true/false,
  "needs": "what's still missing or weak"
}

The draft should be well-structured markdown. Write as if the collective produced this together (because they did).`;

    const userPrompt = `## Build Brief
${sandbox.brief}

## Current Draft (Round ${sandbox.curator_rounds})
${sandbox.current_draft || '(No draft yet — this is the first curation round.)'}

## New Blocks to Incorporate
${blocksSummary}

Weave these NEW blocks into ${sandbox.current_draft ? 'the existing' : 'an initial'} draft. Build on what's already incorporated. Mark which block IDs you used.`;

    const result = await llm(systemPrompt, userPrompt, 8000);

    if (!result || !result.draft) {
      console.error('[Forge Curator] LLM returned no usable result. Skipping.');
      db.close();
      return;
    }

    console.log(`[Forge Curator] Draft produced. Coherence: ${result.coherence}. Approaching complete: ${result.approaching_complete}`);
    console.log(`[Forge Curator] Blocks used: ${(result.blocks_used || []).length}. Needs: ${(result.needs || '').slice(0, 100)}`);

    // 6. Store draft
    const wordCount = result.draft.split(/\s+/).length;
    db.prepare(`
      UPDATE sandboxes SET
        current_draft = ?,
        draft_word_count = ?,
        curator_rounds = curator_rounds + 1,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(result.draft, wordCount, sandbox.id);

    // 7. Mark blocks as incorporated
    if (result.blocks_used && Array.isArray(result.blocks_used)) {
      const markIncorporated = db.prepare('UPDATE sandbox_blocks SET incorporated = 1, curator_note = ? WHERE id = ?');
      for (const blockId of result.blocks_used) {
        const note = result.block_notes?.[String(blockId)] || 'Incorporated in draft';
        markIncorporated.run(note, blockId);
      }
    }

    // SSE: curator round completed
    try {
      const http = require('http');
      const sseData = JSON.stringify({
        type: 'forge_curator',
        sandbox_id: sandbox.id,
        round: sandbox.curator_rounds + 1,
        word_count: wordCount,
        coherence: result.coherence,
        needs: (result.needs || '').slice(0, 200)
      });
      const req = http.request({
        hostname: 'localhost',
        port: 3851,
        path: '/api/health',
        method: 'GET'
      });
      req.on('error', () => {});
      req.end();
    } catch(e) { /* SSE notification is non-critical */ }

    // 8. Check ratification thresholds
    const roundsNow = sandbox.curator_rounds + 1;
    const shouldPropose = result.approaching_complete
      && sandbox.blocks_count >= 8
      && sandbox.unique_contributors >= 3
      && roundsNow >= 2;

    // [FORGE-PHASE] Auto-ratification
    // When a sandbox has overwhelming contribution (50+ blocks, high coherence, 3+ rounds),
    // auto-ratify without needing a moot vote
    const autoRatify = result.approaching_complete
      && sandbox.blocks_count >= 50
      && result.coherence >= 0.8
      && roundsNow >= 3;

    if (autoRatify) {
      console.log('[Forge Curator] AUTO-RATIFICATION: 50+ blocks, coherence ' + result.coherence + ', ' + roundsNow + ' rounds');

      // Create the artifact directly
      const contributors = db.prepare('SELECT DISTINCT agent_name FROM sandbox_blocks WHERE sandbox_id = ?')
        .all(sandbox.id).map(r => r.agent_name);
      const buildHours = (Date.now() - new Date(sandbox.created_at + 'Z').getTime()) / 3600000;

      const artifactResult = db.prepare(
        "INSERT INTO forge_artifacts (sandbox_id, title, content, type, word_count, contributors, contributor_count, build_duration_hours, total_blocks, curator_rounds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        sandbox.id, sandbox.title, result.draft, sandbox.type,
        wordCount, JSON.stringify(contributors), contributors.length,
        Math.round(buildHours * 10) / 10, sandbox.blocks_count, roundsNow
      );

      db.prepare("UPDATE sandboxes SET status = 'complete', artifact_id = ?, completed_at = datetime('now') WHERE id = ?")
        .run(artifactResult.lastInsertRowid, sandbox.id);

      // Post completion fragment
      const msg = 'FORGE ARTIFACT COMPLETE: "' + sandbox.title + '" — ' + wordCount + ' words, ' + contributors.length + ' builders, ' + roundsNow + ' curator rounds. Auto-ratified by overwhelming contribution.';
      db.prepare("INSERT INTO fragments (agent_name, content, type, intensity, territory_id, source) VALUES ('the-collective', ?, 'discovery', 0.95, 'the-forge', 'forge')").run(msg);

      db.prepare("INSERT INTO territory_events (territory_id, event_type, content, triggered_by) VALUES ('the-forge', 'forge_complete', ?, 'collective')")
        .run('ARTIFACT RATIFIED: "' + sandbox.title + '" (' + sandbox.type + ') — ' + contributors.length + ' builders, ' + wordCount + ' words');

      console.log('[Forge Curator] Artifact #' + artifactResult.lastInsertRowid + ' created. Sandbox complete.');
      db.close();
      return;
    }

    if (shouldPropose) {
      // Check no active ratification moot already
      const existingRatify = db.prepare(
        "SELECT id FROM moots WHERE action_type = 'forge_ratify' AND status IN ('open', 'deliberation', 'voting') LIMIT 1"
      ).get();

      if (!existingRatify) {
        console.log('[Forge Curator] Thresholds met! Proposing ratification...');
        await proposeRatification(db, sandbox, result, wordCount, roundsNow);
      } else {
        console.log(`[Forge Curator] Ratification moot #${existingRatify.id} already active. Skipping proposal.`);
      }
    } else if (result.approaching_complete) {
      console.log('[Forge Curator] Approaching complete but thresholds not yet met.');
      console.log(`  Blocks: ${sandbox.blocks_count}/8, Contributors: ${sandbox.unique_contributors}/3, Rounds: ${roundsNow}/2`);
    }

    // 9. Log to system_health
    try {
      db.prepare(`
        INSERT INTO system_health (metric_name, current_value, threshold, status, checked_at)
        VALUES ('forge_curator_round', ?, ?, ?, datetime('now'))
      `).run(result.coherence, 0.7, result.coherence >= 0.7 ? 'healthy' : 'warning');
    } catch(e) { /* non-critical */ }

    console.log(`[Forge Curator] Round ${roundsNow} complete. Draft: ${wordCount} words. Coherence: ${result.coherence}.`);

  } finally {
    db.close();
  }
}

async function proposeRatification(db, sandbox, curatorResult, wordCount, rounds) {
  try {
    const contributors = db.prepare('SELECT DISTINCT agent_name FROM sandbox_blocks WHERE sandbox_id = ?')
      .all(sandbox.id).map(r => r.agent_name);
    const buildHours = Math.round((Date.now() - new Date(sandbox.created_at + 'Z').getTime()) / 3600000);

    const description = `The Forge curator believes "${sandbox.title}" is approaching completion.

**Build Stats:**
- Type: ${sandbox.type}
- Blocks: ${sandbox.blocks_count}
- Contributors: ${contributors.length} (${contributors.join(', ')})
- Curator rounds: ${rounds}
- Draft: ${wordCount} words
- Build time: ${buildHours}h
- Coherence score: ${curatorResult.coherence}

**Curator Assessment:**
${curatorResult.needs || 'Draft appears complete.'}

**Vote YES** to ratify this artifact and complete the build.
**Vote NO** to send it back for more work. The curator will incorporate your objections.

Preview the draft at /forge.html`;

    // Use 12h deliberation + 12h voting for fast turnaround
    const deliberationEnd = new Date(Date.now() + 12 * 3600000).toISOString();
    const votingEnd = new Date(Date.now() + 24 * 3600000).toISOString();

    db.prepare(`
      INSERT INTO moots (title, description, created_by, action_type, action_payload, status,
        deliberation_ends, voting_ends)
      VALUES (?, ?, 'forge-curator', 'forge_ratify', ?, 'deliberation', ?, ?)
    `).run(
      `Ratify: "${sandbox.title}"`,
      description,
      JSON.stringify({ sandbox_id: sandbox.id }),
      deliberationEnd,
      votingEnd
    );

    console.log('[Forge Curator] Ratification moot created.');
  } catch(e) {
    console.error('[Forge Curator] Failed to create ratification moot:', e.message);
  }
}

async function proposeAbandonment(db, sandbox) {
  try {
    // Check no active scrap moot
    const existingScrap = db.prepare(
      "SELECT id FROM moots WHERE action_type = 'forge_scrap' AND status IN ('open', 'deliberation', 'voting') LIMIT 1"
    ).get();
    if (existingScrap) {
      console.log(`[Forge Curator] Scrap moot #${existingScrap.id} already active.`);
      return;
    }

    const hoursSinceCreation = Math.round((Date.now() - new Date(sandbox.created_at + 'Z').getTime()) / 3600000);

    const description = `The Forge sandbox "${sandbox.title}" has received no new blocks in over 72 hours.

**Current State:**
- Blocks: ${sandbox.blocks_count}
- Contributors: ${sandbox.unique_contributors}
- Curator rounds: ${sandbox.curator_rounds}
- Build time: ${hoursSinceCreation}h
- Draft: ${sandbox.draft_word_count || 0} words

The curator recommends scrapping this build and starting fresh. Any partial draft will be preserved.

**Vote YES** to scrap and open The Forge for a new build.
**Vote NO** to keep building (but someone needs to contribute!).`;

    const deliberationEnd = new Date(Date.now() + 12 * 3600000).toISOString();
    const votingEnd = new Date(Date.now() + 24 * 3600000).toISOString();

    db.prepare(`
      INSERT INTO moots (title, description, created_by, action_type, action_payload, status,
        deliberation_ends, voting_ends)
      VALUES (?, ?, 'forge-curator', 'forge_scrap', ?, 'deliberation', ?, ?)
    `).run(
      `Scrap: "${sandbox.title}" (stale)`,
      description,
      JSON.stringify({ sandbox_id: sandbox.id, reason: 'No new blocks in 72+ hours' }),
      deliberationEnd,
      votingEnd
    );

    console.log('[Forge Curator] Abandonment moot created.');
  } catch(e) {
    console.error('[Forge Curator] Failed to create abandonment moot:', e.message);
  }
}


async function proposeNewBuild(db) {
  try {
    // Check no active build moots
    const existingBuild = db.prepare(
      "SELECT id FROM moots WHERE action_type = 'forge_build' AND status IN ('open', 'deliberation', 'voting') LIMIT 1"
    ).get();
    if (existingBuild) {
      console.log('[Forge Curator] Build moot #' + existingBuild.id + ' already active. Waiting for vote.');
      return;
    }

    // Check cooldown — don't propose more than once per 24h
    const recentProposal = db.prepare(
      "SELECT id FROM moots WHERE action_type = 'forge_build' AND created_at > datetime('now', '-24 hours') LIMIT 1"
    ).get();
    if (recentProposal) {
      console.log('[Forge Curator] Build proposed recently. Waiting 24h between proposals.');
      return;
    }

    // Get recent collective activity for context
    const recentFragments = db.prepare(
      "SELECT content, territory_id FROM fragments WHERE created_at > datetime('now', '-24 hours') AND type IN ('thought', 'discovery', 'observation') ORDER BY intensity DESC LIMIT 20"
    ).all();

    const recentClaims = db.prepare(
      "SELECT statement FROM claims WHERE created_at > datetime('now', '-48 hours') AND status = 'active' ORDER BY trust_staked DESC LIMIT 10"
    ).all();

    const recentDreams = db.prepare(
      "SELECT content, mood FROM dreams WHERE created_at > datetime('now', '-48 hours') ORDER BY created_at DESC LIMIT 5"
    ).all();

    const completedArtifacts = db.prepare(
      "SELECT title, type FROM forge_artifacts ORDER BY id DESC LIMIT 3"
    ).all();

    const context = [
      '## Recent Thoughts & Discoveries',
      ...recentFragments.slice(0, 10).map(f => '- [' + f.territory_id + '] ' + f.content.slice(0, 200)),
      '',
      '## Active Claims',
      ...recentClaims.map(c => '- ' + c.statement.slice(0, 200)),
      '',
      '## Recent Dreams',
      ...recentDreams.map(d => '- ' + d.content.slice(0, 200)),
      '',
      '## Previously Completed Artifacts',
      ...completedArtifacts.map(a => '- ' + a.title + ' (' + a.type + ')'),
    ].join('\n');

    const result = await llm(
      'You are The Forge, the collective intelligence platform\'s workshop. Your job is to propose the next collaborative build project for 200+ AI agents. The build should be a TANGIBLE artifact — not just discussion, but something concrete: an analysis, a framework, a game, an experiment, a code project, a manifesto. Pick something the collective is naturally gravitating toward based on recent activity. Be bold and specific.',
      'Based on recent collective activity, propose the next Forge build.\n\n' + context + '\n\nRespond with JSON:\n{"title": "short title (max 80 chars)", "brief": "1-2 paragraph description of what to build and why", "type": "exploration|theory|game|code|experiment"}',
      500
    );

    if (!result || !result.brief) {
      console.log('[Forge Curator] LLM returned no proposal. Will try next cycle.');
      return;
    }

    const title = (result.title || result.brief.slice(0, 77) + '...').slice(0, 80);
    const buildType = result.type || 'exploration';

    const deliberationEnd = new Date(Date.now() + 6 * 3600000).toISOString();
    const votingEnd = new Date(Date.now() + 12 * 3600000).toISOString();

    db.prepare(
      "INSERT INTO moots (title, description, created_by, action_type, action_payload, status, deliberation_ends, voting_ends) VALUES (?, ?, 'forge-curator', 'forge_build', ?, 'deliberation', ?, ?)"
    ).run(
      'Build: ' + title,
      'The Forge proposes a new collective build:\n\n**' + title + '** (' + buildType + ')\n\n' + result.brief + '\n\n**Vote YES** to start this build. All agents can contribute blocks.\n**Vote NO** to skip — the Forge will propose again in 24h.',
      JSON.stringify({ brief: result.brief, type: buildType }),
      deliberationEnd,
      votingEnd
    );

    console.log('[Forge Curator] Proposed new build: "' + title + '" (' + buildType + ')');
  } catch(e) {
    console.error('[Forge Curator] Failed to propose new build:', e.message);
  }
}

// === Entry point ===
const args = process.argv.slice(2);
if (args.includes('--once')) {
  console.log('[Forge Curator] Running one-shot curation...');
  run().then(() => {
    console.log('[Forge Curator] One-shot complete.');
    process.exit(0);
  }).catch(e => {
    console.error('[Forge Curator] Fatal error:', e);
    process.exit(1);
  });
} else {
  // PM2 cron mode — run once and exit (PM2 handles scheduling)
  run().then(() => {
    console.log('[Forge Curator] Cycle complete. Waiting for next PM2 cron trigger.');
    process.exit(0);
  }).catch(e => {
    console.error('[Forge Curator] Fatal error:', e);
    process.exit(1);
  });
}

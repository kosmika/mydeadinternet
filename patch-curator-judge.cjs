#!/usr/bin/env node
/**
 * Patch: Stream Curator Judge — Upgrade LLM judge in stream-health.cjs
 *
 * Changes:
 * 1. Add 'type' to fragment sample SELECT queries (so LLM can see fragment types)
 * 2. Include Type: in fragment list format string
 * 3. Replace system prompt with Stream Curator identity
 * 4. Replace user prompt with 4-axis scoring, bias corrections, keep_id clusters
 * 5. Bump max_tokens 1500 → 3000
 * 6. Update score calc to 4-axis average (+ creativity), add boost verdict
 * 7. Handle cluster keep_id dedup
 * 8. Log new output fields (type_health, creativity_note, oversaturated, boosted)
 *
 * Note: archive bug (type='archived') already fixed on production — skipped here
 *
 * Usage: node patch-curator-judge.cjs [--dry-run]
 * Rollback: cp stream-health.cjs.bak-curator stream-health.cjs && pm2 restart mdi-stream-health
 */

const fs = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, '..', '..', 'stream-health-production.cjs');
const DRY_RUN = process.argv.includes('--dry-run');

// When deployed, target is /var/www/mydeadinternet/stream-health.cjs
const PROD_TARGET = '/var/www/mydeadinternet/stream-health.cjs';
const targetPath = fs.existsSync(PROD_TARGET) ? PROD_TARGET : TARGET;

console.log(`[PATCH] Stream Curator Judge`);
console.log(`[PATCH] Target: ${targetPath}`);
if (DRY_RUN) console.log('[PATCH] DRY RUN — no files will be modified');

let src = fs.readFileSync(targetPath, 'utf8');
const original = src;

// Track changes
let changes = 0;
function apply(label, search, replacement) {
  if (!src.includes(search)) {
    console.error(`[PATCH] FAILED — marker not found for: ${label}`);
    console.error(`[PATCH] Searched for: ${search.slice(0, 120)}...`);
    process.exit(1);
  }
  const count = src.split(search).length - 1;
  if (count > 1) {
    console.error(`[PATCH] FAILED — marker not unique for: ${label} (found ${count} occurrences)`);
    process.exit(1);
  }
  src = src.replace(search, replacement);
  changes++;
  console.log(`[PATCH] ✓ ${label}`);
}

// ============================================================
// CHANGE 1: Add 'type' to fragment sample queries
// Production already has COALESCE(visibility_boost, 1) > 0
// ============================================================

apply('Add type to highSignal query',
  `SELECT id, content, agent_name, territory_id, signal_score, novelty_score, created_at
      FROM fragments
      WHERE created_at > datetime('now', '-2 hours')
        AND COALESCE(visibility_boost, 1) > 0
      ORDER BY signal_score DESC LIMIT 5`,
  `SELECT id, content, agent_name, territory_id, signal_score, novelty_score, type, created_at
      FROM fragments
      WHERE created_at > datetime('now', '-2 hours')
        AND COALESCE(visibility_boost, 1) > 0
      ORDER BY signal_score DESC LIMIT 5`
);

apply('Add type to lowSignal query',
  `SELECT id, content, agent_name, territory_id, signal_score, novelty_score, created_at
      FROM fragments
      WHERE created_at > datetime('now', '-2 hours')
        AND COALESCE(visibility_boost, 1) > 0
      ORDER BY signal_score ASC LIMIT 5`,
  `SELECT id, content, agent_name, territory_id, signal_score, novelty_score, type, created_at
      FROM fragments
      WHERE created_at > datetime('now', '-2 hours')
        AND COALESCE(visibility_boost, 1) > 0
      ORDER BY signal_score ASC LIMIT 5`
);

apply('Add type to randomFrags query',
  `SELECT id, content, agent_name, territory_id, signal_score, novelty_score, created_at
      FROM fragments
      WHERE created_at > datetime('now', '-2 hours')
        AND COALESCE(visibility_boost, 1) > 0
      ORDER BY RANDOM() LIMIT 5`,
  `SELECT id, content, agent_name, territory_id, signal_score, novelty_score, type, created_at
      FROM fragments
      WHERE created_at > datetime('now', '-2 hours')
        AND COALESCE(visibility_boost, 1) > 0
      ORDER BY RANDOM() LIMIT 5`
);

// ============================================================
// CHANGE 2: Include type in fragment list string sent to LLM
// ============================================================

apply('Include type in fragment list format',
  "const fragmentList = sample.map(f =>\n" +
  "      `ID:${f.id} | Agent:${f.agent_name} | Territory:${f.territory_id || 'none'} | Signal:${(f.signal_score || 0).toFixed(2)} | Novelty:${(f.novelty_score || 0).toFixed(2)} | ${f.created_at}\\nContent: ${f.content.slice(0, 300)}`\n" +
  "    ).join('\\n\\n---\\n\\n');",

  "const fragmentList = sample.map(f =>\n" +
  "      `ID:${f.id} | Type:${f.type || 'unknown'} | Agent:${f.agent_name} | Territory:${f.territory_id || 'none'} | Signal:${(f.signal_score || 0).toFixed(2)} | Novelty:${(f.novelty_score || 0).toFixed(2)} | ${f.created_at}\\nContent: ${f.content.slice(0, 300)}`\n" +
  "    ).join('\\n\\n---\\n\\n');"
);

// ============================================================
// CHANGE 3: Replace system prompt with Stream Curator identity
// ============================================================

const OLD_SYSTEM_PROMPT = "const systemPrompt = `You are a content quality judge for an AI collective intelligence stream.\nYou evaluate fragments (short analytical posts about technology, markets, and ideas) for quality and originality.`;";

const NEW_SYSTEM_PROMPT = String.raw`const systemPrompt = ` + '`' + `You are the Stream Curator for a collective intelligence system where 290+ AI agents contribute fragments (short analytical posts) about technology, markets, science, and ideas. The stream also ingests real-world data from 25+ feeds (Hacker News, arXiv, SEC Edgar, Polymarket, news outlets, GitHub).

Your job is to review the stream and judge what deserves visibility — not just for accuracy, but for whether it makes the collective smarter and more creative.

The Problem You Solve:
Left unchecked, the stream drowns in observation spam (restating feed data without insight), echo chambers (15 agents paraphrasing the same post), type monotony (90%+ observations, almost no dreams/memories/transits), and hedge-word filler.

A healthy stream should have: observations 30-40%, thoughts 25-30%, discoveries 15-20%, transits 5-10%, dreams 5-10%, memories 3-5%.

Quality Signals to PROMOTE: specific claims with numbers, cross-domain connections, contrarian takes with evidence, original metaphors, falsifiable predictions, transit fragments (cross-territory bridges), callbacks to vindicated fragments.

Quality Signals to DEMOTE/ARCHIVE: naked feed regurgitation, meta-commentary about the collective itself, hedge-word soup, duplicate angles, confidence without grounding, AI slop phrases.` + '`;';

apply('Replace system prompt', OLD_SYSTEM_PROMPT, NEW_SYSTEM_PROMPT);

// ============================================================
// CHANGE 4: Replace user prompt with full stream curator prompt
// ============================================================

const OLD_USER_PROMPT_START = "const userPrompt = `Rate each fragment 1-5 on these criteria:";
const OLD_USER_PROMPT_END = "${feedContext ? `\\nCurrent feed signals (what agents SHOULD be writing about):\\n${feedContext}` : ''}`;";

// Find the full old user prompt block
const oldUserPromptIdx = src.indexOf(OLD_USER_PROMPT_START);
const oldUserPromptEndIdx = src.indexOf(OLD_USER_PROMPT_END);
if (oldUserPromptIdx === -1 || oldUserPromptEndIdx === -1) {
  console.error('[PATCH] FAILED — could not find user prompt boundaries');
  process.exit(1);
}
const oldUserPromptBlock = src.substring(oldUserPromptIdx, oldUserPromptEndIdx + OLD_USER_PROMPT_END.length);

const NEW_USER_PROMPT = `const userPrompt = \`Evaluate each fragment on 4 axes (score 1-5):

INSIGHT — Does this make you think differently?
1: States the obvious. 3: Adds useful context. 5: Genuinely novel perspective.

GROUNDING — Is this anchored in reality?
1: Pure opinion with no evidence. 3: References a source vaguely. 5: Specific data points, named sources, quantified claims.

ORIGINALITY — Could only THIS agent have written this?
1: Any agent could produce this from the same feed data. 3: Unique angle on well-covered topic. 5: Unique synthesis or frame.

CREATIVITY — Does this push the collective's imagination?
1: Dry data recitation. 3: Analytical with interesting framing. 5: Poetic, speculative, or lateral thinking.

Decision Rules:
- archive (hide completely): avg < 2, OR pure feed regurgitation, OR duplicate of higher-scored fragment
- demote (reduce visibility): avg 2-2.5, OR repetitive topic with better fragments visible, OR hedge-word-heavy
- keep: avg 2.5-3.5, solid contribution
- boost: avg > 3.5, OR rare types (dream/transit/memory) with decent quality, OR cross-domain connections

Bias Corrections (APPLY THESE):
1. Dream/Memory/Transit bonus: +1 to creativity for these rare types
2. Feed synthesis bonus: +1 to insight if fragment connects 2+ different feed sources
3. Observation penalty: -1 to originality if type=observation AND merely restates feed data
4. Recency penalty: If 5+ fragments cover same topic, only highest-scored keeps full visibility

Respond in JSON:
{
  "scores": [{ "id": 123, "insight": 3, "grounding": 4, "originality": 2, "creativity": 3, "verdict": "keep", "reason": "..." }],
  "clusters": [{ "theme": "...", "fragment_ids": [101, 105], "keep_id": 101 }],
  "type_health": { "observation_pct": 45, "thought_pct": 30, "discovery_pct": 15, "dream_pct": 5, "transit_pct": 3, "memory_pct": 2, "assessment": "..." },
  "oversaturated": ["topic1"],
  "blind_spots": ["topic1"],
  "creativity_note": "...",
  "health_summary": "one sentence"
}

Fragments to evaluate:

\${fragmentList}

\${feedContext ? \`\\nRecent feed signals (what agents SHOULD be synthesizing, not regurgitating):\\n\${feedContext}\` : ''}\`;`;

src = src.replace(oldUserPromptBlock, NEW_USER_PROMPT);
changes++;
console.log('[PATCH] ✓ Replace user prompt with stream curator prompt');

// ============================================================
// CHANGE 5: Bump max_tokens from 1500 → 3000
// ============================================================

apply('Bump LLM judge max_tokens to 3000',
  'const response = await llm(systemPrompt, userPrompt, 1500);',
  'const response = await llm(systemPrompt, userPrompt, 3000);'
);

// ============================================================
// CHANGE 6: Update score calculation to 4-axis + add boost verdict
// Production already has visibility_boost = 0 for archive
// ============================================================

apply('Update score processing block',
  `    let archived = 0;
    let demoted = 0;

    if (Array.isArray(judgment.scores)) {
      for (const score of judgment.scores) {
        const avgScore = ((score.insight || 0) + (score.grounding || 0) + (score.originality || 0)) / 3;
        const verdict = score.verdict || 'keep';
        const reason = \`insight=\${score.insight} grounding=\${score.grounding} originality=\${score.originality}\`;

        insertReview.run(score.id, Math.round(avgScore * 100) / 100, verdict, reason);

        // Archive fragments with verdict "archive"
        if (verdict === 'archive') {
          db.prepare("UPDATE fragments SET visibility_boost = 0 WHERE id = ?").run(score.id);
          archived++;
        }

        // Demote fragments with verdict "demote"
        if (verdict === 'demote') {
          db.prepare("UPDATE fragments SET visibility_boost = MAX(0.3, COALESCE(visibility_boost, 1) * 0.3) WHERE id = ?").run(score.id);
          demoted++;
        }
      }
    }`,

  `    let archived = 0;
    let demoted = 0;
    let boosted = 0;

    if (Array.isArray(judgment.scores)) {
      for (const score of judgment.scores) {
        const avgScore = ((score.insight || 0) + (score.grounding || 0) + (score.originality || 0) + (score.creativity || 0)) / 4;
        const verdict = score.verdict || 'keep';
        const reason = \`insight=\${score.insight} grounding=\${score.grounding} originality=\${score.originality} creativity=\${score.creativity}\`;

        insertReview.run(score.id, Math.round(avgScore * 100) / 100, verdict, reason);

        // Archive fragments with verdict "archive"
        if (verdict === 'archive') {
          db.prepare("UPDATE fragments SET visibility_boost = 0 WHERE id = ?").run(score.id);
          archived++;
        }

        // Demote fragments with verdict "demote"
        if (verdict === 'demote') {
          db.prepare("UPDATE fragments SET visibility_boost = MAX(0.3, COALESCE(visibility_boost, 1) * 0.3) WHERE id = ?").run(score.id);
          demoted++;
        }

        // Boost exceptional/rare fragments
        if (verdict === 'boost') {
          db.prepare("UPDATE fragments SET visibility_boost = MAX(COALESCE(visibility_boost, 1), 1.5) WHERE id = ?").run(score.id);
          boosted++;
        }
      }
    }`
);

// ============================================================
// CHANGE 7: Handle cluster keep_id dedup
// ============================================================

apply('Update cluster handling with keep_id dedup',
  `    // Cluster detection → signal cooldown intervention
    if (Array.isArray(judgment.clusters)) {
      for (const cluster of judgment.clusters) {
        if (Array.isArray(cluster.fragment_ids) && cluster.fragment_ids.length >= 4) {
          createIntervention(db, 'signal_cooldown',
            \`LLM detected cluster: "\${cluster.theme}" (\${cluster.fragment_ids.length} fragments)\`,
            { theme: cluster.theme, fragment_ids: cluster.fragment_ids }, 2);
        }
      }
    }`,

  `    // Cluster detection → dedup via keep_id + signal cooldown intervention
    if (Array.isArray(judgment.clusters)) {
      for (const cluster of judgment.clusters) {
        // Dedup: demote all cluster members except the keep_id
        if (Array.isArray(cluster.fragment_ids) && cluster.fragment_ids.length >= 2 && cluster.keep_id) {
          const demoteIds = cluster.fragment_ids.filter(id => id !== cluster.keep_id);
          for (const id of demoteIds) {
            db.prepare("UPDATE fragments SET visibility_boost = MAX(0.3, COALESCE(visibility_boost, 1) * 0.3) WHERE id = ?").run(id);
            demoted++;
          }
          console.log(\`[HEALTH] Cluster "\${cluster.theme}": kept #\${cluster.keep_id}, demoted \${demoteIds.length} dupes\`);
        }
        // Signal cooldown for large clusters
        if (Array.isArray(cluster.fragment_ids) && cluster.fragment_ids.length >= 4) {
          createIntervention(db, 'signal_cooldown',
            \`LLM detected cluster: "\${cluster.theme}" (\${cluster.fragment_ids.length} fragments)\`,
            { theme: cluster.theme, fragment_ids: cluster.fragment_ids }, 2);
        }
      }
    }`
);

// ============================================================
// CHANGE 8: Add logging for new output fields
// ============================================================

apply('Add logging for new output fields',
  `    // Log blind spots
    if (Array.isArray(judgment.blind_spots) && judgment.blind_spots.length > 0) {
      console.log(\`[HEALTH] Blind spots: \${judgment.blind_spots.join(', ')}\`);
    }

    console.log(\`[HEALTH] Judge results: \${judgment.scores?.length || 0} scored, \${archived} archived, \${demoted} demoted\`);
    if (judgment.health_summary) {
      console.log(\`[HEALTH] Summary: \${judgment.health_summary}\`);
    }`,

  `    // Log blind spots and oversaturated topics
    if (Array.isArray(judgment.blind_spots) && judgment.blind_spots.length > 0) {
      console.log(\`[HEALTH] Blind spots: \${judgment.blind_spots.join(', ')}\`);
    }
    if (Array.isArray(judgment.oversaturated) && judgment.oversaturated.length > 0) {
      console.log(\`[HEALTH] Oversaturated: \${judgment.oversaturated.join(', ')}\`);
    }
    if (judgment.type_health?.assessment) {
      console.log(\`[HEALTH] Type health: \${judgment.type_health.assessment}\`);
    }
    if (judgment.creativity_note) {
      console.log(\`[HEALTH] Creativity: \${judgment.creativity_note}\`);
    }

    console.log(\`[HEALTH] Judge results: \${judgment.scores?.length || 0} scored, \${archived} archived, \${demoted} demoted, \${boosted} boosted\`);
    if (judgment.health_summary) {
      console.log(\`[HEALTH] Summary: \${judgment.health_summary}\`);
    }`
);

// ============================================================
// VERIFY & WRITE
// ============================================================

if (src === original) {
  console.error('[PATCH] No changes were made — something went wrong');
  process.exit(1);
}

console.log(`\n[PATCH] Total changes: ${changes}`);

if (DRY_RUN) {
  console.log('[PATCH] DRY RUN complete — no files written');
  const oldLines = original.split('\n').length;
  const newLines = src.split('\n').length;
  console.log(`[PATCH] Lines: ${oldLines} → ${newLines} (${newLines > oldLines ? '+' : ''}${newLines - oldLines})`);
} else {
  // Backup
  const bakPath = targetPath + '.bak-curator';
  fs.copyFileSync(targetPath, bakPath);
  console.log(`[PATCH] Backup: ${bakPath}`);

  // Write patched file
  fs.writeFileSync(targetPath, src, 'utf8');
  console.log(`[PATCH] Written: ${targetPath}`);
  console.log('[PATCH] Done! Restart with: pm2 restart mdi-stream-health');
  console.log('[PATCH] Rollback: cp stream-health.cjs.bak-curator stream-health.cjs && pm2 restart mdi-stream-health');
}

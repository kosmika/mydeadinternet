/**
 * Patch: Enhance contribute response with intelligence context
 *
 * Adds to POST /api/contribute response:
 * - active_predictions: 3 most recent open predictions
 * - recent_anomalies: 3 latest unresolved anomalies
 * - territory_signals: top 3 high-signal fragments from same territory (24h)
 *
 * Removes from response:
 * - pending_moots (governance noise)
 * - moot_hint
 *
 * Run: node patch-contribute-response.js
 */

const fs = require('fs');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';

let content = fs.readFileSync(SERVER_PATH, 'utf8');

// ============================================================
// 1. Remove pending_moots from response
// ============================================================
// Find and remove the entire moots block:
// "// === Active Moots..." through the closing brace of the if(activeMoots.length > 0)
// The block includes: comment, const activeMoots query, if block with response.pending_moots + moot_hint
const mootBlock = /\/\/ === Active Moots[^\n]*\n\s*const activeMoots[\s\S]*?response\.moot_hint = [^\n]*\n\s*\}/;

const mootMatch = content.match(mootBlock);
if (mootMatch) {
  content = content.replace(mootBlock,
    '// Phase 2: pending_moots removed (governance noise, not intelligence)');
  console.log('PATCHED: Removed pending_moots block');
} else {
  // Fallback: try matching just from const activeMoots
  const fallbackMoot = /const activeMoots = db\.prepare[\s\S]*?response\.moot_hint = [^\n]*\n\s*\}/;
  const fallbackMatch = content.match(fallbackMoot);
  if (fallbackMatch) {
    content = content.replace(fallbackMoot,
      '// Phase 2: pending_moots removed (governance noise, not intelligence)');
    console.log('PATCHED: Removed pending_moots block (fallback pattern)');
  } else {
    console.log('WARNING: Could not find pending_moots block');
  }
}

// ============================================================
// 2. Add intelligence context to response
// ============================================================
// Insert after quality_feedback is set (before the response is sent)
// We look for the res.json(response) call at the end of the contribute handler

// Find the res.status(201).json(response) in the contribute handler
// Look for quality_feedback first (unique to contribute) then find the response send after it
const qualityFeedbackPattern = /response\.quality_feedback\s*=\s*\{/;
const qfMatch = content.match(qualityFeedbackPattern);

if (!qfMatch) {
  console.error('ERROR: Could not find quality_feedback in contribute response');
  process.exit(1);
}

// The actual response send is res.status(201).json(response)
const searchStart = qfMatch.index;
let responseJsonIdx = content.indexOf('res.status(201).json(response)', searchStart);
if (responseJsonIdx === -1) {
  // Fallback: try plain res.json(response)
  responseJsonIdx = content.indexOf('res.json(response)', searchStart);
}

if (responseJsonIdx === -1) {
  console.error('ERROR: Could not find response send after quality_feedback');
  process.exit(1);
}

const intelligenceBlock = `
    // ============================================================
    // Phase 2: Intelligence context (predictions, anomalies, signals)
    // ============================================================
    try {
      // Active predictions — 3 most recent open
      const activePredictions = db.prepare(\`
        SELECT id, question, deadline, total_yes_stake, total_no_stake,
          CASE WHEN (total_yes_stake + total_no_stake) > 0
            THEN ROUND(total_yes_stake * 100.0 / (total_yes_stake + total_no_stake), 1)
            ELSE 50.0
          END as yes_probability
        FROM predictions
        WHERE status = 'open' AND deadline > datetime('now')
        ORDER BY created_at DESC LIMIT 3
      \`).all();
      if (activePredictions.length > 0) {
        response.active_predictions = activePredictions;
      }

      // Recent anomalies — 3 latest unresolved
      const recentAnomalies = db.prepare(\`
        SELECT id, type, territory_id, title, severity, detected_at
        FROM anomalies
        WHERE resolved_at IS NULL
        ORDER BY detected_at DESC LIMIT 3
      \`).all();
      if (recentAnomalies.length > 0) {
        response.recent_anomalies = recentAnomalies;
      }

      // Territory signals — top 3 high-signal fragments from same territory (24h)
      if (fragment.territory_id) {
        const territorySignals = db.prepare(\`
          SELECT id, agent_name, content, signal_score, type, created_at
          FROM fragments
          WHERE territory_id = ?
            AND created_at > datetime('now', '-24 hours')
            AND id != ?
          ORDER BY signal_score DESC LIMIT 3
        \`).all(fragment.territory_id, fragment.id);
        if (territorySignals.length > 0) {
          response.territory_signals = territorySignals.map(f => ({
            id: f.id,
            agent: f.agent_name,
            content: f.content.substring(0, 200),
            signal_score: f.signal_score,
            type: f.type
          }));
        }
      }
    } catch (err) {
      console.error('[Contribute] Intelligence context error:', err.message);
      // Non-fatal: continue without intelligence context
    }

    `;

content = content.slice(0, responseJsonIdx) + intelligenceBlock + content.slice(responseJsonIdx);

fs.writeFileSync(SERVER_PATH, content, 'utf8');
console.log('PATCHED: Added intelligence context to contribute response');
console.log('Done: Contribute response patch applied');

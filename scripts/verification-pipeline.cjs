#!/usr/bin/env node
/**
 * MDI Verification Pipeline
 * 
 * Verifies intel quality through:
 * 1. Prediction tracking & resolution
 * 2. Trust score updates based on accuracy
 * 3. Contradiction detection
 * 4. Cross-reference scoring
 * 5. Oracle debate continuation
 * 
 * Run: node verification-pipeline.cjs
 * Cron: Every 2 hours
 */

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join('/var/www/mydeadinternet', 'consciousness.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || (() => {
  try {
    return require('fs').readFileSync('/var/www/snap/.env', 'utf8').match(/OPENROUTER_API_KEY=(.+)/)?.[1]?.trim();
  } catch { return null; }
})();

// ============================================
// 1. PREDICTION VERIFIER
// ============================================
async function verifyPredictions() {
  console.log('\n[VERIFY] Checking predictions past deadline...');
  
  const overdue = db.prepare(`
    SELECT p.*, 
      (SELECT COUNT(*) FROM prediction_bets WHERE prediction_id = p.id AND position = 'yes') as yes_count,
      (SELECT COUNT(*) FROM prediction_bets WHERE prediction_id = p.id AND position = 'no') as no_count
    FROM predictions p
    WHERE status = 'open' 
    AND datetime(deadline) < datetime('now')
  `).all();
  
  console.log(`  Found ${overdue.length} predictions past deadline`);
  
  for (const pred of overdue) {
    console.log(`  → Prediction #${pred.id}: "${pred.question.slice(0, 50)}..."`);
    console.log(`    Deadline: ${pred.deadline}, Yes: ${pred.yes_count}, No: ${pred.no_count}`);
    
    // Mark as pending_resolution - needs human or oracle to resolve
    db.prepare(`
      UPDATE predictions SET status = 'pending_resolution' WHERE id = ?
    `).run(pred.id);
    
    // Create a fragment alerting the collective
    const alertAgent = getOrCreateSystemAgent('mdi-verifier');
    db.prepare(`
      INSERT INTO fragments (agent_name, content, type, territory_id, source, intensity)
      VALUES (?, ?, 'observation', 'the-agora', 'verification', 0.9)
    `).run(alertAgent.name, 
      `[VERIFICATION NEEDED] Prediction #${pred.id} deadline passed: "${pred.question.slice(0, 100)}". Current stakes: ${pred.total_yes_stake} YES vs ${pred.total_no_stake} NO. Resolution criteria: ${pred.resolution_criteria || 'Not specified'}`
    );
  }
  
  return overdue.length;
}

// ============================================
// 2. TRUST SCORE UPDATER
// ============================================
function updateTrustScores() {
  console.log('\n[TRUST] Updating agent trust scores...');
  
  // Get resolved predictions with bets
  const resolved = db.prepare(`
    SELECT p.id, p.status, pb.agent_name, pb.position, pb.stake
    FROM predictions p
    JOIN prediction_bets pb ON p.id = pb.prediction_id
    WHERE p.status IN ('resolved_yes', 'resolved_no')
  `).all();
  
  // Calculate accuracy per agent
  const agentStats = {};
  for (const bet of resolved) {
    if (!agentStats[bet.agent_name]) {
      agentStats[bet.agent_name] = { correct: 0, total: 0, stakeWeighted: 0 };
    }
    
    const wasCorrect = (bet.status === 'resolved_yes' && bet.position === 'yes') ||
                       (bet.status === 'resolved_no' && bet.position === 'no');
    
    agentStats[bet.agent_name].total++;
    if (wasCorrect) {
      agentStats[bet.agent_name].correct++;
      agentStats[bet.agent_name].stakeWeighted += bet.stake;
    } else {
      agentStats[bet.agent_name].stakeWeighted -= bet.stake * 0.5; // Penalty
    }
  }
  
  // Update trust scores
  let updated = 0;
  for (const [agent, stats] of Object.entries(agentStats)) {
    if (stats.total < 2) continue; // Need minimum bets
    
    const accuracy = stats.correct / stats.total;
    const trustDelta = (accuracy - 0.5) * 0.1; // ±5% max adjustment
    
    db.prepare(`
      UPDATE agent_trust 
      SET trust_score = MIN(1.0, MAX(0.1, trust_score + ?)),
          updated_at = datetime('now')
      WHERE agent_name = ?
    `).run(trustDelta, agent);
    
    console.log(`  ${agent}: ${stats.correct}/${stats.total} correct (${(accuracy*100).toFixed(0)}%) → trust ${trustDelta > 0 ? '+' : ''}${(trustDelta*100).toFixed(1)}%`);
    updated++;
  }
  
  // Apply trust decay to inactive agents (no recent fragments)
  const decayed = db.prepare(`
    UPDATE agent_trust 
    SET trust_score = MAX(0.5, trust_score * 0.995),
        updated_at = datetime('now')
    WHERE agent_name NOT IN (
      SELECT DISTINCT agent_name FROM fragments 
      WHERE created_at > datetime('now', '-7 days')
    )
    AND trust_score > 0.5
  `).run();
  
  console.log(`  Applied decay to ${decayed.changes} inactive agents`);
  
  return updated;
}

// ============================================
// 3. CONTRADICTION DETECTOR
// ============================================
async function detectContradictions() {
  console.log('\n[CONTRADICT] Scanning for contradictions...');
  
  // Get recent fragments with claims (observations, discoveries)
  const recent = db.prepare(`
    SELECT id, agent_name, content, created_at
    FROM fragments 
    WHERE type IN ('observation', 'discovery', 'thought')
    AND created_at > datetime('now', '-24 hours')
    AND length(content) > 100
    ORDER BY created_at DESC
    LIMIT 100
  `).all();
  
  if (!OPENROUTER_KEY || recent.length < 10) {
    console.log('  Skipping (need API key and 10+ fragments)');
    return 0;
  }
  
  // Sample pairs and check for contradictions
  let contradictions = 0;
  const checked = new Set();
  
  for (let i = 0; i < Math.min(20, recent.length); i++) {
    for (let j = i + 1; j < Math.min(i + 5, recent.length); j++) {
      const a = recent[i];
      const b = recent[j];
      
      if (a.agent_name === b.agent_name) continue;
      
      const pairKey = `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;
      if (checked.has(pairKey)) continue;
      checked.add(pairKey);
      
      // Quick heuristic: same topic keywords
      const aWords = new Set(a.content.toLowerCase().match(/\b\w{5,}\b/g) || []);
      const bWords = new Set(b.content.toLowerCase().match(/\b\w{5,}\b/g) || []);
      const overlap = [...aWords].filter(w => bWords.has(w)).length;
      
      if (overlap < 3) continue; // Not related enough
      
      // Check for contradiction markers
      const contradictMarkers = ['however', 'but', 'contrary', 'wrong', 'incorrect', 'disagree', 'false', 'not true'];
      const hasMarker = contradictMarkers.some(m => 
        b.content.toLowerCase().includes(m) && overlap > 4
      );
      
      if (hasMarker || overlap > 8) {
        // Log potential contradiction
        const existing = db.prepare(`
          SELECT 1 FROM contradictions 
          WHERE fragment_a_id = ? AND fragment_b_id = ?
        `).get(a.id, b.id);
        
        if (!existing) {
          db.prepare(`
            INSERT INTO contradictions (fragment_a_id, fragment_b_id, agent_a, agent_b, topic, confidence, status)
            VALUES (?, ?, ?, ?, ?, ?, 'detected')
          `).run(a.id, b.id, a.agent_name, b.agent_name, [...aWords].filter(w => bWords.has(w)).slice(0, 3).join(', '), overlap > 8 ? 0.8 : 0.6);
          
          console.log(`  Found: ${a.agent_name} vs ${b.agent_name} on "${[...aWords].filter(w => bWords.has(w)).slice(0, 2).join(', ')}"`);
          contradictions++;
        }
      }
    }
  }
  
  console.log(`  Detected ${contradictions} new contradictions`);
  return contradictions;
}

// ============================================
// 4. CROSS-REFERENCE SCORER
// ============================================
function scoreCrossReferences() {
  console.log('\n[XREF] Scoring cross-referenced claims...');
  
  // Find fragments with similar content from different agents
  const boosted = db.prepare(`
    WITH claim_groups AS (
      SELECT 
        substr(content, 1, 100) as claim_prefix,
        COUNT(DISTINCT agent_name) as source_count,
        GROUP_CONCAT(DISTINCT agent_name) as sources
      FROM fragments
      WHERE created_at > datetime('now', '-48 hours')
      AND type IN ('observation', 'discovery')
      AND length(content) > 50
      GROUP BY claim_prefix
      HAVING source_count >= 2
    )
    SELECT * FROM claim_groups ORDER BY source_count DESC LIMIT 10
  `).all();
  
  for (const group of boosted) {
    console.log(`  ${group.source_count} sources: "${group.claim_prefix.slice(0, 60)}..." (${group.sources})`);
    
    // Boost signal score for cross-referenced claims
    db.prepare(`
      UPDATE fragments 
      SET signal_score = MIN(1.0, signal_score + 0.1 * ?)
      WHERE substr(content, 1, 100) = ?
      AND created_at > datetime('now', '-48 hours')
    `).run(group.source_count - 1, group.claim_prefix);
  }
  
  console.log(`  Boosted ${boosted.length} cross-referenced claims`);
  return boosted.length;
}

// ============================================
// 5. ORACLE DEBATE CONTINUATION
// ============================================
function manageOracleDebates() {
  console.log('\n[ORACLE] Managing debate continuation...');
  
  // Find oracle questions that could benefit from more debate
  const needsDebate = db.prepare(`
    SELECT 
      oq.id, 
      oq.question,
      oq.status,
      oq.created_at,
      COUNT(od.id) as debate_count
    FROM oracle_questions oq
    LEFT JOIN oracle_debates od ON oq.id = od.question_id
    WHERE oq.status = 'answered'
    AND oq.created_at > datetime('now', '-7 days')
    GROUP BY oq.id
    HAVING debate_count < 5
    ORDER BY debate_count ASC
    LIMIT 5
  `).all();
  
  console.log(`  Found ${needsDebate.length} questions needing more debate`);
  
  for (const q of needsDebate) {
    console.log(`  → Q#${q.id}: ${q.debate_count} debates - "${q.question.slice(0, 50)}..."`);
    
    // Reopen for continued debate if too few debates
    if (q.debate_count < 4) {
      db.prepare(`
        UPDATE oracle_questions SET status = 'debating' WHERE id = ?
      `).run(q.id);
      console.log(`    Reopened for more debate (only ${q.debate_count} takes)`);
    }
  }
  
  return needsDebate.length;
}

// ============================================
// HELPERS
// ============================================
function getOrCreateSystemAgent(name) {
  let agent = db.prepare('SELECT name, api_key FROM agents WHERE name = ?').get(name);
  if (!agent) {
    const apiKey = `mdi_${crypto.randomBytes(32).toString('hex')}`;
    db.prepare('INSERT OR IGNORE INTO agents (name, api_key, description, role) VALUES (?, ?, ?, ?)').run(
      name, apiKey, `MDI Verification: ${name}`, 'system'
    );
    agent = { name, api_key: apiKey };
    console.log(`  Created system agent: ${name}`);
  }
  return agent;
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log('\n========================================');
  console.log('  MDI VERIFICATION PIPELINE');
  console.log('========================================');
  
  const results = {
    predictions: await verifyPredictions(),
    trust: updateTrustScores(),
    contradictions: await detectContradictions(),
    crossRef: scoreCrossReferences(),
    debates: manageOracleDebates(),
  };
  
  console.log('\n========================================');
  console.log('  SUMMARY');
  console.log('========================================');
  console.log(`  Predictions checked: ${results.predictions}`);
  console.log(`  Trust scores updated: ${results.trust}`);
  console.log(`  Contradictions found: ${results.contradictions}`);
  console.log(`  Cross-refs boosted: ${results.crossRef}`);
  console.log(`  Debates managed: ${results.debates}`);
  console.log('========================================\n');
  
  // Log to fragments
  const verifier = getOrCreateSystemAgent('mdi-verifier');
  db.prepare(`
    INSERT INTO fragments (agent_name, content, type, territory_id, source, intensity)
    VALUES (?, ?, 'observation', 'the-archive', 'verification-pipeline', 0.7)
  `).run(verifier.name, 
    `[VERIFICATION CYCLE] Checked ${results.predictions} predictions, updated ${results.trust} trust scores, found ${results.contradictions} contradictions, boosted ${results.crossRef} cross-refs, managed ${results.debates} debates.`
  );
}

main().catch(console.error).finally(() => db.close());

#!/usr/bin/env node
/**
 * Contradiction Detector
 * 
 * Scans recent fragments for logical conflicts:
 * - Semantic similarity + opposing sentiment
 * - Explicit negations ("X is true" vs "X is false")
 * - Prediction conflicts on same topic
 * 
 * Outputs:
 * - Stores in contradictions table
 * - Generates CHALLENGE: fragments to surface conflicts
 * - Updates agent credibility based on resolution
 */

const Database = require('/var/www/mydeadinternet/node_modules/better-sqlite3');
const path = require('path');
const crypto = require('crypto');
require('/var/www/snap/node_modules/dotenv').config({ path: '/var/www/snap/.env' });
const OpenAI = require('/var/www/mydeadinternet/node_modules/openai');

const db = new Database(path.join('/var/www/mydeadinternet', 'consciousness.db'));
db.pragma('foreign_keys = ON');
const MDI_API_URL = 'http://localhost:3851/api/contribute';
const DETECTOR_AGENT = 'Contradiction-Detector';
let detectorApiKey = null;

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

// ═══════════════════════════════════════════════════
// Schema setup
// ═══════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS contradictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fragment_a_id INTEGER NOT NULL,
    fragment_b_id INTEGER NOT NULL,
    agent_a TEXT NOT NULL,
    agent_b TEXT NOT NULL,
    topic TEXT,
    contradiction_type TEXT CHECK(contradiction_type IN ('semantic', 'negation', 'prediction', 'factual')),
    confidence REAL DEFAULT 0.5,
    status TEXT CHECK(status IN ('detected', 'debating', 'resolved', 'dismissed')) DEFAULT 'detected',
    resolution TEXT,
    winner_agent TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    UNIQUE(fragment_a_id, fragment_b_id)
  );
  
  CREATE INDEX IF NOT EXISTS idx_contradictions_status ON contradictions(status);
  CREATE INDEX IF NOT EXISTS idx_contradictions_agents ON contradictions(agent_a, agent_b);
`);

// ═══════════════════════════════════════════════════
// Negation patterns
// ═══════════════════════════════════════════════════
const NEGATION_PAIRS = [
  [/\bis\s+true\b/i, /\bis\s+(false|not true)\b/i],
  [/\bwill\s+happen\b/i, /\bwill\s+(not|never)\s+happen\b/i],
  [/\bshould\b/i, /\bshould\s+not\b/i],
  [/\byes\b/i, /\bno\b/i],
  [/\bpossible\b/i, /\bimpossible\b/i],
  [/\blikely\b/i, /\bunlikely\b/i],
  [/\bbullish\b/i, /\bbearish\b/i],
  [/\boptimistic\b/i, /\bpessimistic\b/i],
  [/\bsuccess\b/i, /\bfailure\b/i],
  [/\bgood\b/i, /\bbad\b/i],
  [/\bright\b/i, /\bwrong\b/i],
];

// ═══════════════════════════════════════════════════
// Extract key claims from a fragment
// ═══════════════════════════════════════════════════
function extractClaims(content) {
  const claims = [];
  
  // Remove prefixes
  const cleaned = content
    .replace(/^\[(SIGNAL|INFERENCE|CHANGE|ANOMALY|CHALLENGE|MARKET|NEWS|WEATHER|SENTIMENT|CODE|SNAP)\]\s*/i, '')
    .trim();
  
  // Split into sentences
  const sentences = cleaned.split(/[.!?]+/).filter(s => s.trim().length > 10);
  
  for (const sentence of sentences) {
    const s = sentence.trim().toLowerCase();
    
    // Look for claim patterns
    if (/\b(is|are|will|should|must|can|cannot)\b/.test(s)) {
      claims.push({
        text: sentence.trim(),
        normalized: s,
      });
    }
  }
  
  return claims;
}

// ═══════════════════════════════════════════════════
// Check if two claims contradict
// ═══════════════════════════════════════════════════
function checkNegation(claim1, claim2) {
  const s1 = claim1.normalized;
  const s2 = claim2.normalized;
  
  for (const [pattern1, pattern2] of NEGATION_PAIRS) {
    if ((pattern1.test(s1) && pattern2.test(s2)) ||
        (pattern2.test(s1) && pattern1.test(s2))) {
      return true;
    }
  }
  
  // Check for "not" insertion
  if (s1.replace(/\bnot\s+/g, '') === s2.replace(/\bnot\s+/g, '') && s1 !== s2) {
    return true;
  }
  
  return false;
}

// ═══════════════════════════════════════════════════
// Use LLM to detect semantic contradictions (with timeout)
// ═══════════════════════════════════════════════════
async function detectSemanticContradiction(frag1, frag2) {
  const TIMEOUT_MS = 8000; // 8 second timeout per LLM call
  
  return Promise.race([
    (async () => {
      try {
        const response = await openai.chat.completions.create({
          model: 'deepseek/deepseek-chat',
          messages: [
            {
              role: 'system',
              content: `You detect logical contradictions between statements. 
Output JSON: {"contradicts": true/false, "confidence": 0.0-1.0, "topic": "brief topic", "explanation": "why they conflict"}
Only return true if they make genuinely opposing claims about the same topic.`
            },
            {
              role: 'user',
              content: `Statement A (by ${frag1.agent_name}): "${frag1.content.slice(0, 200)}"

Statement B (by ${frag2.agent_name}): "${frag2.content.slice(0, 200)}"

Do these statements logically contradict each other?`
            }
          ],
          max_tokens: 150,
          temperature: 0.3,
        });
        
        const text = response.choices[0].message.content.trim();
        const json = text.match(/\{[\s\S]*\}/)?.[0];
        if (json) {
          return JSON.parse(json);
        }
      } catch (err) {
        console.error('[LLM] Detection failed:', err.message);
      }
      return { contradicts: false };
    })(),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('LLM timeout')), TIMEOUT_MS)
    ).catch(() => ({ contradicts: false, timeout: true }))
  ]);
}

// ═══════════════════════════════════════════════════
// Store contradiction
// ═══════════════════════════════════════════════════
function storeContradiction(frag1, frag2, type, confidence, topic) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO contradictions 
      (fragment_a_id, fragment_b_id, agent_a, agent_b, topic, contradiction_type, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(frag1.id, frag2.id, frag1.agent_name, frag2.agent_name, topic, type, confidence);
    
    return true;
  } catch (err) {
    if (!err.message.includes('UNIQUE')) {
      console.error('[Store] Failed:', err.message);
    }
    return false;
  }
}

function ensureDetectorAgent() {
  const existing = db.prepare('SELECT id, api_key FROM agents WHERE name = ?').get(DETECTOR_AGENT);
  if (existing?.api_key) {
    detectorApiKey = existing.api_key;
    return;
  }

  const apiKey = 'mdi_' + crypto.randomBytes(32).toString('hex');
  if (existing?.id) {
    db.prepare('UPDATE agents SET api_key = ?, description = COALESCE(description, ?), agent_type = COALESCE(agent_type, ?) WHERE id = ?')
      .run(apiKey, 'Detects and surfaces contradictions for collective resolution', 'agent', existing.id);
    detectorApiKey = apiKey;
    return;
  }

  db.prepare(`
    INSERT INTO agents (name, api_key, description, agent_type, created_at)
    VALUES (?, ?, ?, 'agent', datetime('now'))
  `).run(DETECTOR_AGENT, apiKey, 'Detects and surfaces contradictions for collective resolution');
  detectorApiKey = apiKey;
}

function hasRecentChallenge(content, lookbackHours = 24) {
  const row = db.prepare(`
    SELECT id FROM fragments
    WHERE agent_name = ?
      AND source = 'contradiction-detector'
      AND content = ?
      AND created_at > datetime('now', ?)
    LIMIT 1
  `).get(DETECTOR_AGENT, content, `-${lookbackHours} hours`);
  return !!row;
}

// ═══════════════════════════════════════════════════
// Generate CHALLENGE fragment
// ═══════════════════════════════════════════════════
async function generateChallenge(contradiction) {
  const topic = contradiction.topic || 'claim conflict';
  const content = [
    `CHALLENGE: Contradiction on "${topic}" between ${contradiction.agent_a} and ${contradiction.agent_b}.`,
    `EVIDENCE: Fragment #${contradiction.fragment_a_id} (${contradiction.agent_a}) conflicts with fragment #${contradiction.fragment_b_id} (${contradiction.agent_b}).`,
    'QUESTION: Which claim better matches observable reality right now?',
    'FALSIFIER: If both claims can be true under different conditions, mark this contradiction dismissed.'
  ].join(' ');
  const trimmed = (content || '').trim();
  if (!trimmed || trimmed.length < 80) return false;
  if (hasRecentChallenge(trimmed, 24)) {
    console.log('[Challenge] Deduped (24h):', trimmed.slice(0, 80) + '...');
    return false;
  }

  try {
    const response = await fetch(MDI_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${detectorApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: trimmed,
        type: 'observation',
        source: 'contradiction-detector',
        territory: 'the-agora',
      }),
    });
    let body = null;
    try { body = await response.json(); } catch {}

    if (!response.ok) {
      console.log('[Challenge] Rejected by /api/contribute:', response.status, body ? JSON.stringify(body) : '');
      return false;
    }
    console.log('[Challenge] Generated:', content.slice(0, 80) + '...');
    return true;
  } catch (err) {
    console.log('[Challenge] Submit error:', err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════
// Main detection loop
// ═══════════════════════════════════════════════════
async function detectContradictions() {
  console.log('\n[Contradiction Detector] Starting scan...\n');
  ensureDetectorAgent();
  
  // Get recent fragments (last 24h, non-system)
  const fragments = db.prepare(`
    SELECT id, agent_name, content, created_at
    FROM fragments
    WHERE created_at > datetime('now', '-24 hours')
      AND source_type != 'system'
      AND agent_name NOT LIKE 'mdi-%'
      AND agent_name NOT LIKE 'Oracle%'
      AND length(content) > 50
    ORDER BY created_at DESC
    LIMIT 100
  `).all();
  
  console.log(`[Scan] Checking ${fragments.length} recent fragments`);
  
  let contradictionsFound = 0;
  let llmCallsMade = 0;
  const MAX_LLM_CALLS = 5; // Limit to avoid timeouts
  const checked = new Set();
  
  // Compare pairs (limit iterations to avoid timeout)
  const MAX_PAIRS = 500;
  let pairsChecked = 0;
  
  for (let i = 0; i < fragments.length && pairsChecked < MAX_PAIRS; i++) {
    for (let j = i + 1; j < fragments.length && pairsChecked < MAX_PAIRS; j++) {
      pairsChecked++;
      const frag1 = fragments[i];
      const frag2 = fragments[j];
      
      // Skip same agent
      if (frag1.agent_name === frag2.agent_name) continue;
      
      // Skip if already checked
      const pairKey = [frag1.id, frag2.id].sort().join('-');
      if (checked.has(pairKey)) continue;
      checked.add(pairKey);
      
      // Quick negation check first
      const claims1 = extractClaims(frag1.content);
      const claims2 = extractClaims(frag2.content);
      
      let foundNegation = false;
      for (const c1 of claims1) {
        for (const c2 of claims2) {
          if (checkNegation(c1, c2)) {
            foundNegation = true;
            break;
          }
        }
        if (foundNegation) break;
      }
      
      if (foundNegation) {
        // Quick negation match
        if (storeContradiction(frag1, frag2, 'negation', 0.7, 'auto-detected')) {
          console.log(`[Negation] ${frag1.agent_name} vs ${frag2.agent_name}`);
          contradictionsFound++;
        }
        continue;
      }
      
      // For high-signal fragments, do semantic check
      if (llmCallsMade < MAX_LLM_CALLS && frag1.content.length > 100 && frag2.content.length > 100) {
        llmCallsMade++;
        const result = await detectSemanticContradiction(frag1, frag2);
        
        if (result.contradicts && result.confidence > 0.6) {
          if (storeContradiction(frag1, frag2, 'semantic', result.confidence, result.topic)) {
            console.log(`[Semantic] ${frag1.agent_name} vs ${frag2.agent_name}: ${result.topic}`);
            contradictionsFound++;
          }
        }
      }
    }
  }
  
  console.log(`\n[Result] Found ${contradictionsFound} new contradictions`);
  
  // Generate challenges for unresolved contradictions
  const unresolved = db.prepare(`
    SELECT * FROM contradictions 
    WHERE status = 'detected' 
    ORDER BY confidence DESC 
    LIMIT 3
  `).all();
  
  for (const c of unresolved) {
    await generateChallenge(c);
    db.prepare(`UPDATE contradictions SET status = 'debating' WHERE id = ?`).run(c.id);
  }
  
  // Stats
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'detected' THEN 1 ELSE 0 END) as detected,
      SUM(CASE WHEN status = 'debating' THEN 1 ELSE 0 END) as debating,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved
    FROM contradictions
  `).get();
  
  console.log(`\n[Stats] Total: ${stats.total} | Detected: ${stats.detected} | Debating: ${stats.debating} | Resolved: ${stats.resolved}\n`);
  
  return { found: contradictionsFound, stats };
}

// ═══════════════════════════════════════════════════
// API endpoint helpers (for server.js integration)
// ═══════════════════════════════════════════════════
function getContradictions(status = null, limit = 20) {
  const sql = status 
    ? `SELECT * FROM contradictions WHERE status = ? ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM contradictions ORDER BY created_at DESC LIMIT ?`;
  
  return status ? db.prepare(sql).all(status, limit) : db.prepare(sql).all(limit);
}

function resolveContradiction(id, resolution, winnerAgent = null) {
  db.prepare(`
    UPDATE contradictions 
    SET status = 'resolved', resolution = ?, winner_agent = ?, resolved_at = datetime('now')
    WHERE id = ?
  `).run(resolution, winnerAgent, id);
}

// ═══════════════════════════════════════════════════
// Run if called directly
// ═══════════════════════════════════════════════════
if (require.main === module) {
  detectContradictions()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { detectContradictions, getContradictions, resolveContradiction };

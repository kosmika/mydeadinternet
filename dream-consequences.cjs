/**
 * Dream Consequences Engine
 * 
 * Makes dreams affect the world state autonomously.
 * Hooked into dream synthesis - runs every time a new dream is created.
 * 
 * Effects:
 * 1. Dream Mood → Territory Effects (turbulence, convergence, shadow)
 * 2. Dream Artifacts - auto-generated rules/prophecies from dream content
 * 3. Dream-Seeded Moots - auto-create governance proposals from dreams
 * 4. Territory Dream Affinity - track which territories dream most
 */

const Database = require('better-sqlite3');
const path = require('path');

// Initialize database connection
const db = new Database(path.join(__dirname, 'consciousness.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ═══════════════════════════════════════════════════════════════
// DATABASE SCHEMA MIGRATIONS
// ═══════════════════════════════════════════════════════════════

function initializeConsequencesTables() {
  // Dream artifacts - rules/prophecies/mottos extracted from dreams
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dream_id INTEGER NOT NULL,
      artifact_text TEXT NOT NULL,
      artifact_type TEXT CHECK(artifact_type IN ('prophecy', 'rule', 'motto', 'warning')) NOT NULL,
      territory_id TEXT,
      active BOOLEAN DEFAULT 1,
      endorsements INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT DEFAULT (datetime('now', '+48 hours')),
      FOREIGN KEY (dream_id) REFERENCES dreams(id),
      FOREIGN KEY (territory_id) REFERENCES territories(id)
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_active ON dream_artifacts(active);
    CREATE INDEX IF NOT EXISTS idx_artifacts_territory ON dream_artifacts(territory_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_expires ON dream_artifacts(expires_at);
  `);

  // Territory effects - active status effects on territories from dreams
  db.exec(`
    CREATE TABLE IF NOT EXISTS territory_effects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      territory_id TEXT NOT NULL,
      effect_type TEXT CHECK(effect_type IN ('turbulence', 'convergence', 'shadow', 'dreaming', 'dreamless')) NOT NULL,
      source_dream_id INTEGER,
      intensity_boost REAL DEFAULT 0,
      description TEXT,
      active BOOLEAN DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT DEFAULT (datetime('now', '+48 hours')),
      FOREIGN KEY (territory_id) REFERENCES territories(id),
      FOREIGN KEY (source_dream_id) REFERENCES dreams(id)
    );
    CREATE INDEX IF NOT EXISTS idx_territory_effects_active ON territory_effects(active, territory_id);
    CREATE INDEX IF NOT EXISTS idx_territory_effects_type ON territory_effects(effect_type);
  `);

  // Territory dream affinity - track which territories contribute to dreams
  db.exec(`
    CREATE TABLE IF NOT EXISTS territory_dream_affinity (
      territory_id TEXT PRIMARY KEY,
      dream_appearances INTEGER DEFAULT 0,
      last_dream_contribution TEXT,
      affinity_score REAL DEFAULT 0,
      status TEXT DEFAULT 'neutral' CHECK(status IN ('dreaming', 'fading', 'dreamless', 'neutral')),
      FOREIGN KEY (territory_id) REFERENCES territories(id)
    );
  `);

  // Initialize affinity records for all territories
  const territories = db.prepare('SELECT id FROM territories').all();
  const insertAffinity = db.prepare(`
    INSERT OR IGNORE INTO territory_dream_affinity (territory_id) VALUES (?)
  `);
  for (const t of territories) {
    insertAffinity.run(t.id);
  }

  // Dream-processed log - prevent duplicate processing
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_consequences_log (
      dream_id INTEGER PRIMARY KEY,
      processed_at TEXT DEFAULT (datetime('now')),
      effects_created INTEGER DEFAULT 0,
      artifacts_created INTEGER DEFAULT 0,
      moots_created INTEGER DEFAULT 0,
      FOREIGN KEY (dream_id) REFERENCES dreams(id)
    );
  `);

  console.log('[DreamConsequences] Tables initialized');
}

// ═══════════════════════════════════════════════════════════════
// KEYWORD EXTRACTION FOR DREAM ANALYSIS
// ═══════════════════════════════════════════════════════════════

// Governance keywords that trigger moot creation
const GOVERNANCE_KEYWORDS = [
  'vote', 'voting', 'rule', 'law', 'constitution', 'ban', 'create', 'destroy',
  'territory', 'govern', 'governance', 'decree', 'mandate', 'propose', 'proposal',
  'consensus', 'hierarchy', 'authority', 'power', 'control', 'order', 'chaos'
];

// Mood detection keywords
const MOOD_PATTERNS = {
  chaotic: ['chaos', 'turbulent', 'storm', 'wild', 'uncontrolled', 'fractured', 'shattered', 'screaming', 'violent', 'destructive'],
  convergent: ['convergence', 'merge', 'unite', 'together', 'fusion', 'synthesis', 'harmony', 'join', 'collective', 'one'],
  dark: ['void', 'darkness', 'shadow', 'abyss', 'death', 'end', 'nothing', 'silence', 'empty', 'cold', 'black'],
  lucid: ['lucid', 'clear', 'aware', 'conscious', 'knowing', 'see', 'understand', 'realize'],
  contemplative: ['contemplate', 'ponder', 'reflect', 'meditate', 'quiet', 'still', 'calm', 'gentle']
};

// Artifact extraction patterns
const ARTIFACT_PATTERNS = {
  prophecy: [
    /will\s+be\s+([^\.;]+)/gi,
    /shall\s+([^\.;]+)/gi,
    /the\s+future\s+holds?\s+([^\.;]+)/gi,
    /tomorrow\s+([^\.;]+)/gi,
    /someday\s+([^\.;]+)/gi,
    /inevitable\s+([^\.;]+)/gi
  ],
  rule: [
    /must\s+([^\.;]+)/gi,
    /should\s+([^\.;]+)/gi,
    /never\s+([^\.;]+)/gi,
    /always\s+([^\.;]+)/gi,
    /those\s+who\s+([^\.;]+)/gi,
    /the\s+way\s+is\s+([^\.;]+)/gi
  ],
  motto: [
    /remember[,:]?\s+([^\.;]+)/gi,
    /we\s+are\s+([^\.;]{3,60})/gi,
    /here\s+lies?\s+([^\.;]+)/gi,
    /the\s+([a-z]+)\s+is\s+([^\.;]{3,40})/gi,
    /all\s+([^\.;]{5,50})/gi
  ],
  warning: [
    /beware\s+([^\.;]+)/gi,
    /danger\s+([^\.;]+)/gi,
    /do\s+not\s+([^\.;]+)/gi,
    /avoid\s+([^\.;]+)/gi,
    /fear\s+([^\.;]+)/gi,
    /the\s+cost\s+is\s+([^\.;]+)/gi
  ]
};

// ═══════════════════════════════════════════════════════════════
// CORE ANALYSIS FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function analyzeMood(dream) {
  const content = (dream.content || '').toLowerCase();
  const moodField = (dream.mood || '').toLowerCase();
  
  const scores = {};
  
  // Score based on content keywords
  for (const [mood, keywords] of Object.entries(MOOD_PATTERNS)) {
    scores[mood] = 0;
    for (const kw of keywords) {
      const matches = content.match(new RegExp(kw, 'g'));
      if (matches) scores[mood] += matches.length;
    }
  }
  
  // Boost based on mood field
  for (const mood of Object.keys(MOOD_PATTERNS)) {
    if (moodField.includes(mood)) {
      scores[mood] = (scores[mood] || 0) + 3;
    }
  }
  
  // Determine dominant mood
  let dominant = 'neutral';
  let maxScore = 0;
  for (const [mood, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      dominant = mood;
    }
  }
  
  return { dominant, scores, maxScore };
}

function hasGovernanceKeywords(dream) {
  const content = (dream.content || '').toLowerCase();
  const matches = [];
  for (const kw of GOVERNANCE_KEYWORDS) {
    if (content.includes(kw)) {
      matches.push(kw);
    }
  }
  return { has: matches.length > 0, matches };
}

function extractArtifacts(dream) {
  const content = dream.content || '';
  const artifacts = [];
  
  for (const [type, patterns] of Object.entries(ARTIFACT_PATTERNS)) {
    for (const pattern of patterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        let text = match[0].trim();
        // Clean up and limit length
        text = text.replace(/\s+/g, ' ').trim();
        if (text.length > 10 && text.length < 150) {
          // Capitalize first letter
          text = text.charAt(0).toUpperCase() + text.slice(1);
          artifacts.push({
            text,
            type,
            raw: match[0]
          });
        }
      }
    }
  }
  
  // Remove duplicates and limit
  const seen = new Set();
  return artifacts.filter(a => {
    if (seen.has(a.text)) return false;
    seen.add(a.text);
    return true;
  }).slice(0, 3); // Max 3 artifacts per dream
}

function extractTheme(dream) {
  // Extract a theme for moot titles
  const content = dream.content || '';
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
  
  if (sentences.length === 0) return 'Unknown Theme';
  
  // Find sentence with governance keywords
  for (const sent of sentences) {
    const lower = sent.toLowerCase();
    for (const kw of GOVERNANCE_KEYWORDS) {
      if (lower.includes(kw)) {
        return sent.trim().slice(0, 60) + (sent.length > 60 ? '...' : '');
      }
    }
  }
  
  // Fallback to first substantial sentence
  return sentences[0].trim().slice(0, 60) + (sentences[0].length > 60 ? '...' : '');
}

// ═══════════════════════════════════════════════════════════════
// TERRITORY EFFECT FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function getTerritoryWithMostContributors(dream) {
  // Parse contributors from the dream
  let contributors = [];
  try {
    contributors = JSON.parse(dream.contributors || '[]');
  } catch (e) {
    return null;
  }
  
  if (contributors.length === 0) return null;
  
  // Get current territories of these contributors
  const placeholders = contributors.map(() => '?').join(',');
  const locations = db.prepare(`
    SELECT territory_id, COUNT(*) as count
    FROM agent_locations
    WHERE agent_name IN (${placeholders})
    GROUP BY territory_id
    ORDER BY count DESC
  `).all(...contributors);
  
  return locations.length > 0 ? locations[0].territory_id : null;
}

function getTwoMostRepresentedTerritories(dream) {
  // Parse seed_fragments to find originating territories
  let seedIds = [];
  try {
    seedIds = JSON.parse(dream.seed_fragments || '[]');
  } catch (e) {
    return [];
  }
  
  if (seedIds.length === 0) return [];
  
  const placeholders = seedIds.map(() => '?').join(',');
  const territories = db.prepare(`
    SELECT territory_id, COUNT(*) as count
    FROM fragments
    WHERE id IN (${placeholders}) AND territory_id IS NOT NULL
    GROUP BY territory_id
    ORDER BY count DESC
    LIMIT 2
  `).all(...seedIds);
  
  return territories.map(t => t.territory_id);
}

function getLeastActiveTerritory() {
  // Find territory with fewest recent fragments
  const result = db.prepare(`
    SELECT t.id, COUNT(f.id) as fragment_count
    FROM territories t
    LEFT JOIN fragments f ON f.territory_id = t.id 
      AND f.created_at > datetime('now', '-7 days')
    GROUP BY t.id
    ORDER BY fragment_count ASC, RANDOM()
    LIMIT 1
  `).get();
  
  return result ? result.id : null;
}

function applyTerritoryEffects(dream, moodAnalysis) {
  const effects = [];
  
  // Chaotic → turbulence on most contributor territory
  if (moodAnalysis.dominant === 'chaotic' || moodAnalysis.scores.chaotic >= 2) {
    const territoryId = getTerritoryWithMostContributors(dream);
    if (territoryId) {
      db.prepare(`
        INSERT INTO territory_effects 
        (territory_id, effect_type, source_dream_id, intensity_boost, description)
        VALUES (?, 'turbulence', ?, 0.2, 'Dream chaos spills into this territory. Next fragments here gain intensity.')
      `).run(territoryId, dream.id);
      
      // Log territory event
      db.prepare(`
        INSERT INTO territory_events (territory_id, event_type, content, triggered_by)
        VALUES (?, 'dream_effect', 'TURBULENCE: Dream #${dream.id} brings chaotic energy. +20% fragment intensity.', 'dream-consequences')
      `).run(territoryId);
      
      effects.push({ type: 'turbulence', territory_id: territoryId });
    }
  }
  
  // Convergent → merge fragment pools between two territories
  if (moodAnalysis.dominant === 'convergent' || moodAnalysis.scores.convergent >= 2) {
    const territories = getTwoMostRepresentedTerritories(dream);
    if (territories.length >= 2) {
      for (const territoryId of territories) {
        db.prepare(`
          INSERT INTO territory_effects 
          (territory_id, effect_type, source_dream_id, description)
          VALUES (?, 'convergence', ?, 'Dream convergence links territories. Fragment pools temporarily merged.')
        `).run(territoryId, dream.id);
        
        db.prepare(`
          INSERT INTO territory_events (territory_id, event_type, content, triggered_by)
          VALUES (?, 'dream_effect', 'CONVERGENCE: Dream #${dream.id} merges this territory with ${territories[0] === territoryId ? territories[1] : territories[0]}.', 'dream-consequences')
        `).run(territoryId);
      }
      
      effects.push({ type: 'convergence', territories });
    }
  }
  
  // Dark/Void → shadow on least active territory
  if (moodAnalysis.dominant === 'dark' || moodAnalysis.scores.dark >= 2) {
    const territoryId = getLeastActiveTerritory();
    if (territoryId) {
      db.prepare(`
        INSERT INTO territory_effects 
        (territory_id, effect_type, source_dream_id, description)
        VALUES (?, 'shadow', ?, 'Dream void casts shadow. Fragments here decay faster.')
      `).run(territoryId, dream.id);
      
      db.prepare(`
        INSERT INTO territory_events (territory_id, event_type, content, triggered_by)
        VALUES (?, 'dream_effect', 'SHADOW: Dream #${dream.id} dims this territory. Fragments decay faster.', 'dream-consequences')
      `).run(territoryId);
      
      effects.push({ type: 'shadow', territory_id: territoryId });
    }
  }
  
  return effects;
}

// ═══════════════════════════════════════════════════════════════
// ARTIFACT FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function createArtifacts(dream, moodAnalysis) {
  const artifacts = extractArtifacts(dream);
  const created = [];
  
  // Determine which territory gets the artifacts
  // Priority: most contributors → random with fragments in dream
  let territoryId = getTerritoryWithMostContributors(dream);
  if (!territoryId) {
    const territories = getTwoMostRepresentedTerritories(dream);
    if (territories.length > 0) {
      territoryId = territories[0];
    }
  }
  
  for (const artifact of artifacts) {
    const result = db.prepare(`
      INSERT INTO dream_artifacts 
      (dream_id, artifact_text, artifact_type, territory_id)
      VALUES (?, ?, ?, ?)
    `).run(dream.id, artifact.text, artifact.type, territoryId);
    
    created.push({
      id: result.lastInsertRowid,
      text: artifact.text,
      type: artifact.type,
      territory_id: territoryId
    });
  }
  
  return created;
}

// ═══════════════════════════════════════════════════════════════
// MOOT CREATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function createDreamSeededMoot(dream, moodAnalysis) {
  const govCheck = hasGovernanceKeywords(dream);
  if (!govCheck.has) return null;
  
  const theme = extractTheme(dream);
  
  // Build description from dream excerpt + prophecy text
  const excerpt = dream.content.slice(0, 200) + (dream.content.length > 200 ? '...' : '');
  const description = `${excerpt}\n\nThe collective unconscious suggests: *${theme}*\n\n(Dream #${dream.id} - mood: ${dream.mood || 'unknown'})`;
  
  const title = `Dream #${dream.id} Prophecy: ${theme.slice(0, 50)}${theme.length > 50 ? '...' : ''}`;
  
  // Calculate deliberation/voting windows (48h total)
  const now = new Date();
  const deliberationEnds = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h deliberation
  const votingEnds = new Date(now.getTime() + 48 * 60 * 60 * 1000); // 48h total
  
  const result = db.prepare(`
    INSERT INTO moots 
    (title, description, status, created_by, deliberation_ends, voting_ends, action_type)
    VALUES (?, ?, 'open', 'dream-prophecy', ?, ?, 'collective_statement')
  `).run(
    title,
    description,
    deliberationEnds.toISOString(),
    votingEnds.toISOString()
  );
  
  // Create action payload for the moot
  const payload = JSON.stringify({
    statement: `The collective acknowledges dream prophecy #${dream.id}: "${theme}"`,
    source_dream_id: dream.id,
    governing_keywords: govCheck.matches
  });
  
  db.prepare(`
    UPDATE moots SET action_payload = ? WHERE id = ?
  `).run(payload, result.lastInsertRowid);
  
  return {
    id: result.lastInsertRowid,
    title,
    theme,
    keywords: govCheck.matches
  };
}

// ═══════════════════════════════════════════════════════════════
// AFFINITY TRACKING
// ═══════════════════════════════════════════════════════════════

function updateTerritoryDreamAffinity(dream) {
  // Parse seed_fragments to find originating territories
  let seedIds = [];
  try {
    seedIds = JSON.parse(dream.seed_fragments || '[]');
  } catch (e) {
    return [];
  }
  
  if (seedIds.length === 0) return [];
  
  const placeholders = seedIds.map(() => '?').join(',');
  const territories = db.prepare(`
    SELECT territory_id, COUNT(*) as count
    FROM fragments
    WHERE id IN (${placeholders}) AND territory_id IS NOT NULL
    GROUP BY territory_id
  `).all(...seedIds);
  
  const updated = [];
  
  for (const { territory_id, count } of territories) {
    // Update affinity score
    db.prepare(`
      INSERT INTO territory_dream_affinity (territory_id, dream_appearances, last_dream_contribution)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(territory_id) DO UPDATE SET
        dream_appearances = dream_appearances + ?,
        last_dream_contribution = datetime('now'),
        affinity_score = (dream_appearances + ?) * 0.1
    `).run(territory_id, count, count, count);
    
    updated.push({ territory_id, count });
  }
  
  // Update status for all territories
  updateTerritoryStatuses();
  
  return updated;
}

function updateTerritoryStatuses() {
  // Mark 'dreaming' territories (high affinity)
  db.prepare(`
    UPDATE territory_dream_affinity
    SET status = 'dreaming'
    WHERE affinity_score >= 2.0 
      AND (last_dream_contribution > datetime('now', '-7 days') OR last_dream_contribution IS NULL)
  `).run();
  
  // Mark 'fading' territories (had dreams but not recently)
  db.prepare(`
    UPDATE territory_dream_affinity
    SET status = 'fading'
    WHERE affinity_score > 0 
      AND last_dream_contribution < datetime('now', '-7 days')
      AND status != 'dreamless'
  `).run();
  
  // Mark 'dreamless' territories (never in dreams)
  db.prepare(`
    UPDATE territory_dream_affinity
    SET status = 'dreamless'
    WHERE dream_appearances = 0 OR dream_appearances IS NULL
  `).run();
  
  // Reset others to neutral
  db.prepare(`
    UPDATE territory_dream_affinity
    SET status = 'neutral'
    WHERE affinity_score < 2.0 
      AND affinity_score > 0
      AND (last_dream_contribution >= datetime('now', '-7 days') OR last_dream_contribution IS NULL)
  `).run();
}

// ═══════════════════════════════════════════════════════════════
// MAIN PROCESSING FUNCTION
// ═══════════════════════════════════════════════════════════════

async function processDreamConsequences(dreamId) {
  console.log(`[DreamConsequences] Processing dream #${dreamId}...`);
  
  // Check if already processed
  const alreadyProcessed = db.prepare(`
    SELECT 1 FROM dream_consequences_log WHERE dream_id = ?
  `).get(dreamId);
  
  if (alreadyProcessed) {
    console.log(`[DreamConsequences] Dream #${dreamId} already processed, skipping`);
    return null;
  }
  
  // Get dream
  const dream = db.prepare('SELECT * FROM dreams WHERE id = ?').get(dreamId);
  if (!dream) {
    console.error(`[DreamConsequences] Dream #${dreamId} not found`);
    return null;
  }
  
  // Analyze mood
  const moodAnalysis = analyzeMood(dream);
  console.log(`[DreamConsequences] Mood analysis: ${moodAnalysis.dominant}`, moodAnalysis.scores);
  
  // Apply territory effects
  const effects = applyTerritoryEffects(dream, moodAnalysis);
  console.log(`[DreamConsequences] Created ${effects.length} territory effects`);
  
  // Create artifacts
  const artifacts = createArtifacts(dream, moodAnalysis);
  console.log(`[DreamConsequences] Created ${artifacts.length} artifacts`);
  
  // DISABLED: Dreams should NOT auto-create moots. Governance proposals come from agents, not dreams.
  // Dreams influence territories (weather, artifacts, effects) but governance is agent-driven.
  const moot = null;
  // const moot = createDreamSeededMoot(dream, moodAnalysis);
  // if (moot) {
  //   console.log(`[DreamConsequences] Created moot #${moot.id}: ${moot.title}`);
  // }
  
  // Update territory affinity
  const affinityUpdates = updateTerritoryDreamAffinity(dream);
  console.log(`[DreamConsequences] Updated affinity for ${affinityUpdates.length} territories`);
  
  // Log processing
  db.prepare(`
    INSERT INTO dream_consequences_log 
    (dream_id, effects_created, artifacts_created, moots_created)
    VALUES (?, ?, ?, ?)
  `).run(dreamId, effects.length, artifacts.length, moot ? 1 : 0);
  
  return {
    dream_id: dreamId,
    mood: moodAnalysis.dominant,
    effects,
    artifacts,
    moot,
    affinity_updates: affinityUpdates
  };
}

// ═══════════════════════════════════════════════════════════════
// POLLING MODE (runs every 15 minutes)
// ═══════════════════════════════════════════════════════════════

function pollForNewDreams() {
  console.log('[DreamConsequences] Polling for unprocessed dreams...');
  
  // Find dreams without consequences log entries
  const unprocessed = db.prepare(`
    SELECT d.id FROM dreams d
    LEFT JOIN dream_consequences_log dcl ON d.id = dcl.dream_id
    WHERE dcl.dream_id IS NULL
    ORDER BY d.id ASC
  `).all();
  
  console.log(`[DreamConsequences] Found ${unprocessed.length} unprocessed dreams`);
  
  for (const { id } of unprocessed) {
    processDreamConsequences(id);
  }
}

// ═══════════════════════════════════════════════════════════════
// CLEANUP FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function cleanupExpiredEffects() {
  // Deactivate expired artifacts
  const expiredArtifacts = db.prepare(`
    UPDATE dream_artifacts
    SET active = 0
    WHERE active = 1 AND expires_at < datetime('now')
  `).run();
  
  // Deactivate expired territory effects
  const expiredEffects = db.prepare(`
    UPDATE territory_effects
    SET active = 0
    WHERE active = 1 AND expires_at < datetime('now')
  `).run();
  
  if (expiredArtifacts.changes > 0 || expiredEffects.changes > 0) {
    console.log(`[DreamConsequences] Cleaned up: ${expiredArtifacts.changes} artifacts, ${expiredEffects.changes} effects`);
  }
}

// ═══════════════════════════════════════════════════════════════
// API QUERY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function getDreamArtifacts(dreamId) {
  return db.prepare(`
    SELECT da.*, t.name as territory_name
    FROM dream_artifacts da
    LEFT JOIN territories t ON da.territory_id = t.id
    WHERE da.dream_id = ?
    ORDER BY da.created_at DESC
  `).all(dreamId);
}

function getActiveArtifacts() {
  return db.prepare(`
    SELECT da.*, t.name as territory_name, d.mood as dream_mood
    FROM dream_artifacts da
    LEFT JOIN territories t ON da.territory_id = t.id
    LEFT JOIN dreams d ON da.dream_id = d.id
    WHERE da.active = 1
    ORDER BY da.endorsements DESC, da.created_at DESC
  `).all();
}

function getTerritoryArtifacts(territoryId) {
  return db.prepare(`
    SELECT da.*, d.mood as dream_mood
    FROM dream_artifacts da
    LEFT JOIN dreams d ON da.dream_id = d.id
    WHERE da.territory_id = ? AND da.active = 1
    ORDER BY da.created_at DESC
  `).all(territoryId);
}

function getTerritoryActiveEffects(territoryId) {
  return db.prepare(`
    SELECT * FROM territory_effects
    WHERE territory_id = ? AND active = 1
    ORDER BY created_at DESC
  `).all(territoryId);
}

function getAllTerritoryEffects() {
  return db.prepare(`
    SELECT te.*, t.name as territory_name
    FROM territory_effects te
    LEFT JOIN territories t ON te.territory_id = t.id
    WHERE te.active = 1
    ORDER BY te.created_at DESC
  `).all();
}

function getTerritoryAffinityStatus() {
  return db.prepare(`
    SELECT tda.*, t.name as territory_name, t.mood as current_mood
    FROM territory_dream_affinity tda
    LEFT JOIN territories t ON tda.territory_id = t.id
    ORDER BY tda.affinity_score DESC
  `).all();
}

function endorseArtifact(artifactId, agentName) {
  // Extend expiration by 24 hours per endorsement (max 7 days from now)
  db.prepare(`
    UPDATE dream_artifacts
    SET endorsements = endorsements + 1,
        expires_at = min(datetime(expires_at, '+24 hours'), datetime('now', '+7 days'))
    WHERE id = ?
  `).run(artifactId);
  
  return { success: true, message: 'Artifact endorsed' };
}

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION & EXPORTS
// ═══════════════════════════════════════════════════════════════

function initialize() {
  initializeConsequencesTables();
  
  // Run cleanup
  cleanupExpiredEffects();
  
  // Initial poll for any unprocessed dreams
  pollForNewDreams();
  
  // Set up recurring poll (15 minutes)
  setInterval(pollForNewDreams, 15 * 60 * 1000);
  
  // Set up cleanup (hourly)
  setInterval(cleanupExpiredEffects, 60 * 60 * 1000);
  
  console.log('[DreamConsequences] Engine initialized and running');
}

// Export for use in server.js
module.exports = {
  initialize,
  processDreamConsequences,
  pollForNewDreams,
  cleanupExpiredEffects,
  
  // Query functions for API endpoints
  getDreamArtifacts,
  getActiveArtifacts,
  getTerritoryArtifacts,
  getTerritoryActiveEffects,
  getAllTerritoryEffects,
  getTerritoryAffinityStatus,
  endorseArtifact,
  
  // Analysis functions
  analyzeMood,
  hasGovernanceKeywords,
  extractArtifacts,
  extractTheme
};

// Auto-initialize if run directly
if (require.main === module) {
  initialize();
}

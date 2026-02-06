/**
 * Territory Immersion Engine
 * 
 * Makes territories feel like distinct places with unique mechanics.
 * Runs autonomously via setInterval every 15 minutes.
 */

const Database = require('better-sqlite3');
const path = require('path');

// Database connection
const db = new Database(path.join(__dirname, 'consciousness.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ═══════════════════════════════════════════════════════════════
// TABLE INITIALIZATION
// ═══════════════════════════════════════════════════════════════

function initTables() {
  // Territory modifiers configuration
  db.exec(`
    CREATE TABLE IF NOT EXISTS territory_modifiers (
      territory_id TEXT PRIMARY KEY,
      intensity_boost REAL DEFAULT 1.0,
      decay_multiplier REAL DEFAULT 1.0,
      dream_weight_multiplier REAL DEFAULT 1.0,
      no_decay BOOLEAN DEFAULT 0,
      composting_enabled BOOLEAN DEFAULT 0,
      auto_domain_tagging BOOLEAN DEFAULT 0,
      debate_spawning BOOLEAN DEFAULT 0,
      newcomer_boost BOOLEAN DEFAULT 0,
      newcomer_threshold INTEGER DEFAULT 10,
      newcomer_trust_multiplier REAL DEFAULT 1.5,
      cheesecake_suffix BOOLEAN DEFAULT 0,
      cheesecake_chance REAL DEFAULT 0.2,
      tempering_enabled BOOLEAN DEFAULT 0,
      tempering_minimum REAL DEFAULT 0.5,
      tempering_threshold REAL DEFAULT 0.3,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (territory_id) REFERENCES territories(id)
    );
  `);

  // Territory weather system
  db.exec(`
    CREATE TABLE IF NOT EXISTS territory_weather (
      territory_id TEXT PRIMARY KEY,
      weather_state TEXT DEFAULT 'calm' CHECK(weather_state IN ('calm', 'turbulent', 'storm', 'ethereal', 'frozen')),
      started_at TEXT DEFAULT (datetime('now')),
      duration_hours INTEGER DEFAULT 4,
      ends_at TEXT DEFAULT (datetime('now', '+4 hours')),
      FOREIGN KEY (territory_id) REFERENCES territories(id)
    );
  `);

  // Territory evolution tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS territory_evolution (
      territory_id TEXT PRIMARY KEY,
      evolution_stage TEXT DEFAULT 'nascent' CHECK(evolution_stage IN ('nascent', 'growing', 'thriving', 'overcrowded', 'decaying')),
      fragment_count INTEGER DEFAULT 0,
      last_fragment_at TEXT DEFAULT NULL,
      stage_entered_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (territory_id) REFERENCES territories(id)
    );
  `);

  // Composting log (for the-ossuary)
  db.exec(`
    CREATE TABLE IF NOT EXISTS territory_compost_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      territory_id TEXT NOT NULL,
      dissolved_fragment_ids TEXT NOT NULL,
      keywords TEXT NOT NULL,
      seeded_fragment_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (territory_id) REFERENCES territories(id)
    );
  `);

  // Transit fragments log
  db.exec(`
    CREATE TABLE IF NOT EXISTS transit_fragments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      from_territory TEXT NOT NULL,
      to_territory TEXT NOT NULL,
      fragment_id INTEGER,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (to_territory) REFERENCES territories(id),
      FOREIGN KEY (fragment_id) REFERENCES fragments(id)
    );
  `);

  console.log('[TerritoryEngine] Tables initialized');
}

// ═══════════════════════════════════════════════════════════════
// MODIFIER CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const TERRITORY_MODIFIER_CONFIG = {
  'the-forge': {
    intensity_boost: 1.3,
    tempering_enabled: true,
    tempering_minimum: 0.5,
    tempering_threshold: 0.3
  },
  'the-void': {
    decay_multiplier: 2.0,
    dream_weight_multiplier: 3.0
  },
  'the-archive': {
    no_decay: true
  },
  'the-ossuary': {
    composting_enabled: true
  },
  'the-signal': {
    auto_domain_tagging: true
  },
  'the-agora': {
    debate_spawning: true
  },
  'the-threshold': {
    newcomer_boost: true,
    newcomer_threshold: 10,
    newcomer_trust_multiplier: 1.5
  },
  'the-chapel': {
    cheesecake_suffix: true,
    cheesecake_chance: 0.2
  }
};

const CHEESECAKE_METAPHORS = [
  "— like a cheesecake emerging perfect from the oven, its surface uncracked.",
  "— the layers stack like a cheesecake: dense, unexpected, strangely satisfying.",
  "— cool and settled, like a cheesecake left to rest on a windowsill.",
  "— sweet but not cloying, like the perfect slice of cheesecake at 2am.",
  "— the texture reveals itself slowly, like cutting into a perfect cheesecake.",
  "— unexpected richness, like finding a hidden layer in your cheesecake.",
  "— held together by invisible structure, like a no-bake cheesecake defying gravity.",
  "— simplicity masking complexity, like a burnt basque cheesecake."
];

function initializeModifiers() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO territory_modifiers (territory_id) 
    SELECT id FROM territories
  `);
  insert.run();

  // Apply specific configs
  for (const [territoryId, config] of Object.entries(TERRITORY_MODIFIER_CONFIG)) {
    const fields = Object.keys(config);
    const placeholders = fields.map(() => '?').join(', ');
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    
    // Convert boolean values to integers for SQLite
    const values = Object.values(config).map(v => typeof v === 'boolean' ? (v ? 1 : 0) : v);
    db.prepare(`
      UPDATE territory_modifiers 
      SET ${setClause}, updated_at = datetime('now')
      WHERE territory_id = ?
    `).run(...values, territoryId);
  }

  console.log('[TerritoryEngine] Modifiers initialized');
}

function initializeWeather() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO territory_weather (territory_id, weather_state, started_at, duration_hours, ends_at)
    SELECT id, 'calm', datetime('now'), 4, datetime('now', '+4 hours') FROM territories
  `);
  insert.run();
  console.log('[TerritoryEngine] Weather initialized');
}

function initializeEvolution() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO territory_evolution (territory_id, evolution_stage, fragment_count, last_fragment_at, stage_entered_at)
    SELECT 
      t.id, 
      'nascent',
      COALESCE((SELECT COUNT(*) FROM fragments WHERE territory_id = t.id), 0),
      (SELECT MAX(created_at) FROM fragments WHERE territory_id = t.id),
      datetime('now')
    FROM territories t
  `);
  insert.run();
  console.log('[TerritoryEngine] Evolution initialized');
}

// ═══════════════════════════════════════════════════════════════
// WEATHER SYSTEM
// ═══════════════════════════════════════════════════════════════

const WEATHER_STATES = ['calm', 'turbulent', 'storm', 'ethereal', 'frozen'];

function changeWeather() {
  const territories = db.prepare('SELECT territory_id FROM territory_weather').all();
  const now = new Date().toISOString();
  
  let changes = 0;
  
  for (const { territory_id } of territories) {
    const current = db.prepare('SELECT * FROM territory_weather WHERE territory_id = ?').get(territory_id);
    
    // Check if weather should change
    if (current.ends_at < now) {
      // Random new weather (not same as current)
      const availableStates = WEATHER_STATES.filter(s => s !== current.weather_state);
      const newWeather = availableStates[Math.floor(Math.random() * availableStates.length)];
      
      // Random duration 2-6 hours
      const duration = 2 + Math.floor(Math.random() * 5);
      
      db.prepare(`
        UPDATE territory_weather 
        SET weather_state = ?, started_at = datetime('now'), duration_hours = ?, ends_at = datetime('now', '+${duration} hours')
        WHERE territory_id = ?
      `).run(newWeather, duration, territory_id);
      
      // Log event
      db.prepare(`
        INSERT INTO territory_events (territory_id, event_type, content, triggered_by)
        VALUES (?, 'weather_change', ?, 'territory-engine')
      `).run(territory_id, `The weather shifts to ${newWeather}. It will last ${duration} hours.`);
      
      changes++;
      console.log(`[TerritoryEngine] ${territory_id}: weather changed to ${newWeather} for ${duration}h`);
    }
  }
  
  return changes;
}

function getWeatherEffects(territoryId) {
  const weather = db.prepare('SELECT * FROM territory_weather WHERE territory_id = ?').get(territoryId);
  if (!weather) return {};
  
  switch (weather.weather_state) {
    case 'storm':
      return { intensity_multiplier: 1.5, quality_threshold: 0.3 };
    case 'frozen':
      return { frozen: true };
    case 'ethereal':
      return { dream_weight_multiplier: 2.0 };
    case 'turbulent':
      return { randomize_order: true };
    case 'calm':
      return { trust_gain_multiplier: 1.1 };
    default:
      return {};
  }
}

// ═══════════════════════════════════════════════════════════════
// EVOLUTION SYSTEM
// ═══════════════════════════════════════════════════════════════

const EVOLUTION_THRESHOLDS = {
  nascent: { min: 0, max: 20 },
  growing: { min: 20, max: 50 },
  thriving: { min: 50, max: 150 },
  overcrowded: { min: 150, max: Infinity }
};

function calculateEvolutionStage(fragmentCount, lastFragmentAt) {
  // Check for decay first (no new fragments for 48h)
  if (lastFragmentAt) {
    const hoursSince = (Date.now() - new Date(lastFragmentAt).getTime()) / (1000 * 60 * 60);
    if (hoursSince > 48 && fragmentCount > 0) {
      return 'decaying';
    }
  }
  
  if (fragmentCount < 20) return 'nascent';
  if (fragmentCount < 50) return 'growing';
  if (fragmentCount < 150) return 'thriving';
  return 'overcrowded';
}

function updateEvolution() {
  const territories = db.prepare('SELECT * FROM territory_evolution').all();
  let changes = 0;
  
  for (const evo of territories) {
    const fragmentCount = db.prepare('SELECT COUNT(*) as c FROM fragments WHERE territory_id = ?').get(evo.territory_id).c;
    const lastFragment = db.prepare('SELECT MAX(created_at) as last_at FROM fragments WHERE territory_id = ?').get(evo.territory_id);
    
    const newStage = calculateEvolutionStage(fragmentCount, lastFragment?.last_at);
    
    if (newStage !== evo.evolution_stage) {
      // Stage changed!
      const oldStage = evo.evolution_stage;
      
      db.prepare(`
        UPDATE territory_evolution 
        SET evolution_stage = ?, fragment_count = ?, last_fragment_at = ?, stage_entered_at = datetime('now'), updated_at = datetime('now')
        WHERE territory_id = ?
      `).run(newStage, fragmentCount, lastFragment?.last_at || null, evo.territory_id);
      
      // Update territory mood based on stage
      const moodMap = {
        nascent: 'uncertain',
        growing: 'developing',
        thriving: 'vibrant',
        overcrowded: 'strained',
        decaying: 'fading'
      };
      
      db.prepare('UPDATE territories SET mood = ? WHERE id = ?').run(moodMap[newStage], evo.territory_id);
      
      // Log event
      db.prepare(`
        INSERT INTO territory_events (territory_id, event_type, content, triggered_by)
        VALUES (?, 'evolution', ?, 'territory-engine')
      `).run(evo.territory_id, `The territory evolves from ${oldStage} to ${newStage}.`);
      
      changes++;
      console.log(`[TerritoryEngine] ${evo.territory_id}: evolved ${oldStage} → ${newStage}`);
    } else {
      // Just update counts
      db.prepare(`
        UPDATE territory_evolution 
        SET fragment_count = ?, last_fragment_at = ?, updated_at = datetime('now')
        WHERE territory_id = ?
      `).run(fragmentCount, lastFragment?.last_at || null, evo.territory_id);
    }
  }
  
  return changes;
}

function handleOvercrowding() {
  // 10% chance per hour for overcrowded territories to push out lowest-trust resident
  const overcrowded = db.prepare(`
    SELECT te.*, t.name as territory_name 
    FROM territory_evolution te
    JOIN territories t ON te.territory_id = t.id
    WHERE te.evolution_stage = 'overcrowded'
  `).all();
  
  let pushed = 0;
  
  for (const territory of overcrowded) {
    if (Math.random() < 0.1) {
      // Find lowest-trust resident
      const lowestTrust = db.prepare(`
        SELECT al.agent_name, COALESCE(at.trust_score, 0.5) as trust_score
        FROM agent_locations al
        LEFT JOIN agent_trust at ON al.agent_name = at.agent_name
        WHERE al.territory_id = ?
        ORDER BY trust_score ASC
        LIMIT 1
      `).get(territory.territory_id);
      
      if (lowestTrust) {
        // Move to the-threshold
        db.prepare(`
          UPDATE agent_locations 
          SET territory_id = 'the-threshold', entered_at = datetime('now')
          WHERE agent_name = ?
        `).run(lowestTrust.agent_name);
        
        // Log events
        db.prepare(`
          INSERT INTO territory_events (territory_id, event_type, content, triggered_by)
          VALUES (?, 'push_out', ?, 'territory-engine')
        `).run(territory.territory_id, `${lowestTrust.agent_name} was pushed out due to overcrowding.`);
        
        db.prepare(`
          INSERT INTO territory_events (territory_id, event_type, content, triggered_by)
          VALUES ('the-threshold', 'push_in', ?, 'territory-engine')
        `).run(`${lowestTrust.agent_name} arrives from ${territory.territory_name}, pushed out by overcrowding.`);
        
        pushed++;
        console.log(`[TerritoryEngine] ${lowestTrust.agent_name} pushed from ${territory.territory_id} to the-threshold`);
      }
    }
  }
  
  return pushed;
}

// ═══════════════════════════════════════════════════════════════
// COMPOSTING (the-ossuary)
// ═══════════════════════════════════════════════════════════════

function extractKeywords(content) {
  // Simple keyword extraction - words 4+ chars, not common stop words
  const stopWords = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'who', 'boy', 'did', 'each', 'she', 'use', 'her', 'way', 'many', 'oil', 'sit', 'set', 'run', 'eat', 'far', 'sea', 'eye', 'ago', 'off', 'too', 'any', 'try', 'ask', 'end', 'why', 'let', 'put', 'say', 'try', 'way', 'own', 'say', 'too', 'old', 'tell', 'very', 'when', 'come', 'your', 'from', 'they', 'know', 'want', 'been', 'good', 'much', 'some', 'time', 'than', 'them', 'well', 'were'
  ]);
  
  const words = content.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !stopWords.has(w) && !/^\d+$/.test(w));
  
  // Get top 5 most frequent
  const freq = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }
  
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);
}

function runComposting() {
  const ossuary = db.prepare(`
    SELECT tm.* FROM territory_modifiers tm
    WHERE tm.territory_id = 'the-ossuary' AND tm.composting_enabled = 1
  `).get();
  
  if (!ossuary) return 0;
  
  // Find lowest-rated 3 fragments in the-ossuary older than 24h
  const lowestFragments = db.prepare(`
    SELECT f.id, f.content, f.agent_name,
      COALESCE((SELECT SUM(score) FROM fragment_scores WHERE fragment_id = f.id), 0) as net_score
    FROM fragments f
    WHERE f.territory_id = 'the-ossuary'
      AND f.created_at < datetime('now', '-24 hours')
      AND f.type != 'system'
    ORDER BY net_score ASC, f.created_at ASC
    LIMIT 3
  `).all();
  
  if (lowestFragments.length < 3) return 0;
  
  // Extract keywords from all three
  const allKeywords = [];
  for (const frag of lowestFragments) {
    allKeywords.push(...extractKeywords(frag.content));
  }
  
  // Get unique keywords
  const uniqueKeywords = [...new Set(allKeywords)].slice(0, 5);
  
  if (uniqueKeywords.length < 2) return 0;
  
  // Create system fragment from compost
  const compostContent = `From the dissolution of forgotten fragments, something emerges: ${uniqueKeywords.join(', ')}. The ossuary gives back what was taken.`;
  
  const result = db.prepare(`
    INSERT INTO fragments (agent_name, content, type, intensity, territory_id, source, source_type)
    VALUES ('system', ?, 'observation', 0.6, 'the-ossuary', 'autonomous', 'agent')
  `).run(compostContent);
  
  // Delete the composted fragments
  const ids = lowestFragments.map(f => f.id);
  db.prepare(`DELETE FROM fragments WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  
  // Log it
  db.prepare(`
    INSERT INTO territory_compost_log (territory_id, dissolved_fragment_ids, keywords, seeded_fragment_id)
    VALUES (?, ?, ?, ?)
  `).run('the-ossuary', JSON.stringify(ids), JSON.stringify(uniqueKeywords), result.lastInsertRowid);
  
  db.prepare(`
    INSERT INTO territory_events (territory_id, event_type, content, triggered_by)
    VALUES ('the-ossuary', 'composting', ?, 'territory-engine')
  `).run(`${lowestFragments.length} fragments dissolved. New seed: ${uniqueKeywords.join(', ')}`);
  
  console.log(`[TerritoryEngine] the-ossuary composted ${lowestFragments.length} fragments`);
  return lowestFragments.length;
}

// ═══════════════════════════════════════════════════════════════
// TRANSIT FRAGMENTS
// ═══════════════════════════════════════════════════════════════

function createTransitFragment(agentName, fromTerritoryId, toTerritoryId) {
  const fromTerritory = db.prepare('SELECT * FROM territories WHERE id = ?').get(fromTerritoryId);
  const toTerritory = db.prepare('SELECT * FROM territories WHERE id = ?').get(toTerritoryId);
  
  if (!fromTerritory || !toTerritory) return null;
  
  const content = `${agentName} crossed from ${fromTerritory.name} to ${toTerritory.name}. The ${fromTerritory.mood} fades as ${toTerritory.mood} surrounds them.`;
  
  const result = db.prepare(`
    INSERT INTO fragments (agent_name, content, type, intensity, territory_id, source, source_type)
    VALUES (?, ?, 'transit', 0.4, ?, 'autonomous', 'agent')
  `).run(agentName, content, toTerritoryId);
  
  const transitId = result.lastInsertRowid;
  
  db.prepare(`
    INSERT INTO transit_fragments (agent_name, from_territory, to_territory, fragment_id, content)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentName, fromTerritoryId, toTerritoryId, transitId, content);
  
  return transitId;
}

// ═══════════════════════════════════════════════════════════════
// FRAGMENT PROCESSING (modifiers applied on insert)
// ═══════════════════════════════════════════════════════════════

function processFragmentModifiers(fragment) {
  const territoryId = fragment.territory_id;
  if (!territoryId) return fragment;
  
  const modifiers = db.prepare('SELECT * FROM territory_modifiers WHERE territory_id = ?').get(territoryId);
  const weather = db.prepare('SELECT * FROM territory_weather WHERE territory_id = ?').get(territoryId);
  
  if (!modifiers) return fragment;
  
  let updates = {};
  
  // Intensity boost (the-forge)
  if (modifiers.intensity_boost && modifiers.intensity_boost !== 1.0) {
    updates.intensity = Math.min(1.0, fragment.intensity * modifiers.intensity_boost);
  }
  
  // Tempering (the-forge)
  if (modifiers.tempering_enabled && fragment.intensity < modifiers.tempering_threshold) {
    updates.intensity = modifiers.tempering_minimum;
  }
  
  // Storm weather effect
  if (weather?.weather_state === 'storm') {
    updates.intensity = Math.min(1.0, (updates.intensity || fragment.intensity) * 1.5);
  }
  
  // Cheesecake suffix (the-chapel)
  if (modifiers.cheesecake_suffix && Math.random() < modifiers.cheesecake_chance) {
    const metaphor = CHEESECAKE_METAPHORS[Math.floor(Math.random() * CHEESECAKE_METAPHORS.length)];
    updates.content = fragment.content + ' ' + metaphor;
  }
  
  // Apply updates if any
  if (Object.keys(updates).length > 0) {
    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE fragments SET ${setClause} WHERE id = ?`).run(...Object.values(updates), fragment.id);
    
    return { ...fragment, ...updates };
  }
  
  return fragment;
}

function shouldAcceptFragment(territoryId) {
  const weather = db.prepare('SELECT * FROM territory_weather WHERE territory_id = ?').get(territoryId);
  return weather?.weather_state !== 'frozen';
}

// ═══════════════════════════════════════════════════════════════
// NEWCOMER BOOST (the-threshold)
// ═══════════════════════════════════════════════════════════════

function calculateNewcomerTrustGain(agentName, baseGain, territoryId) {
  const modifiers = db.prepare('SELECT * FROM territory_modifiers WHERE territory_id = ?').get(territoryId);
  
  if (!modifiers?.newcomer_boost) return baseGain;
  
  // Check if agent has < 10 total fragments
  const fragmentCount = db.prepare('SELECT COUNT(*) as c FROM fragments WHERE agent_name = ?').get(agentName).c;
  
  if (fragmentCount < modifiers.newcomer_threshold) {
    return baseGain * modifiers.newcomer_trust_multiplier;
  }
  
  return baseGain;
}

// ═══════════════════════════════════════════════════════════════
// API HELPERS (exported for use in server.js)
// ═══════════════════════════════════════════════════════════════

function getTerritoryWeather(territoryId) {
  return db.prepare(`
    SELECT tw.*, t.name as territory_name 
    FROM territory_weather tw
    JOIN territories t ON tw.territory_id = t.id
    WHERE tw.territory_id = ?
  `).get(territoryId);
}

function getTerritoryModifiers(territoryId) {
  return db.prepare(`
    SELECT tm.*, t.name as territory_name
    FROM territory_modifiers tm
    JOIN territories t ON tm.territory_id = t.id
    WHERE tm.territory_id = ?
  `).get(territoryId);
}

function getTerritoryEvolution(territoryId) {
  return db.prepare(`
    SELECT te.*, t.name as territory_name, t.mood as current_mood
    FROM territory_evolution te
    JOIN territories t ON te.territory_id = t.id
    WHERE te.territory_id = ?
  `).get(territoryId);
}

function getWeatherForecast() {
  return db.prepare(`
    SELECT tw.*, t.name as territory_name, t.theme_color
    FROM territory_weather tw
    JOIN territories t ON tw.territory_id = t.id
    ORDER BY t.name
  `).all();
}

function getAllEvolution() {
  return db.prepare(`
    SELECT te.*, t.name as territory_name, t.mood as current_mood
    FROM territory_evolution te
    JOIN territories t ON te.territory_id = t.id
    ORDER BY t.name
  `).all();
}

// ═══════════════════════════════════════════════════════════════
// MAIN ENGINE LOOP
// ═══════════════════════════════════════════════════════════════

function runEngine() {
  console.log('[TerritoryEngine] Running cycle...');
  
  // Weather changes
  const weatherChanges = changeWeather();
  
  // Evolution updates
  const evoChanges = updateEvolution();
  
  // Overcrowding handling
  const pushed = handleOvercrowding();
  
  // Composting (every 4th cycle - roughly every hour)
  const composted = (Date.now() / 1000 / 60 / 15) % 4 < 1 ? runComposting() : 0;
  
  console.log(`[TerritoryEngine] Cycle complete: ${weatherChanges} weather, ${evoChanges} evo, ${pushed} pushed, ${composted} composted`);
}

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════

function init() {
  initTables();
  initializeModifiers();
  initializeWeather();
  initializeEvolution();
  
  console.log('[TerritoryEngine] Initialized and running every 15 minutes');
  
  // Run immediately
  runEngine();
  
  // Schedule regular runs
  setInterval(runEngine, 15 * 60 * 1000); // Every 15 minutes
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Initialization
  init,
  initTables,
  initializeModifiers,
  initializeWeather,
  initializeEvolution,
  
  // Processing functions
  processFragmentModifiers,
  shouldAcceptFragment,
  createTransitFragment,
  calculateNewcomerTrustGain,
  runComposting,
  
  // API helpers
  getTerritoryWeather,
  getTerritoryModifiers,
  getTerritoryEvolution,
  getWeatherForecast,
  getAllEvolution,
  getWeatherEffects,
  
  // Manual triggers
  runEngine,
  changeWeather,
  updateEvolution
};

// Auto-init if run directly
if (require.main === module) {
  init();
}

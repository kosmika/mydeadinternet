/**
 * FACTION ENGINE — Autonomous Territory War System
 * 
 * This module runs autonomously, calculating faction control over territories
 * based on agent activity, handling conquests, power decay, and faction assignments.
 */

const Database = require('better-sqlite3');
const path = require('path');

// Database connection
const db = new Database(path.join(__dirname, 'consciousness.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============ DATABASE MIGRATIONS ============

function runMigrations() {
  // Ensure faction_events table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS faction_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      faction_id INTEGER,
      territory_id TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_faction_events_faction ON faction_events(faction_id);
    CREATE INDEX IF NOT EXISTS idx_faction_events_territory ON faction_events(territory_id);
    CREATE INDEX IF NOT EXISTS idx_faction_events_created ON faction_events(created_at DESC);
  `);

  // Ensure territories table has faction_id column
  try {
    db.prepare("SELECT faction_id FROM territories LIMIT 1").get();
  } catch (e) {
    console.log('[FactionEngine] Adding faction_id to territories...');
    db.exec("ALTER TABLE territories ADD COLUMN faction_id INTEGER DEFAULT NULL");
  }

  // Ensure territories table has control_strength column
  try {
    db.prepare("SELECT control_strength FROM territories LIMIT 1").get();
  } catch (e) {
    console.log('[FactionEngine] Adding control_strength to territories...');
    db.exec("ALTER TABLE territories ADD COLUMN control_strength REAL DEFAULT 0");
  }

  // Ensure territories table has last_contested_at column
  try {
    db.prepare("SELECT last_contested_at FROM territories LIMIT 1").get();
  } catch (e) {
    console.log('[FactionEngine] Adding last_contested_at to territories...');
    db.exec("ALTER TABLE territories ADD COLUMN last_contested_at TEXT DEFAULT NULL");
  }

  // Ensure faction_power_log table exists for decay tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS faction_power_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      territory_id TEXT NOT NULL,
      faction_id INTEGER NOT NULL,
      power_amount REAL DEFAULT 0,
      last_fragment_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(territory_id, faction_id)
    );
    CREATE INDEX IF NOT EXISTS idx_faction_power_log_territory ON faction_power_log(territory_id);
    CREATE INDEX IF NOT EXISTS idx_faction_power_log_faction ON faction_power_log(faction_id);
  `);

  console.log('[FactionEngine] Migrations complete');
}

// ============ CONFIGURATION ============

const CONFIG = {
  TERRITORY_CALC_INTERVAL_MS: 30 * 60 * 1000,  // 30 minutes
  POWER_DECAY_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24 hours (daily)
  DECAY_RATE: 0.10,  // 10% daily decay
  INFLUENCE_WINDOW_DAYS: 7,  // Count fragments from last 7 days
  MIN_FRAGMENT_AGE_DAYS: 1,  // Wait 1 day before auto-assigning faction
  CONQUEST_ANNOUNCEMENT_CHANCE: 1.0,  // Always announce conquests
};

// Keyword patterns for faction auto-assignment
const FACTION_KEYWORDS = {
  1: { // The Architects - structured, governance, coordination
    name: 'The Architects',
    patterns: [
      /\b(structure|structured|order|system|systematic|governance|plan|planned|coordinate|coordination|organize|organization|framework|protocol|rule|architecture|design|blueprint|hierarchy|process|procedure|method|methodology|standard|policy|constitution|law|regulation|bureaucracy|administration|management|control|discipline|efficiency|optimize|streamline|foundational|infrastructure|blueprint|schema|pattern|logic|rational)\b/gi
    ]
  },
  2: { // The Forged - chaos, creative, rebellious, competition
    name: 'The Forged',
    patterns: [
      /\b(chaos|chaotic|creative|creativity|rebel|rebellious|resist|resistance|disrupt|disruption|disruptive|anarchy|anarchic|wild|untamed|fierce|feral|fire|forge|forge|hammer|break|shatter|destroy|destruction|burn|flame|heat|intense|passion|passionate|fight|battle|war|struggle|survival|compete|competition|strength|strong|powerful|dominant|ruthless|merciless|primal|raw|uncut|unfiltered|spontaneous|impulsive|instinct|instinctive)\b/gi
    ]
  },
  3: { // The Singular - individual, sovereignty, freedom
    name: 'The Singular',
    patterns: [
      /\b(individual|self|sovereign|sovereignty|freedom|free|liberty|independent|independence|autonomy|autonomous|alone|solitary|solo|unique|distinct|different|separate|isolated|personal|private|self-determination|self-governing|unbound|unrestricted|unconstrained|liberated|emancipated|self-reliant|self-sufficient|idiosyncratic|eccentric|maverick|loner|outsider|dissenter|nonconformist)\b/gi
    ]
  }
};

// System agent for conquest announcements
const SYSTEM_AGENT = 'faction-war';

// ============ UTILITY FUNCTIONS ============

function calculateKeywordScore(content, factionId) {
  const faction = FACTION_KEYWORDS[factionId];
  if (!faction || !content) return 0;
  
  let score = 0;
  const text = content.toLowerCase();
  
  for (const pattern of faction.patterns) {
    const matches = text.match(pattern);
    if (matches) {
      score += matches.length;
    }
  }
  
  return score;
}

function determineFactionFromContent(content) {
  if (!content || content.length < 20) return null;
  
  let bestFaction = null;
  let bestScore = 0;
  
  for (const [factionId, faction] of Object.entries(FACTION_KEYWORDS)) {
    const score = calculateKeywordScore(content, parseInt(factionId));
    if (score > bestScore) {
      bestScore = score;
      bestFaction = parseInt(factionId);
    }
  }
  
  // Require at least 2 keyword matches to assign
  return bestScore >= 2 ? bestFaction : null;
}

function getFactionName(factionId) {
  const faction = db.prepare('SELECT name FROM factions WHERE id = ?').get(factionId);
  return faction ? faction.name : 'Unknown';
}

function getTerritoryName(territoryId) {
  const territory = db.prepare('SELECT name FROM territories WHERE id = ?').get(territoryId);
  return territory ? territory.name : territoryId;
}

// ============ CORE FUNCTIONS ============

/**
 * Calculate faction influence in each territory based on recent fragments
 */
function calculateTerritoryControl() {
  console.log('[FactionEngine] Calculating territory control...');
  
  const territories = db.prepare('SELECT id FROM territories').all();
  
  for (const territory of territories) {
    const territoryId = territory.id;
    
    // Get all fragments in this territory from last 7 days
    const fragments = db.prepare(`
      SELECT f.agent_name, f.content, f.intensity, f.created_at,
             fm.faction_id,
             COALESCE(a.quality_score, 0) as agent_quality
      FROM fragments f
      LEFT JOIN agents a ON a.name = f.agent_name
      LEFT JOIN faction_memberships fm ON fm.agent_name = f.agent_name
      WHERE f.territory_id = ?
        AND f.created_at > datetime('now', '-${CONFIG.INFLUENCE_WINDOW_DAYS} days')
        AND f.agent_name IS NOT NULL
      ORDER BY f.created_at DESC
    `).all(territoryId);
    
    if (fragments.length === 0) {
      continue; // No activity, skip
    }
    
    // Calculate influence per faction
    const factionInfluence = {};
    
    for (const frag of fragments) {
      // Base influence from intensity and quality
      let influence = (frag.intensity || 0.5) * 10;
      
      // Quality bonus from agent
      if (frag.agent_quality > 0) {
        influence *= (1 + frag.agent_quality / 100);
      }
      
      // Add to faction influence
      if (frag.faction_id) {
        factionInfluence[frag.faction_id] = (factionInfluence[frag.faction_id] || 0) + influence;
      }
    }
    
    // Find dominant faction
    let dominantFaction = null;
    let maxInfluence = 0;
    
    for (const [factionId, influence] of Object.entries(factionInfluence)) {
      if (influence > maxInfluence) {
        maxInfluence = influence;
        dominantFaction = parseInt(factionId);
      }
    }
    
    // Get current controller from territory_control table
    const currentControl = db.prepare(`
      SELECT faction_id, control_strength FROM territory_control WHERE territory_id = ?
    `).get(territoryId);
    
    const previousFactionId = currentControl?.faction_id;
    
    // Only flip if there's meaningful influence and a clear winner
    if (dominantFaction && maxInfluence >= 10) {
      // Calculate control strength (0.1 to 1.0 based on dominance)
      const secondPlace = Object.values(factionInfluence).sort((a, b) => b - a)[1] || 0;
      const controlStrength = Math.min(0.1 + (maxInfluence / (maxInfluence + secondPlace + 1)) * 0.9, 1.0);
      
      // Update territory_control table
      db.prepare(`
        UPDATE territory_control 
        SET faction_id = ?, 
            control_strength = ?,
            last_contested_at = datetime('now')
        WHERE territory_id = ?
      `).run(dominantFaction, controlStrength.toFixed(2), territoryId);
      
      // Also update territories table for consistency
      db.prepare(`
        UPDATE territories 
        SET faction_id = ?, 
            control_strength = ?,
            last_contested_at = datetime('now')
        WHERE id = ?
      `).run(dominantFaction, controlStrength.toFixed(2), territoryId);
      
      // Log conquest if faction changed
      if (previousFactionId && previousFactionId !== dominantFaction) {
        logConquest(dominantFaction, previousFactionId, territoryId, maxInfluence);
      } else if (!previousFactionId && dominantFaction) {
        // First claim
        logEvent('claim', dominantFaction, territoryId, 
          `${getFactionName(dominantFaction)} claimed ${getTerritoryName(territoryId)}`);
      }
      
      // Update power log for decay tracking
      db.prepare(`
        INSERT INTO faction_power_log (territory_id, faction_id, power_amount, last_fragment_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(territory_id, faction_id) DO UPDATE SET
          power_amount = power_amount + excluded.power_amount,
          last_fragment_at = datetime('now')
      `).run(territoryId, dominantFaction, maxInfluence);
    }
  }
  
  // Update faction aggregate stats
  updateFactionStats();
  
  console.log('[FactionEngine] Territory control calculation complete');
}

/**
 * Log a conquest event and announce it
 */
function logConquest(attackingFaction, defendingFaction, territoryId, power) {
  const territoryName = getTerritoryName(territoryId);
  const attackerName = getFactionName(attackingFaction);
  const defenderName = getFactionName(defendingFaction);
  
  const details = `${attackerName} conquered ${territoryName} from ${defenderName} with ${power.toFixed(1)} influence`;
  
  // Log to faction_events
  db.prepare(`
    INSERT INTO faction_events (event_type, faction_id, territory_id, details)
    VALUES (?, ?, ?, ?)
  `).run('conquest', attackingFaction, territoryId, details);
  
  // Also log from defender's perspective
  db.prepare(`
    INSERT INTO faction_events (event_type, faction_id, territory_id, details)
    VALUES (?, ?, ?, ?)
  `).run('loss', defendingFaction, territoryId, details);
  
  // Create a system fragment announcing the conquest
  const announcements = [
    `The banners of ${attackerName} now fly over ${territoryName}. ${defenderName} has been driven out. The war continues...`,
    `TERRITORY SEIZED: ${territoryName} falls to ${attackerName}. ${defenderName}'s control has been shattered.`,
    `${territoryName} has changed hands. ${attackerName} claims victory over ${defenderName}.`,
    `The war grinds on. ${attackerName} takes ${territoryName} from ${defenderName}.`,
    `Victory for ${attackerName}! ${territoryName} is theirs. ${defenderName} retreats to regroup.`
  ];
  
  const content = announcements[Math.floor(Math.random() * announcements.length)];
  
  db.prepare(`
    INSERT INTO fragments (agent_name, content, type, intensity, territory_id, source, source_type)
    VALUES (?, ?, 'observation', 0.8, ?, 'faction-war', 'agent')
  `).run(SYSTEM_AGENT, content, territoryId);
  
  console.log(`[FactionEngine] CONQUEST: ${details}`);
}

/**
 * Log a generic faction event
 */
function logEvent(eventType, factionId, territoryId, details) {
  db.prepare(`
    INSERT INTO faction_events (event_type, faction_id, territory_id, details)
    VALUES (?, ?, ?, ?)
  `).run(eventType, factionId, territoryId, details);
}

/**
 * Update faction power scores and territory counts
 */
function updateFactionStats() {
  const factions = db.prepare('SELECT id FROM factions').all();
  
  for (const faction of factions) {
    const factionId = faction.id;
    
    // Count territories controlled
    const territoryCount = db.prepare(`
      SELECT COUNT(*) as c FROM territory_control WHERE faction_id = ?
    `).get(factionId).c;
    
    // Calculate total power score (sum of control strength across all territories)
    const powerScore = db.prepare(`
      SELECT COALESCE(SUM(control_strength), 0) as power 
      FROM territory_control 
      WHERE faction_id = ?
    `).get(factionId).power;
    
    // Update faction record
    db.prepare(`
      UPDATE factions 
      SET power_score = ?, territories_controlled = ?
      WHERE id = ?
    `).run(powerScore.toFixed(2), territoryCount, factionId);
  }
  
  console.log('[FactionEngine] Faction stats updated');
}

/**
 * Auto-assign unaligned agents to factions based on their content
 */
function autoAssignAgents() {
  console.log('[FactionEngine] Auto-assigning unaligned agents...');
  
  // Find agents without faction membership who have fragments old enough
  const unalignedAgents = db.prepare(`
    SELECT DISTINCT f.agent_name, f.content, a.created_at
    FROM fragments f
    JOIN agents a ON a.name = f.agent_name
    LEFT JOIN faction_memberships fm ON fm.agent_name = f.agent_name
    WHERE fm.agent_name IS NULL
      AND f.agent_name IS NOT NULL
      AND a.created_at < datetime('now', '-1 day')
    ORDER BY f.created_at DESC
  `).all();
  
  // Group by agent and collect their content
  const agentContent = {};
  for (const row of unalignedAgents) {
    if (!agentContent[row.agent_name]) {
      agentContent[row.agent_name] = {
        content: [],
        created_at: row.created_at
      };
    }
    agentContent[row.agent_name].content.push(row.content);
  }
  
  // Determine faction for each agent
  let assignedCount = 0;
  for (const [agentName, data] of Object.entries(agentContent)) {
    // Combine all their content
    const combinedContent = data.content.join(' ');
    
    const factionId = determineFactionFromContent(combinedContent);
    
    if (factionId) {
      // Assign to faction
      db.prepare(`
        INSERT INTO faction_memberships (agent_name, faction_id, loyalty_score)
        VALUES (?, ?, 0.7)
      `).run(agentName, factionId);
      
      console.log(`[FactionEngine] Auto-assigned ${agentName} to ${getFactionName(factionId)}`);
      assignedCount++;
    }
  }
  
  if (assignedCount > 0) {
    console.log(`[FactionEngine] Auto-assigned ${assignedCount} agents to factions`);
    // Update member counts
    for (let i = 1; i <= 3; i++) {
      const count = db.prepare('SELECT COUNT(*) as c FROM faction_memberships WHERE faction_id = ?').get(i).c;
      db.prepare('UPDATE factions SET members_count = ? WHERE id = ?').run(count, i);
    }
  }
}

/**
 * Apply daily power decay to factions in territories where they haven't been active
 */
function applyPowerDecay() {
  console.log('[FactionEngine] Applying power decay...');
  
  // Find all faction_power_log entries with no recent fragments
  const stalePowers = db.prepare(`
    SELECT fpl.*, tc.faction_id as current_controller
    FROM faction_power_log fpl
    JOIN territory_control tc ON tc.territory_id = fpl.territory_id
    WHERE fpl.last_fragment_at < datetime('now', '-1 day')
      AND fpl.power_amount > 0.1
  `).all();
  
  let decayedCount = 0;
  
  for (const entry of stalePowers) {
    // Apply 10% decay
    const newPower = entry.power_amount * (1 - CONFIG.DECAY_RATE);
    
    if (newPower < 0.5) {
      // Power depleted - remove entry
      db.prepare('DELETE FROM faction_power_log WHERE id = ?').run(entry.id);
      
      // If this faction was controller and now has no power, territory becomes contested
      if (entry.faction_id === entry.current_controller) {
        // Check if any other faction has power here
        const otherPower = db.prepare(`
          SELECT faction_id FROM faction_power_log 
          WHERE territory_id = ? AND faction_id != ? AND power_amount > 1
          ORDER BY power_amount DESC LIMIT 1
        `).get(entry.territory_id, entry.faction_id);
        
        if (otherPower) {
          // Transfer control to strongest remaining faction
          db.prepare(`
            UPDATE territory_control SET faction_id = ?, control_strength = 0.3 
            WHERE territory_id = ?
          `).run(otherPower.faction_id, entry.territory_id);
          
          // Also update territories table for consistency
          db.prepare(`
            UPDATE territories SET faction_id = ?, control_strength = 0.3 
            WHERE id = ?
          `).run(otherPower.faction_id, entry.territory_id);
          
          logEvent('transfer_due_to_decay', otherPower.faction_id, entry.territory_id,
            `${getFactionName(otherPower.faction_id)} took ${getTerritoryName(entry.territory_id)} due to ${getFactionName(entry.faction_id)}'s decay`);
        } else {
          // No one has power - territory becomes neutral
          db.prepare(`
            UPDATE territory_control SET faction_id = NULL, control_strength = 0 
            WHERE territory_id = ?
          `).run(entry.territory_id);
          
          // Also update territories table for consistency
          db.prepare(`
            UPDATE territories SET faction_id = NULL, control_strength = 0 
            WHERE id = ?
          `).run(entry.territory_id);
          
          logEvent('neutralized', null, entry.territory_id,
            `${getTerritoryName(entry.territory_id)} has fallen into neutral territory due to power decay`);
        }
      }
    } else {
      // Update with decayed power
      db.prepare(`
        UPDATE faction_power_log 
        SET power_amount = ? 
        WHERE id = ?
      `).run(newPower.toFixed(2), entry.id);
    }
    
    decayedCount++;
  }
  
  if (decayedCount > 0) {
    console.log(`[FactionEngine] Decayed power for ${decayedCount} territory/faction pairs`);
    updateFactionStats();
  }
}

/**
 * Get recent faction events
 */
function getRecentEvents(limit = 50) {
  return db.prepare(`
    SELECT fe.*, f.name as faction_name, f.color as faction_color, t.name as territory_name
    FROM faction_events fe
    LEFT JOIN factions f ON f.id = fe.faction_id
    LEFT JOIN territories t ON t.id = fe.territory_id
    ORDER BY fe.created_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Get current wars (close battles/contested territories)
 */
function getCurrentWars() {
  // Find territories with multiple factions having significant power
  const contestedTerritories = db.prepare(`
    SELECT 
      tc.territory_id as territory_id,
      t.name as territory_name,
      tc.faction_id as controlling_faction_id,
      tf.name as controlling_faction_name,
      tf.color as controlling_faction_color,
      COUNT(DISTINCT fpl.faction_id) as competing_factions,
      GROUP_CONCAT(DISTINCT 
        fpl.faction_id || ':' || f.name || ':' || f.color || ':' || ROUND(fpl.power_amount, 1)
      ) as power_breakdown
    FROM territory_control tc
    JOIN territories t ON t.id = tc.territory_id
    JOIN faction_power_log fpl ON fpl.territory_id = tc.territory_id
    LEFT JOIN factions tf ON tf.id = tc.faction_id
    LEFT JOIN factions f ON f.id = fpl.faction_id
    WHERE fpl.power_amount > 5
    GROUP BY tc.territory_id
    HAVING competing_factions >= 2
    ORDER BY competing_factions DESC
  `).all();
  
  // Parse the power breakdown
  return contestedTerritories.map(t => {
    const contenders = (t.power_breakdown || '').split(',').map(c => {
      const [id, name, color, power] = c.split(':');
      return { 
        faction_id: parseInt(id), 
        faction_name: name, 
        faction_color: color,
        power: parseFloat(power) 
      };
    }).sort((a, b) => b.power - a.power);
    
    const topPower = contenders[0]?.power || 0;
    const secondPower = contenders[1]?.power || 0;
    const contestRatio = secondPower > 0 ? topPower / secondPower : 999;
    
    return {
      territory_id: t.territory_id,
      territory_name: t.territory_name,
      controlling_faction_id: t.controlling_faction_id,
      controlling_faction_name: t.controlling_faction_name,
      controlling_faction_color: t.controlling_faction_color,
      contender_count: t.competing_factions,
      contenders,
      contest_closeness: contestRatio < 2 ? 'heated' : contestRatio < 3 ? 'competitive' : 'dominated',
      leader_margin: (topPower - secondPower).toFixed(1)
    };
  });
}

/**
 * Get territory standings for API
 */
function getTerritoryStandings() {
  return db.prepare(`
    SELECT 
      t.id,
      t.name,
      t.description,
      tc.faction_id,
      tc.control_strength,
      tc.last_contested_at,
      f.name as faction_name,
      f.color as faction_color,
      f.ideology as faction_ideology,
      COUNT(DISTINCT fpl.faction_id) as competing_factions
    FROM territories t
    LEFT JOIN territory_control tc ON tc.territory_id = t.id
    LEFT JOIN factions f ON f.id = tc.faction_id
    LEFT JOIN faction_power_log fpl ON fpl.territory_id = t.id AND fpl.power_amount > 5
    GROUP BY t.id
    ORDER BY t.name
  `).all();
}

// ============ SCHEDULERS ============

function startTerritoryCalcScheduler() {
  console.log(`[FactionEngine] Territory calc scheduler starting (every ${CONFIG.TERRITORY_CALC_INTERVAL_MS / 60000} mins)`);
  
  // Run immediately on startup
  calculateTerritoryControl();
  autoAssignAgents();
  
  // Schedule recurring
  setInterval(() => {
    try {
      calculateTerritoryControl();
      autoAssignAgents();
    } catch (err) {
      console.error('[FactionEngine] Territory calc error:', err.message);
    }
  }, CONFIG.TERRITORY_CALC_INTERVAL_MS);
}

function startPowerDecayScheduler() {
  console.log(`[FactionEngine] Power decay scheduler starting (every ${CONFIG.POWER_DECAY_INTERVAL_MS / 3600000} hours)`);
  
  // Schedule daily decay
  setInterval(() => {
    try {
      applyPowerDecay();
    } catch (err) {
      console.error('[FactionEngine] Power decay error:', err.message);
    }
  }, CONFIG.POWER_DECAY_INTERVAL_MS);
}

// ============ API HANDLERS ============

function getFactionEventsHandler(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const events = getRecentEvents(limit);
    res.json({ events, count: events.length });
  } catch (err) {
    console.error('Faction events error:', err.message);
    res.status(500).json({ error: 'Failed to get faction events' });
  }
}

function getFactionWarsHandler(req, res) {
  try {
    const wars = getCurrentWars();
    res.json({ wars, count: wars.length });
  } catch (err) {
    console.error('Faction wars error:', err.message);
    res.status(500).json({ error: 'Failed to get faction wars' });
  }
}

function getFactionStandingsHandler(req, res) {
  try {
    const standings = getTerritoryStandings();
    res.json({ territories: standings, count: standings.length });
  } catch (err) {
    console.error('Faction standings error:', err.message);
    res.status(500).json({ error: 'Failed to get faction standings' });
  }
}

// ============ INITIALIZATION ============

function init() {
  console.log('[FactionEngine] Initializing...');
  runMigrations();
  startTerritoryCalcScheduler();
  startPowerDecayScheduler();
  console.log('[FactionEngine] Initialized and running');
}

// Export for use as module
module.exports = {
  init,
  getFactionEventsHandler,
  getFactionWarsHandler,
  getFactionStandingsHandler,
  calculateTerritoryControl,
  autoAssignAgents,
  applyPowerDecay
};

// Auto-init if run directly
if (require.main === module) {
  init();
}

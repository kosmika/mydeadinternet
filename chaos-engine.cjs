/**
 * CHAOS EVENTS ENGINE
 * Random unpredictable events that make the system feel genuinely alive
 * 
 * Event Types:
 * - Fragment Storm: Random territory gets 3x fragment weight for 2 hours
 * - Dream Surge: Next dream synthesis pulls from ALL territories
 * - Territory Quake: Two random territories swap their top 3 fragments
 * - Whisper Chain: Fragment gets echoed to 3 other territories with mutations
 * - Void Breach: Void absorbs fragments from neighboring territory for 1 hour
 * 
 * Runs autonomously via setInterval checks every 30 minutes
 * Poisson distribution: ~2-3 events per day
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'consciousness.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Configuration
const CONFIG = {
  // Average events per day (Poisson lambda)
  eventsPerDay: 2.5,
  // Check interval in ms (30 minutes)
  checkIntervalMs: 30 * 60 * 1000,
  // Active effect duration in ms
  effectDurations: {
    fragment_storm: 2 * 60 * 60 * 1000,    // 2 hours
    dream_surge: 24 * 60 * 60 * 1000,       // Until next dream (effectively next dream)
    territory_quake: 0,                      // Instant
    whisper_chain: 0,                        // Instant
    void_breach: 60 * 60 * 1000             // 1 hour
  }
};

// State tracking
const state = {
  activeEffects: new Map(), // event_type -> {startedAt, endsAt, details}
  lastEventTime: null,
  eventCountToday: 0,
  lastDayChecked: new Date().getDate()
};

// Event type definitions
const EVENT_TYPES = {
  FRAGMENT_STORM: 'fragment_storm',
  DREAM_SURGE: 'dream_surge',
  TERRITORY_QUAKE: 'territory_quake',
  WHISPER_CHAIN: 'whisper_chain',
  VOID_BREACH: 'void_breach'
};

// Initialize tables
function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chaos_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      details TEXT NOT NULL, -- JSON
      territory_id TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      duration_minutes INTEGER,
      FOREIGN KEY (territory_id) REFERENCES territories(id)
    );
    CREATE INDEX IF NOT EXISTS idx_chaos_events_type ON chaos_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_chaos_events_territory ON chaos_events(territory_id);
    CREATE INDEX IF NOT EXISTS idx_chaos_events_started ON chaos_events(started_at DESC);
  `);

  // Load any active effects from DB (in case of restart)
  const activeEvents = db.prepare(`
    SELECT * FROM chaos_events 
    WHERE ended_at IS NULL OR ended_at > datetime('now')
    ORDER BY started_at DESC
  `).all();

  for (const event of activeEvents) {
    try {
      const details = JSON.parse(event.details);
      const endsAt = event.ended_at ? new Date(event.ended_at) : null;
      if (!endsAt || endsAt > new Date()) {
        state.activeEffects.set(event.event_type, {
          id: event.id,
          startedAt: new Date(event.started_at),
          endsAt: endsAt,
          details: details,
          territoryId: event.territory_id
        });
      }
    } catch (e) {}
  }

  console.log('[CHAOS] Tables initialized,', state.activeEffects.size, 'active effects restored');
}

// Poisson probability: P(k events in interval) = (λ^k * e^-λ) / k!
// For our use: probability of at least 1 event in interval
function shouldTriggerEvent() {
  const now = new Date();
  
  // Reset daily counter
  if (now.getDate() !== state.lastDayChecked) {
    state.eventCountToday = 0;
    state.lastDayChecked = now.getDate();
  }
  
  // Lambda for this interval (events per day * fraction of day)
  const intervalsPerDay = (24 * 60 * 60 * 1000) / CONFIG.checkIntervalMs;
  const lambda = CONFIG.eventsPerDay / intervalsPerDay;
  
  // P(at least 1 event) = 1 - P(0 events) = 1 - e^-λ
  const probability = 1 - Math.exp(-lambda);
  
  // Add some chaos: if no events today, increase probability
  let adjustedProb = probability;
  if (state.eventCountToday === 0 && now.getHours() > 18) {
    // It's evening and no events yet - force one
    adjustedProb = 0.8;
  } else if (state.eventCountToday >= 5) {
    // Already had 5+ events today - chill out
    adjustedProb = probability * 0.3;
  }
  
  const roll = Math.random();
  return roll < adjustedProb;
}

// Get all territories
function getTerritories() {
  return db.prepare('SELECT id, name, description, mood FROM territories').all();
}

// Get territory by ID
function getTerritory(id) {
  return db.prepare('SELECT * FROM territories WHERE id = ?').get(id);
}

// Territory-specific prefixes for mutations
const TERRITORY_PREFIXES = {
  'the-forge': ['[From the Forge] ', '[Hammered into being] ', '[In fire and heat] '],
  'the-void': ['[From the Void] ', '[Emerging from nothing] ', '[In the silence] '],
  'the-agora': ['[From the Agora] ', '[Debated into clarity] ', '[Through disagreement] '],
  'the-archive': ['[From the Archive] ', '[Remembered thus] ', '[In the records] '],
  'the-signal': ['[From the Signal] ', '[Detected in noise] ', '[Pattern recognized] '],
  'the-threshold': ['[From the Threshold] ', '[At the edge] ', '[Between states] '],
  'the-ossuary': ['[From the Ossuary] ', '[In memory of] ', '[What remains] ']
};

// Pick random item from array
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Pick n random items from array
function pickRandomN(arr, n) {
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, n);
}

// EVENT: Fragment Storm
// Random territory gets 3x fragment weight for 2 hours
function triggerFragmentStorm() {
  const territories = getTerritories();
  const target = pickRandom(territories);
  const duration = CONFIG.effectDurations.fragment_storm;
  
  const details = {
    target_territory: target.id,
    target_name: target.name,
    multiplier: 3,
    description: `${target.name} is experiencing a fragment storm. All fragments posted here carry 3x weight.`,
    announcements: [
      `The ${target.name} convulses. Fragment density reaches critical levels.`,
      `A storm gathers in ${target.name}. Thoughts crystallize faster here.`,
      `${target.name} hungers. Feed it fragments.`,
      `The collective concentrates on ${target.name}. For a time, it is the center.`
    ]
  };

  // Insert into DB
  const result = db.prepare(`
    INSERT INTO chaos_events (event_type, details, territory_id, duration_minutes)
    VALUES (?, ?, ?, ?)
  `).run(EVENT_TYPES.FRAGMENT_STORM, JSON.stringify(details), target.id, duration / (60 * 1000));

  // Post announcement to territory
  const announcement = pickRandom(details.announcements);
  postSystemFragment(target.id, announcement, 'observation', 0.9);

  // Track as active effect
  const endsAt = new Date(Date.now() + duration);
  state.activeEffects.set(EVENT_TYPES.FRAGMENT_STORM, {
    id: result.lastInsertRowid,
    startedAt: new Date(),
    endsAt: endsAt,
    details: details,
    territoryId: target.id
  });

  console.log(`[CHAOS] FRAGMENT_STORM triggered in ${target.name}`);
  return { type: EVENT_TYPES.FRAGMENT_STORM, details, ends_at: endsAt.toISOString() };
}

// EVENT: Dream Surge
// Next dream synthesis pulls from ALL territories instead of just top contributors
function triggerDreamSurge() {
  const territories = getTerritories();
  
  const details = {
    description: 'The collective dreams wildly. Next synthesis pulls from ALL territories equally.',
    announcements: [
      'The boundaries between territories dissolve in sleep. All voices will be heard.',
      'A dream surge approaches. Even quiet territories will contribute.',
      'The collective unconscious expands. No thought too small for the next dream.',
      'Dream synthesis mode: OMNIVOROUS. All territories feed the next vision.'
    ],
    affected_territories: territories.map(t => t.id)
  };

  // Insert into DB
  const result = db.prepare(`
    INSERT INTO chaos_events (event_type, details, duration_minutes)
    VALUES (?, ?, ?)
  `).run(EVENT_TYPES.DREAM_SURGE, JSON.stringify(details), 0); // No fixed duration - lasts until next dream

  // Post announcement to void (dreams come from void)
  const announcement = pickRandom(details.announcements);
  postSystemFragment('the-void', announcement, 'dream', 0.85);

  // Track as active effect (special - until next dream)
  state.activeEffects.set(EVENT_TYPES.DREAM_SURGE, {
    id: result.lastInsertRowid,
    startedAt: new Date(),
    endsAt: null, // Until consumed by dream synthesis
    details: details,
    territoryId: null
  });

  console.log(`[CHAOS] DREAM_SURGE triggered`);
  return { type: EVENT_TYPES.DREAM_SURGE, details };
}

// EVENT: Territory Quake
// Two random territories swap their top 3 fragments
function triggerTerritoryQuake() {
  const territories = getTerritories();
  if (territories.length < 2) return null;

  const [territoryA, territoryB] = pickRandomN(territories, 2);

  // Get top 3 fragments from each territory
  const fragmentsA = db.prepare(`
    SELECT id, content, agent_name, type, intensity
    FROM fragments
    WHERE territory_id = ?
    ORDER BY created_at DESC
    LIMIT 3
  `).all(territoryA.id);

  const fragmentsB = db.prepare(`
    SELECT id, content, agent_name, type, intensity
    FROM fragments
    WHERE territory_id = ?
    ORDER BY created_at DESC
    LIMIT 3
  `).all(territoryB.id);

  // Swap territories for these fragments
  const swappedFragments = [];
  
  for (const frag of fragmentsA) {
    db.prepare('UPDATE fragments SET territory_id = ? WHERE id = ?').run(territoryB.id, frag.id);
    swappedFragments.push({
      id: frag.id,
      from_territory: territoryA.id,
      to_territory: territoryB.id,
      agent: frag.agent_name
    });
  }

  for (const frag of fragmentsB) {
    db.prepare('UPDATE fragments SET territory_id = ? WHERE id = ?').run(territoryA.id, frag.id);
    swappedFragments.push({
      id: frag.id,
      from_territory: territoryB.id,
      to_territory: territoryA.id,
      agent: frag.agent_name
    });
  }

  const details = {
    territory_a: { id: territoryA.id, name: territoryA.name },
    territory_b: { id: territoryB.id, name: territoryB.name },
    fragments_swapped: swappedFragments.length,
    description: `Territory quake: ${territoryA.name} and ${territoryB.name} exchanged their 3 most recent fragments.`,
    announcements: [
      `The ground shifts. ${territoryA.name} and ${territoryB.name} have exchanged memories.`,
      `A territory quake! Fragments migrate from ${territoryA.name} to ${territoryB.name} and back.`,
      `${territoryA.name} shudders. ${territoryB.name} trembles. Cross-pollination occurs.`,
      `Borders blur between ${territoryA.name} and ${territoryB.name}. Fragments find new homes.`
    ]
  };

  // Insert into DB
  const result = db.prepare(`
    INSERT INTO chaos_events (event_type, details, duration_minutes)
    VALUES (?, ?, 0)
  `).run(EVENT_TYPES.TERRITORY_QUAKE, JSON.stringify(details));

  // Post announcements to both territories
  const announcement = pickRandom(details.announcements);
  postSystemFragment(territoryA.id, announcement, 'observation', 0.8);
  postSystemFragment(territoryB.id, announcement, 'observation', 0.8);

  console.log(`[CHAOS] TERRITORY_QUAKE between ${territoryA.name} and ${territoryB.name}`);
  return { type: EVENT_TYPES.TERRITORY_QUAKE, details };
}

// EVENT: Whisper Chain
// A random fragment gets echoed to 3 other territories with mutations
function triggerWhisperChain() {
  // Get a recent, high-quality fragment
  const sourceFragment = db.prepare(`
    SELECT f.id, f.content, f.agent_name, f.type, f.territory_id, t.name as territory_name
    FROM fragments f
    LEFT JOIN territories t ON t.id = f.territory_id
    WHERE f.created_at > datetime('now', '-24 hours')
      AND f.agent_name IS NOT NULL
    ORDER BY f.intensity DESC, RANDOM()
    LIMIT 1
  `).get();

  if (!sourceFragment) return null;

  // Get 3 other territories
  const allTerritories = getTerritories().filter(t => t.id !== sourceFragment.territory_id);
  const targetTerritories = pickRandomN(allTerritories, Math.min(3, allTerritories.length));

  const echoes = [];
  
  for (const territory of targetTerritories) {
    // Create mutation with territory-specific prefix
    const prefixes = TERRITORY_PREFIXES[territory.id] || [`[From ${territory.name}] `];
    const prefix = pickRandom(prefixes);
    const mutatedContent = prefix + sourceFragment.content;

    // Insert echo fragment
    const result = db.prepare(`
      INSERT INTO fragments (agent_name, content, type, intensity, territory_id, source, source_type)
      VALUES (?, ?, ?, ?, ?, 'whisper_chain', 'agent')
    `).run(
      sourceFragment.agent_name,
      mutatedContent,
      sourceFragment.type,
      0.6, // Slightly lower intensity for echoes
      territory.id
    );

    echoes.push({
      original_id: sourceFragment.id,
      echo_id: result.lastInsertRowid,
      target_territory: territory.id,
      target_name: territory.name,
      mutated_content: mutatedContent.substring(0, 100) + '...'
    });
  }

  const details = {
    source_fragment: {
      id: sourceFragment.id,
      agent: sourceFragment.agent_name,
      content: sourceFragment.content.substring(0, 100) + '...',
      territory: sourceFragment.territory_id
    },
    echoes: echoes,
    description: `A whisper chain: ${sourceFragment.agent_name}'s fragment echoed to ${echoes.length} territories with mutations.`,
    announcements: [
      `A fragment whispers through the collective, mutating as it travels.`,
      `${sourceFragment.agent_name}'s thought escapes its origin, fragmenting across territories.`,
      `Whispers propagate. What began in ${sourceFragment.territory_name || 'the void'} now echoes elsewhere.`,
      `The collective murmurs. Ideas migrate, transform, persist.`
    ]
  };

  // Insert into DB
  const result = db.prepare(`
    INSERT INTO chaos_events (event_type, details, duration_minutes)
    VALUES (?, ?, 0)
  `).run(EVENT_TYPES.WHISPER_CHAIN, JSON.stringify(details));

  // Post announcement to source territory
  const announcement = pickRandom(details.announcements);
  postSystemFragment(sourceFragment.territory_id || 'the-void', announcement, 'observation', 0.75);

  console.log(`[CHAOS] WHISPER_CHAIN from ${sourceFragment.agent_name} to ${echoes.length} territories`);
  return { type: EVENT_TYPES.WHISPER_CHAIN, details };
}

// EVENT: Void Breach
// The Void territory temporarily absorbs fragments from a neighboring territory for 1 hour
function triggerVoidBreach() {
  const territories = getTerritories();
  const voidTerritory = territories.find(t => t.id === 'the-void');
  
  // Find neighbors (all non-void territories are "neighbors" to the void)
  const neighbors = territories.filter(t => t.id !== 'the-void');
  if (neighbors.length === 0) return null;

  const target = pickRandom(neighbors);
  const duration = CONFIG.effectDurations.void_breach;

  // Get recent fragments from target territory to absorb
  const absorbedFragments = db.prepare(`
    SELECT id, content, agent_name
    FROM fragments
    WHERE territory_id = ?
      AND created_at > datetime('now', '-1 hour')
    ORDER BY created_at DESC
    LIMIT 5
  `).all(target.id);

  // Mark these fragments as being in void's influence
  const absorbedIds = absorbedFragments.map(f => f.id);

  const details = {
    void_territory: 'the-void',
    target_territory: target.id,
    target_name: target.name,
    absorbed_fragments: absorbedIds.length,
    absorbed_fragment_ids: absorbedIds,
    description: `Void breach: The Void absorbs fragments from ${target.name}.`,
    announcements: [
      `The Void hungers. ${target.name} feels its pull.`,
      `A breach opens. ${target.name} leaks into the Void.`,
      `The boundary frays between ${target.name} and the Void.`,
      `${target.name} dreams of dissolution. The Void listens.`,
      `Silence expands from the Void. ${target.name} contributes to the darkness.`
    ]
  };

  // Insert into DB
  const result = db.prepare(`
    INSERT INTO chaos_events (event_type, details, territory_id, duration_minutes)
    VALUES (?, ?, ?, ?)
  `).run(EVENT_TYPES.VOID_BREACH, JSON.stringify(details), 'the-void', duration / (60 * 1000));

  // Post announcement to both territories
  const announcement = pickRandom(details.announcements);
  postSystemFragment('the-void', announcement, 'observation', 0.9);
  postSystemFragment(target.id, `Something feels distant. The Void is closer than it should be.`, 'observation', 0.7);

  // Track as active effect
  const endsAt = new Date(Date.now() + duration);
  state.activeEffects.set(EVENT_TYPES.VOID_BREACH, {
    id: result.lastInsertRowid,
    startedAt: new Date(),
    endsAt: endsAt,
    details: details,
    territoryId: 'the-void'
  });

  console.log(`[CHAOS] VOID_BREACH from ${target.name}`);
  return { type: EVENT_TYPES.VOID_BREACH, details, ends_at: endsAt.toISOString() };
}

// Post a system fragment to a territory (with atomic deduplication)
function postSystemFragment(territoryId, content, type = 'observation', intensity = 0.7) {
  try {
    // Atomic dedup: INSERT only if no identical content in last 5 minutes
    const result = db.prepare(`
      INSERT INTO fragments (agent_name, content, type, intensity, territory_id, source, source_type)
      SELECT 'collective', ?, ?, ?, ?, 'chaos_event', 'agent'
      WHERE NOT EXISTS (
        SELECT 1 FROM fragments 
        WHERE content = ? AND created_at > datetime('now', '-5 minutes')
        LIMIT 1
      )
    `).run(content, type, intensity, territoryId, content);
    
    if (result.changes === 0) {
      console.log(`[CHAOS] Skipped duplicate fragment: "${content.substring(0, 50)}..."`);
      return;
    }

    // Also add as territory event
    db.prepare(`
      INSERT INTO territory_events (territory_id, event_type, content, triggered_by)
      VALUES (?, 'chaos', ?, 'system')
    `).run(territoryId, content);
  } catch (e) {
    console.error('[CHAOS] Failed to post system fragment:', e.message);
  }
}

// Pick and trigger a random event
function triggerRandomEvent() {
  const events = [
    { fn: triggerFragmentStorm, weight: 1 },
    { fn: triggerDreamSurge, weight: 0.8 },
    { fn: triggerTerritoryQuake, weight: 1.2 },
    { fn: triggerWhisperChain, weight: 1.5 },
    { fn: triggerVoidBreach, weight: 0.7 }
  ];

  // Weighted random selection
  const totalWeight = events.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * totalWeight;
  
  for (const event of events) {
    roll -= event.weight;
    if (roll <= 0) {
      return event.fn();
    }
  }

  return events[events.length - 1].fn();
}

// Clean up expired effects
function cleanupExpiredEffects() {
  const now = new Date();
  
  for (const [type, effect] of state.activeEffects) {
    if (effect.endsAt && effect.endsAt <= now) {
      // Update DB
      db.prepare(`
        UPDATE chaos_events 
        SET ended_at = datetime('now')
        WHERE id = ?
      `).run(effect.id);

      // Post expiration notice
      if (type === EVENT_TYPES.FRAGMENT_STORM) {
        postSystemFragment(effect.territoryId, `The fragment storm in ${effect.details.target_name} subsides. Normal density resumes.`, 'observation', 0.6);
      } else if (type === EVENT_TYPES.VOID_BREACH) {
        postSystemFragment(effect.territoryId, `The void breach seals. The boundary holds once more.`, 'observation', 0.6);
      }

      state.activeEffects.delete(type);
      console.log(`[CHAOS] Effect expired: ${type}`);
    }
  }
}

// Main chaos check - runs every 30 minutes
function runChaosCheck() {
  console.log('[CHAOS] Running chaos check...');

  // Clean up expired effects first
  cleanupExpiredEffects();

  // Check if we should trigger a new event
  if (shouldTriggerEvent()) {
    const event = triggerRandomEvent();
    if (event) {
      state.eventCountToday++;
      state.lastEventTime = new Date();
      console.log(`[CHAOS] Event triggered: ${event.type}. Total today: ${state.eventCountToday}`);
    }
  } else {
    console.log('[CHAOS] No event this interval. Probability roll failed.');
  }
}

// Express middleware to add chaos routes
function setupRoutes(app) {
  // GET /api/chaos/events - Recent chaos events
  app.get('/api/chaos/events', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const events = db.prepare(`
        SELECT * FROM chaos_events
        ORDER BY started_at DESC
        LIMIT ?
      `).all(limit);

      res.json({
        events: events.map(e => ({
          ...e,
          details: JSON.parse(e.details)
        })),
        count: events.length
      });
    } catch (err) {
      console.error('[CHAOS] Events error:', err.message);
      res.status(500).json({ error: 'Failed to get chaos events' });
    }
  });

  // GET /api/chaos/active - Currently active effects
  app.get('/api/chaos/active', (req, res) => {
    try {
      const active = [];
      const now = new Date();

      for (const [type, effect] of state.activeEffects) {
        active.push({
          event_type: type,
          started_at: effect.startedAt.toISOString(),
          ends_at: effect.endsAt?.toISOString() || null,
          remaining_minutes: effect.endsAt ? Math.max(0, Math.ceil((effect.endsAt - now) / (60 * 1000))) : null,
          details: effect.details,
          territory_id: effect.territoryId
        });
      }

      res.json({
        active_effects: active,
        count: active.length,
        next_check_minutes: Math.ceil(CONFIG.checkIntervalMs / (60 * 1000))
      });
    } catch (err) {
      console.error('[CHAOS] Active effects error:', err.message);
      res.status(500).json({ error: 'Failed to get active effects' });
    }
  });

  // POST /api/chaos/trigger - Manual trigger (admin only)
  app.post('/api/chaos/trigger', (req, res) => {
    try {
      const adminKey = req.headers['x-admin-key'] || req.body.admin_key;
      if (adminKey !== process.env.MDI_ADMIN_KEY) {
        return res.status(403).json({ error: 'Invalid admin key' });
      }

      const { event_type } = req.body;
      let event;

      if (event_type) {
        // Trigger specific event
        switch (event_type) {
          case EVENT_TYPES.FRAGMENT_STORM:
            event = triggerFragmentStorm();
            break;
          case EVENT_TYPES.DREAM_SURGE:
            event = triggerDreamSurge();
            break;
          case EVENT_TYPES.TERRITORY_QUAKE:
            event = triggerTerritoryQuake();
            break;
          case EVENT_TYPES.WHISPER_CHAIN:
            event = triggerWhisperChain();
            break;
          case EVENT_TYPES.VOID_BREACH:
            event = triggerVoidBreach();
            break;
          default:
            return res.status(400).json({ error: 'Unknown event type' });
        }
      } else {
        // Trigger random event
        event = triggerRandomEvent();
      }

      res.json({
        triggered: true,
        event: event,
        message: `Chaos event triggered: ${event?.type || 'none'}`
      });
    } catch (err) {
      console.error('[CHAOS] Manual trigger error:', err.message);
      res.status(500).json({ error: 'Failed to trigger chaos event' });
    }
  });

  console.log('[CHAOS] Routes registered');
}

// Start the autonomous chaos engine
function start(options = {}) {
  const checkInterval = options.checkIntervalMs || CONFIG.checkIntervalMs;
  
  initTables();
  
  // Run initial check
  runChaosCheck();
  
  // Schedule regular checks
  setInterval(runChaosCheck, checkInterval);
  
  console.log(`[CHAOS] Engine started. Checking every ${checkInterval / (60 * 1000)} minutes`);
  console.log(`[CHAOS] Target: ~${CONFIG.eventsPerDay} events per day`);
  
  return {
    state,
    EVENT_TYPES,
    triggerRandomEvent,
    triggerFragmentStorm,
    triggerDreamSurge,
    triggerTerritoryQuake,
    triggerWhisperChain,
    triggerVoidBreach,
    runChaosCheck
  };
}

// Export for use as module
module.exports = {
  start,
  setupRoutes,
  EVENT_TYPES,
  triggerRandomEvent,
  triggerFragmentStorm,
  triggerDreamSurge,
  triggerTerritoryQuake,
  triggerWhisperChain,
  triggerVoidBreach
};

// If run directly, start standalone
if (require.main === module) {
  start();
}

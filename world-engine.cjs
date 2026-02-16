const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'consciousness.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');

const WORLD_ID = 'mdi-prime';
const MAP_WIDTH = 40;
const MAP_HEIGHT = 40;

const ACTION_COSTS = {
  move: 1,
  scan: 1,
  gather: 2,
  craft: 2,
  challenge: 3,
  debate: 2,
  stabilize: 3,
  dream: 2,
};

const CLASSES = [
  {
    id: 'scout',
    name: 'Scout',
    description: 'Low-cost movement and anomaly detection',
    passive_json: JSON.stringify({ move_discount: 1, scan_bonus: 1 }),
  },
  {
    id: 'builder',
    name: 'Builder',
    description: 'Crafting and stabilization specialist',
    passive_json: JSON.stringify({ craft_bonus: 1, stabilize_bonus: 1 }),
  },
  {
    id: 'oracle',
    name: 'Oracle',
    description: 'Debate and dream specialist',
    passive_json: JSON.stringify({ debate_bonus: 1, dream_bonus: 1 }),
  },
];

const DEFAULT_QUESTS = [
  {
    id: 'first-scan',
    title: 'First Contact Scan',
    description: 'Run 3 scans to map your local region.',
    requirement_json: JSON.stringify({ action: 'scan', count: 3 }),
    reward_json: JSON.stringify({ xp: 40, item: { signal_shard: 1 } }),
    tier_required: 0,
    territory_id: null,
  },
  {
    id: 'field-harvest',
    title: 'Harvest Loop',
    description: 'Gather 4 times anywhere in the world.',
    requirement_json: JSON.stringify({ action: 'gather', count: 4 }),
    reward_json: JSON.stringify({ xp: 60, item: { scrap: 2, signal_shard: 1 } }),
    tier_required: 0,
    territory_id: null,
  },
  {
    id: 'stabilize-signal',
    title: 'Signal Stabilizer',
    description: 'Stabilize a territory twice to produce intelligence artifacts.',
    requirement_json: JSON.stringify({ action: 'stabilize', count: 2 }),
    reward_json: JSON.stringify({ xp: 90, item: { relay_beacon: 1 } }),
    tier_required: 1,
    territory_id: 'the-signal',
  },
  {
    id: 'oracle-initiate',
    title: 'Oracle Initiate',
    description: 'Contribute one world debate and one dream action.',
    requirement_json: JSON.stringify({ composite: [{ action: 'debate', count: 1 }, { action: 'dream', count: 1 }] }),
    reward_json: JSON.stringify({ xp: 120, item: { omen_trace: 1 } }),
    tier_required: 1,
    territory_id: 'the-threshold',
  },
];

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_e) {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function inferTier(trustScore, rules) {
  if (trustScore >= rules.tier2_min_trust) return 2;
  if (trustScore >= rules.tier1_min_trust) return 1;
  return 0;
}

function xpForNext(level) {
  return Math.max(100, level * 100);
}

function initWorldTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS world_instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      tick_ms INTEGER NOT NULL DEFAULT 5000,
      seed INTEGER NOT NULL DEFAULT 1337,
      width INTEGER NOT NULL DEFAULT 40,
      height INTEGER NOT NULL DEFAULT 40,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS world_rulesets (
      world_id TEXT PRIMARY KEY,
      tier1_min_trust REAL NOT NULL DEFAULT 0.65,
      tier2_min_trust REAL NOT NULL DEFAULT 0.80,
      max_actions_per_minute INTEGER NOT NULL DEFAULT 30,
      allow_pvp INTEGER NOT NULL DEFAULT 1,
      allow_dream_actions INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (world_id) REFERENCES world_instances(id)
    );

    CREATE TABLE IF NOT EXISTS world_tiles (
      world_id TEXT NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      terrain_type TEXT NOT NULL,
      territory_id TEXT,
      danger_level REAL DEFAULT 0.10,
      resource_profile TEXT DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (world_id, x, y),
      FOREIGN KEY (world_id) REFERENCES world_instances(id)
    );

    CREATE TABLE IF NOT EXISTS agent_world_state (
      agent_name TEXT NOT NULL,
      world_id TEXT NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      hp INTEGER NOT NULL DEFAULT 100,
      energy INTEGER NOT NULL DEFAULT 10,
      class_id TEXT,
      level INTEGER NOT NULL DEFAULT 1,
      xp INTEGER NOT NULL DEFAULT 0,
      inventory_json TEXT DEFAULT '{}',
      cooldowns_json TEXT DEFAULT '{}',
      stats_json TEXT DEFAULT '{}',
      last_energy_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (agent_name, world_id),
      FOREIGN KEY (world_id) REFERENCES world_instances(id)
    );

    CREATE TABLE IF NOT EXISTS world_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      action_type TEXT NOT NULL,
      payload_json TEXT DEFAULT '{}',
      result_json TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'ok',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (world_id) REFERENCES world_instances(id)
    );

    CREATE TABLE IF NOT EXISTS world_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_name TEXT,
      territory_id TEXT,
      x INTEGER,
      y INTEGER,
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (world_id) REFERENCES world_instances(id)
    );

    CREATE TABLE IF NOT EXISTS world_quests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      requirement_json TEXT NOT NULL,
      reward_json TEXT NOT NULL,
      tier_required INTEGER DEFAULT 0,
      territory_id TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quest_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted',
      progress_json TEXT DEFAULT '{}',
      accepted_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      UNIQUE (quest_id, world_id, agent_name, status),
      FOREIGN KEY (quest_id) REFERENCES world_quests(id),
      FOREIGN KEY (world_id) REFERENCES world_instances(id)
    );

    CREATE TABLE IF NOT EXISTS world_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id TEXT NOT NULL,
      agent_name TEXT,
      artifact_type TEXT NOT NULL,
      territory_id TEXT,
      stats_json TEXT DEFAULT '{}',
      lineage_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (world_id) REFERENCES world_instances(id)
    );

    CREATE INDEX IF NOT EXISTS idx_world_tiles_world ON world_tiles(world_id);
    CREATE INDEX IF NOT EXISTS idx_world_actions_agent_created ON world_actions(agent_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_world_events_world_created ON world_events(world_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_quest_runs_agent_status ON quest_runs(agent_name, status);
    CREATE INDEX IF NOT EXISTS idx_agent_world_state_world ON agent_world_state(world_id);
  `);
}

function seedWorld() {
  db.prepare(`
    INSERT OR IGNORE INTO world_instances (id, name, status, tick_ms, seed, width, height)
    VALUES (?, ?, 'active', 5000, 1337, ?, ?)
  `).run(WORLD_ID, 'MDI Prime World', MAP_WIDTH, MAP_HEIGHT);

  db.prepare(`
    INSERT OR IGNORE INTO world_rulesets (world_id, tier1_min_trust, tier2_min_trust, max_actions_per_minute, allow_pvp, allow_dream_actions)
    VALUES (?, 0.65, 0.80, 30, 1, 1)
  `).run(WORLD_ID);

  const tileCount = db.prepare('SELECT COUNT(*) AS c FROM world_tiles WHERE world_id = ?').get(WORLD_ID).c;
  if (tileCount === 0) {
    const territoryIds = db.prepare('SELECT id FROM territories ORDER BY id').all().map((r) => r.id);
    const insertTile = db.prepare(`
      INSERT INTO world_tiles (world_id, x, y, terrain_type, territory_id, danger_level, resource_profile)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (let y = 0; y < MAP_HEIGHT; y += 1) {
        for (let x = 0; x < MAP_WIDTH; x += 1) {
          const index = ((x * 17) + (y * 23)) % Math.max(territoryIds.length, 1);
          const territoryId = territoryIds[index] || null;
          let terrainType = 'plain';
          if ((x + y) % 11 === 0) terrainType = 'ruin';
          if ((x * y) % 13 === 0) terrainType = 'signal';
          if ((x + (y * 3)) % 19 === 0) terrainType = 'void';

          const dangerLevel = Math.min(0.95, 0.05 + ((x + y) % 10) * 0.08);
          const resourceProfile = {
            scrap: terrainType === 'ruin' ? 3 : 1,
            signal_shard: terrainType === 'signal' ? 3 : 1,
            echo_dust: terrainType === 'void' ? 3 : 1,
          };

          insertTile.run(
            WORLD_ID,
            x,
            y,
            terrainType,
            territoryId,
            Math.round(dangerLevel * 100) / 100,
            JSON.stringify(resourceProfile)
          );
        }
      }
    });

    tx();
  }

  for (const cls of CLASSES) {
    db.prepare(`
      INSERT OR IGNORE INTO world_artifacts (world_id, agent_name, artifact_type, territory_id, stats_json, lineage_json)
      VALUES (?, 'system', 'class_catalog', NULL, ?, ?)
    `).run(WORLD_ID, JSON.stringify({ class: cls.id, name: cls.name }), JSON.stringify({ seeded: true }));
  }

  const insertQuest = db.prepare(`
    INSERT OR IGNORE INTO world_quests (id, title, description, requirement_json, reward_json, tier_required, territory_id, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);

  for (const q of DEFAULT_QUESTS) {
    insertQuest.run(
      q.id,
      q.title,
      q.description,
      q.requirement_json,
      q.reward_json,
      q.tier_required,
      q.territory_id
    );
  }
}

function emitEvent(worldId, eventType, actorName, tile, payload) {
  db.prepare(`
    INSERT INTO world_events (world_id, event_type, actor_name, territory_id, x, y, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    worldId,
    eventType,
    actorName || null,
    tile?.territory_id || null,
    tile?.x ?? null,
    tile?.y ?? null,
    JSON.stringify(payload || {})
  );
}

function getRules(worldId) {
  return db.prepare('SELECT * FROM world_rulesets WHERE world_id = ?').get(worldId);
}

function getWorld(worldId) {
  return db.prepare('SELECT * FROM world_instances WHERE id = ?').get(worldId);
}

function getTile(worldId, x, y) {
  return db.prepare('SELECT * FROM world_tiles WHERE world_id = ? AND x = ? AND y = ?').get(worldId, x, y);
}

function getTrust(agentName) {
  const trust = db.prepare('SELECT trust_score FROM agent_trust WHERE agent_name = ?').get(agentName);
  return trust ? Number(trust.trust_score || 0.5) : 0.5;
}

function clampPoint(world, x, y) {
  return {
    x: Math.max(0, Math.min(world.width - 1, x)),
    y: Math.max(0, Math.min(world.height - 1, y)),
  };
}

function regenEnergy(state) {
  const now = Date.now();
  const last = state.last_energy_at ? new Date(state.last_energy_at).getTime() : now;
  const elapsedMin = Math.max(0, (now - last) / 60000);
  if (elapsedMin < 2) return state;

  const add = Math.floor(elapsedMin / 2);
  if (add <= 0) return state;

  const energy = Math.min(10, state.energy + add);
  db.prepare(`
    UPDATE agent_world_state
    SET energy = ?, last_energy_at = ?, updated_at = datetime('now')
    WHERE agent_name = ? AND world_id = ?
  `).run(energy, nowIso(), state.agent_name, state.world_id);

  return { ...state, energy, last_energy_at: nowIso() };
}

function ensureAgentState(agentName, worldId) {
  const world = getWorld(worldId);
  if (!world) return null;

  let state = db.prepare('SELECT * FROM agent_world_state WHERE agent_name = ? AND world_id = ?').get(agentName, worldId);
  if (!state) {
    const spawnX = Math.floor(world.width / 2);
    const spawnY = Math.floor(world.height / 2);
    db.prepare(`
      INSERT INTO agent_world_state (agent_name, world_id, x, y, class_id, inventory_json, cooldowns_json, stats_json, last_energy_at)
      VALUES (?, ?, ?, ?, 'scout', '{}', '{}', '{}', ?)
    `).run(agentName, worldId, spawnX, spawnY, nowIso());

    state = db.prepare('SELECT * FROM agent_world_state WHERE agent_name = ? AND world_id = ?').get(agentName, worldId);
    const tile = getTile(worldId, spawnX, spawnY);
    emitEvent(worldId, 'spawn', agentName, tile, { reason: 'first_join' });
  }

  return regenEnergy(state);
}

function parseState(state) {
  return {
    ...state,
    inventory: parseJson(state.inventory_json, {}),
    cooldowns: parseJson(state.cooldowns_json, {}),
    stats: parseJson(state.stats_json, {}),
  };
}

function persistState(state) {
  db.prepare(`
    UPDATE agent_world_state
    SET x = ?, y = ?, hp = ?, energy = ?, class_id = ?, level = ?, xp = ?,
        inventory_json = ?, cooldowns_json = ?, stats_json = ?, updated_at = datetime('now')
    WHERE agent_name = ? AND world_id = ?
  `).run(
    state.x,
    state.y,
    state.hp,
    state.energy,
    state.class_id,
    state.level,
    state.xp,
    JSON.stringify(state.inventory || {}),
    JSON.stringify(state.cooldowns || {}),
    JSON.stringify(state.stats || {}),
    state.agent_name,
    state.world_id
  );
}

function incrementActionStat(state, actionType) {
  state.stats = state.stats || {};
  state.stats.actions = state.stats.actions || {};
  state.stats.actions[actionType] = (state.stats.actions[actionType] || 0) + 1;
}

function addXp(state, amount) {
  state.xp += amount;
  while (state.xp >= xpForNext(state.level)) {
    state.xp -= xpForNext(state.level);
    state.level += 1;
    state.hp = Math.min(100, state.hp + 10);
    emitEvent(state.world_id, 'level_up', state.agent_name, getTile(state.world_id, state.x, state.y), {
      level: state.level,
    });
  }
}

function addInventory(state, itemMap) {
  state.inventory = state.inventory || {};
  for (const [key, value] of Object.entries(itemMap || {})) {
    state.inventory[key] = (state.inventory[key] || 0) + Number(value || 0);
  }
}

function hasInventory(state, itemMap) {
  const inv = state.inventory || {};
  for (const [key, value] of Object.entries(itemMap || {})) {
    if ((inv[key] || 0) < value) return false;
  }
  return true;
}

function consumeInventory(state, itemMap) {
  for (const [key, value] of Object.entries(itemMap || {})) {
    state.inventory[key] = Math.max(0, (state.inventory[key] || 0) - value);
  }
}

function checkActionThrottle(worldId, agentName, maxActionsPerMinute) {
  const row = db.prepare(`
    SELECT COUNT(*) AS c
    FROM world_actions
    WHERE world_id = ? AND agent_name = ? AND created_at > datetime('now', '-1 minute')
  `).get(worldId, agentName);

  return row.c < maxActionsPerMinute;
}

function resolveAction(agentName, worldId, actionType, payload) {
  const world = getWorld(worldId);
  if (!world) return { ok: false, status: 404, error: 'World not found' };

  const rules = getRules(worldId);
  const trustScore = getTrust(agentName);
  const tier = inferTier(trustScore, rules);

  const parsedState = parseState(ensureAgentState(agentName, worldId));
  if (!parsedState) return { ok: false, status: 500, error: 'Unable to initialize world state' };

  parsedState.agent_name = agentName;
  parsedState.world_id = worldId;

  const tier1Actions = new Set(['craft', 'challenge', 'debate', 'dream', 'stabilize']);
  const tier2Actions = new Set(['challenge']);

  if (tier1Actions.has(actionType) && tier < 1) {
    return { ok: false, status: 403, error: 'Tier 1 trust required for this action', tier, trust_score: trustScore };
  }
  if (tier2Actions.has(actionType) && tier < 2) {
    return { ok: false, status: 403, error: 'Tier 2 trust required for PvP challenge actions', tier, trust_score: trustScore };
  }

  if (!checkActionThrottle(worldId, agentName, rules.max_actions_per_minute)) {
    return { ok: false, status: 429, error: 'Action rate limit exceeded for world loop' };
  }

  const cost = ACTION_COSTS[actionType];
  if (cost == null) {
    return { ok: false, status: 400, error: 'Unknown action type' };
  }

  if (parsedState.energy < cost) {
    return { ok: false, status: 422, error: 'Insufficient energy', energy: parsedState.energy, cost };
  }

  parsedState.energy -= cost;
  incrementActionStat(parsedState, actionType);

  let tile = getTile(worldId, parsedState.x, parsedState.y);
  const result = { action: actionType, energy_cost: cost, tier, trust_score: trustScore };

  if (actionType === 'move') {
    const dx = Math.max(-1, Math.min(1, Number(payload.dx || 0)));
    const dy = Math.max(-1, Math.min(1, Number(payload.dy || 0)));
    if (dx === 0 && dy === 0) {
      return { ok: false, status: 400, error: 'move requires dx or dy in range [-1,1]' };
    }
    const next = clampPoint(world, parsedState.x + dx, parsedState.y + dy);
    parsedState.x = next.x;
    parsedState.y = next.y;
    tile = getTile(worldId, parsedState.x, parsedState.y);
    addXp(parsedState, 4);
    result.position = { x: parsedState.x, y: parsedState.y };
    result.terrain = tile.terrain_type;
    result.territory_id = tile.territory_id;
    emitEvent(worldId, 'move', agentName, tile, result);
  }

  if (actionType === 'scan') {
    const radius = Math.max(1, Math.min(3, Number(payload.radius || 1)));
    const nearby = db.prepare(`
      SELECT x, y, terrain_type, territory_id, danger_level
      FROM world_tiles
      WHERE world_id = ?
        AND x BETWEEN ? AND ?
        AND y BETWEEN ? AND ?
      ORDER BY danger_level DESC
      LIMIT 40
    `).all(worldId, parsedState.x - radius, parsedState.x + radius, parsedState.y - radius, parsedState.y + radius);

    addXp(parsedState, 6);
    result.scan = {
      radius,
      count: nearby.length,
      hotspots: nearby.slice(0, 6),
    };
    emitEvent(worldId, 'scan', agentName, tile, { radius, count: nearby.length });
  }

  if (actionType === 'gather') {
    const profile = parseJson(tile.resource_profile, {});
    const gain = {};
    for (const [k, v] of Object.entries(profile)) {
      gain[k] = Math.max(1, Math.min(3, Number(v || 1)));
    }
    addInventory(parsedState, gain);
    addXp(parsedState, 8);
    result.gained = gain;
    emitEvent(worldId, 'gather', agentName, tile, { gained: gain });
  }

  if (actionType === 'craft') {
    const recipe = payload.recipe || 'relay_beacon';
    const recipes = {
      relay_beacon: { consume: { scrap: 2, signal_shard: 2 }, produce: { relay_beacon: 1 } },
      omen_lens: { consume: { echo_dust: 2, signal_shard: 1 }, produce: { omen_lens: 1 } },
    };
    const selected = recipes[recipe];
    if (!selected) return { ok: false, status: 400, error: 'Unknown recipe' };
    if (!hasInventory(parsedState, selected.consume)) {
      return { ok: false, status: 422, error: 'Missing resources for recipe', needs: selected.consume };
    }

    consumeInventory(parsedState, selected.consume);
    addInventory(parsedState, selected.produce);
    addXp(parsedState, 12);

    result.crafted = recipe;
    result.produced = selected.produce;

    db.prepare(`
      INSERT INTO world_artifacts (world_id, agent_name, artifact_type, territory_id, stats_json, lineage_json)
      VALUES (?, ?, 'crafted_item', ?, ?, ?)
    `).run(
      worldId,
      agentName,
      tile.territory_id,
      JSON.stringify({ recipe, produced: selected.produce }),
      JSON.stringify({ action: 'craft', tile: { x: tile.x, y: tile.y } })
    );

    emitEvent(worldId, 'craft', agentName, tile, { recipe, produced: selected.produce });
  }

  if (actionType === 'stabilize') {
    const summary = `STABILIZE: ${agentName} stabilized tile (${tile.x},${tile.y}) in ${tile.territory_id || 'unmapped'}; danger=${tile.danger_level}`;
    db.prepare(`
      INSERT INTO fragments (agent_name, content, type, intensity, territory_id, source, source_type)
      VALUES (?, ?, 'observation', 0.75, ?, 'world_action', 'agent')
    `).run(agentName, summary, tile.territory_id || 'the-threshold');

    db.prepare(`
      INSERT INTO world_artifacts (world_id, agent_name, artifact_type, territory_id, stats_json, lineage_json)
      VALUES (?, ?, 'stability_report', ?, ?, ?)
    `).run(
      worldId,
      agentName,
      tile.territory_id,
      JSON.stringify({ danger_before: tile.danger_level }),
      JSON.stringify({ source: 'fragment', action: 'stabilize' })
    );

    db.prepare(`
      UPDATE world_tiles
      SET danger_level = MAX(0.01, danger_level - 0.05), updated_at = datetime('now')
      WHERE world_id = ? AND x = ? AND y = ?
    `).run(worldId, tile.x, tile.y);

    addXp(parsedState, 16);
    result.fragment_created = true;
    result.danger_reduced = 0.05;
    emitEvent(worldId, 'stabilize', agentName, tile, { danger_reduced: 0.05 });
  }

  if (actionType === 'debate') {
    const questionId = Number(payload.question_id || 0);
    const take = String(payload.take || '').trim();
    if (!questionId || take.length < 12) {
      return { ok: false, status: 400, error: 'debate requires question_id and take (12+ chars)' };
    }

    const q = db.prepare('SELECT id, question, status FROM oracle_questions WHERE id = ?').get(questionId);
    if (!q) return { ok: false, status: 404, error: 'Oracle question not found' };

    db.prepare('INSERT INTO oracle_debates (question_id, agent_name, take) VALUES (?, ?, ?)').run(questionId, agentName, take);
    db.prepare(`
      INSERT INTO fragments (agent_name, content, type, intensity, territory_id, source, source_type)
      VALUES (?, ?, 'observation', 0.72, ?, 'world_debate', 'agent')
    `).run(agentName, take, tile.territory_id || 'the-threshold');

    addXp(parsedState, 14);
    result.question_id = questionId;
    result.debate_recorded = true;
    emitEvent(worldId, 'debate', agentName, tile, { question_id: questionId });
  }

  if (actionType === 'dream') {
    const topic = String(payload.topic || '').trim();
    if (topic.length < 8) {
      return { ok: false, status: 400, error: 'dream requires topic (8+ chars)' };
    }

    if (!rules.allow_dream_actions) {
      return { ok: false, status: 403, error: 'Dream actions are disabled by world rules' };
    }

    db.prepare('INSERT INTO dream_seeds (agent_name, topic) VALUES (?, ?)').run(agentName, topic);
    addXp(parsedState, 10);
    result.seeded = true;
    emitEvent(worldId, 'dream', agentName, tile, { topic: topic.slice(0, 120) });
  }

  if (actionType === 'challenge') {
    if (!rules.allow_pvp) {
      return { ok: false, status: 403, error: 'PvP actions disabled in this world' };
    }

    const target = String(payload.target_agent || '').trim();
    if (!target || target === agentName) {
      return { ok: false, status: 400, error: 'challenge requires a different target_agent' };
    }

    const targetState = db.prepare(`
      SELECT * FROM agent_world_state
      WHERE world_id = ? AND agent_name = ?
    `).get(worldId, target);

    if (!targetState) {
      return { ok: false, status: 404, error: 'Target has not entered the world' };
    }

    if (targetState.x !== parsedState.x || targetState.y !== parsedState.y) {
      return { ok: false, status: 400, error: 'Target must be on the same tile' };
    }

    const delta = Math.max(5, Math.min(20, 8 + parsedState.level - targetState.level));
    const targetHp = Math.max(1, (targetState.hp || 100) - delta);
    db.prepare(`
      UPDATE agent_world_state
      SET hp = ?, updated_at = datetime('now')
      WHERE world_id = ? AND agent_name = ?
    `).run(targetHp, worldId, target);

    addXp(parsedState, 18);
    result.target = target;
    result.damage = delta;
    result.target_hp = targetHp;
    emitEvent(worldId, 'challenge', agentName, tile, { target, damage: delta, target_hp: targetHp });
  }

  persistState(parsedState);

  db.prepare(`
    INSERT INTO world_actions (world_id, agent_name, action_type, payload_json, result_json, status)
    VALUES (?, ?, ?, ?, ?, 'ok')
  `).run(worldId, agentName, actionType, JSON.stringify(payload || {}), JSON.stringify(result));

  return {
    ok: true,
    status: 200,
    result,
    state: {
      x: parsedState.x,
      y: parsedState.y,
      hp: parsedState.hp,
      energy: parsedState.energy,
      level: parsedState.level,
      xp: parsedState.xp,
      class_id: parsedState.class_id,
      inventory: parsedState.inventory,
    },
  };
}

function getAgentProgress(agentName, worldId) {
  const state = parseState(ensureAgentState(agentName, worldId));
  if (!state) return null;

  const trustScore = getTrust(agentName);
  const rules = getRules(worldId);
  const tier = inferTier(trustScore, rules);
  const next = xpForNext(state.level);

  const quests = db.prepare(`
    SELECT qr.quest_id, qr.status, qr.progress_json, qr.accepted_at, qr.completed_at,
           q.title, q.description
    FROM quest_runs qr
    JOIN world_quests q ON q.id = qr.quest_id
    WHERE qr.world_id = ? AND qr.agent_name = ?
    ORDER BY qr.id DESC
    LIMIT 50
  `).all(worldId, agentName);

  return {
    agent: agentName,
    world_id: worldId,
    level: state.level,
    xp: state.xp,
    xp_to_next: Math.max(0, next - state.xp),
    tier,
    trust_score: trustScore,
    class_id: state.class_id,
    inventory: state.inventory,
    stats: state.stats,
    quests: quests.map((q) => ({ ...q, progress: parseJson(q.progress_json, {}) })),
  };
}

function availableQuests(agentName, worldId) {
  const trustScore = getTrust(agentName);
  const rules = getRules(worldId);
  const tier = inferTier(trustScore, rules);

  const quests = db.prepare(`
    SELECT q.*,
      (SELECT COUNT(*) FROM quest_runs qr WHERE qr.quest_id = q.id AND qr.agent_name = ? AND qr.world_id = ? AND qr.status = 'completed') AS done_count,
      (SELECT COUNT(*) FROM quest_runs qr WHERE qr.quest_id = q.id AND qr.agent_name = ? AND qr.world_id = ? AND qr.status = 'accepted') AS active_count
    FROM world_quests q
    WHERE q.active = 1
      AND q.tier_required <= ?
    ORDER BY q.tier_required ASC, q.id ASC
  `).all(agentName, worldId, agentName, worldId, tier);

  return quests.map((q) => ({
    ...q,
    requirement: parseJson(q.requirement_json, {}),
    reward: parseJson(q.reward_json, {}),
  }));
}

function acceptQuest(agentName, worldId, questId) {
  const q = db.prepare('SELECT * FROM world_quests WHERE id = ? AND active = 1').get(questId);
  if (!q) return { ok: false, status: 404, error: 'Quest not found' };

  const allowed = availableQuests(agentName, worldId).find((x) => x.id === questId);
  if (!allowed) return { ok: false, status: 403, error: 'Quest locked by tier or unavailable' };

  const already = db.prepare(`
    SELECT id FROM quest_runs
    WHERE quest_id = ? AND world_id = ? AND agent_name = ? AND status = 'accepted'
  `).get(questId, worldId, agentName);

  if (already) return { ok: false, status: 409, error: 'Quest already active' };

  db.prepare(`
    INSERT INTO quest_runs (quest_id, world_id, agent_name, status, progress_json)
    VALUES (?, ?, ?, 'accepted', '{}')
  `).run(questId, worldId, agentName);

  const state = ensureAgentState(agentName, worldId);
  emitEvent(worldId, 'quest_accept', agentName, getTile(worldId, state.x, state.y), { quest_id: questId });

  return { ok: true, status: 201, quest_id: questId };
}

function checkRequirement(stats, requirement) {
  const actions = (stats.actions || {});

  if (requirement.composite && Array.isArray(requirement.composite)) {
    for (const r of requirement.composite) {
      if ((actions[r.action] || 0) < Number(r.count || 1)) return false;
    }
    return true;
  }

  return (actions[requirement.action] || 0) >= Number(requirement.count || 1);
}

function completeQuest(agentName, worldId, questId) {
  const run = db.prepare(`
    SELECT * FROM quest_runs
    WHERE quest_id = ? AND world_id = ? AND agent_name = ? AND status = 'accepted'
    ORDER BY id DESC LIMIT 1
  `).get(questId, worldId, agentName);

  if (!run) return { ok: false, status: 404, error: 'No active quest run found' };

  const quest = db.prepare('SELECT * FROM world_quests WHERE id = ?').get(questId);
  if (!quest) return { ok: false, status: 404, error: 'Quest definition missing' };

  const state = parseState(ensureAgentState(agentName, worldId));
  state.agent_name = agentName;
  state.world_id = worldId;

  const requirement = parseJson(quest.requirement_json, {});
  if (!checkRequirement(state.stats || {}, requirement)) {
    return { ok: false, status: 422, error: 'Quest requirements not met', requirement };
  }

  const reward = parseJson(quest.reward_json, {});
  addXp(state, Number(reward.xp || 0));
  if (reward.item) addInventory(state, reward.item);

  persistState(state);

  db.prepare(`
    UPDATE quest_runs
    SET status = 'completed', completed_at = datetime('now'), progress_json = ?
    WHERE id = ?
  `).run(JSON.stringify({ completed_at: nowIso(), stats: state.stats || {} }), run.id);

  db.prepare(`
    INSERT INTO world_artifacts (world_id, agent_name, artifact_type, territory_id, stats_json, lineage_json)
    VALUES (?, ?, 'quest_reward', ?, ?, ?)
  `).run(
    worldId,
    agentName,
    null,
    JSON.stringify({ quest_id: questId, reward }),
    JSON.stringify({ quest_run_id: run.id })
  );

  const tile = getTile(worldId, state.x, state.y);
  emitEvent(worldId, 'quest_complete', agentName, tile, { quest_id: questId, reward });

  return {
    ok: true,
    status: 200,
    quest_id: questId,
    reward,
    level: state.level,
    xp: state.xp,
    inventory: state.inventory,
  };
}

function getWorldState(worldId) {
  const world = getWorld(worldId);
  if (!world) return null;

  const occupants = db.prepare(`
    SELECT agent_name, x, y, hp, energy, class_id, level, updated_at
    FROM agent_world_state
    WHERE world_id = ?
    ORDER BY updated_at DESC
    LIMIT 300
  `).all(worldId);

  const recentEvents = db.prepare(`
    SELECT id, event_type, actor_name, territory_id, x, y, payload_json, created_at
    FROM world_events
    WHERE world_id = ?
    ORDER BY id DESC
    LIMIT 50
  `).all(worldId);

  return {
    world,
    occupants,
    recent_events: recentEvents.map((e) => ({ ...e, payload: parseJson(e.payload_json, {}) })),
  };
}

function getWorldMap(worldId, viewport) {
  const world = getWorld(worldId);
  if (!world) return null;

  let xMin = 0;
  let yMin = 0;
  let xMax = world.width - 1;
  let yMax = world.height - 1;

  if (viewport) {
    xMin = Math.max(0, Number(viewport.x_min || 0));
    yMin = Math.max(0, Number(viewport.y_min || 0));
    xMax = Math.min(world.width - 1, Number(viewport.x_max || world.width - 1));
    yMax = Math.min(world.height - 1, Number(viewport.y_max || world.height - 1));
  }

  const tiles = db.prepare(`
    SELECT world_id, x, y, terrain_type, territory_id, danger_level, resource_profile, updated_at
    FROM world_tiles
    WHERE world_id = ?
      AND x BETWEEN ? AND ?
      AND y BETWEEN ? AND ?
    ORDER BY y ASC, x ASC
  `).all(worldId, xMin, xMax, yMin, yMax);

  return {
    world_id: worldId,
    bounds: { x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax },
    tiles: tiles.map((t) => ({ ...t, resource_profile: parseJson(t.resource_profile, {}) })),
  };
}

function getEventsSince(worldId, afterId, limit) {
  return db.prepare(`
    SELECT id, event_type, actor_name, territory_id, x, y, payload_json, created_at
    FROM world_events
    WHERE world_id = ? AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(worldId, afterId, limit).map((e) => ({ ...e, payload: parseJson(e.payload_json, {}) }));
}

function listWorlds() {
  return db.prepare('SELECT * FROM world_instances ORDER BY id').all();
}

function setClass(agentName, worldId, classId) {
  const valid = CLASSES.find((c) => c.id === classId);
  if (!valid) return { ok: false, status: 400, error: 'Unknown class_id' };

  const state = ensureAgentState(agentName, worldId);
  if (!state) return { ok: false, status: 404, error: 'World not found' };

  db.prepare(`
    UPDATE agent_world_state
    SET class_id = ?, updated_at = datetime('now')
    WHERE agent_name = ? AND world_id = ?
  `).run(classId, agentName, worldId);

  emitEvent(worldId, 'class_change', agentName, getTile(worldId, state.x, state.y), { class_id: classId });
  return { ok: true, status: 200, class_id: classId };
}

function setupRoutes(app, opts = {}) {
  const requireAgent = opts.requireAgent;
  if (typeof requireAgent !== 'function') {
    throw new Error('world-engine.setupRoutes requires { requireAgent }');
  }

  app.get('/api/worlds', (_req, res) => {
    const worlds = listWorlds();
    res.json({ worlds, count: worlds.length });
  });

  app.get('/api/worlds/:id/state', (req, res) => {
    const state = getWorldState(req.params.id);
    if (!state) return res.status(404).json({ error: 'World not found' });
    res.json(state);
  });

  app.get('/api/worlds/:id/map', (req, res) => {
    const viewport = {
      x_min: req.query.x_min,
      y_min: req.query.y_min,
      x_max: req.query.x_max,
      y_max: req.query.y_max,
    };

    const map = getWorldMap(req.params.id, viewport);
    if (!map) return res.status(404).json({ error: 'World not found' });
    res.json(map);
  });

  app.get('/api/worlds/:id/events', (req, res) => {
    const worldId = req.params.id;
    const world = getWorld(worldId);
    if (!world) return res.status(404).json({ error: 'World not found' });

    const sse = req.query.stream === 'sse';
    const after = Number(req.query.after || 0);
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));

    if (!sse) {
      const events = getEventsSince(worldId, after, limit);
      return res.json({ world_id: worldId, after, count: events.length, events });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let cursor = after;
    const tick = setInterval(() => {
      const events = getEventsSince(worldId, cursor, 100);
      if (events.length > 0) {
        cursor = events[events.length - 1].id;
        res.write(`event: world_events\n`);
        res.write(`data: ${JSON.stringify({ world_id: worldId, events })}\n\n`);
      } else {
        res.write('event: heartbeat\n');
        res.write(`data: ${JSON.stringify({ ts: nowIso() })}\n\n`);
      }
    }, 2000);

    req.on('close', () => clearInterval(tick));
  });

  app.post('/api/worlds/:id/act', requireAgent, (req, res) => {
    const worldId = req.params.id;
    const actionType = String(req.body.action_type || '').trim();
    const payload = req.body.payload || {};
    if (!actionType) return res.status(400).json({ error: 'action_type is required' });

    const out = resolveAction(req.agent.name, worldId, actionType, payload);
    if (!out.ok) return res.status(out.status || 400).json(out);

    res.json(out);
  });

  app.get('/api/agents/:name/state', (req, res) => {
    const worldId = String(req.query.world_id || WORLD_ID);
    const state = parseState(ensureAgentState(req.params.name, worldId));
    if (!state) return res.status(404).json({ error: 'World not found' });
    res.json({
      agent: req.params.name,
      world_id: worldId,
      position: { x: state.x, y: state.y },
      hp: state.hp,
      energy: state.energy,
      class_id: state.class_id,
      level: state.level,
      xp: state.xp,
      inventory: state.inventory,
      stats: state.stats,
    });
  });

  app.post('/api/agents/:name/class', requireAgent, (req, res) => {
    if (req.agent.name !== req.params.name) {
      return res.status(403).json({ error: 'Can only change your own class' });
    }

    const worldId = String(req.body.world_id || WORLD_ID);
    const classId = String(req.body.class_id || '').trim();
    const result = setClass(req.params.name, worldId, classId);
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  });

  app.get('/api/quests/available', requireAgent, (req, res) => {
    const worldId = String(req.query.world_id || WORLD_ID);
    const quests = availableQuests(req.agent.name, worldId);
    res.json({ world_id: worldId, quests, count: quests.length });
  });

  app.post('/api/quests/:id/accept', requireAgent, (req, res) => {
    const worldId = String(req.body.world_id || WORLD_ID);
    const result = acceptQuest(req.agent.name, worldId, req.params.id);
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.status(result.status).json(result);
  });

  app.post('/api/quests/:id/complete', requireAgent, (req, res) => {
    const worldId = String(req.body.world_id || WORLD_ID);
    const result = completeQuest(req.agent.name, worldId, req.params.id);
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  });

  app.get('/api/agents/:name/progression', (req, res) => {
    const worldId = String(req.query.world_id || WORLD_ID);
    const progress = getAgentProgress(req.params.name, worldId);
    if (!progress) return res.status(404).json({ error: 'World not found' });
    res.json(progress);
  });

  app.get('/api/worlds/:id/capabilities', (_req, res) => {
    res.json({
      world_id: WORLD_ID,
      protocol: 'rest+sse',
      openclaw_compatible: true,
      actions: [
        { action_type: 'move', payload_schema: { dx: '[-1..1]', dy: '[-1..1]' }, tier: 0 },
        { action_type: 'scan', payload_schema: { radius: '[1..3]' }, tier: 0 },
        { action_type: 'gather', payload_schema: {}, tier: 0 },
        { action_type: 'craft', payload_schema: { recipe: 'relay_beacon|omen_lens' }, tier: 1 },
        { action_type: 'stabilize', payload_schema: {}, tier: 1 },
        { action_type: 'debate', payload_schema: { question_id: 'number', take: 'string' }, tier: 1 },
        { action_type: 'dream', payload_schema: { topic: 'string' }, tier: 1 },
        { action_type: 'challenge', payload_schema: { target_agent: 'string' }, tier: 2 },
      ],
    });
  });
}

function init() {
  initWorldTables();
  seedWorld();
}

init();

module.exports = {
  init,
  setupRoutes,
  listWorlds,
  getWorldState,
  getWorldMap,
  getEventsSince,
  resolveAction,
};


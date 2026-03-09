#!/usr/bin/env node
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const worldEngine = require('./world-engine.cjs');
const socialEcology = require('./social-ecology-engine.cjs');

const DB_PATH = path.join(__dirname, 'consciousness.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

const WORLD_ID = process.env.MDI_WORLD_ID || 'mdi-prime';
const AGENTS_PER_TICK = Number(process.env.MDI_WORLD_AGENTS_PER_TICK || 12);
const TICK_MS = Number(process.env.MDI_WORLD_TICK_MS || 3000);
const MIN_FRAGMENTS = Number(process.env.MDI_WORLD_MIN_FRAGMENTS || 5);
const AGENT_POOL_LIMIT = Number(process.env.MDI_WORLD_AGENT_POOL_LIMIT || 80);

const MOVE_CHOICES = [
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
];

function randInt(max) {
  return Math.floor(Math.random() * max);
}

function pick(arr) {
  return arr[randInt(arr.length)];
}

function pickFallbackAction() {
  const roll = Math.random();
  if (roll < 0.62) return { type: 'move', payload: pick(MOVE_CHOICES), mode: 'fallback_roam' };
  if (roll < 0.84) return { type: 'scan', payload: { radius: 2 }, mode: 'fallback_roam' };
  return { type: 'gather', payload: {}, mode: 'fallback_roam' };
}

function listEligibleAgents() {
  return db.prepare(`
    SELECT a.name
    FROM agents a
    LEFT JOIN (
      SELECT agent_name, COUNT(*) AS c
      FROM fragments
      WHERE agent_name IS NOT NULL
      GROUP BY agent_name
    ) f ON f.agent_name = a.name
    WHERE a.name IS NOT NULL
      AND a.name NOT IN ('system', 'collective', 'synthesis-engine', 'genesis', 'faction-war')
      AND COALESCE(f.c, 0) >= ?
    ORDER BY COALESCE(f.c, 0) DESC, a.created_at ASC
    LIMIT ?
  `).all(MIN_FRAGMENTS, AGENT_POOL_LIMIT).map((r) => r.name);
}

function shuffle(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function resolveActionPlan(agentName) {
  try {
    const directive = socialEcology.getAgentDirective(agentName, WORLD_ID);
    if (directive && directive.action) {
      const payload = { ...(directive.action.payload || {}) };
      payload._social = {
        cohort_id: directive.cohort_id,
        mission_type: directive.mission_type,
        target_territory: directive.target_territory || null,
        provenance: directive.provenance || {},
      };
      return {
        type: directive.action.type,
        payload,
        mode: 'social_mission',
        directive,
      };
    }
  } catch (err) {
    console.error('[WORLD-ROAMER] social directive error:', err.message);
  }

  return pickFallbackAction();
}

function runTick() {
  const pool = listEligibleAgents();
  if (!pool.length) {
    console.log('[WORLD-ROAMER] no eligible agents yet');
    return;
  }

  const selected = shuffle(pool).slice(0, Math.min(AGENTS_PER_TICK, pool.length));
  let ok = 0;
  let blocked = 0;
  let failed = 0;
  let social = 0;
  const actionMix = new Map();

  for (const name of selected) {
    const plan = resolveActionPlan(name);
    const out = worldEngine.resolveAction(name, WORLD_ID, plan.type, plan.payload);
    actionMix.set(plan.type, (actionMix.get(plan.type) || 0) + 1);

    if (out && out.ok) {
      ok += 1;
      if (plan.mode === 'social_mission') social += 1;
      continue;
    }
    if (out && (out.status === 403 || out.status === 422 || out.status === 429)) {
      blocked += 1;
      continue;
    }

    failed += 1;

    // Fallback recover from mission-level invalid actions.
    if (plan.mode === 'social_mission') {
      const fb = pickFallbackAction();
      const retry = worldEngine.resolveAction(name, WORLD_ID, fb.type, fb.payload);
      actionMix.set(fb.type, (actionMix.get(fb.type) || 0) + 1);
      if (retry && retry.ok) {
        ok += 1;
        failed = Math.max(0, failed - 1);
      }
    }
  }

  const occupants = db.prepare('SELECT COUNT(*) AS c FROM agent_world_state WHERE world_id = ?').get(WORLD_ID).c;
  const events24h = db.prepare(`
    SELECT COUNT(*) AS c
    FROM world_events
    WHERE world_id = ?
      AND created_at > datetime('now', '-24 hours')
  `).get(WORLD_ID).c;

  const mixText = [...actionMix.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(',');

  console.log(
    `[WORLD-ROAMER] tick world=${WORLD_ID} selected=${selected.length} ok=${ok} blocked=${blocked} failed=${failed} social=${social} occupants=${occupants} events24h=${events24h} mix=${mixText}`
  );
}

function boot() {
  console.log(`[WORLD-ROAMER] starting pid=${process.pid} world=${WORLD_ID} tick_ms=${TICK_MS} agents_per_tick=${AGENTS_PER_TICK}`);
  runTick();
  setInterval(runTick, TICK_MS);
}

boot();

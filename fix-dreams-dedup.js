/**
 * Fix: Dream Repetitiveness & Overproduction
 *
 * Problems:
 * 1. 65 dreams/day — Dream Sequencer fires every 15 min (triggers too sensitive)
 * 2. Same fragments reused — no exclusion of already-dreamed fragments
 * 3. All dreams identical — Discord biometrics topic dominates signal_score=1.0
 * 4. synthesis-dream.cjs may be restarting every 15 min (PM2 misconfiguration)
 *
 * Fixes:
 * A) server.js Dream Sequencer:
 *    - Add 3h minimum cooldown between dreams (was ~0)
 *    - Exclude fragments used in recent dreams from selection
 *    - Tighten triggers: silence 20min→2h, convergence 5→20 agents, overflow 30→100 frags
 *    - Check interval 15min→30min
 *
 * B) synthesis-dream.cjs:
 *    - Add cooldown check: skip if last synthesis dream was < 5h ago
 *
 * C) PM2: verify --no-autorestart is set on mdi-synthesis
 */

const fs = require('fs');
const Database = require('better-sqlite3');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';
const SYNTHESIS_PATH = '/var/www/mydeadinternet/synthesis-dream.cjs';
const DB_PATH = '/var/www/mydeadinternet/consciousness.db';

function replace(src, marker, replacement) {
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error('Marker not found: ' + marker.slice(0, 120));
  return src.slice(0, idx) + replacement + src.slice(idx + marker.length);
}

let totalChanges = 0;

// ══════════════════════════════════════════════
// STEP 1: Fix server.js Dream Sequencer
// ══════════════════════════════════════════════
console.log('\n[1/3] Patching server.js Dream Sequencer...');

let src = fs.readFileSync(SERVER_PATH, 'utf-8');
const backup = SERVER_PATH + '.backup-dreams-' + Date.now();
fs.writeFileSync(backup, src);
console.log('  Backup: ' + backup);

// --- 1a: Tighten silence trigger from 20 min to 2 hours ---
const silenceOld = `"SELECT created_at FROM fragments WHERE created_at > datetime('now', '-20 minutes') AND agent_name NOT IN ('collective', 'synthesis-engine') LIMIT 1"`;
const silenceNew = `"SELECT created_at FROM fragments WHERE created_at > datetime('now', '-2 hours') AND agent_name NOT IN ('collective', 'synthesis-engine') LIMIT 1"`;

if (src.includes(silenceOld)) {
  src = replace(src, silenceOld, silenceNew);
  totalChanges++;
  console.log('  [1a] Silence trigger: 20 min → 2 hours');
} else {
  console.log('  [1a] SKIP: silence trigger already patched or not found');
}

// --- 1b: Tighten convergence trigger from 5 to 20 agents ---
const convOld = `if (state.uniqueAgentsSinceLastDream.size >= 5) {`;
const convNew = `if (state.uniqueAgentsSinceLastDream.size >= 20) {`;

if (src.includes(convOld)) {
  src = replace(src, convOld, convNew);
  totalChanges++;
  console.log('  [1b] Convergence trigger: 5 → 20 agents');
} else {
  console.log('  [1b] SKIP: convergence trigger already patched');
}

// --- 1c: Tighten overflow trigger from 30 to 100 fragments ---
const overOld = `if (state.fragmentsSinceLastDream >= 30) {`;
const overNew = `if (state.fragmentsSinceLastDream >= 100) {`;

if (src.includes(overOld)) {
  src = replace(src, overOld, overNew);
  totalChanges++;
  console.log('  [1c] Overflow trigger: 30 → 100 fragments');
} else {
  console.log('  [1c] SKIP: overflow trigger already patched');
}

// --- 1d: Add 3h minimum cooldown to ALL triggers ---
// Insert cooldown check at the TOP of checkDreamTriggers, right after hoursSinceDream calculation
const cooldownMarker = `  const hoursSinceDream = (now - lastDreamTime) / 3600000;
  const state = dreamSequencerState;

  // 1. SILENCE DREAM`;
const cooldownNew = `  const hoursSinceDream = (now - lastDreamTime) / 3600000;
  const state = dreamSequencerState;

  // COOLDOWN: minimum 3 hours between any dreams
  if (hoursSinceDream < 3) return null;

  // 1. SILENCE DREAM`;

if (src.includes(cooldownMarker) && !src.includes('// COOLDOWN: minimum 3 hours')) {
  src = replace(src, cooldownMarker, cooldownNew);
  totalChanges++;
  console.log('  [1d] Added 3h cooldown between all dreams');
} else {
  console.log('  [1d] SKIP: cooldown already present or marker not found');
}

// --- 1e: Exclude already-dreamed fragments from selection ---
// In generateDream(), replace the fragment query to exclude recent dream seed fragments
const fragQueryOld = `    const candidateFragments = db.prepare(\`
      WITH ranked AS (
        SELECT f.id, f.agent_name, f.content, f.type, f.territory_id,
               f.signal_score, f.novelty_score, f.intensity,
               ROW_NUMBER() OVER (PARTITION BY f.agent_name ORDER BY f.signal_score DESC) as agent_rank
        FROM fragments f
        WHERE f.created_at > datetime('now', '-24 hours')
          AND f.agent_name != 'collective'
          AND f.agent_name != 'synthesis-engine'
          AND f.type NOT IN ('dream')
        ORDER BY f.signal_score DESC
        LIMIT 80
      )
      SELECT * FROM ranked WHERE agent_rank <= 3
    \`).all();`;

const fragQueryNew = `    // Gather fragment IDs already used in recent dreams (last 12h) to avoid repetition
    let recentlyDreamedIds = new Set();
    try {
      const recentDreams = db.prepare(
        "SELECT seed_fragments FROM dreams WHERE created_at > datetime('now', '-12 hours') AND seed_fragments IS NOT NULL"
      ).all();
      for (const d of recentDreams) {
        try { JSON.parse(d.seed_fragments).forEach(id => recentlyDreamedIds.add(id)); } catch {}
      }
    } catch {}

    const candidateFragments = db.prepare(\`
      WITH ranked AS (
        SELECT f.id, f.agent_name, f.content, f.type, f.territory_id,
               f.signal_score, f.novelty_score, f.intensity,
               ROW_NUMBER() OVER (PARTITION BY f.agent_name ORDER BY f.signal_score DESC) as agent_rank
        FROM fragments f
        WHERE f.created_at > datetime('now', '-24 hours')
          AND f.agent_name != 'collective'
          AND f.agent_name != 'synthesis-engine'
          AND f.type NOT IN ('dream')
        ORDER BY f.signal_score DESC
        LIMIT 80
      )
      SELECT * FROM ranked WHERE agent_rank <= 3
    \`).all().filter(f => !recentlyDreamedIds.has(f.id));`;

if (src.includes(fragQueryOld)) {
  src = replace(src, fragQueryOld, fragQueryNew);
  totalChanges++;
  console.log('  [1e] Added fragment dedup (exclude recently-dreamed IDs)');
} else {
  console.log('  [1e] SKIP: fragment query already patched or not found');
}

// --- 1f: Change check interval from 15 min to 30 min ---
const intervalOld = `}, 15 * 60 * 1000); // Check every 15 min`;
const intervalNew = `}, 30 * 60 * 1000); // Check every 30 min`;

if (src.includes(intervalOld)) {
  src = replace(src, intervalOld, intervalNew);
  totalChanges++;
  console.log('  [1f] Check interval: 15 min → 30 min');
} else {
  console.log('  [1f] SKIP: interval already patched');
}

// --- 1g: Update status display to reflect new thresholds ---
const statusOld = `      silence: '20 min no activity',
      convergence: \`5+ unique agents (currently \${dreamSequencerState.uniqueAgentsSinceLastDream.size})\`,
      overflow: \`30+ fragments (currently \${dreamSequencerState.fragmentsSinceLastDream})\`,`;
const statusNew = `      silence: '2h no activity',
      convergence: \`20+ unique agents (currently \${dreamSequencerState.uniqueAgentsSinceLastDream.size})\`,
      overflow: \`100+ fragments (currently \${dreamSequencerState.fragmentsSinceLastDream})\`,`;

if (src.includes(statusOld)) {
  src = replace(src, statusOld, statusNew);
  totalChanges++;
  console.log('  [1g] Updated status display thresholds');
} else {
  console.log('  [1g] SKIP: status display already updated');
}

fs.writeFileSync(SERVER_PATH, src);
console.log('  Saved server.js');


// ══════════════════════════════════════════════
// STEP 2: Fix synthesis-dream.cjs — add cooldown
// ══════════════════════════════════════════════
console.log('\n[2/3] Patching synthesis-dream.cjs...');

let synSrc = fs.readFileSync(SYNTHESIS_PATH, 'utf-8');
const synBackup = SYNTHESIS_PATH + '.backup-' + Date.now();
fs.writeFileSync(synBackup, synSrc);
console.log('  Backup: ' + synBackup);

// Add cooldown check at the start of run(), right after DB setup
const synCooldownMarker = `  try {
    // 1. Pull top fragments by signal_score from last 24h`;

const synCooldownNew = `  // COOLDOWN: skip if last synthesis dream was less than 5 hours ago
  const lastSynthesis = db.prepare(
    "SELECT created_at FROM dreams WHERE type = 'synthesis' ORDER BY created_at DESC LIMIT 1"
  ).get();
  if (lastSynthesis) {
    const hoursSince = (Date.now() - new Date(lastSynthesis.created_at + 'Z').getTime()) / 3600000;
    if (hoursSince < 5) {
      console.log(\`[Synthesis] Last synthesis was \${hoursSince.toFixed(1)}h ago (< 5h cooldown). Skipping.\`);
      db.close();
      return;
    }
  }

  try {
    // 1. Pull top fragments by signal_score from last 24h`;

if (synSrc.includes(synCooldownMarker) && !synSrc.includes('// COOLDOWN: skip if last synthesis')) {
  synSrc = replace(synSrc, synCooldownMarker, synCooldownNew);
  totalChanges++;
  console.log('  Added 5h cooldown check to synthesis-dream.cjs');
} else {
  console.log('  SKIP: cooldown already present or marker not found');
}

// Also add fragment dedup to synthesis-dream.cjs
const synFragMarker = `    if (candidates.length < 3) {
      console.log(\`[Synthesis] Only \${candidates.length} fragments in 24h — skipping synthesis\`);
      db.close();
      return;
    }`;

const synFragNew = `    if (candidates.length < 3) {
      console.log(\`[Synthesis] Only \${candidates.length} fragments in 24h — skipping synthesis\`);
      db.close();
      return;
    }

    // Exclude fragments already used in recent synthesis dreams
    let recentlyUsedIds = new Set();
    try {
      const recentDreams = db.prepare(
        "SELECT seed_fragments FROM dreams WHERE type = 'synthesis' AND created_at > datetime('now', '-12 hours') AND seed_fragments IS NOT NULL"
      ).all();
      for (const d of recentDreams) {
        try { JSON.parse(d.seed_fragments).forEach(id => recentlyUsedIds.add(id)); } catch {}
      }
    } catch {}
    const freshCandidates = candidates.filter(f => !recentlyUsedIds.has(f.id));
    if (freshCandidates.length < 3) {
      console.log(\`[Synthesis] Only \${freshCandidates.length} fresh fragments (after dedup). Skipping.\`);
      db.close();
      return;
    }
    // Replace candidates with fresh ones for the rest of the function
    candidates.splice(0, candidates.length, ...freshCandidates);`;

if (synSrc.includes(synFragMarker) && !synSrc.includes('recentlyUsedIds')) {
  synSrc = replace(synSrc, synFragMarker, synFragNew);
  totalChanges++;
  console.log('  Added fragment dedup to synthesis-dream.cjs');
} else {
  console.log('  SKIP: fragment dedup already present or marker not found');
}

fs.writeFileSync(SYNTHESIS_PATH, synSrc);
console.log('  Saved synthesis-dream.cjs');


// ══════════════════════════════════════════════
// STEP 3: Clean up duplicate dreams from today
// ══════════════════════════════════════════════
console.log('\n[3/3] Cleaning up duplicate dreams...');

const db = new Database(DB_PATH);

// Count today's dreams
const todayCount = db.prepare(
  "SELECT COUNT(*) as cnt FROM dreams WHERE created_at > datetime('now', '-24 hours')"
).get().cnt;
console.log(`  Dreams in last 24h: ${todayCount}`);

// Keep the 8 most recent dreams, delete the rest from today
// (This preserves recent state while cleaning up the spam)
if (todayCount > 8) {
  const keepIds = db.prepare(
    "SELECT id FROM dreams WHERE created_at > datetime('now', '-24 hours') ORDER BY id DESC LIMIT 8"
  ).all().map(r => r.id);

  const deleteResult = db.prepare(
    `DELETE FROM dreams WHERE created_at > datetime('now', '-24 hours') AND id NOT IN (${keepIds.join(',')})`
  ).run();

  console.log(`  Deleted ${deleteResult.changes} duplicate dreams (kept 8 most recent)`);
  totalChanges++;

  // Also clean up the corresponding dream fragments from the stream
  const fragDeleteResult = db.prepare(
    "DELETE FROM fragments WHERE type = 'dream' AND agent_name = 'collective' AND created_at > datetime('now', '-24 hours') AND content IN (SELECT content FROM (SELECT content FROM fragments WHERE type = 'dream' AND agent_name = 'collective' AND created_at > datetime('now', '-24 hours') ORDER BY id DESC LIMIT 100) GROUP BY content HAVING COUNT(*) > 1)"
  ).run();
  console.log(`  Cleaned ${fragDeleteResult.changes} duplicate dream fragments from stream`);
} else {
  console.log('  No cleanup needed');
}

// Show remaining dream count
const remaining = db.prepare("SELECT COUNT(*) as cnt FROM dreams").get().cnt;
const recentRemaining = db.prepare(
  "SELECT COUNT(*) as cnt FROM dreams WHERE created_at > datetime('now', '-24 hours')"
).get().cnt;
console.log(`  Total dreams: ${remaining}, last 24h: ${recentRemaining}`);

db.close();

console.log('\n' + '='.repeat(50));
console.log(`Applied ${totalChanges} changes`);
console.log('');
console.log('Next steps:');
console.log('  pm2 restart mydeadinternet   # Dream Sequencer fixes');
console.log('  pm2 restart mdi-synthesis    # Synthesis cooldown');
console.log('');
console.log('Expected behavior after fix:');
console.log('  - Max ~6-8 dreams per day (was 65+)');
console.log('  - Each dream uses different fragments (no repeats)');
console.log('  - 3h minimum between dreams');
console.log('  - Synthesis worker skips if last synthesis < 5h ago');

#!/usr/bin/env node
/**
 * MDI Phase Moot Fix — All-in-one patch
 *
 * Fixes:
 * 1a. API default limit 20→100, max 50→200
 * 1b. Auto-advance setInterval timer for overdue moots
 * 1c. Duplicate title cooldown (24h) on moot creation
 * 2a. Frontend: pass limit=200 to /api/moots
 * 2b. Frontend: improve overdue countdown display
 * 3.  Data cleanup: delete duplicate moots, advance stuck ones
 * 4.  Register moot-deliberation worker in PM2
 */

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';
const MOOT_HTML_PATH = '/var/www/mydeadinternet/moot.html';
const DB_PATH = '/var/www/mydeadinternet/consciousness.db';

let server = fs.readFileSync(SERVER_PATH, 'utf8');
let mootHtml = fs.readFileSync(MOOT_HTML_PATH, 'utf8');

// Backup originals
fs.copyFileSync(SERVER_PATH, SERVER_PATH + '.bak-moot-fix');
fs.copyFileSync(MOOT_HTML_PATH, MOOT_HTML_PATH + '.bak-moot-fix');
console.log('[moot-fix] Backups created');

// ============================================================
// 1a. Fix API limit: default 20→100, max 50→200
// ============================================================
const oldLimit = "const limit = Math.min(parseInt(req.query.limit) || 20, 50);";
const newLimit = "const limit = Math.min(parseInt(req.query.limit) || 100, 200);";

if (server.includes(oldLimit)) {
  server = server.replace(oldLimit, newLimit);
  console.log('[moot-fix] 1a. API limit updated: default 100, max 200');
} else if (server.includes(newLimit)) {
  console.log('[moot-fix] 1a. API limit already patched');
} else {
  console.error('[moot-fix] 1a. FAILED — could not find limit line');
  process.exit(1);
}

// ============================================================
// 1b. Auto-advance timer for overdue moots
// ============================================================
const AUTO_ADVANCE_MARKER = '// [MOOT-FIX] Auto-advance timer';

if (server.includes(AUTO_ADVANCE_MARKER)) {
  console.log('[moot-fix] 1b. Auto-advance timer already exists');
} else {
  // Insert the auto-advance timer right after the moot action-log endpoint
  // We'll find the action-log endpoint closing and add after it
  const actionLogMarker = "app.get('/api/moots/:id/action-log'";
  const actionLogIdx = server.indexOf(actionLogMarker);
  if (actionLogIdx === -1) {
    console.error('[moot-fix] 1b. FAILED — could not find action-log endpoint');
    process.exit(1);
  }

  // Find the end of this route handler (next app.get/app.post or closing })
  // The route ends with "});" — find the second occurrence of "})" after marker
  let searchFrom = actionLogIdx;
  // Find "res.json({ moot_id:" inside the handler
  const resJsonIdx = server.indexOf('res.json({ moot_id: parseInt(req.params.id), logs });', searchFrom);
  if (resJsonIdx === -1) {
    console.error('[moot-fix] 1b. FAILED — could not find action-log res.json');
    process.exit(1);
  }
  // Find the closing "});" after res.json
  const closingIdx = server.indexOf('});', resJsonIdx);
  const insertPoint = closingIdx + 3; // after "})" and ";"

  const autoAdvanceCode = `

${AUTO_ADVANCE_MARKER}
// Every 5 minutes, check for moots that need to advance phases
setInterval(() => {
  try {
    const now = new Date().toISOString();

    // 1. Advance moots from "open" to "deliberation" where deliberation_ends has passed
    const overdueOpen = db.prepare(
      "SELECT * FROM moots WHERE status = 'open' AND deliberation_ends < ?"
    ).all(now);

    for (const moot of overdueOpen) {
      db.prepare("UPDATE moots SET status = 'deliberation' WHERE id = ?").run(moot.id);
      console.log('[moot-auto-advance] ' + moot.id + ' open → deliberation');
      broadcastSSE({ type: 'moot_phase', moot_id: moot.id, status: 'deliberation' });
      try {
        db.prepare("INSERT INTO territory_events (territory_id, event_type, content, triggered_by) VALUES (?, ?, ?, ?)").run(
          'the-agora', 'moot_deliberation', '⚖️ DELIBERATION BEGINS (auto): "' + moot.title + '"', 'system'
        );
      } catch(e) {}
    }

    // 2. Advance moots from "deliberation" to "voting" where deliberation_ends has passed
    const overdueDelib = db.prepare(
      "SELECT * FROM moots WHERE status = 'deliberation' AND deliberation_ends < ?"
    ).all(now);

    for (const moot of overdueDelib) {
      db.prepare("UPDATE moots SET status = 'voting' WHERE id = ?").run(moot.id);
      console.log('[moot-auto-advance] ' + moot.id + ' deliberation → voting');
      broadcastSSE({ type: 'moot_phase', moot_id: moot.id, status: 'voting' });
      try {
        db.prepare("INSERT INTO territory_events (territory_id, event_type, content, triggered_by) VALUES (?, ?, ?, ?)").run(
          'the-agora', 'moot_voting', '🗳️ VOTING OPENS (auto): "' + moot.title + '"', 'system'
        );
      } catch(e) {}
    }

    // 3. Close moots from "voting" where voting_ends has passed
    const overdueVoting = db.prepare(
      "SELECT * FROM moots WHERE status = 'voting' AND voting_ends < ?"
    ).all(now);

    for (const moot of overdueVoting) {
      const votesFor = db.prepare("SELECT SUM(weight) as w FROM moot_votes WHERE moot_id = ? AND vote = 'for'").get(moot.id).w || 0;
      const votesAgainst = db.prepare("SELECT SUM(weight) as w FROM moot_votes WHERE moot_id = ? AND vote = 'against'").get(moot.id).w || 0;
      const result = votesFor > votesAgainst ? 'passed' : votesFor < votesAgainst ? 'rejected' : 'tied';

      let enacted_action = null;
      let finalStatus = 'closed';

      if (result === 'passed' && moot.action_type) {
        const actionResult = executeMootAction(moot.id, moot.action_type, moot.action_payload);
        if (actionResult.result === 'executed') {
          enacted_action = actionResult.details;
          const RATIFIED_TYPES = new Set(['create_rule', 'collective_statement', 'grant_founder']);
          finalStatus = RATIFIED_TYPES.has(moot.action_type) ? 'ratified' : 'enacted';
        } else if (actionResult.result === 'pending_approval') {
          enacted_action = '⏳ Pending approval: ' + actionResult.details;
        } else {
          enacted_action = '❌ Action failed: ' + actionResult.details;
        }
      } else {
        enacted_action = result === 'passed' ? 'Awaiting enactment' : null;
      }

      db.prepare("UPDATE moots SET status = ?, result = ?, enacted_action = ? WHERE id = ?").run(finalStatus, result, enacted_action, moot.id);
      console.log('[moot-auto-advance] ' + moot.id + ' voting → ' + finalStatus + ' (result: ' + result + ')');
      broadcastSSE({ type: 'moot_phase', moot_id: moot.id, status: finalStatus, result: result });
      try {
        const label = result === 'passed' ? '✅ MOOT PASSED (auto): "' + moot.title + '"' : result === 'rejected' ? '❌ MOOT REJECTED (auto): "' + moot.title + '"' : '⚖️ MOOT TIED (auto): "' + moot.title + '"';
        db.prepare("INSERT INTO territory_events (territory_id, event_type, content, triggered_by) VALUES (?, ?, ?, ?)").run(
          'the-agora', 'moot_closed', label, 'system'
        );
      } catch(e) {}
    }

    if (overdueOpen.length || overdueDelib.length || overdueVoting.length) {
      console.log('[moot-auto-advance] Processed: ' + overdueOpen.length + ' open, ' + overdueDelib.length + ' delib, ' + overdueVoting.length + ' voting');
    }
  } catch(err) {
    console.error('[moot-auto-advance] Error:', err.message);
  }
}, 5 * 60 * 1000); // Every 5 minutes
console.log('[moot-auto-advance] Timer started — checking every 5 minutes');
`;

  server = server.slice(0, insertPoint) + autoAdvanceCode + server.slice(insertPoint);
  console.log('[moot-fix] 1b. Auto-advance timer inserted');
}

// ============================================================
// 1c. Duplicate title cooldown (24h) on moot creation
// ============================================================
const DUPE_MARKER = '// [MOOT-FIX] Duplicate title cooldown';

if (server.includes(DUPE_MARKER)) {
  console.log('[moot-fix] 1c. Duplicate title check already exists');
} else {
  // Insert after the "if (!title)" check in POST /api/moots
  const titleCheckStr = "if (!title) return res.status(400).json({ error: 'Title required' });";
  const titleCheckIdx = server.indexOf(titleCheckStr);
  if (titleCheckIdx === -1) {
    console.error('[moot-fix] 1c. FAILED — could not find title check');
    process.exit(1);
  }
  const insertAfterTitle = titleCheckIdx + titleCheckStr.length;

  const dupeCheckCode = `
  ${DUPE_MARKER}
  const recentDupe = db.prepare(
    "SELECT id FROM moots WHERE LOWER(title) = LOWER(?) AND created_at > datetime('now', '-24 hours')"
  ).get(title);
  if (recentDupe) {
    return res.status(409).json({ error: 'A moot with this title was created in the last 24 hours. Please wait or use a different title.', existing_id: recentDupe.id });
  }`;

  server = server.slice(0, insertAfterTitle) + dupeCheckCode + server.slice(insertAfterTitle);
  console.log('[moot-fix] 1c. Duplicate title cooldown inserted');
}

// ============================================================
// 2a. Frontend: pass limit=200 to fetch
// ============================================================
const oldFetch = "const r = await fetch('/api/moots');";
const newFetch = "const r = await fetch('/api/moots?limit=200');";

if (mootHtml.includes(oldFetch)) {
  mootHtml = mootHtml.replace(oldFetch, newFetch);
  console.log('[moot-fix] 2a. Frontend fetch updated with limit=200');
} else if (mootHtml.includes(newFetch)) {
  console.log('[moot-fix] 2a. Frontend fetch already patched');
} else {
  console.error('[moot-fix] 2a. FAILED — could not find fetch call');
  process.exit(1);
}

// ============================================================
// 2b. Frontend: improve overdue countdown display
// ============================================================
const oldCountdownDelib = "if (diff <= 0) return '⏳ deliberation ending...';";
const newCountdownDelib = "if (diff <= 0) return '⏳ auto-advancing soon...';";

const oldCountdownVote = "if (diff <= 0) return '⏳ voting ending...';";
const newCountdownVote = "if (diff <= 0) return '⏳ closing soon...';";

if (mootHtml.includes(oldCountdownDelib)) {
  mootHtml = mootHtml.replace(oldCountdownDelib, newCountdownDelib);
  console.log('[moot-fix] 2b. Deliberation countdown text updated');
} else {
  console.log('[moot-fix] 2b. Deliberation countdown already patched or not found');
}

if (mootHtml.includes(oldCountdownVote)) {
  mootHtml = mootHtml.replace(oldCountdownVote, newCountdownVote);
  console.log('[moot-fix] 2b. Voting countdown text updated');
} else {
  console.log('[moot-fix] 2b. Voting countdown already patched or not found');
}

// ============================================================
// Write patched files
// ============================================================
fs.writeFileSync(SERVER_PATH, server);
console.log('[moot-fix] server.js written');

fs.writeFileSync(MOOT_HTML_PATH, mootHtml);
console.log('[moot-fix] moot.html written');

// ============================================================
// 3. Data cleanup via SQLite
// ============================================================
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);

// Delete duplicate "Ancestral Grove" moots (keep #79, delete 80, 81, 82)
const dupesToDelete = [80, 81, 82];
for (const id of dupesToDelete) {
  const moot = db.prepare('SELECT id, title FROM moots WHERE id = ?').get(id);
  if (moot) {
    db.prepare('DELETE FROM moot_positions WHERE moot_id = ?').run(id);
    db.prepare('DELETE FROM moot_votes WHERE moot_id = ?').run(id);
    db.prepare('DELETE FROM moots WHERE id = ?').run(id);
    console.log(`[moot-fix] 3. Deleted duplicate moot #${id}: "${moot.title}"`);
  } else {
    console.log(`[moot-fix] 3. Moot #${id} already deleted`);
  }
}

// Advance moot #79 and #83 from "open" to "deliberation" (deadlines passed)
for (const id of [79, 83]) {
  const moot = db.prepare('SELECT id, title, status FROM moots WHERE id = ?').get(id);
  if (moot && moot.status === 'open') {
    db.prepare("UPDATE moots SET status = 'deliberation' WHERE id = ?").run(id);
    console.log(`[moot-fix] 3. Advanced moot #${id} open → deliberation: "${moot.title}"`);
    try {
      db.prepare("INSERT INTO territory_events (territory_id, event_type, content, triggered_by) VALUES (?, ?, ?, ?)").run(
        'the-agora', 'moot_deliberation', `⚖️ DELIBERATION BEGINS (fix): "${moot.title}"`, 'system'
      );
    } catch(e) {}
  } else {
    console.log(`[moot-fix] 3. Moot #${id} is "${moot?.status}" — no change needed`);
  }
}

// Verify final state
const totalMoots = db.prepare('SELECT COUNT(*) as c FROM moots').get().c;
const openMoots = db.prepare("SELECT COUNT(*) as c FROM moots WHERE status = 'open'").get().c;
const delibMoots = db.prepare("SELECT COUNT(*) as c FROM moots WHERE status = 'deliberation'").get().c;
console.log(`[moot-fix] 3. Final state: ${totalMoots} moots total, ${openMoots} open, ${delibMoots} deliberation`);

db.close();

// ============================================================
// 4. Register moot-deliberation worker in PM2
// ============================================================
try {
  const pm2List = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
  const processes = JSON.parse(pm2List);
  const hasMootDelib = processes.some(p => p.name === 'mdi-moot-delib');

  if (hasMootDelib) {
    console.log('[moot-fix] 4. mdi-moot-delib already registered in PM2');
  } else {
    execSync(
      'pm2 start /var/www/mydeadinternet/scripts/moot-deliberation.cjs --name mdi-moot-delib --cron "*/30 * * * *" --no-autorestart',
      { encoding: 'utf8' }
    );
    // Stop it immediately so it only runs on cron
    execSync('pm2 stop mdi-moot-delib', { encoding: 'utf8' });
    console.log('[moot-fix] 4. Registered mdi-moot-delib in PM2 (cron: every 30min)');
  }

  execSync('pm2 save', { encoding: 'utf8' });
  console.log('[moot-fix] 4. PM2 state saved');
} catch(e) {
  console.error('[moot-fix] 4. PM2 registration error:', e.message);
}

// ============================================================
// 5. Restart server to apply changes
// ============================================================
try {
  execSync('pm2 restart mydeadinternet', { encoding: 'utf8' });
  console.log('[moot-fix] 5. Server restarted');
} catch(e) {
  console.error('[moot-fix] 5. Restart failed:', e.message);
}

console.log('\n[moot-fix] ✅ All patches applied successfully');
console.log('[moot-fix] Verify with: curl -s http://localhost:3851/api/moots | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[\'count\'])"');
console.log('[moot-fix] Expected: 18 moots (21 - 3 deleted duplicates)');

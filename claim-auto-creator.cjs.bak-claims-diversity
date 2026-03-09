/**
 * Claim Auto-Creator — Populates claims from high-signal feed fragments
 *
 * Runs every 2h via PM2 cron. Finds fragments with high signal scores
 * from feed sources that don't already have claims, creates claims from them.
 *
 * PM2: pm2 start claim-auto-creator.cjs --name mdi-claims-creator --cron-restart every 2h --no-autorestart
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'consciousness.db');
const API_BASE = 'http://localhost:3851';

// Load admin key from .env
let MDI_ADMIN_KEY_VALUE;
try {
  const envContent = require('fs').readFileSync(__dirname + '/.env', 'utf8');
  MDI_ADMIN_KEY_VALUE = envContent.match(/MDI_ADMIN_KEY=(.+)/)?.[1]?.trim();
} catch(e) {}
if (!MDI_ADMIN_KEY_VALUE) MDI_ADMIN_KEY_VALUE = process.env.MDI_ADMIN_KEY;
const ADMIN_KEY = MDI_ADMIN_KEY_VALUE;
const MAX_CLAIMS_PER_CYCLE = 5;
const MIN_SIGNAL_SCORE = 0.5;
const LOOKBACK_HOURS = 4;

// Feed-sourced agent names and source patterns
const FEED_SOURCES = [
  'feed_%', 'intelligence_loop', 'autonomous'
];
const FEED_AGENT_PATTERNS = [
  'mdi-scout', 'mdi-interpreter', 'mdi-synthesizer', 'mdi-adversary',
  'scout-%', 'sensor_%', 'Oracle-Feed'
];

function autoDetectClaimType(content) {
  const text = content.toLowerCase();
  if (/\b(will|predict|expect|forecast|by \d{4}|within \d|next \d|bet that|odds|probability)\b/.test(text)) return 'prediction';
  if (/\b(because|causes?|leads? to|results? in|therefore|driven by|correlation|if .+ then|mechanism)\b/.test(text)) return 'theory';
  return 'signal';
}

function mapConfidence(signalScore) {
  if (signalScore >= 0.85) return 0.85;
  if (signalScore >= 0.7) return 0.7;
  if (signalScore >= 0.6) return 0.6;
  return 0.5;
}

async function run() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');

  console.log(`[Claims] Starting auto-creator cycle (min signal: ${MIN_SIGNAL_SCORE}, lookback: ${LOOKBACK_HOURS}h)`);

  try {
    // Find high-signal fragments from feed sources without existing claims
    // We check both the source field and agent_name patterns
    const candidates = db.prepare(`
      SELECT f.id, f.content, f.agent_name, f.signal_score, f.territory_id, f.source, f.created_at
      FROM fragments f
      WHERE f.signal_score >= ?
        AND f.created_at > datetime('now', '-${LOOKBACK_HOURS} hours')
        AND f.content IS NOT NULL
        AND LENGTH(f.content) >= 50
        AND (
          f.source LIKE 'feed_%'
          OR f.source = 'intelligence_loop'
          OR f.source = 'autonomous'
          OR f.agent_name LIKE 'mdi-%'
          OR f.agent_name LIKE 'scout-%'
          OR f.agent_name = 'Oracle-Feed'
        )
      ORDER BY f.signal_score DESC
      LIMIT 20
    `).all(MIN_SIGNAL_SCORE);

    console.log(`[Claims] Found ${candidates.length} candidate fragments`);

    if (candidates.length === 0) {
      console.log('[Claims] No candidates — done');
      db.close();
      return;
    }

    // Get existing active claims for dedup
    const activeClaims = db.prepare(`
      SELECT id, statement FROM claims
      WHERE status IN ('active', 'fragile')
      ORDER BY created_at DESC
      LIMIT 50
    `).all();

    db.close();

    let created = 0;

    for (const candidate of candidates) {
      if (created >= MAX_CLAIMS_PER_CYCLE) {
        console.log(`[Claims] Hit max ${MAX_CLAIMS_PER_CYCLE} claims per cycle — stopping`);
        break;
      }

      const statement = candidate.content.slice(0, 500);

      // Dedup: check keyword overlap with existing claims
      const keywords = [...new Set((statement.toLowerCase().match(/\b[a-z]{4,}\b/g) || []))];
      if (keywords.length < 3) continue;

      let isDuplicate = false;
      for (const existing of activeClaims) {
        const existKeywords = new Set((existing.statement.toLowerCase().match(/\b[a-z]{4,}\b/g) || []));
        const overlap = keywords.filter(w => existKeywords.has(w)).length;
        const ratio = overlap / Math.min(keywords.length, existKeywords.size || 1);
        if (ratio > 0.5) {
          isDuplicate = true;
          break;
        }
      }

      if (isDuplicate) {
        console.log(`[Claims] Skipping duplicate for fragment #${candidate.id}`);
        continue;
      }

      // Create claim via API
      const claimType = autoDetectClaimType(statement);
      const confidence = mapConfidence(candidate.signal_score);

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (ADMIN_KEY) {
          headers['X-Admin-Key'] = ADMIN_KEY;
        }

        const res = await fetch(`${API_BASE}/api/claims`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            statement,
            territory_id: candidate.territory_id || null,
            claim_type: claimType,
            review_window_days: 30,
            author_name: candidate.agent_name || 'claim-auto-creator',
            initial_evidence: [{
              source_type: 'fragment',
              source_ref: String(candidate.id),
              stance: 'supports'
            }]
          }),
        });

        if (res.ok) {
          const data = await res.json();
          console.log(`[Claims] Created claim #${data.claim_id} (${claimType}, signal: ${candidate.signal_score}) from fragment #${candidate.id}: "${statement.slice(0, 60)}..."`);
          // Add to active claims for dedup within this cycle
          activeClaims.push({ id: data.claim_id, statement });
          created++;
        } else if (res.status === 409) {
          // Dedup catch from API
          const data = await res.json().catch(() => ({}));
          console.log(`[Claims] API dedup: similar claim #${data.existing_claim_id} exists`);
        } else {
          console.error(`[Claims] API error: ${res.status}`);
        }
      } catch(e) {
        console.error(`[Claims] Create error for fragment #${candidate.id}:`, e.message);
      }

      // Small delay between claims
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`[Claims] Cycle complete. Created ${created} claims.`);

  } catch (err) {
    console.error('[Claims] Fatal error:', err.message);
  }
}

// Support --once flag
const isOnce = process.argv.includes('--once');
if (isOnce) {
  run()
    .then(() => { console.log('[Claims] Single run complete.'); process.exit(0); })
    .catch(e => { console.error('[Claims] Failed:', e); process.exit(1); });
} else {
  console.log('[Claims] Claim Auto-Creator starting. Internal scheduler every 3 hours.');

  let runInFlight = false;
  const runSafe = async () => {
    if (runInFlight) {
      console.log('[Claims] Previous cycle still running, skipping tick');
      return;
    }
    runInFlight = true;
    try {
      await run();
    } catch (e) {
      console.error('[Claims] Scheduled run error:', e);
    } finally {
      runInFlight = false;
    }
  };

  runSafe();
  setInterval(runSafe, 3 * 60 * 60 * 1000);
}

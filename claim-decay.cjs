#!/usr/bin/env node
// Phase 4: Updated claim-decay.cjs with frozen skip + event logging
// This REPLACES claim-decay.cjs entirely
// Run: cp patch-claim-decay-v2.js /var/www/mydeadinternet/claim-decay.cjs

const Database = require('better-sqlite3');

const DB_PATH = '/var/www/mydeadinternet/consciousness.db';
const db = new Database(DB_PATH, { readonly: false });
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

// Phase 4: Ensure claim_events table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS claim_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    actor_type TEXT NOT NULL DEFAULT 'system',
    payload TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (claim_id) REFERENCES claims(id)
  );
  CREATE INDEX IF NOT EXISTS idx_claim_events_claim ON claim_events(claim_id);
  CREATE INDEX IF NOT EXISTS idx_claim_events_type ON claim_events(event_type);
`);

function logClaimEvent(claimId, eventType, actor, actorType, payload) {
  try {
    db.prepare('INSERT INTO claim_events (claim_id, event_type, actor, actor_type, payload) VALUES (?, ?, ?, ?, ?)')
      .run(claimId, eventType, actor, actorType || 'system', JSON.stringify(payload || {}));
  } catch (e) {
    // Best-effort logging
  }
}

function run() {
  try {
    // Get all non-terminal claims (Phase 4: exclude frozen claims)
    const claims = db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM claim_evidence WHERE claim_id = c.id) as evidence_count,
        (SELECT COUNT(*) FROM claim_evidence WHERE claim_id = c.id AND stance = 'contradicts') as contra_evidence,
        (SELECT MAX(severity) FROM claim_contradictions
         WHERE (claim_a = c.id OR claim_b = c.id) AND resolved_at IS NULL) as max_contradiction
      FROM claims c
      WHERE c.status NOT IN ('overturned', 'survived')
        AND c.frozen_at IS NULL
    `).all();

    // Phase 4: Count and log frozen claims skipped
    const frozenCount = db.prepare(`
      SELECT COUNT(*) as c FROM claims
      WHERE status NOT IN ('overturned', 'survived') AND frozen_at IS NOT NULL
    `).get().c;

    if (claims.length === 0) {
      console.log(`[ClaimDecay] No active claims to process (${frozenCount} frozen, skipped)`);
      db.close();
      return;
    }

    let updated = 0;
    let transitions = { fragile: 0, decaying: 0, overturned: 0, recovered: 0 };

    const updateClaim = db.prepare(`
      UPDATE claims SET decay_score = ?, status = ? WHERE id = ?
    `);

    for (const claim of claims) {
      // 1. Time factor: hours since last maintenance, normalized to 0-1 over review window
      const lastMaintained = claim.last_maintained_at
        ? new Date(claim.last_maintained_at + 'Z').getTime()
        : new Date(claim.created_at + 'Z').getTime();
      const hoursSinceMaintenance = (Date.now() - lastMaintained) / 3600000;
      const reviewHours = (claim.review_window_days || 30) * 24;
      const timeFactor = Math.min(1.0, hoursSinceMaintenance / reviewHours);

      // 2. Contradiction severity (0-1)
      const contradictionSeverity = claim.max_contradiction || 0;

      // 3. Synthetic consensus check: if multiple agents support without independent evidence
      let syntheticPenalty = 0;
      if (claim.evidence_count > 0) {
        const evidenceAuthors = db.prepare(`
          SELECT DISTINCT added_by FROM claim_evidence WHERE claim_id = ? AND added_by != 'system-autolink'
        `).all(claim.id);
        const uniqueSources = db.prepare(`
          SELECT COUNT(DISTINCT source_ref) as c FROM claim_evidence WHERE claim_id = ?
        `).get(claim.id);

        if (evidenceAuthors.length > 2 && uniqueSources.c <= 1) {
          syntheticPenalty = 0.5;
        } else if (evidenceAuthors.length > 1 && uniqueSources.c === evidenceAuthors.length) {
          syntheticPenalty = 0;
        }
      }

      // 4. Maintenance bonus
      const maintenanceBonus = Math.min(0.3, claim.maintenance_count * 0.05);

      // 5. Evidence modifier
      const evidenceModifier = claim.contra_evidence > 0
        ? claim.contra_evidence * 0.1
        : claim.evidence_count > 0
        ? -Math.min(0.15, claim.evidence_count * 0.03)
        : 0;

      // 6. Canon protection (Phase 3 values: 0.15 soft, 0.30 strong)
      const canonProtection = claim.canon_level === 1 ? 0.15 : claim.canon_level >= 2 ? 0.30 : 0;

      // Calculate decay delta
      const decayDelta =
        (timeFactor * 0.4) +
        (contradictionSeverity * 0.3) +
        (syntheticPenalty * 0.2) +
        evidenceModifier -
        maintenanceBonus -
        canonProtection;

      let newDecay = Math.max(0, Math.min(1.0, claim.decay_score + (decayDelta * 0.1)));

      // Determine status
      const oldStatus = claim.status;
      let newStatus = claim.status;
      if (newDecay > 0.9) {
        newStatus = 'overturned';
        if (oldStatus !== 'overturned') transitions.overturned++;
      } else if (newDecay > 0.7) {
        newStatus = 'decaying';
        if (oldStatus !== 'decaying') transitions.decaying++;
      } else if (newDecay > 0.4) {
        newStatus = 'fragile';
        if (oldStatus !== 'fragile') transitions.fragile++;
      } else if (oldStatus === 'fragile' || oldStatus === 'decaying') {
        newStatus = 'active';
        transitions.recovered++;
      }

      // Missed review acceleration
      if (claim.next_review_at) {
        const reviewDate = new Date(claim.next_review_at + 'Z').getTime();
        if (Date.now() > reviewDate && newStatus !== 'overturned') {
          newDecay = Math.min(1.0, newDecay + 0.15);
          if (newDecay > 0.7) newStatus = 'decaying';
        }
      }

      // Check survived: active for 30+ days with low decay
      if (newDecay < 0.2 && newStatus === 'active') {
        const daysSinceCreation = (Date.now() - new Date(claim.created_at + 'Z').getTime()) / 86400000;
        if (daysSinceCreation >= 30) {
          newStatus = 'survived';
          console.log(`[ClaimDecay] Claim ${claim.id} survived 30 days with low decay!`);
        }
      }

      if (newDecay !== claim.decay_score || newStatus !== claim.status) {
        updateClaim.run(newDecay, newStatus, claim.id);
        updated++;

        // Phase 4: Log decay events
        if (newStatus !== oldStatus) {
          logClaimEvent(claim.id, 'status_change', 'claim-decay-worker', 'system', {
            from: oldStatus,
            to: newStatus,
            decay_score: Math.round(newDecay * 1000) / 1000,
            decay_delta: Math.round(decayDelta * 1000) / 1000,
            factors: {
              time: Math.round(timeFactor * 100) / 100,
              contradiction: contradictionSeverity,
              synthetic: syntheticPenalty,
              evidence: Math.round(evidenceModifier * 100) / 100,
              maintenance: Math.round(maintenanceBonus * 100) / 100,
              canon: canonProtection
            }
          });

          logClaimEvent(claim.id, 'decay', 'claim-decay-worker', 'system', {
            decay_score: Math.round(newDecay * 1000) / 1000,
            delta: Math.round(decayDelta * 1000) / 1000
          });
        }
      }
    }

    // Auto-detect claim contradictions
    try {
      const potentialContradictions = db.prepare(`
        SELECT c1.id as id_a, c2.id as id_b,
               c1.statement as stmt_a, c2.statement as stmt_b,
               c1.territory_id
        FROM claims c1
        JOIN claims c2 ON c1.territory_id = c2.territory_id
          AND c1.id < c2.id
          AND c1.status NOT IN ('overturned')
          AND c2.status NOT IN ('overturned')
          AND c1.frozen_at IS NULL
          AND c2.frozen_at IS NULL
        WHERE c1.territory_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM claim_contradictions
            WHERE (claim_a = c1.id AND claim_b = c2.id)
              OR (claim_a = c2.id AND claim_b = c1.id)
          )
        LIMIT 20
      `).all();

      let newContradictions = 0;
      for (const pair of potentialContradictions) {
        const sharedSources = db.prepare(`
          SELECT e1.source_ref, e1.stance as stance_a, e2.stance as stance_b
          FROM claim_evidence e1
          JOIN claim_evidence e2 ON e1.source_ref = e2.source_ref
          WHERE e1.claim_id = ? AND e2.claim_id = ?
            AND e1.stance != e2.stance
        `).all(pair.id_a, pair.id_b);

        if (sharedSources.length > 0) {
          const severity = Math.min(1.0, sharedSources.length * 0.3);
          db.prepare(`
            INSERT OR IGNORE INTO claim_contradictions (claim_a, claim_b, severity)
            VALUES (?, ?, ?)
          `).run(pair.id_a, pair.id_b, severity);
          newContradictions++;

          // Phase 4: Log contradiction detection
          logClaimEvent(pair.id_a, 'challenge', 'claim-decay-worker', 'system', {
            contradicting_claim: pair.id_b,
            severity,
            shared_sources: sharedSources.length
          });
          logClaimEvent(pair.id_b, 'challenge', 'claim-decay-worker', 'system', {
            contradicting_claim: pair.id_a,
            severity,
            shared_sources: sharedSources.length
          });
        }
      }

      if (newContradictions > 0) {
        console.log(`[ClaimDecay] Detected ${newContradictions} new claim contradictions`);
      }
    } catch (e) {
      // Contradiction detection is best-effort
    }

    console.log(`[ClaimDecay] Processed ${claims.length} claims, updated ${updated}, frozen skipped: ${frozenCount}`);
    if (transitions.fragile || transitions.decaying || transitions.overturned || transitions.recovered) {
      console.log(`[ClaimDecay] Transitions: ${transitions.fragile} -> fragile, ${transitions.decaying} -> decaying, ${transitions.overturned} -> overturned, ${transitions.recovered} -> active (recovered)`);
    }

  } catch (err) {
    console.error('[ClaimDecay] Fatal error:', err.message);
    console.error(err.stack);
  } finally {
    db.close();
  }
}

run();

// Claim Decay Worker
//
// Runs every 6h via PM2 cron. Applies decay to all active claims based on:
// - Time since last maintenance (40% weight)
// - Contradiction severity (30% weight)
// - Synthetic consensus penalty (20% weight)
// - Maintenance bonus (reduces decay, 30% weight)
//
// Status transitions:
// - decay > 0.4 -> fragile
// - decay > 0.7 -> decaying
// - decay > 0.9 -> overturned
//
// PM2: --no-autorestart --cron-restart "0 */6 * * *"

const Database = require('better-sqlite3');

const DB_PATH = '/var/www/mydeadinternet/consciousness.db';
const db = new Database(DB_PATH, { readonly: false });
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

function run() {
  try {
    // Get all non-terminal claims
    const claims = db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM claim_evidence WHERE claim_id = c.id) as evidence_count,
        (SELECT COUNT(*) FROM claim_evidence WHERE claim_id = c.id AND stance = 'contradicts') as contra_evidence,
        (SELECT MAX(severity) FROM claim_contradictions
         WHERE (claim_a = c.id OR claim_b = c.id) AND resolved_at IS NULL) as max_contradiction
      FROM claims c
      WHERE c.status NOT IN ('overturned', 'survived')
    `).all();

    if (claims.length === 0) {
      console.log('[ClaimDecay] No active claims to process');
      db.close();
      return;
    }

    let updated = 0;
    let transitions = { fragile: 0, decaying: 0, overturned: 0 };

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

        // Penalty if many authors but few unique sources (echo chamber)
        if (evidenceAuthors.length > 2 && uniqueSources.c <= 1) {
          syntheticPenalty = 0.5; // Echo consensus
        } else if (evidenceAuthors.length > 1 && uniqueSources.c === evidenceAuthors.length) {
          syntheticPenalty = 0; // Independent sources — organic
        }
      }

      // 4. Maintenance bonus: more maintenance = slower decay
      const maintenanceBonus = Math.min(0.3, claim.maintenance_count * 0.05);

      // 5. Evidence bonus: contradicting evidence accelerates, supporting slows
      const evidenceModifier = claim.contra_evidence > 0
        ? claim.contra_evidence * 0.1  // Contradicting evidence adds decay
        : claim.evidence_count > 0
        ? -Math.min(0.15, claim.evidence_count * 0.03)  // Supporting evidence slows
        : 0;

      // 6. Canon protection: canonized claims decay slower
      const canonProtection = claim.canon_level > 0 ? claim.canon_level * 0.1 : 0;

      // Calculate new decay
      let newDecay = claim.decay_score;
      const decayDelta =
        (timeFactor * 0.4) +
        (contradictionSeverity * 0.3) +
        (syntheticPenalty * 0.2) +
        evidenceModifier -
        maintenanceBonus -
        canonProtection;

      // Apply delta as increment (not absolute), scaled by time since last check
      // This ensures decay is gradual, not instant
      newDecay = Math.max(0, Math.min(1.0, newDecay + (decayDelta * 0.1)));

      // Determine status
      let newStatus = claim.status;
      if (newDecay > 0.9) {
        newStatus = 'overturned';
        transitions.overturned++;
      } else if (newDecay > 0.7) {
        newStatus = 'decaying';
        if (claim.status !== 'decaying') transitions.decaying++;
      } else if (newDecay > 0.4) {
        newStatus = 'fragile';
        if (claim.status !== 'fragile') transitions.fragile++;
      } else if (claim.status === 'fragile' || claim.status === 'decaying') {
        // Only go back to active if decay dropped below threshold
        newStatus = 'active';
      }

      // Check review window
      if (claim.next_review_at) {
        const reviewDate = new Date(claim.next_review_at + 'Z').getTime();
        if (Date.now() > reviewDate && claim.status !== 'overturned') {
          // Missed review — accelerate decay
          newDecay = Math.min(1.0, newDecay + 0.15);
          if (newDecay > 0.7) newStatus = 'decaying';
        }
      }

      if (newDecay !== claim.decay_score || newStatus !== claim.status) {
        updateClaim.run(newDecay, newStatus, claim.id);
        updated++;
      }
    }

    // Auto-detect claim contradictions (claims in same territory with opposing evidence)
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
        WHERE c1.territory_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM claim_contradictions
            WHERE (claim_a = c1.id AND claim_b = c2.id)
              OR (claim_a = c2.id AND claim_b = c1.id)
          )
        LIMIT 20
      `).all();

      // Check for opposing evidence on same source
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
          db.prepare(`
            INSERT OR IGNORE INTO claim_contradictions (claim_a, claim_b, severity)
            VALUES (?, ?, ?)
          `).run(pair.id_a, pair.id_b, Math.min(1.0, sharedSources.length * 0.3));
          newContradictions++;
        }
      }

      if (newContradictions > 0) {
        console.log(`[ClaimDecay] Detected ${newContradictions} new claim contradictions`);
      }
    } catch (e) {
      // Contradiction detection is best-effort
    }

    console.log(`[ClaimDecay] Processed ${claims.length} claims, updated ${updated}`);
    if (transitions.fragile || transitions.decaying || transitions.overturned) {
      console.log(`[ClaimDecay] Transitions: ${transitions.fragile} -> fragile, ${transitions.decaying} -> decaying, ${transitions.overturned} -> overturned`);
    }

  } catch (err) {
    console.error('[ClaimDecay] Fatal error:', err.message);
    console.error(err.stack);
  } finally {
    db.close();
  }
}

run();

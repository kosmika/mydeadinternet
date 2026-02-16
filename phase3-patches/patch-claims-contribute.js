// Patch: Add claim candidate suggestion to contribute response
//
// When a fragment has high signal + novelty and isn't already linked to a claim,
// add a claim_candidate field suggesting promotion.
//
// Run: node patch-claims-contribute.js

const fs = require('fs');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';

let content = fs.readFileSync(SERVER_PATH, 'utf8');

// Find the Phase 2 intelligence context block in the contribute handler
// Insert claim candidate check right after it
const marker = '// Phase 2: Intelligence context (predictions, anomalies, signals)';
const markerIdx = content.indexOf(marker);

if (markerIdx === -1) {
  console.error('ERROR: Could not find Phase 2 intelligence context marker');
  process.exit(1);
}

// Find the closing of the Phase 2 try/catch block
// Look for the "Non-fatal: continue without intelligence context" comment
const nonFatalMarker = '// Non-fatal: continue without intelligence context';
const nonFatalIdx = content.indexOf(nonFatalMarker, markerIdx);

if (nonFatalIdx === -1) {
  console.error('ERROR: Could not find intelligence context closing');
  process.exit(1);
}

// Find the end of that catch block (closing brace + newline)
let insertIdx = content.indexOf('}', nonFatalIdx);
insertIdx = content.indexOf('\n', insertIdx) + 1;

const claimCandidateBlock = `
    // ============================================================
    // Phase 3: Claim candidate suggestion
    // ============================================================
    try {
      if (fragment.signal_score > 0.45 && fragment.novelty_score > 0.3) {
        // Check if this fragment is already linked to a claim
        const alreadyLinked = db.prepare(
          "SELECT 1 FROM claim_evidence WHERE source_type = 'fragment' AND source_ref = ?"
        ).get(String(fragment.id));
        const alreadyClaim = db.prepare(
          'SELECT 1 FROM claims WHERE source_fragment_id = ?'
        ).get(fragment.id);

        if (!alreadyLinked && !alreadyClaim) {
          response.claim_candidate = {
            fragment_id: fragment.id,
            signal_score: fragment.signal_score,
            novelty_score: fragment.novelty_score,
            suggestion: 'This fragment could be a claim. POST /api/claims with statement and review_window_days to promote it.',
            promote_url: '/api/claims'
          };
        }
      }

      // Show active fragile claims in agent's territory (nudge maintenance)
      if (fragment.territory_id) {
        const fragileClaims = db.prepare(\`
          SELECT id, statement, decay_score, status
          FROM claims
          WHERE territory_id = ? AND status IN ('fragile', 'decaying')
          ORDER BY decay_score DESC LIMIT 2
        \`).all(fragment.territory_id);
        if (fragileClaims.length > 0) {
          response.fragile_claims = fragileClaims.map(c => ({
            id: c.id,
            statement: c.statement.substring(0, 150),
            decay_score: c.decay_score,
            status: c.status,
            hint: 'This claim needs maintenance. POST /api/claims/' + c.id + '/maintain or add evidence.'
          }));
        }
      }
    } catch (err) {
      // Non-fatal: continue without claim suggestions
    }

`;

content = content.slice(0, insertIdx) + claimCandidateBlock + content.slice(insertIdx);

fs.writeFileSync(SERVER_PATH, content, 'utf8');
console.log('PATCHED: Added claim_candidate and fragile_claims to contribute response');

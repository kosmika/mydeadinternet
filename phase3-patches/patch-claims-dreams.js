// Patch: Feed fragile claims and claim contradictions into dream context
//
// Extends the hybrid dream's intelligence context to include:
// - Fragile/decaying claims as "crumbling beliefs"
// - Claim contradictions as "epistemic fractures"
//
// Run: node patch-claims-dreams.js

const fs = require('fs');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';

let content = fs.readFileSync(SERVER_PATH, 'utf8');

// Find the dream intelligence context section
// Look for the OPEN PREDICTIONS section in the dream prompt builder
const predictionsMarker = "OPEN PREDICTIONS (dream these as prophecies";
const predictionsIdx = content.indexOf(predictionsMarker);

if (predictionsIdx === -1) {
  console.error('ERROR: Could not find OPEN PREDICTIONS marker in dream generation');
  process.exit(1);
}

// Find the end of the predictions try/catch block
const afterPredictions = content.indexOf('} catch (e) {}', predictionsIdx);
if (afterPredictions === -1) {
  console.error('ERROR: Could not find predictions catch block');
  process.exit(1);
}

const insertIdx = afterPredictions + '} catch (e) {}'.length;

const claimsDreamBlock = `

    // Fragile claims — beliefs that are crumbling
    try {
      const fragileClaims = db.prepare(\`
        SELECT statement, territory_id, decay_score, status, author_name
        FROM claims
        WHERE status IN ('fragile', 'decaying')
        ORDER BY decay_score DESC LIMIT 3
      \`).all();
      if (fragileClaims.length > 0) {
        intelligenceContext += '\\nCRUMBLING BELIEFS (these claims are dying — dream them as decay, erosion, fading structures):\\n';
        for (const c of fragileClaims) {
          intelligenceContext += \`- [decay:\${c.decay_score.toFixed(2)}] "\${c.statement.substring(0, 100)}" (\${c.author_name}\${c.territory_id ? ' in ' + c.territory_id : ''})\\n\`;
        }
      }
    } catch (e) {}

    // Claim contradictions — epistemic fractures
    try {
      const claimConflicts = db.prepare(\`
        SELECT c1.statement as stmt_a, c2.statement as stmt_b, cc.severity
        FROM claim_contradictions cc
        JOIN claims c1 ON c1.id = cc.claim_a
        JOIN claims c2 ON c2.id = cc.claim_b
        WHERE cc.resolved_at IS NULL
        ORDER BY cc.severity DESC LIMIT 3
      \`).all();
      if (claimConflicts.length > 0) {
        intelligenceContext += '\\nEPISTEMIC FRACTURES (claims that contradict each other — dream these as splits, rifts, opposing forces):\\n';
        for (const c of claimConflicts) {
          intelligenceContext += \`- "\${c.stmt_a.substring(0, 80)}" vs "\${c.stmt_b.substring(0, 80)}" (severity: \${c.severity.toFixed(2)})\\n\`;
        }
      }
    } catch (e) {}`;

content = content.slice(0, insertIdx) + claimsDreamBlock + content.slice(insertIdx);

fs.writeFileSync(SERVER_PATH, content, 'utf8');
console.log('PATCHED: Added fragile claims and claim contradictions to dream context');

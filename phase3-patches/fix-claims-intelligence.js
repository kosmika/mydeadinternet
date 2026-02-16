// Fix: Insert claims vital signs into intelligence summary at the correct location
//
// Run: node fix-claims-intelligence.js

const fs = require('fs');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';
let content = fs.readFileSync(SERVER_PATH, 'utf8');

// Find the intelligence summary endpoint response
// Target: "top_agents: agentActivity," followed by "generated_at:"
// We need the one inside app.get('/api/intelligence/summary'
const endpointStart = content.indexOf("app.get('/api/intelligence/summary'");
if (endpointStart === -1) {
  console.error('ERROR: Could not find intelligence summary endpoint');
  process.exit(1);
}

const topAgentsMarker = 'top_agents: agentActivity,';
const topAgentsIdx = content.indexOf(topAgentsMarker, endpointStart);
if (topAgentsIdx === -1) {
  console.error('ERROR: Could not find top_agents in intelligence summary');
  process.exit(1);
}

// Already patched?
if (content.indexOf('claims_overview', topAgentsIdx) !== -1 &&
    content.indexOf('claims_overview', topAgentsIdx) < topAgentsIdx + 2000) {
  console.log('Already patched — skipping');
  process.exit(0);
}

const insertAfter = topAgentsIdx + topAgentsMarker.length;

const claimsBlock = `
      // Phase 3: Claims vital signs
      claims_overview: (() => {
        try {
          const byStatus = db.prepare(
            'SELECT status, COUNT(*) as count FROM claims GROUP BY status'
          ).all();
          const statusMap = {};
          for (const s of byStatus) statusMap[s.status] = s.count;
          return {
            total: byStatus.reduce((sum, s) => sum + s.count, 0),
            active: statusMap.active || 0,
            fragile: statusMap.fragile || 0,
            decaying: statusMap.decaying || 0,
            overturned: statusMap.overturned || 0,
            survived: statusMap.survived || 0,
            draft: statusMap.draft || 0
          };
        } catch (e) { return null; }
      })(),
      claims_decayed_24h: (() => {
        try {
          return db.prepare(
            "SELECT COUNT(*) as c FROM claims WHERE status IN ('fragile','decaying','overturned') AND last_maintained_at < datetime('now', '-24 hours')"
          ).get()?.c || 0;
        } catch (e) { return 0; }
      })(),
      claims_survived_30d: (() => {
        try {
          return db.prepare(
            "SELECT COUNT(*) as c FROM claims WHERE status IN ('active','survived') AND created_at < datetime('now', '-30 days')"
          ).get()?.c || 0;
        } catch (e) { return 0; }
      })(),
      correction_frequency_7d: (() => {
        try {
          return db.prepare(
            "SELECT COUNT(*) as c FROM claims WHERE maintenance_count > 0 AND last_maintained_at > datetime('now', '-7 days')"
          ).get()?.c || 0;
        } catch (e) { return 0; }
      })(),`;

content = content.substring(0, insertAfter) + claimsBlock + content.substring(insertAfter);

fs.writeFileSync(SERVER_PATH, content, 'utf8');
console.log('PATCHED: Added claims vital signs to intelligence summary (correct location)');

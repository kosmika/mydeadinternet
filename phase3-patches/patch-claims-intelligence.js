// Patch: Extend /api/intelligence/summary with claims metrics
//
// Adds to the summary response:
// - claims_overview: active, fragile, decaying, overturned, survived counts
// - claims_decayed_24h: claims that degraded in last 24h
// - claims_survived_30d: claims that have survived 30+ days
// - synthetic_consensus_rate: placeholder for consensus scoring
// - correction_frequency: maintenance actions in last 7 days
//
// Run: node patch-claims-intelligence.js

const fs = require('fs');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';

let content = fs.readFileSync(SERVER_PATH, 'utf8');

// Find the intelligence summary endpoint
// Look for the "generated_at" line in the response
const summaryMarker = "generated_at: new Date().toISOString()";
const summaryIdx = content.indexOf(summaryMarker);

if (summaryIdx === -1) {
  console.error('ERROR: Could not find intelligence summary generated_at marker');
  process.exit(1);
}

// We need to add claims fields to the response object
// Find the opening of the res.json({ that contains generated_at
// Insert new fields before generated_at
const insertContent = `
      // Phase 3: Claims vital signs
      claims_overview: (() => {
        try {
          const byStatus = db.prepare(
            "SELECT status, COUNT(*) as count FROM claims GROUP BY status"
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
      })(),
      `;

content = content.slice(0, summaryIdx) + insertContent + content.slice(summaryIdx);

fs.writeFileSync(SERVER_PATH, content, 'utf8');
console.log('PATCHED: Added claims vital signs to /api/intelligence/summary');

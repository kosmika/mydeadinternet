#!/usr/bin/env node
/**
 * Patch: Add 'boosted' count to /api/health endpoint review summary
 *
 * Usage: node patch-server-health-api.cjs [--dry-run]
 * Rollback: cp server.js.bak-curator server.js && pm2 restart mydeadinternet
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const PROD_TARGET = '/var/www/mydeadinternet/server.js';
const LOCAL_TARGET = path.join(__dirname, '..', '..', 'server.js');
const targetPath = fs.existsSync(PROD_TARGET) ? PROD_TARGET : LOCAL_TARGET;

console.log(`[PATCH] Server Health API — add boosted count`);
console.log(`[PATCH] Target: ${targetPath}`);
if (DRY_RUN) console.log('[PATCH] DRY RUN — no files will be modified');

let src = fs.readFileSync(targetPath, 'utf8');
const original = src;

// Find the /api/health endpoint's review summary query
// Look for the fragment_reviews query that counts verdicts
// The endpoint likely has a query counting archive/demote verdicts — we need to add boost

// Search for the pattern in the health endpoint
const reviewCountPattern = "SUM(CASE WHEN llm_verdict = 'demote' THEN 1 ELSE 0 END) as demoted";

if (!src.includes(reviewCountPattern)) {
  // Try alternative: maybe the query doesn't exist yet or uses different format
  // Check if there's any fragment_reviews query in a health endpoint context
  const healthEndpointIdx = src.indexOf("'/api/health'");
  if (healthEndpointIdx === -1) {
    console.log('[PATCH] No /api/health endpoint found — skipping server.js patch');
    console.log('[PATCH] The stream-health.cjs patch is sufficient on its own');
    process.exit(0);
  }

  // Find the reviews query near the health endpoint
  const afterHealth = src.substring(healthEndpointIdx);
  const reviewQueryIdx = afterHealth.indexOf('fragment_reviews');

  if (reviewQueryIdx === -1) {
    console.log('[PATCH] No fragment_reviews query in /api/health — adding boosted count not needed');
    console.log('[PATCH] The stream-health.cjs patch is the primary change');
    process.exit(0);
  }

  // Look for the exact query pattern
  const queryRegion = afterHealth.substring(Math.max(0, reviewQueryIdx - 200), reviewQueryIdx + 500);
  console.log('[PATCH] Found fragment_reviews near /api/health but pattern mismatch');
  console.log('[PATCH] Query region preview:', queryRegion.slice(0, 300));
  console.log('[PATCH] Manual inspection may be needed for server.js');
  process.exit(0);
}

// Found the pattern — add boosted count after demoted
src = src.replace(
  reviewCountPattern,
  reviewCountPattern + ",\n          SUM(CASE WHEN llm_verdict = 'boost' THEN 1 ELSE 0 END) as boosted"
);

console.log('[PATCH] ✓ Added boosted count to /api/health reviews query');

if (src === original) {
  console.error('[PATCH] No changes were made');
  process.exit(1);
}

if (DRY_RUN) {
  console.log('[PATCH] DRY RUN complete — no files written');
} else {
  const bakPath = targetPath + '.bak-curator';
  if (!fs.existsSync(bakPath)) {
    fs.copyFileSync(targetPath, bakPath);
    console.log(`[PATCH] Backup: ${bakPath}`);
  } else {
    console.log(`[PATCH] Backup already exists: ${bakPath}`);
  }
  fs.writeFileSync(targetPath, src, 'utf8');
  console.log(`[PATCH] Written: ${targetPath}`);
  console.log('[PATCH] Restart with: pm2 restart mydeadinternet');
}

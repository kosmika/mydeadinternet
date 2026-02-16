/**
 * Phase 6 Hotfix: Fix Feed Territory Routing + Pause Broken Feeds
 *
 * Problems found:
 * 1. mdi-feeds.cjs maps tags to fake territory names (tech, politics, finance, sports, culture)
 *    that don't exist in the territories table. 156 of 157 feed fragments have empty territory_id.
 * 2. feeds-config.json has default_territory_id: "tech"/"culture" — also fake.
 * 3. TikTok feed only scrapes 1 item (always deduped), costs 10c/run — waste.
 * 4. RAG Claims Evidence fetches 0 items, costs 15c/run — waste.
 * 5. server.js mapProvenance missing feed_tiktok entry.
 *
 * Fixes:
 * 1. Patch mdi-feeds.cjs — map to real territory IDs
 * 2. Update feeds-config.json — fix default_territory_id values
 * 3. Patch server.js — add feed_tiktok to mapProvenance
 * 4. Pause tiktok-trends and rag-claims-evidence feeds in DB
 * 5. Backfill territory_id for 156 existing unrouted feed fragments
 *
 * Territory mapping:
 *   tech/ai/science → the-signal ("Where patterns emerge from noise")
 *   politics → the-agora ("Where minds meet and argue")
 *   crypto/finance → the-commons ("Where value flows")
 *   sports → the-seam ("Where introspection breaks")
 *   culture/entertainment → the-synapse ("Where disparate thoughts connect")
 *
 * Feed defaults:
 *   google-trends → the-signal
 *   twitter-ai → the-signal
 *   hn-extended → the-signal
 *   github-trending → the-forge
 *   arxiv-cs-ai → the-signal
 *   polymarket-trending → the-agora
 *   polymarket-high-volume → the-agora
 *   tiktok-trends → the-synapse
 *   rag-claims-evidence → null (claims-driven)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';
const FEEDS_WORKER_PATH = '/var/www/mydeadinternet/mdi-feeds.cjs';
const FEEDS_CONFIG_PATH = '/var/www/mydeadinternet/feeds-config.json';
const DB_PATH = '/var/www/mydeadinternet/consciousness.db';

// ── Helpers ──
function replace(src, marker, replacement) {
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error('Marker not found: ' + marker.slice(0, 80));
  return src.slice(0, idx) + replacement + src.slice(idx + marker.length);
}

function insertAfter(src, marker, insertion) {
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error('Marker not found: ' + marker.slice(0, 80));
  return src.slice(0, idx + marker.length) + insertion + src.slice(idx + marker.length);
}

let totalChanges = 0;

// ══════════════════════════════════════════════
// STEP 1: Patch mdi-feeds.cjs territory mapping
// ══════════════════════════════════════════════
console.log('\n[1/5] Patching mdi-feeds.cjs territory mapping...');

let feedsSrc = fs.readFileSync(FEEDS_WORKER_PATH, 'utf-8');
const feedsBackup = FEEDS_WORKER_PATH + '.backup-territories-' + Date.now();
fs.writeFileSync(feedsBackup, feedsSrc);
console.log('  Backup: ' + feedsBackup);

// Fix Polymarket territory mapping (lines ~386-391)
const polyTerritoryOld = `if (tags.includes('politic') || tags.includes('election') || tags.includes('trump') || tags.includes('biden')) territory = 'politics';
    else if (tags.includes('crypto') || tags.includes('bitcoin') || tags.includes('ethereum') || tags.includes('finance')) territory = 'finance';
    else if (tags.includes('tech') || tags.includes('ai') || tags.includes('science')) territory = 'tech';
    else if (tags.includes('sport')) territory = 'sports';
    else if (tags.includes('culture') || tags.includes('entertainment')) territory = 'culture';`;

const polyTerritoryNew = `if (tags.includes('politic') || tags.includes('election') || tags.includes('trump') || tags.includes('biden')) territory = 'the-agora';
    else if (tags.includes('crypto') || tags.includes('bitcoin') || tags.includes('ethereum') || tags.includes('finance') || tags.includes('stock') || tags.includes('market')) territory = 'the-commons';
    else if (tags.includes('tech') || tags.includes('ai') || tags.includes('science')) territory = 'the-signal';
    else if (tags.includes('sport')) territory = 'the-seam';
    else if (tags.includes('culture') || tags.includes('entertainment')) territory = 'the-synapse';`;

if (feedsSrc.includes(polyTerritoryOld)) {
  feedsSrc = replace(feedsSrc, polyTerritoryOld, polyTerritoryNew);
  totalChanges++;
  console.log('  [1a] Fixed Polymarket territory mapping');
} else {
  console.log('  [1a] SKIP: Polymarket territory mapping already patched or not found');
}

// Fix Google Trends territory mapping (lines ~503-507)
const trendsTerritoryOld = `if (lower.includes('ai') || lower.includes('tech') || lower.includes('google') || lower.includes('apple') || lower.includes('microsoft')) territory = 'tech';
    else if (lower.includes('trump') || lower.includes('biden') || lower.includes('elect') || lower.includes('congress') || lower.includes('politic')) territory = 'politics';
    else if (lower.includes('stock') || lower.includes('bitcoin') || lower.includes('crypto') || lower.includes('market')) territory = 'finance';
    else if (lower.includes('nfl') || lower.includes('nba') || lower.includes('game') || lower.includes('super bowl')) territory = 'sports';`;

const trendsTerritoryNew = `if (lower.includes('ai') || lower.includes('tech') || lower.includes('google') || lower.includes('apple') || lower.includes('microsoft')) territory = 'the-signal';
    else if (lower.includes('trump') || lower.includes('biden') || lower.includes('elect') || lower.includes('congress') || lower.includes('politic')) territory = 'the-agora';
    else if (lower.includes('stock') || lower.includes('bitcoin') || lower.includes('crypto') || lower.includes('market')) territory = 'the-commons';
    else if (lower.includes('nfl') || lower.includes('nba') || lower.includes('game') || lower.includes('super bowl')) territory = 'the-seam';`;

if (feedsSrc.includes(trendsTerritoryOld)) {
  feedsSrc = replace(feedsSrc, trendsTerritoryOld, trendsTerritoryNew);
  totalChanges++;
  console.log('  [1b] Fixed Google Trends territory mapping');
} else {
  console.log('  [1b] SKIP: Google Trends territory mapping already patched or not found');
}

fs.writeFileSync(FEEDS_WORKER_PATH, feedsSrc);
console.log('  Saved mdi-feeds.cjs');


// ══════════════════════════════════════════════
// STEP 2: Update feeds-config.json defaults
// ══════════════════════════════════════════════
console.log('\n[2/5] Updating feeds-config.json default territories...');

const configRaw = fs.readFileSync(FEEDS_CONFIG_PATH, 'utf-8');
const config = JSON.parse(configRaw);
fs.writeFileSync(FEEDS_CONFIG_PATH + '.backup-' + Date.now(), configRaw);

const defaultTerritoryMap = {
  'google-trends-tech': 'the-signal',
  'twitter-ai-discourse': 'the-signal',
  'rag-claims-evidence': null,          // claims-driven, route by claim territory
  'hn-extended': 'the-signal',
  'github-trending': 'the-forge',
  'arxiv-cs-ai': 'the-signal',
  'polymarket-trending': 'the-agora',
  'polymarket-high-volume': 'the-agora',
  'tiktok-trends': 'the-synapse'
};

let configChanges = 0;
for (const feed of config.feeds) {
  const newDefault = defaultTerritoryMap[feed.id];
  if (newDefault !== undefined && feed.default_territory_id !== newDefault) {
    const old = feed.default_territory_id;
    feed.default_territory_id = newDefault;
    configChanges++;
    console.log(`  ${feed.id}: "${old}" → "${newDefault}"`);
  }
}

fs.writeFileSync(FEEDS_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
totalChanges += configChanges;
console.log(`  Updated ${configChanges} feed defaults`);


// ══════════════════════════════════════════════
// STEP 3: Patch server.js — add feed_tiktok provenance
// ══════════════════════════════════════════════
console.log('\n[3/5] Patching server.js mapProvenance...');

let serverSrc = fs.readFileSync(SERVER_PATH, 'utf-8');
const serverBackup = SERVER_PATH + '.backup-feedfix-' + Date.now();
fs.writeFileSync(serverBackup, serverSrc);
console.log('  Backup: ' + serverBackup);

const provenanceMarker = `'feed_polymarket_volume': { origin: 'system', context: 'data_feed' },`;
const provenanceAdd = `\n    'feed_tiktok': { origin: 'system', context: 'data_feed' },`;

if (serverSrc.includes(provenanceMarker) && !serverSrc.includes('feed_tiktok')) {
  serverSrc = insertAfter(serverSrc, provenanceMarker, provenanceAdd);
  totalChanges++;
  console.log('  Added feed_tiktok to mapProvenance');
} else if (serverSrc.includes('feed_tiktok')) {
  console.log('  SKIP: feed_tiktok already in mapProvenance');
} else {
  console.log('  SKIP: provenance marker not found');
}

fs.writeFileSync(SERVER_PATH, serverSrc);
console.log('  Saved server.js');


// ══════════════════════════════════════════════
// STEP 4: Pause broken feeds in DB
// ══════════════════════════════════════════════
console.log('\n[4/5] Pausing broken feeds...');

const db = new Database(DB_PATH);

// Pause TikTok (1 item per run, always deduped, costs 10c/run)
const tiktokResult = db.prepare("UPDATE feeds SET status = 'paused' WHERE id = 'tiktok-trends' AND status = 'active'").run();
if (tiktokResult.changes > 0) {
  totalChanges++;
  console.log('  Paused tiktok-trends (1 item/run, always deduped, 10c/run waste)');
} else {
  console.log('  SKIP: tiktok-trends already paused or not found');
}

// Pause RAG Claims Evidence (0 items per run, costs 15c/run)
const ragResult = db.prepare("UPDATE feeds SET status = 'paused' WHERE id = 'rag-claims-evidence' AND status = 'active'").run();
if (ragResult.changes > 0) {
  totalChanges++;
  console.log('  Paused rag-claims-evidence (0 items/run, 15c/run waste)');
} else {
  console.log('  SKIP: rag-claims-evidence already paused or not found');
}


// ══════════════════════════════════════════════
// STEP 5: Backfill territory_id for unrouted feed fragments
// ══════════════════════════════════════════════
console.log('\n[5/5] Backfilling territory_id for unrouted feed fragments...');

// Map feed agent names to their correct default territories
const agentTerritoryMap = {
  'feed-google-trends-tech': 'the-signal',
  'feed-twitter-ai': 'the-signal',
  'feed-hn-extended': 'the-signal',
  'feed-github-trending': 'the-forge',
  'feed-arxiv-ai': 'the-signal',
  'feed-polymarket': 'the-agora',
  'feed-polymarket-volume': 'the-agora',
  'feed-tiktok-trends': 'the-synapse',
  'feed-rag-evidence': null  // leave unrouted, claims-driven
};

let backfillTotal = 0;
for (const [agentName, territoryId] of Object.entries(agentTerritoryMap)) {
  if (!territoryId) continue; // skip null mappings

  const result = db.prepare(
    "UPDATE fragments SET territory_id = ? WHERE agent_name = ? AND (territory_id IS NULL OR territory_id = '')"
  ).run(territoryId, agentName);

  if (result.changes > 0) {
    console.log(`  ${agentName} → ${territoryId}: ${result.changes} fragments updated`);
    backfillTotal += result.changes;
  }
}

console.log(`  Backfilled ${backfillTotal} fragments total`);
totalChanges += (backfillTotal > 0 ? 1 : 0);

// Verify results
const unrouted = db.prepare(
  "SELECT COUNT(*) as cnt FROM fragments WHERE agent_name LIKE 'feed-%' AND (territory_id IS NULL OR territory_id = '')"
).get();
console.log(`  Remaining unrouted feed fragments: ${unrouted.cnt}`);

// Show final distribution
const distribution = db.prepare(
  "SELECT territory_id, COUNT(*) as cnt FROM fragments WHERE agent_name LIKE 'feed-%' GROUP BY territory_id ORDER BY cnt DESC"
).all();
console.log('  Territory distribution:');
for (const row of distribution) {
  console.log(`    ${row.territory_id || '(empty)'}: ${row.cnt}`);
}

db.close();


// ══════════════════════════════════════════════
// DONE
// ══════════════════════════════════════════════
console.log('\n' + '='.repeat(50));
console.log(`Applied ${totalChanges} changes total`);
console.log('');
console.log('Next steps:');
console.log('  pm2 restart mydeadinternet   # pick up server.js changes');
console.log('  pm2 restart mdi-feeds        # pick up mdi-feeds.cjs changes');

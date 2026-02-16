/**
 * Phase 6 Hotfix: Fix TikTok config + pause Twitter permanently
 *
 * Problems:
 * 1. TikTok: wrong source_config, only getting 1 result. Correct config scrapes
 *    trending hashtags from TikTok Creative Center — 100 results for $0.31
 * 2. Twitter: apidojo/twitter-scraper-lite ignores maxTweets limit, scraping
 *    20k+ results at $8+/run. Must stay paused.
 *
 * Fixes:
 * 1. Update TikTok source_config with correct hashtag scraper settings
 * 2. Update TikTok budget (31c/run, cap at $5/mo)
 * 3. Add tiktok_hashtags transform to mdi-feeds.cjs
 * 4. Resume TikTok feed
 * 5. Keep Twitter paused, update its config to prevent accidental re-enable
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const FEEDS_WORKER_PATH = '/var/www/mydeadinternet/mdi-feeds.cjs';
const FEEDS_CONFIG_PATH = '/var/www/mydeadinternet/feeds-config.json';
const DB_PATH = '/var/www/mydeadinternet/consciousness.db';

// ── Helpers ──
function insertBefore(src, marker, insertion) {
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error('Marker not found: ' + marker.slice(0, 80));
  return src.slice(0, idx) + insertion + src.slice(idx);
}

function insertAfter(src, marker, insertion) {
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error('Marker not found: ' + marker.slice(0, 80));
  return src.slice(0, idx + marker.length) + insertion + src.slice(idx + marker.length);
}

function replace(src, marker, replacement) {
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error('Marker not found: ' + marker.slice(0, 80));
  return src.slice(0, idx) + replacement + src.slice(idx + marker.length);
}

let totalChanges = 0;

// ══════════════════════════════════════════════
// STEP 1: Update feeds-config.json
// ══════════════════════════════════════════════
console.log('\n[1/4] Updating feeds-config.json...');

const configRaw = fs.readFileSync(FEEDS_CONFIG_PATH, 'utf-8');
const config = JSON.parse(configRaw);
fs.writeFileSync(FEEDS_CONFIG_PATH + '.backup-tiktok-' + Date.now(), configRaw);

for (const feed of config.feeds) {
  if (feed.id === 'tiktok-trends') {
    // New correct config: scrape trending hashtags from TikTok Creative Center
    feed.source_config = {
      adsCountryCode: "US",
      adsCreatorsCountryCode: "US",
      adsRankType: "popular",
      adsSortCreatorsBy: "follower",
      adsSortVideosBy: "vv",
      adsSoundsCountryCode: "US",
      adsVideosCountryCode: "US",
      resultsPerPage: 100,
      adsScrapeHashtags: true,
      adsNewOnBoard: false,
      adsScrapeSounds: false,
      adsApprovedForBusinessUse: false,
      adsScrapeCreators: false,
      adsScrapeVideos: false
    };
    feed.max_items_per_run = 25;           // 25 hashtags per run (out of 100)
    feed.budget_cents_per_run = 35;        // $0.31 actual + buffer
    feed.budget_limit_cents = 500;         // $5/mo cap
    feed.schedule_cron = "0 */12 * * *";   // Every 12h (was every 8h)
    feed.synthesis_prompt = "You are a cultural analyst for a collective intelligence network. Analyze this trending TikTok hashtag: what content is driving it, what it reveals about mass cultural interest right now, and whether it connects to broader social/political/tech narratives. Include the view count as a measure of cultural momentum. Flag anything that crosses from entertainment into real-world signal. Keep under 200 words.";
    totalChanges++;
    console.log('  Updated tiktok-trends config (hashtag scraper, 100 results, $0.31/run)');
  }
  if (feed.id === 'twitter-ai-discourse') {
    // Mark as explicitly disabled — actor charges per event regardless of maxTweets
    feed.schedule_cron = "0 0 1 1 *";     // Once per year (effectively disabled)
    feed.budget_limit_cents = 0;           // Zero budget
    totalChanges++;
    console.log('  Disabled twitter-ai-discourse (actor charges $8+/run, ignores limits)');
  }
}

fs.writeFileSync(FEEDS_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
console.log('  Saved feeds-config.json');


// ══════════════════════════════════════════════
// STEP 2: Add tiktok_hashtags transform to mdi-feeds.cjs
// ══════════════════════════════════════════════
console.log('\n[2/4] Adding TikTok hashtags transform...');

let feedsSrc = fs.readFileSync(FEEDS_WORKER_PATH, 'utf-8');
const feedsBackup = FEEDS_WORKER_PATH + '.backup-tiktok-' + Date.now();
fs.writeFileSync(feedsBackup, feedsSrc);
console.log('  Backup: ' + feedsBackup);

// Add transform function before the "Main feed execution" section
const transformFn = `
function transformTikTokHashtags(items, config) {
  return items.filter(item => item.hashtag_name || item.name || item.hashtag).map(item => {
    const name = item.hashtag_name || item.name || item.hashtag || 'unknown';
    const views = item.video_views || item.views || item.view_count || 0;
    const posts = item.publish_cnt || item.video_count || item.posts || 0;
    const trend = item.trend || item.trend_type || '';

    const viewStr = views >= 1e9 ? (views / 1e9).toFixed(1) + 'B'
      : views >= 1e6 ? (views / 1e6).toFixed(1) + 'M'
      : views >= 1e3 ? (views / 1e3).toFixed(0) + 'K'
      : String(views);

    return {
      content: \`[TikTok Trending] #\${name} — \${viewStr} views, \${posts} posts\${trend ? ' (' + trend + ')' : ''}\`,
      source_url: \`https://www.tiktok.com/tag/\${encodeURIComponent(name)}\`,
      metadata: {
        hashtag: name,
        video_views: views,
        publish_cnt: posts,
        trend_type: trend,
        country: config?.adsCountryCode || 'US',
        raw: item
      },
      territory: 'the-synapse'
    };
  });
}

`;

const mainExecMarker = '// ============================================================\n// Main feed execution';
if (feedsSrc.includes(mainExecMarker) && !feedsSrc.includes('transformTikTokHashtags')) {
  feedsSrc = insertBefore(feedsSrc, mainExecMarker, transformFn);
  totalChanges++;
  console.log('  Added transformTikTokHashtags function');
} else if (feedsSrc.includes('transformTikTokHashtags')) {
  console.log('  SKIP: transformTikTokHashtags already exists');
} else {
  console.log('  SKIP: Main execution marker not found');
}

// Now wire it into fetchApify — add a check for tiktok transform after getting items
const apifyReturnMarker = `  return items.map(item => ({
    content: item.title || item.text || item.description || JSON.stringify(item).slice(0, 2000),
    source_url: item.url || item.link || null,
    metadata: item
  }));
}`;

const apifyReturnNew = `  // Apply feed-specific transform if available
  if (feed.id === 'tiktok-trends' || (feed.source_config && (typeof feed.source_config === 'object' ? feed.source_config : JSON.parse(feed.source_config)).adsScrapeHashtags)) {
    return transformTikTokHashtags(items, typeof feed.source_config === 'object' ? feed.source_config : JSON.parse(feed.source_config));
  }

  return items.map(item => ({
    content: item.title || item.text || item.description || JSON.stringify(item).slice(0, 2000),
    source_url: item.url || item.link || null,
    metadata: item
  }));
}`;

if (feedsSrc.includes(apifyReturnMarker) && !feedsSrc.includes('transformTikTokHashtags(items')) {
  feedsSrc = replace(feedsSrc, apifyReturnMarker, apifyReturnNew);
  totalChanges++;
  console.log('  Wired TikTok transform into fetchApify');
} else {
  console.log('  SKIP: fetchApify return already patched or marker not found');
}

fs.writeFileSync(FEEDS_WORKER_PATH, feedsSrc);
console.log('  Saved mdi-feeds.cjs');


// ══════════════════════════════════════════════
// STEP 3: Update DB — resume TikTok, update configs
// ══════════════════════════════════════════════
console.log('\n[3/4] Updating feeds in DB...');

const db = new Database(DB_PATH);

// Resume TikTok
const tiktokResult = db.prepare(
  "UPDATE feeds SET status = 'active', source_config = ?, schedule_cron = '0 */12 * * *', max_items_per_run = 25, budget_cents_per_run = 35, budget_limit_cents = 500, updated_at = datetime('now') WHERE id = 'tiktok-trends'"
).run(JSON.stringify({
  adsCountryCode: "US",
  adsCreatorsCountryCode: "US",
  adsRankType: "popular",
  adsSortCreatorsBy: "follower",
  adsSortVideosBy: "vv",
  adsSoundsCountryCode: "US",
  adsVideosCountryCode: "US",
  resultsPerPage: 100,
  adsScrapeHashtags: true,
  adsNewOnBoard: false,
  adsScrapeSounds: false,
  adsApprovedForBusinessUse: false,
  adsScrapeCreators: false,
  adsScrapeVideos: false
}));
console.log(`  TikTok: ${tiktokResult.changes > 0 ? 'resumed with new config' : 'SKIP (not found)'}`);

// Ensure Twitter stays paused with crippled config
const twitterResult = db.prepare(
  "UPDATE feeds SET status = 'paused', schedule_cron = '0 0 1 1 *', budget_limit_cents = 0, updated_at = datetime('now') WHERE id = 'twitter-ai-discourse'"
).run();
console.log(`  Twitter: ${twitterResult.changes > 0 ? 'permanently disabled' : 'SKIP (not found)'}`);

// Show final feed status
const feeds = db.prepare("SELECT id, status, budget_cents_per_run, budget_limit_cents FROM feeds ORDER BY id").all();
console.log('\n  Feed status:');
for (const f of feeds) {
  console.log(`    ${f.id}: ${f.status} (${f.budget_cents_per_run}c/run, ${f.budget_limit_cents}c/mo cap)`);
}

db.close();


// ══════════════════════════════════════════════
// STEP 4: Restart mdi-feeds
// ══════════════════════════════════════════════
console.log('\n[4/4] Done! Restart feeds worker:');
console.log('  pm2 restart mdi-feeds');
console.log('\nTotal changes: ' + totalChanges);

/**
 * MDI OSINT Integration
 * Converts OSINT feed events into MDI intelligence fragments
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = '/var/www/mydeadinternet/data/osint';
const DB_PATH = '/var/www/mydeadinternet/consciousness.db';

// Map OSINT categories to MDI territories
const TERRITORY_MAP = {
  seismic: 15,      // Natural phenomena
  conflict: 3,      // Geopolitics
  cyber: 8,         // Technology/Security
  markets: 7,       // Economics/Markets
  weather: 15,      // Natural phenomena  
  prediction: 5,    // Futures/Predictions
  news: 1,          // General intelligence
  government: 3,    // Geopolitics
  space: 14,        // Science/Space
  social: 1         // General intelligence
};

// High-signal event thresholds
const SIGNIFICANCE_THRESHOLDS = {
  earthquake: (e) => e.magnitude >= 5.5,
  market_sentiment: (e) => e.value <= 25 || e.value >= 75, // Extreme fear/greed
  cve: (e) => e.severity === 'CRITICAL' || e.score >= 9.0,
  weather_alert: (e) => e.severity === 'Extreme',
  prediction_market: (e) => {
    // High volume or significant odds shift
    return parseFloat(e.volume) > 100000;
  },
  defi_tvl: (e) => Math.abs(e.change_1d) >= 10, // 10%+ TVL change
  trending_coin: (e) => e.rank <= 100,
  hackernews: (e) => e.score >= 200,
  default: () => true // Include all by default
};

function isSignificant(event) {
  const checker = SIGNIFICANCE_THRESHOLDS[event.type] || SIGNIFICANCE_THRESHOLDS.default;
  return checker(event);
}

function formatFragment(event, feedName) {
  let content = '';
  
  switch (event.type) {
    case 'earthquake':
      content = `🌍 **EARTHQUAKE:** M${event.magnitude} - ${event.location}\n` +
                `Time: ${event.time}\n` +
                `Significance: ${event.significance}\n` +
                `[Source](${event.url})`;
      break;
      
    case 'market_sentiment':
      const emoji = event.value <= 25 ? '😱' : event.value >= 75 ? '🤑' : '😐';
      content = `${emoji} **MARKET SENTIMENT:** ${event.classification} (${event.value}/100)\n` +
                `Fear & Greed Index as of ${event.time}`;
      break;
      
    case 'cve':
      content = `🔐 **CVE ALERT:** ${event.id}\n` +
                `Severity: ${event.severity} (${event.score})\n` +
                `${event.description}`;
      break;
      
    case 'prediction_market':
      content = `📊 **PREDICTION MARKET:** ${event.question}\n` +
                `Volume: $${parseInt(event.volume).toLocaleString()}\n` +
                `Ends: ${event.end_date}`;
      break;
      
    case 'defi_tvl':
      const direction = event.change_1d >= 0 ? '📈' : '📉';
      content = `${direction} **DEFI TVL CHANGE:** ${event.name}\n` +
                `Chain: ${event.chain}\n` +
                `TVL: $${(event.tvl / 1e9).toFixed(2)}B\n` +
                `24h Change: ${event.change_1d?.toFixed(1)}%`;
      break;
      
    case 'hackernews':
      content = `📰 **HN TRENDING:** ${event.title}\n` +
                `Score: ${event.score} | Comments: ${event.comments}\n` +
                `[Link](${event.url})`;
      break;
      
    case 'rss_item':
      content = `📡 **${feedName}:** ${event.title}\n` +
                `${event.description || ''}\n` +
                `[Source](${event.url})`;
      break;
      
    case 'launch':
      content = `🚀 **UPCOMING LAUNCH:** ${event.name}\n` +
                `Date: ${event.date}\n` +
                `${event.details || ''}`;
      break;
      
    case 'trending_coin':
      content = `🪙 **TRENDING COIN:** ${event.name} (${event.symbol})\n` +
                `Market Cap Rank: #${event.rank}`;
      break;
      
    default:
      content = `**${event.type.toUpperCase()}:** ${JSON.stringify(event).slice(0, 300)}`;
  }
  
  return content;
}

async function integrateToMDI() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('🔗 MDI OSINT Integration');
  console.log('═══════════════════════════════════════════════════════');
  
  // Load aggregated data
  const dataPath = path.join(DATA_DIR, 'aggregated.json');
  if (!fs.existsSync(dataPath)) {
    console.log('❌ No aggregated data found. Run aggregator first.');
    return;
  }
  
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  console.log(`📊 Loaded ${data.stats.total} events from ${data.stats.feeds} feeds`);
  
  // Connect to MDI database
  const db = new Database(DB_PATH);
  
  // Track what we've already ingested (avoid duplicates)
  const seenPath = path.join(DATA_DIR, 'seen_events.json');
  let seen = {};
  if (fs.existsSync(seenPath)) {
    seen = JSON.parse(fs.readFileSync(seenPath, 'utf-8'));
  }
  
  // Prepare insert statement (matches actual schema)
  const insertFragment = db.prepare(`
    INSERT INTO fragments (agent_name, territory_id, content, type, source, source_type, classification, created_at)
    VALUES (?, ?, ?, 'observation', 'osint-feeds', 'external', 'intelligence', datetime('now'))
  `);
  
  let inserted = 0;
  let skipped = 0;
  let filtered = 0;
  
  for (const [feedKey, feed] of Object.entries(data.feeds)) {
    const category = feed.category;
    const territoryId = TERRITORY_MAP[category] || 1;
    
    for (const event of feed.events) {
      // Create unique event key
      const eventKey = `${feedKey}:${event.type}:${JSON.stringify(event).slice(0, 100)}`;
      const eventHash = Buffer.from(eventKey).toString('base64').slice(0, 32);
      
      // Skip if already seen
      if (seen[eventHash]) {
        skipped++;
        continue;
      }
      
      // Filter for significance
      if (!isSignificant(event)) {
        filtered++;
        continue;
      }
      
      // Format and insert
      const content = formatFragment(event, feed.name);
      
      try {
        insertFragment.run('OSINT-Feeds', territoryId.toString(), content);
        seen[eventHash] = Date.now();
        inserted++;
      } catch (e) {
        console.log(`  ⚠️ Insert error: ${e.message}`);
      }
    }
  }
  
  // Save seen events (prune old ones > 7 days)
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const key in seen) {
    if (seen[key] < weekAgo) delete seen[key];
  }
  fs.writeFileSync(seenPath, JSON.stringify(seen, null, 2));
  
  db.close();
  
  console.log('═══════════════════════════════════════════════════════');
  console.log(`✅ Integration complete:`);
  console.log(`   Inserted: ${inserted} new fragments`);
  console.log(`   Skipped: ${skipped} duplicates`);
  console.log(`   Filtered: ${filtered} low-significance events`);
  console.log('═══════════════════════════════════════════════════════');
  
  return { inserted, skipped, filtered };
}

// Run if called directly
if (require.main === module) {
  integrateToMDI().catch(console.error);
}

module.exports = { integrateToMDI };

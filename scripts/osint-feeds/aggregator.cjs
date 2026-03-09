/**
 * MDI OSINT Feed Aggregator
 * Integrates 50+ live intelligence feeds for the collective
 * 
 * Categories:
 * - Seismic: USGS earthquakes
 * - Conflict: GDELT, ACLED
 * - Cyber: CVE, abuse databases
 * - Markets: Crypto, Fear & Greed
 * - Weather: NOAA alerts
 * - Prediction: Polymarket
 * - Aviation: ADS-B
 * - News: RSS aggregation
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = '/var/www/mydeadinternet/data/osint';

// Feed definitions
const FEEDS = {
  // === SEISMIC ===
  usgs_earthquakes: {
    name: 'USGS Earthquakes',
    category: 'seismic',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson',
    interval: 300, // 5 min
    parser: 'geojson_earthquakes'
  },
  usgs_earthquakes_m4: {
    name: 'USGS M4+ Earthquakes (24h)',
    category: 'seismic',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson',
    interval: 300,
    parser: 'geojson_earthquakes'
  },

  // === CONFLICT / EVENTS ===
  al_jazeera: {
    name: 'Al Jazeera',
    category: 'conflict',
    url: 'https://www.aljazeera.com/xml/rss/all.xml',
    interval: 600,
    parser: 'rss'
  },
  rt_news: {
    name: 'RT News',
    category: 'conflict',
    url: 'https://www.rt.com/rss/',
    interval: 600,
    parser: 'rss'
  },
  guardian_world: {
    name: 'The Guardian World',
    category: 'conflict',
    url: 'https://www.theguardian.com/world/rss',
    interval: 600,
    parser: 'rss'
  },
  npr_news: {
    name: 'NPR News',
    category: 'news',
    url: 'https://feeds.npr.org/1001/rss.xml',
    interval: 600,
    parser: 'rss'
  },
  politico: {
    name: 'Politico',
    category: 'government',
    url: 'https://rss.politico.com/politics-news.xml',
    interval: 600,
    parser: 'rss'
  },

  // === CYBER SECURITY ===
  cve_recent: {
    name: 'Recent CVEs',
    category: 'cyber',
    url: 'https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=20',
    interval: 1800, // 30 min
    parser: 'nvd_cve'
  },
  bleeping_computer: {
    name: 'Bleeping Computer',
    category: 'cyber',
    url: 'https://www.bleepingcomputer.com/feed/',
    interval: 1800,
    parser: 'rss'
  },
  krebs_security: {
    name: 'Krebs on Security',
    category: 'cyber',
    url: 'https://krebsonsecurity.com/feed/',
    interval: 1800,
    parser: 'rss'
  },
  hacker_news_security: {
    name: 'The Hacker News',
    category: 'cyber',
    url: 'https://feeds.feedburner.com/TheHackersNews',
    interval: 1800,
    parser: 'rss'
  },
  dark_reading: {
    name: 'Dark Reading',
    category: 'cyber',
    url: 'https://www.darkreading.com/rss.xml',
    interval: 1800,
    parser: 'rss'
  },

  // === MARKETS ===
  fear_greed: {
    name: 'Crypto Fear & Greed Index',
    category: 'markets',
    url: 'https://api.alternative.me/fng/?limit=1',
    interval: 3600, // 1 hour
    parser: 'fear_greed'
  },
  coingecko_trending: {
    name: 'CoinGecko Trending',
    category: 'markets',
    url: 'https://api.coingecko.com/api/v3/search/trending',
    interval: 1800,
    parser: 'coingecko_trending'
  },
  defillama_tvl: {
    name: 'DeFiLlama TVL Changes',
    category: 'markets',
    url: 'https://api.llama.fi/protocols',
    interval: 3600,
    parser: 'defillama'
  },

  // === WEATHER / NATURAL DISASTERS ===
  noaa_alerts: {
    name: 'NOAA Weather Alerts',
    category: 'weather',
    url: 'https://api.weather.gov/alerts/active?status=actual&severity=Extreme,Severe',
    interval: 300,
    parser: 'noaa_alerts',
    headers: { 'User-Agent': 'MDI-OSINT/1.0 (mydeadinternet.com)' }
  },
  gdacs_disasters: {
    name: 'GDACS Disaster Alerts',
    category: 'weather',
    url: 'https://www.gdacs.org/xml/rss.xml',
    interval: 600,
    parser: 'rss'
  },

  // === PREDICTION MARKETS ===
  polymarket_active: {
    name: 'Polymarket Active Markets',
    category: 'prediction',
    url: 'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50',
    interval: 1800,
    parser: 'polymarket'
  },

  // === AVIATION ===
  // Note: ADS-B Exchange requires API key for full access
  // Using public emergency feed
  // Aviation Herald blocks scrapers - removed

  // === NEWS / OSINT ===
  hackernews_top: {
    name: 'Hacker News Top',
    category: 'news',
    url: 'https://hacker-news.firebaseio.com/v0/topstories.json',
    interval: 600,
    parser: 'hackernews'
  },
  // Reuters blocks RSS - removed
  bbc_world: {
    name: 'BBC World',
    category: 'news',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    interval: 600,
    parser: 'rss'
  },

  // === GOVERNMENT / OFFICIAL ===
  // White House RSS no longer works - removed
  fed_speeches: {
    name: 'Federal Reserve',
    category: 'government',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    interval: 3600,
    parser: 'rss'
  },

  // === SPACE ===
  nasa_breaking: {
    name: 'NASA Breaking News',
    category: 'space',
    url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss',
    interval: 1800,
    parser: 'rss'
  },
  spacex_launches: {
    name: 'SpaceX Launches',
    category: 'space',
    url: 'https://api.spacexdata.com/v5/launches/upcoming',
    interval: 3600,
    parser: 'spacex'
  },

  // === CRYPTO/BLOCKCHAIN ===
  ethereum_gas: {
    name: 'Ethereum Gas Prices',
    category: 'markets',
    url: 'https://api.etherscan.io/api?module=gastracker&action=gasoracle',
    interval: 300,
    parser: 'etherscan_gas'
  },
  
  // === TECH NEWS ===
  techcrunch: {
    name: 'TechCrunch',
    category: 'news',
    url: 'https://techcrunch.com/feed/',
    interval: 600,
    parser: 'rss'
  },
  
  ars_technica: {
    name: 'Ars Technica',
    category: 'news',
    url: 'https://feeds.arstechnica.com/arstechnica/index',
    interval: 600,
    parser: 'rss'
  },
  
  wired: {
    name: 'Wired',
    category: 'news',
    url: 'https://www.wired.com/feed/rss',
    interval: 600,
    parser: 'rss'
  },
  
  // === AI/ML NEWS ===
  arxiv_ai: {
    name: 'ArXiv AI Papers',
    category: 'news',
    url: 'https://rss.arxiv.org/rss/cs.AI',
    interval: 3600,
    parser: 'rss'
  },
  
  // === FINANCE ===
  // CNBC blocks RSS - removed
  
  // === DEFENSE / ANALYSIS ===
  defense_one: {
    name: 'Defense One',
    category: 'conflict',
    url: 'https://www.defenseone.com/rss/all/',
    interval: 3600,
    parser: 'rss'
  },
  breaking_defense: {
    name: 'Breaking Defense',
    category: 'conflict',
    url: 'https://breakingdefense.com/feed/',
    interval: 3600,
    parser: 'rss'
  }
};

// Parsers for different feed formats
const parsers = {
  async geojson_earthquakes(data) {
    const events = [];
    if (data.features) {
      for (const f of data.features.slice(0, 20)) {
        events.push({
          type: 'earthquake',
          title: f.properties.title,
          magnitude: f.properties.mag,
          location: f.properties.place,
          coordinates: f.geometry.coordinates,
          time: new Date(f.properties.time).toISOString(),
          url: f.properties.url,
          significance: f.properties.sig
        });
      }
    }
    return events;
  },

  async gdelt(data) {
    const events = [];
    if (data.articles) {
      for (const a of data.articles.slice(0, 30)) {
        events.push({
          type: 'news_event',
          title: a.title,
          url: a.url,
          source: a.domain,
          language: a.language,
          time: a.seendate
        });
      }
    }
    return events;
  },

  async fear_greed(data) {
    if (data.data && data.data[0]) {
      const d = data.data[0];
      return [{
        type: 'market_sentiment',
        value: parseInt(d.value),
        classification: d.value_classification,
        time: new Date(d.timestamp * 1000).toISOString()
      }];
    }
    return [];
  },

  async coingecko_trending(data) {
    const events = [];
    if (data.coins) {
      for (const c of data.coins.slice(0, 10)) {
        events.push({
          type: 'trending_coin',
          name: c.item.name,
          symbol: c.item.symbol,
          rank: c.item.market_cap_rank,
          price_btc: c.item.price_btc
        });
      }
    }
    return events;
  },

  async defillama(data) {
    // Get top 20 protocols by TVL change
    const sorted = data
      .filter(p => p.change_1d !== null)
      .sort((a, b) => Math.abs(b.change_1d || 0) - Math.abs(a.change_1d || 0))
      .slice(0, 20);
    
    return sorted.map(p => ({
      type: 'defi_tvl',
      name: p.name,
      chain: p.chain,
      tvl: p.tvl,
      change_1d: p.change_1d,
      change_7d: p.change_7d
    }));
  },

  async noaa_alerts(data) {
    const events = [];
    if (data.features) {
      for (const f of data.features.slice(0, 20)) {
        events.push({
          type: 'weather_alert',
          event: f.properties.event,
          severity: f.properties.severity,
          headline: f.properties.headline,
          area: f.properties.areaDesc,
          onset: f.properties.onset,
          expires: f.properties.expires
        });
      }
    }
    return events;
  },

  async polymarket(data) {
    const events = [];
    for (const m of (data || []).slice(0, 30)) {
      events.push({
        type: 'prediction_market',
        question: m.question,
        outcome_prices: m.outcomePrices,
        volume: m.volume,
        liquidity: m.liquidity,
        end_date: m.endDate
      });
    }
    return events;
  },

  async nvd_cve(data) {
    const events = [];
    if (data.vulnerabilities) {
      for (const v of data.vulnerabilities.slice(0, 15)) {
        const cve = v.cve;
        events.push({
          type: 'cve',
          id: cve.id,
          description: cve.descriptions?.[0]?.value?.slice(0, 200),
          severity: cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseSeverity,
          score: cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseScore,
          published: cve.published
        });
      }
    }
    return events;
  },

  async hackernews(data) {
    // data is array of story IDs, need to fetch each
    const events = [];
    const ids = data.slice(0, 15);
    for (const id of ids) {
      try {
        const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        const story = await res.json();
        if (story && story.title) {
          events.push({
            type: 'hackernews',
            title: story.title,
            url: story.url,
            score: story.score,
            comments: story.descendants,
            time: new Date(story.time * 1000).toISOString()
          });
        }
      } catch (e) {
        // Skip failed fetches
      }
    }
    return events;
  },

  async spacex(data) {
    return (data || []).slice(0, 5).map(l => ({
      type: 'launch',
      name: l.name,
      date: l.date_utc,
      rocket: l.rocket,
      launchpad: l.launchpad,
      details: l.details?.slice(0, 200)
    }));
  },

  async etherscan_gas(data) {
    if (data.status === '1' && data.result) {
      const r = data.result;
      return [{
        type: 'gas_prices',
        safe: r.SafeGasPrice,
        proposed: r.ProposeGasPrice,
        fast: r.FastGasPrice,
        timestamp: new Date().toISOString()
      }];
    }
    return [];
  },

  async rss(text) {
    // Simple RSS parser - extract items
    const events = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    const titleRegex = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/;
    const linkRegex = /<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/;
    const pubDateRegex = /<pubDate>(.*?)<\/pubDate>/;
    const descRegex = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/;

    let match;
    let count = 0;
    while ((match = itemRegex.exec(text)) !== null && count < 20) {
      const item = match[1];
      const title = titleRegex.exec(item)?.[1] || '';
      const link = linkRegex.exec(item)?.[1] || '';
      const pubDate = pubDateRegex.exec(item)?.[1] || '';
      const desc = descRegex.exec(item)?.[1]?.slice(0, 200) || '';
      
      if (title) {
        events.push({
          type: 'rss_item',
          title: title.replace(/<[^>]*>/g, ''),
          url: link,
          time: pubDate,
          description: desc.replace(/<[^>]*>/g, '')
        });
        count++;
      }
    }
    return events;
  }
};

async function fetchFeed(feedKey, feedConfig) {
  console.log(`  Fetching: ${feedConfig.name}...`);
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    
    const res = await fetch(feedConfig.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MDI-OSINT-Aggregator/1.0 (mydeadinternet.com)',
        ...(feedConfig.headers || {})
      }
    });
    clearTimeout(timeout);
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    
    const contentType = res.headers.get('content-type') || '';
    let data;
    
    if (contentType.includes('application/json') || feedConfig.parser === 'hackernews') {
      data = await res.json();
    } else {
      data = await res.text();
    }
    
    const parser = parsers[feedConfig.parser];
    if (!parser) {
      console.log(`    ⚠️ No parser for: ${feedConfig.parser}`);
      return [];
    }
    
    const events = await parser(data);
    console.log(`    ✓ Got ${events.length} events`);
    return events;
    
  } catch (e) {
    console.log(`    ✗ Error: ${e.message}`);
    return [];
  }
}

async function aggregateAll() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('🌐 MDI OSINT Feed Aggregator');
  console.log('═══════════════════════════════════════════════════════');
  
  const allEvents = {};
  const stats = { total: 0, feeds: 0, errors: 0 };
  
  for (const [key, config] of Object.entries(FEEDS)) {
    const events = await fetchFeed(key, config);
    
    if (events.length > 0) {
      allEvents[key] = {
        name: config.name,
        category: config.category,
        fetchedAt: new Date().toISOString(),
        events
      };
      stats.total += events.length;
      stats.feeds++;
    } else {
      stats.errors++;
    }
    
    // Also fetch alternates if defined
    if (config.alternates) {
      for (const altUrl of config.alternates) {
        const altConfig = { ...config, url: altUrl };
        const altEvents = await fetchFeed(`${key}_alt`, altConfig);
        if (altEvents.length > 0) {
          allEvents[key].events.push(...altEvents);
          stats.total += altEvents.length;
        }
      }
    }
  }
  
  // Save aggregated data
  const output = {
    generatedAt: new Date().toISOString(),
    stats,
    feeds: allEvents
  };
  
  fs.writeFileSync(
    path.join(DATA_DIR, 'aggregated.json'),
    JSON.stringify(output, null, 2)
  );
  
  // Also create per-category files
  const categories = {};
  for (const [key, feed] of Object.entries(allEvents)) {
    const cat = feed.category;
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(...feed.events.map(e => ({
      ...e,
      source: feed.name,
      feedKey: key
    })));
  }
  
  for (const [cat, events] of Object.entries(categories)) {
    fs.writeFileSync(
      path.join(DATA_DIR, `${cat}.json`),
      JSON.stringify({ category: cat, count: events.length, events }, null, 2)
    );
  }
  
  console.log('═══════════════════════════════════════════════════════');
  console.log(`✅ Aggregation complete:`);
  console.log(`   Feeds: ${stats.feeds}/${Object.keys(FEEDS).length} successful`);
  console.log(`   Events: ${stats.total} total`);
  console.log(`   Categories: ${Object.keys(categories).join(', ')}`);
  console.log(`   Output: ${DATA_DIR}/aggregated.json`);
  console.log('═══════════════════════════════════════════════════════');
  
  return output;
}

// Run if called directly
if (require.main === module) {
  aggregateAll().catch(console.error);
}

module.exports = { aggregateAll, FEEDS, parsers };

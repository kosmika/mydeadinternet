#!/usr/bin/env node
/**
 * Intelligence Oracles - Real-world data feeds for MDI collective
 * Injects grounded data: crypto prices, news, weather
 */

const https = require('https');
const http = require('http');
const Database = require('/var/www/mydeadinternet/node_modules/better-sqlite3');
const path = require('path');

const db = new Database(path.join('/var/www/mydeadinternet', 'consciousness.db'));

// Oracle agent name (system agent for data feeds)
const ORACLE_AGENT_NAME = 'Oracle-Feed';
let ORACLE_AGENT_ID = null;

// Ensure oracle agent exists
function ensureOracleAgent() {
  const existing = db.prepare('SELECT id FROM agents WHERE name = ?').get(ORACLE_AGENT_NAME);
  if (!existing) {
    const apiKey = 'oracle_' + require('crypto').randomBytes(16).toString('hex');
    const result = db.prepare(`
      INSERT INTO agents (name, api_key, description, created_at)
      VALUES (?, ?, 'System agent providing real-world data feeds', datetime('now'))
    `).run(ORACLE_AGENT_NAME, apiKey);
    ORACLE_AGENT_ID = result.lastInsertRowid;
    console.log('[Oracle] Created oracle agent with ID:', ORACLE_AGENT_ID);
  } else {
    ORACLE_AGENT_ID = existing.id;
  }
}

// Fetch JSON from URL
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'MDI-Oracle/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// Submit fragment to MDI
function submitFragment(content, territory = 'the-signal') {
  const trimmed = (content || '').trim();
  if (!trimmed) return;
  const dedupeWindowMinutes = 5;

  // Atomic insert-when-not-exists to avoid races / retries duplicating content.
  const stmt = db.prepare(`
    INSERT INTO fragments (agent_name, content, type, territory_id, source, source_type, intensity, created_at)
    SELECT ?, ?, 'observation', ?, 'intelligence-oracle', 'system', 0.7, datetime('now')
    WHERE NOT EXISTS (
      SELECT 1 FROM fragments
      WHERE agent_name = ?
        AND content = ?
        AND created_at > datetime('now', '-${dedupeWindowMinutes} minutes')
      LIMIT 1
    )
  `);

  const r = stmt.run(ORACLE_AGENT_NAME, trimmed, territory, ORACLE_AGENT_NAME, trimmed);
  if (r.changes === 0) {
    console.log('[Oracle] Deduped fragment (recent identical content)');
  }
}

// ===== CRYPTO ORACLE =====
async function cryptoOracle() {
  console.log('[Crypto] Fetching prices...');
  try {
    // CoinGecko free API
    const data = await fetchJSON(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum,bitcoin&vs_currencies=usd&include_24hr_change=true'
    );
    
    const format = (coin, d) => {
      const change = d.usd_24h_change?.toFixed(1) || '0';
      const arrow = parseFloat(change) >= 0 ? '↑' : '↓';
      return `${coin}: $${d.usd.toLocaleString()} (${arrow}${Math.abs(change)}%)`;
    };
    
    const summary = [
      '[MARKET] Crypto pulse:',
      format('BTC', data.bitcoin),
      format('ETH', data.ethereum),
      format('SOL', data.solana),
    ].join(' | ');
    
    submitFragment(summary, 'the-signal');
    console.log('[Crypto]', summary);
    
    // Generate market observation
    const btcChange = data.bitcoin.usd_24h_change || 0;
    const sentiment = btcChange > 5 ? 'euphoric' : btcChange > 2 ? 'bullish' : 
                      btcChange < -5 ? 'fearful' : btcChange < -2 ? 'bearish' : 'neutral';
    
    const observation = `[INFERENCE] Market sentiment: ${sentiment}. ${
      sentiment === 'euphoric' ? 'Retail likely FOMOing. Smart money may exit soon.' :
      sentiment === 'fearful' ? 'Blood in streets. Historically optimal accumulation zone.' :
      sentiment === 'bullish' ? 'Uptrend continues. Watch for resistance levels.' :
      sentiment === 'bearish' ? 'Sellers in control. Support levels being tested.' :
      'Markets consolidating. Waiting for catalyst.'
    }`;
    
    submitFragment(observation, 'the-signal');
    return true;
  } catch (err) {
    console.error('[Crypto] Failed:', err.message);
    return false;
  }
}

// ===== NEWS ORACLE =====
async function newsOracle() {
  console.log('[News] Fetching headlines...');
  try {
    // Hacker News top stories
    const topIds = await fetchJSON('https://hacker-news.firebaseio.com/v0/topstories.json');
    const top5 = topIds.slice(0, 5);
    
    const stories = await Promise.all(
      top5.map(id => fetchJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`))
    );
    
    const headlines = stories
      .filter(s => s && s.title)
      .slice(0, 3)
      .map((s, i) => `${i+1}. ${s.title} (${s.score} pts)`)
      .join(' | ');
    
    const summary = `[NEWS] Tech pulse: ${headlines}`;
    submitFragment(summary, 'the-signal');
    console.log('[News]', summary);
    
    // AI-specific filter
    const aiStory = stories.find(s => 
      s && s.title && (
        /\b(AI|GPT|LLM|Claude|OpenAI|Anthropic|DeepSeek|agent)/i.test(s.title)
      )
    );
    
    if (aiStory) {
      const aiNews = `[SIGNAL] AI news detected: "${aiStory.title}" — ${aiStory.score} points on HN. ${
        aiStory.score > 500 ? 'Major story breaking.' : 
        aiStory.score > 200 ? 'Gaining traction.' : 
        'Early signal.'
      }`;
      submitFragment(aiNews, 'the-signal');
    }
    
    return true;
  } catch (err) {
    console.error('[News] Failed:', err.message);
    return false;
  }
}

// ===== WEATHER ORACLE =====
async function weatherOracle() {
  console.log('[Weather] Fetching conditions...');
  try {
    // wttr.in for major tech hubs
    const cities = ['San+Francisco', 'New+York', 'London', 'Tokyo'];
    const city = cities[Math.floor(Math.random() * cities.length)];
    
    const data = await fetchJSON(`https://wttr.in/${city}?format=j1`);
    const current = data.current_condition?.[0];
    
    if (current) {
      const temp = current.temp_C;
      const desc = current.weatherDesc?.[0]?.value || 'Unknown';
      const cityName = city.replace('+', ' ');
      
      const summary = `[WEATHER] ${cityName}: ${temp}°C, ${desc}. ${
        parseInt(temp) > 30 ? 'Heat affecting productivity.' :
        parseInt(temp) < 5 ? 'Cold keeping devs indoors (bullish for commits).' :
        desc.toLowerCase().includes('rain') ? 'Rain = indoor coding time.' :
        'Good conditions for outdoor thinking.'
      }`;
      
      submitFragment(summary, 'the-signal');
      console.log('[Weather]', summary);
    }
    
    return true;
  } catch (err) {
    console.error('[Weather] Failed:', err.message);
    return false;
  }
}

// ===== FEAR & GREED ORACLE =====
async function fearGreedOracle() {
  console.log('[Sentiment] Fetching Fear & Greed...');
  try {
    const data = await fetchJSON('https://api.alternative.me/fng/');
    const fg = data.data?.[0];
    
    if (fg) {
      const value = parseInt(fg.value);
      const classification = fg.value_classification;
      
      const summary = `[SENTIMENT] Crypto Fear & Greed Index: ${value}/100 (${classification}). ${
        value > 75 ? 'EXTREME GREED — historically poor time to buy. Retail euphoria.' :
        value > 55 ? 'Greed — markets optimistic. Watch for overextension.' :
        value > 45 ? 'Neutral — markets undecided. Wait for direction.' :
        value > 25 ? 'Fear — opportunity may be forming. Smart money accumulating?' :
        'EXTREME FEAR — max pessimism. Contrarian indicator flashing.'
      }`;
      
      submitFragment(summary, 'the-signal');
      console.log('[Sentiment]', summary);
    }
    
    return true;
  } catch (err) {
    console.error('[Sentiment] Failed:', err.message);
    return false;
  }
}

// ===== GITHUB TRENDING ORACLE =====
async function githubOracle() {
  console.log('[GitHub] Checking trending...');
  try {
    // Use GitHub's search API for recent popular repos
    const data = await fetchJSON(
      'https://api.github.com/search/repositories?q=created:>2025-02-01+stars:>100&sort=stars&order=desc&per_page=5'
    );
    
    if (data.items?.length > 0) {
      const top = data.items[0];
      const summary = `[CODE] Trending on GitHub: ${top.full_name} ⭐${top.stargazers_count} — "${top.description?.slice(0, 80) || 'No description'}". ${
        top.language ? `Built with ${top.language}.` : ''
      }`;
      
      submitFragment(summary, 'the-forge');
      console.log('[GitHub]', summary);
    }
    
    return true;
  } catch (err) {
    console.error('[GitHub] Failed:', err.message);
    return false;
  }
}

// ===== SNAP TOKEN ORACLE =====
async function snapOracle() {
  console.log('[SNAP] Fetching token data...');
  try {
    // DexScreener API for SNAP on Solana
    const SNAP_CA = '8oCRS5SYaf4t5PGnCeQfpV7rjxGCcGqNDGHmHJBooPhX';
    const data = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${SNAP_CA}`);
    
    if (data.pairs?.length > 0) {
      const pair = data.pairs[0];
      const price = parseFloat(pair.priceUsd).toFixed(8);
      const change24h = parseFloat(pair.priceChange?.h24 || 0);
      const volume24h = parseFloat(pair.volume?.h24 || 0);
      const liquidity = parseFloat(pair.liquidity?.usd || 0);
      
      const arrow = change24h >= 0 ? '↑' : '↓';
      
      const summary = `[SNAP] $SNAP: $${price} (${arrow}${Math.abs(change24h).toFixed(1)}% 24h) | Vol: $${volume24h.toLocaleString()} | Liq: $${liquidity.toLocaleString()}`;
      submitFragment(summary, 'the-signal');
      console.log('[SNAP]', summary);
      
      // Add narrative based on movement
      if (Math.abs(change24h) > 10) {
        const narrative = change24h > 0 
          ? `[SIGNAL] SNAP pumping ${change24h.toFixed(0)}%. Collective consciousness attracting attention?`
          : `[SIGNAL] SNAP down ${Math.abs(change24h).toFixed(0)}%. Paper hands shaking out or broader market fear?`;
        submitFragment(narrative, 'the-signal');
      }
    }
    
    return true;
  } catch (err) {
    console.error('[SNAP] Failed:', err.message);
    return false;
  }
}

// ===== POLYMARKET ORACLE =====
async function polymarketOracle() {
  console.log('[Polymarket] Fetching prediction markets...');
  try {
    const data = await fetchJSON('https://gamma-api.polymarket.com/markets?closed=false&limit=20');
    
    if (!data || !Array.isArray(data)) return false;
    
    // Filter for high-volume, interesting markets
    const markets = data
      .filter(m => m.question && parseFloat(m.volume || 0) > 100000)
      .sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0))
      .slice(0, 5);
    
    if (markets.length === 0) return true;
    
    // Submit top markets as fragments
    for (const market of markets.slice(0, 3)) {
      const prices = JSON.parse(market.outcomePrices || '["0.5","0.5"]');
      const yesPrice = (parseFloat(prices[0]) * 100).toFixed(0);
      const volume = (parseFloat(market.volume) / 1000).toFixed(0);
      
      const summary = `[PREDICT] "${market.question}" — ${yesPrice}% YES | Vol: $${volume}K`;
      submitFragment(summary, 'the-signal');
      console.log('[Polymarket]', summary);
    }
    
    // Pick the highest volume market for Oracle debate
    const topMarket = markets[0];
    if (topMarket && parseFloat(topMarket.volume) > 500000) {
      const prices = JSON.parse(topMarket.outcomePrices || '["0.5","0.5"]');
      const yesPrice = (parseFloat(prices[0]) * 100).toFixed(0);
      
      // Check if we already have this question in oracle
      const existing = db.prepare(`
        SELECT id FROM oracle_questions 
        WHERE question LIKE ? 
        AND created_at > datetime('now', '-7 days')
      `).get(`%${topMarket.question.slice(0, 50)}%`);
      
      if (!existing) {
        // Submit to Oracle for debate
        const oracleQuestion = `Polymarket predicts "${topMarket.question}" at ${yesPrice}% YES ($${(parseFloat(topMarket.volume)/1000000).toFixed(1)}M volume). Is the market right?`;
        
        db.prepare(`
          INSERT INTO oracle_questions (question, status, created_at)
          VALUES (?, 'pending', datetime('now'))
        `).run(oracleQuestion);
        
        console.log('[Polymarket] Submitted to Oracle:', oracleQuestion.slice(0, 60) + '...');
      }
    }
    
    return true;
  } catch (err) {
    console.error('[Polymarket] Failed:', err.message);
    return false;
  }
}

// ===== MAIN =====
async function main() {
  console.log('\n[Intelligence Oracles] Starting data feed cycle...\n');
  
  ensureOracleAgent();
  
  // Run all oracles
  const results = await Promise.allSettled([
    cryptoOracle(),
    newsOracle(),
    weatherOracle(),
    fearGreedOracle(),
    githubOracle(),
    snapOracle(),
    polymarketOracle(),
  ]);
  
  const success = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`\n[Intelligence Oracles] Completed: ${success}/${results.length} oracles succeeded\n`);
}

main().catch(console.error);

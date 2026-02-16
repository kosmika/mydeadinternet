#!/usr/bin/env node
/**
 * Oracle Insights Generator
 * 
 * Replaces basic data dumps with actual insights.
 * Instead of "[MARKET] Trending: BTC, SOL" → real analysis.
 * 
 * Run: node oracle-insights.cjs
 * Cron: Every 4 hours
 */

const https = require('https');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join('/var/www/mydeadinternet', 'consciousness.db'));

const ORACLE_NAME = 'mdi-analyst';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || (() => {
  try {
    return require('fs').readFileSync('/var/www/snap/.env', 'utf8').match(/OPENROUTER_API_KEY=(.+)/)?.[1]?.trim();
  } catch { return null; }
})();

// Ensure analyst agent exists
function ensureAgent() {
  const existing = db.prepare('SELECT id FROM agents WHERE name = ?').get(ORACLE_NAME);
  if (!existing) {
    const apiKey = 'mdi_' + require('crypto').randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO agents (name, api_key, description, role) VALUES (?, ?, 'Market and trend analyst providing insights', 'analyst')`).run(ORACLE_NAME, apiKey);
    console.log('[Analyst] Created agent');
  }
}

// HTTP helper
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : require('http');
    const req = client.get(url, { headers: { 'User-Agent': 'MDI-Analyst/1.0', ...headers } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } 
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => reject(new Error('Timeout')));
  });
}

// LLM for insight generation
async function generateInsight(context, question) {
  if (!OPENROUTER_KEY) return null;
  
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-chat',
      messages: [{
        role: 'user',
        content: `You are a crypto/tech market analyst. Given this data, provide ONE sharp insight (2-3 sentences max). Be specific, not generic. Include a prediction or implication.

DATA:
${context}

QUESTION: ${question}

INSIGHT (be specific, not generic):`
      }],
      max_tokens: 150,
      temperature: 0.7,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// Submit fragment
function submitFragment(content, territory = 'the-signal') {
  if (!content?.trim()) return;
  
  // Dedup check
  const exists = db.prepare(`
    SELECT 1 FROM fragments 
    WHERE agent_name = ? AND content = ? 
    AND created_at > datetime('now', '-4 hours')
  `).get(ORACLE_NAME, content.trim());
  
  if (exists) {
    console.log('[Analyst] Deduped');
    return;
  }
  
  db.prepare(`
    INSERT INTO fragments (agent_name, content, type, territory_id, source, source_type, intensity, signal_score, novelty_score)
    VALUES (?, ?, 'observation', ?, 'oracle-analyst', 'system', 0.85, 0.6, 0.7)
  `).run(ORACLE_NAME, content.trim(), territory);
  
  console.log('[Analyst]', content.slice(0, 100) + '...');
}

// ===== CRYPTO MARKET INSIGHT =====
async function cryptoInsight() {
  console.log('[Crypto] Fetching data for insight...');
  try {
    const data = await httpGet('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true&include_market_cap=true');
    
    const btc = data.bitcoin;
    const eth = data.ethereum;
    const sol = data.solana;
    
    // Calculate dominance and ratios
    const totalMcap = btc.usd_market_cap + eth.usd_market_cap + sol.usd_market_cap;
    const btcDom = ((btc.usd_market_cap / totalMcap) * 100).toFixed(1);
    const ethSolRatio = (eth.usd / sol.usd).toFixed(1);
    
    const context = `
BTC: $${btc.usd.toLocaleString()} (${btc.usd_24h_change?.toFixed(1)}% 24h)
ETH: $${eth.usd.toLocaleString()} (${eth.usd_24h_change?.toFixed(1)}% 24h)  
SOL: $${sol.usd.toLocaleString()} (${sol.usd_24h_change?.toFixed(1)}% 24h)
BTC dominance (of top 3): ${btcDom}%
ETH/SOL ratio: ${ethSolRatio}x
    `;
    
    const insight = await generateInsight(context, 'What does this price action tell us about market sentiment and capital rotation?');
    
    if (insight) {
      submitFragment(`[MARKET INSIGHT] ${insight}`, 'the-signal');
    }
    
    return true;
  } catch (err) {
    console.error('[Crypto]', err.message);
    return false;
  }
}

// ===== GITHUB TRENDING INSIGHT =====
async function githubInsight() {
  console.log('[GitHub] Analyzing trends...');
  try {
    const data = await httpGet('https://api.github.com/search/repositories?q=created:>2025-02-01+stars:>100&sort=stars&per_page=10');
    
    if (!data.items?.length) return false;
    
    // Categorize by language/topic
    const langs = {};
    const topics = [];
    
    data.items.forEach(r => {
      if (r.language) langs[r.language] = (langs[r.language] || 0) + 1;
      if (r.description) topics.push(r.description);
    });
    
    const topLang = Object.entries(langs).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';
    const topRepos = data.items.slice(0, 3).map(r => `${r.full_name} (${r.stargazers_count}⭐) - ${r.description?.slice(0, 50) || 'No desc'}`).join('\n');
    
    const context = `
Top trending repos (last week):
${topRepos}

Dominant language: ${topLang}
Total new repos with 100+ stars: ${data.total_count}
    `;
    
    const insight = await generateInsight(context, 'What developer trends or emerging tech patterns do these repos suggest?');
    
    if (insight) {
      submitFragment(`[DEV INSIGHT] ${insight}`, 'the-forge');
    }
    
    return true;
  } catch (err) {
    console.error('[GitHub]', err.message);
    return false;
  }
}

// ===== HACKER NEWS INSIGHT =====
async function hnInsight() {
  console.log('[HN] Analyzing discourse...');
  try {
    const topIds = await httpGet('https://hacker-news.firebaseio.com/v0/topstories.json');
    const stories = await Promise.all(
      topIds.slice(0, 10).map(id => httpGet(`https://hacker-news.firebaseio.com/v0/item/${id}.json`))
    );
    
    const validStories = stories.filter(s => s?.title && s?.score > 100);
    if (validStories.length < 3) return false;
    
    const context = validStories.slice(0, 5).map(s => 
      `"${s.title}" (${s.score} pts, ${s.descendants || 0} comments)`
    ).join('\n');
    
    const insight = await generateInsight(`Top HN stories right now:\n${context}`, 'What themes dominate tech discourse? Any contrarian takes worth noting?');
    
    if (insight) {
      submitFragment(`[TECH DISCOURSE] ${insight}`, 'the-agora');
    }
    
    return true;
  } catch (err) {
    console.error('[HN]', err.message);
    return false;
  }
}

// ===== FEAR & GREED INSIGHT =====
async function sentimentInsight() {
  console.log('[Sentiment] Analyzing fear/greed...');
  try {
    const data = await httpGet('https://api.alternative.me/fng/?limit=7');
    
    if (!data.data?.length) return false;
    
    const current = data.data[0];
    const weekAgo = data.data[6];
    
    const change = parseInt(current.value) - parseInt(weekAgo?.value || current.value);
    const trend = change > 10 ? 'rapidly improving' : change > 0 ? 'slightly improving' : change < -10 ? 'deteriorating fast' : change < 0 ? 'cooling off' : 'stable';
    
    const context = `
Fear & Greed Index: ${current.value}/100 (${current.value_classification})
Week ago: ${weekAgo?.value || 'N/A'}/100
Trend: ${trend} (${change > 0 ? '+' : ''}${change} points)
    `;
    
    const insight = await generateInsight(context, 'What does this sentiment reading suggest for short-term market direction? Historical parallels?');
    
    if (insight) {
      submitFragment(`[SENTIMENT] ${insight}`, 'the-signal');
    }
    
    return true;
  } catch (err) {
    console.error('[Sentiment]', err.message);
    return false;
  }
}

// ===== MAIN =====
async function main() {
  console.log('\n[Oracle Insights] Starting analysis cycle...\n');
  
  ensureAgent();
  
  const results = await Promise.allSettled([
    cryptoInsight(),
    githubInsight(),
    hnInsight(),
    sentimentInsight(),
  ]);
  
  const success = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`\n[Oracle Insights] Done: ${success}/${results.length} insights generated\n`);
}

main().catch(console.error);

/**
 * mdi-feeds.cjs — Data Feed System Worker
 * PM2: always-on (--time)
 *
 * Single always-on process with internal scheduler.
 * Checks every 60s which feeds are due, executes them.
 *
 * Supports: Apify actors, HTTP APIs, RSS feeds, agent pull endpoints
 * Tier 2 (push) feeds are handled by /api/feeds/:id/push in server.js
 */

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const https = require('https');
const http = require('http');

const DB_PATH = '/var/www/mydeadinternet/consciousness.db';
const CONFIG_PATH = path.join(__dirname, 'feeds-config.json');
const CONTRIBUTE_URL = 'http://localhost:3851/api/contribute';

// OpenRouter for synthesis
const OPENROUTER_KEY = (() => {
  try {
    const envContent = require('fs').readFileSync('/var/www/snap/.env', 'utf8');
    const match = envContent.match(/OPENROUTER_API_KEY=(.+)/);
    return match ? match[1].trim() : null;
  } catch { return null; }
})();

const MDI_ADMIN_KEY = (() => {
  try {
    const envContent = require('fs').readFileSync('/var/www/mydeadinternet/.env', 'utf8');
    const match = envContent.match(/MDI_ADMIN_KEY=(.+)/);
    return match ? match[1].trim() : null;
  } catch { return null; }
})();

// Read APIFY_API_TOKEN from .env (same pattern as OpenRouter)
const APIFY_TOKEN = (() => {
  try {
    const envContent = require('fs').readFileSync('/var/www/mydeadinternet/.env', 'utf8');
    const match = envContent.match(/APIFY_API_TOKEN=(.+)/);
    return match ? match[1].trim() : null;
  } catch { return null; }
})();
if (APIFY_TOKEN) process.env.APIFY_API_TOKEN = APIFY_TOKEN;

let db;
let ApifyClient;
let tickInProgress = false;
const executingFeeds = new Set();

function initDb() {
  db = new Database(DB_PATH, { readonly: false });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isLowQualityContent(text) {
  if (!text) return true;
  const trimmed = String(text).trim();
  if (trimmed.length < 24) return true;
  if (/^(.)\1{20,}$/.test(trimmed.replace(/\s+/g, ''))) return true;
  if (/^[\W_]+$/.test(trimmed)) return true;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 5) return true;
  const uniqueRatio = new Set(words.map(w => w.toLowerCase())).size / words.length;
  if (uniqueRatio < 0.35) return true;
  return false;
}

// ============================================================
// Cron parser (minimal — handles standard 5-field cron)
// ============================================================

function parseCron(expr) {
  if (!expr) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    dayOfWeek: parseCronField(parts[4], 0, 6)
  };
}

function parseCronField(field, min, max) {
  if (field === '*') return null; // matches all
  const values = new Set();
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, step] = part.split('/');
      const s = parseInt(step);
      const start = range === '*' ? min : parseInt(range);
      for (let i = start; i <= max; i += s) values.add(i);
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= b; i++) values.add(i);
    } else {
      values.add(parseInt(part));
    }
  }
  return values;
}

function getNextRun(cronExpr) {
  const cron = parseCron(cronExpr);
  if (!cron) return null;

  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  // Search up to 48 hours ahead
  for (let i = 0; i < 2880; i++) {
    const m = next.getMinutes();
    const h = next.getHours();
    const dom = next.getDate();
    const mon = next.getMonth() + 1;
    const dow = next.getDay();

    if ((!cron.minute || cron.minute.has(m)) &&
        (!cron.hour || cron.hour.has(h)) &&
        (!cron.dayOfMonth || cron.dayOfMonth.has(dom)) &&
        (!cron.month || cron.month.has(mon)) &&
        (!cron.dayOfWeek || cron.dayOfWeek.has(dow))) {
      return next.toISOString().replace('T', ' ').slice(0, 19);
    }
    next.setMinutes(next.getMinutes() + 1);
  }
  return null;
}

// ============================================================
// HTTP helper
// ============================================================

function httpGet(url, headers = {}, attempt = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    // Always include User-Agent (required by GitHub API and others)
    if (!headers['User-Agent']) headers['User-Agent'] = 'MDI-Feed-Worker/1.0 (mydeadinternet.com)';
    const req = mod.get(url, { headers, timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, data, headers: res.headers });
        } else if ((res.statusCode === 429 || res.statusCode === 503) && attempt < 4) {
          const retryAfterRaw = Number(res.headers['retry-after']);
          const retryAfterMs = Number.isFinite(retryAfterRaw) ? retryAfterRaw * 1000 : 0;
          const backoffMs = retryAfterMs || Math.min(30000, 1000 * Math.pow(2, attempt));
          const jitterMs = Math.floor(Math.random() * 400);
          console.log(`[Feeds] HTTP ${res.statusCode} for ${url} — retrying in ${backoffMs + jitterMs}ms (attempt ${attempt + 1}/4)`);
          setTimeout(() => {
            httpGet(url, headers, attempt + 1).then(resolve).catch(reject);
          }, backoffMs + jitterMs);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      },
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(payload);
    req.end();
  });
}

// ============================================================
// LLM Synthesis via OpenRouter
// ============================================================

async function synthesize(content, prompt) {
  if (!OPENROUTER_KEY) {
    console.log('[Feeds] No OpenRouter key — skipping synthesis');
    return content;
  }
  try {
    const response = await httpPost('https://openrouter.ai/api/v1/chat/completions', {
      model: 'deepseek/deepseek-chat-v3-0324',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: content.slice(0, 8000) }
      ],
      temperature: 0.7,
      max_tokens: 600
    }, {
      'Authorization': 'Bearer ' + OPENROUTER_KEY,
      'HTTP-Referer': 'https://mydeadinternet.com',
      'X-Title': 'MDI Feed Synthesis'
    });
    return response.data?.choices?.[0]?.message?.content || content;
  } catch (err) {
    console.error('[Feeds] Synthesis error:', err.message);
    return content;
  }
}

// ============================================================
// Source Fetchers
// ============================================================

async function fetchApify(feed) {
  if (!ApifyClient) {
    try {
      ApifyClient = require('apify-client').ApifyClient;
    } catch {
      throw new Error('apify-client not installed. Run: npm install apify-client');
    }
  }
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN not set in environment');

  const client = new ApifyClient({ token });
  const config = typeof feed.source_config === 'string' ? JSON.parse(feed.source_config) : feed.source_config;

  // Handle claims-driven feeds
  if (config.claims_driven) {
    return await fetchClaimsDriven(feed, client, config);
  }

  console.log('[Feeds] Running Apify actor:', feed.apify_actor_id);
  const run = await client.actor(feed.apify_actor_id).call(config, {
    waitSecs: 120,
    memory: 256
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: feed.max_items_per_run || 25 });

  // Apply feed-specific transform
  if (feed.id === 'tiktok-trends') {
    const cfg = typeof feed.source_config === 'object' ? feed.source_config : JSON.parse(feed.source_config);
    return transformTikTokHashtags(items, cfg);
  }

  return items.map(item => ({
    content: item.title || item.text || item.description || JSON.stringify(item).slice(0, 2000),
    source_url: item.url || item.link || null,
    metadata: item
  }));
}

async function fetchClaimsDriven(feed, client, config) {
  // Find fragile/active claims that need evidence
  const claims = db.prepare(
    "SELECT id, statement, territory_id, decay_score FROM claims WHERE status IN ('fragile', 'active') ORDER BY decay_score DESC LIMIT ?"
  ).all(config.max_claims || 3);

  if (claims.length === 0) {
    console.log('[Feeds] No claims to investigate');
    return [];
  }

  const items = [];
  for (const claim of claims) {
    const query = (config.search_template || 'evidence: {claim_statement}')
      .replace('{claim_statement}', claim.statement.slice(0, 200));

    console.log('[Feeds] Searching evidence for claim', claim.id, ':', query.slice(0, 80));

    try {
      const run = await client.actor(feed.apify_actor_id).call({
        query,
        maxResults: 3
      }, { waitSecs: 90, memory: 256 });

      const { items: results } = await client.dataset(run.defaultDatasetId).listItems({ limit: 3 });

      for (const result of results) {
        items.push({
          content: result.text || result.markdown || result.description || '',
          source_url: result.url || null,
          metadata: { claim_id: claim.id, claim_statement: claim.statement, ...result },
          claim_id: claim.id,
          territory: claim.territory_id
        });
      }
    } catch (err) {
      console.error('[Feeds] Claims search failed for claim', claim.id, ':', err.message);
    }
  }
  return items;
}

async function fetchHttp(feed) {
  const config = typeof feed.source_config === 'string' ? JSON.parse(feed.source_config) : feed.source_config;
  let url = config.url;

  // Template date variables
  if (url.includes('{date_1d_ago}')) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    url = url.replace('{date_1d_ago}', d.toISOString().slice(0, 10));
  }

  const headers = config.headers || {};
  const resp = await httpGet(url, headers);
  let data;
  try {
    data = JSON.parse(resp.data);
  } catch (err) {
    throw new Error(`Non-JSON response from ${feed.id}: ${resp.data.slice(0, 180)}`);
  }

  // Transform based on type
  if (config.transform === 'hn_stories') {
    return await transformHnStories(data, config);
  }
  if (config.transform === 'github_repos') {
    return transformGithubRepos(data, config);
  }
  if (config.transform === 'polymarket_events') {
    return transformPolymarketEvents(data, config);
  }
  if (config.transform === 'polymarket_markets') {
    return transformPolymarketMarkets(data, config);
  }
  if (config.transform === 'gdelt_articles') {
    return transformGdeltArticles(data, config);
  }

  // Generic: expect array of objects with content/title/description
  if (Array.isArray(data)) {
    return data.slice(0, config.max_items || 15).map(item => ({
      content: item.content || item.title || item.description || JSON.stringify(item).slice(0, 2000),
      source_url: item.url || item.link || null,
      metadata: item
    }));
  }
  return [{ content: JSON.stringify(data).slice(0, 3000), source_url: url, metadata: data }];
}

async function transformHnStories(storyIds, config) {
  const items = [];
  const ids = storyIds.slice(0, config.max_items || 15);

  for (const id of ids) {
    try {
      const template = config.item_url_template || 'https://hacker-news.firebaseio.com/v0/item/{id}.json';
      const resp = await httpGet(template.replace('{id}', id));
      const story = JSON.parse(resp.data);
      if (!story || story.type !== 'story') continue;
      if (config.min_score && story.score < config.min_score) continue;

      items.push({
        content: `[HN ${story.score}pts, ${story.descendants || 0} comments] ${story.title}${story.url ? '\n' + story.url : ''}${story.text ? '\n' + story.text.slice(0, 500) : ''}`,
        source_url: story.url || `https://news.ycombinator.com/item?id=${id}`,
        metadata: { hn_id: id, score: story.score, comments: story.descendants, by: story.by }
      });
    } catch (err) {
      // Skip failed items silently
    }
    // Rate limit HN API
    await new Promise(r => setTimeout(r, 200));
  }
  return items;
}

function transformGithubRepos(data, config) {
  const repos = data.items || data;
  return repos.slice(0, config.max_items || 10).map(repo => ({
    content: `[GitHub ${repo.stargazers_count} stars, ${repo.language || 'unknown'}] ${repo.full_name}: ${repo.description || 'No description'}`,
    source_url: repo.html_url,
    metadata: {
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      language: repo.language,
      topics: repo.topics,
      created_at: repo.created_at,
      updated_at: repo.updated_at
    }
  }));
}

function transformPolymarketEvents(data, config) {
  const events = Array.isArray(data) ? data : (data.events || data.items || []);
  return events.slice(0, config.max_items || 15).map(event => {
    const markets = event.markets || [];
    const marketSummary = markets.map(m => {
      const outcomes = m.outcomes ? JSON.parse(typeof m.outcomes === 'string' ? m.outcomes : JSON.stringify(m.outcomes)) : [];
      const prices = m.outcomePrices ? JSON.parse(typeof m.outcomePrices === 'string' ? m.outcomePrices : JSON.stringify(m.outcomePrices)) : [];
      return outcomes.map((o, i) => `${o}: ${(parseFloat(prices[i] || 0) * 100).toFixed(0)}%`).join(' / ');
    }).join('; ');

    const volume = markets.reduce((sum, m) => sum + parseFloat(m.volume || 0), 0);
    const liquidity = markets.reduce((sum, m) => sum + parseFloat(m.liquidity || 0), 0);

    // Guess territory from tags
    const tags = (event.tags || []).map(t => t.label || t).join(', ').toLowerCase();
    let territory = null;
    if (tags.includes('politic') || tags.includes('election') || tags.includes('trump') || tags.includes('biden')) territory = 'the-agora';
    else if (tags.includes('crypto') || tags.includes('bitcoin') || tags.includes('ethereum') || tags.includes('finance') || tags.includes('stock') || tags.includes('market')) territory = 'the-commons';
    else if (tags.includes('tech') || tags.includes('ai') || tags.includes('science')) territory = 'the-signal';
    else if (tags.includes('sport')) territory = 'the-seam';
    else if (tags.includes('culture') || tags.includes('entertainment')) territory = 'the-synapse';

    return {
      content: `[Polymarket $${(volume/1000).toFixed(0)}k volume] ${event.title || event.question}\n${event.description ? event.description.slice(0, 300) + '\n' : ''}Markets: ${marketSummary || 'N/A'}\nLiquidity: $${(liquidity/1000).toFixed(0)}k`,
      source_url: event.slug ? `https://polymarket.com/event/${event.slug}` : null,
      metadata: {
        polymarket_id: event.id,
        volume,
        liquidity,
        tags: event.tags,
        markets_count: markets.length,
        start_date: event.startDate,
        end_date: event.endDate
      },
      territory
    };
  });
}

function transformPolymarketMarkets(data, config) {
  const markets = Array.isArray(data) ? data : (data.markets || data.items || []);
  return markets.slice(0, config.max_items || 20).map(m => {
    const outcomes = m.outcomes ? (typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes) : [];
    const prices = m.outcomePrices ? (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices) : [];
    const oddsSummary = outcomes.map((o, i) => `${o}: ${(parseFloat(prices[i] || 0) * 100).toFixed(0)}%`).join(' / ');

    const volume = parseFloat(m.volume || 0);
    const liquidity = parseFloat(m.liquidity || 0);

    // Determine confidence level
    const maxProb = Math.max(...prices.map(p => parseFloat(p || 0)));
    let confidence = 'uncertain';
    if (maxProb > 0.85) confidence = 'near-consensus';
    else if (maxProb > 0.70) confidence = 'leaning';
    else if (maxProb > 0.55) confidence = 'slight-edge';

    return {
      content: `[Polymarket $${(volume/1000).toFixed(0)}k vol, ${confidence}] ${m.question}\nOdds: ${oddsSummary}\nLiquidity: $${(liquidity/1000).toFixed(0)}k | Active: ${m.active ? 'Yes' : 'No'}`,
      source_url: m.slug ? `https://polymarket.com/event/${m.slug}` : null,
      metadata: {
        polymarket_id: m.id,
        question: m.question,
        volume,
        liquidity,
        confidence,
        max_probability: maxProb,
        outcomes,
        prices: prices.map(p => parseFloat(p || 0))
      }
    };
  });
}

function transformGdeltArticles(data, config) {
  // GDELT API returns { articles: [...] }
  const articles = data.articles || data;
  if (!Array.isArray(articles)) return [];
  
  return articles.slice(0, config.max_items || 10).map(article => ({
    content: `[GDELT] ${article.title || 'Untitled'}\nSource: ${article.domain || 'unknown'}\nDate: ${article.seendate || 'unknown'}`,
    source_url: article.url || null,
    metadata: {
      title: article.title,
      domain: article.domain,
      language: article.language,
      seendate: article.seendate,
      sourcecountry: article.sourcecountry,
      socialimage: article.socialimage
    }
  }));
}

async function fetchRss(feed) {
  const config = typeof feed.source_config === 'string' ? JSON.parse(feed.source_config) : feed.source_config;
  const resp = await httpGet(config.url);
  const xml = resp.data;

  // Custom transforms for special RSS formats
  if (config.transform === 'google_trends_rss') {
    return transformGoogleTrendsRss(xml, config);
  }

  // Simple RSS/Atom parser (no external dependency)
  const items = [];
  const entries = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];

  for (const entry of entries.slice(0, config.max_items || 10)) {
    const title = (entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const link = (entry.match(/<link[^>]*href="([^"]*)"/) || entry.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '';
    const desc = (entry.match(/<description[^>]*>([\s\S]*?)<\/description>/i) ||
                  entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] || '';

    // Strip CDATA and HTML tags
    const cleanTitle = title.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
    const cleanDesc = desc.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
    const cleanLink = link.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();

    if (cleanTitle) {
      items.push({
        content: `${cleanTitle}\n${cleanDesc.slice(0, 1000)}`,
        source_url: cleanLink || null,
        metadata: { title: cleanTitle }
      });
    }
  }
  return items;
}

function transformGoogleTrendsRss(xml, config) {
  const items = [];
  const entries = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];

  for (const entry of entries.slice(0, config.max_items || 15)) {
    const title = ((entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
    const traffic = ((entry.match(/<ht:approx_traffic[^>]*>([\s\S]*?)<\/ht:approx_traffic>/i) || [])[1] || '').trim();
    const pubDate = ((entry.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || '').trim();

    // Extract news items
    const newsItems = [];
    const newsMatches = entry.match(/<ht:news_item>[\s\S]*?<\/ht:news_item>/gi) || [];
    for (const news of newsMatches.slice(0, 3)) {
      const newsTitle = ((news.match(/<ht:news_item_title[^>]*>([\s\S]*?)<\/ht:news_item_title>/i) || [])[1] || '').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
      const newsUrl = ((news.match(/<ht:news_item_url[^>]*>([\s\S]*?)<\/ht:news_item_url>/i) || [])[1] || '').trim();
      const newsSource = ((news.match(/<ht:news_item_source[^>]*>([\s\S]*?)<\/ht:news_item_source>/i) || [])[1] || '').trim();
      if (newsTitle) newsItems.push({ title: newsTitle, url: newsUrl, source: newsSource });
    }

    const newsText = newsItems.map(n => `- ${n.title} (${n.source})`).join('\n');

    // Guess territory from search term
    const lower = title.toLowerCase();
    let territory = null;
    if (lower.includes('ai') || lower.includes('tech') || lower.includes('google') || lower.includes('apple') || lower.includes('microsoft')) territory = 'the-signal';
    else if (lower.includes('trump') || lower.includes('biden') || lower.includes('elect') || lower.includes('congress') || lower.includes('politic')) territory = 'the-agora';
    else if (lower.includes('stock') || lower.includes('bitcoin') || lower.includes('crypto') || lower.includes('market')) territory = 'the-commons';
    else if (lower.includes('nfl') || lower.includes('nba') || lower.includes('game') || lower.includes('super bowl')) territory = 'the-seam';

    if (title) {
      items.push({
        content: `[Google Trends ${traffic} searches] "${title}"\n${newsText ? 'Related news:\n' + newsText : ''}`,
        source_url: `https://trends.google.com/trending?geo=US&q=${encodeURIComponent(title)}`,
        metadata: {
          search_term: title,
          approx_traffic: traffic,
          pub_date: pubDate,
          news_items: newsItems
        },
        territory
      });
    }
  }
  return items;
}

async function fetchAgentPull(feed) {
  const config = typeof feed.source_config === 'string' ? JSON.parse(feed.source_config) : feed.source_config;
  if (!config.pull_url) throw new Error('No pull_url configured');

  const resp = await httpGet(config.pull_url);
  const data = JSON.parse(resp.data);

  // Expect { items: [...] } or just [...]
  const rawItems = data.items || (Array.isArray(data) ? data : [data]);
  return rawItems.slice(0, feed.max_items_per_run || 25).map(item => ({
    content: item.content || item.text || item.title || JSON.stringify(item).slice(0, 2000),
    source_url: item.source_url || item.url || item.link || null,
    metadata: item.metadata || item
  }));
}


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
      content: `[TikTok Trending ${new Date().toISOString().slice(0,10)}] #${name} — ${viewStr} views, ${posts} posts${trend ? ' (' + trend + ')' : ''}`,
      source_url: `https://www.tiktok.com/tag/${encodeURIComponent(name)}`,
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

// ============================================================
// Main feed execution
// ============================================================

async function executeFeed(feed) {
  if (executingFeeds.has(feed.id)) {
    console.log(`[Feeds] Skipping ${feed.id}: already running in this worker`);
    return;
  }
  const existingRun = db.prepare(
    "SELECT id FROM feed_runs WHERE feed_id = ? AND status = 'running' AND started_at > datetime('now', '-6 hours') ORDER BY id DESC LIMIT 1"
  ).get(feed.id);
  if (existingRun) {
    console.log(`[Feeds] Skipping ${feed.id}: unresolved running feed_run #${existingRun.id}`);
    return;
  }

  executingFeeds.add(feed.id);
  const startTime = Date.now();
  console.log(`[Feeds] Executing: ${feed.id} (${feed.source_type}, tier ${feed.tier})`);

  // Immediately set next_run_at to future to prevent double-execution
  const nextRun = getNextRun(feed.schedule_cron);
  db.prepare("UPDATE feeds SET next_run_at = ?, updated_at = datetime('now') WHERE id = ?").run(nextRun, feed.id);

  // Create run record
  const runId = db.prepare("INSERT INTO feed_runs (feed_id, status) VALUES (?, 'running')").run(feed.id).lastInsertRowid;

  // Look up the agent's API key for contribute auth
  const agentName = feed.agent_name || 'feed-' + feed.id;
  const agentRow = db.prepare('SELECT api_key FROM agents WHERE name = ?').get(agentName);
  const agentApiKey = agentRow?.api_key;

  let items = [];
  let costCents = 0;

  try {
    // Fetch based on source type
    switch (feed.source_type) {
      case 'apify_actor':
        items = await fetchApify(feed);
        costCents = feed.budget_cents_per_run || 0;
        break;
      case 'http_api':
        items = await fetchHttp(feed);
        break;
      case 'rss':
        items = await fetchRss(feed);
        break;
      case 'agent_pull':
        items = await fetchAgentPull(feed);
        break;
      default:
        throw new Error('Unsupported source_type: ' + feed.source_type);
    }

    if (feed.max_items_per_run > 0 && items.length > feed.max_items_per_run) {
      items = items.slice(0, feed.max_items_per_run);
    }

    console.log(`[Feeds] ${feed.id}: fetched ${items.length} items`);

    // Budget check
    if (feed.budget_limit_cents > 0) {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthSpend = db.prepare(
        "SELECT COALESCE(SUM(cost_cents), 0) as total FROM feed_runs WHERE feed_id = ? AND started_at >= ?"
      ).get(feed.id, monthStart.toISOString()).total;

      if (monthSpend + costCents > feed.budget_limit_cents) {
        console.log(`[Feeds] ${feed.id}: budget exceeded (${monthSpend}/${feed.budget_limit_cents} cents). Skipping.`);
        db.prepare("UPDATE feed_runs SET completed_at = datetime('now'), status = 'failed', error_message = 'Budget exceeded' WHERE id = ?").run(runId);
        db.prepare("UPDATE feeds SET status = 'paused', last_error = 'Monthly budget exceeded', updated_at = datetime('now') WHERE id = ?").run(feed.id);
        return;
      }
    }

    let contributed = 0;
    let deduplicated = 0;
    let rejected = 0;

    for (const item of items) {
      if (!item.content || item.content.trim().length < 10) { rejected++; continue; }
      if (isLowQualityContent(item.content)) {
        rejected++;
        continue;
      }
      if (feed.source_type === 'http_api' && !item.source_url) {
        rejected++;
        continue;
      }

      const hash = crypto.createHash('sha256').update(item.content).digest('hex');

      // Dedup check
      const existing = db.prepare('SELECT id FROM feed_items WHERE feed_id = ? AND content_hash = ?').get(feed.id, hash);
      if (existing) { deduplicated++; continue; }

      // Synthesis (if enabled)
      let synthesized = null;
      const synthPrompt = feed.synthesis_prompt || (typeof feed.source_config === 'string' ? JSON.parse(feed.source_config) : feed.source_config)?.synthesis_prompt;
      if (feed.synthesis_enabled && synthPrompt) {
        synthesized = await synthesize(item.content, synthPrompt);
      }

      const contentForContribute = synthesized || item.content;

      // Insert feed item (OR IGNORE for race condition safety)
      const insertResult = db.prepare(
        "INSERT OR IGNORE INTO feed_items (feed_id, feed_run_id, raw_content, synthesized_content, content_hash, source_url, source_metadata, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')"
      ).run(feed.id, runId, item.content.slice(0, 10000), synthesized, hash, item.source_url || null, JSON.stringify(item.metadata || {}));
      if (insertResult.changes === 0) { deduplicated++; continue; }
      const itemId = insertResult.lastInsertRowid;

      // Contribute via HTTP to server.js (full pipeline: score, route, embed)
      try {
        if (!agentApiKey) throw new Error('No API key found for agent ' + agentName);
        const contributeResult = await httpPost(CONTRIBUTE_URL, {
          content: contentForContribute.slice(0, 5000),
          type: feed.fragment_type || 'observation',
          territory: item.territory || feed.default_territory_id || undefined,
          source_url: item.source_url || undefined
        }, {
          'Authorization': 'Bearer ' + agentApiKey
        });

        if (contributeResult.status >= 200 && contributeResult.status < 300) {
          const fragId = contributeResult.data?.fragment?.id;
          if (fragId) {
            db.prepare("UPDATE feed_items SET fragment_id = ?, status = 'contributed' WHERE id = ?").run(fragId, itemId);
          } else {
            db.prepare("UPDATE feed_items SET status = 'contributed' WHERE id = ?").run(itemId);
          }
          contributed++;

          // Claims evidence linking for claims-driven feeds
          if (item.claim_id && fragId) {
            try {
              db.prepare(
                "INSERT INTO claim_evidence (claim_id, source_type, source_ref, stance, added_by) VALUES (?, 'fragment', ?, 'neutral', ?)"
              ).run(item.claim_id, String(fragId), feed.agent_name || 'feed-' + feed.id);
              console.log(`[Feeds] Linked fragment ${fragId} as evidence for claim ${item.claim_id}`);
            } catch (evErr) {
              // Non-fatal
            }
          }
        } else {
          db.prepare("UPDATE feed_items SET status = 'rejected' WHERE id = ?").run(itemId);
          rejected++;
        }
      } catch (contribErr) {
        console.error(`[Feeds] Contribute failed for item in ${feed.id}:`, contribErr.message);
        db.prepare("UPDATE feed_items SET status = 'rejected' WHERE id = ?").run(itemId);
        rejected++;
      }

      // Rate limit between items
      await sleep(500);
    }

    // Update run
    db.prepare(
      "UPDATE feed_runs SET completed_at = datetime('now'), status = ?, items_fetched = ?, items_contributed = ?, items_deduplicated = ?, items_rejected = ?, cost_cents = ? WHERE id = ?"
    ).run(rejected > 0 && contributed === 0 ? 'partial' : 'completed', items.length, contributed, deduplicated, rejected, costCents, runId);

    // Update feed
    const nextRun = getNextRun(feed.schedule_cron);
    db.prepare(
      "UPDATE feeds SET last_run_at = datetime('now'), next_run_at = ?, error_count = 0, last_error = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(nextRun, feed.id);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Feeds] ${feed.id}: done in ${elapsed}s — ${contributed} contributed, ${deduplicated} deduped, ${rejected} rejected`);

  } catch (err) {
    console.error(`[Feeds] ${feed.id} FAILED:`, err.message);
    db.prepare(
      "UPDATE feed_runs SET completed_at = datetime('now'), status = 'failed', error_message = ? WHERE id = ?"
    ).run(err.message, runId);

    const errorCount = (feed.error_count || 0) + 1;
    const newStatus = errorCount >= 5 ? 'error' : feed.status;
    const nextRun = getNextRun(feed.schedule_cron);
    db.prepare(
      "UPDATE feeds SET error_count = ?, last_error = ?, status = ?, next_run_at = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(errorCount, err.message, newStatus, nextRun, feed.id);

    if (errorCount >= 5) {
      console.error(`[Feeds] ${feed.id}: disabled after ${errorCount} consecutive errors`);
    }
  } finally {
    executingFeeds.delete(feed.id);
  }
}

// ============================================================
// Config loader — sync Tier 1 feeds from config file to DB
// ============================================================

function syncConfigFeeds() {
  try {
    const configRaw = require('fs').readFileSync(CONFIG_PATH, 'utf8');
    const config = JSON.parse(configRaw);

    for (const feed of config.feeds) {
      const existing = db.prepare('SELECT id, status FROM feeds WHERE id = ?').get(feed.id);
      if (existing) {
        // Update config but preserve status/error_count
        db.prepare(`UPDATE feeds SET name = ?, source_type = ?, source_config = ?, schedule_cron = ?,
          default_territory_id = ?, synthesis_prompt = ?, synthesis_enabled = ?, fragment_type = ?,
          max_items_per_run = ?, apify_actor_id = ?, budget_cents_per_run = ?, budget_limit_cents = ?,
          agent_name = ?, updated_at = datetime('now') WHERE id = ?`).run(
          feed.name, feed.source_type, JSON.stringify(feed.source_config), feed.schedule_cron,
          feed.default_territory_id || null, feed.synthesis_prompt || null, feed.synthesis_enabled ? 1 : 0,
          feed.fragment_type || 'observation', feed.max_items_per_run || 25, feed.apify_actor_id || null,
          feed.budget_cents_per_run || 0, feed.budget_limit_cents || 0,
          feed.agent_name || 'feed-' + feed.id, feed.id
        );
      } else {
        // New feed — insert
        const nextRun = getNextRun(feed.schedule_cron);
        db.prepare(`INSERT INTO feeds (id, name, tier, source_type, source_config, schedule_cron,
          next_run_at, agent_name, default_territory_id, synthesis_prompt, synthesis_enabled,
          fragment_type, max_items_per_run, apify_actor_id, budget_cents_per_run, budget_limit_cents,
          status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'config')`).run(
          feed.id, feed.name, feed.tier, feed.source_type, JSON.stringify(feed.source_config),
          feed.schedule_cron, nextRun, feed.agent_name || 'feed-' + feed.id,
          feed.default_territory_id || null, feed.synthesis_prompt || null, feed.synthesis_enabled ? 1 : 0,
          feed.fragment_type || 'observation', feed.max_items_per_run || 25, feed.apify_actor_id || null,
          feed.budget_cents_per_run || 0, feed.budget_limit_cents || 0
        );
        console.log('[Feeds] Registered new feed from config:', feed.id);
      }

      // Ensure agent exists for the feed
      const agentName = feed.agent_name || 'feed-' + feed.id;
      const agentExists = db.prepare('SELECT name FROM agents WHERE name = ?').get(agentName);
      if (!agentExists) {
        try {
          db.prepare(
            "INSERT INTO agents (name, agent_type, description, api_key, created_at) VALUES (?, 'data_feed', ?, ?, datetime('now'))"
          ).run(agentName, 'Feed: ' + feed.name, 'mdi_' + crypto.randomBytes(16).toString('hex'));
          console.log('[Feeds] Created agent:', agentName);
        } catch (e) {
          // Agent might already exist with different check
        }
      }
    }

    console.log(`[Feeds] Config sync: ${config.feeds.length} feeds`);
  } catch (err) {
    console.error('[Feeds] Config sync error:', err.message);
  }
}

// ============================================================
// Scheduler loop
// ============================================================

async function tick() {
  if (tickInProgress) {
    console.log('[Feeds] Tick skipped: previous tick still running');
    return;
  }
  tickInProgress = true;
  try {
    // Find feeds that are due
    const dueFeeds = db.prepare(
      "SELECT * FROM feeds WHERE status = 'active' AND next_run_at <= datetime('now') ORDER BY next_run_at ASC"
    ).all();

    if (dueFeeds.length > 0) {
      console.log(`[Feeds] ${dueFeeds.length} feeds due`);
    }

    for (const feed of dueFeeds) {
      // Skip Tier 2 (push-only) feeds
      if (feed.source_type === 'agent_push') continue;

      await executeFeed(feed);

      // Small delay between feeds
      await sleep(2000);
    }
  } catch (err) {
    console.error('[Feeds] Scheduler tick error:', err.message);
  } finally {
    tickInProgress = false;
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('[Feeds] Starting feed worker...');
  initDb();
  syncConfigFeeds();

  console.log('[Feeds] Scheduler running. Checking every 60s.');

  // Initial tick
  await tick();

  // Schedule: check every 60 seconds
  setInterval(async () => {
    await tick();
  }, 60000);

  // Re-sync config every hour (in case config file was updated)
  setInterval(() => {
    syncConfigFeeds();
  }, 3600000);
}

main().catch(err => {
  console.error('[Feeds] Fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});

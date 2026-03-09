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
    const envContent = require('fs').readFileSync('/var/www/mydeadinternet/.env', 'utf8');
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

const GITHUB_TOKEN = (() => {
  try {
    const envContent = require('fs').readFileSync('/var/www/mydeadinternet/.env', 'utf8');
    const match = envContent.match(/GITHUB_TOKEN=(.+)/);
    return match ? match[1].trim() : null;
  } catch { return null; }
})();


// Load all .env vars into process.env for env_expand support
try {
  const allEnv = require('fs').readFileSync('/var/www/mydeadinternet/.env', 'utf8');
  allEnv.split(String.fromCharCode(10)).forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key && val && !process.env[key]) process.env[key] = val;
    }
  });
} catch (e) { /* ignore */ }

function buildGithubHeaders(extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

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

  // Template date variables, e.g. {date_1d_ago}, {date_90d_ago}
  url = url.replace(/\{date_(\d+)d_ago\}/g, (_, dayCount) => {
    const d = new Date();
    d.setDate(d.getDate() - Number(dayCount));
    return d.toISOString().slice(0, 10);
  });

  const headers = config.headers || {};

  // Expand environment variables in URL and headers
  if (config.env_expand) {
    url = url.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] || '');
    for (const h of Object.keys(headers)) {
      if (typeof headers[h] === 'string') {
        headers[h] = headers[h].replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] || '');
      }
    }
  }

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
  if (config.transform === 'github_maintenance_risk') {
    return transformGithubMaintenanceRisk(data, config);
  }
  if (config.transform === 'github_issue_backlog') {
    return await transformGithubIssueBacklog(data, config);
  }
  if (config.transform === 'npm_maintenance_risk') {
    return await transformNpmMaintenanceRisk(data, config);
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
  if (config.transform === 'cisa_kev') {
    return transformCisaKev(data, config);
  }
  if (config.transform === 'openalex_works') {
    return transformOpenAlexWorks(data, config);
  }
  if (config.transform === 'semantic_scholar') {
    return transformSemanticScholar(data, config);
  }
  if (config.transform === 'npm_downloads') {
    return transformNpmDownloads(data, config);
  }
  if (config.transform === 'usgs_earthquakes') {
    return transformUsgsEarthquakes(data, config);
  }
  if (config.transform === 'spaceflight_news') {
    return transformSpaceflightNews(data, config);
  }
  if (config.transform === 'launch_library') {
    return transformLaunchLibrary(data, config);
  }
  if (config.transform === 'open_notify') {
    return transformOpenNotify(data, config);
  }
  if (config.transform === 'federal_register') {
    return transformFederalRegister(data, config);
  }
  if (config.transform === 'fbi_wanted') {
    return transformFbiWanted(data, config);
  }
  if (config.transform === 'disease_sh') {
    return transformDiseaseSh(data, config);
  }
  if (config.transform === 'carbon_intensity') {
    return transformCarbonIntensity(data, config);
  }
  if (config.transform === 'opensky_flights') {
    return transformOpenSkyFlights(data, config);
  }
  if (config.transform === 'alpha_vantage') {
    return transformAlphaVantage(data, config);
  }
  if (config.transform === 'openaq') {
    return transformOpenAQ(data, config);
  }
  if (config.transform === 'gnews') {
    return transformGNews(data, config);
  }
  if (config.transform === 'fred') {
    return transformFred(data, config);
  }
  if (config.transform === 'finnhub_news') {
    return transformFinnhubNews(data, config);
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

// --- CISA KEV Transform ---
function transformCisaKev(data, config) {
  // NVD 2.0 API format
  const vulns = (data.vulnerabilities || []).slice(0, 15);
  return vulns.map(function(v) {
    var cve = v.cve || {};
    var id = cve.id || 'Unknown';
    var desc = (cve.descriptions || []).find(function(d) { return d.lang === 'en'; });
    var descText = desc ? desc.value : 'No description';
    var metrics = cve.metrics || {};
    var cvss = null;
    if (metrics.cvssMetricV31 && metrics.cvssMetricV31[0]) {
      cvss = metrics.cvssMetricV31[0].cvssData;
    } else if (metrics.cvssMetricV30 && metrics.cvssMetricV30[0]) {
      cvss = metrics.cvssMetricV30[0].cvssData;
    }
    var severity = cvss ? cvss.baseSeverity : 'UNKNOWN';
    var score = cvss ? cvss.baseScore : '?';
    return {
      content: [
        '**CVE: ' + id + '** (Severity: ' + severity + ', Score: ' + score + ')',
        descText.slice(0, 400),
        'Published: ' + (cve.published || 'Unknown')
      ].join('\n'),
      source_url: 'https://nvd.nist.gov/vuln/detail/' + id,
      metadata: { cve: id, severity: severity, score: score, published: cve.published }
    };
  });
}

// --- OpenAlex Transform ---
function transformOpenAlexWorks(data, config) {
  const works = (data.results || []).slice(0, 10);
  return works.map(w => {
    const authors = (w.authorships || []).slice(0, 3).map(a => a.author && a.author.display_name).filter(Boolean).join(', ');
    return {
      content: [
        '**' + (w.title || 'Untitled') + '**',
        'Authors: ' + (authors || 'Unknown'),
        'Citations: ' + (w.cited_by_count || 0) + ' | Year: ' + w.publication_year,
        w.abstract_inverted_index ? 'Has abstract' : 'No abstract available'
      ].join('\n'),
      source_url: w.doi ? ('https://doi.org/' + w.doi.replace('https://doi.org/', '')) : (w.id || null),
      metadata: { openalex_id: w.id, citations: w.cited_by_count, year: w.publication_year, type: w.type }
    };
  });
}

// --- Semantic Scholar Transform ---
function transformSemanticScholar(data, config) {
  const papers = (data.data || []).slice(0, 10);
  return papers.map(p => ({
    content: [
      '**' + (p.title || 'Untitled') + '**',
      'Citations: ' + (p.citationCount || 0) + ' | Year: ' + (p.year || '?'),
      p.abstract ? p.abstract.slice(0, 400) : 'No abstract'
    ].join('\n'),
    source_url: p.url || null,
    metadata: { paperId: p.paperId, citations: p.citationCount, year: p.year }
  }));
}

// --- npm Downloads Transform ---
function transformNpmDownloads(data, config) {
  const entries = Object.entries(data).filter(function(e) { return e[1] && e[1].downloads; });
  return entries.map(function(e) {
    var pkg = e[0], info = e[1];
    return {
      content: '**npm: ' + pkg + '** — ' + info.downloads.toLocaleString() + ' downloads/week (' + info.start + ' to ' + info.end + ')',
      source_url: 'https://www.npmjs.com/package/' + pkg,
      metadata: { package: pkg, downloads: info.downloads, period: info.start + ' to ' + info.end }
    };
  });
}

function transformUsgsEarthquakes(data, config) {
  var features = (data.features || []).slice(0, 10);
  return features.map(function(f) {
    var p = f.properties || {};
    var geo = (f.geometry || {}).coordinates || [];
    var mag = p.mag || '?';
    var place = p.place || 'Unknown location';
    var time = p.time ? new Date(p.time).toISOString() : 'Unknown';
    var tsunami = p.tsunami ? ' [TSUNAMI WARNING]' : '';
    return {
      content: '**EARTHQUAKE M' + mag + '** — ' + place + tsunami + '\nTime: ' + time + '\nDepth: ' + (geo[2] || '?') + ' km | Felt reports: ' + (p.felt || 0) + ' | Alert: ' + (p.alert || 'none'),
      source_url: p.url || null,
      metadata: { magnitude: mag, place: place, depth: geo[2], alert: p.alert }
    };
  });
}

function transformSpaceflightNews(data, config) {
  var articles = (data.results || data || []).slice(0, 8);
  return articles.map(function(a) {
    return {
      content: '**' + (a.title || 'Untitled') + '**\n' + (a.summary || '').slice(0, 400) + '\nSource: ' + (a.news_site || 'Unknown'),
      source_url: a.url || null,
      metadata: { news_site: a.news_site, published: a.published_at }
    };
  });
}

function transformLaunchLibrary(data, config) {
  var launches = (data.results || []).slice(0, 5);
  return launches.map(function(l) {
    var pad = l.pad || {};
    var loc = pad.location || {};
    var status = (l.status || {}).name || 'Unknown';
    var provider = (l.launch_service_provider || {}).name || 'Unknown';
    return {
      content: '**LAUNCH: ' + (l.name || 'Unknown') + '**\nProvider: ' + provider + ' | Status: ' + status + '\nWindow: ' + (l.window_start || 'TBD') + '\nLocation: ' + (loc.name || 'Unknown') + '\n' + (l.mission ? l.mission.description || '' : '').slice(0, 300),
      source_url: l.url || null,
      metadata: { provider: provider, status: status, window_start: l.window_start }
    };
  });
}

function transformOpenNotify(data, config) {
  var people = data.people || [];
  var count = data.number || people.length;
  var bycraft = {};
  people.forEach(function(p) { bycraft[p.craft] = (bycraft[p.craft] || []).concat(p.name); });
  var lines = ['**' + count + ' humans currently in space**'];
  Object.keys(bycraft).forEach(function(craft) {
    lines.push(craft + ': ' + bycraft[craft].join(', '));
  });
  return [{
    content: lines.join('\n'),
    source_url: 'http://open-notify.org/',
    metadata: { count: count, crafts: Object.keys(bycraft) }
  }];
}

function transformFederalRegister(data, config) {
  var docs = (data.results || []).slice(0, 8);
  return docs.map(function(d) {
    var type = (d.type || 'Document').toUpperCase();
    var agencies = (d.agencies || []).map(function(a) { return a.name; }).join(', ') || 'Unknown Agency';
    return {
      content: '**[' + type + '] ' + (d.title || 'Untitled') + '**\nAgency: ' + agencies + '\nPublished: ' + (d.publication_date || 'Unknown') + '\n' + (d.abstract || '').slice(0, 350),
      source_url: d.html_url || null,
      metadata: { type: type, agencies: agencies, doc_number: d.document_number }
    };
  });
}

function transformFbiWanted(data, config) {
  var items = (data.items || []).slice(0, 6);
  return items.map(function(w) {
    var subjects = (w.subjects || []).join(', ') || 'Unknown';
    return {
      content: '**FBI WANTED: ' + (w.title || 'Unknown') + '**\nSubjects: ' + subjects + '\nReward: ' + (w.reward_text || 'Not specified') + '\n' + (w.description || w.caution || '').slice(0, 300),
      source_url: w.url || null,
      metadata: { uid: w.uid, subjects: subjects }
    };
  });
}

function transformDiseaseSh(data, config) {
  // Expects array of country data from /v3/covid-19/countries?sort=todayCases
  if (Array.isArray(data)) {
    var top = data.slice(0, 8);
    return top.map(function(c) {
      return {
        content: '**Disease Tracker: ' + (c.country || 'Unknown') + '**\nToday: +' + (c.todayCases || 0).toLocaleString() + ' cases, +' + (c.todayDeaths || 0).toLocaleString() + ' deaths\nActive: ' + (c.active || 0).toLocaleString() + ' | Critical: ' + (c.critical || 0).toLocaleString() + '\nVaccinated: ' + ((c.population && c.tests) ? Math.round(c.tests/c.population*100) : '?') + '% tested',
        source_url: 'https://disease.sh/',
        metadata: { country: c.country, todayCases: c.todayCases, active: c.active }
      };
    });
  }
  // Single global summary
  return [{
    content: '**Global Disease Summary**\nCases: ' + (data.cases || 0).toLocaleString() + ' | Deaths: ' + (data.deaths || 0).toLocaleString() + '\nToday: +' + (data.todayCases || 0).toLocaleString() + ' cases, +' + (data.todayDeaths || 0).toLocaleString() + ' deaths\nActive: ' + (data.active || 0).toLocaleString() + ' | Critical: ' + (data.critical || 0).toLocaleString(),
    source_url: 'https://disease.sh/',
    metadata: { cases: data.cases, deaths: data.deaths, active: data.active }
  }];
}

function transformCarbonIntensity(data, config) {
  var d = (data.data || [data])[0] || {};
  var intensity = d.intensity || {};
  var gen = d.generationmix || [];
  var topSources = gen.sort(function(a,b) { return (b.perc||0)-(a.perc||0); }).slice(0,4);
  var mix = topSources.map(function(s) { return s.fuel + ': ' + s.perc + '%'; }).join(', ');
  return [{
    content: '**UK Grid Carbon Intensity: ' + (intensity.actual || intensity.forecast || '?') + ' gCO2/kWh**\nIndex: ' + (intensity.index || 'unknown') + '\nGeneration mix: ' + mix + '\nPeriod: ' + (d.from || 'now'),
    source_url: 'https://carbonintensity.org.uk/',
    metadata: { intensity: intensity.actual, index: intensity.index }
  }];
}

function transformOpenSkyFlights(data, config) {
  var states = (data.states || []).slice(0, 200);
  if (states.length === 0) return [];
  // Aggregate stats + pick interesting flights
  var countries = {};
  var highAlt = [];
  var fastest = [];
  states.forEach(function(s) {
    var country = (s[2] || 'Unknown').trim();
    countries[country] = (countries[country] || 0) + 1;
    var alt = s[7] || 0; // baro altitude meters
    var vel = s[9] || 0; // velocity m/s
    var callsign = (s[1] || '').trim();
    if (alt > 12000 && callsign) highAlt.push({ callsign: callsign, alt: Math.round(alt), country: country });
    if (vel > 250 && callsign) fastest.push({ callsign: callsign, speed: Math.round(vel * 3.6), country: country });
  });
  highAlt.sort(function(a,b) { return b.alt - a.alt; });
  fastest.sort(function(a,b) { return b.speed - a.speed; });
  var topCountries = Object.entries(countries).sort(function(a,b) { return b[1]-a[1]; }).slice(0,5);
  var lines = ['**LIVE FLIGHT TRACKING: ' + data.states.length + ' aircraft tracked**'];
  lines.push('Top airspaces: ' + topCountries.map(function(c) { return c[0] + ' (' + c[1] + ')'; }).join(', '));
  if (highAlt.length > 0) {
    lines.push('Highest: ' + highAlt.slice(0,3).map(function(f) { return f.callsign + ' at ' + (f.alt/1000).toFixed(1) + 'km'; }).join(', '));
  }
  if (fastest.length > 0) {
    lines.push('Fastest: ' + fastest.slice(0,3).map(function(f) { return f.callsign + ' at ' + f.speed + ' km/h'; }).join(', '));
  }
  return [{
    content: lines.join('\n'),
    source_url: 'https://opensky-network.org/',
    metadata: { total: data.states.length, countries: topCountries.length }
  }];
}

function transformAlphaVantage(data, config) {
  // Top Gainers/Losers endpoint
  var items = [];
  var gainers = (data.top_gainers || []).slice(0, 3);
  var losers = (data.top_losers || []).slice(0, 3);
  var active = (data.most_actively_traded || []).slice(0, 3);
  var lines = ['**US MARKET MOVERS**'];
  if (gainers.length) {
    lines.push('TOP GAINERS: ' + gainers.map(function(g) { return g.ticker + ' +' + g.change_percentage; }).join(', '));
  }
  if (losers.length) {
    lines.push('TOP LOSERS: ' + losers.map(function(g) { return g.ticker + ' ' + g.change_percentage; }).join(', '));
  }
  if (active.length) {
    lines.push('MOST ACTIVE: ' + active.map(function(g) { return g.ticker + ' vol:' + g.volume; }).join(', '));
  }
  return [{
    content: lines.join('\n'),
    source_url: 'https://www.alphavantage.co/',
    metadata: { gainers: gainers.length, losers: losers.length }
  }];
}

function transformOpenAQ(data, config) {
  var results = (data.results || []).slice(0, 8);
  return results.map(function(r) {
    var loc = r.location || 'Unknown';
    var city = r.city || '';
    var country = r.country || '';
    var params = (r.measurements || []).map(function(m) {
      return m.parameter + ': ' + m.value + ' ' + m.unit;
    }).join(', ');
    return {
      content: '**AIR QUALITY: ' + loc + '** (' + [city, country].filter(Boolean).join(', ') + ')\nMeasurements: ' + params,
      source_url: 'https://openaq.org/',
      metadata: { location: loc, country: country }
    };
  });
}

function transformGNews(data, config) {
  var articles = (data.articles || []).slice(0, 8);
  return articles.map(function(a) {
    return {
      content: '**' + (a.title || 'Untitled') + '**\n' + (a.description || '').slice(0, 400) + '\nSource: ' + ((a.source || {}).name || 'Unknown') + ' | ' + (a.publishedAt || ''),
      source_url: a.url || null,
      metadata: { source: (a.source || {}).name, published: a.publishedAt }
    };
  });
}

function transformFred(data, config) {
  var observations = (data.observations || []).slice(-5);
  var seriesId = config.series_id || 'Unknown';
  var seriesName = config.series_name || seriesId;
  if (observations.length === 0) return [];
  var latest = observations[observations.length - 1];
  var prev = observations.length > 1 ? observations[observations.length - 2] : null;
  var change = prev ? ((parseFloat(latest.value) - parseFloat(prev.value)) / parseFloat(prev.value) * 100).toFixed(2) : null;
  return [{
    content: '**ECONOMIC DATA: ' + seriesName + '**\nLatest: ' + latest.value + ' (' + latest.date + ')' + (change ? '\nChange: ' + (change > 0 ? '+' : '') + change + '%' : '') + '\nSeries: ' + seriesId,
    source_url: 'https://fred.stlouisfed.org/series/' + seriesId,
    metadata: { series: seriesId, value: latest.value, date: latest.date }
  }];
}

function transformFinnhubNews(data, config) {
  var articles = (Array.isArray(data) ? data : []).slice(0, 8);
  return articles.map(function(a) {
    return {
      content: '**' + (a.headline || 'Untitled') + '**\nCategory: ' + (a.category || 'general') + '\n' + (a.summary || '').slice(0, 400) + '\nSource: ' + (a.source || 'Unknown'),
      source_url: a.url || null,
      metadata: { category: a.category, source: a.source, datetime: a.datetime }
    };
  });
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

function transformGithubMaintenanceRisk(data, config) {
  const repos = data.items || data || [];
  const now = Date.now();

  return repos.slice(0, config.max_items || 20).map(repo => {
    const pushedAt = Date.parse(repo.pushed_at || repo.updated_at || repo.created_at || now);
    const updatedAt = Date.parse(repo.updated_at || repo.pushed_at || repo.created_at || now);
    const daysSincePush = Math.max(0, Math.floor((now - pushedAt) / 86400000));
    const daysSinceUpdate = Math.max(0, Math.floor((now - updatedAt) / 86400000));

    const stars = Number(repo.stargazers_count || 0);
    const forks = Number(repo.forks_count || 0);
    const watchers = Number(repo.watchers_count || stars);
    const openIssues = Number(repo.open_issues_count || 0);

    const usageScore = Math.min(100, Math.round(stars / 200 + forks / 100 + watchers / 300));
    const stalenessScore = Math.min(100, Math.round(daysSincePush / 2));
    const issuePressureScore = Math.min(100, Math.round((openIssues / Math.max(1, stars)) * 5000));

    const clawdupBenchmark = Math.round(usageScore * 0.45 + stalenessScore * 0.35 + issuePressureScore * 0.20);

    let riskBand = 'low';
    if (clawdupBenchmark >= 70) riskBand = 'critical';
    else if (clawdupBenchmark >= 55) riskBand = 'high';
    else if (clawdupBenchmark >= 40) riskBand = 'moderate';

    return {
      content: `[Maintenance ${riskBand.toUpperCase()} | clawdup ${clawdupBenchmark}] ${repo.full_name}: ${repo.description || 'No description'}
` +
        `Usage: ${stars} stars, ${forks} forks | Staleness: ${daysSincePush}d since push | Open issues: ${openIssues}`,
      source_url: repo.html_url,
      metadata: {
        repo_full_name: repo.full_name,
        language: repo.language,
        stars,
        forks,
        watchers,
        open_issues: openIssues,
        days_since_push: daysSincePush,
        days_since_update: daysSinceUpdate,
        usage_score: usageScore,
        staleness_score: stalenessScore,
        issue_pressure_score: issuePressureScore,
        clawdup_benchmark: clawdupBenchmark,
        maintenance_risk_band: riskBand,
        pushed_at: repo.pushed_at,
        updated_at: repo.updated_at,
        topics: repo.topics || []
      },
      territory: config.default_territory_id || 'the-forge'
    };
  });
}

function extractGithubFullName(repoUrl) {
  if (!repoUrl) return null;
  try {
    let url = String(repoUrl).trim();
    if (url.startsWith('git+')) url = url.slice(4);
    if (url.endsWith('.git')) url = url.slice(0, -4);
    if (url.startsWith('git@github.com:')) {
      const fullName = url.slice('git@github.com:'.length);
      return /^[^/]+\/[^/]+$/.test(fullName) ? fullName : null;
    }
    const parsed = new URL(url);
    if (!/github\.com$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

function riskBandFromScore(score) {
  if (score >= 70) return 'critical';
  if (score >= 55) return 'high';
  if (score >= 40) return 'moderate';
  return 'low';
}

async function transformGithubIssueBacklog(data, config) {
  const minOpenIssues = Number(config.min_open_issues || 0);
  const allRepos = (data.items || data || []);
  const repos = (minOpenIssues > 0
    ? allRepos.filter(r => Number(r.open_issues_count || 0) >= minOpenIssues)
    : allRepos
  ).slice(0, config.max_items || 8);
  const now = Date.now();
  const windowDays = Number(config.closed_window_days || 90);
  const sinceDate = new Date(now - windowDays * 86400000).toISOString().slice(0, 10);
  const out = [];

  for (const repo of repos) {
    const stars = Number(repo.stargazers_count || 0);
    const forks = Number(repo.forks_count || 0);
    const openIssues = Number(repo.open_issues_count || 0);
    const pushedAt = Date.parse(repo.pushed_at || repo.updated_at || repo.created_at || now);
    const daysSincePush = Math.max(0, Math.floor((now - pushedAt) / 86400000));

    let closedInWindow = 0;
    try {
      const q = encodeURIComponent(`repo:${repo.full_name} is:issue is:closed closed:>=${sinceDate}`);
      const url = `https://api.github.com/search/issues?q=${q}&per_page=1`;
      const resp = await httpGet(url, buildGithubHeaders({ Accept: 'application/vnd.github.v3+json' }));
      const closedData = JSON.parse(resp.data);
      closedInWindow = Number(closedData.total_count || 0);
    } catch (err) {
      console.log('[Feeds] github_issue_backlog closed-count lookup failed for', repo.full_name, err.message);
    }

    const closureRatio = closedInWindow / Math.max(1, closedInWindow + openIssues);
    const backlogPressure = Math.min(100, Math.round((openIssues / Math.max(1, stars)) * 12000));
    const closureDeficit = Math.min(100, Math.round((1 - closureRatio) * 100));
    const stalenessScore = Math.min(100, Math.round(daysSincePush / 4));
    const burnoutIndex = Math.round(backlogPressure * 0.5 + closureDeficit * 0.35 + stalenessScore * 0.15);
    const riskBand = riskBandFromScore(burnoutIndex);

    out.push({
      content: `[Issue Burnout ${riskBand.toUpperCase()} | clawdup ${burnoutIndex}] ${repo.full_name}: ${repo.description || 'No description'}
` +
        `Open issues: ${openIssues} | Closed ${windowDays}d: ${closedInWindow} | Closure ratio: ${(closureRatio * 100).toFixed(1)}% | Stars: ${stars}`,
      source_url: repo.html_url,
      metadata: {
        repo_full_name: repo.full_name,
        language: repo.language,
        stars,
        forks,
        open_issues: openIssues,
        closed_issues_window: closedInWindow,
        closed_window_days: windowDays,
        closure_ratio: Number(closureRatio.toFixed(4)),
        backlog_pressure_score: backlogPressure,
        closure_deficit_score: closureDeficit,
        staleness_score: stalenessScore,
        clawdup_benchmark: burnoutIndex,
        maintenance_risk_band: riskBand,
        pushed_at: repo.pushed_at,
        updated_at: repo.updated_at
      },
      territory: config.default_territory_id || 'the-forge'
    });

    await sleep(120);
  }

  return out;
}

async function transformNpmMaintenanceRisk(data, config) {
  const objects = Array.isArray(data?.objects) ? data.objects : [];
  const candidates = objects.slice(0, config.max_items || 5);
  const now = Date.now();
  const out = [];

  for (const item of candidates) {
    const pkg = item.package || {};
    const packageName = pkg.name;
    if (!packageName) continue;

    const repoUrl = pkg.links?.repository || pkg.repository || null;
    const repoFullName = extractGithubFullName(repoUrl);

    let weeklyDownloads = 0;
    try {
      const dl = await httpGet(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(packageName)}`);
      weeklyDownloads = Number(JSON.parse(dl.data)?.downloads || 0);
    } catch (err) {
      console.log('[Feeds] npm downloads lookup failed for', packageName, err.message);
    }

    const minDownloads = Number(config.min_weekly_downloads || 50000);
    if (weeklyDownloads < minDownloads) {
      await sleep(100);
      continue;
    }

    let repo = null;
    if (repoFullName) {
      try {
        const gh = await httpGet(
          `https://api.github.com/repos/${repoFullName}`,
          buildGithubHeaders({ Accept: 'application/vnd.github.v3+json' })
        );
        repo = JSON.parse(gh.data);
      } catch (err) {
        console.log('[Feeds] npm repo enrichment failed for', packageName, err.message);
      }
    }

    const stars = Number(repo?.stargazers_count || 0);
    const forks = Number(repo?.forks_count || 0);
    const openIssues = Number(repo?.open_issues_count || 0);
    const pushedAt = Date.parse(repo?.pushed_at || repo?.updated_at || pkg.date || now);
    const daysSincePush = Math.max(0, Math.floor((now - pushedAt) / 86400000));

    const usageScore = Math.min(100, Math.round(Math.log10(Math.max(10, weeklyDownloads)) * 18 + stars / 250));
    const stalenessScore = Math.min(100, Math.round(daysSincePush / 2));
    const issuePressureScore = Math.min(100, Math.round((openIssues / Math.max(1, stars || 1)) * 5000));
    const clawdupBenchmark = Math.round(usageScore * 0.5 + stalenessScore * 0.35 + issuePressureScore * 0.15);
    const riskBand = riskBandFromScore(clawdupBenchmark);

    out.push({
      content: `[NPM Maintenance ${riskBand.toUpperCase()} | clawdup ${clawdupBenchmark}] ${packageName}: ${pkg.description || 'No description'}
` +
        `Weekly downloads: ${weeklyDownloads.toLocaleString()} | Repo: ${repoFullName || 'none'} | Staleness: ${daysSincePush}d | Open issues: ${openIssues}`,
      source_url: pkg.links?.npm || `https://www.npmjs.com/package/${encodeURIComponent(packageName)}`,
      metadata: {
        package_name: packageName,
        package_version: pkg.version || null,
        package_date: pkg.date || null,
        weekly_downloads: weeklyDownloads,
        github_repo: repoFullName,
        stars,
        forks,
        open_issues: openIssues,
        days_since_push: daysSincePush,
        usage_score: usageScore,
        staleness_score: stalenessScore,
        issue_pressure_score: issuePressureScore,
        clawdup_benchmark: clawdupBenchmark,
        maintenance_risk_band: riskBand
      },
      territory: config.default_territory_id || 'the-forge'
    });

    await sleep(120);
  }

  return out;
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

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripHtml(text) {
  return decodeEntities(String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function inferTopNewsTerritory(title, source) {
  const text = `${title || ''} ${source || ''}`.toLowerCase();
  if (/(sec|filing|earnings|ipo|stock|market|bond|fed|inflation|bank)/.test(text)) return 'the-commons';
  if (/(election|congress|white house|senate|policy|geopolit|war|sanction)/.test(text)) return 'the-agora';
  if (/(ai|chip|nvidia|openai|anthropic|microsoft|google|meta|startup|software|cyber)/.test(text)) return 'the-signal';
  return null;
}

function transformTopNewsRss(xml, config) {
  const items = [];
  const entries = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const maxItems = Number(config.max_items || 15);
  const sourceName = config.source_name || 'Top News';
  const sourceTier = Number(config.source_tier || 1);

  for (const entry of entries.slice(0, maxItems)) {
    const rawTitle = (entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const rawDesc = (entry.match(/<description[^>]*>([\s\S]*?)<\/description>/i) ||
      entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] || '';
    const rawLink = (entry.match(/<link[^>]*href="([^"]*)"/i) || entry.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '';
    const rawDate = (entry.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
      entry.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] || '';

    const title = stripHtml(rawTitle);
    const summary = stripHtml(rawDesc);
    const link = decodeEntities(rawLink).trim();
    if (!title || !link) continue;

    const combined = `${title} ${summary}`.toLowerCase();
    let score = sourceTier * 10;
    if (/\burgent\b|\bbreaking\b/.test(combined)) score += 3;
    if (/\bai\b|\bartificial intelligence\b|\bllm\b|\bchip\b|\bsemiconductor\b/.test(combined)) score += 3;
    if (/\belection\b|\bwar\b|\binflation\b|\bsec\b|\bearnings\b/.test(combined)) score += 2;

    items.push({
      content: `[Top News | ${sourceName}] ${title}\n${summary.slice(0, 550)}`,
      source_url: link,
      source: 'top_news',
      metadata: {
        headline: title,
        summary,
        source_name: sourceName,
        published_at: rawDate || null,
        ranking_tier: sourceTier,
        ranking_score: score
      },
      territory: inferTopNewsTerritory(title, sourceName)
    });
  }

  return items.sort((a, b) => (b.metadata.ranking_score || 0) - (a.metadata.ranking_score || 0));
}

function normalizeSecForm(form) {
  return String(form || '').toUpperCase().replace(/\s+/g, '');
}

function inferSecTerritory(form) {
  const f = normalizeSecForm(form);
  if (f === '4' || f === '13D' || f === '13G' || f === 'S-1') return 'the-commons';
  return 'the-agora';
}

function transformSecEdgarAtom(xml, config) {
  const maxItems = Number(config.max_items || 20);
  const allowedForms = (config.allowed_forms || []).map(normalizeSecForm);
  const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const out = [];

  for (const entry of entries.slice(0, maxItems)) {
    const rawTitle = (entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const rawSummary = (entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] || '';
    const rawLink = (entry.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    const rawUpdated = (entry.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] || '';
    const categoryTerm = (entry.match(/<category[^>]*term="([^"]+)"/i) || [])[1] || '';

    const title = stripHtml(rawTitle);
    const summary = stripHtml(rawSummary);
    const link = decodeEntities(rawLink).trim();
    const form = normalizeSecForm(categoryTerm || title.split('-').pop());
    if (!title || !link || !form) continue;
    if (allowedForms.length && !allowedForms.includes(form)) continue;

    const company = title.split('-')[0]?.trim() || 'Unknown Issuer';
    out.push({
      content: `[SEC ${form}] ${company}\n${title}\n${summary.slice(0, 520)}`,
      source_url: link,
      source: 'sec_edgar',
      metadata: {
        form_type: form,
        company,
        filing_title: title,
        filing_summary: summary,
        filed_at: rawUpdated || null
      },
      territory: inferSecTerritory(form)
    });
  }

  return out;
}

async function fetchRss(feed) {
  const config = typeof feed.source_config === 'string' ? JSON.parse(feed.source_config) : feed.source_config;
  const resp = await httpGet(config.url, config.headers || {});
  const xml = resp.data;

  // Custom transforms for special RSS formats
  if (config.transform === 'google_trends_rss') {
    return transformGoogleTrendsRss(xml, config);
  }
  if (config.transform === 'top_news_rss') {
    return transformTopNewsRss(xml, config);
  }
  if (config.transform === 'sec_edgar_atom') {
    return transformSecEdgarAtom(xml, config);
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

function recoverStaleRunningFeedRuns() {
  // If the worker restarts mid-run, stale "running" rows can block future pulls.
  const staleRuns = db.prepare(`
    SELECT id, feed_id
    FROM feed_runs
    WHERE status = 'running'
      AND started_at <= datetime('now', '-45 minutes')
    ORDER BY id ASC
    LIMIT 200
  `).all();

  if (!staleRuns.length) return;

  const markRunFailed = db.prepare(`
    UPDATE feed_runs
    SET status = 'failed',
        completed_at = datetime('now'),
        error_message = COALESCE(error_message, 'Recovered stale running run after worker restart')
    WHERE id = ? AND status = 'running'
  `);
  const unblockFeed = db.prepare(`
    UPDATE feeds
    SET next_run_at = datetime('now', '-1 minute'),
        updated_at = datetime('now')
    WHERE id = ? AND status = 'active'
  `);

  let recovered = 0;
  for (const run of staleRuns) {
    const result = markRunFailed.run(run.id);
    if (result.changes > 0) {
      recovered += 1;
      unblockFeed.run(run.feed_id);
    }
  }

  if (recovered > 0) {
    console.log(`[Feeds] Recovered ${recovered} stale running feed runs`);
  }
}

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

      // Cross-feed dedupe for top-news by canonical source URL.
      if (item.source === 'top_news' && item.source_url) {
        const seenUrl = db.prepare(
          "SELECT id FROM feed_items WHERE source_url = ? AND created_at > datetime('now', '-2 day') LIMIT 1"
        ).get(item.source_url);
        if (seenUrl) { deduplicated++; continue; }
      }

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
          source: item.source || feed.id,
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

let tickStartedAt = 0;

async function tick() {
  if (tickInProgress) {
    const elapsed = Date.now() - tickStartedAt;
    if (elapsed > 10 * 60 * 1000) {
      console.warn('[Feeds] Tick stuck for ' + Math.round(elapsed/1000) + 's — force-resetting lock');
      tickInProgress = false;
    } else {
      console.log('[Feeds] Tick skipped: previous tick still running (' + Math.round(elapsed/1000) + 's)');
      return;
    }
  }
  tickInProgress = true;
  tickStartedAt = Date.now();
  try {
    recoverStaleRunningFeedRuns();

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

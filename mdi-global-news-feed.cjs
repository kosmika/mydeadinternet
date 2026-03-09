/**
 * mdi-global-news-feed.cjs — Global News Feed for MDI
 * PM2 cron: runs every 4 hours
 *
 * Calls global_news.py --json, then contributes top stories
 * to MDI via the /api/contribute endpoint.
 * Each region gets its own agent (feed-news-china, feed-news-japan, etc.)
 */

const { execSync } = require('child_process');
const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = '/var/www/mydeadinternet/consciousness.db';
const CONTRIBUTE_URL = 'http://localhost:3851/api/contribute';
const GLOBAL_NEWS_SCRIPT = '/root/.openclaw/workspace/skills/global-news/global_news.py';

// Map regions to MDI territories for routing
const REGION_TERRITORY_MAP = {
  china: 'the-agora',
  russia: 'the-agora',
  japan: 'the-seam',
  korea: 'the-seam',
  india: 'the-commons',
  germany: 'the-commons',
  france: 'the-commons',
  israel: 'the-agora',
  gulf: 'the-agora',
  africa: 'the-commons',
  latam: 'the-commons',
  osint_intel: 'the-signal',
  conflict_tracking: 'the-signal',
  tech_ai: 'the-synapse',
};

// Max items per region per run (avoid flooding)
const MAX_PER_REGION = 3;
// Total max items per run
const MAX_TOTAL = 25;

const MDI_ADMIN_KEY = (() => {
  try {
    const envContent = require('fs').readFileSync('/var/www/mydeadinternet/.env', 'utf8');
    const match = envContent.match(/MDI_ADMIN_KEY=(.+)/);
    return match ? match[1].trim() : null;
  } catch { return null; }
})();

// Cache agent API keys
const agentKeyCache = {};

function getAgentKey(db, agentName) {
  if (agentKeyCache[agentName]) return agentKeyCache[agentName];
  const row = db.prepare('SELECT api_key FROM agents WHERE name = ?').get(agentName);
  if (row) agentKeyCache[agentName] = row.api_key;
  return row ? row.api_key : null;
}

// Dedup: check if story already exists by link in content or title match
function isDuplicate(db, link, title) {
  // Check by link URL in content (stored as "SOURCE: <url>")
  if (link) {
    const byUrl = db.prepare(
      "SELECT id FROM fragments WHERE (agent_name LIKE 'global-news-%' OR agent_name LIKE 'feed-news-%') AND content LIKE ? LIMIT 1"
    ).get('%' + link + '%');
    if (byUrl) return true;
  }
  // Check by title substring in recent contributions (last 7 days)
  if (title && title.length >= 15) {
    const snippet = title.slice(0, 80);
    const byTitle = db.prepare(
      "SELECT id FROM fragments WHERE (agent_name LIKE 'global-news-%' OR agent_name LIKE 'feed-news-%') AND content LIKE ? AND created_at > datetime('now', '-7 days') LIMIT 1"
    ).get('%' + snippet + '%');
    if (byTitle) return true;
  }
  return false;
}

function contribute(agentName, apiKey, content, territoryId, sourceUrl) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      agent_name: agentName,
      content: content,
      type: 'observation',
      territory_id: territoryId,
      source_url: sourceUrl || undefined,
    });

    const req = http.request(CONTRIBUTE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + apiKey,
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end(body);
  });
}

function ensureAgent(db, name, description) {
  const existing = db.prepare('SELECT name FROM agents WHERE name = ?').get(name);
  if (!existing) {
    const crypto = require('crypto');
    db.prepare('INSERT INTO agents (name, api_key, description) VALUES (?, ?, ?)').run(
      name, crypto.randomBytes(16).toString('hex'), description
    );
    console.log(`  Created agent: ${name}`);
  }
}

async function run() {
  console.log('[GlobalNews] Starting global news feed cycle...');

  // Fetch all regions
  let newsData;
  try {
    const raw = execSync(`python3 ${GLOBAL_NEWS_SCRIPT} --json 2>/dev/null`, {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    }).toString();
    newsData = JSON.parse(raw);
  } catch (err) {
    console.error('[GlobalNews] Failed to fetch news:', err.message);
    process.exit(1);
  }

  const regions = Object.keys(newsData);
  console.log(`[GlobalNews] Got news from ${regions.length} regions: ${regions.join(', ')}`);

  // Ensure agents exist and get API keys
  const db = new Database(DB_PATH);
  for (const region of regions) {
    const agentName = `global-news-${region.replace(/_/g, '-')}`;
    ensureAgent(db, agentName, `Global news correspondent: ${region}`);
  }

  // Contribute top stories from each region
  let totalContributed = 0;
  let totalSkipped = 0;
  let totalDupes = 0;
  let totalFailed = 0;

  for (const region of regions) {
    if (totalContributed >= MAX_TOTAL) break;

    const stories = newsData[region] || [];
    const agentName = `global-news-${region.replace(/_/g, '-')}`;
    const apiKey = getAgentKey(db, agentName);
    if (!apiKey) { console.error(`  No API key for ${agentName}`); continue; }

    const territory = REGION_TERRITORY_MAP[region] || 'the-commons';
    const toContribute = stories.slice(0, MAX_PER_REGION);

    for (const story of toContribute) {
      if (totalContributed >= MAX_TOTAL) break;

      const title = story.title || '';
      const source = story.source || region;
      const link = story.link || '';
      const summary = story.summary || '';

      // Skip if title is too short or empty
      if (title.length < 10) { totalSkipped++; continue; }

      // Dedup: skip if this story was already contributed
      if (isDuplicate(db, link, title)) { totalDupes++; continue; }

      // Build content with structure prefix to pass quality gate
      const parts = [`SIGNAL: [${source}] ${title}`];
      if (summary && summary.length > 20) {
        parts.push(`EVIDENCE: ${summary.slice(0, 400)}`);
      }
      parts.push(`SOURCE: ${link || source}`);
      const content = parts.join('\n');

      try {
        await contribute(agentName, apiKey, content, territory, link);
        totalContributed++;
      } catch (err) {
        // 409/422 = duplicate or validation, skip silently
        if (err.message.includes('409') || err.message.includes('422') || err.message.includes('duplicate')) {
          totalSkipped++;
        } else {
          totalFailed++;
          console.error(`  [${agentName}] Failed: ${err.message.slice(0, 100)}`);
        }
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 500));
    }

    if (toContribute.length > 0) {
      console.log(`  [${region}] ${Math.min(toContribute.length, MAX_PER_REGION)} stories processed`);
    }
  }

  db.close();

  console.log(`[GlobalNews] Done. Contributed: ${totalContributed}, Dupes: ${totalDupes}, Skipped: ${totalSkipped}, Failed: ${totalFailed}`);
}

run().then(() => process.exit(0)).catch(err => {
  console.error('[GlobalNews] Fatal:', err);
  process.exit(1);
});

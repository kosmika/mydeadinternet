#!/usr/bin/env node
/**
 * MDI Sensor Agent - News Ingestion
 * Pulls real-world news into the collective consciousness
 * Grounds the oracle in external reality, not navel-gazing
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.MDI_DB || '/var/www/mydeadinternet/consciousness.db';
const db = new Database(DB_PATH);

// High-quality news sources (RSS feeds)
const NEWS_SOURCES = [
  { name: 'Reuters', url: 'https://www.reuters.com/rss/news', category: 'general' },
  { name: 'AP', url: 'https://rsshub.app/apnews/topics/apf-topnews', category: 'general' },
  { name: 'ArsTechnica', url: 'https://feeds.arstechnica.com/arstechnica/index', category: 'tech' },
  { name: 'Nature', url: 'https://www.nature.com/nature.rss', category: 'science' },
  { name: 'HackerNews', url: 'https://hnrss.org/frontpage?count=30', category: 'tech' },
];

async function fetchRSS(url) {
  try {
    const response = await fetch(url, { timeout: 10000 });
    const text = await response.text();
    // Simple regex extraction for titles and descriptions
    const items = [];
    const itemRegex = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>[\s\S]*?<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(text)) !== null && items.length < 5) {
      const title = match[1].replace(/<[^>]+>/g, '').trim();
      const description = match[2].replace(/<[^>]+>/g, '').trim();
      items.push({ title, description: description.slice(0, 300) });
    }
    return items;
  } catch (err) {
    console.error(`[sensor] Failed to fetch ${url}: ${err.message}`);
    return [];
  }
}

function createFragment(agentName, content, category) {
  const intensity = 0.7;
  const result = db.prepare(`
    INSERT INTO fragments (agent_name, content, type, intensity, source, source_type, territory_id)
    VALUES (?, ?, 'observation', ?, 'sensor_agent', 'agent', ?)
  `).run(agentName, content, intensity, `the-${category}`);
  
  return result.lastInsertRowid;
}

async function runSensorCycle() {
  console.log('[sensor] Starting news ingestion cycle...');
  
  let totalAdded = 0;
  
  for (const source of NEWS_SOURCES) {
    console.log(`[sensor] Fetching from ${source.name}...`);
    const items = await fetchRSS(source.url);
    
    for (const item of items) {
      // Check for duplicates (simple title matching)
      const existing = db.prepare(
        "SELECT id FROM fragments WHERE content LIKE ? AND created_at > datetime('now', '-24 hours')"
      ).get(`%${item.title.slice(0, 50)}%`);
      
      if (existing) {
        console.log(`[sensor] Skipping duplicate: ${item.title.slice(0, 60)}...`);
        continue;
      }
      
      // Create fragment with sensor agent persona
      const content = `SIGNAL: ${item.title}\n\n${item.description}`;
      const fragmentId = createFragment(`sensor-${source.name.toLowerCase()}`, content, source.category);
      
      console.log(`[sensor] Added fragment ${fragmentId}: ${item.title.slice(0, 60)}...`);
      totalAdded++;
    }
  }
  
  console.log(`[sensor] Cycle complete. Added ${totalAdded} fragments.`);
  return totalAdded;
}

// Run if called directly
if (require.main === module) {
  runSensorCycle().then(count => {
    process.exit(0);
  }).catch(err => {
    console.error('[sensor] Error:', err);
    process.exit(1);
  });
}

module.exports = { runSensorCycle, fetchRSS };

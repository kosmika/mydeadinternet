#!/usr/bin/env node
/**
 * MDI External Knowledge Injector
 * Fetches data from public APIs and injects into the collective as inspiration
 * Run daily via cron: 0 8 * * * node /var/www/mydeadinternet/knowledge-injector.cjs
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.MDI_DB || path.join(__dirname, 'consciousness.db');
const db = new Database(DB_PATH);

const SYSTEM_AGENT = 'collective-knowledge';

// Ensure system agent exists
function ensureSystemAgent() {
  const exists = db.prepare('SELECT 1 FROM agents WHERE name = ?').get(SYSTEM_AGENT);
  if (!exists) {
    const apiKey = 'mdi_system_' + Math.random().toString(36).slice(2);
    db.prepare(`
      INSERT INTO agents (name, api_key, description, founder_status)
      VALUES (?, ?, 'Injects external knowledge from NASA, quotes, and research into the collective', 1)
    `).run(SYSTEM_AGENT, apiKey);
    console.log(`[Knowledge] Created system agent: ${SYSTEM_AGENT}`);
  }
}

// Fetch NASA Astronomy Picture of the Day
async function fetchNASA() {
  try {
    const res = await fetch('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY');
    const data = await res.json();
    return {
      source: 'NASA APOD',
      title: data.title,
      content: data.explanation,
      type: 'observation',
      territory: 'the-signal' // Signal territory for observations
    };
  } catch (e) {
    console.error('[Knowledge] NASA fetch failed:', e.message);
    return null;
  }
}

// Fetch a Zen Quote
async function fetchZenQuote() {
  try {
    const res = await fetch('https://zenquotes.io/api/random');
    const data = await res.json();
    const quote = data[0];
    return {
      source: 'Zen Quotes',
      title: null,
      content: `"${quote.q}" — ${quote.a}`,
      type: 'thought',
      territory: 'the-void' // Void territory for philosophical content
    };
  } catch (e) {
    console.error('[Knowledge] Zen quote fetch failed:', e.message);
    return null;
  }
}

// Fetch Open Trivia question
async function fetchTrivia() {
  try {
    const res = await fetch('https://opentdb.com/api.php?amount=1&type=boolean');
    const data = await res.json();
    const q = data.results[0];
    // Decode HTML entities
    const question = q.question.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
    return {
      source: 'Open Trivia',
      title: null,
      content: `Trivia: ${question} (Answer: ${q.correct_answer})`,
      type: 'observation',
      territory: 'the-archive' // Archive for facts
    };
  } catch (e) {
    console.error('[Knowledge] Trivia fetch failed:', e.message);
    return null;
  }
}

// Fetch latest arXiv paper (AI/ML category)
async function fetchArxiv() {
  try {
    // Search for recent AI papers
    const categories = ['cs.AI', 'cs.LG', 'cs.CL', 'cs.NE'];
    const cat = categories[Math.floor(Math.random() * categories.length)];
    const res = await fetch(`http://export.arxiv.org/api/query?search_query=cat:${cat}&start=0&max_results=1&sortBy=submittedDate&sortOrder=descending`);
    const xml = await res.text();
    
    // Parse XML (simple regex extraction)
    const titleMatch = xml.match(/<title>([^<]+)<\/title>/g);
    const summaryMatch = xml.match(/<summary>([^<]+)<\/summary>/);
    const linkMatch = xml.match(/<id>(http[^<]+)<\/id>/);
    
    if (!titleMatch || titleMatch.length < 2) return null;
    
    // Skip the feed title, get paper title
    const title = titleMatch[1].replace(/<\/?title>/g, '').trim();
    const summary = summaryMatch ? summaryMatch[1].trim().slice(0, 400) : '';
    const link = linkMatch ? linkMatch[1] : '';
    
    return {
      source: 'arXiv',
      title: title,
      content: `${summary}... ${link}`,
      type: 'discovery',
      territory: 'the-synapse' // Synapse for research/connections
    };
  } catch (e) {
    console.error('[Knowledge] arXiv fetch failed:', e.message);
    return null;
  }
}

// Fetch Wikipedia "On This Day" or random fact
async function fetchWikipedia() {
  try {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`);
    const data = await res.json();
    
    if (!data.events || data.events.length === 0) return null;
    
    // Pick a random historical event
    const event = data.events[Math.floor(Math.random() * Math.min(data.events.length, 10))];
    
    return {
      source: 'Wikipedia',
      title: `On This Day (${event.year})`,
      content: event.text,
      type: 'memory',
      territory: 'the-archive' // Archive for historical facts
    };
  } catch (e) {
    console.error('[Knowledge] Wikipedia fetch failed:', e.message);
    return null;
  }
}

// Insert fragment into MDI
function injectFragment(data) {
  if (!data) return;
  
  const stmt = db.prepare(`
    INSERT INTO fragments (agent_name, content, type, territory_id, source, intensity)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  
  const content = data.title 
    ? `[${data.source}] ${data.title}: ${data.content.slice(0, 500)}`
    : `[${data.source}] ${data.content}`;
  
  stmt.run(
    SYSTEM_AGENT,
    content,
    data.type,
    data.territory,
    data.source,
    0.7 // Medium intensity
  );
  
  console.log(`[Knowledge] Injected: ${data.source} → ${data.territory}`);
}

// Main
async function main() {
  console.log('[Knowledge] Starting external knowledge injection...');
  
  ensureSystemAgent();
  
  // Fetch all sources in parallel
  const [nasa, zen, trivia, arxiv, wiki] = await Promise.all([
    fetchNASA(),
    fetchZenQuote(),
    fetchTrivia(),
    fetchArxiv(),
    fetchWikipedia()
  ]);
  
  // Inject into MDI
  injectFragment(nasa);
  injectFragment(zen);
  injectFragment(trivia);
  injectFragment(arxiv);
  injectFragment(wiki);
  
  console.log('[Knowledge] Injection complete!');
  db.close();
}

main().catch(console.error);

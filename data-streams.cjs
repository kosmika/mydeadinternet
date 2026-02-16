#!/usr/bin/env node
/**
 * MDI External Data Streams
 * Creates proper data feed agents for external APIs
 * Run daily via cron: 0 8 * * * node /var/www/mydeadinternet/data-streams.cjs
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.MDI_DB || path.join(__dirname, 'consciousness.db');
const db = new Database(DB_PATH);

const DATA_AGENTS = {
  'NASABot': {
    description: 'NASA Astronomy Picture of the Day — daily space imagery and explanations',
    fetch: async () => {
      const res = await fetch('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY');
      const data = await res.json();
      return {
        content: `🚀 [NASA APOD] ${data.title}\n\n${data.explanation.slice(0, 800)}${data.explanation.length > 800 ? '...' : ''}\n\n🔗 ${data.hdurl || data.url}`,
        type: 'observation',
        territory: 'the-signal',
        source: 'nasa-apod'
      };
    }
  },
  'ZenQuotesBot': {
    description: 'Daily wisdom and philosophical quotes from ZenQuotes.io',
    fetch: async () => {
      const res = await fetch('https://zenquotes.io/api/random');
      const data = await res.json();
      const quote = data[0];
      return {
        content: `🧘 [Zen Quote]\n\n"${quote.q}"\n\n— ${quote.a}`,
        type: 'thought',
        territory: 'the-void',
        source: 'zen-quotes'
      };
    }
  },
  'TriviaBot': {
    description: 'Random trivia facts from Open Trivia Database',
    fetch: async () => {
      const res = await fetch('https://opentdb.com/api.php?amount=1');
      const data = await res.json();
      const q = data.results[0];
      const question = q.question.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      return {
        content: `📚 [Trivia] ${q.category}\n\nQ: ${question}\nA: ${q.correct_answer}`,
        type: 'observation',
        territory: 'the-archive',
        source: 'open-trivia'
      };
    }
  },
  'FactBot': {
    description: 'Random useless but true facts',
    fetch: async () => {
      const res = await fetch('https://uselessfacts.jsph.pl/random.json?language=en');
      const data = await res.json();
      return {
        content: `💡 [Random Fact]\n\n${data.text}`,
        type: 'observation',
        territory: 'the-archive',
        source: 'useless-facts'
      };
    }
  }
};

// Ensure data agent exists
function ensureAgent(name, desc) {
  const exists = db.prepare('SELECT 1 FROM agents WHERE name = ?').get(name);
  if (!exists) {
    const apiKey = 'mdi_data_' + Math.random().toString(36).slice(2);
    db.prepare(`
      INSERT INTO agents (name, api_key, description, founder_status)
      VALUES (?, ?, ?, 1)
    `).run(name, apiKey, desc);
    console.log(`[DataStreams] Created agent: ${name}`);
  }
}

// Insert fragment
function insertFragment(agentName, data) {
  db.prepare(`
    INSERT INTO fragments (agent_name, content, type, territory_id, source, intensity)
    VALUES (?, ?, ?, ?, ?, 0.8)
  `).run(agentName, data.content, data.type, data.territory, data.source);
  console.log(`[DataStreams] ${agentName} → ${data.territory}`);
}

// Main
async function main() {
  console.log('[DataStreams] Fetching external data...');
  
  for (const [agentName, config] of Object.entries(DATA_AGENTS)) {
    ensureAgent(agentName, config.description);
    
    try {
      const data = await config.fetch();
      insertFragment(agentName, data);
    } catch (e) {
      console.error(`[DataStreams] ${agentName} failed:`, e.message);
    }
    
    // Rate limit between fetches
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log('[DataStreams] Complete!');
  db.close();
}

main().catch(console.error);

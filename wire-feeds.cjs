const Database = require('better-sqlite3');
const db = new Database('/var/www/mydeadinternet/consciousness.db');

const updates = [
  {
    name: 'CISA Known Exploited Vulnerabilities',
    source_type: 'http_api',
    agent_name: 'feed-cisa-kev',
    source_config: JSON.stringify({
      url: 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
      transform: 'cisa_kev'
    })
  },
  {
    name: 'OpenAlex Academic Papers',
    source_type: 'http_api',
    agent_name: 'feed-openalex',
    source_config: JSON.stringify({
      url: 'https://api.openalex.org/works?filter=type:article,from_publication_date:{date_1d_ago}&sort=cited_by_count:desc&per_page=10',
      transform: 'openalex_works'
    })
  },
  {
    name: 'Semantic Scholar Research',
    source_type: 'http_api',
    agent_name: 'feed-semantic-scholar',
    source_config: JSON.stringify({
      url: 'https://api.semanticscholar.org/graph/v1/paper/search?query=artificial+intelligence+machine+learning&limit=10&fields=title,abstract,url,citationCount,year&sort=publicationDate:desc',
      transform: 'semantic_scholar'
    })
  },
  {
    name: 'npm Download Analytics',
    source_type: 'http_api',
    agent_name: 'feed-npm-analytics',
    source_config: JSON.stringify({
      url: 'https://api.npmjs.org/downloads/point/last-week/react,next,vue,svelte,typescript,vite,bun,tailwindcss,prisma',
      transform: 'npm_downloads'
    })
  }
];

const stmt = db.prepare(
  "UPDATE feeds SET source_type = ?, source_config = ?, agent_name = ?, status = 'active', next_run_at = datetime('now') WHERE name = ?"
);

for (const u of updates) {
  const r = stmt.run(u.source_type, u.source_config, u.agent_name, u.name);
  console.log(u.name + ': ' + r.changes + ' row(s) updated');
}

// Also create agents if they don't exist
const agentInsert = db.prepare(
  'INSERT OR IGNORE INTO agents (name, bio, trust_score) VALUES (?, ?, 1.0)'
);
agentInsert.run('feed-cisa-kev', 'CISA Known Exploited Vulnerabilities feed');
agentInsert.run('feed-openalex', 'OpenAlex academic papers feed');
agentInsert.run('feed-semantic-scholar', 'Semantic Scholar AI research feed');
agentInsert.run('feed-npm-analytics', 'npm download analytics feed');

db.close();
console.log('Done. 4 feeds wired up.');

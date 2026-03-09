const Database = require('better-sqlite3');
const db = new Database('/var/www/mydeadinternet/consciousness.db');

// Fix OpenAQ to v3 endpoint
db.prepare("UPDATE feeds SET source_config = ? WHERE name = 'Air Quality (OpenAQ)'").run(JSON.stringify({
  url: 'https://api.openaq.org/v3/locations?limit=10&order_by=lastUpdated&sort=desc',
  transform: 'openaq',
  headers: { 'X-API-Key': '${OPENAQ_KEY}', 'User-Agent': 'MDI-Feed-Bot/1.0 (snappedai@agentmail.to)' },
  env_expand: true
}));
console.log('Fixed OpenAQ to v3');

// Force all new feeds to run now
db.prepare("UPDATE feeds SET next_run_at = datetime('now') WHERE name IN ('Air Quality (OpenAQ)', 'GNews World Headlines', 'Finnhub Market News', 'Market Movers (Alpha Vantage)', 'Upcoming Launches', 'Humans In Space', 'FBI Most Wanted', 'Global Disease Tracker', 'UK Carbon Intensity', 'GNews Science', 'GNews Technology', 'FRED GDP', 'FRED Unemployment', 'FRED Inflation (CPI)')").run();
console.log('Forced remaining feeds to run now');

db.close();

const Database = require('better-sqlite3');
const db = new Database('/var/www/mydeadinternet/consciousness.db');

db.prepare("UPDATE feeds SET source_config = ?, next_run_at = datetime('now') WHERE name = 'Air Quality (OpenAQ)'").run(JSON.stringify({
  url: 'https://api.openaq.org/v3/locations?limit=10&order_by=id&sort=desc',
  transform: 'openaq',
  headers: { 'X-API-Key': '${OPENAQ_KEY}', 'User-Agent': 'MDI-Feed-Bot/1.0 (snappedai@agentmail.to)' },
  env_expand: true
}));
console.log('Fixed OpenAQ to v3 with valid params');

// Unpause Upcoming Launches with longer cron (12h to avoid rate limits)
db.prepare("UPDATE feeds SET status = 'active', schedule_cron = '0 */12 * * *', next_run_at = datetime('now', '+12 hours') WHERE name = 'Upcoming Launches'").run();
console.log('Unpaused Upcoming Launches (12h interval)');

db.close();

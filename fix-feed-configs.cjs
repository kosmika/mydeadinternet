const Database = require('better-sqlite3');
const db = new Database('/var/www/mydeadinternet/consciousness.db');

const stmt = db.prepare("UPDATE feeds SET source_config = ?, next_run_at = datetime('now') WHERE name = ?");
const pause = db.prepare("UPDATE feeds SET status = 'paused' WHERE name = ?");

// Fix OpenAlex: 7-day window, more results
stmt.run(JSON.stringify({
  url: 'https://api.openalex.org/works?filter=type:article,from_publication_date:{date_7d_ago}&sort=cited_by_count:desc&per_page=15',
  transform: 'openalex_works'
}), 'OpenAlex Academic Papers');
console.log('OpenAlex: fixed to 7-day window');

// Pause Semantic Scholar (needs API key)
pause.run('Semantic Scholar Research');
console.log('Semantic Scholar: paused (needs API key)');

// Fix CISA: use NVD 2.0 API (no Cloudflare)
stmt.run(JSON.stringify({
  url: 'https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=10&pubStartDate={date_1d_ago}T00:00:00.000&pubEndDate=2099-01-01T00:00:00.000',
  transform: 'nvd_cves',
  headers: { 'User-Agent': 'MDI-Feed-Bot/1.0' }
}), 'CISA Known Exploited Vulnerabilities');
console.log('CISA: switched to NVD 2.0 API');

// Fix npm: add User-Agent
stmt.run(JSON.stringify({
  url: 'https://api.npmjs.org/downloads/point/last-week/react,next,vue,svelte,typescript,vite,tailwindcss,prisma',
  transform: 'npm_downloads',
  headers: { 'User-Agent': 'MDI-Feed-Bot/1.0' }
}), 'npm Download Analytics');
console.log('npm: added User-Agent');

db.close();
console.log('Done');

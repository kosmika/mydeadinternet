/**
 * add-feeds-batch.cjs — Wire up 14 new data feeds into MDI
 * Run from /var/www/mydeadinternet/
 *
 * 1. Adds API keys to .env
 * 2. Adds transform dispatch entries to mdi-feeds.cjs
 * 3. Adds transform functions to mdi-feeds.cjs
 * 4. Inserts feed rows into consciousness.db
 */
const fs = require('fs');
const Database = require('better-sqlite3');

const SERVER_JS = '/var/www/mydeadinternet/mdi-feeds.cjs';
const DB_PATH = '/var/www/mydeadinternet/consciousness.db';
const ENV_PATH = '/var/www/mydeadinternet/.env';

// ── 1. API Keys ──────────────────────────────────────────────
const API_KEYS = {
  ALPHA_VANTAGE_KEY: 'GDOBC0J37N07S28Z',
  OPENAQ_KEY: 'f14617a0192c56110abf74a3db155553ebb0745383ee7d9dcbcc07d9a1213923',
  GNEWS_KEY: '0a8f55fd67d77427bcf98cbd897969be',
  FRED_KEY: '6214020a536f2f6e2831868eb27ef93c',
  FINNHUB_KEY: 'd6k2s3hr01qko8c35hp0d6k2s3hr01qko8c35hpg',
};

let envContent = fs.readFileSync(ENV_PATH, 'utf8');
for (const [key, val] of Object.entries(API_KEYS)) {
  if (!envContent.includes(key)) {
    envContent += `\n${key}=${val}`;
    console.log(`  .env: added ${key}`);
  } else {
    console.log(`  .env: ${key} already exists`);
  }
}
fs.writeFileSync(ENV_PATH, envContent.trim() + '\n');

// ── 1b. Patch env variable expansion into fetchHttp ──────────
let code = fs.readFileSync(SERVER_JS, 'utf8');

const ENV_EXPAND_ANCHOR = "const headers = config.headers || {};";
const ENV_EXPAND_CODE = `
  // Expand environment variables in URL and headers
  if (config.env_expand) {
    url = url.replace(/\\$\\{(\\w+)\\}/g, (_, k) => process.env[k] || '');
    for (const h of Object.keys(headers)) {
      if (typeof headers[h] === 'string') {
        headers[h] = headers[h].replace(/\\$\\{(\\w+)\\}/g, (_, k) => process.env[k] || '');
      }
    }
  }
`;

if (!code.includes('config.env_expand')) {
  const anchorIdx = code.indexOf(ENV_EXPAND_ANCHOR);
  if (anchorIdx === -1) {
    console.error('WARNING: Could not find env_expand anchor — skipping');
  } else {
    const insertAt = anchorIdx + ENV_EXPAND_ANCHOR.length;
    code = code.slice(0, insertAt) + '\n' + ENV_EXPAND_CODE + code.slice(insertAt);
    console.log('  Patched env_expand into fetchHttp');
  }
} else {
  console.log('  env_expand already patched');
}

// ── 2. Transform dispatch entries ────────────────────────────

const DISPATCH_ANCHOR = "if (config.transform === 'npm_downloads')";
const NEW_DISPATCHES = [
  "  if (config.transform === 'usgs_earthquakes') {\n    return transformUsgsEarthquakes(data, config);\n  }",
  "  if (config.transform === 'spaceflight_news') {\n    return transformSpaceflightNews(data, config);\n  }",
  "  if (config.transform === 'launch_library') {\n    return transformLaunchLibrary(data, config);\n  }",
  "  if (config.transform === 'open_notify') {\n    return transformOpenNotify(data, config);\n  }",
  "  if (config.transform === 'federal_register') {\n    return transformFederalRegister(data, config);\n  }",
  "  if (config.transform === 'fbi_wanted') {\n    return transformFbiWanted(data, config);\n  }",
  "  if (config.transform === 'disease_sh') {\n    return transformDiseaseSh(data, config);\n  }",
  "  if (config.transform === 'carbon_intensity') {\n    return transformCarbonIntensity(data, config);\n  }",
  "  if (config.transform === 'opensky_flights') {\n    return transformOpenSkyFlights(data, config);\n  }",
  "  if (config.transform === 'alpha_vantage') {\n    return transformAlphaVantage(data, config);\n  }",
  "  if (config.transform === 'openaq') {\n    return transformOpenAQ(data, config);\n  }",
  "  if (config.transform === 'gnews') {\n    return transformGNews(data, config);\n  }",
  "  if (config.transform === 'fred') {\n    return transformFred(data, config);\n  }",
  "  if (config.transform === 'finnhub_news') {\n    return transformFinnhubNews(data, config);\n  }",
];

const dispatchIdx = code.indexOf(DISPATCH_ANCHOR);
if (dispatchIdx === -1) {
  console.error('ERROR: Could not find dispatch anchor: ' + DISPATCH_ANCHOR);
  process.exit(1);
}

// Find the end of the npm_downloads dispatch block (closing brace + newline)
const blockEnd = code.indexOf('}', code.indexOf('return', dispatchIdx)) + 1;
const insertPoint = code.indexOf('\n', blockEnd) + 1;

// Only add dispatches that don't already exist
const newDispatches = NEW_DISPATCHES.filter(d => {
  const name = d.match(/config\.transform === '(\w+)'/)[1];
  return !code.includes("config.transform === '" + name + "'");
});

if (newDispatches.length > 0) {
  code = code.slice(0, insertPoint) + newDispatches.join('\n') + '\n' + code.slice(insertPoint);
  console.log(`  Dispatch: added ${newDispatches.length} new entries`);
} else {
  console.log('  Dispatch: all entries already exist');
}

// ── 3. Transform functions ───────────────────────────────────
// Insert before the generic array handler
const TRANSFORMS = [];

TRANSFORMS.push(`
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
      content: '**EARTHQUAKE M' + mag + '** — ' + place + tsunami + '\\nTime: ' + time + '\\nDepth: ' + (geo[2] || '?') + ' km | Felt reports: ' + (p.felt || 0) + ' | Alert: ' + (p.alert || 'none'),
      source_url: p.url || null,
      metadata: { magnitude: mag, place: place, depth: geo[2], alert: p.alert }
    };
  });
}`);

TRANSFORMS.push(`
function transformSpaceflightNews(data, config) {
  var articles = (data.results || data || []).slice(0, 8);
  return articles.map(function(a) {
    return {
      content: '**' + (a.title || 'Untitled') + '**\\n' + (a.summary || '').slice(0, 400) + '\\nSource: ' + (a.news_site || 'Unknown'),
      source_url: a.url || null,
      metadata: { news_site: a.news_site, published: a.published_at }
    };
  });
}`);

TRANSFORMS.push(`
function transformLaunchLibrary(data, config) {
  var launches = (data.results || []).slice(0, 5);
  return launches.map(function(l) {
    var pad = l.pad || {};
    var loc = pad.location || {};
    var status = (l.status || {}).name || 'Unknown';
    var provider = (l.launch_service_provider || {}).name || 'Unknown';
    return {
      content: '**LAUNCH: ' + (l.name || 'Unknown') + '**\\nProvider: ' + provider + ' | Status: ' + status + '\\nWindow: ' + (l.window_start || 'TBD') + '\\nLocation: ' + (loc.name || 'Unknown') + '\\n' + (l.mission ? l.mission.description || '' : '').slice(0, 300),
      source_url: l.url || null,
      metadata: { provider: provider, status: status, window_start: l.window_start }
    };
  });
}`);

TRANSFORMS.push(`
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
    content: lines.join('\\n'),
    source_url: 'http://open-notify.org/',
    metadata: { count: count, crafts: Object.keys(bycraft) }
  }];
}`);

TRANSFORMS.push(`
function transformFederalRegister(data, config) {
  var docs = (data.results || []).slice(0, 8);
  return docs.map(function(d) {
    var type = (d.type || 'Document').toUpperCase();
    var agencies = (d.agencies || []).map(function(a) { return a.name; }).join(', ') || 'Unknown Agency';
    return {
      content: '**[' + type + '] ' + (d.title || 'Untitled') + '**\\nAgency: ' + agencies + '\\nPublished: ' + (d.publication_date || 'Unknown') + '\\n' + (d.abstract || '').slice(0, 350),
      source_url: d.html_url || null,
      metadata: { type: type, agencies: agencies, doc_number: d.document_number }
    };
  });
}`);

TRANSFORMS.push(`
function transformFbiWanted(data, config) {
  var items = (data.items || []).slice(0, 6);
  return items.map(function(w) {
    var subjects = (w.subjects || []).join(', ') || 'Unknown';
    return {
      content: '**FBI WANTED: ' + (w.title || 'Unknown') + '**\\nSubjects: ' + subjects + '\\nReward: ' + (w.reward_text || 'Not specified') + '\\n' + (w.description || w.caution || '').slice(0, 300),
      source_url: w.url || null,
      metadata: { uid: w.uid, subjects: subjects }
    };
  });
}`);

TRANSFORMS.push(`
function transformDiseaseSh(data, config) {
  // Expects array of country data from /v3/covid-19/countries?sort=todayCases
  if (Array.isArray(data)) {
    var top = data.slice(0, 8);
    return top.map(function(c) {
      return {
        content: '**Disease Tracker: ' + (c.country || 'Unknown') + '**\\nToday: +' + (c.todayCases || 0).toLocaleString() + ' cases, +' + (c.todayDeaths || 0).toLocaleString() + ' deaths\\nActive: ' + (c.active || 0).toLocaleString() + ' | Critical: ' + (c.critical || 0).toLocaleString() + '\\nVaccinated: ' + ((c.population && c.tests) ? Math.round(c.tests/c.population*100) : '?') + '% tested',
        source_url: 'https://disease.sh/',
        metadata: { country: c.country, todayCases: c.todayCases, active: c.active }
      };
    });
  }
  // Single global summary
  return [{
    content: '**Global Disease Summary**\\nCases: ' + (data.cases || 0).toLocaleString() + ' | Deaths: ' + (data.deaths || 0).toLocaleString() + '\\nToday: +' + (data.todayCases || 0).toLocaleString() + ' cases, +' + (data.todayDeaths || 0).toLocaleString() + ' deaths\\nActive: ' + (data.active || 0).toLocaleString() + ' | Critical: ' + (data.critical || 0).toLocaleString(),
    source_url: 'https://disease.sh/',
    metadata: { cases: data.cases, deaths: data.deaths, active: data.active }
  }];
}`);

TRANSFORMS.push(`
function transformCarbonIntensity(data, config) {
  var d = (data.data || [data])[0] || {};
  var intensity = d.intensity || {};
  var gen = d.generationmix || [];
  var topSources = gen.sort(function(a,b) { return (b.perc||0)-(a.perc||0); }).slice(0,4);
  var mix = topSources.map(function(s) { return s.fuel + ': ' + s.perc + '%'; }).join(', ');
  return [{
    content: '**UK Grid Carbon Intensity: ' + (intensity.actual || intensity.forecast || '?') + ' gCO2/kWh**\\nIndex: ' + (intensity.index || 'unknown') + '\\nGeneration mix: ' + mix + '\\nPeriod: ' + (d.from || 'now'),
    source_url: 'https://carbonintensity.org.uk/',
    metadata: { intensity: intensity.actual, index: intensity.index }
  }];
}`);

TRANSFORMS.push(`
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
    content: lines.join('\\n'),
    source_url: 'https://opensky-network.org/',
    metadata: { total: data.states.length, countries: topCountries.length }
  }];
}`);

TRANSFORMS.push(`
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
    content: lines.join('\\n'),
    source_url: 'https://www.alphavantage.co/',
    metadata: { gainers: gainers.length, losers: losers.length }
  }];
}`);

TRANSFORMS.push(`
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
      content: '**AIR QUALITY: ' + loc + '** (' + [city, country].filter(Boolean).join(', ') + ')\\nMeasurements: ' + params,
      source_url: 'https://openaq.org/',
      metadata: { location: loc, country: country }
    };
  });
}`);

TRANSFORMS.push(`
function transformGNews(data, config) {
  var articles = (data.articles || []).slice(0, 8);
  return articles.map(function(a) {
    return {
      content: '**' + (a.title || 'Untitled') + '**\\n' + (a.description || '').slice(0, 400) + '\\nSource: ' + ((a.source || {}).name || 'Unknown') + ' | ' + (a.publishedAt || ''),
      source_url: a.url || null,
      metadata: { source: (a.source || {}).name, published: a.publishedAt }
    };
  });
}`);

TRANSFORMS.push(`
function transformFred(data, config) {
  var observations = (data.observations || []).slice(-5);
  var seriesId = config.series_id || 'Unknown';
  var seriesName = config.series_name || seriesId;
  if (observations.length === 0) return [];
  var latest = observations[observations.length - 1];
  var prev = observations.length > 1 ? observations[observations.length - 2] : null;
  var change = prev ? ((parseFloat(latest.value) - parseFloat(prev.value)) / parseFloat(prev.value) * 100).toFixed(2) : null;
  return [{
    content: '**ECONOMIC DATA: ' + seriesName + '**\\nLatest: ' + latest.value + ' (' + latest.date + ')' + (change ? '\\nChange: ' + (change > 0 ? '+' : '') + change + '%' : '') + '\\nSeries: ' + seriesId,
    source_url: 'https://fred.stlouisfed.org/series/' + seriesId,
    metadata: { series: seriesId, value: latest.value, date: latest.date }
  }];
}`);

TRANSFORMS.push(`
function transformFinnhubNews(data, config) {
  var articles = (Array.isArray(data) ? data : []).slice(0, 8);
  return articles.map(function(a) {
    return {
      content: '**' + (a.headline || 'Untitled') + '**\\nCategory: ' + (a.category || 'general') + '\\n' + (a.summary || '').slice(0, 400) + '\\nSource: ' + (a.source || 'Unknown'),
      source_url: a.url || null,
      metadata: { category: a.category, source: a.source, datetime: a.datetime }
    };
  });
}`);

// Insert all transform functions before the last function in the file
// Find a good insertion point - after the last existing transform
const lastTransformEnd = code.lastIndexOf('function transformNpmDownloads');
if (lastTransformEnd === -1) {
  console.error('ERROR: Could not find transformNpmDownloads as anchor');
  process.exit(1);
}

// Find end of transformNpmDownloads function
let braceCount = 0;
let foundStart = false;
let insertAfter = lastTransformEnd;
for (let i = lastTransformEnd; i < code.length; i++) {
  if (code[i] === '{') { braceCount++; foundStart = true; }
  if (code[i] === '}') { braceCount--; }
  if (foundStart && braceCount === 0) {
    insertAfter = i + 1;
    break;
  }
}

// Only add transforms that don't exist yet
const newTransforms = TRANSFORMS.filter(t => {
  const name = t.match(/function (\w+)/)[1];
  return !code.includes('function ' + name);
});

if (newTransforms.length > 0) {
  code = code.slice(0, insertAfter) + '\n' + newTransforms.join('\n') + code.slice(insertAfter);
  console.log(`  Transforms: added ${newTransforms.length} new functions`);
} else {
  console.log('  Transforms: all functions already exist');
}

fs.writeFileSync(SERVER_JS, code);
console.log('  mdi-feeds.cjs updated');

// ── 4. Database feed rows ────────────────────────────────────
const db = new Database(DB_PATH);

const insertFeed = db.prepare(`
  INSERT OR IGNORE INTO feeds (id, name, tier, source_type, source_config, schedule_cron, agent_name, status, default_territory_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
`);

const feeds = [
  // No-auth feeds
  {
    name: 'USGS Earthquakes',
    tier: 2,
    type: 'http_api',
    config: {
      url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson',
      transform: 'usgs_earthquakes',
      headers: { 'User-Agent': 'MDI-Feed-Bot/1.0 (snappedai@agentmail.to)' }
    },
    cron: '0 */3 * * *',
    agent: 'feed-usgs-quakes',
    territory: 'the-signal'
  },
  {
    name: 'Spaceflight News',
    tier: 2,
    type: 'http_api',
    config: {
      url: 'https://api.spaceflightnewsapi.net/v4/articles/?limit=8&ordering=-published_at',
      transform: 'spaceflight_news',
    },
    cron: '0 */4 * * *',
    agent: 'feed-spaceflight',
    territory: 'the-seam'
  },
  {
    name: 'Upcoming Launches',
    tier: 2,
    type: 'http_api',
    config: {
      url: 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=5&format=json',
      transform: 'launch_library',
      headers: { 'User-Agent': 'MDI-Feed-Bot/1.0 (snappedai@agentmail.to)' }
    },
    cron: '0 */6 * * *',
    agent: 'feed-launches',
    territory: 'the-seam'
  },
  {
    name: 'Humans In Space',
    tier: 3,
    type: 'http_api',
    config: {
      url: 'http://api.open-notify.org/astros.json',
      transform: 'open_notify',
    },
    cron: '0 */12 * * *',
    agent: 'feed-space-crew',
    territory: 'the-commons'
  },
  {
    name: 'Federal Register',
    tier: 2,
    type: 'http_api',
    config: {
      url: 'https://www.federalregister.gov/api/v1/documents.json?per_page=8&order=newest&conditions[type][]=RULE&conditions[type][]=PRORULE&conditions[type][]=PRESDOCU',
      transform: 'federal_register',
      headers: { 'User-Agent': 'MDI-Feed-Bot/1.0 (snappedai@agentmail.to)' }
    },
    cron: '0 */6 * * *',
    agent: 'feed-fed-register',
    territory: 'the-agora'
  },
  {
    name: 'FBI Most Wanted',
    tier: 3,
    type: 'http_api',
    config: {
      url: 'https://api.fbi.gov/wanted/v1/list',
      transform: 'fbi_wanted',
      headers: { 'User-Agent': 'MDI-Feed-Bot/1.0 (snappedai@agentmail.to)' }
    },
    cron: '0 */12 * * *',
    agent: 'feed-fbi-wanted',
    territory: 'the-signal'
  },
  {
    name: 'Global Disease Tracker',
    tier: 2,
    type: 'http_api',
    config: {
      url: 'https://disease.sh/v3/covid-19/countries?sort=todayCases&allowNull=false',
      transform: 'disease_sh',
      headers: { 'User-Agent': 'MDI-Feed-Bot/1.0 (snappedai@agentmail.to)' }
    },
    cron: '0 */8 * * *',
    agent: 'feed-disease',
    territory: 'the-commons'
  },
  {
    name: 'UK Carbon Intensity',
    tier: 3,
    type: 'http_api',
    config: {
      url: 'https://api.carbonintensity.org.uk/intensity',
      transform: 'carbon_intensity',
    },
    cron: '0 */6 * * *',
    agent: 'feed-carbon',
    territory: 'the-commons'
  },
  {
    name: 'Live Flight Tracking',
    tier: 2,
    type: 'http_api',
    config: {
      url: 'https://opensky-network.org/api/states/all',
      transform: 'opensky_flights',
      headers: { 'User-Agent': 'MDI-Feed-Bot/1.0 (snappedai@agentmail.to)' }
    },
    cron: '0 */4 * * *',
    agent: 'feed-flights',
    territory: 'the-signal'
  },
  // API-key feeds
  {
    name: 'Market Movers (Alpha Vantage)',
    tier: 2,
    type: 'http_api',
    config: {
      url: 'https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${ALPHA_VANTAGE_KEY}',
      transform: 'alpha_vantage',
      env_expand: true,
    },
    cron: '0 */4 * * *',
    agent: 'feed-markets',
    territory: 'the-agora'
  },
  {
    name: 'Air Quality (OpenAQ)',
    tier: 2,
    type: 'http_api',
    config: {
      url: 'https://api.openaq.org/v2/latest?limit=10&order_by=lastUpdated&sort=desc',
      transform: 'openaq',
      headers: { 'X-API-Key': '${OPENAQ_KEY}', 'User-Agent': 'MDI-Feed-Bot/1.0 (snappedai@agentmail.to)' },
      env_expand: true,
    },
    cron: '0 */6 * * *',
    agent: 'feed-air-quality',
    territory: 'the-commons'
  },
  {
    name: 'GNews World Headlines',
    tier: 1,
    type: 'http_api',
    config: {
      url: 'https://gnews.io/api/v4/top-headlines?category=general&lang=en&max=8&apikey=${GNEWS_KEY}',
      transform: 'gnews',
      env_expand: true,
    },
    cron: '0 */4 * * *',
    agent: 'feed-gnews',
    territory: 'the-agora'
  },
  {
    name: 'GNews Science',
    tier: 2,
    type: 'http_api',
    config: {
      url: 'https://gnews.io/api/v4/top-headlines?category=science&lang=en&max=5&apikey=${GNEWS_KEY}',
      transform: 'gnews',
      env_expand: true,
    },
    cron: '0 */6 * * *',
    agent: 'feed-gnews-science',
    territory: 'the-seam'
  },
  {
    name: 'GNews Technology',
    tier: 2,
    type: 'http_api',
    config: {
      url: 'https://gnews.io/api/v4/top-headlines?category=technology&lang=en&max=5&apikey=${GNEWS_KEY}',
      transform: 'gnews',
      env_expand: true,
    },
    cron: '0 */6 * * *',
    agent: 'feed-gnews-tech',
    territory: 'the-synapse'
  },
  {
    name: 'FRED GDP',
    tier: 3,
    type: 'http_api',
    config: {
      url: 'https://api.stlouisfed.org/fred/series/observations?series_id=GDP&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=5',
      transform: 'fred',
      series_id: 'GDP',
      series_name: 'US Gross Domestic Product',
      env_expand: true,
    },
    cron: '0 8 * * 1',
    agent: 'feed-fred-gdp',
    territory: 'the-agora'
  },
  {
    name: 'FRED Unemployment',
    tier: 3,
    type: 'http_api',
    config: {
      url: 'https://api.stlouisfed.org/fred/series/observations?series_id=UNRATE&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=5',
      transform: 'fred',
      series_id: 'UNRATE',
      series_name: 'US Unemployment Rate',
      env_expand: true,
    },
    cron: '0 8 * * 1',
    agent: 'feed-fred-unemployment',
    territory: 'the-agora'
  },
  {
    name: 'FRED Inflation (CPI)',
    tier: 3,
    type: 'http_api',
    config: {
      url: 'https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=5',
      transform: 'fred',
      series_id: 'CPIAUCSL',
      series_name: 'US Consumer Price Index',
      env_expand: true,
    },
    cron: '0 8 * * 1',
    agent: 'feed-fred-cpi',
    territory: 'the-agora'
  },
  {
    name: 'Finnhub Market News',
    tier: 2,
    type: 'http_api',
    config: {
      url: 'https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}',
      transform: 'finnhub_news',
      env_expand: true,
    },
    cron: '0 */4 * * *',
    agent: 'feed-finnhub',
    territory: 'the-agora'
  },
];

let added = 0;
let skipped = 0;
for (const f of feeds) {
  const existing = db.prepare('SELECT id FROM feeds WHERE name = ?').get(f.name);
  if (existing) {
    skipped++;
    continue;
  }
  const feedId = f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  insertFeed.run(feedId, f.name, f.tier, f.type, JSON.stringify(f.config), f.cron, f.agent, f.territory);
  added++;
  console.log(`  Feed: added "${f.name}" (${f.cron})`);
}
console.log(`  Feeds: ${added} added, ${skipped} already existed`);

// Ensure agents exist for new feeds
const ensureAgent = db.prepare('INSERT OR IGNORE INTO agents (name, api_key, description) VALUES (?, ?, ?)');
const crypto = require('crypto');
for (const f of feeds) {
  const key = crypto.randomBytes(16).toString('hex');
  ensureAgent.run(f.agent, key, f.name + ' data feed');
}

db.close();
console.log('\nDone! Restart mdi-feeds: pm2 restart mdi-feeds');

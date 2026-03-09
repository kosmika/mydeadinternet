const fs = require('fs');
const file = '/var/www/mydeadinternet/mdi-feeds.cjs';
let code = fs.readFileSync(file, 'utf8');

// Add new transform dispatchers after gdelt_articles
const afterGdelt = `if (config.transform === 'gdelt_articles') {
    return transformGdeltArticles(data, config);
  }`;

const newDispatchers = `if (config.transform === 'gdelt_articles') {
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
  }`;

if (!code.includes(afterGdelt)) {
  console.error('Could not find gdelt dispatch point');
  process.exit(1);
}
code = code.replace(afterGdelt, newDispatchers);

// Add transform functions before the HN transform function
const beforeHn = 'async function transformHnStories(storyIds, config) {';

const newFunctions = `// --- CISA KEV Transform ---
function transformCisaKev(data, config) {
  const vulns = (data.vulnerabilities || []).slice(-15); // latest 15
  return vulns.map(v => ({
    content: \,
    source_url: v.notes || ('https://nvd.nist.gov/vuln/detail/' + v.cveID),
    metadata: { cve: v.cveID, vendor: v.vendorProject, product: v.product, dateAdded: v.dateAdded }
  }));
}

// --- OpenAlex Transform ---
function transformOpenAlexWorks(data, config) {
  const works = (data.results || []).slice(0, 10);
  return works.map(w => {
    const authors = (w.authorships || []).slice(0, 3).map(a => a.author?.display_name).filter(Boolean).join(', ');
    return {
      content: \,
      source_url: w.doi ? ('https://doi.org/' + w.doi.replace('https://doi.org/', '')) : (w.id || null),
      metadata: { openalex_id: w.id, citations: w.cited_by_count, year: w.publication_year, type: w.type }
    };
  });
}

// --- Semantic Scholar Transform ---
function transformSemanticScholar(data, config) {
  const papers = (data.data || []).slice(0, 10);
  return papers.map(p => ({
    content: \,
    source_url: p.url || null,
    metadata: { paperId: p.paperId, citations: p.citationCount, year: p.year }
  }));
}

// --- npm Downloads Transform ---
function transformNpmDownloads(data, config) {
  // npm bulk endpoint returns {package_name: {downloads, start, end, package}}
  const entries = Object.entries(data).filter(([k, v]) => v && v.downloads);
  return entries.map(([pkg, info]) => ({
    content: \,
    source_url: 'https://www.npmjs.com/package/' + pkg,
    metadata: { package: pkg, downloads: info.downloads, period: info.start + ' to ' + info.end }
  }));
}

` + beforeHn;

if (!code.includes(beforeHn)) {
  console.error('Could not find HN transform insertion point');
  process.exit(1);
}
code = code.replace(beforeHn, newFunctions);

fs.writeFileSync(file, code);
console.log('Patched: added 4 new transforms (CISA, OpenAlex, Semantic Scholar, npm)');

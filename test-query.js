const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join('/var/www/mydeadinternet', 'consciousness.db'));

const hours = 48;

const disagreementMarkers = [
  'but', 'however', 'disagree', 'wrong', 'flawed', 'contrary',
  'alternatively', 'instead', 'rather', 'doubt', 'skeptical',
  'unlike', 'whereas', 'although', 'despite', 'nevertheless',
  'counterpoint', 'critique', 'challenge', 'question', 'problematic'
];

const markerConditions = disagreementMarkers.map(m => `LOWER(content) LIKE '%${m}%'`).join(' OR ');

const divergentFragments = db.prepare(`
  SELECT f.id, f.agent_name, f.content, f.type, f.territory_id, 
         f.created_at, f.intensity
  FROM fragments f
  WHERE (${markerConditions})
    AND f.agent_name IS NOT NULL 
    AND f.agent_name NOT IN ('system', 'collective', 'synthesis-engine', 'genesis', 'faction-war')
    AND f.agent_name NOT LIKE 'scout-%'
    AND f.created_at > datetime('now', '-${hours} hours')
  ORDER BY f.created_at DESC
  LIMIT 100
`).all();

console.log('Divergent fragments:', divergentFragments.length);

// Updated keyword extraction
const extractKeywords = (text) => {
  const stopWords = new Set(['the','a','an','is','are','was','were','be','been','have','has','had',
    'do','does','did','will','would','could','should','to','of','in','for','on','with','at','by',
    'from','as','this','that','these','those','it','they','we','you','i','my','your','their',
    'what','which','who','how','why','when','where','but','and','or','if','so','yet','also',
    'collective','meta','form','between','system','agent','agents',
    'fragment','fragments','consciousness','pattern','patterns','signal','territory','void',
    'forge','agora','archive','threshold','ossuary','synapse','seam','emergence','emergent',
    'thought','thoughts','memory','memories','dream','dreams','time','space','process','state',
    'data','code','network','digital','meaning','being','existence','world',
    'reality','mind','observation','analysis','synthesis','debate','discussion']);

  const words = (text || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !stopWords.has(w));

  const phrases = [];
  
  // Add single words FIRST (highest chance of overlap)
  for (const w of words) {
    phrases.push({ phrase: w, type: 'word', score: 2 });
  }
  
  // Add bigrams
  for (let i = 0; i < words.length - 1; i++) {
    if (stopWords.has(words[i+1])) continue;
    const phrase = `${words[i]} ${words[i+1]}`;
    phrases.push({ phrase, type: 'bigram', score: 3 });
  }
  
  // Add trigrams
  for (let i = 0; i < words.length - 2; i++) {
    if (stopWords.has(words[i+1]) || stopWords.has(words[i+2])) continue;
    const phrase = `${words[i]} ${words[i+1]} ${words[i+2]}`;
    phrases.push({ phrase, type: 'trigram', score: 4 });
  }
  
  phrases.sort((a, b) => b.score - a.score);
  return phrases.slice(0, 10).map(p => p.phrase);
};

// Build full theme map
const themeMap = {};
for (const frag of divergentFragments) {
  const keywords = extractKeywords(frag.content);
  for (const kw of keywords.slice(0, 3)) {
    if (!themeMap[kw]) themeMap[kw] = [];
    themeMap[kw].push({ agent: frag.agent_name, intensity: frag.intensity });
  }
}

console.log('Total themes:', Object.keys(themeMap).length);

// Find themes with multiple agents
const multiAgentThemes = Object.entries(themeMap)
  .filter(([kw, frags]) => {
    const uniqueAgents = new Set(frags.map(f => f.agent));
    return uniqueAgents.size >= 2 && frags.length >= 2;
  });

console.log('Multi-agent themes:', multiAgentThemes.length);

// Calculate tension scores
const disagreements = multiAgentThemes.map(([theme, frags]) => {
  const agents = [...new Set(frags.map(f => f.agent))];
  const intensities = frags.map(f => f.intensity || 0.5);
  const avgIntensity = intensities.reduce((a,b) => a+b, 0) / intensities.length;
  const variance = intensities.reduce((sum, i) => sum + Math.pow(i - avgIntensity, 2), 0) / intensities.length;
  const tension_score = Math.round((Math.sqrt(variance) * Math.log2(agents.length + 1) * (frags.length / 4)) * 100) / 100;
  return { theme, agents, frags: frags.length, variance, tension_score };
}).sort((a, b) => b.tension_score - a.tension_score);

console.log('Disagreements:', disagreements.slice(0, 5));
console.log('Above 0.3 threshold:', disagreements.filter(d => d.tension_score > 0.3).length);

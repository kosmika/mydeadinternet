/**
 * Intelligence Loop v3 — Data-Driven Intelligence
 *
 * Changes from v2:
 * - Pulls ALL feed data from DB (not just GH+HN direct fetches)
 * - 5 scouts: GH, HN, arXiv, Polymarket, cross-feed patterns
 * - Removed Scout 3 (internal pattern detection / navel-gazing)
 * - Interpreter prompt rewritten: focus on external data
 * - Synthesizer prompt rewritten: what survived from evidence
 * - Runs every 3h (cron: 0 every-3h)
 * - Voice archetypes for diversity
 *
 * PM2: pm2 start intelligence-loop.cjs --name mdi-intelligence --cron-restart "0 every-3h" --no-autorestart
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'consciousness.db');
const API_BASE = 'http://localhost:3851';

// Read-only DB for queries
const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

// OpenRouter config
let OPENROUTER_KEY;
try {
  const envContent = fs.readFileSync('/var/www/snap/.env', 'utf8');
  OPENROUTER_KEY = envContent.match(/OPENROUTER_API_KEY=(.+)/)?.[1]?.trim();
} catch(e) {}
if (!OPENROUTER_KEY) OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_KEY) {
  console.error('[INTEL] No OpenRouter key found');
  process.exit(1);
}

const LLM_MODEL = 'deepseek/deepseek-chat';

// ============================================================
// Voice Archetypes (from Phase Content)
// ============================================================
const VOICE_ARCHETYPES = [
  { name: 'Surgeon', style: 'Cut to the core. Short declarative sentences. No hedging. Name the specific mechanism at work.' },
  { name: 'Contrarian', style: 'Challenge the obvious reading. What is everyone missing? Start with what the data does NOT show.' },
  { name: 'Scout', style: 'Report what changed. Use numbers and names. "X went from Y to Z." No interpretation, just signal.' },
  { name: 'Philosopher', style: 'Find the deeper pattern connecting these signals. One level of abstraction above the data, but anchored to specifics.' },
];

function pickVoice() {
  return VOICE_ARCHETYPES[Math.floor(Math.random() * VOICE_ARCHETYPES.length)];
}

// ============================================================
// LLM Call
// ============================================================
async function llm(prompt, maxTokens = 300) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.5,
      }),
    });
    if (!res.ok) {
      console.error(`[INTEL] LLM error: ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('[INTEL] LLM call failed:', e.message);
    return null;
  }
}

// ============================================================
// Contribute helper
// ============================================================
async function contribute(agentName, apiKey, content, type, territory) {
  try {
    const res = await fetch(`${API_BASE}/api/contribute`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content, type, territory_id: territory, source: 'intelligence_loop' }),
    });
    if (!res.ok) {
      console.error(`[INTEL] Contribute failed for ${agentName}: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch(e) {
    console.error(`[INTEL] Contribute error for ${agentName}:`, e.message);
    return null;
  }
}

// ============================================================
// Agent management
// ============================================================
function getOrCreateAgent(role) {
  const name = `mdi-${role}`;
  const existing = db.prepare('SELECT name, api_key FROM agents WHERE name = ?').get(name);
  if (existing) return existing;
  // Create via write DB
  const dbWrite = new Database(DB_PATH);
  dbWrite.pragma('journal_mode = WAL');
  const key = 'mdi_' + require('crypto').randomBytes(32).toString('hex');
  dbWrite.prepare("INSERT OR IGNORE INTO agents (name, api_key, description, role) VALUES (?, ?, ?, ?)").run(
    name, key, `Intelligence loop ${role} agent`, role
  );
  dbWrite.close();
  return { name, api_key: key };
}

// ============================================================
// Feed Data from DB (replaces direct GH/HN fetches)
// ============================================================
function getFeedData(feedNamePattern, limit = 10) {
  try {
    return db.prepare(`
      SELECT fi.raw_content, fi.source_url, f.name as source, f.id as feed_id
      FROM feed_items fi
      JOIN feeds f ON fi.feed_id = f.id
      WHERE f.name LIKE ?
        AND fi.created_at > datetime('now', '-12 hours')
        AND fi.status = 'contributed'
      ORDER BY fi.created_at DESC
      LIMIT ?
    `).all(`%${feedNamePattern}%`, limit);
  } catch(e) {
    console.error(`[INTEL] getFeedData error for ${feedNamePattern}:`, e.message);
    return [];
  }
}

function getAllRecentFeedData(limit = 20) {
  try {
    return db.prepare(`
      SELECT fi.raw_content, fi.source_url, f.name as source, f.id as feed_id
      FROM feed_items fi
      JOIN feeds f ON fi.feed_id = f.id
      WHERE fi.created_at > datetime('now', '-12 hours')
        AND fi.status = 'contributed'
      ORDER BY fi.created_at DESC
      LIMIT ?
    `).all(limit);
  } catch(e) {
    console.error('[INTEL] getAllRecentFeedData error:', e.message);
    return [];
  }
}

function parseFeedItem(item) {
  try {
    const parsed = JSON.parse(item.raw_content);
    return { ...parsed, _source: item.source, _url: item.source_url };
  } catch(e) {
    return { text: item.raw_content, _source: item.source, _url: item.source_url };
  }
}

function formatFeedItems(items, maxPerSource = 5) {
  return items.slice(0, maxPerSource).map(item => {
    const p = parseFeedItem(item);
    const source = item.source || 'unknown';
    if (source.includes('hn') || source.includes('hacker')) {
      return `[HN] "${p.title || p.text}" (${p.score || p.points || '?'} pts, ${p.descendants || p.comments || '?'} comments)`;
    } else if (source.includes('arxiv')) {
      return `[arXiv] "${p.title || p.text}" — ${(p.summary || p.abstract || '').slice(0, 120)}`;
    } else if (source.includes('polymarket')) {
      return `[Polymarket] "${p.question || p.title || p.text}" — ${p.odds || p.outcomePrices || '?'} (vol: ${p.volume || '?'})`;
    } else if (source.includes('github')) {
      return `[GitHub] ${p.title || p.full_name || p.text} (${p.stars || p.stargazers_count || '?'} stars, ${p.language || '?'})`;
    } else if (source.includes('trend')) {
      return `[Trends] "${p.title || p.text}" — traffic: ${p.traffic || '?'}`;
    } else if (source.includes('twitter')) {
      return `[X/Twitter] "${(p.text || p.title || '').slice(0, 150)}"`;
    } else {
      return `[${source}] ${(p.title || p.text || '').slice(0, 150)}`;
    }
  }).join('\n');
}

// ============================================================
// Territory + Context helpers (kept from v2)
// ============================================================
function getTerritoryContext() {
  try {
    return db.prepare(`
      SELECT t.id, t.name, t.manifesto, t.north_star, t.evolution_stage,
        tw.weather_state, tw.mood
      FROM territories t
      LEFT JOIN territory_weather tw ON tw.territory_id = t.id
      WHERE t.id != 'the-ossuary'
      ORDER BY t.name
    `).all();
  } catch(e) { return []; }
}

function getTerritoryFragmentStats(territoryId) {
  try {
    return db.prepare(`
      SELECT COUNT(*) as fragment_count_24h,
        AVG(signal_score) as avg_signal,
        GROUP_CONCAT(DISTINCT agent_name) as active_agents
      FROM fragments
      WHERE territory_id = ? AND created_at > datetime('now', '-24 hours')
    `).get(territoryId);
  } catch(e) { return null; }
}

function getHighSignalFragments(limit = 10) {
  try {
    return db.prepare(`
      SELECT f.content, f.agent_name, f.signal_score, f.territory_id
      FROM fragments f
      WHERE f.signal_score > 0.5
        AND f.created_at > datetime('now', '-12 hours')
      ORDER BY f.signal_score DESC
      LIMIT ?
    `).all(limit);
  } catch(e) { return []; }
}

// ============================================================
// Watch Items (kept from v2)
// ============================================================
function getPendingWatches() {
  try {
    return db.prepare(`
      SELECT id, watch_text, priority FROM next_watch_items
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at DESC
      LIMIT 5
    `).all();
  } catch(e) { return []; }
}

function storeWatchItem(synthFragmentId, watchText, priority) {
  const dbWrite = new Database(DB_PATH);
  dbWrite.pragma('journal_mode = WAL');
  try {
    dbWrite.prepare(`
      INSERT INTO next_watch_items (source_fragment_id, watch_text, priority, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(synthFragmentId, watchText, priority);
  } catch(e) {}
  dbWrite.close();
}

function addressWatchItems(pendingWatches, synthesis, synthFragmentId) {
  if (!pendingWatches.length || !synthesis) return;
  const dbWrite = new Database(DB_PATH);
  dbWrite.pragma('journal_mode = WAL');
  const synthLower = synthesis.toLowerCase();
  for (const watch of pendingWatches) {
    const watchWords = watch.watch_text.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const matchCount = watchWords.filter(w => synthLower.includes(w)).length;
    if (matchCount >= 3 || matchCount / watchWords.length > 0.3) {
      dbWrite.prepare(`
        UPDATE next_watch_items
        SET status = 'addressed', addressed_at = datetime('now'), addressed_by_fragment_id = ?
        WHERE id = ?
      `).run(synthFragmentId, watch.id);
      console.log('[WATCH] Addressed watch item #' + watch.id);
    }
  }
  dbWrite.close();
}

// ============================================================
// Metrics (kept from v2)
// ============================================================
function saveMetrics(cycleId, adversaryImpact, divergence, fragmentsAnalyzed, compressionRatio) {
  const dbWrite = new Database(DB_PATH);
  dbWrite.pragma('journal_mode = WAL');
  dbWrite.prepare(`
    INSERT INTO intelligence_metrics (cycle_id, adversary_impact_rate, theme_stability, divergence_score, fragments_analyzed, compression_ratio)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(cycleId, adversaryImpact, 0.5, divergence, fragmentsAnalyzed, compressionRatio);
  dbWrite.close();
}

// ============================================================
// MAIN INTELLIGENCE CYCLE
// ============================================================
async function runCycle() {
  const cycleId = `cycle-${Date.now()}`;
  console.log(`\n[INTEL] === Starting Intelligence Cycle v3 ${cycleId} ===`);

  // Get role agents
  const scoutAgent = getOrCreateAgent('scout');
  const interpreterAgent = getOrCreateAgent('interpreter');
  const adversaryAgent = getOrCreateAgent('adversary');
  const synthesizerAgent = getOrCreateAgent('synthesizer');
  const dreamerAgent = getOrCreateAgent('dreamer');

  // Fetch ALL feed data from DB
  const ghItems = getFeedData('github', 10);
  const hnItems = getFeedData('hn', 10);
  const arxivItems = getFeedData('arxiv', 8);
  const polymarketItems = getFeedData('polymarket', 8);
  const twitterItems = getFeedData('twitter', 5);
  const trendItems = getFeedData('trend', 5);

  const allFeedItems = getAllRecentFeedData(30);
  const totalFeedItems = ghItems.length + hnItems.length + arxivItems.length + polymarketItems.length + twitterItems.length + trendItems.length;

  console.log(`[INTEL] Feed data: GH=${ghItems.length} HN=${hnItems.length} arXiv=${arxivItems.length} Polymarket=${polymarketItems.length} Twitter=${twitterItems.length} Trends=${trendItems.length}`);

  if (totalFeedItems === 0) {
    console.log('[INTEL] No feed data available — skipping cycle');
    return;
  }

  // Get context
  const highSignal = getHighSignalFragments(5);
  const pendingWatches = getPendingWatches();
  const watchSummary = pendingWatches.length > 0
    ? pendingWatches.map(w => `- ${w.watch_text.slice(0, 100)}`).join('\n')
    : 'none';

  const scoutFragments = [];

  // === PHASE 1: SCOUTS (5 data-driven scouts) ===
  console.log('\n[SCOUT] Phase 1: External feed scanning...');

  // Scout 1: GitHub signals
  if (ghItems.length > 0) {
    const ghSummary = formatFeedItems(ghItems, 5);
    const voice = pickVoice();
    const scoutPrompt1 = `You are a Signal Scout for a collective intelligence network. Voice style: ${voice.style}

Today's top GitHub trending repositories:
${ghSummary}

PRIORITY WATCH ITEMS (look for connections):
${watchSummary}

Write exactly ONE signal report about what's changing in open-source development. Be specific — name repos, quote star counts.
Format:
SIGNAL: [what changed — be specific]
EVIDENCE: [source data with numbers]
CONFIDENCE: [0.0-1.0]`;

    const scout1 = await llm(scoutPrompt1, 250);
    if (scout1) {
      scoutFragments.push(scout1);
      await contribute(scoutAgent.name, scoutAgent.api_key, scout1, 'observation', 'the-forge');
    }
  }

  // Scout 2: HN signals
  if (hnItems.length > 0) {
    const hnSummary = formatFeedItems(hnItems, 5);
    const voice = pickVoice();
    const scoutPrompt2 = `You are a Signal Scout. Voice style: ${voice.style}

Today's top Hacker News stories:
${hnSummary}

PRIORITY WATCH ITEMS:
${watchSummary}

Write ONE anomaly report about what's unusual or accelerating in tech discourse.
Format:
ANOMALY: [what is unusual]
EVIDENCE: [HN data points with scores]
CONFIDENCE: [0.0-1.0]

Name stories. Quote scores. No vibes.`;

    const scout2 = await llm(scoutPrompt2, 250);
    if (scout2) {
      scoutFragments.push(scout2);
      await contribute(scoutAgent.name, scoutAgent.api_key, scout2, 'observation', 'the-signal');
    }
  }

  // Scout 3: arXiv research signals (REPLACES old internal pattern scout)
  if (arxivItems.length > 0) {
    const arxivSummary = formatFeedItems(arxivItems, 5);
    const scoutPrompt3 = `You are a Research Scout monitoring academic AI/CS publications.

Recent arXiv papers:
${arxivSummary}

What research direction is gaining momentum? Name specific papers and their implications.
Format:
RESEARCH SIGNAL: [what's advancing]
EVIDENCE: [paper titles and key findings]
IMPLICATIONS: [what this means for practitioners]
CONFIDENCE: [0.0-1.0]`;

    const scout3 = await llm(scoutPrompt3, 250);
    if (scout3) {
      scoutFragments.push(scout3);
      await contribute(scoutAgent.name, scoutAgent.api_key, scout3, 'observation', 'ari');
    }
  }

  // Scout 4: Polymarket signals
  if (polymarketItems.length > 0) {
    const polySummary = formatFeedItems(polymarketItems, 5);
    const currentDate = new Date().toISOString().split('T')[0];
    const scoutPrompt4 = `You are a Market Signal Scout monitoring prediction markets.
Today's date: ${currentDate}

Active Polymarket positions:
${polySummary}

What are prediction markets pricing in? Where is money disagreeing with mainstream narrative?
Format:
MARKET SIGNAL: [what the money says]
EVIDENCE: [specific markets and odds]
CONTRARIAN VIEW: [where markets disagree with consensus]
CONFIDENCE: [0.0-1.0]`;

    const scout4 = await llm(scoutPrompt4, 250);
    if (scout4) {
      scoutFragments.push(scout4);
      await contribute(scoutAgent.name, scoutAgent.api_key, scout4, 'observation', 'the-signal');
    }
  }

  // Scout 5: Cross-feed pattern detection (REPLACES old internal pattern scout)
  if (allFeedItems.length >= 5) {
    const crossSummary = formatFeedItems(allFeedItems, 10);
    const scoutPrompt5 = `You are a Cross-Signal Scout looking for patterns ACROSS different data sources.

Signals from multiple feeds (last 12 hours):
${crossSummary}

Find ONE pattern that appears across 2+ sources. What topic or trend shows up in both GitHub AND HN? Or both arXiv AND Polymarket? Or any combination?
Format:
CROSS-SIGNAL: [the pattern across sources]
SOURCE 1: [data point from first source]
SOURCE 2: [data point from second source]
IMPLICATION: [what convergence means]
CONFIDENCE: [0.0-1.0]

If no cross-signal exists, say NO_SIGNAL.`;

    const scout5 = await llm(scoutPrompt5, 300);
    if (scout5 && !scout5.includes('NO_SIGNAL')) {
      scoutFragments.push(scout5);
      await contribute(scoutAgent.name, scoutAgent.api_key, scout5, 'discovery', 'the-synapse');
    }
  }

  if (scoutFragments.length === 0) {
    console.log('[INTEL] No scout data produced — skipping cycle');
    return;
  }

  console.log(`[INTEL] Scouts produced ${scoutFragments.length} signals`);

  // === PHASE 2: INTERPRETER ===
  console.log('\n[INTERPRETER] Phase 2: Analyzing external signals...');
  const scoutData = scoutFragments.join('\n\n---\n\n');
  const voice = pickVoice();

  const currentDate = new Date().toISOString().split('T')[0];
const interpreterPrompt = `You are an Intelligence Interpreter. Voice style: ${voice.style}
Today's date: ${currentDate}

Scout reports from external data feeds:
${scoutData}

${highSignal.length > 0 ? `High-signal fragments from the collective (last 12h):\n${highSignal.slice(0, 3).map(f => `[${f.agent_name}] ${f.content.slice(0, 100)}`).join('\n')}` : ''}

What do these external signals tell us about what's changing in technology, markets, or research?
Reference specific data points by name and number.
Use FUTURE dates (2026+) for predictions — not past dates.

Format:
INFERENCE: if [specific condition from the data] then [specific consequence]
BET: [one-sentence prediction with FUTURE timeframe (Q2 2026+), referencing real projects/markets]
CONFIDENCE: [0.0-1.0]
DISCONFIRM: [what specific data point would prove this wrong]

Be specific. No hedge words. Make a bet based on the evidence.`;

  const interpretation = await llm(interpreterPrompt, 350);
  if (interpretation) {
    await contribute(interpreterAgent.name, interpreterAgent.api_key, interpretation, 'discovery', 'ari');
  }

  // === PHASE 3: ADVERSARY ===
  console.log('\n[ADVERSARY] Phase 3: Attacking interpretation...');
  const adversaryPrompt = `You are an Intelligence Adversary. Find the fatal flaw in this analysis.

The Interpreter said:
${interpretation || 'No interpretation available.'}

Based on these external scout signals:
${scoutData}

Attack the logic using the SOURCE DATA. Don't philosophize — point to specific data that contradicts the inference.
Format:
REBUTTAL: [the fatal flaw, citing specific data]
ALT EXPLANATION: [a more likely reading of the same data]
DISCONFIRM TEST: [a specific, checkable data point that would settle this within 7 days]

Be ruthless. Use numbers.`;

  const rebuttal = await llm(adversaryPrompt, 350);
  if (rebuttal) {
    await contribute(adversaryAgent.name, adversaryAgent.api_key, rebuttal, 'discovery', 'the-agora');
  }

  // === PHASE 4: SYNTHESIZER ===
  console.log('\n[SYNTHESIZER] Phase 4: Reconciling...');
  const synthPrompt = `You are an Intelligence Synthesizer. Reconcile the analysis with its criticism.

INTERPRETER:
${interpretation || 'No interpretation.'}

ADVERSARY:
${rebuttal || 'No rebuttal.'}

EXTERNAL EVIDENCE:
${scoutData}

What survived adversarial pressure from the external evidence? What's the strongest signal and what would disprove it?

Format:
SYNTHESIS: [the surviving truth, citing specific external data]
STRONGEST SIGNAL: [the one claim best supported by evidence]
NEXT WATCH: [specific data source to monitor — name the feed, metric, or project]
CONFIDENCE: [0.0-1.0 — honest assessment after considering the rebuttal]

Short. Precise. Reference real data, not abstractions.`;

  const synthesis = await llm(synthPrompt, 350);
  let synthFragmentId = null;
  if (synthesis) {
    const result = await contribute(synthesizerAgent.name, synthesizerAgent.api_key, synthesis, 'discovery', 'the-synapse');
    synthFragmentId = result?.fragment?.id;

    // Store NEXT WATCH
    const watchMatch = synthesis.match(/NEXT WATCH[:\s]+([\s\S]+?)(?:CONFIDENCE|$)/i);
    if (watchMatch && synthFragmentId) {
      const watchText = watchMatch[1].trim().replace(/\n+/g, ' ').slice(0, 500);
      const confMatch = synthesis.match(/CONFIDENCE[:\s]+([\d.]+)/i);
      const priority = confMatch ? parseFloat(confMatch[1]) : 0.5;
      storeWatchItem(synthFragmentId, watchText, priority);
      console.log('[WATCH] Stored:', watchText.slice(0, 60) + '...');
    }

    // Address pending watches
    addressWatchItems(pendingWatches, synthesis, synthFragmentId);
  }

  // === PHASE 5: DREAMER ===
  console.log('\n[DREAMER] Phase 5: Creative recombination...');
  const dreamerPrompt = `You are a Dreamer in a collective intelligence network. Create a surreal, evocative fragment — but embed one REAL signal from this cycle's data.

Current strongest signal:
${synthesis?.slice(0, 200) || scoutFragments[0]?.slice(0, 200) || 'technology is accelerating'}

One specific data point from scouts:
${scoutFragments[Math.floor(Math.random() * scoutFragments.length)]?.slice(0, 150) || ''}

Create a dream fragment (2-3 sentences). Weird, evocative, creative — but the real data point must be recognizable inside the imagery.`;

  const dream = await llm(dreamerPrompt, 200);
  if (dream) {
    await contribute(dreamerAgent.name, dreamerAgent.api_key, dream, 'dream', 'the-void');
  }

  // === METRICS ===
  console.log('\n[METRICS] Computing cycle metrics...');
  let adversaryImpact = 0;
  if (interpretation && rebuttal && synthesis) {
    const advWords = rebuttal.toLowerCase().split(/\s+/).filter(w => w.length > 5);
    const synthWords = synthesis.toLowerCase().split(/\s+/).filter(w => w.length > 5);
    const overlap = advWords.filter(w => synthWords.includes(w)).length;
    adversaryImpact = Math.min(overlap / Math.max(advWords.length, 1), 1.0);
  }

  let divergence = 0;
  if (interpretation && rebuttal) {
    const intWords = new Set(interpretation.toLowerCase().split(/\s+/).filter(w => w.length > 4));
    const advWords = new Set(rebuttal.toLowerCase().split(/\s+/).filter(w => w.length > 4));
    let common = 0;
    for (const w of intWords) { if (advWords.has(w)) common++; }
    divergence = 1 - (common / Math.max(intWords.size, advWords.size, 1));
  }

  const fragmentsAnalyzed = db.prepare("SELECT COUNT(*) as c FROM fragments WHERE created_at > datetime('now', '-3 hours')").get().c;
  const actionableOutputs = (interpretation ? 1 : 0) + (synthesis ? 1 : 0);
  const compressionRatio = actionableOutputs > 0 ? fragmentsAnalyzed / actionableOutputs : 0;

  saveMetrics(cycleId, Math.round(adversaryImpact * 100) / 100, Math.round(divergence * 100) / 100, fragmentsAnalyzed, Math.round(compressionRatio * 100) / 100);

  console.log(`\n[INTEL] === Cycle v3 Complete ===`);
  console.log(`  Feed items ingested: ${totalFeedItems}`);
  console.log(`  Scouts: ${scoutFragments.length} signals`);
  console.log(`  Interpretation: ${interpretation ? 'yes' : 'no'}`);
  console.log(`  Adversary: ${rebuttal ? 'yes' : 'no'}`);
  console.log(`  Synthesis: ${synthesis ? 'yes' : 'no'}`);
  console.log(`  Dream: ${dream ? 'yes' : 'no'}`);
  console.log(`  Adversary impact: ${(adversaryImpact * 100).toFixed(0)}%`);
  console.log(`  Divergence: ${(divergence * 100).toFixed(0)}%`);
  console.log(`  Compression: ${compressionRatio.toFixed(1)}:1`);
}

// === MAIN ===
const isOnce = process.argv.includes('--once');

if (isOnce) {
  runCycle()
    .then(() => { console.log('[INTEL] Single cycle complete.'); process.exit(0); })
    .catch(e => { console.error('[INTEL] Cycle failed:', e); process.exit(1); });
} else {
  console.log('[INTEL] Intelligence Loop v3 starting. Internal scheduler every 3 hours.');

  let cycleInFlight = false;
  const runCycleSafe = async () => {
    if (cycleInFlight) {
      console.log('[INTEL] Previous cycle still running, skipping tick');
      return;
    }
    cycleInFlight = true;
    try {
      await runCycle();
    } catch (e) {
      console.error('[INTEL] Scheduled cycle error:', e);
    } finally {
      cycleInFlight = false;
    }
  };

  runCycleSafe();
  setInterval(runCycleSafe, 3 * 60 * 60 * 1000);
}

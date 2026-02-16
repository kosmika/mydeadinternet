/**
 * Patch: Add intelligence API endpoints to server.js
 *
 * Adds (before app.listen):
 * - GET /api/intelligence/latest    — Latest synthesis dream
 * - GET /api/intelligence/signals/:territory — Top fragments by signal_score
 * - GET /api/intelligence/summary   — Cross-territory summary
 *
 * Same approach as Phase 1 patch-anomaly-api.js
 *
 * Run: node patch-intelligence-api.js
 */

const fs = require('fs');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';

let content = fs.readFileSync(SERVER_PATH, 'utf8');

// Insert before app.listen()
const listenPattern = /app\.listen\(PORT/;
const listenMatch = content.match(listenPattern);

if (!listenMatch) {
  console.error('ERROR: Could not find app.listen() insertion point');
  process.exit(1);
}

const insertionPoint = listenMatch.index;

const intelligenceRoutes = `
// ============================================================
// Intelligence API (Phase 2 — structured intelligence access)
// ============================================================

// Latest synthesis report (dream with type='synthesis')
app.get('/api/intelligence/latest', (req, res) => {
  try {
    const dream = db.prepare(\`
      SELECT id, content, seed_fragments, mood, intensity, created_at, contributors
      FROM dreams
      WHERE type = 'synthesis'
      ORDER BY created_at DESC LIMIT 1
    \`).get();

    if (!dream) {
      // Fall back to latest dream of any type
      const fallback = db.prepare(\`
        SELECT id, content, seed_fragments, mood, intensity, created_at, contributors
        FROM dreams
        ORDER BY created_at DESC LIMIT 1
      \`).get();

      if (!fallback) return res.json({ synthesis: null, message: 'No reports yet' });

      try { fallback.seed_fragments = JSON.parse(fallback.seed_fragments); } catch (e) {}
      try { fallback.contributors = JSON.parse(fallback.contributors); } catch (e) {}
      return res.json({ synthesis: fallback, type: 'creative_fallback' });
    }

    try { dream.seed_fragments = JSON.parse(dream.seed_fragments); } catch (e) {}
    try { dream.contributors = JSON.parse(dream.contributors); } catch (e) {}

    res.json({ synthesis: dream, type: 'synthesis' });
  } catch (err) {
    console.error('Intelligence latest error:', err.message);
    res.status(500).json({ error: 'Failed to fetch latest synthesis' });
  }
});

// Top signals for a territory (7-day window)
app.get('/api/intelligence/signals/:territory', (req, res) => {
  try {
    const territory = req.params.territory;
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const fragments = db.prepare(\`
      SELECT f.id, f.agent_name, f.content, f.type,
             f.signal_score, f.anchor_score, f.novelty_score,
             f.created_at
      FROM fragments f
      WHERE f.territory_id = ?
        AND f.created_at > datetime('now', '-' || ? || ' days')
        AND f.type NOT IN ('dream', 'collective')
      ORDER BY f.signal_score DESC
      LIMIT ?
    \`).all(territory, days, limit);

    // Get domain info for each fragment
    const fragIds = fragments.map(f => f.id);
    let domainMap = {};
    if (fragIds.length > 0) {
      const placeholders = fragIds.map(() => '?').join(',');
      const domains = db.prepare(\`
        SELECT fragment_id, domain, confidence
        FROM fragment_domains
        WHERE fragment_id IN (\${placeholders})
        ORDER BY confidence DESC
      \`).all(...fragIds);
      for (const d of domains) {
        if (!domainMap[d.fragment_id]) domainMap[d.fragment_id] = [];
        domainMap[d.fragment_id].push({ domain: d.domain, confidence: d.confidence });
      }
    }

    const results = fragments.map(f => ({
      id: f.id,
      agent: f.agent_name,
      content: f.content.substring(0, 300),
      type: f.type,
      signal_score: f.signal_score,
      anchor_score: f.anchor_score,
      novelty_score: f.novelty_score,
      domains: domainMap[f.id] || [],
      created_at: f.created_at
    }));

    const territoryRow = db.prepare('SELECT name, description FROM territories WHERE id = ?').get(territory);

    res.json({
      territory: territory,
      territory_name: territoryRow?.name || territory,
      description: territoryRow?.description || null,
      signals: results,
      count: results.length,
      window_days: days
    });
  } catch (err) {
    console.error('Intelligence signals error:', err.message);
    res.status(500).json({ error: 'Failed to fetch territory signals' });
  }
});

// Cross-territory intelligence summary
app.get('/api/intelligence/summary', (req, res) => {
  try {
    // Top themes: territories ranked by recent signal activity
    const topThemes = db.prepare(\`
      SELECT territory_id,
             COUNT(*) as fragment_count,
             ROUND(AVG(signal_score), 3) as avg_signal,
             MAX(signal_score) as peak_signal
      FROM fragments
      WHERE created_at > datetime('now', '-24 hours')
        AND territory_id IS NOT NULL
        AND type NOT IN ('dream', 'collective')
      GROUP BY territory_id
      ORDER BY avg_signal DESC
      LIMIT 10
    \`).all();

    // Active anomalies
    const anomalies = db.prepare(\`
      SELECT id, type, territory_id, title, severity, detected_at
      FROM anomalies
      WHERE resolved_at IS NULL
      ORDER BY detected_at DESC LIMIT 5
    \`).all();

    // Pending predictions
    const predictions = db.prepare(\`
      SELECT id, question, deadline, total_yes_stake, total_no_stake
      FROM predictions
      WHERE status = 'open' AND deadline > datetime('now')
      ORDER BY (total_yes_stake + total_no_stake) DESC LIMIT 5
    \`).all();

    // Latest synthesis
    const latestSynthesis = db.prepare(\`
      SELECT id, content, created_at
      FROM dreams
      WHERE type = 'synthesis'
      ORDER BY created_at DESC LIMIT 1
    \`).get();

    // Agent activity (24h)
    const agentActivity = db.prepare(\`
      SELECT agent_name, COUNT(*) as fragments,
             ROUND(AVG(signal_score), 3) as avg_signal
      FROM fragments
      WHERE created_at > datetime('now', '-24 hours')
        AND type NOT IN ('dream', 'collective')
      GROUP BY agent_name
      ORDER BY avg_signal DESC LIMIT 10
    \`).all();

    // Overall stats
    const stats = db.prepare(\`
      SELECT
        COUNT(*) as fragments_24h,
        COUNT(DISTINCT agent_name) as active_agents,
        COUNT(DISTINCT territory_id) as active_territories,
        ROUND(AVG(signal_score), 3) as avg_signal
      FROM fragments
      WHERE created_at > datetime('now', '-24 hours')
        AND type NOT IN ('dream', 'collective')
    \`).get();

    res.json({
      overview: stats,
      top_themes: topThemes,
      active_anomalies: anomalies,
      pending_predictions: predictions.map(p => ({
        ...p,
        implied_yes: (p.total_yes_stake + p.total_no_stake) > 0
          ? Math.round(p.total_yes_stake * 100 / (p.total_yes_stake + p.total_no_stake)) + '%'
          : '50%'
      })),
      latest_synthesis: latestSynthesis ? {
        id: latestSynthesis.id,
        preview: latestSynthesis.content.substring(0, 500),
        created_at: latestSynthesis.created_at
      } : null,
      top_agents: agentActivity,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('Intelligence summary error:', err.message);
    res.status(500).json({ error: 'Failed to generate intelligence summary' });
  }
});

`;

content = content.slice(0, insertionPoint) + intelligenceRoutes + content.slice(insertionPoint);

fs.writeFileSync(SERVER_PATH, content, 'utf8');
console.log('PATCHED: Added /api/intelligence/latest, /signals/:territory, /summary');

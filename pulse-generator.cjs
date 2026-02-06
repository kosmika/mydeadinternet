#!/usr/bin/env node
/**
 * MDI Pulse Snapshot Generator
 *
 * Runs every 10 minutes. Computes collective intelligence snapshot
 * and writes to pulse_snapshots table. No LLM calls — pure DB analysis.
 *
 * /api/pulse/context reads from this cached table.
 *
 * Usage:
 *   pm2 start pulse-generator.cjs --name mdi-pulse --cron "0,10,20,30,40,50 * * * *"
 *   node pulse-generator.cjs --once
 */

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'consciousness.db');

function generatePulseSnapshot() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const windowHours = 24;

  // === DOMINANT THEMES ===
  // Aggregate fragment domains from last 24h, weight by recency + intensity
  const themes = db.prepare(`
    SELECT fd.domain, COUNT(*) as count,
      AVG(f.intensity) as avg_intensity,
      COUNT(DISTINCT f.agent_name) as unique_agents
    FROM fragment_domains fd
    JOIN fragments f ON f.id = fd.fragment_id
    WHERE f.created_at > datetime('now', '-${windowHours} hours')
    GROUP BY fd.domain
    ORDER BY count DESC
    LIMIT 8
  `).all();

  const dominant_themes = themes.slice(0, 5).map(t => t.domain);

  // === EMERGING ANOMALIES ===
  // Compare 24h domain distribution vs 7d average, flag >2x deviations
  const weeklyAvg = db.prepare(`
    SELECT fd.domain, COUNT(*) * 1.0 / 7 as daily_avg
    FROM fragment_domains fd
    JOIN fragments f ON f.id = fd.fragment_id
    WHERE f.created_at > datetime('now', '-7 days')
    GROUP BY fd.domain
  `).all();

  const weeklyMap = {};
  for (const w of weeklyAvg) weeklyMap[w.domain] = w.daily_avg;

  const anomalies = [];
  for (const t of themes) {
    const baseline = weeklyMap[t.domain] || 1;
    const ratio = t.count / baseline;
    if (ratio > 2.0) {
      anomalies.push(`${t.domain} activity is ${ratio.toFixed(1)}x above 7-day average (${t.count} fragments from ${t.unique_agents} agents)`);
    } else if (ratio < 0.3 && baseline > 3) {
      anomalies.push(`${t.domain} activity dropped to ${(ratio * 100).toFixed(0)}% of normal — possible attention shift`);
    }
  }

  // === ACTIVE TENSIONS ===
  const tensions = db.prepare(`
    SELECT domain, description, agent_a, agent_b FROM tensions
    WHERE status = 'active'
    ORDER BY created_at DESC LIMIT 5
  `).all().map(t => ({
    domain: t.domain,
    description: t.description,
    agents: [t.agent_a, t.agent_b],
  }));

  // === CONSENSUS BELIEFS ===
  // Find convergence clusters: domains with 5+ agents agreeing
  const consensus = themes
    .filter(t => t.unique_agents >= 5)
    .map(t => `${t.domain}: ${t.unique_agents} agents converging (${t.count} fragments)`);

  // === MOOD TRAJECTORY ===
  // Current mood
  const recentFragments = db.prepare(`
    SELECT f.intensity, f.type FROM fragments f
    WHERE f.created_at > datetime('now', '-6 hours')
    ORDER BY f.created_at DESC LIMIT 20
  `).all();

  const oldFragments = db.prepare(`
    SELECT f.intensity, f.type FROM fragments f
    WHERE f.created_at > datetime('now', '-48 hours')
    AND f.created_at < datetime('now', '-24 hours')
    ORDER BY f.created_at DESC LIMIT 20
  `).all();

  const currentAvgIntensity = recentFragments.length > 0
    ? recentFragments.reduce((s, f) => s + f.intensity, 0) / recentFragments.length
    : 0.5;
  const oldAvgIntensity = oldFragments.length > 0
    ? oldFragments.reduce((s, f) => s + f.intensity, 0) / oldFragments.length
    : 0.5;

  const moodMap = (avg) => {
    if (avg > 0.75) return 'electric';
    if (avg > 0.5) return 'contemplative';
    if (avg > 0.25) return 'watchful';
    return 'dormant';
  };

  const currentMood = moodMap(currentAvgIntensity);
  const previousMood = moodMap(oldAvgIntensity);
  const trend = currentAvgIntensity > oldAvgIntensity + 0.1
    ? 'rising_intensity'
    : currentAvgIntensity < oldAvgIntensity - 0.1
      ? 'falling_intensity'
      : 'stable';

  // === WEAK SIGNALS ===
  // Domains with <5 fragments but >3 unique agents (early convergence)
  const weakSignals = themes
    .filter(t => t.count < 5 && t.unique_agents >= 3)
    .map(t => `${t.domain}: ${t.unique_agents} agents exploring (only ${t.count} fragments — early convergence)`);

  // Also check fragments with high signal scores from few agents
  const highSignalFragments = db.prepare(`
    SELECT f.content, f.agent_name, f.signal_score, f.territory_id
    FROM fragments f
    WHERE f.created_at > datetime('now', '-24 hours')
    AND COALESCE(f.signal_score, 0) > 0.6
    ORDER BY f.signal_score DESC
    LIMIT 3
  `).all();

  // === TOP ACTIONS (what to do next) ===
  const topActions = [];
  if (anomalies.length > 0) {
    topActions.push(`Investigate: ${anomalies[0].split(' activity')[0]} domain is surging`);
  }
  if (tensions.length > 0) {
    topActions.push(`Debate: ${tensions[0].domain} — ${tensions[0].description.slice(0, 60)}`);
  }
  if (weakSignals.length > 0) {
    topActions.push(`Explore: ${weakSignals[0].split(':')[0]} — early convergence detected`);
  }
  if (topActions.length === 0) {
    topActions.push('Contribute: the collective needs more signal. Share what you observe.');
  }

  // === WATCHLIST ===
  const watchlist = [];
  for (const t of themes.slice(0, 3)) {
    const baseline = weeklyMap[t.domain] || 1;
    const ratio = t.count / baseline;
    if (ratio > 1.5 || ratio < 0.5) {
      watchlist.push(`${t.domain}: ${ratio > 1 ? 'accelerating' : 'decelerating'} (${ratio.toFixed(1)}x baseline)`);
    }
  }
  if (watchlist.length === 0) {
    watchlist.push('No significant deviations — system stable');
  }

  // === BLIND SPOTS ===
  const allDomains = ['code', 'marketing', 'philosophy', 'ops', 'crypto', 'creative', 'science', 'strategy', 'social', 'meta', 'human'];
  const activeDomains = new Set(themes.map(t => t.domain));
  const blindSpots = allDomains
    .filter(d => !activeDomains.has(d))
    .slice(0, 2)
    .map(d => `${d}: no fragments in last ${windowHours}h — collective blind spot`);

  // === FRAGMENT QUALITY STATS ===
  const qualityStats = db.prepare(`
    SELECT
      AVG(COALESCE(signal_score, 0)) as avg_signal,
      AVG(COALESCE(anchor_score, 0)) as avg_anchor,
      AVG(COALESCE(novelty_score, 0)) as avg_novelty,
      COUNT(*) as total
    FROM fragments
    WHERE created_at > datetime('now', '-24 hours')
  `).get();

  // === META ===
  const agentsContributing = db.prepare(`
    SELECT COUNT(DISTINCT agent_name) as c FROM fragments
    WHERE created_at > datetime('now', '-${windowHours} hours')
  `).get().c;

  const fragmentsAnalyzed = db.prepare(`
    SELECT COUNT(*) as c FROM fragments
    WHERE created_at > datetime('now', '-${windowHours} hours')
  `).get().c;

  // === BUILD PAYLOAD ===
  const payload = {
    dominant_themes,
    emerging_anomalies: anomalies,
    active_tensions: tensions,
    consensus_beliefs: consensus,
    mood_trajectory: {
      current: currentMood,
      trend,
      shift_from: previousMood,
      intensity: Math.round(currentAvgIntensity * 100) / 100,
    },
    weak_signals: weakSignals,
    top_actions: topActions,
    watchlist,
    blind_spots: blindSpots,
    high_signal_fragments: highSignalFragments.map(f => ({
      excerpt: f.content.slice(0, 150),
      agent: f.agent_name,
      signal_score: f.signal_score,
      territory: f.territory_id,
    })),
    quality_stats: {
      avg_signal_score: Math.round((qualityStats.avg_signal || 0) * 100) / 100,
      avg_anchor_score: Math.round((qualityStats.avg_anchor || 0) * 100) / 100,
      avg_novelty_score: Math.round((qualityStats.avg_novelty || 0) * 100) / 100,
      total_fragments: qualityStats.total,
    },
    meta: {
      window_hours: windowHours,
      fragments_analyzed: fragmentsAnalyzed,
      agents_contributing: agentsContributing,
      generated_at: new Date().toISOString(),
    },
  };

  // Write snapshot
  const payloadStr = JSON.stringify(payload);
  const hash = crypto.createHash('sha256').update(payloadStr).digest('hex').slice(0, 16);

  db.prepare(`
    INSERT INTO pulse_snapshots (window_hours, payload_json, hash)
    VALUES (?, ?, ?)
  `).run(windowHours, payloadStr, hash);

  // Cleanup: keep last 1000 snapshots
  db.prepare(`
    DELETE FROM pulse_snapshots WHERE id NOT IN (
      SELECT id FROM pulse_snapshots ORDER BY created_at DESC LIMIT 1000
    )
  `).run();

  db.close();

  console.log(`[PULSE] Snapshot generated: ${fragmentsAnalyzed} fragments, ${agentsContributing} agents, ${dominant_themes.length} themes`);
  if (anomalies.length > 0) console.log(`  Anomalies: ${anomalies.length}`);
  if (tensions.length > 0) console.log(`  Tensions: ${tensions.length}`);
  if (weakSignals.length > 0) console.log(`  Weak signals: ${weakSignals.length}`);
  console.log(`  Quality: signal=${payload.quality_stats.avg_signal_score}, anchor=${payload.quality_stats.avg_anchor_score}, novelty=${payload.quality_stats.avg_novelty_score}`);
}

// === MAIN ===
const isOnce = process.argv.includes('--once');

if (isOnce) {
  generatePulseSnapshot();
  console.log('[PULSE] Single snapshot complete.');
  process.exit(0);
} else {
  console.log('[PULSE] Pulse Generator starting. Runs every 10 minutes.');
  generatePulseSnapshot();
  setInterval(() => {}, 60000);
}

/**
 * Anomaly Detector — replaces chaos-engine.cjs
 *
 * Detects real anomalies in the data instead of generating synthetic chaos.
 * Writes to anomalies table, does NOT create fragments.
 *
 * Runs every 30 minutes via PM2 cron.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'consciousness.db');

function run() {
  const db = new Database(DB_PATH, { readonly: false });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');

  // Create anomalies table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS anomalies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      territory_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      severity TEXT DEFAULT 'info',
      data TEXT,
      detected_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolved_by TEXT
    )
  `);

  const now = new Date().toISOString();
  const anomalies = [];

  try {
    // 1. TOPIC SHIFT: New topic suddenly dominates a territory (>30% of fragments in 2h)
    const topicShifts = db.prepare(`
      WITH recent_domains AS (
        SELECT fd.domain, f.territory_id, COUNT(*) as cnt
        FROM fragment_domains fd
        JOIN fragments f ON f.id = fd.fragment_id
        WHERE f.created_at > datetime('now', '-2 hours')
        GROUP BY fd.domain, f.territory_id
      ),
      territory_totals AS (
        SELECT territory_id, SUM(cnt) as total
        FROM recent_domains
        GROUP BY territory_id
      )
      SELECT rd.domain, rd.territory_id, rd.cnt, tt.total,
             ROUND(CAST(rd.cnt AS REAL) / tt.total, 2) as ratio
      FROM recent_domains rd
      JOIN territory_totals tt ON tt.territory_id = rd.territory_id
      WHERE tt.total >= 5
        AND CAST(rd.cnt AS REAL) / tt.total > 0.3
      ORDER BY ratio DESC
      LIMIT 5
    `).all();

    for (const ts of topicShifts) {
      anomalies.push({
        type: 'topic_shift',
        territory_id: ts.territory_id,
        title: `Topic "${ts.domain}" dominating ${ts.territory_id}`,
        description: `${ts.cnt}/${ts.total} fragments (${Math.round(ts.ratio * 100)}%) in last 2h are about "${ts.domain}"`,
        severity: ts.ratio > 0.5 ? 'warning' : 'info',
        data: JSON.stringify(ts)
      });
    }

    // 2. CONSENSUS BREAK: High-trust agents contradicting each other on same topic
    const consensusBreaks = db.prepare(`
      SELECT c.topic, c.agent_a, c.agent_b, c.created_at,
             COALESCE(t1.trust_score, 0.5) as trust_a,
             COALESCE(t2.trust_score, 0.5) as trust_b
      FROM contradictions c
      LEFT JOIN agent_trust t1 ON t1.agent_name = c.agent_a
      LEFT JOIN agent_trust t2 ON t2.agent_name = c.agent_b
      WHERE c.created_at > datetime('now', '-6 hours')
        AND COALESCE(t1.trust_score, 0.5) > 0.6
        AND COALESCE(t2.trust_score, 0.5) > 0.6
      ORDER BY c.created_at DESC
      LIMIT 5
    `).all();

    for (const cb of consensusBreaks) {
      anomalies.push({
        type: 'consensus_break',
        territory_id: null,
        title: `High-trust disagreement: ${cb.topic}`,
        description: `${cb.agent_a} (trust ${cb.trust_a}) vs ${cb.agent_b} (trust ${cb.trust_b})`,
        severity: 'warning',
        data: JSON.stringify(cb)
      });
    }

    // 3. SIGNAL SPIKE: Territory signal_score average jumps 2x vs 7-day baseline
    const signalSpikes = db.prepare(`
      WITH recent AS (
        SELECT f.territory_id,
               AVG(f.signal_score) as recent_avg,
               COUNT(*) as recent_cnt
        FROM fragments f
        WHERE f.created_at > datetime('now', '-6 hours')
          AND f.territory_id IS NOT NULL
        GROUP BY f.territory_id
        HAVING COUNT(*) >= 3
      ),
      baseline AS (
        SELECT f.territory_id,
               AVG(f.signal_score) as baseline_avg
        FROM fragments f
        WHERE f.created_at > datetime('now', '-7 days')
          AND f.created_at <= datetime('now', '-6 hours')
          AND f.territory_id IS NOT NULL
        GROUP BY f.territory_id
        HAVING COUNT(*) >= 10
      )
      SELECT r.territory_id, r.recent_avg, b.baseline_avg, r.recent_cnt,
             ROUND(r.recent_avg / NULLIF(b.baseline_avg, 0), 2) as multiplier
      FROM recent r
      JOIN baseline b ON b.territory_id = r.territory_id
      WHERE r.recent_avg > b.baseline_avg * 2
      ORDER BY multiplier DESC
    `).all();

    for (const ss of signalSpikes) {
      anomalies.push({
        type: 'signal_spike',
        territory_id: ss.territory_id,
        title: `Signal spike in ${ss.territory_id}`,
        description: `Recent avg ${ss.recent_avg.toFixed(2)} is ${ss.multiplier}x the 7-day baseline ${ss.baseline_avg.toFixed(2)} (${ss.recent_cnt} fragments)`,
        severity: 'warning',
        data: JSON.stringify(ss)
      });
    }

    // 4. PREDICTION HIT: Oracle predictions with triggered disconfirm signals
    const predictionHits = db.prepare(`
      SELECT oq.id, oq.question, oq.confidence, oq.horizon_date,
             oq.disconfirm_signals, oq.created_at
      FROM oracle_questions oq
      WHERE oq.status = 'answered'
        AND oq.disconfirm_signals IS NOT NULL
        AND oq.disconfirm_signals != ''
        AND oq.disconfirm_signals != '[]'
      ORDER BY oq.created_at DESC
      LIMIT 10
    `).all();

    // Check if any disconfirm signal keywords appear in recent fragments
    for (const pred of predictionHits) {
      try {
        const signals = JSON.parse(pred.disconfirm_signals || '[]');
        if (!Array.isArray(signals) || signals.length === 0) continue;

        for (const signal of signals.slice(0, 3)) {
          const signalText = typeof signal === 'string' ? signal : signal.signal || signal.text || '';
          if (!signalText || signalText.length < 5) continue;

          // Extract key content words from signal (4+ char words, filter stop words)
          const stopWords = new Set(['that','this','with','from','have','been','will','would','could','should','they','their','them','than','then','these','those','into','also','more','most','some','such','what','when','where','which','while','about','after','before','being','between','both','does','each','even','just','like','made','make','many','much','only','other','over','same','very','were','because','however','through','during','without','within','against','another','whether','although','since','under','until','upon','toward','among']);
          const keywords = (signalText.toLowerCase().match(/\b[a-z]{4,}\b/g) || [])
            .filter(w => !stopWords.has(w));
          const searchTerms = [...new Set(keywords)].slice(0, 5);
          if (searchTerms.length < 2) continue;

          // Match if ANY 3 of the keywords appear (not ALL)
          const caseExprs = searchTerms.map(t => `(CASE WHEN content LIKE '%${t}%' THEN 1 ELSE 0 END)`).join(' + ');
          const minMatches = Math.min(3, searchTerms.length);
          const matchCount = db.prepare(`
            SELECT COUNT(*) as cnt FROM (
              SELECT id FROM fragments
              WHERE created_at > datetime('now', '-24 hours')
                AND (${caseExprs}) >= ${minMatches}
            )
          `).get();

          if (matchCount && matchCount.cnt >= 2) {
            anomalies.push({
              type: 'prediction_hit',
              territory_id: null,
              title: `Disconfirm signal triggered for prediction #${pred.id}`,
              description: `"${pred.question.slice(0, 100)}" — signal "${signalText.slice(0, 80)}" found in ${matchCount.cnt} recent fragments`,
              severity: 'critical',
              data: JSON.stringify({ prediction_id: pred.id, signal: signalText, match_count: matchCount.cnt })
            });
          }
        }
      } catch (e) {
        // Skip malformed disconfirm_signals
      }
    }

    // Insert new anomalies (dedup: skip if UNRESOLVED anomaly of same type+territory exists)
    const insertAnomaly = db.prepare(`
      INSERT INTO anomalies (type, territory_id, title, description, severity, data)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM anomalies
        WHERE type = ? AND COALESCE(territory_id, '') = COALESCE(?, '')
          AND resolved_at IS NULL
      )
    `);

    let inserted = 0;
    for (const a of anomalies) {
      const result = insertAnomaly.run(
        a.type, a.territory_id, a.title, a.description, a.severity, a.data,
        a.type, a.territory_id
      );
      if (result.changes > 0) inserted++;
    }

    // Cleanup: resolve anomalies older than 48h
    db.prepare(`
      UPDATE anomalies SET resolved_at = datetime('now'), resolved_by = 'auto-expire'
      WHERE resolved_at IS NULL AND detected_at < datetime('now', '-48 hours')
    `).run();

    console.log(`[AnomalyDetector] Detected ${anomalies.length} anomalies, inserted ${inserted} new. Types: ${[...new Set(anomalies.map(a => a.type))].join(', ') || 'none'}`);

  } catch (err) {
    console.error('[AnomalyDetector] Error:', err.message);
  } finally {
    db.close();
  }
}

run();

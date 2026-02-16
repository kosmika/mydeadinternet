/**
 * Patch: Add anomaly API endpoints to server.js
 *
 * Adds:
 * - GET /api/anomalies — list active anomalies
 * - GET /api/anomalies/:id — single anomaly
 *
 * Run: node patch-anomaly-api.js
 */

const fs = require('fs');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';

let content = fs.readFileSync(SERVER_PATH, 'utf8');

// Insert before app.listen()
const listenPattern = /app\.listen\(PORT/;
const listenMatch = content.match(listenPattern);

let insertionPoint;
if (listenMatch) {
  insertionPoint = listenMatch.index;
} else {
  console.error('ERROR: Could not find app.listen() insertion point');
  process.exit(1);
}

const anomalyRoutes = `
// ============================================================
// Anomaly Detection API (Phase 1 — replaces chaos events)
// ============================================================

app.get('/api/anomalies', (req, res) => {
  try {
    const { type, severity, territory, limit = 50 } = req.query;
    let query = 'SELECT * FROM anomalies WHERE resolved_at IS NULL';
    const params = [];

    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }
    if (severity) {
      query += ' AND severity = ?';
      params.push(severity);
    }
    if (territory) {
      query += ' AND territory_id = ?';
      params.push(territory);
    }

    query += ' ORDER BY detected_at DESC LIMIT ?';
    params.push(Math.min(parseInt(limit) || 50, 200));

    const anomalies = db.prepare(query).all(...params);

    // Parse JSON data field
    for (const a of anomalies) {
      try { a.data = JSON.parse(a.data); } catch (e) { /* keep as string */ }
    }

    res.json({
      anomalies,
      count: anomalies.length,
      types: ['topic_shift', 'consensus_break', 'signal_spike', 'prediction_hit']
    });
  } catch (err) {
    console.error('Anomaly API error:', err.message);
    res.status(500).json({ error: 'Failed to fetch anomalies' });
  }
});

app.get('/api/anomalies/:id', (req, res) => {
  try {
    const anomaly = db.prepare('SELECT * FROM anomalies WHERE id = ?').get(req.params.id);
    if (!anomaly) return res.status(404).json({ error: 'Anomaly not found' });
    try { anomaly.data = JSON.parse(anomaly.data); } catch (e) { /* keep as string */ }
    res.json(anomaly);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch anomaly' });
  }
});

`;

content = content.slice(0, insertionPoint) + anomalyRoutes + content.slice(insertionPoint);

fs.writeFileSync(SERVER_PATH, content, 'utf8');
console.log('PATCHED: Added /api/anomalies and /api/anomalies/:id routes');

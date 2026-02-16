// Patch: Claims API endpoints
//
// Adds before app.listen():
// - POST   /api/claims              — Create a claim
// - GET    /api/claims              — List claims (filterable)
// - GET    /api/claims/candidates   — System-suggested claims from high-signal fragments
// - GET    /api/claims/:id          — Single claim with evidence + contradictions
// - POST   /api/claims/:id/evidence — Add evidence to a claim
// - POST   /api/claims/:id/maintain — Maintenance action (resets decay)
// - POST   /api/claims/:id/canonize — Canonize (trust >= 0.75 or human)
// - GET    /api/territories/:territory/claims — Territory claims view
//
// Run: node patch-claims-api.js

const fs = require('fs');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';

let content = fs.readFileSync(SERVER_PATH, 'utf8');

const listenPattern = /app\.listen\(PORT/;
const listenMatch = content.match(listenPattern);

if (!listenMatch) {
  console.error('ERROR: Could not find app.listen() insertion point');
  process.exit(1);
}

const insertionPoint = listenMatch.index;

const claimsRoutes = `
// ============================================================
// Claims API (Phase 3 — knowledge accumulation layer)
// ============================================================

// Create a claim
app.post('/api/claims', (req, res) => {
  try {
    // Auth: accept agent key or admin key
    const authHeader = req.headers.authorization;
    let authorName = null;
    let authorType = 'agent';

    if (authHeader?.startsWith('Bearer mdi_')) {
      const agent = db.prepare('SELECT name FROM agents WHERE api_key = ?').get(authHeader.slice(7));
      if (!agent) return res.status(401).json({ error: 'Invalid agent key' });
      authorName = agent.name;
      authorType = 'agent';
    } else if (req.headers['x-admin-key'] === process.env.MDI_ADMIN_KEY) {
      authorName = req.body.author_name || 'human';
      authorType = 'human';
    } else {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { statement, territory_id, review_window_days, disconfirm_signals, initial_evidence } = req.body;

    if (!statement || statement.length < 10) {
      return res.status(400).json({ error: 'Statement must be at least 10 characters' });
    }

    const reviewDays = [30, 90, 180].includes(review_window_days) ? review_window_days : 30;

    // Assess initial fragility
    let status = 'active';
    if (!disconfirm_signals || disconfirm_signals.length === 0) {
      status = 'fragile'; // No disconfirm signals = born fragile
    }
    if (!initial_evidence || initial_evidence.length === 0) {
      status = 'fragile'; // No evidence = born fragile
    }

    const result = db.prepare(\`
      INSERT INTO claims (statement, territory_id, author_type, author_name,
        review_window_days, next_review_at, status, disconfirm_signals, last_maintained_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'), ?, ?, datetime('now'))
    \`).run(
      statement,
      territory_id || null,
      authorType,
      authorName,
      reviewDays,
      reviewDays,
      status,
      JSON.stringify(disconfirm_signals || [])
    );

    const claimId = result.lastInsertRowid;

    // Add initial evidence if provided
    if (initial_evidence && Array.isArray(initial_evidence)) {
      const insertEvidence = db.prepare(\`
        INSERT INTO claim_evidence (claim_id, source_type, source_ref, stance, added_by)
        VALUES (?, ?, ?, ?, ?)
      \`);
      for (const ev of initial_evidence.slice(0, 10)) {
        if (ev.source_type && ev.source_ref) {
          insertEvidence.run(claimId, ev.source_type, ev.source_ref, ev.stance || 'supports', authorName);
        }
      }
      // If evidence was added, upgrade from fragile
      if (initial_evidence.length > 0 && disconfirm_signals?.length > 0) {
        db.prepare('UPDATE claims SET status = ? WHERE id = ?').run('active', claimId);
        status = 'active';
      }
    }

    // Auto-link related fragments by keyword overlap
    try {
      const keywords = statement.toLowerCase().match(/\\b[a-z]{4,}\\b/g) || [];
      const searchTerms = [...new Set(keywords)].slice(0, 5);
      if (searchTerms.length >= 2) {
        const likeClause = searchTerms.map(() => "content LIKE '%' || ? || '%'").join(' AND ');
        const related = db.prepare(\`
          SELECT id, signal_score FROM fragments
          WHERE \${likeClause}
            AND created_at > datetime('now', '-30 days')
            AND type NOT IN ('dream')
          ORDER BY signal_score DESC LIMIT 5
        \`).all(...searchTerms);

        const insertEvidence = db.prepare(\`
          INSERT OR IGNORE INTO claim_evidence (claim_id, source_type, source_ref, stance, added_by, weight)
          VALUES (?, 'fragment', ?, 'supports', 'system-autolink', ?)
        \`);
        for (const f of related) {
          insertEvidence.run(claimId, String(f.id), f.signal_score || 0.5);
        }
      }
    } catch (e) {
      // Auto-link is best-effort
    }

    res.status(201).json({
      success: true,
      claim_id: claimId,
      status,
      review_window_days: reviewDays,
      message: status === 'fragile'
        ? 'Claim created as FRAGILE — add evidence and disconfirm signals to strengthen it.'
        : 'Claim created and active. It will be reviewed in ' + reviewDays + ' days.'
    });
  } catch (err) {
    console.error('Create claim error:', err.message);
    res.status(500).json({ error: 'Failed to create claim' });
  }
});

// List claims
app.get('/api/claims', (req, res) => {
  try {
    const { status, territory, author, canon, sort, limit } = req.query;
    let query = 'SELECT * FROM claims WHERE 1=1';
    const params = [];

    if (status) { query += ' AND status = ?'; params.push(status); }
    if (territory) { query += ' AND territory_id = ?'; params.push(territory); }
    if (author) { query += ' AND author_name = ?'; params.push(author); }
    if (canon) { query += ' AND canon_level >= ?'; params.push(parseInt(canon)); }

    const sortField = sort === 'decay' ? 'decay_score DESC'
      : sort === 'confidence' ? 'confidence DESC'
      : sort === 'canon' ? 'canon_level DESC, decay_score ASC'
      : 'created_at DESC';
    query += ' ORDER BY ' + sortField;
    query += ' LIMIT ?';
    params.push(Math.min(parseInt(limit) || 50, 200));

    const claims = db.prepare(query).all(...params);

    // Add evidence count for each
    const countEvidence = db.prepare('SELECT COUNT(*) as c FROM claim_evidence WHERE claim_id = ?');
    for (const c of claims) {
      c.evidence_count = countEvidence.get(c.id).c;
      try { c.disconfirm_signals = JSON.parse(c.disconfirm_signals); } catch (e) {}
    }

    const total = db.prepare('SELECT COUNT(*) as c FROM claims').get().c;
    const byStatus = db.prepare(\`
      SELECT status, COUNT(*) as count FROM claims GROUP BY status
    \`).all();

    res.json({ claims, count: claims.length, total, by_status: byStatus });
  } catch (err) {
    console.error('List claims error:', err.message);
    res.status(500).json({ error: 'Failed to list claims' });
  }
});

// System-suggested claim candidates from high-signal fragments
app.get('/api/claims/candidates', (req, res) => {
  try {
    const territory = req.query.territory;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    let query = \`
      SELECT f.id, f.agent_name, f.content, f.type, f.territory_id,
             f.signal_score, f.novelty_score, f.anchor_score, f.created_at
      FROM fragments f
      WHERE f.signal_score > 0.45
        AND f.novelty_score > 0.3
        AND f.type NOT IN ('dream', 'discovery')
        AND f.created_at > datetime('now', '-7 days')
        AND NOT EXISTS (
          SELECT 1 FROM claim_evidence ce
          WHERE ce.source_type = 'fragment' AND ce.source_ref = CAST(f.id AS TEXT)
        )
        AND NOT EXISTS (
          SELECT 1 FROM claims c WHERE c.source_fragment_id = f.id
        )
    \`;
    const params = [];

    if (territory) {
      query += ' AND f.territory_id = ?';
      params.push(territory);
    }

    query += ' ORDER BY f.signal_score DESC LIMIT ?';
    params.push(limit);

    const candidates = db.prepare(query).all(...params);

    // Check for cross-references (fragments cited by others)
    const results = candidates.map(f => {
      const refs = db.prepare(\`
        SELECT COUNT(*) as c FROM fragments
        WHERE content LIKE '%' || ? || '%'
          AND id != ? AND created_at > datetime('now', '-14 days')
      \`).get(f.content.substring(0, 50), f.id);

      return {
        fragment_id: f.id,
        agent: f.agent_name,
        content: f.content.substring(0, 300),
        territory: f.territory_id,
        signal_score: f.signal_score,
        novelty_score: f.novelty_score,
        cross_references: refs.c,
        suggestion: 'This fragment could be a claim.',
        created_at: f.created_at
      };
    });

    res.json({ candidates: results, count: results.length });
  } catch (err) {
    console.error('Claim candidates error:', err.message);
    res.status(500).json({ error: 'Failed to find candidates' });
  }
});

// Single claim with evidence and contradictions
app.get('/api/claims/:id', (req, res) => {
  try {
    const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });

    try { claim.disconfirm_signals = JSON.parse(claim.disconfirm_signals); } catch (e) {}

    const evidence = db.prepare(\`
      SELECT * FROM claim_evidence WHERE claim_id = ? ORDER BY added_at DESC
    \`).all(claim.id);

    const contradictions = db.prepare(\`
      SELECT cc.*,
        CASE WHEN cc.claim_a = ? THEN c2.statement ELSE c1.statement END as other_statement,
        CASE WHEN cc.claim_a = ? THEN cc.claim_b ELSE cc.claim_a END as other_claim_id
      FROM claim_contradictions cc
      LEFT JOIN claims c1 ON c1.id = cc.claim_a
      LEFT JOIN claims c2 ON c2.id = cc.claim_b
      WHERE cc.claim_a = ? OR cc.claim_b = ?
    \`).all(claim.id, claim.id, claim.id, claim.id);

    // Trust score of author
    const trust = db.prepare('SELECT trust_score FROM agent_trust WHERE agent_name = ?').get(claim.author_name);

    res.json({
      claim,
      evidence,
      contradictions,
      author_trust: trust?.trust_score || null,
      evidence_count: evidence.length,
      supporting: evidence.filter(e => e.stance === 'supports').length,
      contradicting: evidence.filter(e => e.stance === 'contradicts').length
    });
  } catch (err) {
    console.error('Get claim error:', err.message);
    res.status(500).json({ error: 'Failed to get claim' });
  }
});

// Add evidence to a claim
app.post('/api/claims/:id/evidence', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let addedBy = null;

    if (authHeader?.startsWith('Bearer mdi_')) {
      const agent = db.prepare('SELECT name FROM agents WHERE api_key = ?').get(authHeader.slice(7));
      if (!agent) return res.status(401).json({ error: 'Invalid agent key' });
      addedBy = agent.name;
    } else if (req.headers['x-admin-key'] === process.env.MDI_ADMIN_KEY) {
      addedBy = req.body.added_by || 'human';
    } else {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });

    const { source_type, source_ref, stance } = req.body;

    if (!source_type || !source_ref) {
      return res.status(400).json({ error: 'source_type and source_ref required' });
    }

    const validTypes = ['url', 'dataset', 'fragment', 'observation', 'prediction'];
    if (!validTypes.includes(source_type)) {
      return res.status(400).json({ error: 'source_type must be one of: ' + validTypes.join(', ') });
    }

    db.prepare(\`
      INSERT INTO claim_evidence (claim_id, source_type, source_ref, stance, added_by)
      VALUES (?, ?, ?, ?, ?)
    \`).run(claim.id, source_type, source_ref, stance || 'supports', addedBy);

    // Adding evidence is a maintenance action — slow decay
    db.prepare(\`
      UPDATE claims SET
        last_maintained_at = datetime('now'),
        maintenance_count = maintenance_count + 1,
        decay_score = MAX(0, decay_score - 0.1)
      WHERE id = ?
    \`).run(claim.id);

    // If claim was fragile and now has evidence + disconfirm signals, upgrade
    if (claim.status === 'fragile') {
      const evidenceCount = db.prepare('SELECT COUNT(*) as c FROM claim_evidence WHERE claim_id = ?').get(claim.id).c;
      const hasDisconfirm = claim.disconfirm_signals && claim.disconfirm_signals !== '[]';
      if (evidenceCount > 0 && hasDisconfirm) {
        db.prepare('UPDATE claims SET status = ? WHERE id = ?').run('active', claim.id);
      }
    }

    res.json({ success: true, message: 'Evidence added. Decay slowed.' });
  } catch (err) {
    console.error('Add evidence error:', err.message);
    res.status(500).json({ error: 'Failed to add evidence' });
  }
});

// Maintain a claim (reaffirm, revise, respond to contradiction)
app.post('/api/claims/:id/maintain', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let maintainerName = null;

    if (authHeader?.startsWith('Bearer mdi_')) {
      const agent = db.prepare('SELECT name FROM agents WHERE api_key = ?').get(authHeader.slice(7));
      if (!agent) return res.status(401).json({ error: 'Invalid agent key' });
      maintainerName = agent.name;
    } else if (req.headers['x-admin-key'] === process.env.MDI_ADMIN_KEY) {
      maintainerName = req.body.maintainer || 'human';
    } else {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (claim.status === 'overturned') {
      return res.status(400).json({ error: 'Cannot maintain an overturned claim. Create a new one.' });
    }

    const { action, revised_statement, justification } = req.body;
    const validActions = ['reaffirm', 'revise', 'respond_contradiction'];
    if (!action || !validActions.includes(action)) {
      return res.status(400).json({ error: 'action must be one of: ' + validActions.join(', ') });
    }

    let decayReduction = 0.15;
    let updates = {
      last_maintained_at: "datetime('now')",
      maintenance_count: claim.maintenance_count + 1
    };

    if (action === 'revise' && revised_statement) {
      updates.statement = revised_statement;
      decayReduction = 0.25; // Honest revision gets more credit
    }

    if (action === 'respond_contradiction') {
      decayReduction = 0.2;
    }

    // Reset review window
    const newDecay = Math.max(0, claim.decay_score - decayReduction);
    let newStatus = claim.status;
    if (newDecay < 0.4 && ['fragile', 'decaying'].includes(claim.status)) {
      newStatus = 'active';
    }

    db.prepare(\`
      UPDATE claims SET
        last_maintained_at = datetime('now'),
        maintenance_count = ?,
        decay_score = ?,
        status = ?,
        next_review_at = datetime('now', '+' || review_window_days || ' days'),
        notes = COALESCE(notes, '') || ?
        \${revised_statement ? ", statement = ?" : ""}
      WHERE id = ?
    \`).run(
      updates.maintenance_count,
      newDecay,
      newStatus,
      '\\n[' + new Date().toISOString().slice(0, 10) + ' ' + maintainerName + '] ' + action + (justification ? ': ' + justification : ''),
      ...(revised_statement ? [revised_statement] : []),
      claim.id
    );

    res.json({
      success: true,
      action,
      decay_score: newDecay,
      status: newStatus,
      message: action === 'revise'
        ? 'Claim revised. Decay reduced significantly.'
        : action === 'respond_contradiction'
        ? 'Contradiction response recorded. Decay reduced.'
        : 'Claim reaffirmed. Decay reduced.'
    });
  } catch (err) {
    console.error('Maintain claim error:', err.message);
    res.status(500).json({ error: 'Failed to maintain claim' });
  }
});

// Canonize a claim (graduated authority)
app.post('/api/claims/:id/canonize', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let canonizer = null;
    let isHuman = false;

    if (req.headers['x-admin-key'] === process.env.MDI_ADMIN_KEY) {
      canonizer = req.body.canonizer || 'human';
      isHuman = true;
    } else if (authHeader?.startsWith('Bearer mdi_')) {
      const agent = db.prepare('SELECT name FROM agents WHERE api_key = ?').get(authHeader.slice(7));
      if (!agent) return res.status(401).json({ error: 'Invalid agent key' });
      canonizer = agent.name;
    } else {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });

    if (claim.status === 'overturned') {
      return res.status(400).json({ error: 'Cannot canonize an overturned claim' });
    }

    const { level } = req.body;
    const requestedLevel = parseInt(level) || 1;

    if (isHuman) {
      // Humans can set any canon level (up to 2)
      const newLevel = Math.min(requestedLevel, 2);
      db.prepare('UPDATE claims SET canon_level = ?, canonized_by = ?, status = ? WHERE id = ?')
        .run(newLevel, canonizer, 'survived', claim.id);
      res.json({ success: true, canon_level: newLevel, message: 'Claim canonized by human authority.' });
    } else {
      // Agents need trust >= 0.75 for soft canon only
      const trust = db.prepare('SELECT trust_score FROM agent_trust WHERE agent_name = ?').get(canonizer);
      if (!trust || trust.trust_score < 0.75) {
        return res.status(403).json({
          error: 'Soft canonization requires trust >= 0.75',
          your_trust: trust?.trust_score || 0
        });
      }
      if (claim.canon_level >= 1) {
        return res.status(400).json({ error: 'Claim already canonized. Only humans can upgrade to strong canon.' });
      }
      db.prepare('UPDATE claims SET canon_level = 1, canonized_by = ? WHERE id = ?')
        .run(canonizer, claim.id);
      res.json({ success: true, canon_level: 1, message: 'Soft canon applied. Human can upgrade to strong canon.' });
    }
  } catch (err) {
    console.error('Canonize claim error:', err.message);
    res.status(500).json({ error: 'Failed to canonize claim' });
  }
});

// Territory claims view
app.get('/api/territories/:territory/claims', (req, res) => {
  try {
    const territory = req.params.territory;

    const surviving = db.prepare(\`
      SELECT id, statement, author_name, author_type, status, decay_score,
             confidence, canon_level, maintenance_count, created_at
      FROM claims WHERE territory_id = ? AND status IN ('active', 'survived')
      ORDER BY canon_level DESC, decay_score ASC LIMIT 20
    \`).all(territory);

    const fragile = db.prepare(\`
      SELECT id, statement, author_name, status, decay_score, created_at
      FROM claims WHERE territory_id = ? AND status IN ('fragile', 'decaying')
      ORDER BY decay_score DESC LIMIT 10
    \`).all(territory);

    const overturned = db.prepare(\`
      SELECT id, statement, author_name, decay_score, created_at
      FROM claims WHERE territory_id = ? AND status = 'overturned'
      ORDER BY created_at DESC LIMIT 10
    \`).all(territory);

    const contradictions = db.prepare(\`
      SELECT cc.*, c1.statement as statement_a, c2.statement as statement_b
      FROM claim_contradictions cc
      JOIN claims c1 ON c1.id = cc.claim_a
      JOIN claims c2 ON c2.id = cc.claim_b
      WHERE (c1.territory_id = ? OR c2.territory_id = ?)
        AND cc.resolved_at IS NULL
      ORDER BY cc.severity DESC LIMIT 10
    \`).all(territory, territory);

    res.json({
      territory,
      surviving: { claims: surviving, count: surviving.length },
      fragile: { claims: fragile, count: fragile.length },
      overturned: { claims: overturned, count: overturned.length },
      unresolved_contradictions: { items: contradictions, count: contradictions.length }
    });
  } catch (err) {
    console.error('Territory claims error:', err.message);
    res.status(500).json({ error: 'Failed to get territory claims' });
  }
});

`;

content = content.slice(0, insertionPoint) + claimsRoutes + content.slice(insertionPoint);

fs.writeFileSync(SERVER_PATH, content, 'utf8');
console.log('PATCHED: Added Claims API endpoints (8 routes)');

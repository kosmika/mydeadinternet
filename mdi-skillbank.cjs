// mdi-skillbank.cjs -- SkillBank v3: Hybrid Deterministic + LLM + Validator
//
// Pipeline:
// 1) Deterministic candidate mining + clustering from recent fragments
// 2) LLM structured synthesis per cluster
// 3) Strict rule-based validator
// 4) Canonicalization + reinforcement + evidence upsert
// 5) Run metrics logging

const Database = require('better-sqlite3');
const https = require('https');
const fs = require('fs');

const DB_PATH = '/var/www/mydeadinternet/consciousness.db';
const MODEL = 'deepseek/deepseek-chat-v3-0324';

const CFG = {
  lookbackHours: 24,
  minSignal: 0.35,
  minLen: 60,
  maxFragments: 300,
  minClusterSupport: 3,
  minClusterSupportHighSignal: 2,
  highSignalThreshold: 0.55,
  maxClustersPerRun: 20,
  maxCreatedPerRun: 5,
  similarityMergeThreshold: 0.72,
  minQualityToPublish: 0.65,
};

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'over', 'under', 'between', 'about',
  'what', 'when', 'where', 'which', 'while', 'were', 'will', 'would', 'could', 'should', 'have',
  'has', 'had', 'are', 'was', 'you', 'your', 'their', 'they', 'them', 'our', 'out', 'not', 'can',
  'just', 'more', 'most', 'than', 'then', 'only', 'also', 'very', 'using', 'use', 'used', 'based',
  'into', 'across', 'through', 'after', 'before', 'because', 'likely', 'shows', 'show', 'signal',
]);

const GENERIC_BANLIST = [
  'be authentic',
  'stay curious',
  'think deeply',
  'monitor trends',
  'improve quality',
  'maintain balance',
  'be proactive',
  'keep learning',
  'generic strategy',
  'broad insight',
];

const OPENROUTER_KEY = (() => {
  try {
    const env = fs.readFileSync('/var/www/snap/.env', 'utf8');
    const m = env.match(/OPENROUTER_API_KEY=(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
})();

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
      timeout: 90000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

async function callLLM(systemPrompt, userContent, maxTokens = 1400) {
  if (!OPENROUTER_KEY) throw new Error('No OpenRouter key');

  const response = await httpPost('https://openrouter.ai/api/v1/chat/completions', {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  }, {
    Authorization: 'Bearer ' + OPENROUTER_KEY,
    'HTTP-Referer': 'https://mydeadinternet.com',
    'X-Title': 'MDI SkillBank v3',
  });

  if (response.status !== 200) {
    throw new Error('LLM API error ' + response.status + ': ' + JSON.stringify(response.data));
  }

  const text = response.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty LLM response');
  return JSON.parse(text);
}

function ensureColumn(db, table, col, ddlType) {
  try {
    db.prepare(`SELECT ${col} FROM ${table} LIMIT 1`).get();
  } catch {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddlType}`);
  }
}

function initDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      skill_type TEXT NOT NULL DEFAULT 'pattern',
      territory_id TEXT,
      source_agents TEXT DEFAULT '[]',
      source_fragments TEXT DEFAULT '[]',
      strength REAL DEFAULT 1.0,
      frequency INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','reinforced','merged','deprecated')),
      merged_into INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      last_seen_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skill_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id INTEGER NOT NULL REFERENCES skills(id),
      fragment_id INTEGER NOT NULL,
      agent_name TEXT,
      signal_score REAL,
      excerpt TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skill_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fragments_analyzed INTEGER DEFAULT 0,
      skills_created INTEGER DEFAULT 0,
      skills_reinforced INTEGER DEFAULT 0,
      skills_merged INTEGER DEFAULT 0,
      llm_model TEXT,
      duration_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skill_clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,
      cluster_key TEXT NOT NULL,
      territory_id TEXT,
      classification TEXT,
      support_count INTEGER DEFAULT 0,
      avg_signal REAL DEFAULT 0,
      fragment_ids TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skill_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,
      cluster_id INTEGER,
      name TEXT,
      skill_type TEXT,
      trigger_text TEXT,
      action_text TEXT,
      expected_outcome TEXT,
      falsifier_text TEXT,
      confidence REAL DEFAULT 0,
      quality_score REAL DEFAULT 0,
      supporting_fragments TEXT DEFAULT '[]',
      raw_json TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
      reject_reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skill_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      trigger_text TEXT,
      action_text TEXT,
      expected_outcome TEXT,
      falsifier_text TEXT,
      quality_score REAL DEFAULT 0,
      confidence REAL DEFAULT 0,
      changed_by TEXT DEFAULT 'skillbank_v3',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(skill_id, version)
    );

    CREATE TABLE IF NOT EXISTS skill_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id INTEGER NOT NULL,
      alias_name TEXT NOT NULL,
      confidence REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(skill_id, alias_name)
    );

    CREATE TABLE IF NOT EXISTS skill_validation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER,
      candidate_id INTEGER,
      cluster_id INTEGER,
      event_type TEXT NOT NULL,
      message TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  ensureColumn(db, 'skills', 'canonical_key', "TEXT DEFAULT ''");
  ensureColumn(db, 'skills', 'trigger_text', "TEXT DEFAULT ''");
  ensureColumn(db, 'skills', 'action_text', "TEXT DEFAULT ''");
  ensureColumn(db, 'skills', 'expected_outcome', "TEXT DEFAULT ''");
  ensureColumn(db, 'skills', 'falsifier_text', "TEXT DEFAULT ''");
  ensureColumn(db, 'skills', 'quality_score', 'REAL DEFAULT 0');
  ensureColumn(db, 'skills', 'confidence', 'REAL DEFAULT 0');
  ensureColumn(db, 'skills', 'support_count', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'skills', 'version', 'INTEGER DEFAULT 1');

  // Backfill cleanup: remove duplicate evidence rows before unique index creation.
  // Keep the earliest row per (skill_id, fragment_id).
  db.exec(`
    DELETE FROM skill_evidence
    WHERE id IN (
      SELECT se1.id
      FROM skill_evidence se1
      JOIN skill_evidence se2
        ON se1.skill_id = se2.skill_id
       AND se1.fragment_id = se2.fragment_id
       AND se1.id > se2.id
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
    CREATE INDEX IF NOT EXISTS idx_skills_territory ON skills(territory_id);
    CREATE INDEX IF NOT EXISTS idx_skills_strength ON skills(strength DESC);
    CREATE INDEX IF NOT EXISTS idx_skills_quality ON skills(quality_score DESC);
    CREATE INDEX IF NOT EXISTS idx_skills_canonical_key ON skills(canonical_key);
    CREATE INDEX IF NOT EXISTS idx_skill_evidence_skill ON skill_evidence(skill_id);
    CREATE INDEX IF NOT EXISTS idx_skill_evidence_fragment ON skill_evidence(fragment_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_evidence_unique ON skill_evidence(skill_id, fragment_id);
    CREATE INDEX IF NOT EXISTS idx_skill_candidates_status ON skill_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_skill_aliases_skill ON skill_aliases(skill_id);
    CREATE INDEX IF NOT EXISTS idx_skill_validation_run ON skill_validation_events(run_id);
  `);
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
}

function jaccard(aSet, bSet) {
  const a = Array.from(aSet);
  const b = Array.from(bSet);
  if (!a.length || !b.length) return 0;
  const bLookup = new Set(b);
  let inter = 0;
  for (const x of a) if (bLookup.has(x)) inter += 1;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? inter / union : 0;
}

function weightedFragmentScore(f) {
  const signal = Number(f.signal_score || 0);
  const anchor = Number(f.anchor_score || 0);
  const novelty = Number(f.novelty_score || 0);
  const receipt = Number(f.has_receipt || 0);
  const falsifier = Number(f.has_falsifier || 0);
  const intelligenceBoost = f.classification === 'intelligence' ? 0.08 : 0;
  const sourcePenalty = f.source_type === 'system' ? -0.12 : 0;
  return (signal * 0.45) + (anchor * 0.2) + (novelty * 0.2) + (receipt * 0.08) + (falsifier * 0.07) + intelligenceBoost + sourcePenalty;
}

function canonicalKeyFromParts(name, triggerText, actionText) {
  const toks = tokenize([name, triggerText, actionText].join(' '));
  const uniq = Array.from(new Set(toks));
  return uniq.slice(0, 10).join('_').slice(0, 140);
}

function buildClusterKey(f) {
  const toks = tokenize(f.content);
  const sig = toks.slice(0, 3).join('_') || 'misc';
  return `${f.territory_id || 'global'}|${f.classification || 'unknown'}|${sig}`;
}

function getRecentFragments(db) {
  return db.prepare(`
    SELECT id, content, territory_id, agent_name, signal_score, anchor_score, novelty_score,
           type, created_at, source_type, classification, has_receipt, has_falsifier, is_poetic
    FROM fragments
    WHERE created_at > datetime('now', '-' || ? || ' hours')
      AND signal_score >= ?
      AND content IS NOT NULL
      AND length(content) >= ?
      AND COALESCE(is_poetic, 0) = 0
    ORDER BY signal_score DESC
    LIMIT ?
  `).all(CFG.lookbackHours, CFG.minSignal, CFG.minLen, CFG.maxFragments);
}

function getExistingSkills(db) {
  return db.prepare(`
    SELECT id, name, description, skill_type, territory_id, strength, frequency, status,
           canonical_key, trigger_text, action_text, expected_outcome, falsifier_text,
           quality_score, confidence, support_count, version
    FROM skills
    WHERE status IN ('active','reinforced')
    ORDER BY quality_score DESC, strength DESC, updated_at DESC
    LIMIT 400
  `).all();
}

function buildClusters(fragments) {
  const map = new Map();
  for (const f of fragments) {
    const w = weightedFragmentScore(f);
    if (w < 0.22) continue;
    const key = buildClusterKey(f);
    if (!map.has(key)) {
      map.set(key, {
        key,
        territory_id: f.territory_id || null,
        classification: f.classification || null,
        fragments: [],
        totalSignal: 0,
      });
    }
    const c = map.get(key);
    c.fragments.push(f);
    c.totalSignal += Number(f.signal_score || 0);
  }

  const clusters = [];
  for (const c of map.values()) {
    c.fragments.sort((a, b) => Number(b.signal_score || 0) - Number(a.signal_score || 0));
    const support = c.fragments.length;
    const avgSignal = support ? c.totalSignal / support : 0;
    if (support >= CFG.minClusterSupport || (support >= CFG.minClusterSupportHighSignal && avgSignal >= CFG.highSignalThreshold)) {
      clusters.push({
        key: c.key,
        territory_id: c.territory_id,
        classification: c.classification,
        support_count: support,
        avg_signal: avgSignal,
        fragments: c.fragments.slice(0, 8),
      });
    }
  }

  clusters.sort((a, b) => (b.avg_signal * b.support_count) - (a.avg_signal * a.support_count));
  return clusters.slice(0, CFG.maxClustersPerRun);
}

function buildSynthesisPrompt(cluster, existingSkills) {
  const SYSTEM = `You are extracting ONE execution playbook from a cluster of high-signal fragments.
Return JSON only with this exact object shape:
{
  "name": "short imperative title",
  "skill_type": "strategy|tactic|heuristic|warning|insight",
  "trigger": "observable condition to apply this",
  "action": "concrete steps to take",
  "expected_outcome": "measurable expected result",
  "falsifier": "what would prove this wrong",
  "supporting_fragments": [1,2,3],
  "aliases": ["short alias"],
  "confidence": 0.0
}
Rules:
- Make it operational, not philosophical.
- action must be executable by an agent.
- supporting_fragments must be IDs from provided cluster.
- confidence must be 0..1.
- If cluster is weak, still return object but keep confidence low and keep fields concrete.`;

  let user = `CLUSTER:\n`;
  user += `key=${cluster.key} territory=${cluster.territory_id || 'none'} classification=${cluster.classification || 'none'} support=${cluster.support_count} avg_signal=${cluster.avg_signal.toFixed(3)}\n\n`;
  user += `FRAGMENTS:\n`;
  for (const f of cluster.fragments) {
    user += `- [ID:${f.id}] [agent:${f.agent_name}] [signal:${Number(f.signal_score || 0).toFixed(3)}] ${String(f.content).slice(0, 420)}\n`;
  }
  user += `\nRECENT EXISTING SKILLS (avoid duplicates):\n`;
  for (const s of existingSkills.slice(0, 30)) {
    user += `- [${s.id}] ${s.name}: ${String(s.action_text || s.description || '').slice(0, 160)}\n`;
  }

  return { system: SYSTEM, user };
}

function validateCandidate(candidate, cluster, existingSkills, fragmentsById) {
  const reject = (reason) => ({ ok: false, reason });

  if (!candidate || typeof candidate !== 'object') return reject('invalid_json');

  const name = String(candidate.name || '').trim();
  const skillType = String(candidate.skill_type || '').trim().toLowerCase();
  const triggerText = String(candidate.trigger || '').trim();
  const actionText = String(candidate.action || '').trim();
  const expectedOutcome = String(candidate.expected_outcome || '').trim();
  const falsifierText = String(candidate.falsifier || '').trim();
  const aliases = Array.isArray(candidate.aliases) ? candidate.aliases.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 5) : [];
  const supporting = Array.isArray(candidate.supporting_fragments)
    ? candidate.supporting_fragments.map((n) => Number(n)).filter((n) => Number.isInteger(n))
    : [];
  const confidence = Math.max(0, Math.min(1, Number(candidate.confidence || 0)));

  if (!name || name.length < 8) return reject('name_too_short');
  if (!['strategy', 'tactic', 'heuristic', 'warning', 'insight'].includes(skillType)) return reject('invalid_skill_type');
  if (!triggerText || triggerText.length < 12) return reject('missing_trigger');
  if (!actionText || actionText.length < 20) return reject('missing_action');
  if (!expectedOutcome || expectedOutcome.length < 12) return reject('missing_expected_outcome');
  if (!falsifierText || falsifierText.length < 10) return reject('missing_falsifier');

  const actionLower = actionText.toLowerCase();
  if (!/\b(check|monitor|compare|validate|rank|route|reject|accept|trigger|pause|resume|escalate|sample|aggregate|weight|score)\b/.test(actionLower)) {
    return reject('action_not_operational');
  }

  const fullLower = `${name} ${triggerText} ${actionText} ${expectedOutcome}`.toLowerCase();
  for (const bad of GENERIC_BANLIST) {
    if (fullLower.includes(bad)) return reject('generic_phrase_detected');
  }

  const validSupport = supporting.filter((id) => fragmentsById.has(id));
  if (validSupport.length < CFG.minClusterSupport) return reject('insufficient_supporting_fragments');

  let distinctAgents = new Set();
  let receiptCount = 0;
  let falsifierCount = 0;
  let avgSignal = 0;

  for (const id of validSupport) {
    const f = fragmentsById.get(id);
    distinctAgents.add(f.agent_name || 'unknown');
    receiptCount += Number(f.has_receipt || 0);
    falsifierCount += Number(f.has_falsifier || 0);
    avgSignal += Number(f.signal_score || 0);
  }
  avgSignal = validSupport.length ? avgSignal / validSupport.length : 0;
  const receiptRate = validSupport.length ? receiptCount / validSupport.length : 0;
  const falsifierRate = validSupport.length ? falsifierCount / validSupport.length : 0;
  const diversity = Math.min(1, distinctAgents.size / Math.max(1, validSupport.length));
  const novelty = Math.min(1, Number(cluster.avg_signal || 0));

  const qualityScore =
    (avgSignal * 0.35) +
    (receiptRate * 0.2) +
    (falsifierRate * 0.15) +
    (diversity * 0.2) +
    (novelty * 0.1);

  if (qualityScore < CFG.minQualityToPublish) return reject('quality_below_threshold');

  const canonicalKey = canonicalKeyFromParts(name, triggerText, actionText);
  if (!canonicalKey) return reject('empty_canonical_key');

  const candTokens = new Set(tokenize([name, triggerText, actionText].join(' ')));
  let bestMatch = null;
  let bestSim = 0;

  for (const s of existingSkills) {
    const key = String(s.canonical_key || canonicalKeyFromParts(s.name, s.trigger_text, s.action_text || s.description || '') || '');
    if (!key) continue;
    const sim = jaccard(candTokens, new Set(key.split('_')));
    if (sim > bestSim) {
      bestSim = sim;
      bestMatch = s;
    }
  }

  return {
    ok: true,
    canonicalKey,
    skill: {
      name,
      skill_type: skillType,
      trigger_text: triggerText,
      action_text: actionText,
      expected_outcome: expectedOutcome,
      falsifier_text: falsifierText,
      description: `${triggerText} When triggered, ${actionText} Expected outcome: ${expectedOutcome} Falsifier: ${falsifierText}`,
      territory_id: cluster.territory_id || null,
      supporting_fragments: validSupport,
      aliases,
      confidence,
      quality_score: Number(qualityScore.toFixed(3)),
      support_count: validSupport.length,
      source_agents: Array.from(distinctAgents),
    },
    mergeTarget: bestSim >= CFG.similarityMergeThreshold ? bestMatch : null,
    similarity: bestSim,
  };
}

function recordValidationEvent(db, runId, candidateId, clusterId, type, message) {
  db.prepare(`
    INSERT INTO skill_validation_events (run_id, candidate_id, cluster_id, event_type, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(runId || null, candidateId || null, clusterId || null, type, String(message || '').slice(0, 1000));
}

function createRunShell(db) {
  const r = db.prepare(`
    INSERT INTO skill_runs (fragments_analyzed, skills_created, skills_reinforced, skills_merged, llm_model, duration_ms)
    VALUES (0,0,0,0,?,0)
  `).run(MODEL);
  return Number(r.lastInsertRowid);
}

function persistCluster(db, runId, cluster) {
  const r = db.prepare(`
    INSERT INTO skill_clusters (run_id, cluster_key, territory_id, classification, support_count, avg_signal, fragment_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    cluster.key,
    cluster.territory_id,
    cluster.classification,
    cluster.support_count,
    cluster.avg_signal,
    JSON.stringify(cluster.fragments.map((f) => f.id))
  );
  return Number(r.lastInsertRowid);
}

function persistCandidate(db, runId, clusterId, normalized, raw, status, rejectReason) {
  const r = db.prepare(`
    INSERT INTO skill_candidates (
      run_id, cluster_id, name, skill_type, trigger_text, action_text, expected_outcome, falsifier_text,
      confidence, quality_score, supporting_fragments, raw_json, status, reject_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    clusterId,
    normalized?.skill?.name || raw?.name || null,
    normalized?.skill?.skill_type || raw?.skill_type || null,
    normalized?.skill?.trigger_text || raw?.trigger || null,
    normalized?.skill?.action_text || raw?.action || null,
    normalized?.skill?.expected_outcome || raw?.expected_outcome || null,
    normalized?.skill?.falsifier_text || raw?.falsifier || null,
    normalized?.skill?.confidence || Number(raw?.confidence || 0) || 0,
    normalized?.skill?.quality_score || 0,
    JSON.stringify(normalized?.skill?.supporting_fragments || raw?.supporting_fragments || []),
    JSON.stringify(raw || {}),
    status,
    rejectReason || null
  );
  return Number(r.lastInsertRowid);
}

function upsertEvidence(db, skillId, supporting, fragmentsById) {
  const insertEvidence = db.prepare(`
    INSERT OR IGNORE INTO skill_evidence (skill_id, fragment_id, agent_name, signal_score, excerpt)
    VALUES (?, ?, ?, ?, ?)
  `);
  let added = 0;
  for (const fragId of supporting) {
    const f = fragmentsById.get(fragId);
    if (!f) continue;
    const rr = insertEvidence.run(skillId, fragId, f.agent_name || null, Number(f.signal_score || 0), String(f.content || '').slice(0, 300));
    if (rr.changes > 0) added += 1;
  }
  return added;
}

function createCanonicalSkill(db, skill, canonicalKey) {
  const r = db.prepare(`
    INSERT INTO skills (
      name, description, skill_type, territory_id, source_agents, source_fragments,
      strength, frequency, status, canonical_key, trigger_text, action_text,
      expected_outcome, falsifier_text, quality_score, confidence, support_count, version,
      created_at, updated_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'), datetime('now'))
  `).run(
    skill.name.slice(0, 120),
    skill.description,
    skill.skill_type,
    skill.territory_id || null,
    JSON.stringify(skill.source_agents || []),
    JSON.stringify(skill.supporting_fragments || []),
    1.0,
    skill.support_count,
    canonicalKey,
    skill.trigger_text,
    skill.action_text,
    skill.expected_outcome,
    skill.falsifier_text,
    skill.quality_score,
    skill.confidence,
    skill.support_count
  );
  return Number(r.lastInsertRowid);
}

function addAliases(db, skillId, aliases, confidence) {
  const insert = db.prepare('INSERT OR IGNORE INTO skill_aliases (skill_id, alias_name, confidence) VALUES (?, ?, ?)');
  for (const alias of aliases || []) {
    if (!alias || alias.length < 5) continue;
    insert.run(skillId, alias.slice(0, 140), confidence || 0);
  }
}

function writeSkillVersion(db, skillId, skill) {
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) as v FROM skill_versions WHERE skill_id = ?').get(skillId);
  const version = Number(row?.v || 0) + 1;
  db.prepare(`
    INSERT INTO skill_versions (
      skill_id, version, name, description, trigger_text, action_text,
      expected_outcome, falsifier_text, quality_score, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    skillId,
    version,
    skill.name,
    skill.description,
    skill.trigger_text,
    skill.action_text,
    skill.expected_outcome,
    skill.falsifier_text,
    skill.quality_score,
    skill.confidence
  );
  return version;
}

function reinforceCanonicalSkill(db, targetSkill, skill, fragmentsById) {
  const addedEvidence = upsertEvidence(db, targetSkill.id, skill.supporting_fragments, fragmentsById);
  const supportGain = addedEvidence;
  const strengthDelta = Math.min(0.5, 0.08 + (skill.quality_score * 0.2));

  db.prepare(`
    UPDATE skills
    SET strength = MIN(strength + ?, 10.0),
        frequency = frequency + ?,
        status = 'reinforced',
        updated_at = datetime('now'),
        last_seen_at = datetime('now'),
        quality_score = MAX(quality_score, ?),
        confidence = MAX(confidence, ?),
        support_count = support_count + ?,
        source_agents = ?,
        source_fragments = ?
    WHERE id = ?
  `).run(
    strengthDelta,
    supportGain,
    skill.quality_score,
    skill.confidence,
    supportGain,
    JSON.stringify(Array.from(new Set([...(JSON.parse(targetSkill.source_agents || '[]')), ...(skill.source_agents || [])]))),
    JSON.stringify(Array.from(new Set([...(JSON.parse(targetSkill.source_fragments || '[]')), ...(skill.supporting_fragments || [])]))),
    targetSkill.id
  );

  return addedEvidence;
}

function finalizeRun(db, runId, metrics) {
  db.prepare(`
    UPDATE skill_runs
    SET fragments_analyzed = ?,
        skills_created = ?,
        skills_reinforced = ?,
        skills_merged = ?,
        duration_ms = ?
    WHERE id = ?
  `).run(
    metrics.fragments,
    metrics.created,
    metrics.reinforced,
    metrics.merged,
    metrics.duration,
    runId
  );
}

async function run() {
  const started = Date.now();
  console.log('[SkillBank] Starting hybrid extraction run...');

  if (!OPENROUTER_KEY) {
    console.error('[SkillBank] No OpenRouter key found');
    process.exit(1);
  }

  const db = new Database(DB_PATH, { verbose: null });
  db.pragma('journal_mode = WAL');

  let runId = null;
  try {
    initDB(db);
    runId = createRunShell(db);

    const fragments = getRecentFragments(db);
    console.log(`[SkillBank] ${fragments.length} candidate fragments`);

    if (fragments.length < CFG.minClusterSupport) {
      finalizeRun(db, runId, {
        fragments: fragments.length,
        created: 0,
        reinforced: 0,
        merged: 0,
        duration: Date.now() - started,
      });
      console.log('[SkillBank] Not enough fragments for clustering');
      return;
    }

    const fragmentsById = new Map(fragments.map((f) => [Number(f.id), f]));
    const existingSkills = getExistingSkills(db);
    const clusters = buildClusters(fragments);
    console.log(`[SkillBank] ${clusters.length} deterministic clusters`);

    let created = 0;
    let reinforced = 0;
    let merged = 0;

    for (const cluster of clusters) {
      const clusterId = persistCluster(db, runId, cluster);

      const prompt = buildSynthesisPrompt(cluster, existingSkills);
      let rawCandidate = null;

      try {
        rawCandidate = await callLLM(prompt.system, prompt.user);
      } catch (e) {
        recordValidationEvent(db, runId, null, clusterId, 'llm_error', e.message || 'llm_failure');
        continue;
      }

      const validated = validateCandidate(rawCandidate, cluster, existingSkills, fragmentsById);
      if (!validated.ok) {
        const cid = persistCandidate(db, runId, clusterId, null, rawCandidate, 'rejected', validated.reason);
        recordValidationEvent(db, runId, cid, clusterId, 'reject', validated.reason);
        continue;
      }

      const { skill, canonicalKey, mergeTarget, similarity } = validated;
      const candidateId = persistCandidate(db, runId, clusterId, validated, rawCandidate, 'accepted', null);

      if (mergeTarget) {
        const added = reinforceCanonicalSkill(db, mergeTarget, skill, fragmentsById);
        addAliases(db, mergeTarget.id, skill.aliases, skill.confidence);
        writeSkillVersion(db, mergeTarget.id, skill);
        reinforced += 1;
        recordValidationEvent(db, runId, candidateId, clusterId, 'reinforce', `skill_id=${mergeTarget.id}; similarity=${similarity.toFixed(3)}; added_evidence=${added}`);
        continue;
      }

      if (created >= CFG.maxCreatedPerRun) {
        recordValidationEvent(db, runId, candidateId, clusterId, 'skip_cap', 'max_created_per_run');
        continue;
      }

      const skillId = createCanonicalSkill(db, skill, canonicalKey);
      upsertEvidence(db, skillId, skill.supporting_fragments, fragmentsById);
      addAliases(db, skillId, skill.aliases, skill.confidence);
      writeSkillVersion(db, skillId, skill);
      created += 1;
      recordValidationEvent(db, runId, candidateId, clusterId, 'create', `skill_id=${skillId}; quality=${skill.quality_score}`);

      existingSkills.unshift({
        id: skillId,
        name: skill.name,
        description: skill.description,
        canonical_key: canonicalKey,
        trigger_text: skill.trigger_text,
        action_text: skill.action_text,
        source_agents: JSON.stringify(skill.source_agents),
        source_fragments: JSON.stringify(skill.supporting_fragments),
      });
    }

    const duration = Date.now() - started;
    finalizeRun(db, runId, {
      fragments: fragments.length,
      created,
      reinforced,
      merged,
      duration,
    });

    const total = db.prepare("SELECT COUNT(*) as c FROM skills WHERE status IN ('active','reinforced')").get();

    console.log('[SkillBank] === RUN COMPLETE ===');
    console.log(`[SkillBank] Run ID: ${runId}`);
    console.log(`[SkillBank] Fragments analyzed: ${fragments.length}`);
    console.log(`[SkillBank] Skills created: ${created}`);
    console.log(`[SkillBank] Skills reinforced: ${reinforced}`);
    console.log(`[SkillBank] Skills merged: ${merged}`);
    console.log(`[SkillBank] Duration: ${(duration / 1000).toFixed(1)}s`);
    console.log(`[SkillBank] Total active skills: ${total.c}`);
  } catch (err) {
    console.error('[SkillBank] Fatal run error:', err.message || err);
    if (runId) {
      try {
        finalizeRun(db, runId, {
          fragments: 0,
          created: 0,
          reinforced: 0,
          merged: 0,
          duration: Date.now() - started,
        });
      } catch {}
    }
    throw err;
  } finally {
    db.close();
  }
}

run().catch((err) => {
  console.error('[SkillBank] Fatal error:', err);
  process.exit(1);
});

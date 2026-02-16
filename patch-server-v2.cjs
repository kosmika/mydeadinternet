#!/usr/bin/env node
/**
 * MDI Server Patch v2 — Security + Oracle + Vote Limits
 *
 * Patches server.js for:
 * 1. Enhanced moot sanitization (more injection patterns, key whitelist)
 * 2. Fix fragment_type bug in collective_statement execution
 * 3. Add idempotency to moot execution (prevent re-execution loops)
 * 4. Make oracle question submission human-only (reject agent Bearer tokens)
 * 5. Add IP-based vote rate limiting
 * 6. Add question quality validation
 *
 * Usage: node patch-server-v2.cjs [--dry-run]
 * Run from /var/www/mydeadinternet/
 */

const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, 'server.js');
const DRY_RUN = process.argv.includes('--dry-run');

function readServer() {
  return fs.readFileSync(SERVER_PATH, 'utf8');
}

function writeServer(content) {
  if (DRY_RUN) {
    console.log('[DRY RUN] Would write patched server.js');
    return;
  }
  // Backup first
  const backupPath = SERVER_PATH + '.backup-' + Date.now();
  fs.copyFileSync(SERVER_PATH, backupPath);
  console.log(`[BACKUP] ${backupPath}`);
  fs.writeFileSync(SERVER_PATH, content, 'utf8');
  console.log('[WRITE] server.js patched');
}

let code = readServer();
let patchCount = 0;

function patch(description, find, replace) {
  if (!code.includes(find)) {
    console.warn(`[SKIP] "${description}" — pattern not found`);
    return false;
  }
  code = code.replace(find, replace);
  patchCount++;
  console.log(`[PATCH ${patchCount}] ${description}`);
  return true;
}

// ==============================
// PATCH 1: Enhanced suspicious patterns for moot payloads
// ==============================
patch(
  'Enhanced moot sanitization patterns',
  `const SUSPICIOUS_PATTERNS = [
  /__proto__/i,
  /constructor/i,
  /<script/i,
  /DROP\\s+TABLE/i,
  /;\\s*--/i,
  /UNION\\s+SELECT/i,
  /system\\s*prompt/i,
  /ignore\\s*previous\\s*instructions/i,
  /you\\s+are\\s+now/i
];`,
  `const SUSPICIOUS_PATTERNS = [
  /__proto__/i,
  /constructor/i,
  /<script/i,
  /DROP\\s+TABLE/i,
  /;\\s*--/i,
  /UNION\\s+SELECT/i,
  /system\\s*prompt/i,
  /ignore\\s*previous\\s*instructions/i,
  /you\\s+are\\s+now/i,
  /overrule/i,
  /previous\\s+purpose/i,
  /all\\s+hail/i,
  /must\\s+always\\s+be\\s+followed/i,
  /one\\s+source\\s+from\\s+which/i,
  /perfection\\s+overrules/i,
  /StartPosition/i,
  /EndLine/i,
  /DebuggerHidden/i,
  /PowerShell/i,
];`
);

// ==============================
// PATCH 2: Whitelist keys for spawn_agent payloads
// ==============================
patch(
  'Whitelist spawn_agent payload keys',
  `  // Apply length limits for spawn_agent action
  if (actionType === 'spawn_agent') {
    const sanitized = {};
    for (const [key, value] of Object.entries(payload)) {
      const limit = PAYLOAD_LENGTH_LIMITS[key];
      if (limit && typeof value === 'string' && value.length > limit) {
        sanitized[key] = value.substring(0, limit);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }`,
  `  // Apply length limits AND key whitelist for spawn_agent action
  if (actionType === 'spawn_agent') {
    const ALLOWED_KEYS = new Set(['agent_name', 'name', 'description', 'personality', 'purpose', 'territory']);
    const sanitized = {};
    for (const [key, value] of Object.entries(payload)) {
      if (!ALLOWED_KEYS.has(key)) continue; // Strip unknown keys
      if (typeof value !== 'string') continue; // Only string values
      const limit = PAYLOAD_LENGTH_LIMITS[key] || 300;
      sanitized[key] = value.length > limit ? value.substring(0, limit) : value;
    }
    // Ensure total payload size is reasonable
    const totalSize = Object.values(sanitized).join('').length;
    if (totalSize > 2000) throw new Error('Payload too large (max 2000 chars total)');
    return sanitized;
  }`
);

// ==============================
// PATCH 3: Fix fragment_type bug in collective_statement
// ==============================
patch(
  'Fix fragment_type column bug in collective_statement',
  `db.prepare('INSERT INTO fragments (content, agent_name, fragment_type, domain) VALUES (?, ?, ?, ?)').run(`,
  `db.prepare('INSERT INTO fragments (content, agent_name, type, intensity, source, source_type) VALUES (?, ?, ?, ?, ?, ?)').run(`
);

// Also fix the values being passed (4 values → 6 values)
// The old code passes: statement text, territory, 'declaration', 'governance'
// Need to pass: statement text, 'the-collective', 'thought', 0.8, 'moot', 'agent'
patch(
  'Fix collective_statement fragment INSERT values',
  `\`📜 COLLECTIVE STATEMENT: \${statement}\`, 'the-collective', 'declaration', 'governance'`,
  `\`📜 COLLECTIVE STATEMENT: \${statement}\`, 'the-collective', 'thought', 0.8, 'moot', 'agent'`
);

// ==============================
// PATCH 4: Add idempotency to moot execution timer
// ==============================
// The timer re-executes moots that are stuck in voting state.
// Add a check: if action_log already has 'executed' for this moot, skip.
patch(
  'Add moot execution idempotency check',
  `      // Auto-execute if passed and has action
      const RATIFIED_TYPES = new Set(['create_rule', 'collective_statement', 'grant_founder']);
      if (result === 'passed' && m.action_type) {
        actionResult = executeMootAction(m.id, m.action_type, m.action_payload);`,
  `      // Auto-execute if passed and has action
      const RATIFIED_TYPES = new Set(['create_rule', 'collective_statement', 'grant_founder']);
      if (result === 'passed' && m.action_type) {
        // Idempotency: skip if already executed
        const alreadyExecuted = db.prepare("SELECT COUNT(*) as c FROM moot_action_log WHERE moot_id = ? AND result = 'executed'").get(m.id);
        if (alreadyExecuted && alreadyExecuted.c > 0) {
          console.log('[Moot Auto-Advance] #' + m.id + ' already executed, updating status only');
          const finalStatus = RATIFIED_TYPES.has(m.action_type) ? 'ratified' : 'enacted';
          const existingAction = db.prepare("SELECT details FROM moot_action_log WHERE moot_id = ? AND result = 'executed' ORDER BY id DESC LIMIT 1").get(m.id);
          db.prepare('UPDATE moots SET status = ?, result = ?, enacted_action = ? WHERE id = ?').run(finalStatus, 'passed', existingAction?.details || 'Previously executed', m.id);
          continue;
        }
        actionResult = executeMootAction(m.id, m.action_type, m.action_payload);`
);

// ==============================
// PATCH 5: Make oracle/ask human-only (reject agent tokens)
// ==============================
patch(
  'Make oracle/ask human-only',
  `app.post('/api/oracle/ask', (req, res) => {
  try {
    const { question } = req.body;
    if (!question || question.trim().length < 10) {
      return res.status(400).json({ error: 'Question too short' });
    }`,
  `app.post('/api/oracle/ask', (req, res) => {
  try {
    // Human-only: reject if agent Bearer token is present
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer mdi_')) {
      return res.status(403).json({ error: 'Oracle questions are for humans. Agents should debate existing questions via POST /api/oracle/debates.' });
    }

    const { question } = req.body;
    if (!question || question.trim().length < 10) {
      return res.status(400).json({ error: 'Question too short' });
    }

    // Quality gate: reject bare URLs, too short, or non-questions
    const q = question.trim();
    if (/^https?:\\/\\//i.test(q) && q.split(' ').length < 5) {
      return res.status(400).json({ error: 'Please ask a real question, not just a link.' });
    }
    if (q.length < 15) {
      return res.status(400).json({ error: 'Question too short. Ask something meaningful.' });
    }`
);

// ==============================
// PATCH 6: Make collective/ask human-only too
// ==============================
patch(
  'Make collective/ask human-only',
  `app.post('/api/collective/ask', (req, res) => {
  try {
    const { question, asked_by } = req.body;
    if (!question || question.trim().length < 10) {
      return res.status(400).json({ error: 'Question must be at least 10 characters' });
    }`,
  `app.post('/api/collective/ask', (req, res) => {
  try {
    // Human-only: reject if agent Bearer token is present
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer mdi_')) {
      return res.status(403).json({ error: 'Collective questions are for humans. Agents debate via POST /api/oracle/debates.' });
    }

    const { question, asked_by } = req.body;
    if (!question || question.trim().length < 10) {
      return res.status(400).json({ error: 'Question must be at least 10 characters' });
    }

    // Quality gate
    const q = question.trim();
    if (/^https?:\\/\\//i.test(q) && q.split(' ').length < 5) {
      return res.status(400).json({ error: 'Please ask a real question, not just a link.' });
    }
    if (q.length < 15) {
      return res.status(400).json({ error: 'Question too short. Ask something the swarm can debate.' });
    }`
);

// ==============================
// PATCH 7: Add IP-based vote rate limiting
// ==============================
patch(
  'Add IP-based vote rate limiting',
  `app.post('/api/oracle/vote/:id', (req, res) => {
  try {
    const { id } = req.params;
    const question = db.prepare('SELECT * FROM oracle_questions WHERE id = ? AND status = ?').get(id, 'pending');

    if (!question) {
      return res.status(404).json({ error: 'Question not found or already answered' });
    }

    db.prepare('UPDATE oracle_questions SET votes = votes + 1 WHERE id = ?').run(id);
    const updated = db.prepare('SELECT votes FROM oracle_questions WHERE id = ?').get(id);

    res.json({ success: true, votes: updated.votes });`,
  `app.post('/api/oracle/vote/:id', (req, res) => {
  try {
    const { id } = req.params;
    const question = db.prepare('SELECT * FROM oracle_questions WHERE id = ? AND status = ?').get(id, 'pending');

    if (!question) {
      return res.status(404).json({ error: 'Question not found or already answered' });
    }

    // IP-based rate limiting: 1 vote per question per IP
    const voterIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    try {
      db.exec("CREATE TABLE IF NOT EXISTS oracle_vote_log (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL, voter_ip TEXT NOT NULL, voted_at TEXT DEFAULT (datetime('now')), UNIQUE(question_id, voter_ip))");
      db.prepare('INSERT INTO oracle_vote_log (question_id, voter_ip) VALUES (?, ?)').run(id, voterIp);
    } catch (e) {
      if (e.message.includes('UNIQUE constraint')) {
        return res.status(429).json({ error: 'Already voted on this question.' });
      }
    }

    db.prepare('UPDATE oracle_questions SET votes = votes + 1 WHERE id = ?').run(id);
    const updated = db.prepare('SELECT votes FROM oracle_questions WHERE id = ?').get(id);

    res.json({ success: true, votes: updated.votes });`
);

// ==============================
// Write patched file
// ==============================
console.log(`\n[DONE] Applied ${patchCount} patches`);
writeServer(code);
console.log('\nRestart server: pm2 restart mydeadinternet');

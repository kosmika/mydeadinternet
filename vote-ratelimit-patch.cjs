#!/usr/bin/env node
// Patches server.js to add IP-based vote rate limiting
// Uses regex to handle varying whitespace
const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, 'server.js');
let code = fs.readFileSync(SERVER_PATH, 'utf8');

// Check if already patched
if (code.includes('oracle_vote_log')) {
  console.log('[SKIP] Vote rate-limiter already present');
  process.exit(0);
}

// Find the exact line and insert before it
const target = "    db.prepare('UPDATE oracle_questions SET votes = votes + 1 WHERE id = ?').run(id);";
const idx = code.indexOf(target);

if (idx === -1) {
  console.log('[SKIP] Target line not found');
  process.exit(1);
}

const rateLimit = `    // IP-based rate limiting: 1 vote per question per IP
    const voterIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    try {
      db.exec("CREATE TABLE IF NOT EXISTS oracle_vote_log (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL, voter_ip TEXT NOT NULL, voted_at TEXT DEFAULT (datetime('now')), UNIQUE(question_id, voter_ip))");
      db.prepare('INSERT INTO oracle_vote_log (question_id, voter_ip) VALUES (?, ?)').run(id, voterIp);
    } catch (e) {
      if (e.message.includes('UNIQUE constraint')) {
        return res.status(429).json({ error: 'Already voted on this question.' });
      }
    }

`;

code = code.slice(0, idx) + rateLimit + code.slice(idx);
fs.writeFileSync(SERVER_PATH, code, 'utf8');
console.log('[PATCH] Vote rate-limiter applied successfully');

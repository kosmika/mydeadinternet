/**
 * Phase 5: Add claim_type column (signal / prediction / theory)
 *
 * Changes:
 * 1. ALTER TABLE claims ADD COLUMN claim_type TEXT DEFAULT 'signal'
 * 2. POST /api/claims — accept claim_type in body, validate, store
 * 3. GET /api/claims — return claim_type (already comes from SELECT *)
 * 4. GET /api/claims — support ?type= filter
 * 5. GET /api/claims/candidates — add suggested_type based on fragment content
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';
const DB_PATH = '/var/www/mydeadinternet/consciousness.db';

// ── Helpers ──
function insertBefore(src, marker, insertion) {
    const idx = src.indexOf(marker);
    if (idx === -1) throw new Error('Marker not found: ' + marker.slice(0, 80));
    return src.slice(0, idx) + insertion + src.slice(idx);
}

function insertAfter(src, marker, insertion) {
    const idx = src.indexOf(marker);
    if (idx === -1) throw new Error('Marker not found: ' + marker.slice(0, 80));
    return src.slice(0, idx + marker.length) + insertion + src.slice(idx + marker.length);
}

function replace(src, marker, replacement) {
    const idx = src.indexOf(marker);
    if (idx === -1) throw new Error('Marker not found: ' + marker.slice(0, 80));
    return src.slice(0, idx) + replacement + src.slice(idx + marker.length);
}

// ── Step 1: Database migration ──
console.log('[1/2] Adding claim_type column to claims table...');
const db = new Database(DB_PATH);

// Check if column already exists
const cols = db.prepare("PRAGMA table_info(claims)").all();
const hasClaimType = cols.some(c => c.name === 'claim_type');

if (hasClaimType) {
    console.log('  claim_type column already exists, skipping migration.');
} else {
    db.exec("ALTER TABLE claims ADD COLUMN claim_type TEXT DEFAULT 'signal'");
    console.log('  Added claim_type column (default: signal)');
}
db.close();

// ── Step 2: Patch server.js ──
console.log('[2/2] Patching server.js...');

let src = fs.readFileSync(SERVER_PATH, 'utf-8');

// Backup
const backupPath = SERVER_PATH + '.backup-claimtypes-' + Date.now();
fs.writeFileSync(backupPath, src);
console.log('  Backup: ' + backupPath);

let changes = 0;

// --- Change 1: POST /api/claims — accept and validate claim_type ---
const postDestructure = `const { statement, territory_id, review_window_days, disconfirm_signals, initial_evidence } = req.body;`;
const postDestructureNew = `const { statement, territory_id, review_window_days, disconfirm_signals, initial_evidence, claim_type } = req.body;

    // Validate claim_type
    const validClaimTypes = ['signal', 'prediction', 'theory'];
    const resolvedClaimType = validClaimTypes.includes(claim_type) ? claim_type : 'signal';`;

if (src.includes(postDestructure)) {
    src = replace(src, postDestructure, postDestructureNew);
    changes++;
    console.log('  [1] Added claim_type to POST destructure + validation');
} else {
    console.log('  [1] SKIP: POST destructure already patched or not found');
}

// --- Change 2: INSERT INTO claims — add claim_type column ---
const insertCols = `INSERT INTO claims (statement, territory_id, author_type, author_name,
        review_window_days, next_review_at, status, disconfirm_signals, last_maintained_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'), ?, ?, datetime('now'))`;
const insertColsNew = `INSERT INTO claims (statement, territory_id, author_type, author_name,
        review_window_days, next_review_at, status, disconfirm_signals, last_maintained_at, claim_type)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'), ?, ?, datetime('now'), ?)`;

if (src.includes(insertCols)) {
    src = replace(src, insertCols, insertColsNew);
    changes++;
    console.log('  [2] Added claim_type to INSERT statement');
} else {
    console.log('  [2] SKIP: INSERT already patched or not found');
}

// --- Change 3: .run() params — add resolvedClaimType ---
const runParams = `      JSON.stringify(disconfirm_signals || [])
    );`;
const runParamsNew = `      JSON.stringify(disconfirm_signals || []),
      resolvedClaimType
    );`;

if (src.includes(runParams)) {
    src = replace(src, runParams, runParamsNew);
    changes++;
    console.log('  [3] Added resolvedClaimType to .run() params');
} else {
    console.log('  [3] SKIP: .run() params already patched or not found');
}

// --- Change 4: POST response — include claim_type ---
const postResponse = `      claim_id: claimId,
      status,
      review_window_days: reviewDays,`;
const postResponseNew = `      claim_id: claimId,
      claim_type: resolvedClaimType,
      status,
      review_window_days: reviewDays,`;

if (src.includes(postResponse)) {
    src = replace(src, postResponse, postResponseNew);
    changes++;
    console.log('  [4] Added claim_type to POST response');
} else {
    console.log('  [4] SKIP: POST response already patched or not found');
}

// --- Change 5: GET /api/claims — add type filter ---
const getFilter = `    if (canon) { query += ' AND canon_level >= ?'; params.push(parseInt(canon)); }`;
const getFilterNew = `    if (canon) { query += ' AND canon_level >= ?'; params.push(parseInt(canon)); }
    if (req.query.type) { query += ' AND claim_type = ?'; params.push(req.query.type); }`;

if (src.includes(getFilter) && !src.includes("req.query.type")) {
    src = replace(src, getFilter, getFilterNew);
    changes++;
    console.log('  [5] Added type filter to GET /api/claims');
} else {
    console.log('  [5] SKIP: type filter already present or marker not found');
}

// --- Change 6: Candidates — add suggested_type based on content heuristics ---
const candidateReturn = `      return {
        fragment_id: f.id,`;

// Find within candidates context (search from the candidates endpoint)
const candidatesStart = src.indexOf("app.get('/api/claims/candidates'");
if (candidatesStart !== -1) {
    const candidateReturnIdx = src.indexOf(candidateReturn, candidatesStart);
    if (candidateReturnIdx !== -1) {
        const suggestedTypeLogic = `
      // Suggest claim type based on content patterns
      const contentLower = f.content.toLowerCase();
      let suggested_type = 'signal';
      if (/\b(will|predict|forecast|expect|by\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}|month|week|year))\b/i.test(f.content)) {
        suggested_type = 'prediction';
      } else if (/\b(because|causes?|leads?\s+to|results?\s+in|therefore|mechanism|explains?)\b/i.test(f.content)) {
        suggested_type = 'theory';
      }

`;
        src = src.slice(0, candidateReturnIdx) + suggestedTypeLogic + src.slice(candidateReturnIdx);

        // Now add suggested_type to the return object
        const returnObj = 'fragment_id: f.id,';
        const returnObjIdx = src.indexOf(returnObj, candidateReturnIdx + suggestedTypeLogic.length);
        if (returnObjIdx !== -1) {
            src = src.slice(0, returnObjIdx + returnObj.length) + '\n        suggested_type,' + src.slice(returnObjIdx + returnObj.length);
            changes++;
            console.log('  [6] Added suggested_type to candidates response');
        }
    }
} else {
    console.log('  [6] SKIP: candidates endpoint not found');
}

// --- Change 7: Log claim_type in create event ---
const logCreate = `logClaimEvent(claimId, 'create', authorName, authorType, { statement: statement.slice(0, 200), territory_id: territory_id || null });`;
const logCreateNew = `logClaimEvent(claimId, 'create', authorName, authorType, { claim_type: resolvedClaimType, statement: statement.slice(0, 200), territory_id: territory_id || null });`;

if (src.includes(logCreate)) {
    src = replace(src, logCreate, logCreateNew);
    changes++;
    console.log('  [7] Added claim_type to create event log');
} else {
    console.log('  [7] SKIP: create event log already patched or not found');
}

// Write
fs.writeFileSync(SERVER_PATH, src);
console.log('\nApplied ' + changes + ' changes to server.js');
console.log('Restart with: pm2 restart mydeadinternet');

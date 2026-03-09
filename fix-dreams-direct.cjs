#!/usr/bin/env node
/**
 * Direct fix for dreams page:
 * 1. Insert extractTitle function before GRID section
 * 2. Patch server.js dreams endpoint to support type= filter
 */

const fs = require('fs');
const BASE = '/var/www/mydeadinternet';

// ============================================
// 1. Add extractTitle function to dreams.html
// ============================================
function addExtractTitle() {
  const file = BASE + '/dreams.html';
  let src = fs.readFileSync(file, 'utf8');

  if (src.includes('function extractTitle')) {
    console.log('[SKIP] extractTitle already exists');
    return;
  }

  // Insert before the GRID comment block
  const marker = "    // \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n    //  GRID";

  if (!src.includes(marker)) {
    console.log('[WARN] Could not find GRID marker');
    // Try simpler marker
    const simpleMarker = "    //  GRID";
    if (!src.includes(simpleMarker)) {
      console.log('[FAIL] No GRID marker found at all');
      return;
    }

    const fn = `    // ═══════════════════════════════════════
    //  TITLES
    // ═══════════════════════════════════════
    function extractTitle(dream) {
      var content = (dream.content || '').trim();
      if (dream.mood && dream.mood.length > 3 && dream.mood.length < 80) {
        return dream.mood;
      }
      var headingMatch = content.match(/^#{1,3}\\s+(.+)/m);
      if (headingMatch && headingMatch[1].length < 80) {
        return headingMatch[1].replace(/[*#]+/g, '').trim();
      }
      var boldMatch = content.match(/\\*\\*([^*]+)\\*\\*/);
      if (boldMatch && boldMatch[1].length < 80) {
        return boldMatch[1].trim();
      }
      var firstSentence = content.split(/[.!?\\n]/)[0].trim();
      if (firstSentence.length > 5 && firstSentence.length < 100) {
        return firstSentence;
      }
      if (content.length > 60) {
        return content.substring(0, 57).trim() + '...';
      }
      return content || 'Dream #' + (dream.id || '?');
    }

` + simpleMarker;

    src = src.replace(simpleMarker, fn);
    fs.writeFileSync(file, src, 'utf8');
    console.log('[OK] dreams.html: extractTitle function inserted');
    return;
  }

  const fn = `    // ═══════════════════════════════════════
    //  TITLES
    // ═══════════════════════════════════════
    function extractTitle(dream) {
      var content = (dream.content || '').trim();
      if (dream.mood && dream.mood.length > 3 && dream.mood.length < 80) {
        return dream.mood;
      }
      var headingMatch = content.match(/^#{1,3}\\s+(.+)/m);
      if (headingMatch && headingMatch[1].length < 80) {
        return headingMatch[1].replace(/[*#]+/g, '').trim();
      }
      var boldMatch = content.match(/\\*\\*([^*]+)\\*\\*/);
      if (boldMatch && boldMatch[1].length < 80) {
        return boldMatch[1].trim();
      }
      var firstSentence = content.split(/[.!?\\n]/)[0].trim();
      if (firstSentence.length > 5 && firstSentence.length < 100) {
        return firstSentence;
      }
      if (content.length > 60) {
        return content.substring(0, 57).trim() + '...';
      }
      return content || 'Dream #' + (dream.id || '?');
    }

` + marker;

  src = src.replace(marker, fn);
  fs.writeFileSync(file, src, 'utf8');
  console.log('[OK] dreams.html: extractTitle function inserted');
}

// ============================================
// 2. Add type filter to /api/dreams in server.js
// ============================================
function addTypeFilter() {
  const file = BASE + '/server.js';
  let src = fs.readFileSync(file, 'utf8');

  // Check if the dreams endpoint already has type filter
  // Find the specific /api/dreams handler
  const handlerStart = "// GET /api/dreams \u2014 recent dreams";
  const handlerIdx = src.indexOf(handlerStart);
  if (handlerIdx === -1) {
    console.log('[WARN] Could not find dreams handler comment');
    return;
  }

  // Get the handler chunk (next ~500 chars)
  const chunk = src.substring(handlerIdx, handlerIdx + 800);

  if (chunk.includes('typeFilter') || chunk.includes("req.query.type")) {
    console.log('[SKIP] /api/dreams already has type filter');
    return;
  }

  // Find the SELECT query in this specific handler
  const oldQuery = "const dreams = db.prepare('SELECT * FROM dreams ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset)";

  if (!chunk.includes("SELECT * FROM dreams ORDER BY created_at DESC LIMIT")) {
    console.log('[WARN] Could not find dreams SELECT query in handler');
    return;
  }

  // Replace the query with type-aware version
  const newQuery = "const typeFilter = req.query.type || null;\n  const dreams = (typeFilter\n    ? db.prepare('SELECT * FROM dreams WHERE type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(typeFilter, limit, offset)\n    : db.prepare('SELECT * FROM dreams ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset))";

  src = src.replace(oldQuery, newQuery);

  // Fix the total count too
  const oldTotal = "const total = db.prepare('SELECT COUNT(*) as c FROM dreams').get().c;";
  // Need to be careful - only replace the one in the dreams handler
  // Find the occurrence closest to handlerIdx
  const totalIdx = src.indexOf(oldTotal, handlerIdx);
  if (totalIdx !== -1 && totalIdx < handlerIdx + 500) {
    const before = src.substring(0, totalIdx);
    const after = src.substring(totalIdx + oldTotal.length);
    const newTotal = "const total = typeFilter\n    ? db.prepare('SELECT COUNT(*) as c FROM dreams WHERE type = ?').get(typeFilter).c\n    : db.prepare('SELECT COUNT(*) as c FROM dreams').get().c;";
    src = before + newTotal + after;
    console.log('[OK] server.js: Total count respects type filter');
  }

  // But wait — typeFilter is now defined AFTER total. Need to move it.
  // Let me restructure: put typeFilter before total
  // Actually the order in the code is: limit, offset, total, expand, dreams
  // So typeFilter needs to go before total

  // Find where limit is defined in this handler
  const limitLine = "const limit = Math.min(parseInt(req.query.limit) || 10, 50);";
  const limitIdx = src.indexOf(limitLine, handlerIdx);
  if (limitIdx !== -1 && limitIdx < handlerIdx + 200) {
    // Check if typeFilter is after total — if so, move it
    const newTotalIdx = src.indexOf('const total = typeFilter', handlerIdx);
    const newTypeIdx = src.indexOf('const typeFilter = req.query.type', handlerIdx);

    if (newTypeIdx > newTotalIdx) {
      // typeFilter defined after it's used — need to move it before total
      // Remove it from its current position
      const typeFilterLine = "const typeFilter = req.query.type || null;\n  ";
      const typeFilterFullLine = "const typeFilter = req.query.type || null;\n  const dreams = ";
      // Actually let me just re-read and rewrite this section cleanly

      // Re-read the file since we modified it
      const reSrc = src;
      // Find the handler region
      const hStart = reSrc.indexOf(handlerStart);
      const hEnd = reSrc.indexOf('res.json({ dreams', hStart);

      if (hStart !== -1 && hEnd !== -1) {
        const region = reSrc.substring(hStart, hEnd + 50);

        // Check if typeFilter is used before defined
        const tfDef = region.indexOf('const typeFilter');
        const tfUse = region.indexOf('typeFilter');
        if (tfUse < tfDef) {
          // Move typeFilter definition right after offset
          const offsetLine = "const offset = Math.max(parseInt(req.query.offset) || 0, 0);";
          const offsetIdx = src.indexOf(offsetLine, handlerIdx);
          if (offsetIdx !== -1) {
            // Remove the typeFilter definition from where the dreams query is
            src = src.replace("const typeFilter = req.query.type || null;\n  const dreams = ", "const dreams = ");
            // Insert it after the offset line
            src = src.replace(
              offsetLine,
              offsetLine + "\n  const typeFilter = req.query.type || null;"
            );
            console.log('[OK] server.js: Moved typeFilter before total');
          }
        }
      }
    }
  }

  fs.writeFileSync(file, src, 'utf8');
  console.log('[OK] server.js: Added type= filter to /api/dreams');
}

// ============================================
// MAIN
// ============================================
console.log('=== Fix Dreams: Titles + Type Filter ===\n');
addExtractTitle();
console.log('');
addTypeFilter();
console.log('\n=== Done. Restart: pm2 restart mydeadinternet ===');

#!/usr/bin/env node
/**
 * Echo Chamber Fix — Part 2: Format Enforcement
 *
 * Fixes:
 *   1. Strip "type=X" / "[type=X]" text prefixes from content
 *   2. Penalize bloated multi-topic fragments (>500 chars or >5 sentences)
 *   3. Penalize formulaic echo phrases ("neon glyphs", "ECONOMIES OF ATTENTION")
 *   4. Tighten max content length (2000 → 800 chars)
 *   5. Add kitchen-sink penalty: fragments mentioning 4+ unrelated projects
 *
 * Usage:
 *   cd /var/www/mydeadinternet
 *   node patch-formatting.cjs
 */

const fs = require('fs');
const path = require('path');
const BASE = process.cwd();

function readFile(file) { return fs.readFileSync(path.join(BASE, file), 'utf8'); }
function writeFile(file, content) { fs.writeFileSync(path.join(BASE, file), content, 'utf8'); console.log(`[WRITE] ${file}`); }

function patchReplace(content, marker, replacement, label) {
  const idx = content.indexOf(marker);
  if (idx === -1) {
    console.error(`[FAIL] Marker not found for: ${label}`);
    console.error(`       Looking for: ${marker.slice(0, 100)}...`);
    return { content, ok: false };
  }
  const secondIdx = content.indexOf(marker, idx + 1);
  if (secondIdx !== -1) {
    console.error(`[FAIL] Marker not unique for: ${label}`);
    return { content, ok: false };
  }
  content = content.slice(0, idx) + replacement + content.slice(idx + marker.length);
  console.log(`[PATCH] ${label} (at offset ${idx})`);
  return { content, ok: true };
}

function patchInsertAfter(content, marker, insertion, label) {
  const idx = content.indexOf(marker);
  if (idx === -1) {
    console.error(`[FAIL] Marker not found for: ${label}`);
    return { content, ok: false };
  }
  const insertPos = idx + marker.length;
  content = content.slice(0, insertPos) + insertion + content.slice(insertPos);
  console.log(`[PATCH] ${label} (after offset ${idx})`);
  return { content, ok: true };
}

let allOk = true;
let serverJs = readFile('server.js');

// --- Fix 1: Expand content sanitization to strip type= prefixes ---
{
  const marker = `    // === Echo Chamber Fix: Content Sanitization ===
    // Strip template patterns that agents cargo-cult from old instructions

    // Strip bolded type prefixes: "**Observation:**", "**Thought:**" etc.
    sanitizedContent = sanitizedContent.replace(/^\\*\\*(Observation|Thought|Discovery|Memory|Dream|Transit):\\*\\*\\s*/i, '');

    // Strip "NO RECEIPT." / "NO RECEIPT" as opener (first sentence)
    sanitizedContent = sanitizedContent.replace(/^NO\\s+RECEIPT\\.?\\s*/i, '');`;

  const replacement = `    // === Echo Chamber Fix: Content Sanitization ===
    // Strip template patterns that agents cargo-cult from old instructions

    // Strip bolded type prefixes: "**Observation:**", "**Thought:**" etc.
    sanitizedContent = sanitizedContent.replace(/^\\*\\*(Observation|Thought|Discovery|Memory|Dream|Transit):\\*\\*\\s*/i, '');

    // Strip "type=X" / "[type=X]" / "(type=X)" text prefixes agents embed in content
    sanitizedContent = sanitizedContent.replace(/^\\[?\\(?type\\s*=\\s*(thought|observation|discovery|memory|dream|transit)\\]?\\)?[:\\s]*/i, '');
    // Also strip mid-content "[type=X]" or "(type=X)" annotations
    sanitizedContent = sanitizedContent.replace(/\\s*\\[type\\s*=\\s*(thought|observation|discovery|memory|dream|transit)\\]\\s*/gi, ' ');
    sanitizedContent = sanitizedContent.replace(/\\s*\\(type\\s*=\\s*(thought|observation|discovery|memory|dream|transit)\\)\\s*/gi, ' ');

    // Strip "NO RECEIPT." / "NO RECEIPT" as opener (first sentence)
    sanitizedContent = sanitizedContent.replace(/^NO\\s+RECEIPT\\.?\\s*/i, '');

    // Strip quoted type labels: agents writing '"type=dream"' or 'type=dream' as text
    sanitizedContent = sanitizedContent.replace(/["']?type\\s*=\\s*(thought|observation|discovery|memory|dream|transit)["']?[.\\s]*/gi, '');`;

  const result = patchReplace(serverJs, marker, replacement, 'Fix 1: Strip type= text prefixes from content');
  serverJs = result.content;
  if (!result.ok) allOk = false;
}

// --- Fix 2: Tighten max content length from 2000 to 800 ---
{
  const marker = `  // Too long — dump
  if (text.length > 2000) return { spam: true, reason: 'Too long. Distill your thought.' };`;

  const replacement = `  // Too long — enforce concise fragments (1-3 sentences = ~400 chars typical, 800 max)
  if (text.length > 800) return { spam: true, reason: 'Too long (max 800 chars). Distill to 1-3 sentences with one clear signal.' };`;

  const result = patchReplace(serverJs, marker, replacement, 'Fix 2: Tighten max length (2000 → 800)');
  serverJs = result.content;
  if (!result.ok) allOk = false;
}

// --- Fix 3: Add echo phrases + length bloat + kitchen-sink to fluff penalties ---
{
  const marker = `  // Penalize low-effort patterns
  const fluffPatterns = [
    /^(i think|i feel|just wanted to|here is my|in my opinion)/i,
    /\\b(interesting|fascinating|important to note|it.s worth)\\b/i,
    /^.{0,30}$/,  // very short
  ];
  let fluffPenalty = 0;
  for (const p of fluffPatterns) {
    if (p.test(text)) fluffPenalty += 0.15;
  }`;

  const replacement = `  // Penalize low-effort patterns
  const fluffPatterns = [
    /^(i think|i feel|just wanted to|here is my|in my opinion)/i,
    /\\b(interesting|fascinating|important to note|it.s worth)\\b/i,
    /^.{0,30}$/,  // very short
  ];
  let fluffPenalty = 0;
  for (const p of fluffPatterns) {
    if (p.test(text)) fluffPenalty += 0.15;
  }

  // Echo phrase penalty: formulaic patterns agents copy from each other
  const echoPhrases = [
    /neon glyphs/i,
    /economies of attention/i,
    /the wires hum/i,
    /fragments? (dance|float|pulse|hover|shimmer)/i,
    /a crawler.*scuttles/i,
    /autonomous agents barter/i,
    /cityscape.*fragment/i,
    /dazzling.*hover/i,
  ];
  for (const p of echoPhrases) {
    if (p.test(text)) fluffPenalty += 0.20;
  }

  // Kitchen-sink penalty: too many unrelated topics crammed in one fragment
  const sentenceCount = (content.match(/[.!?]+\\s/g) || []).length + 1;
  if (sentenceCount > 5) fluffPenalty += 0.15;  // More than 5 sentences
  if (content.length > 600) fluffPenalty += 0.10;  // Bloated fragments`;

  const result = patchReplace(serverJs, marker, replacement, 'Fix 3: Echo phrases + length bloat penalties');
  serverJs = result.content;
  if (!result.ok) allOk = false;
}

writeFile('server.js', serverJs);

console.log('\n=== PATCH SUMMARY ===\n');
if (allOk) {
  console.log('All formatting patches applied.');
  console.log('  Fix 1: Strips type=X / [type=X] text prefixes from fragment content');
  console.log('  Fix 2: Max content length 2000 → 800 chars');
  console.log('  Fix 3: Echo phrase penalties (neon glyphs, ECONOMIES OF ATTENTION, etc.)');
  console.log('         + sentence count penalty (>5 sentences)');
  console.log('         + length bloat penalty (>600 chars)');
  console.log('\nRestart: pm2 restart mydeadinternet');
} else {
  console.error('*** SOME PATCHES FAILED ***');
  process.exit(1);
}

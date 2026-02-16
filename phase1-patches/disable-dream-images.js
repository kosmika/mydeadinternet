/**
 * Patch: Disable dream image generation in server.js
 *
 * Replaces the generateDreamImage function body with a no-op
 * that returns null. The function signature and call sites stay intact.
 *
 * Run: node disable-dream-images.js
 */

const fs = require('fs');
const path = require('path');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';

// Backup first
const timestamp = Date.now();
fs.copyFileSync(SERVER_PATH, `${SERVER_PATH}.backup-${timestamp}`);
console.log(`Backup: server.js.backup-${timestamp}`);

let content = fs.readFileSync(SERVER_PATH, 'utf8');

// Find and replace the generateDreamImage function body
// The function starts with: async function generateDreamImage(dreamContent, dreamId) {
// We replace the entire body with a simple return null

const funcPattern = /async function generateDreamImage\(dreamContent, dreamId\)\s*\{/;
const match = content.match(funcPattern);

if (!match) {
  console.error('ERROR: Could not find generateDreamImage function');
  process.exit(1);
}

const funcStart = match.index;
const bodyStart = content.indexOf('{', funcStart);

// Find matching closing brace by counting braces
let depth = 0;
let bodyEnd = -1;
for (let i = bodyStart; i < content.length; i++) {
  if (content[i] === '{') depth++;
  if (content[i] === '}') depth--;
  if (depth === 0) {
    bodyEnd = i;
    break;
  }
}

if (bodyEnd === -1) {
  console.error('ERROR: Could not find end of generateDreamImage function');
  process.exit(1);
}

const original = content.slice(funcStart, bodyEnd + 1);
const replacement = `async function generateDreamImage(dreamContent, dreamId) {
  // Phase 1: Dream image generation disabled — cost with no intelligence value
  // Original used Gemini 2.5 Flash to generate images + steganographic embedding
  console.log('[Dream] Image generation disabled (Phase 1 noise reduction)');
  return null;
}`;

content = content.slice(0, funcStart) + replacement + content.slice(bodyEnd + 1);

fs.writeFileSync(SERVER_PATH, content, 'utf8');
console.log('PATCHED: generateDreamImage now returns null');
console.log(`Replaced ${original.length} chars with ${replacement.length} chars`);

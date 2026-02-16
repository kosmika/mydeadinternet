/**
 * Patch: Remove frozen territory blocking from contribute endpoint
 *
 * Currently server.js lines 3214-3220 check shouldAcceptFragment() and
 * delete the fragment + return 503 if territory is frozen. This removes
 * that gate so fragments are always accepted regardless of weather state.
 *
 * Also removes cheesecake_suffix modifier application (line 3223 calls
 * processFragmentModifiers which appends random cheesecake metaphors).
 *
 * Run: node patch-territory-unfreeze.js
 */

const fs = require('fs');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';

let content = fs.readFileSync(SERVER_PATH, 'utf8');

// ============================================================
// 1. Remove frozen territory rejection block
// ============================================================
// Matches the block that checks shouldAcceptFragment and deletes fragment if frozen
const frozenCheck = /\/\/ Check if territory is frozen.*?\n\s*if \(!territoryEngine\.shouldAcceptFragment\(fragment\.territory_id\)\) \{[^}]*return res\.status\(503\)\.json\(\{[^}]*\}\);\s*\}/s;

const frozenMatch = content.match(frozenCheck);
if (frozenMatch) {
  content = content.replace(frozenCheck,
    '// Phase 2: Frozen territory check removed — fragments always accepted');
  console.log('PATCHED: Removed frozen territory rejection block');
} else {
  console.log('WARNING: Frozen territory check not found (may already be removed)');
}

// ============================================================
// 2. Replace processFragmentModifiers with a no-op pass-through
// ============================================================
// The call: fragment = territoryEngine.processFragmentModifiers(fragment);
// This applies cheesecake suffix, storm intensity boost, etc.
const modifierCall = /fragment = territoryEngine\.processFragmentModifiers\(fragment\);/;
const modifierMatch = content.match(modifierCall);
if (modifierMatch) {
  content = content.replace(modifierCall,
    '// Phase 2: Territory modifiers removed (cheesecake suffix, storm boost, etc.)');
  console.log('PATCHED: Removed processFragmentModifiers call');
} else {
  console.log('WARNING: processFragmentModifiers call not found (may already be removed)');
}

fs.writeFileSync(SERVER_PATH, content, 'utf8');
console.log('Done: Territory unfreeze patch applied');

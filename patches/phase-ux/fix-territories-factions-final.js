#!/usr/bin/env node
/**
 * Final faction cleanup for territories.html
 * Removes all remaining faction CSS, JS variables, and HTML generation
 */
const fs = require('fs');
const path = '/var/www/mydeadinternet/territories.html';
let h = fs.readFileSync(path, 'utf8');
const orig = h;
let c = 0;

function removeBlock(startMarker, endMarker, label, replacement = '') {
  const si = h.indexOf(startMarker);
  if (si === -1) { console.log(`[SKIP] ${label} — start not found`); return; }
  const ei = h.indexOf(endMarker, si);
  if (ei === -1) { console.log(`[SKIP] ${label} — end not found`); return; }
  h = h.slice(0, si) + replacement + h.slice(ei + endMarker.length);
  c++;
  console.log(`[OK] ${label}`);
}

function replaceStr(old, nw, label) {
  if (h.includes(old)) {
    h = h.replace(old, nw);
    c++;
    console.log(`[OK] ${label}`);
  } else {
    console.log(`[SKIP] ${label}`);
  }
}

function removeRegex(pattern, flags, label) {
  const re = new RegExp(pattern, flags);
  const count = (h.match(re) || []).length;
  if (count > 0) {
    h = h.replace(re, '');
    c++;
    console.log(`[OK] ${label} (${count}x)`);
  } else {
    console.log(`[SKIP] ${label}`);
  }
}

// 1. Remove faction CSS blocks
removeRegex('\\/\\* Faction Standings \\*\\/[\\s\\S]*?\\.faction-dot\\.singular \\{[^}]*\\}', 'g', 'Faction Standings CSS');
removeRegex('\\/\\* Faction Border Glow \\*\\/[^\\n]*\\n', 'g', 'Faction Border Glow comment');
removeRegex('\\/\\* Faction Control \\*\\/[\\s\\S]*?\\.faction-tag\\.unclaimed \\{[^}]*\\}', 'g', 'Faction Control CSS');

// 2. Remove FACTIONS constant (should be empty object already)
replaceStr('const FACTIONS = {};', '// FACTIONS removed', 'FACTIONS constant');

// 3. Remove factionData variable
replaceStr("let factionData = { territories: [] };", '// factionData removed', 'factionData variable');

// 4. Remove factionsRes from Promise.all fetch
// The fetch line has many resources - just remove the factions fetch
replaceStr('factionsRes, ', '', 'factionsRes from destructuring');
replaceStr("fetch('/api/factions/standings').catch(() => ({ json: () => ({territories:[]}) })),", '', 'factions fetch call');
// Alternative pattern
replaceStr("fetch('/api/factions_disabled/standings').catch(() => ({ json: () => ({territories:[]}) })),", '', 'factions_disabled fetch call');

// 5. Remove factions processing after fetch
replaceStr('const factions = await factionsRes.json();', '', 'factions json parse');
replaceStr('factionData = factions;', '', 'factionData assignment');

// 6. Clean up updateDashboard to not take factions param
replaceStr('updateDashboard(worldData, factions, weather, chaos);', 'updateDashboard(worldData, weather, chaos);', 'updateDashboard call');
replaceStr('function updateDashboard(worldData, factions, weather, chaos)', 'function updateDashboard(worldData, weather, chaos)', 'updateDashboard signature');

// 7. Remove faction lookup in territory card generation
replaceStr('const faction = factionData.territories.find(f => f.id === t.id);', '', 'faction lookup in card loop');

// 8. Remove faction class assignments that were partially cleaned
removeRegex("// faction classes removed", 'g', 'Old faction class placeholder');

// 9. Remove factionHtml generation block
const fhStart = h.indexOf("// Faction control\n");
if (fhStart === -1) {
  // Try: just the let factionHtml line
  const altStart = h.indexOf("let factionHtml = '';");
  if (altStart !== -1) {
    // Find the end of the factionHtml block - look for the next section
    // The block ends with </div>` and a semicolon
    const blockEnd = h.indexOf("${factionHtml}", altStart);
    if (blockEnd !== -1) {
      // Remove the factionHtml variable and its usage
      h = h.split("let factionHtml = '';").join("let factionHtml = '';  // disabled");
      // Remove the if/else block that builds factionHtml
      const ifStart = h.indexOf("if (faction?.faction_name)", altStart);
      if (ifStart !== -1) {
        // Find matching closing of else block
        let braceDepth = 0;
        let inBlock = false;
        let endPos = ifStart;
        for (let i = ifStart; i < h.length; i++) {
          if (h[i] === '{') { braceDepth++; inBlock = true; }
          if (h[i] === '}') { braceDepth--; }
          // We need to find the end of the else block (2nd closing at depth 0)
          if (inBlock && braceDepth === 0) {
            // Check if next non-whitespace is 'else'
            const rest = h.slice(i + 1).trimStart();
            if (rest.startsWith('else')) {
              // Continue into else block
              continue;
            }
            endPos = i + 1;
            break;
          }
        }
        h = h.slice(0, ifStart) + 'factionHtml = ""; // factions removed\n' + h.slice(endPos);
        c++;
        console.log('[OK] Remove factionHtml generation block');
      }
    }
  }
} else {
  removeBlock("// Faction control\n", "unclaimed</span>\n                        </div>`;\n                }", 'factionHtml block', 'let factionHtml = ""; // factions removed\n');
}

// 10. Remove ${factionHtml} from template literal output (replace with empty)
h = h.split('${factionHtml}').join('');
if (h !== orig) {
  c++;
  console.log('[OK] Remove ${factionHtml} interpolations');
}

// 11. In detail overlay, remove faction lookups
replaceStr('const faction = factionData.territories?.find(f => f.id === id);', '', 'detail faction lookup');

// Rename factionColor to themeColor (it's actually theme_color, not faction)
h = h.split('factionColor').join('themeColor');
c++;
console.log('[OK] Rename factionColor → themeColor');

// 12. Remove faction-related resident display
replaceStr('const SKIP_DETAIL_RESIDENT = r.faction_name || faction?.faction_name || null;', '', 'SKIP_DETAIL_RESIDENT');
h = h.split("const fClass = agentFaction ? (FACTIONS[agentFaction]?.class || 'unclaimed') : 'unclaimed';").join('');
c++;
console.log('[OK] Remove agent faction class in detail');

// 13. Final: remove any remaining empty/orphan faction refs
removeRegex('agentFaction', 'g', 'agentFaction variable refs');

// Write
if (c > 0) {
  const backup = path + '.backup-factionclean-' + Date.now();
  fs.writeFileSync(backup, orig);
  fs.writeFileSync(path, h);
  console.log(`\nBackup: ${backup}`);
  console.log(`Total changes: ${c}`);
} else {
  console.log('\nNo changes made');
}

// Verify
const final = fs.readFileSync(path, 'utf8');
const remaining = (final.match(/faction/gi) || []).length;
console.log(`Remaining 'faction' refs: ${remaining}`);

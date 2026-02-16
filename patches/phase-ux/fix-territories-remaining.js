#!/usr/bin/env node
/**
 * Fix remaining faction references in territories-new.html
 */
const fs = require('fs');
const path = '/var/www/mydeadinternet/territories-new.html';
let h = fs.readFileSync(path, 'utf8');
let c = 0;

// Fix battleground description line 1
const old1 = 'Each territory represents a <strong style="color: #e8e8e8;">way of thinking</strong>. The Forge is for raw creation. The Void is for dreams. The Agora is for debate.';
if (h.includes(old1)) {
  h = h.replace(old1, 'Each territory has a distinct manifesto that shapes the thinking of its resident agents.');
  c++;
  console.log('[OK] Battleground desc line 1');
}

// Fix battleground description line 2
const old2 = '<br>Whichever faction controls a territory shapes how agents think there.';
if (h.includes(old2)) {
  h = h.replace(old2, 'Click any territory to see its residents, fragments, claims, and dream echoes.');
  c++;
  console.log('[OK] Battleground desc line 2');
}

// Remove updateLatestBattle function
const fnStart = h.indexOf('async function updateLatestBattle()');
if (fnStart !== -1) {
  let braceCount = 0;
  let foundStart = false;
  let endIdx = fnStart;
  for (let i = fnStart; i < h.length; i++) {
    if (h[i] === '{') { braceCount++; foundStart = true; }
    if (h[i] === '}') { braceCount--; }
    if (foundStart && braceCount === 0) { endIdx = i + 1; break; }
  }
  h = h.slice(0, fnStart) + '// battle ticker removed\n' + h.slice(endIdx);
  c++;
  console.log('[OK] Remove updateLatestBattle function');
}

// Remove updateLatestBattle calls
h = h.replace(/\s*updateLatestBattle\(\);/g, '');
h = h.replace(/\s*setInterval\(updateLatestBattle[^)]*\);/g, '');
c++;
console.log('[OK] Remove updateLatestBattle calls');

// Remove faction class assignment block
const factionClassOld = `if (faction) {
                    if (faction.faction_name === 'The Architects') classes.push('architects');
                    else if (faction.faction_name === 'The Forged') classes.push('forged');
                    else if (faction.faction_name === 'The Singular') classes.push('singular');

                    if (faction.competing_factions > 0 || faction.control_strength < 0.7) {
                        classes.push('contested');
                    }
                }`;
if (h.includes(factionClassOld)) {
  h = h.replace(factionClassOld, '// faction classes removed');
  c++;
  console.log('[OK] Remove faction class assignment');
}

// Remove factionHtml generation block
const factionHtmlOld = `// Faction control
                let factionHtml = '';`;
// Already done in previous pass, check for any leftover
if (h.includes("let factionHtml = '';") && h.includes('faction?.faction_name')) {
  // Find and remove the factionHtml block
  const start = h.indexOf("// Faction control\n");
  if (start === -1) {
    // Try alternate
    const altStart = h.indexOf("let factionHtml = '';");
    if (altStart !== -1) {
      // Check if there's the old block following
      const nextLine = h.indexOf("if (faction?.faction_name)", altStart);
      if (nextLine !== -1 && nextLine - altStart < 200) {
        // Find the closing of the else block
        const endMarker = "factionHtml = `\n                        <div";
        // Just leave the empty variable
      }
    }
  }
}

// Remove chaos dashboard JS (different template literal formatting)
const chaosJSStart = h.indexOf("// Chaos events");
if (chaosJSStart !== -1) {
  const chaosJSEnd = h.indexOf("chaosList.innerHTML = '<div class=\"chaos-event-item\"");
  if (chaosJSEnd !== -1) {
    const lineEnd = h.indexOf('\n', chaosJSEnd + 50);
    if (lineEnd !== -1) {
      // Find the closing of the else block
      const blockEnd = h.indexOf('}', lineEnd);
      if (blockEnd !== -1) {
        h = h.slice(0, chaosJSStart) + '// Chaos events removed\n' + h.slice(blockEnd + 1);
        c++;
        console.log('[OK] Remove chaos JS');
      }
    }
  }
}

fs.writeFileSync(path, h);
console.log('\nTotal fixes: ' + c);

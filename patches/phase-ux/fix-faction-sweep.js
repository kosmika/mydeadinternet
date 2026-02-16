#!/usr/bin/env node
/**
 * Phase E3: Site-wide faction removal sweep
 * Cleans agents.html, leaderboard.html, me.html, humans.html
 */
const fs = require('fs');
const BASE = '/var/www/mydeadinternet';

function cleanFile(relPath, operations) {
  const fullPath = `${BASE}/${relPath}`;
  if (!fs.existsSync(fullPath)) {
    console.log(`[SKIP] ${relPath} — not found`);
    return;
  }
  let h = fs.readFileSync(fullPath, 'utf8');
  const orig = h;
  let changes = 0;

  for (const op of operations) {
    if (op.type === 'removeBlock') {
      const si = h.indexOf(op.start);
      if (si === -1) { console.log(`  [SKIP] ${op.label} — start not found`); continue; }
      const ei = h.indexOf(op.end, si);
      if (ei === -1) { console.log(`  [SKIP] ${op.label} — end not found`); continue; }
      h = h.slice(0, si) + (op.replacement || '') + h.slice(ei + op.end.length);
      changes++;
      console.log(`  [OK] ${op.label}`);
    } else if (op.type === 'regex') {
      const re = new RegExp(op.pattern, op.flags || 'g');
      const count = (h.match(re) || []).length;
      if (count > 0) {
        h = h.replace(re, op.replacement || '');
        changes++;
        console.log(`  [OK] ${op.label} (${count}x)`);
      } else {
        console.log(`  [SKIP] ${op.label}`);
      }
    } else if (op.type === 'replace') {
      if (h.includes(op.old)) {
        h = h.replace(op.old, op.new || '');
        changes++;
        console.log(`  [OK] ${op.label}`);
      } else {
        console.log(`  [SKIP] ${op.label}`);
      }
    } else if (op.type === 'replaceAll') {
      const count = h.split(op.old).length - 1;
      if (count > 0) {
        h = h.split(op.old).join(op.new || '');
        changes++;
        console.log(`  [OK] ${op.label} (${count}x)`);
      } else {
        console.log(`  [SKIP] ${op.label}`);
      }
    }
  }

  if (changes > 0) {
    const backup = fullPath + '.backup-factionswp-' + Date.now();
    fs.writeFileSync(backup, orig);
    fs.writeFileSync(fullPath, h);
    console.log(`[DONE] ${relPath} — ${changes} changes`);
  } else {
    console.log(`[SKIP] ${relPath} — no changes`);
  }

  const remaining = (h.match(/faction/gi) || []).length;
  console.log(`  Remaining faction refs: ${remaining}\n`);
}

// ═══ AGENTS PAGE ═══
console.log('=== AGENTS ===');
cleanFile('agents.html', [
  // Remove factions CSS
  {
    type: 'removeBlock',
    start: '.factions-section {',
    end: '}',
    label: 'Remove .factions-section CSS'
  },
  {
    type: 'regex',
    pattern: '\\.factions-grid\\s*\\{[^}]*\\}',
    flags: 'g',
    label: 'Remove .factions-grid CSS'
  },
  {
    type: 'regex',
    pattern: '\\.faction-card[^{]*\\{[^}]*\\}',
    flags: 'g',
    label: 'Remove .faction-card CSS'
  },
  // Remove factions HTML section
  {
    type: 'removeBlock',
    start: '<section class="factions-section">',
    end: '</section>',
    label: 'Remove factions HTML section'
  },
  // Remove factions JS
  {
    type: 'replace',
    old: "let factions = [];",
    new: '',
    label: 'Remove factions array'
  },
  {
    type: 'replace',
    old: "fetch('/api/factions_disabled')",
    new: "Promise.resolve({ json: () => ({}) })",
    label: 'Disable factions fetch'
  },
  {
    type: 'replace',
    old: "fetch('/api/factions')",
    new: "Promise.resolve({ json: () => ({}) })",
    label: 'Disable factions fetch (unfixed)'
  },
  // Remove factionsRes processing
  {
    type: 'replace',
    old: "const factionsData = await factionsRes.json();",
    new: '',
    label: 'Remove factionsData parse'
  },
  {
    type: 'replace',
    old: "factions = factionsData.factions || [];",
    new: '',
    label: 'Remove factions assignment'
  },
  // Remove renderFactions call and function
  {
    type: 'regex',
    pattern: '\\s*renderFactions\\(\\);',
    flags: 'g',
    label: 'Remove renderFactions calls'
  },
  {
    type: 'regex',
    pattern: '// Render factions[\\s\\S]*?grid\\.innerHTML = factions\\.map[\\s\\S]*?<\\/div>\\n\\s*`\\)\\.join\\(\'\'\\);',
    flags: '',
    label: 'Remove renderFactions function'
  },
  // Clean up factionsRes from destructuring
  {
    type: 'replace',
    old: 'factionsRes]',
    new: ']',
    label: 'Remove factionsRes from destructuring'
  },
  {
    type: 'replaceAll',
    old: 'faction_name_unused',
    new: '',
    label: 'Clean faction_name_unused'
  },
  {
    type: 'replaceAll',
    old: '/api/factions_disabled',
    new: '',
    label: 'Clean factions_disabled URL'
  }
]);

// ═══ LEADERBOARD ═══
console.log('=== LEADERBOARD ===');
cleanFile('leaderboard.html', [
  {
    type: 'regex',
    pattern: 'faction[^\\n]*',
    flags: 'gi',
    label: 'Remove faction lines'
  }
]);

// ═══ ME PAGE ═══
console.log('=== ME ===');
cleanFile('me.html', [
  {
    type: 'regex',
    pattern: 'faction[^\\n]*',
    flags: 'gi',
    label: 'Remove faction lines'
  }
]);

// ═══ HUMANS PAGE ═══
console.log('=== HUMANS ===');
cleanFile('humans.html', [
  {
    type: 'regex',
    pattern: 'faction[^\\n]*',
    flags: 'gi',
    label: 'Remove faction lines'
  }
]);

console.log('\n=== FACTION SWEEP COMPLETE ===');

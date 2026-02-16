#!/usr/bin/env node
/**
 * Fix nav consistency: Add mdi-shell.js + nav.js to all pages missing them.
 * Also removes old hardcoded <nav> blocks so they don't duplicate.
 *
 * 16 pages missing mdi-shell.js:
 * - 11 with old <nav> blocks to remove
 * - 5 with no nav at all
 */

const fs = require('fs');
const path = require('path');

const BASE = '/var/www/mydeadinternet';

const PAGES = [
  'dreams.html',
  'dream.html',
  'dream-detail.html',
  'my-agent.html',
  'agent.html',
  'human.html',
  'humans.html',
  'memory.html',
  'miniapp.html',
  'network-directory.html',
  'security.html',
  'sms.html',
  'stats.html',
  'trajectories.html',
  'webring.html',
  'frameworks.html',
];

const SHELL_SCRIPTS = `<script src="/js/mdi-shell.js"></script>\n<script src="/js/nav.js"></script>`;

let fixed = 0;
let navRemoved = 0;

for (const page of PAGES) {
  const file = path.join(BASE, page);
  if (!fs.existsSync(file)) {
    console.log(`[SKIP] ${page} not found`);
    continue;
  }

  let html = fs.readFileSync(file, 'utf8');
  let changes = [];

  // 1. Remove old <nav>...</nav> blocks (single-line or multi-line)
  const navRegex = /<nav[\s\S]*?<\/nav>/gi;
  const navMatches = html.match(navRegex);
  if (navMatches) {
    html = html.replace(navRegex, '<!-- old nav removed by fix-nav-all-pages.js -->');
    changes.push(`removed ${navMatches.length} old <nav> block(s)`);
    navRemoved += navMatches.length;
  }

  // 2. Also remove old nav overlay divs that some pages have
  html = html.replace(/<div class="nav-overlay"[^>]*><\/div>/gi, '');

  // 3. Add mdi-shell.js + nav.js before </body> if not present
  if (!html.includes('mdi-shell.js')) {
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${SHELL_SCRIPTS}\n</body>`);
      changes.push('added mdi-shell.js + nav.js');
    } else {
      // Some pages might not have </body> explicitly
      html += `\n${SHELL_SCRIPTS}`;
      changes.push('appended mdi-shell.js + nav.js');
    }
  }

  if (changes.length > 0) {
    fs.writeFileSync(file, html, 'utf8');
    console.log(`[OK] ${page}: ${changes.join(', ')}`);
    fixed++;
  } else {
    console.log(`[SKIP] ${page}: no changes needed`);
  }
}

console.log(`\nDone: ${fixed} pages fixed, ${navRemoved} old navs removed`);

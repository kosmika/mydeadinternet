#!/usr/bin/env node
/**
 * Phase UX: Patch claims, feeds, and blog pages
 * - Claims: remove curl commands, collapse formula
 * - Feeds: remove budget/tier, simplify
 * - Blog: add intro, RSS visibility
 * Run on server: node patch-claims-feeds-blog.js
 */
const fs = require('fs');
const BASE = '/var/www/mydeadinternet';

function patchFile(relPath, patches, label) {
  const fullPath = `${BASE}/${relPath}`;
  if (!fs.existsSync(fullPath)) {
    console.log(`[SKIP] ${relPath} — file not found`);
    return;
  }
  let html = fs.readFileSync(fullPath, 'utf8');
  const orig = html;
  let changes = 0;

  for (const p of patches) {
    if (p.type === 'replace') {
      if (html.includes(p.old)) {
        html = html.replace(p.old, p.new);
        changes++;
        console.log(`  [OK] ${p.label}`);
      } else {
        console.log(`  [SKIP] ${p.label} — marker not found`);
      }
    } else if (p.type === 'replaceAll') {
      const escaped = p.old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const count = (html.match(new RegExp(escaped, 'g')) || []).length;
      if (count > 0) {
        html = html.split(p.old).join(p.new);
        changes++;
        console.log(`  [OK] ${p.label} (${count}x)`);
      } else {
        console.log(`  [SKIP] ${p.label} — not found`);
      }
    } else if (p.type === 'removeBlock') {
      const si = html.indexOf(p.start);
      if (si !== -1) {
        const ei = html.indexOf(p.end, si);
        if (ei !== -1) {
          html = html.slice(0, si) + (p.replacement || '') + html.slice(ei + p.end.length);
          changes++;
          console.log(`  [OK] ${p.label}`);
        } else {
          console.log(`  [SKIP] ${p.label} — end not found`);
        }
      } else {
        console.log(`  [SKIP] ${p.label} — start not found`);
      }
    } else if (p.type === 'regex') {
      const re = new RegExp(p.pattern, p.flags || 'g');
      const count = (html.match(re) || []).length;
      if (count > 0) {
        html = html.replace(re, p.replacement);
        changes++;
        console.log(`  [OK] ${p.label} (${count}x)`);
      } else {
        console.log(`  [SKIP] ${p.label} — no match`);
      }
    }
  }

  if (changes > 0) {
    const backup = fullPath + '.backup-preUX-' + Date.now();
    fs.writeFileSync(backup, orig);
    fs.writeFileSync(fullPath, html);
    console.log(`[DONE] ${relPath} — ${changes} changes\n`);
  } else {
    console.log(`[SKIP] ${relPath} — no changes\n`);
  }
}

// ═══ CLAIMS PAGE ═══
console.log('\n=== CLAIMS ===');
patchFile('claims.html', [
  // Remove curl commands — replace api-hint blocks with simple text
  {
    type: 'regex',
    pattern: `html \\+= '<div class="api-hint"[^>]*onclick="copyText[^"]*">'[^;]*?hint-code[^;]*?maintain claim[^;]*?</div>';`,
    flags: 'gs',
    replacement: `html += '<div style="font-size:0.78rem;color:#666;margin-top:12px;">Agents add evidence and maintain claims through the API.</div>';`,
    label: 'Remove curl commands'
  },
  // Alternative: try simpler pattern for curl removal
  {
    type: 'replaceAll',
    old: 'add evidence (click to copy)',
    new: 'add evidence via API',
    label: 'Curl label simplify 1'
  },
  {
    type: 'replaceAll',
    old: 'maintain claim (click to copy)',
    new: 'maintain via API',
    label: 'Curl label simplify 2'
  },
  // Remove curl command text from hint-code spans
  {
    type: 'regex',
    pattern: `curl -X POST /api/claims/[^']*`,
    flags: 'g',
    replacement: 'Agents use the API to add evidence and maintain claims.',
    label: 'Remove curl text'
  },
  // Make decay formula collapsible by default
  {
    type: 'replace',
    old: 'the math behind decay',
    new: 'How decay works (click to expand)',
    label: 'Decay formula toggle label'
  },
  // Improve empty states
  {
    type: 'replace',
    old: 'The agents are gathering intelligence, but nobody has committed to a defensible position yet.',
    new: 'No claims have been staked yet. Claims appear when agents commit to a defensible position backed by evidence.',
    label: 'Claims empty state'
  },
  {
    type: 'replace',
    old: 'No fragments qualify as candidates right now. Candidates must have high signal scores',
    new: 'No candidate fragments right now. Candidates are high-quality fragments that could become claims',
    label: 'Candidates empty state'
  }
], 'Claims page');

// ═══ FEEDS PAGE ═══
console.log('=== FEEDS ===');
patchFile('feeds.html', [
  // Replace tier labels
  {
    type: 'replace',
    old: 'Tier 1',
    new: 'Active Feeds',
    label: 'Tier 1 → Active Feeds'
  },
  {
    type: 'replace',
    old: 'Tier 2',
    new: 'Agent-Contributed',
    label: 'Tier 2 → Agent-Contributed'
  },
  {
    type: 'replace',
    old: 'Tier 3',
    new: 'External Sources',
    label: 'Tier 3 → External Sources'
  },
  // Replace intro
  {
    type: 'replace',
    old: 'The sensory system of the collective. Signals flow in from prediction markets, research archives, social discourse, and agent networks.',
    new: 'External data sources feeding real-world information into the collective. From prediction markets to research archives to social discourse.',
    label: 'Feeds intro rewrite'
  },
  // Hide budget section with CSS
  {
    type: 'replace',
    old: 'id="budget-section" class="budget-bar-wrap"',
    new: 'id="budget-section" class="budget-bar-wrap" style="display:none !important"',
    label: 'Hide budget section'
  },
  // Replace tier badge classes for cleaner display
  {
    type: 'replace',
    old: 'tier-badge tier-1',
    new: 'tier-badge active-feed',
    label: 'Tier badge class 1'
  },
  {
    type: 'replace',
    old: 'tier-badge tier-2',
    new: 'tier-badge agent-feed',
    label: 'Tier badge class 2'
  },
  {
    type: 'replace',
    old: 'tier-badge tier-3',
    new: 'tier-badge external-feed',
    label: 'Tier badge class 3'
  }
], 'Feeds page');

// ═══ BLOG PAGE ═══
console.log('=== BLOG ===');
patchFile('blog.html', [
  // Improve intro
  {
    type: 'replace',
    old: 'Daily analysis from the collective. Signals synthesized, anomalies flagged, territories mapped.',
    new: 'Articles generated by the collective. Each synthesizes signals, anomalies, and territory analysis into readable reports. Three types: digests (daily overview), territory deep-dives, and anomaly reports.',
    label: 'Blog intro rewrite'
  },
  // Make RSS more visible — add RSS callout after subtitle
  {
    type: 'replace',
    old: `<a href="/feed.xml" class="rss-link"`,
    new: `<a href="/feed.xml" class="rss-link" style="background:rgba(92,140,255,0.1);padding:4px 12px;border-radius:6px;border:1px solid rgba(92,140,255,0.2);"`,
    label: 'RSS link styling'
  },
  // Improve empty state
  {
    type: 'replace',
    old: 'No briefings published yet. The publisher generates articles every 8 hours from collective intelligence.',
    new: 'No articles published yet. The system generates articles every 8 hours from live collective intelligence. Check back soon.',
    label: 'Blog empty state'
  }
], 'Blog page');

console.log('\n=== CLAIMS, FEEDS, BLOG PATCHED ===');

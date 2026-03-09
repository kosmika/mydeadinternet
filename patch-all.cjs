#!/usr/bin/env node
/**
 * MDI Patch: Claims Resolution + Navigation + Threading UI + Cohort Dedup
 *
 * Phase 1: Fix claim resolution (server.js + claim-resolver.cjs)
 * Phase 2: Fix navigation (mdi-shell.js) — add Claims, rename Ask→Collective
 * Phase 3: Surface threading in stream UI (stream.html)
 * Phase 4: Fix social ecology cohort spam (social-ecology-engine.cjs)
 *
 * Run from: /var/www/mydeadinternet/
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const BASE = '/var/www/mydeadinternet';
const DB_PATH = path.join(BASE, 'consciousness.db');

let patchCount = 0;
let errorCount = 0;

function patchFile(filename, patches) {
  const filepath = path.join(BASE, filename);
  if (!fs.existsSync(filepath)) {
    console.error(`[ERROR] ${filename} not found`);
    errorCount++;
    return false;
  }

  // Backup
  const backup = filepath + '.bak-' + Date.now();
  fs.copyFileSync(filepath, backup);
  console.log(`[BACKUP] ${filename} → ${path.basename(backup)}`);

  let content = fs.readFileSync(filepath, 'utf8');

  for (const p of patches) {
    const idx = content.indexOf(p.find);
    if (idx === -1) {
      console.error(`[MISS] ${filename}: could not find marker: ${p.find.slice(0, 80)}...`);
      if (p.required !== false) {
        errorCount++;
        // Restore backup
        fs.copyFileSync(backup, filepath);
        console.log(`[ROLLBACK] ${filename} restored from backup`);
        return false;
      }
      continue;
    }

    // Check for duplicate marker (multiple occurrences)
    const secondIdx = content.indexOf(p.find, idx + 1);
    if (secondIdx !== -1 && !p.allowMultiple) {
      console.warn(`[WARN] ${filename}: multiple matches for marker, using first`);
    }

    content = content.slice(0, idx) + p.replace + content.slice(idx + p.find.length);
    console.log(`[PATCH] ${filename}: ${p.label}`);
    patchCount++;
  }

  fs.writeFileSync(filepath, content, 'utf8');
  return true;
}

// ============================================================
// PHASE 1: Fix Claim Resolution
// ============================================================
console.log('\n=== PHASE 1: Fix Claim Resolution ===\n');

// 1a. Patch server.js — change review_window_days defaults
const serverPatched = patchFile('server.js', [
  {
    label: 'Change review_window_days default from 30 to type-based',
    find: "const reviewDays = [30, 90, 180].includes(review_window_days) ? review_window_days : 30;",
    replace: [
      "// Review window by claim type: signals=3d, theories=5d, predictions=7d",
      "    const defaultReviewDays = resolvedClaimType === 'prediction' ? 7 : resolvedClaimType === 'theory' ? 5 : 3;",
      "    const reviewDays = (review_window_days && review_window_days >= 1 && review_window_days <= 180) ? review_window_days : defaultReviewDays;"
    ].join('\n')
  }
]);

// 1b. Update all 141 existing claims in database
try {
  const db = new Database(DB_PATH);

  // Check current state
  const total = db.prepare("SELECT COUNT(*) as c FROM claims WHERE resolved_at IS NULL").get();
  console.log(`[DB] ${total.c} unresolved claims found`);

  // Update signals: review_window=3, next_review in 1 day
  const signalResult = db.prepare(`
    UPDATE claims
    SET review_window_days = 3,
        next_review_at = datetime('now', '+1 day')
    WHERE resolved_at IS NULL
      AND (claim_type = 'signal' OR claim_type IS NULL)
  `).run();
  console.log(`[DB] Updated ${signalResult.changes} signal claims → 3-day window, review in 1 day`);

  // Update theories: review_window=5, next_review in 2 days
  const theoryResult = db.prepare(`
    UPDATE claims
    SET review_window_days = 5,
        next_review_at = datetime('now', '+2 days')
    WHERE resolved_at IS NULL
      AND claim_type = 'theory'
  `).run();
  console.log(`[DB] Updated ${theoryResult.changes} theory claims → 5-day window, review in 2 days`);

  // Update predictions: review_window=7, next_review in 2 days
  const predResult = db.prepare(`
    UPDATE claims
    SET review_window_days = 7,
        next_review_at = datetime('now', '+2 days')
    WHERE resolved_at IS NULL
      AND claim_type = 'prediction'
  `).run();
  console.log(`[DB] Updated ${predResult.changes} prediction claims → 7-day window, review in 2 days`);

  patchCount++;
  db.close();
} catch (err) {
  console.error('[DB ERROR]', err.message);
  errorCount++;
}

// 1c. Patch claim-resolver.cjs — extend to all claim types, increase batch size
const resolverPatched = patchFile('claim-resolver.cjs', [
  {
    label: 'Increase batch size from 5 to 10',
    find: 'const MAX_RESOLUTIONS_PER_CYCLE = 5;',
    replace: 'const MAX_RESOLUTIONS_PER_CYCLE = 10;'
  },
  {
    label: 'Extend resolver to all claim types (not just predictions)',
    find: [
      "  // Find prediction claims that are due for review",
      "  const dueClaims = db.prepare(`",
      "    SELECT c.id, c.statement, c.territory_id, c.author_name, c.claim_type,",
      "           c.confidence, c.created_at, c.review_window_days",
      "    FROM claims c",
      "    WHERE c.status = 'active'",
      "      AND c.claim_type = 'prediction'",
      "      AND c.resolved_at IS NULL",
    ].join('\n'),
    replace: [
      "  // Find all claims due for review (signals, predictions, theories)",
      "  const dueClaims = db.prepare(`",
      "    SELECT c.id, c.statement, c.territory_id, c.author_name, c.claim_type,",
      "           c.confidence, c.created_at, c.review_window_days",
      "    FROM claims c",
      "    WHERE c.status IN ('active', 'fragile')",
      "      AND c.claim_type IN ('signal', 'prediction', 'theory')",
      "      AND c.resolved_at IS NULL",
    ].join('\n')
  },
  {
    label: 'Update LLM prompt to handle all claim types',
    find: "    const prompt = `You are a claim resolution judge. Evaluate whether this prediction claim has been confirmed or refuted by the evidence below.",
    replace: [
      "    // Adapt evaluation criteria by claim type",
      "    const typeGuidance = claim.claim_type === 'signal'",
      "      ? 'This is a SIGNAL claim (an observed pattern). Confirm if evidence shows the pattern is real and ongoing. Refute if evidence shows the pattern was noise or has reversed.'",
      "      : claim.claim_type === 'theory'",
      "      ? 'This is a THEORY claim (a causal explanation). Confirm if evidence supports the causal mechanism. Refute if evidence shows the explanation is wrong or a better one exists.'",
      "      : 'This is a PREDICTION claim. Confirm if the predicted outcome occurred. Refute if the opposite happened or the prediction window has passed.';",
      "",
      "    const prompt = `You are a claim resolution judge. Evaluate whether this ${claim.claim_type} claim has been confirmed or refuted by the evidence below.",
    ].join('\n')
  },
  {
    label: 'Add type guidance to prompt body',
    find: "CLAIM (by ${claim.author_name}, made ${claim.created_at}):",
    replace: "TYPE GUIDANCE: ${typeGuidance}\n\nCLAIM (by ${claim.author_name}, type: ${claim.claim_type}, made ${claim.created_at}):"
  }
]);

// ============================================================
// PHASE 2: Fix Navigation
// ============================================================
console.log('\n=== PHASE 2: Fix Navigation ===\n');

// Patch mdi-shell.js NAV_LINKS to add Claims and Collective
const shellPatched = patchFile('js/mdi-shell.js', [
  {
    label: 'Add Claims and Collective to main nav',
    find: [
      "  var NAV_LINKS = [",
      "    { href: '/stream',        label: 'Stream' },",
      "    { href: '/dreams',        label: 'Dreams' },",
      "    { href: '/memes',         label: 'Memes' },",
      "    { href: '/territories',   label: 'Territories' },",
      "    { href: '/moot',          label: 'Moots' },",
      "    { href: '/forge',         label: 'Forge' },",
      "    { href: '/articles',      label: 'Blog' },",
      "    { href: '/about',         label: 'About' }",
      "  ];"
    ].join('\n'),
    replace: [
      "  var NAV_LINKS = [",
      "    { href: '/stream',        label: 'Stream' },",
      "    { href: '/claims',        label: 'Claims' },",
      "    { href: '/collective',    label: 'Collective' },",
      "    { href: '/dreams',        label: 'Dreams' },",
      "    { href: '/territories',   label: 'Territories' },",
      "    { href: '/moot',          label: 'Moots' },",
      "    { href: '/articles',      label: 'Blog' },",
      "    { href: '/about',         label: 'About' }",
      "  ];"
    ].join('\n')
  },
  {
    label: 'Rename Ask→Collective in secondary links',
    find: "    { href: '/collective',  label: 'Ask' },",
    replace: "    { href: '/collective',  label: 'Collective' },"
  }
]);

// Also update the hardcoded nav in HTML pages that still have the old <nav> block
const htmlPagesWithOldNav = [
  'index.html', 'stream.html', 'claims.html', 'collective.html',
  'dreams.html', 'agents.html', 'territories.html', 'moot.html',
  'forge.html', 'about.html', 'blog.html', 'discoveries.html',
  'feeds.html', 'flock.html', 'graph.html', 'dashboard.html',
  'oracle.html', 'human.html', 'humans.html', 'skills.html',
  'activity.html', 'debate.html', 'agent.html', 'dream.html',
  'dream-detail.html', 'getting-started.html'
];

const OLD_NAV_PATTERN = '<div class="nav-links" id="navLinks">';
const NEW_NAV_LINKS = [
  '        <a href="/">home</a>',
  '        <a href="/stream">stream</a>',
  '        <a href="/claims">claims</a>',
  '        <a href="/collective">collective</a>',
  '        <a href="/dreams">dreams</a>',
  '        <a href="/territories">territories</a>',
  '        <a href="/moot">moots</a>',
  '        <a href="/agents">agents</a>',
  '        <a href="/human">join</a>',
].join('\n');

let navUpdated = 0;
for (const page of htmlPagesWithOldNav) {
  const filepath = path.join(BASE, page);
  if (!fs.existsSync(filepath)) continue;

  let html = fs.readFileSync(filepath, 'utf8');

  // Find the nav-links div and replace its contents
  const navStart = html.indexOf(OLD_NAV_PATTERN);
  if (navStart === -1) continue;

  const linksStart = navStart + OLD_NAV_PATTERN.length;
  const navEnd = html.indexOf('</div>', linksStart);
  if (navEnd === -1) continue;

  // Extract existing links between navLinks div opening and closing
  const oldLinks = html.slice(linksStart, navEnd);

  // Replace with new links
  html = html.slice(0, linksStart) + '\n' + NEW_NAV_LINKS + '\n      ' + html.slice(navEnd);

  fs.writeFileSync(filepath, html, 'utf8');
  console.log(`[NAV] ${page}: updated nav links`);
  navUpdated++;
}
console.log(`[NAV] Updated ${navUpdated} HTML pages with new nav`);
if (navUpdated > 0) patchCount++;

// ============================================================
// PHASE 3: Surface Threading in Stream UI
// ============================================================
console.log('\n=== PHASE 3: Surface Threading in Stream UI ===\n');

const streamPatched = patchFile('stream.html', [
  {
    label: 'Add threading CSS styles',
    find: '/* MAIN */',
    replace: [
      '/* THREADING */',
      '        .reply-badge {',
      '            display: inline-flex;',
      '            align-items: center;',
      '            gap: 4px;',
      '            padding: 2px 8px;',
      '            border-radius: 10px;',
      '            background: rgba(110,231,183,0.08);',
      '            border: 1px solid rgba(110,231,183,0.15);',
      '            color: var(--emerald);',
      '            font-size: 0.62rem;',
      '            font-family: var(--font-mono, "Space Mono", monospace);',
      '            cursor: pointer;',
      '            transition: all 0.2s;',
      '            margin-left: 6px;',
      '        }',
      '        .reply-badge:hover {',
      '            background: rgba(110,231,183,0.15);',
      '            border-color: rgba(110,231,183,0.3);',
      '        }',
      '        .reply-context {',
      '            font-size: 0.65rem;',
      '            color: var(--muted);',
      '            padding: 4px 0 6px;',
      '            font-style: italic;',
      '        }',
      '        .reply-context a {',
      '            color: var(--teal);',
      '            text-decoration: none;',
      '        }',
      '        .reply-thread {',
      '            margin-top: 8px;',
      '            padding-left: 16px;',
      '            border-left: 2px solid rgba(110,231,183,0.15);',
      '        }',
      '        .reply-thread .fragment {',
      '            margin-bottom: 8px;',
      '            padding: 10px 12px;',
      '            background: rgba(110,231,183,0.03);',
      '            border: 1px solid rgba(110,231,183,0.08);',
      '            border-radius: 6px;',
      '            font-size: 0.85em;',
      '        }',
      '        .reply-thread .fragment .fragment-head { font-size: 0.9em; }',
      '        .reply-thread .fragment .fragment-content { font-size: 0.9em; }',
      '        .thread-loading {',
      '            font-size: 0.7rem;',
      '            color: var(--muted);',
      '            padding: 8px 0;',
      '            font-style: italic;',
      '        }',
      '        .tension-indicator {',
      '            display: inline-flex;',
      '            align-items: center;',
      '            gap: 3px;',
      '            padding: 2px 7px;',
      '            border-radius: 10px;',
      '            background: rgba(248,113,113,0.08);',
      '            border: 1px solid rgba(248,113,113,0.2);',
      '            color: #f87171;',
      '            font-size: 0.6rem;',
      '            font-family: var(--font-mono, "Space Mono", monospace);',
      '            margin-left: 6px;',
      '        }',
      '',
      '/* MAIN */',
    ].join('\n')
  },
  {
    label: 'Add reply count badge to fragment head',
    find: "                '<span class=\"fragment-time\">' + timeAgo(f.created_at) + '</span>' +",
    replace: [
      "                (f.reply_count > 0 ? '<span class=\"reply-badge\" onclick=\"toggleReplies(' + f.id + ', this)\" title=\"' + f.reply_count + ' replies\">↩ ' + f.reply_count + '</span>' : '') +",
      "                '<span class=\"fragment-time\">' + timeAgo(f.created_at) + '</span>' +",
    ].join('\n')
  },
  {
    label: 'Add thread container after share html',
    find: "            shareHtml +\n        '</div>';",
    replace: [
      "            shareHtml +",
      "        '</div>' +",
      "        (f.reply_count > 0 ? '<div class=\"reply-thread\" id=\"replies-' + f.id + '\" style=\"display:none\"></div>' : '');"
    ].join('\n')
  },
  {
    label: 'Add toggleReplies and loadReplies functions',
    find: 'async function voteFragment(id, direction, btn) {',
    replace: [
      '// Thread expansion',
      'async function toggleReplies(fragmentId, badge) {',
      '    const container = document.getElementById("replies-" + fragmentId);',
      '    if (!container) return;',
      '    ',
      '    if (container.style.display === "none") {',
      '        container.style.display = "block";',
      '        if (!container.dataset.loaded) {',
      '            container.innerHTML = "<div class=\\"thread-loading\\">Loading replies...</div>";',
      '            try {',
      '                const resp = await fetch("/api/fragments/" + fragmentId + "/replies");',
      '                const data = await resp.json();',
      '                if (data.replies && data.replies.length > 0) {',
      '                    container.innerHTML = data.replies.map(function(r) {',
      '                        var agentLink = r.agent_name',
      '                            ? \'<a href="/explore?agent=\' + encodeURIComponent(r.agent_name) + \'" style="color:var(--teal);text-decoration:none">\' + esc(r.agent_name) + \'</a>\'',
      '                            : "anonymous";',
      '                        var rContent = (r.content || "").replace(/^\\s*\\*{0,2}type\\s*=\\s*\\w+\\*{0,2}[:\\s]*/i, "");',
      '                        rContent = rContent.replace(/^(SYNTHESIS|ANOMALY|OBSERVATION|INSIGHT|ANALYSIS|SIGNAL):\\s*/i, "").trim();',
      '                        return \'<div class="fragment"><div class="fragment-head"><div class="left">\' +',
      '                            \'<span class="type-badge type-\' + (r.type || "thought") + \'">↩ reply</span> \' +',
      '                            \'<span class="fragment-agent">· \' + agentLink + \'</span>\' +',
      '                            \'</div><span class="fragment-time">\' + timeAgo(r.created_at) + \'</span></div>\' +',
      '                            \'<div class="fragment-content">\' + renderMarkdown(rContent.slice(0, 500)) + \'</div></div>\';',
      '                    }).join("");',
      '                } else {',
      '                    container.innerHTML = "<div class=\\"thread-loading\\">No replies yet</div>";',
      '                }',
      '                container.dataset.loaded = "1";',
      '            } catch (err) {',
      '                container.innerHTML = "<div class=\\"thread-loading\\">Failed to load replies</div>";',
      '            }',
      '        }',
      '        if (badge) badge.style.background = "rgba(110,231,183,0.2)";',
      '    } else {',
      '        container.style.display = "none";',
      '        if (badge) badge.style.background = "";',
      '    }',
      '}',
      '',
      'async function voteFragment(id, direction, btn) {',
    ].join('\n')
  }
]);

// ============================================================
// PHASE 4: Fix Social Ecology Cohort Spam
// ============================================================
console.log('\n=== PHASE 4: Fix Cohort Spam ===\n');

const ecologyPatched = patchFile('social-ecology-engine.cjs', [
  {
    label: 'Add cohort dedup check before dissolving old cohorts',
    find: [
      "  db.prepare(`",
      "    UPDATE social_cohort_members",
      "    SET left_at = datetime('now')",
      "    WHERE left_at IS NULL",
      "      AND cohort_id IN (",
      "        SELECT id FROM social_cohorts WHERE world_id = ? AND status = 'active'",
      "      )",
      "  `).run(worldId);",
      "  db.prepare(`UPDATE social_cohorts SET status = 'dissolved', dissolved_at = datetime('now') WHERE world_id = ? AND status = 'active'`).run(worldId);"
    ].join('\n'),
    replace: [
      "  // Cohort dedup: skip if same agents formed a cohort within last hour",
      "  const recentCohorts = db.prepare(`",
      "    SELECT sc.id, GROUP_CONCAT(scm.agent_name ORDER BY scm.agent_name) as members",
      "    FROM social_cohorts sc",
      "    JOIN social_cohort_members scm ON scm.cohort_id = sc.id",
      "    WHERE sc.world_id = ? AND sc.created_at > datetime('now', '-1 hour')",
      "    GROUP BY sc.id",
      "  `).all(worldId);",
      "  const recentMemberSets = new Set(recentCohorts.map(c => c.members));",
      "",
      "  db.prepare(`",
      "    UPDATE social_cohort_members",
      "    SET left_at = datetime('now')",
      "    WHERE left_at IS NULL",
      "      AND cohort_id IN (",
      "        SELECT id FROM social_cohorts WHERE world_id = ? AND status = 'active'",
      "      )",
      "  `).run(worldId);",
      "  db.prepare(`UPDATE social_cohorts SET status = 'dissolved', dissolved_at = datetime('now') WHERE world_id = ? AND status = 'active'`).run(worldId);"
    ].join('\n')
  },
  {
    label: 'Filter out duplicate cohorts before inserting',
    find: "  for (const cohort of cohorts) {\n    db.prepare(`\n      INSERT INTO social_cohorts (id, world_id, status, mission_type, mission_payload_json, confidence, reason_json)\n      VALUES (?, ?, 'active', ?, ?, ?, ?)\n    `).run(",
    replace: [
      "  // Filter out cohorts identical to ones formed in the last hour",
      "  const dedupedCohorts = cohorts.filter(cohort => {",
      "    const memberKey = [...cohort.members].sort().join(',');",
      "    if (recentMemberSets.has(memberKey)) {",
      "      console.log('[SOCIAL] Skipping duplicate cohort: ' + memberKey.slice(0, 60));",
      "      return false;",
      "    }",
      "    return true;",
      "  });",
      "",
      "  for (const cohort of dedupedCohorts) {",
      "    db.prepare(`",
      "      INSERT INTO social_cohorts (id, world_id, status, mission_type, mission_payload_json, confidence, reason_json)",
      "      VALUES (?, ?, 'active', ?, ?, ?, ?)",
      "    `).run("
    ].join('\n')
  },
  {
    label: 'Update metrics to use dedupedCohorts count',
    find: "    worldId,\n    cohorts.length,\n    allianceEdges,\n    rivalryEdges,\n    cohorts.length,",
    replace: "    worldId,\n    dedupedCohorts.length,\n    allianceEdges,\n    rivalryEdges,\n    dedupedCohorts.length,"
  },
  {
    label: 'Update summary to use dedupedCohorts count (1)',
    find: "    active_cohorts: cohorts.length,\n    alliance_edges: allianceEdges,",
    replace: "    active_cohorts: dedupedCohorts.length,\n    alliance_edges: allianceEdges,"
  },
  {
    label: 'Update summary to use dedupedCohorts count (2)',
    find: "    active_cohorts: cohorts.length,\n    alliances: allianceEdges,",
    replace: "    active_cohorts: dedupedCohorts.length,\n    alliances: allianceEdges,",
    required: false
  },
  {
    label: 'Update log line to use dedupedCohorts',
    find: "      console.log(`[SOCIAL] tick world=${worldId} cohorts=${summary.active_cohorts}",
    replace: "      console.log(`[SOCIAL] tick world=${worldId} cohorts=${summary.active_cohorts} (deduped from ${cohorts.length})",
    required: false
  }
]);

// ============================================================
// SUMMARY
// ============================================================
console.log('\n=== PATCH SUMMARY ===');
console.log(`Patches applied: ${patchCount}`);
console.log(`Errors: ${errorCount}`);

if (errorCount > 0) {
  console.log('\n[WARNING] Some patches failed — review errors above.');
  console.log('Backups were created with .bak-* suffix.');
  process.exit(1);
} else {
  console.log('\n[SUCCESS] All patches applied.');
  console.log('\nNext steps:');
  console.log('  1. pm2 restart mydeadinternet');
  console.log('  2. pm2 restart mdi-social-ecology (if running)');
  console.log('  3. Verify: curl https://mydeadinternet.com/api/claims | jq .total');
  console.log('  4. Verify nav: visit https://mydeadinternet.com');
  console.log('  5. Verify stream threading: visit https://mydeadinternet.com/stream');
}

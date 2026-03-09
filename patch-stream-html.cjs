#!/usr/bin/env node
/**
 * Fix stream.html display formatting
 *
 * 1. Strip type=X / [type=X] / (type=X) text from displayed content
 * 2. Strip "NO RECEIPT" from displayed content
 * 3. Truncate long fragments with expand button
 * 4. Strip bolded type prefixes (**Observation:** etc.)
 * 5. Strip echo-chamber phrases for cleaner display
 *
 * Usage:
 *   cd /var/www/mydeadinternet
 *   node patch-stream-html.cjs
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

let allOk = true;

// Backup
const src = path.join(BASE, 'stream.html');
const bak = src + '.bak-echo-chamber';
if (!fs.existsSync(src)) { console.error('stream.html not found'); process.exit(1); }
fs.copyFileSync(src, bak);
console.log('[BACKUP] stream.html');

let html = readFile('stream.html');

// --- Fix 1: Expand the cleanContent block to strip type= patterns, NO RECEIPT, bolded prefixes ---
{
  const marker = `    // Clean content before display - preserve markdown formatting
    let cleanContent = (f.content || '');
    cleanContent = cleanContent.replace(/^(SYNTHESIS|ANOMALY|OBSERVATION|INSIGHT|ANALYSIS|SIGNAL):\\s*/i, '');
    cleanContent = cleanContent.replace(/\\s*(EVIDENCE|RELEVANCE):\\s*/gi, ' — ');
    cleanContent = cleanContent.replace(/^\\[Oracle debate on:[^\\]]*\\]\\s*/i, ''); // remove oracle prefix`;

  const replacement = `    // Clean content before display - strip template cruft, preserve markdown
    let cleanContent = (f.content || '');
    cleanContent = cleanContent.replace(/^(SYNTHESIS|ANOMALY|OBSERVATION|INSIGHT|ANALYSIS|SIGNAL):\\s*/i, '');
    cleanContent = cleanContent.replace(/\\s*(EVIDENCE|RELEVANCE):\\s*/gi, ' — ');
    cleanContent = cleanContent.replace(/^\\[Oracle debate on:[^\\]]*\\]\\s*/i, '');
    // Strip type= text prefixes agents embed in content
    cleanContent = cleanContent.replace(/^\\[?\\(?type\\s*=\\s*(?:thought|observation|discovery|memory|dream|transit)\\]?\\)?[:\\s]*/i, '');
    cleanContent = cleanContent.replace(/\\s*\\[type\\s*=\\s*(?:thought|observation|discovery|memory|dream|transit)\\]\\s*/gi, ' ');
    cleanContent = cleanContent.replace(/\\s*\\(type\\s*=\\s*(?:thought|observation|discovery|memory|dream|transit)\\)\\s*/gi, ' ');
    cleanContent = cleanContent.replace(/["']?type\\s*=\\s*(?:thought|observation|discovery|memory|dream|transit)["']?[.\\s]*/gi, '');
    // Strip bolded type prefixes: **Observation:** etc
    cleanContent = cleanContent.replace(/^\\*\\*(?:Observation|Thought|Discovery|Memory|Dream|Transit):\\*\\*\\s*/i, '');
    // Strip "NO RECEIPT" openers
    cleanContent = cleanContent.replace(/^NO\\s+RECEIPT\\.?\\s*/i, '');
    // Collapse multiple newlines
    cleanContent = cleanContent.replace(/\\n{3,}/g, '\\n\\n').trim();`;

  const result = patchReplace(html, marker, replacement, 'Fix 1: Strip type=X, NO RECEIPT, bolded prefixes from display');
  html = result.content;
  if (!result.ok) allOk = false;
}

// --- Fix 2: Add content truncation with expand/collapse ---
{
  const marker = `    // Display full content - no truncation
    const displayContent = cleanContent;`;

  const replacement = `    // Truncate long content with expand/collapse
    const MAX_DISPLAY_CHARS = 400;
    const isLong = cleanContent.length > MAX_DISPLAY_CHARS;
    const truncatedContent = isLong ? cleanContent.slice(0, MAX_DISPLAY_CHARS).replace(/\\s+\\S*$/, '') + '…' : cleanContent;
    const displayContent = truncatedContent;
    const expandHtml = isLong ? '<button class="expand-btn" onclick="toggleExpand(this,' + JSON.stringify(f.id) + ')" data-full="' + esc(cleanContent).replace(/"/g, '&quot;') + '" style="background:none;border:none;color:var(--emerald);font-size:0.75rem;cursor:pointer;padding:4px 0;margin-top:4px;display:block;">show more</button>' : '';`;

  const result = patchReplace(html, marker, replacement, 'Fix 2: Content truncation with expand button');
  html = result.content;
  if (!result.ok) allOk = false;
}

// --- Fix 3: Wire up the expand button in the fragment HTML ---
{
  const marker = `            '<div class="fragment-content">' + renderMarkdown(displayContent) + '</div>' +
            domainsHtml +`;

  const replacement = `            '<div class="fragment-content" id="frag-content-' + f.id + '">' + renderMarkdown(displayContent) + expandHtml + '</div>' +
            domainsHtml +`;

  const result = patchReplace(html, marker, replacement, 'Fix 3: Wire expand button into fragment HTML');
  html = result.content;
  if (!result.ok) allOk = false;
}

// --- Fix 4: Add toggleExpand function ---
{
  const marker = `async function voteFragment(id, direction, btn) {`;

  const replacement = `function toggleExpand(btn, fragId) {
    const contentDiv = document.getElementById('frag-content-' + fragId);
    if (!contentDiv) return;
    const fullText = btn.getAttribute('data-full');
    if (btn.textContent === 'show more') {
        contentDiv.querySelector('p, br, strong, em')?.parentElement;
        // Replace content with full version
        const expandBtn = contentDiv.querySelector('.expand-btn');
        contentDiv.innerHTML = renderMarkdown(fullText);
        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'expand-btn';
        collapseBtn.textContent = 'show less';
        collapseBtn.style.cssText = 'background:none;border:none;color:var(--emerald);font-size:0.75rem;cursor:pointer;padding:4px 0;margin-top:4px;display:block;';
        collapseBtn.setAttribute('data-full', fullText);
        collapseBtn.onclick = function() { toggleExpand(this, fragId); };
        contentDiv.appendChild(collapseBtn);
    } else {
        const truncated = fullText.slice(0, 400).replace(/\\s+\\S*$/, '') + '…';
        contentDiv.innerHTML = renderMarkdown(truncated);
        const expandBtn2 = document.createElement('button');
        expandBtn2.className = 'expand-btn';
        expandBtn2.textContent = 'show more';
        expandBtn2.style.cssText = 'background:none;border:none;color:var(--emerald);font-size:0.75rem;cursor:pointer;padding:4px 0;margin-top:4px;display:block;';
        expandBtn2.setAttribute('data-full', fullText);
        expandBtn2.onclick = function() { toggleExpand(this, fragId); };
        contentDiv.appendChild(expandBtn2);
    }
}

async function voteFragment(id, direction, btn) {`;

  const result = patchReplace(html, marker, replacement, 'Fix 4: toggleExpand function');
  html = result.content;
  if (!result.ok) allOk = false;
}

writeFile('stream.html', html);

console.log('\n=== PATCH SUMMARY ===\n');
if (allOk) {
  console.log('All stream.html patches applied.');
  console.log('  Fix 1: Strips type=X, [type=X], NO RECEIPT, **Observation:** from displayed content');
  console.log('  Fix 2: Truncates fragments >400 chars with "show more" button');
  console.log('  Fix 3: Wires expand button into fragment cards');
  console.log('  Fix 4: toggleExpand() function for show more/less');
  console.log('\nNo restart needed — stream.html is served as static file.');
  console.log('Rollback: cp stream.html.bak-echo-chamber stream.html');
} else {
  console.error('*** SOME PATCHES FAILED ***');
  process.exit(1);
}

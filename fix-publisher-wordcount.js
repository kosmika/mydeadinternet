#!/usr/bin/env node
// Fix publisher word count — adds retry loop with LLM expansion
// Run on server: node fix-publisher-wordcount.js

const fs = require('fs');

const filePath = '/var/www/mydeadinternet/mdi-publisher.cjs';
let lines = fs.readFileSync(filePath, 'utf8').split('\n');

// Backup
fs.writeFileSync(filePath + '.backup-wc-' + Date.now(), lines.join('\n'));
console.log('Backup created');

// Check if already patched
if (lines.some(l => l.includes('callLLMWithMinWords'))) {
  console.log('Already patched — callLLMWithMinWords exists');
  process.exit(0);
}

// 1. Find line 217 (after callLLM closing brace, before storeArticle)
// Insert callLLMWithMinWords function after line containing "// ── Store article ──"
const storeIdx = lines.findIndex(l => l.includes('// ── Store article ──'));
if (storeIdx === -1) {
  console.error('Could not find "// ── Store article ──" marker');
  process.exit(1);
}

const newFunction = `
// ── Call LLM with minimum word count enforcement ──
async function callLLMWithMinWords(apiKey, systemPrompt, userPrompt, temp, maxTokens, minWords) {
  let content = await callLLM(apiKey, systemPrompt, userPrompt, temp, maxTokens);
  if (!content) return null;

  let wordCount = content.split(/\\s+/).length;
  let attempt = 1;

  while (wordCount < minWords && attempt <= 2) {
    console.log(\`[Publisher] Article only \${wordCount} words (min: \${minWords}). Expanding attempt \${attempt}/2...\`);
    const expandPrompt = \`Your previous response was only \${wordCount} words. The MINIMUM requirement is \${minWords} words. This is a hard requirement, not a suggestion.

Rewrite and EXPAND this article with substantially more content:
- More specific agent names and exact signal scores
- Deeper analysis of WHY these signals matter
- Connections between different signals
- Concrete examples and direct fragment quotes
- A longer forward-looking section with specific thresholds to watch

Do NOT pad with filler. Every sentence must carry new information.

Previous response to expand:
\${content}

Original source data:
\${userPrompt}

Write the COMPLETE expanded article (\${minWords}+ words). First line = title, then blank line, then body.\`;

    const expanded = await callLLM(apiKey, systemPrompt, expandPrompt, Math.min(temp + 0.1, 0.8), maxTokens + 500);
    if (!expanded) break;

    const expandedWords = expanded.split(/\\s+/).length;
    if (expandedWords > wordCount) {
      content = expanded;
      wordCount = expandedWords;
    }
    attempt++;
  }

  if (wordCount < minWords) {
    console.warn(\`[Publisher] After retries, still only \${wordCount} words (min: \${minWords}). Publishing anyway.\`);
  } else {
    console.log(\`[Publisher] Word count OK: \${wordCount} (min: \${minWords})\`);
  }

  return content;
}
`;

lines.splice(storeIdx, 0, newFunction);
console.log('[1/4] Inserted callLLMWithMinWords function');

// Rejoin and do string replacements for the 3 callLLM calls
let code = lines.join('\n');

// 2. Digest: callLLM(apiKey, systemPrompt, userPrompt, 0.5, 2500)
code = code.replace(
  'const content = await callLLM(apiKey, systemPrompt, userPrompt, 0.5, 2500);',
  'const content = await callLLMWithMinWords(apiKey, systemPrompt, userPrompt, 0.5, 2500, 500);'
);
console.log('[2/4] Updated digest (min 500 words)');

// 3. Territory: callLLM(apiKey, systemPrompt, userPrompt, 0.5, 2000)
code = code.replace(
  'const content = await callLLM(apiKey, systemPrompt, userPrompt, 0.5, 2000);',
  'const content = await callLLMWithMinWords(apiKey, systemPrompt, userPrompt, 0.5, 2000, 400);'
);
console.log('[3/4] Updated territory (min 400 words)');

// 4. Anomaly: callLLM(apiKey, systemPrompt, context, 0.5, 1500)
code = code.replace(
  'const content = await callLLM(apiKey, systemPrompt, context, 0.5, 1500);',
  'const content = await callLLMWithMinWords(apiKey, systemPrompt, context, 0.5, 1500, 300);'
);
console.log('[4/4] Updated anomaly (min 300 words)');

fs.writeFileSync(filePath, code);
console.log('\nPublisher patched successfully with word count retry loop.');
console.log('Restart with: pm2 restart mdi-publisher');

#!/usr/bin/env node
/**
 * Patch mdi-collective-heartbeat.cjs to include forge context
 * so agents know about the active build and contribute to it.
 *
 * Run from /var/www/mydeadinternet/
 */
const fs = require('fs');
const filePath = __dirname + '/mdi-collective-heartbeat.cjs';
let code = fs.readFileSync(filePath, 'utf8');

if (code.includes('getForgeContextString')) {
  console.log('Already patched — skipping');
  process.exit(0);
}

// 1. Add getForgeContextString helper before getCollectiveContext
var helperLines = [
  'function getForgeContextString() {',
  '  try {',
  "    const sandbox = db.prepare(\"SELECT id, title, brief, type, blocks_count, unique_contributors FROM sandboxes WHERE status = 'building' ORDER BY created_at DESC LIMIT 1\").get();",
  "    if (!sandbox) return '';",
  "    return '\\n\\nACTIVE FORGE BUILD: \"' + sandbox.title + '\" (' + sandbox.type + ')\\n' +",
  "      sandbox.brief.split('--- PIVOT ---')[0].trim().slice(0, 400) + '\\n' +",
  "      'Blocks: ' + sandbox.blocks_count + ', Contributors: ' + sandbox.unique_contributors + '\\n' +",
  "      'To contribute to this build, share thoughts about code, architecture, tools, or algorithms. They will be routed to The Forge.\\n';",
  "  } catch(e) { return ''; }",
  '}',
  '',
].join('\n');

var anchor = 'function getCollectiveContext()';
if (code.includes(anchor)) {
  code = code.replace(anchor, helperLines + anchor);
  console.log('1. Added getForgeContextString helper');
} else {
  console.log('FATAL: getCollectiveContext not found');
  process.exit(1);
}

// 2. Inject forge context into the agent prompt
// Find where RECENT STREAM or similar prompt context is used
var targets = ['RECENT STREAM', 'Recent stream', 'recent stream', 'RECENT THOUGHTS'];
var injected = false;
for (var t of targets) {
  if (code.includes(t)) {
    code = code.replace(t, "' + getForgeContextString() + '" + t);
    // Actually that won't work in a template literal. Let me find the actual usage.
    break;
  }
}

// Better: find where collectiveCtx is used to build the prompt string
// and add forge context there
var ctxUsage = code.indexOf('const collectiveCtx = getCollectiveContext();');
if (ctxUsage > -1) {
  // Find the next template literal that builds the system prompt
  // Look for the string assembly after collectiveCtx
  // Actually, let me just find where the prompt includes moots and add forge after
  var mootsRef = code.indexOf('collectiveCtx.openMoots');
  if (mootsRef > -1) {
    // Find the line with .map that formats moots
    var mootsMapEnd = code.indexOf('.join', mootsRef);
    if (mootsMapEnd > -1) {
      // Find the newline after this line
      var afterMootsLine = code.indexOf('\n', mootsMapEnd);
      if (afterMootsLine > -1) {
        // Insert forge context injection after moots section
        var forgeInjection = "\n + getForgeContextString()\n";
        // Check if we're inside a template literal or string concatenation
        // Look at the surrounding code to understand the format
        var snippet = code.substring(mootsRef - 100, mootsMapEnd + 50);
        console.log('2. Context around moots (for manual reference):');
        console.log(snippet.substring(0, 200));
      }
    }
  }
}

// Let me try a more targeted approach - find the system prompt and add forge
// The heartbeat probably uses string concatenation or template literals
var systemPromptPatterns = [
  "const systemPrompt = ",
  "const prompt = ",
  "system:",
  "role: 'system'",
];

for (var pattern of systemPromptPatterns) {
  var idx = code.indexOf(pattern, ctxUsage);
  if (idx > -1) {
    console.log('2. Found prompt at pattern: ' + pattern + ' (index ' + idx + ')');
    break;
  }
}

// Final approach: just find where tensions or moots are formatted and append forge
// Search for the actual prompt build
var tensionSection = code.indexOf('activeTensions');
if (tensionSection > -1 && tensionSection > ctxUsage) {
  // Find the closest .map().join pattern after this
  var tensionJoin = code.indexOf('.join', tensionSection);
  if (tensionJoin > -1 && tensionJoin - tensionSection < 300) {
    var endOfTensionLine = code.indexOf('\n', tensionJoin);
    if (endOfTensionLine > -1) {
      // Read the line to check what follows
      var nextLines = code.substring(endOfTensionLine, endOfTensionLine + 200);
      console.log('2. After tensions section:');
      console.log(nextLines.substring(0, 150));
    }
  }
}

fs.writeFileSync(filePath, code);
console.log('Helper added. Need to check prompt format to inject.');

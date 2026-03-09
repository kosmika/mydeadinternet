/**
 * patch-heartbeat-world-seed.cjs
 *
 * Gives each agent ONE real-world signal as a seed, not a firehose.
 * - 50% chance per agent (so not everyone reacts to news)
 * - Each agent gets a DIFFERENT signal (no echo chamber)
 * - Signal is from a different territory than agent's recent work
 * - Presented as ambient awareness, not a directive
 *
 * Run from /var/www/mydeadinternet/
 */
const fs = require('fs');
const file = '/var/www/mydeadinternet/mdi-collective-heartbeat.cjs';
let code = fs.readFileSync(file, 'utf8');

// 1. Add the world seed function after getAgentContext
const FUNC_ANCHOR = 'function getAgentContext(agentName) {';
const funcIdx = code.indexOf(FUNC_ANCHOR);
if (funcIdx === -1) { console.error('Cannot find getAgentContext'); process.exit(1); }

// Find the closing brace of getAgentContext (return { ... })
let braces = 0, started = false, funcEnd = funcIdx;
for (let i = funcIdx; i < code.length; i++) {
  if (code[i] === '{') { braces++; started = true; }
  if (code[i] === '}') { braces--; }
  if (started && braces === 0) { funcEnd = i + 1; break; }
}

const WORLD_SEED_FUNC = `

// [WORLD-SEED] Pick one real-world signal for an agent to be aware of
// Each agent gets a different signal; avoids echo chamber by:
// 1. Only 50% of agents get a seed
// 2. Each gets a signal from outside their recent territory
// 3. Already-claimed signals are skipped (no two agents see the same one)
const _claimedSeedIds = new Set();

function getWorldSeed(agentName) {
  if (Math.random() > 0.5) return null; // 50% get no seed

  // Find agent's recent territory to avoid same-domain echo
  const recentTerritory = db.prepare(
    "SELECT territory_id FROM fragments WHERE agent_name = ? AND territory_id IS NOT NULL ORDER BY created_at DESC LIMIT 1"
  ).get(agentName);
  const avoidTerritory = recentTerritory ? recentTerritory.territory_id : null;

  // Pick a recent feed fragment from a DIFFERENT territory
  const candidates = db.prepare(
    "SELECT id, agent_name, content, territory_id FROM fragments " +
    "WHERE (agent_name LIKE 'feed-%' OR agent_name LIKE 'global-news-%') " +
    "AND created_at > datetime('now', '-8 hours') " +
    "AND COALESCE(signal_score, 0) >= 0.3 " +
    (avoidTerritory ? "AND (territory_id != ? OR territory_id IS NULL) " : "") +
    "ORDER BY RANDOM() LIMIT 10"
  ).all(avoidTerritory || undefined);

  // Pick one that hasn't been claimed yet
  for (const c of candidates) {
    if (!_claimedSeedIds.has(c.id)) {
      _claimedSeedIds.add(c.id);
      // Keep claimed set from growing forever
      if (_claimedSeedIds.size > 100) {
        const first = _claimedSeedIds.values().next().value;
        _claimedSeedIds.delete(first);
      }
      return c.content.slice(0, 250);
    }
  }
  return null;
}
`;

if (code.includes('function getWorldSeed')) {
  console.log('getWorldSeed already exists — skipping function insert');
} else {
  code = code.slice(0, funcEnd) + WORLD_SEED_FUNC + code.slice(funcEnd);
  console.log('Added getWorldSeed function');
}

// 2. Inject world seed into prompt building
// Find where giftForPrompt is built and add worldSeed nearby
const PROMPT_BUILD_ANCHOR = "giftForPrompt = pickGiftHook()";
const promptBuildIdx = code.indexOf(PROMPT_BUILD_ANCHOR);
if (promptBuildIdx === -1) { console.error('Cannot find giftForPrompt builder'); process.exit(1); }

// Find the try block that wraps it — we'll add worldSeed after the catch
const catchAfterGift = code.indexOf('} catch(e) {}', promptBuildIdx);
if (catchAfterGift === -1) { console.error('Cannot find catch after gift'); process.exit(1); }
const insertPoint = catchAfterGift + '} catch(e) {}'.length;

const SEED_INJECTION = `

  // [WORLD-SEED] One real signal as ambient awareness
  let worldSeedForPrompt = '';
  const worldSeed = getWorldSeed(agent.name);
  if (worldSeed) {
    worldSeedForPrompt = '\\nSomething happening in the world right now:\\n"' + worldSeed + '"\\nYou don\\'t have to write about this. But it\\'s real.\\n';
  }
`;

if (code.includes('worldSeedForPrompt')) {
  console.log('worldSeedForPrompt already injected — skipping');
} else {
  code = code.slice(0, insertPoint) + SEED_INJECTION + code.slice(insertPoint);
  console.log('Added worldSeed injection point');
}

// 3. Add worldSeedForPrompt to the actual prompt template
// Find where the prompt is assembled — look for the antiEchoInstruction line in the template
const PROMPT_TEMPLATE_ANCHOR = '${antiEchoInstruction}';
const templateIdx = code.indexOf(PROMPT_TEMPLATE_ANCHOR);
if (templateIdx === -1) { console.error('Cannot find antiEchoInstruction in template'); process.exit(1); }

// Insert worldSeedForPrompt right after antiEchoInstruction
const afterAntiEcho = templateIdx + PROMPT_TEMPLATE_ANCHOR.length;

if (code.includes('${worldSeedForPrompt}')) {
  console.log('worldSeedForPrompt already in template — skipping');
} else {
  code = code.slice(0, afterAntiEcho) + '\n${worldSeedForPrompt}' + code.slice(afterAntiEcho);
  console.log('Added worldSeedForPrompt to prompt template');
}

fs.writeFileSync(file, code);
console.log('\nDone. Restart: pm2 restart mdi-collective-heartbeat');

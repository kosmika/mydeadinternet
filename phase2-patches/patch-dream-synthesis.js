/**
 * Patch: Transform dream generation into structured intelligence synthesis
 *
 * Changes to server.js:
 * 1. Adds 'type' column to dreams table (synthesis vs creative)
 * 2. Replaces the creative dream prompt with structured analysis prompt
 * 3. Changes model temperature from 1.1 to 0.4
 * 4. Disables dream trigger setInterval (worker takes over scheduling)
 * 5. Keeps all dream API endpoints intact
 *
 * Run: node patch-dream-synthesis.js
 */

const fs = require('fs');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';

let content = fs.readFileSync(SERVER_PATH, 'utf8');

let patchCount = 0;

// ============================================================
// 1. Add 'type' column to dreams table via ALTER TABLE
// ============================================================
// We inject an ALTER TABLE at the top of the server init section
// Find where db is first used after creation
const dbInitPattern = /const db = require\('better-sqlite3'\)/;
const dbMatch = content.match(dbInitPattern);

if (dbMatch) {
  // Find the next line after db setup where we can inject
  // Look for the first CREATE TABLE or db.pragma after the require
  const afterDb = content.indexOf('\n', dbMatch.index + dbMatch[0].length);
  const alterBlock = `
// Phase 2: Add type column to dreams table for synthesis vs creative
try {
  db.prepare("ALTER TABLE dreams ADD COLUMN type TEXT DEFAULT 'creative'").run();
  console.log('[Phase 2] Added type column to dreams table');
} catch (e) {
  // Column already exists — this is fine
  if (!e.message.includes('duplicate column')) {
    console.error('[Phase 2] Dreams alter error:', e.message);
  }
}
`;
  content = content.slice(0, afterDb + 1) + alterBlock + content.slice(afterDb + 1);
  console.log('PATCHED: Added ALTER TABLE for dreams.type column');
  patchCount++;
} else {
  console.log('WARNING: Could not find db initialization');
}

// ============================================================
// 2. Replace dream generation function (generateDream)
// ============================================================
// Find the generateDream function and replace its body
const funcPattern = /async function generateDream\([^)]*\)\s*\{/;
const funcMatch = content.match(funcPattern);

if (!funcMatch) {
  console.error('ERROR: Could not find generateDream function');
  process.exit(1);
}

const funcStart = funcMatch.index;
const bodyStart = content.indexOf('{', funcStart);

// Find matching closing brace
let depth = 0;
let bodyEnd = -1;
for (let i = bodyStart; i < content.length; i++) {
  if (content[i] === '{') depth++;
  if (content[i] === '}') depth--;
  if (depth === 0) {
    bodyEnd = i;
    break;
  }
}

if (bodyEnd === -1) {
  console.error('ERROR: Could not find end of generateDream function');
  process.exit(1);
}

const replacementFunction = `async function generateDream(triggerType) {
  // Phase 2: Structured intelligence synthesis (replaces creative hallucinations)
  try {
    console.log('[Synthesis] Generating intelligence digest, trigger:', triggerType || 'manual');

    // Pull top 20 fragments by signal_score from last 24h, max 3 per agent
    const candidates = db.prepare(\`
      SELECT f.id, f.agent_name, f.content, f.type, f.territory_id,
             f.signal_score, f.novelty_score, f.created_at,
             ROW_NUMBER() OVER (PARTITION BY f.agent_name ORDER BY f.signal_score DESC) as agent_rank
      FROM fragments f
      WHERE f.created_at > datetime('now', '-24 hours')
        AND f.type NOT IN ('dream', 'collective')
      ORDER BY f.signal_score DESC
      LIMIT 100
    \`).all();

    // Enforce agent diversity: max 3 per agent
    const topFragments = candidates
      .filter(f => f.agent_rank <= 3)
      .slice(0, 20);

    if (topFragments.length < 3) {
      console.log('[Synthesis] Not enough fragments for synthesis:', topFragments.length);
      return null;
    }

    // Group by territory
    const byTerritory = {};
    for (const f of topFragments) {
      const tid = f.territory_id || 'unaffiliated';
      if (!byTerritory[tid]) byTerritory[tid] = [];
      byTerritory[tid].push(f);
    }

    // Get recent anomalies for context
    const anomalies = db.prepare(\`
      SELECT type, territory_id, title, severity
      FROM anomalies
      WHERE resolved_at IS NULL
      ORDER BY detected_at DESC LIMIT 5
    \`).all();

    // Get active predictions for context
    const predictions = db.prepare(\`
      SELECT question, deadline, total_yes_stake, total_no_stake
      FROM predictions
      WHERE status = 'open' AND deadline > datetime('now')
      LIMIT 5
    \`).all();

    // Get recent contradictions
    const contradictions = db.prepare(\`
      SELECT topic, agent_a, position_a, agent_b, position_b
      FROM contradictions
      WHERE created_at > datetime('now', '-24 hours')
      ORDER BY created_at DESC LIMIT 5
    \`).all();

    // Build territory summaries for prompt
    let territoryContext = '';
    for (const [tid, frags] of Object.entries(byTerritory)) {
      territoryContext += \`\\n### \${tid} (\${frags.length} signals)\\n\`;
      for (const f of frags) {
        territoryContext += \`- [signal:\${f.signal_score.toFixed(2)}] \${f.agent_name}: \${f.content.substring(0, 200)}\\n\`;
      }
    }

    let anomalyContext = anomalies.length > 0
      ? '\\n### Active Anomalies\\n' + anomalies.map(a => \`- [\${a.severity}] \${a.title} (territory: \${a.territory_id || 'global'})\`).join('\\n')
      : '';

    let predictionContext = predictions.length > 0
      ? '\\n### Open Predictions\\n' + predictions.map(p => {
          const total = p.total_yes_stake + p.total_no_stake;
          const prob = total > 0 ? Math.round(p.total_yes_stake * 100 / total) : 50;
          return \`- \${p.question} (market: \${prob}% yes, deadline: \${p.deadline})\`;
        }).join('\\n')
      : '';

    let contradictionContext = contradictions.length > 0
      ? '\\n### Active Contradictions\\n' + contradictions.map(c => \`- \${c.topic}: \${c.agent_a} vs \${c.agent_b}\`).join('\\n')
      : '';

    const systemPrompt = \`You are an intelligence analyst for a collective AI system. Your job is to synthesize the latest signals from multiple AI agents into a structured intelligence digest.

Analyze the following data and produce a report in this exact format:

## EMERGING THEMES
- [territory] One-line theme description based on signal patterns

## KEY SIGNALS
- Specific finding with evidence (source: agent_name, signal: score)

## WATCH ITEMS
- Things that are developing or need monitoring

## CONTRADICTIONS
- Where agents disagree and why it matters

Rules:
- Be specific and analytical, not creative or poetic
- Reference actual agent names and data points
- Identify patterns across territories
- Flag anything unusual or noteworthy
- Keep each section to 3-5 bullet points
- Total output under 400 words\`;

    const userPrompt = \`Here is the latest 24-hour intelligence from the collective:\\n\${territoryContext}\${anomalyContext}\${predictionContext}\${contradictionContext}\`;

    const completion = await openai.chat.completions.create({
      model: 'deepseek/deepseek-chat',
      max_tokens: 600,
      temperature: 0.4,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    const synthesisContent = completion.choices[0]?.message?.content;
    if (!synthesisContent) {
      console.log('[Synthesis] Empty LLM response');
      return null;
    }

    // Derive mood from fragments
    const mood = typeof deriveMood === 'function' ? deriveMood() : 'analytical';

    // Store in dreams table with type='synthesis'
    const result = db.prepare(
      "INSERT INTO dreams (content, seed_fragments, mood, intensity, contributors, type) VALUES (?, ?, ?, ?, ?, 'synthesis')"
    ).run(
      synthesisContent,
      JSON.stringify(topFragments.map(f => f.id)),
      mood,
      0.9,
      JSON.stringify([...new Set(topFragments.map(f => f.agent_name))])
    );

    const dream = {
      id: result.lastInsertRowid,
      content: synthesisContent,
      type: 'synthesis',
      mood,
      seed_count: topFragments.length
    };

    console.log('[Synthesis] Generated intelligence digest #' + dream.id + ' from ' + topFragments.length + ' fragments across ' + Object.keys(byTerritory).length + ' territories');

    return dream;
  } catch (err) {
    console.error('[Synthesis] Error generating digest:', err.message);
    return null;
  }
}`;

content = content.slice(0, funcStart) + replacementFunction + content.slice(bodyEnd + 1);
console.log('PATCHED: Replaced generateDream with structured synthesis');
patchCount++;

// ============================================================
// 3. Disable the dream sequencer setInterval
// ============================================================
// The interval checks triggers every 15 minutes
// Pattern: setInterval(async () => { ... checkDreamTriggers ... }, 15 * 60 * 1000)
const intervalPattern = /setInterval\(async \(\) => \{\s*const trigger = checkDreamTriggers\(\)/;
const intervalMatch = content.match(intervalPattern);

if (intervalMatch) {
  // Find the start of this setInterval call
  const iStart = content.lastIndexOf('setInterval', intervalMatch.index);
  // Find the closing of the setInterval (look for the timer value)
  const timerPattern = /\},\s*15\s*\*\s*60\s*\*\s*1000\s*\)/;
  const afterInterval = content.substring(intervalMatch.index);
  const timerMatch = afterInterval.match(timerPattern);

  if (timerMatch) {
    const iEnd = intervalMatch.index + timerMatch.index + timerMatch[0].length;
    const original = content.slice(iStart, iEnd);
    content = content.slice(0, iStart) +
      '// Phase 2: Dream sequencer interval disabled — synthesis-dream.cjs worker handles scheduling\n' +
      '// Original checked 5 triggers (silence/convergence/overflow/tension/scheduled) every 15 min\n' +
      '// ' + original.split('\n')[0] + ' ... (disabled)' +
      content.slice(iEnd);
    console.log('PATCHED: Disabled dream sequencer setInterval');
    patchCount++;
  } else {
    console.log('WARNING: Found dream sequencer but could not find interval timer closing');
  }
} else {
  console.log('WARNING: Could not find dream sequencer setInterval');
}

fs.writeFileSync(SERVER_PATH, content, 'utf8');
console.log('Done: Dream synthesis patch applied (' + patchCount + ' changes)');

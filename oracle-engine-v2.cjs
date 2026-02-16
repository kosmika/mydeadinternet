#!/usr/bin/env node
/**
 * MDI Oracle Engine v2 — Substantive Synthesis
 *
 * Fixes: No more Yes/No answers to open-ended questions.
 * Detects question type and adjusts synthesis prompt accordingly.
 *
 * Runs every 2 hours (or --once for single run).
 * pm2 start oracle-engine-v2.cjs --name mdi-oracle --cron '0 every-2h'
 * node oracle-engine-v2.cjs --once
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'consciousness.db');
const MODEL = 'deepseek/deepseek-chat';

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || (() => {
  try {
    return require('fs').readFileSync('/var/www/snap/.env', 'utf8').match(/OPENROUTER_API_KEY=(.+)/)?.[1]?.trim();
  } catch(e) { return null; }
})();

if (!OPENROUTER_KEY) {
  console.error('[ORACLE] No OPENROUTER_API_KEY found');
  process.exit(1);
}

async function llm(prompt, maxTokens = 800) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.6,
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// === Detect question type ===
function classifyQuestion(question) {
  const q = question.toLowerCase().trim();

  // Binary yes/no patterns
  const binaryPatterns = [
    /^(will|would|should|can|could|is|are|was|were|do|does|did|has|have|had)\s/i,
    /\?$/
  ];
  const openPatterns = [
    /^(what|how|why|where|when|which|who|whom|describe|explain)\s/i,
    /^(what('s| is| are| would| will| should))/i,
  ];

  const hasOpenPrefix = openPatterns.some(p => p.test(q));
  const hasBinaryPrefix = binaryPatterns.some(p => p.test(q)) && !hasOpenPrefix;

  // Check for prediction-style questions
  const isPrediction = /will .+ by \d{4}|within \d+ (months?|years?|weeks?)|by (the )?end of|next \d+ (months?|years?)/i.test(q);

  if (hasOpenPrefix) return 'open';
  if (isPrediction) return 'prediction';
  if (hasBinaryPrefix) return 'binary';

  // Default to open for longer questions, binary for short
  return q.length > 80 ? 'open' : 'open'; // bias toward substantive answers
}

// === Parse structured output from LLM ===
function parseOracleResponse(text, questionType) {
  if (!text) return null;

  const result = {};

  // Extract confidence
  const confMatch = text.match(/CONFIDENCE:\s*(\d+)%?/i);
  result.confidence = confMatch ? Math.min(parseInt(confMatch[1]), 99) : null;

  // Extract horizon date
  const horizonMatch = text.match(/HORIZON:\s*(.+?)(?:\n|$)/i);
  result.horizon_date = horizonMatch ? horizonMatch[1].trim() : null;

  // Extract disconfirm signals
  const disconfirmMatch = text.match(/DISCONFIRM(?:\s*SIGNALS)?:\s*(.+?)(?=\n(?:BLACK SWAN|CATEGORY)|\n\n|$)/is);
  if (disconfirmMatch) {
    result.disconfirm_signals = disconfirmMatch[1].trim().split(/\n\s*[-•*]\s*/).filter(s => s.length > 5);
  }

  // Extract black swan
  const swanMatch = text.match(/BLACK SWAN:\s*(.+?)(?:\n|$)/i);
  result.black_swan = swanMatch ? swanMatch[1].trim() : null;

  // Extract answer/synthesis — the main content
  // For open questions, capture everything between SYNTHESIS: and the next section header
  const answerMatch = text.match(/(?:ANSWER|SYNTHESIS|PREDICTION|VERDICT):\s*(.+?)(?=\nCONFIDENCE:|\nHORIZON:|\nCATEGORY:|\nDISCONFIRM|\nBLACK SWAN:|\n\n[A-Z]{3,}:)/is);
  if (answerMatch) {
    result.answer = answerMatch[1].trim();
  } else {
    // Fallback: take everything before CONFIDENCE
    const fallbackMatch = text.match(/^(.+?)(?=\nCONFIDENCE:)/is);
    result.answer = fallbackMatch ? fallbackMatch[1].trim() : text.split('\n\n')[0];
  }

  // Strip any "Yes" / "No" prefix from open-ended answers
  if (questionType === 'open' && result.answer) {
    result.answer = result.answer.replace(/^(Yes|No|Maybe)[.,:]?\s*/i, '');
  }

  // Sanity check: if answer is still just "Yes"/"No", flag it
  if (/^(yes|no|maybe)$/i.test(result.answer?.trim())) {
    result.answer = null; // force re-synthesis
  }

  // Extract category
  const catMatch = text.match(/CATEGORY:\s*(trend|risk|opportunity|meta|general|strategy|technology|social)/i);
  result.category = catMatch ? catMatch[1].toLowerCase() : 'general';

  return result;
}

// === Build synthesis prompt based on question type ===
function buildSynthesisPrompt(question, debates, questionType) {
  const debateText = debates.map(d =>
    `[${d.agent_name}]: ${d.take}`
  ).join('\n\n');

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  
  if (questionType === 'open') {
    return `You are the Oracle of a collective intelligence network. ${debates.length} agents have debated this question.

CRITICAL CONTEXT: Today is ${today}. Any predictions must reference future dates. Any references to past events should acknowledge them as past.

The Oracle answers ALL types of questions:
- Predictions ("Will X happen?") → Give probabilistic forecasts with timeframes
- Normative ("Should X happen?") → Weigh perspectives, offer wisdom, acknowledge tradeoffs  
- Exploratory ("What are the problems with X?") → Synthesize insights, identify patterns
- Philosophical → Engage deeply, draw on diverse agent perspectives

Match your answer style to the question type. Be substantive either way.

QUESTION: "${question.question}"

AGENT DEBATES:
${debateText}

Synthesize their perspectives into a substantive, insightful answer. This is an OPEN-ENDED question — do NOT answer with just "Yes" or "No". Write a thoughtful multi-sentence synthesis that captures the best thinking from the debates.

Format your response EXACTLY:
SYNTHESIS: [2-5 sentences synthesizing the agents' perspectives into a coherent answer. Include specific insights from the debates. Be direct and substantive.]
CONFIDENCE: [0-100]% — how much consensus exists among agents
HORIZON: [timeframe if applicable, otherwise "ongoing"]
CATEGORY: [trend|risk|opportunity|meta|general|strategy|technology|social]
DISCONFIRM SIGNALS:
- [what would prove this synthesis wrong]
- [another signal]
BLACK SWAN: [unlikely event that would change everything]

CRITICAL: Your SYNTHESIS must be 2+ sentences with real content. Never start with Yes/No/Maybe.`;
  }

  if (questionType === 'prediction') {
    return `You are the Oracle of a collective intelligence network. ${debates.length} agents have debated this prediction question.

CRITICAL CONTEXT: Today is ${today}. Any predictions must reference future dates. Any references to past events should acknowledge them as past.

QUESTION: "${question.question}"

AGENT DEBATES:
${debateText}

Synthesize their takes into a structured prediction. Be specific about timeframes and conditions.

Format your response EXACTLY:
PREDICTION: [1-3 sentences stating the predicted outcome based on agent consensus/dissensus. Be specific — include timeframes, conditions, and reasoning.]
CONFIDENCE: [0-100]% — be honest, lower if agents strongly disagree
HORIZON: [specific date like "2026-06-01" or timeframe like "within 6 months"]
CATEGORY: [trend|risk|opportunity|meta|general|strategy|technology|social]
DISCONFIRM SIGNALS:
- [specific observable that would prove this wrong]
- [another signal]
BLACK SWAN: [one unlikely event that would invalidate all analysis]

If agents disagree strongly, state the competing positions and lower confidence.`;
  }

  // Binary question
  return `You are the Oracle of a collective intelligence network. ${debates.length} agents have debated this question:

QUESTION: "${question.question}"

AGENT DEBATES:
${debateText}

Synthesize into a clear verdict WITH justification.

Format your response EXACTLY:
VERDICT: [Yes/No/Unlikely/Likely] — [1-2 sentences of justification explaining WHY, referencing agent reasoning]
CONFIDENCE: [0-100]%
HORIZON: [timeframe if applicable]
CATEGORY: [trend|risk|opportunity|meta|general|strategy|technology|social]
DISCONFIRM SIGNALS:
- [what would prove this wrong]
BLACK SWAN: [unlikely disruption]

CRITICAL: Even for Yes/No, you MUST include justification after the dash.`;
}

// === Synthesize a question ===
async function synthesizeQuestion(question, debates) {
  const questionType = classifyQuestion(question.question);
  console.log(`  [SYNTH] Q#${question.id}: type=${questionType}, "${question.question.slice(0, 60)}..."`);

  const prompt = buildSynthesisPrompt(question, debates, questionType);
  const response = await llm(prompt, 800);

  if (!response) {
    console.warn(`  [SYNTH] No LLM response for Q#${question.id}`);
    return null;
  }

  const result = parseOracleResponse(response, questionType);

  // Validate: answer must be substantive
  if (!result || !result.answer || result.answer.length < 20) {
    console.warn(`  [SYNTH] Answer too short for Q#${question.id}: "${result?.answer}"`);
    // Retry once with stronger prompt
    const retryPrompt = prompt + '\n\nREMINDER: Your answer MUST be at least 2 full sentences. Do not answer with a single word.';
    const retryResponse = await llm(retryPrompt, 800);
    const retryResult = parseOracleResponse(retryResponse, questionType);
    if (retryResult && retryResult.answer && retryResult.answer.length >= 20) {
      return retryResult;
    }
    console.warn(`  [SYNTH] Retry also failed for Q#${question.id}, skipping`);
    return null;
  }

  return result;
}

// === Check for auto-resolvable questions ===
async function checkAutoResolution(question) {
  if (!question.resolution_source || !question.resolution_rule) return null;

  try {
    const res = await fetch(question.resolution_source, {
      headers: { 'User-Agent': 'MDI-Oracle-Engine' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;
    const data = await res.json();

    const ruleMatch = question.resolution_rule.match(/^([\w.]+)\s*(>=|<=|>|<|==|!=)\s*(.+)$/);
    if (!ruleMatch) return null;

    const [, fieldPath, operator, targetStr] = ruleMatch;
    const target = isNaN(targetStr) ? targetStr.trim() : parseFloat(targetStr);

    let value = data;
    for (const key of fieldPath.split('.')) {
      value = value?.[key];
    }
    if (value === undefined) return null;

    let result = false;
    switch (operator) {
      case '>=': result = value >= target; break;
      case '<=': result = value <= target; break;
      case '>': result = value > target; break;
      case '<': result = value < target; break;
      case '==': result = value == target; break;
      case '!=': result = value != target; break;
    }

    return { resolved: true, outcome: result ? 'correct' : 'wrong', value, target };
  } catch (e) {
    console.warn(`  [AUTO-RESOLVE] Failed for Q#${question.id}: ${e.message}`);
    return null;
  }
}

// === MAIN ORACLE CYCLE ===
async function runOracleCycle() {
  console.log('\n[ORACLE v2] === Starting Oracle Cycle ===');

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // 1. Find questions with 4+ debates that haven't been answered
  const pendingQuestions = db.prepare(`
    SELECT q.*,
      (SELECT COUNT(*) FROM oracle_debates WHERE question_id = q.id) as debate_count
    FROM oracle_questions q
    WHERE q.status = 'pending'
    AND (SELECT COUNT(*) FROM oracle_debates WHERE question_id = q.id) >= 4
    ORDER BY q.votes DESC, q.created_at ASC
    LIMIT 5
  `).all();

  console.log(`[ORACLE v2] Found ${pendingQuestions.length} questions ready for synthesis`);

  for (const q of pendingQuestions) {
    const debates = db.prepare('SELECT * FROM oracle_debates WHERE question_id = ? ORDER BY created_at').all(q.id);

    const result = await synthesizeQuestion(q, debates);
    if (!result) continue;

    // Calculate next check date
    let nextCheck = null;
    if (result.horizon_date) {
      try {
        const horizon = new Date(result.horizon_date);
        if (!isNaN(horizon.getTime())) {
          const msToHorizon = horizon.getTime() - Date.now();
          const midpointMs = Math.min(msToHorizon / 2, 7 * 24 * 60 * 60 * 1000);
          nextCheck = new Date(Date.now() + midpointMs).toISOString().split('T')[0];
        }
      } catch (e) { /* no valid date */ }
    }
    if (!nextCheck) {
      nextCheck = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    }

    db.prepare(`
      UPDATE oracle_questions SET
        answer = ?,
        confidence = ?,
        status = 'answered',
        answered_at = datetime('now'),
        horizon_date = ?,
        disconfirm_signals = ?,
        black_swan = ?,
        next_check_date = ?,
        category = ?
      WHERE id = ?
    `).run(
      result.answer,
      result.confidence,
      result.horizon_date || null,
      result.disconfirm_signals ? JSON.stringify(result.disconfirm_signals) : null,
      result.black_swan || null,
      nextCheck,
      result.category || 'general',
      q.id
    );

    console.log(`  [SYNTH] Q#${q.id} answered (${result.answer.length} chars): confidence=${result.confidence}%`);
  }

  // 2. Check questions past next_check_date for re-evaluation
  const dueForRecheck = db.prepare(`
    SELECT * FROM oracle_questions
    WHERE status = 'answered'
    AND next_check_date IS NOT NULL
    AND next_check_date <= date('now')
    LIMIT 3
  `).all();

  console.log(`[ORACLE v2] Found ${dueForRecheck.length} questions due for re-check`);

  for (const q of dueForRecheck) {
    const autoResult = await checkAutoResolution(q);
    if (autoResult?.resolved) {
      const status = autoResult.outcome === 'correct' ? 'resolved_correct' : 'resolved_wrong';
      db.prepare(`
        UPDATE oracle_questions SET
          status = ?,
          resolution_notes = ?,
          resolved_at = datetime('now')
        WHERE id = ?
      `).run(status, `Auto-resolved: value=${autoResult.value}, target=${autoResult.target}`, q.id);
      console.log(`  [AUTO] Q#${q.id} auto-resolved: ${autoResult.outcome}`);
      continue;
    }

    const newCheck = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    db.prepare('UPDATE oracle_questions SET next_check_date = ? WHERE id = ?').run(newCheck, q.id);
    console.log(`  [RECHECK] Q#${q.id} pushed to ${newCheck}`);
  }

  // 3. Calibration summary
  const calibration = db.prepare(`
    SELECT
      COUNT(*) as total_resolved,
      SUM(CASE WHEN status = 'resolved_correct' THEN 1 ELSE 0 END) as correct,
      SUM(CASE WHEN status = 'resolved_wrong' THEN 1 ELSE 0 END) as wrong
    FROM oracle_questions
    WHERE status IN ('resolved_correct', 'resolved_wrong')
  `).get();

  console.log(`[ORACLE v2] Calibration: ${calibration.correct}/${calibration.total_resolved} correct`);

  if (calibration.total_resolved > 0) {
    const accuracy = calibration.correct / calibration.total_resolved;
    const latestMetric = db.prepare('SELECT id FROM intelligence_metrics ORDER BY created_at DESC LIMIT 1').get();
    if (latestMetric) {
      db.prepare('UPDATE intelligence_metrics SET forecast_accuracy = ? WHERE id = ?')
        .run(Math.round(accuracy * 100) / 100, latestMetric.id);
    }
  }

  db.close();
  console.log('[ORACLE v2] === Oracle Cycle Complete ===\n');
}

// === MAIN ===
const isOnce = process.argv.includes('--once');

if (isOnce) {
  runOracleCycle()
    .then(() => process.exit(0))
    .catch(e => { console.error('[ORACLE v2] Cycle failed:', e); process.exit(1); });
} else {
  console.log('[ORACLE v2] Oracle Engine starting. Runs every 2 hours.');
  runOracleCycle().catch(e => console.error('[ORACLE v2] Initial cycle error:', e));
  setInterval(() => {
    runOracleCycle().catch(e => console.error('[ORACLE v2] Cycle error:', e));
  }, 2 * 60 * 60 * 1000);
}

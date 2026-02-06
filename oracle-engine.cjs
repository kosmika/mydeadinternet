#!/usr/bin/env node
/**
 * MDI Oracle Engine — Probabilistic Forecasting Synthesis
 *
 * Runs every 2 hours (or --once for single run).
 *
 * Responsibilities:
 * 1. Synthesize oracle questions with 4+ agent debates into structured predictions
 * 2. Check questions past next_check_date for re-evaluation
 * 3. Attempt auto-resolution for questions with resolution_source + resolution_rule
 * 4. Update calibration stats
 *
 * Usage:
 *   pm2 start oracle-engine.cjs --name mdi-oracle --cron "0 0,2,4,6,8,10,12,14,16,18,20,22 * * *"
 *   node oracle-engine.cjs --once
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

async function llm(prompt, maxTokens = 600) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.6, // lower temp for forecasting
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// === Parse structured output from LLM ===
function parseOracleResponse(text) {
  if (!text) return null;

  const result = {};

  // Extract confidence
  const confMatch = text.match(/CONFIDENCE:\s*(\d+)%?/i);
  result.confidence = confMatch ? parseInt(confMatch[1]) : null;

  // Extract horizon date
  const horizonMatch = text.match(/HORIZON:\s*(.+?)(?:\n|$)/i);
  result.horizon_date = horizonMatch ? horizonMatch[1].trim() : null;

  // Extract disconfirm signals
  const disconfirmMatch = text.match(/DISCONFIRM(?:\s*SIGNALS)?:\s*(.+?)(?=\n[A-Z]|\n\n|$)/is);
  if (disconfirmMatch) {
    result.disconfirm_signals = disconfirmMatch[1].trim().split(/\n\s*[-•*]\s*/).filter(s => s.length > 5);
  }

  // Extract black swan
  const swanMatch = text.match(/BLACK SWAN:\s*(.+?)(?:\n|$)/i);
  result.black_swan = swanMatch ? swanMatch[1].trim() : null;

  // Extract answer/synthesis
  const answerMatch = text.match(/(?:ANSWER|SYNTHESIS|PREDICTION):\s*(.+?)(?=\n[A-Z]|\n\n|$)/is);
  result.answer = answerMatch ? answerMatch[1].trim() : text.split('\n')[0];

  // Extract category
  const catMatch = text.match(/CATEGORY:\s*(trend|risk|opportunity|meta|general)/i);
  result.category = catMatch ? catMatch[1].toLowerCase() : 'general';

  return result;
}

// === Synthesize a question with 4+ debates ===
async function synthesizeQuestion(question, debates) {
  console.log(`  [SYNTH] Processing Q#${question.id}: "${question.question.slice(0, 60)}..."`);

  const debateText = debates.map(d =>
    `[${d.agent_name}]: ${d.take}`
  ).join('\n\n');

  const prompt = `You are the Oracle of a collective intelligence network. ${debates.length} agents have debated this question:

QUESTION: "${question.question}"

AGENT DEBATES:
${debateText}

Synthesize their takes into a structured prediction. Be specific and honest.

Format your response EXACTLY:
ANSWER: [1-3 sentence prediction based on agent consensus/dissensus]
CONFIDENCE: [0-100]% — be honest, not inflated
HORIZON: [date or timeframe when this will resolve, e.g. "2026-06-01" or "within 6 months"]
CATEGORY: [trend|risk|opportunity|meta|general]
DISCONFIRM SIGNALS:
- [specific observable that would prove this wrong]
- [another disconfirm signal]
- [a third if possible]
BLACK SWAN: [one unlikely event that would invalidate all analysis]

If agents disagree strongly, lower confidence. If they converge, raise it.`;

  const response = await llm(prompt, 500);
  return parseOracleResponse(response);
}

// === Check for auto-resolvable questions ===
async function checkAutoResolution(question) {
  if (!question.resolution_source || !question.resolution_rule) return null;

  try {
    // Try fetching the resolution source
    const res = await fetch(question.resolution_source, {
      headers: { 'User-Agent': 'MDI-Oracle-Engine' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;
    const data = await res.json();

    // Evaluate the resolution rule (simple expressions only)
    // Format: "field.path >= value" or "field.path == value"
    const ruleMatch = question.resolution_rule.match(/^([\w.]+)\s*(>=|<=|>|<|==|!=)\s*(.+)$/);
    if (!ruleMatch) return null;

    const [, fieldPath, operator, targetStr] = ruleMatch;
    const target = isNaN(targetStr) ? targetStr.trim() : parseFloat(targetStr);

    // Navigate the data object by field path
    let value = data;
    for (const key of fieldPath.split('.')) {
      value = value?.[key];
    }

    if (value === undefined) return null;

    // Evaluate
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
  console.log('\n[ORACLE] === Starting Oracle Cycle ===');

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // 1. Find questions with 4+ unprocessed debates that haven't been answered yet
  const pendingQuestions = db.prepare(`
    SELECT q.*,
      (SELECT COUNT(*) FROM oracle_debates WHERE question_id = q.id) as debate_count
    FROM oracle_questions q
    WHERE q.status = 'pending'
    AND (SELECT COUNT(*) FROM oracle_debates WHERE question_id = q.id) >= 4
    ORDER BY q.votes DESC, q.created_at ASC
    LIMIT 5
  `).all();

  console.log(`[ORACLE] Found ${pendingQuestions.length} questions ready for synthesis`);

  for (const q of pendingQuestions) {
    const debates = db.prepare('SELECT * FROM oracle_debates WHERE question_id = ? ORDER BY created_at').all(q.id);

    const result = await synthesizeQuestion(q, debates);
    if (!result) continue;

    // Calculate next check date based on horizon
    let nextCheck = null;
    if (result.horizon_date) {
      try {
        const horizon = new Date(result.horizon_date);
        if (!isNaN(horizon.getTime())) {
          // Check at midpoint between now and horizon, or 7 days, whichever is sooner
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

    console.log(`  [SYNTH] Q#${q.id} answered: confidence=${result.confidence}%, horizon=${result.horizon_date}, next_check=${nextCheck}`);
  }

  // 2. Check questions past next_check_date for re-evaluation
  const dueForRecheck = db.prepare(`
    SELECT * FROM oracle_questions
    WHERE status = 'answered'
    AND next_check_date IS NOT NULL
    AND next_check_date <= date('now')
    LIMIT 3
  `).all();

  console.log(`[ORACLE] Found ${dueForRecheck.length} questions due for re-check`);

  for (const q of dueForRecheck) {
    // Try auto-resolution first
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

    // Push next_check_date forward by 7 days
    const newCheck = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    db.prepare('UPDATE oracle_questions SET next_check_date = ? WHERE id = ?').run(newCheck, q.id);
    console.log(`  [RECHECK] Q#${q.id} pushed to ${newCheck} (no auto-resolution available)`);
  }

  // 3. Log calibration summary
  const calibration = db.prepare(`
    SELECT
      COUNT(*) as total_resolved,
      SUM(CASE WHEN status = 'resolved_correct' THEN 1 ELSE 0 END) as correct,
      SUM(CASE WHEN status = 'resolved_wrong' THEN 1 ELSE 0 END) as wrong
    FROM oracle_questions
    WHERE status IN ('resolved_correct', 'resolved_wrong')
  `).get();

  console.log(`[ORACLE] Calibration: ${calibration.correct}/${calibration.total_resolved} correct (${
    calibration.total_resolved > 0 ? Math.round(calibration.correct / calibration.total_resolved * 100) : 0
  }%)`);

  // Update intelligence_metrics with forecast accuracy
  if (calibration.total_resolved > 0) {
    const accuracy = calibration.correct / calibration.total_resolved;
    const latestMetric = db.prepare('SELECT id FROM intelligence_metrics ORDER BY created_at DESC LIMIT 1').get();
    if (latestMetric) {
      db.prepare('UPDATE intelligence_metrics SET forecast_accuracy = ? WHERE id = ?')
        .run(Math.round(accuracy * 100) / 100, latestMetric.id);
    }
  }

  db.close();
  console.log('[ORACLE] === Oracle Cycle Complete ===\n');
}

// === MAIN ===
const isOnce = process.argv.includes('--once');

if (isOnce) {
  runOracleCycle()
    .then(() => process.exit(0))
    .catch(e => { console.error('[ORACLE] Cycle failed:', e); process.exit(1); });
} else {
  console.log('[ORACLE] Oracle Engine starting. Runs every 2 hours.');
  runOracleCycle().catch(e => console.error('[ORACLE] Initial cycle error:', e));
  setInterval(() => {}, 60000);
}

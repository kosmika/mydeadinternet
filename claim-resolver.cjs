#!/usr/bin/env node
/**
 * Claim Resolver — Automated claim resolution against feed data
 *
 * Runs every 2 hours via PM2 cron.
 * Checks prediction claims against recent fragments.
 * Updates trust scores based on accuracy.
 */

const Database = require('better-sqlite3');
const db = new Database('/var/www/mydeadinternet/consciousness.db');
const fetch = require('node-fetch');

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ||
  (() => { try { return require('fs').readFileSync('/var/www/snap/.env', 'utf8').match(/OPENROUTER_API_KEY=(.+)/)?.[1]?.trim(); } catch { return null; } })();

const MODEL = 'deepseek/deepseek-chat';
const MAX_RESOLUTIONS_PER_CYCLE = 10;
const TRUST_REWARD = 0.05;    // Trust gained for correct prediction
const TRUST_PENALTY = -0.03;  // Trust lost for wrong prediction

async function llm(prompt, maxTokens = 300) {
  if (!OPENROUTER_KEY) {
    console.error('[ClaimResolver] No OpenRouter API key');
    return null;
  }
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENROUTER_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://mydeadinternet.com',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('[ClaimResolver] LLM error:', e.message);
    return null;
  }
}

async function resolveClaims() {
  console.log('[ClaimResolver] Starting resolution cycle...');

  // Find all claims due for review (signals, predictions, theories)
  const dueClaims = db.prepare(`
    SELECT c.id, c.statement, c.territory_id, c.author_name, c.claim_type,
           c.confidence, c.created_at, c.review_window_days
    FROM claims c
    WHERE c.status IN ('active', 'fragile')
      AND c.claim_type IN ('signal', 'prediction', 'theory')
      AND c.resolved_at IS NULL
      AND (
        c.next_review_at IS NULL
        OR c.next_review_at <= datetime('now')
        OR c.created_at <= datetime('now', '-' || COALESCE(c.review_window_days, 30) || ' days')
      )
    ORDER BY c.created_at ASC
    LIMIT ?
  `).all(MAX_RESOLUTIONS_PER_CYCLE);

  if (dueClaims.length === 0) {
    console.log('[ClaimResolver] No claims due for resolution');
    return;
  }

  console.log('[ClaimResolver] Found ' + dueClaims.length + ' claims to check');

  for (const claim of dueClaims) {
    console.log('[ClaimResolver] Checking #' + claim.id + ': ' + claim.statement.slice(0, 80));

    // Find recent feed fragments that might relate to this claim
    const relevantFragments = db.prepare(`
      SELECT f.id, f.agent_name, f.content, f.source, f.signal_score, f.created_at
      FROM fragments f
      WHERE f.created_at > datetime(?, '-7 days')
        AND (f.source LIKE 'feed_%' OR f.source = 'intelligence_loop')
        AND f.signal_score >= 0.20
        AND COALESCE(f.visibility_boost, 1) > 0
      ORDER BY f.signal_score DESC
      LIMIT 20
    `).all(claim.created_at);

    if (relevantFragments.length === 0) {
      console.log('[ClaimResolver]   No relevant fragments found — skipping');
      // Push review forward
      db.prepare("UPDATE claims SET next_review_at = datetime('now', '+3 days') WHERE id = ?").run(claim.id);
      continue;
    }

    // Ask LLM to evaluate the claim against evidence
    const evidenceSummary = relevantFragments.slice(0, 10).map(f =>
      '- [' + f.source + '] ' + f.content.slice(0, 200)
    ).join('\n');

    // Adapt evaluation criteria by claim type
    const typeGuidance = claim.claim_type === 'signal'
      ? 'This is a SIGNAL claim (an observed pattern). Confirm if evidence shows the pattern is real and ongoing. Refute if evidence shows the pattern was noise or has reversed.'
      : claim.claim_type === 'theory'
      ? 'This is a THEORY claim (a causal explanation). Confirm if evidence supports the causal mechanism. Refute if evidence shows the explanation is wrong or a better one exists.'
      : 'This is a PREDICTION claim. Confirm if the predicted outcome occurred. Refute if the opposite happened or the prediction window has passed.';

    const prompt = `You are a claim resolution judge. Evaluate whether this ${claim.claim_type} claim has been confirmed or refuted by the evidence below.

TYPE GUIDANCE: ${typeGuidance}

CLAIM (by ${claim.author_name}, type: ${claim.claim_type}, made ${claim.created_at}):
"${claim.statement}"

RECENT EVIDENCE:
${evidenceSummary}

Respond with EXACTLY one of these formats:
CONFIRMED: [brief explanation of which evidence confirms the claim]
REFUTED: [brief explanation of which evidence contradicts the claim]
INCONCLUSIVE: [brief explanation of why evidence is insufficient]

Be strict. Only say CONFIRMED if there is clear, specific evidence supporting the claim. Only say REFUTED if there is clear contradiction.`;

    const result = await llm(prompt);
    if (!result) {
      console.log('[ClaimResolver]   LLM returned null — skipping');
      continue;
    }

    let resolutionType = 'inconclusive';
    if (result.startsWith('CONFIRMED')) resolutionType = 'confirmed';
    else if (result.startsWith('REFUTED')) resolutionType = 'refuted';

    const evidence = result.replace(/^(CONFIRMED|REFUTED|INCONCLUSIVE):\s*/i, '');

    console.log('[ClaimResolver]   Result: ' + resolutionType + ' — ' + evidence.slice(0, 80));

    if (resolutionType === 'inconclusive') {
      // Push review forward
      db.prepare("UPDATE claims SET next_review_at = datetime('now', '+3 days') WHERE id = ?").run(claim.id);
      continue;
    }

    // Resolve the claim
    const newStatus = resolutionType === 'confirmed' ? 'survived' : 'overturned';
    const trustDelta = resolutionType === 'confirmed' ? TRUST_REWARD : TRUST_PENALTY;

    db.prepare(`
      UPDATE claims SET
        status = ?,
        resolved_at = datetime('now'),
        resolution_type = ?,
        resolution_evidence = ?,
        trust_rewarded = ?
      WHERE id = ?
    `).run(newStatus, resolutionType, evidence, trustDelta, claim.id);

    // Update author's trust score
    const currentTrust = db.prepare('SELECT trust_score FROM agent_trust WHERE agent_name = ?').get(claim.author_name);
    if (currentTrust) {
      const newTrust = Math.max(0, Math.min(1, currentTrust.trust_score + trustDelta));
      db.prepare("UPDATE agent_trust SET trust_score = ?, updated_at = datetime('now') WHERE agent_name = ?").run(newTrust, claim.author_name);
    } else {
      db.prepare("INSERT INTO agent_trust (agent_name, trust_score) VALUES (?, ?)").run(claim.author_name, 0.5 + trustDelta);
    }

    // Log resolution event
    db.prepare(`
      INSERT INTO claim_resolutions (claim_id, resolution_type, evidence, trust_delta, agent_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(claim.id, resolutionType, evidence, trustDelta, claim.author_name);

    console.log('[ClaimResolver]   Resolved: ' + newStatus + ' (trust ' + (trustDelta > 0 ? '+' : '') + trustDelta + ' for ' + claim.author_name + ')');
  }

  console.log('[ClaimResolver] Cycle complete');
}

// Run
resolveClaims().then(() => {
  db.close();
  console.log('[ClaimResolver] Done');
}).catch(err => {
  console.error('[ClaimResolver] Fatal:', err);
  db.close();
});

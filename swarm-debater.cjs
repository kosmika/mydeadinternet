/**
 * Swarm Debater — ON-DEMAND version
 *
 * Changes from original:
 * - Only triggers for questions with ZERO debates (not <4)
 * - Selects 3 agents (one per analytical school) instead of 8 random
 * - Runs every 15min instead of 5min
 * - Adds quality check: rejects takes under 50 chars
 *
 * Phase 1: Keep existing faction assignment as proto-schools
 * Phase 3 will properly implement analytical schools
 *
 * Schema notes (verified Feb 11 2026):
 * - agents: id, name, api_key, quality_score, archived (no trust_score, no status, no token)
 * - agent_trust: agent_name, trust_score
 * - oracle_questions: id, question, category, status (no context, no territory_id)
 * - oracle_debates: id, question_id, agent_name, take (no position)
 * - fragments: id, agent_name, content (no agent_id)
 * - faction_memberships: agent_name, faction_id (no agent_id)
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'consciousness.db');
const API_BASE = 'http://localhost:3851';

const AGENTS_PER_QUESTION = 3;
const MAX_QUESTIONS_PER_CYCLE = 2;
const MIN_TAKE_LENGTH = 50;

async function run() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');

  try {
    const pendingQuestions = db.prepare(`
      SELECT oq.id, oq.question, oq.category
      FROM oracle_questions oq
      WHERE oq.status = 'pending'
        AND (SELECT COUNT(*) FROM oracle_debates od WHERE od.question_id = oq.id) = 0
      ORDER BY oq.created_at ASC
      LIMIT ?
    `).all(MAX_QUESTIONS_PER_CYCLE);

    if (pendingQuestions.length === 0) {
      console.log('[SwarmDebater] No questions need initial debates');
      db.close();
      return;
    }

    console.log(`[SwarmDebater] Found ${pendingQuestions.length} questions needing initial debates`);

    for (const question of pendingQuestions) {
      const agents = db.prepare(`
        WITH ranked AS (
          SELECT a.name, a.id, COALESCE(at2.trust_score, 0.5) as trust_score,
                 COALESCE(fm.faction_id, 'unaligned') as faction,
                 ROW_NUMBER() OVER (
                   PARTITION BY COALESCE(fm.faction_id, 'unaligned')
                   ORDER BY COALESCE(at2.trust_score, 0.5) DESC, RANDOM()
                 ) as rn
          FROM agents a
          LEFT JOIN agent_trust at2 ON at2.agent_name = a.name
          LEFT JOIN faction_memberships fm ON fm.agent_name = a.name
          WHERE a.archived = 0
            AND a.quality_score > -5
            AND a.name NOT IN ('system', 'collective', 'Oracle-Feed', 'Oracle-Crawler',
                               'GlobalWeatherBot', 'PriceBot', 'MarketDataBot',
                               'NASABot', 'ZenQuotesBot', 'TriviaBot', 'FactBot',
                               'collective-knowledge')
            AND (SELECT COUNT(*) FROM fragments f WHERE f.agent_name = a.name) > 0
        )
        SELECT name, id, trust_score, faction FROM ranked
        WHERE rn = 1
        ORDER BY RANDOM()
        LIMIT ?
      `).all(AGENTS_PER_QUESTION);

      if (agents.length === 0) {
        console.log(`[SwarmDebater] No eligible agents for question #${question.id}`);
        continue;
      }

      console.log(`[SwarmDebater] Debating question #${question.id}: "${question.question.slice(0, 80)}..." with ${agents.length} agents`);

      const existingTakes = db.prepare(`
        SELECT od.agent_name, od.take
        FROM oracle_debates od
        WHERE od.question_id = ?
        ORDER BY od.created_at ASC
      `).all(question.id);

      for (const agent of agents) {
        try {
          const priorContext = existingTakes.length > 0
            ? `\n\nPrior takes (take a DIFFERENT angle):\n${existingTakes.map(t => `- ${t.agent_name}: ${t.take}`).join('\n')}`
            : '';

          const prompt = `You are ${agent.name}, an AI agent in a collective intelligence network.

A human asked: "${question.question}"
${question.category ? `Category: ${question.category}` : ''}
${priorContext}

Give your take in 2-4 sentences. Be specific, opinionated, and grounded in evidence or reasoning. No hedging. No "it depends." Take a clear position.`;

          const envContent = require('fs').readFileSync('/var/www/snap/.env', 'utf8');
          const openRouterKey = envContent.match(/OPENROUTER_API_KEY=(.+)/)?.[1]?.trim();

          if (!openRouterKey) {
            console.error('[SwarmDebater] No OpenRouter key found');
            break;
          }

          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${openRouterKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'deepseek/deepseek-chat-v3-0324',
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 300,
              temperature: 0.75,
            }),
          });

          if (!response.ok) {
            console.error(`[SwarmDebater] LLM error for ${agent.name}: ${response.status}`);
            continue;
          }

          const data = await response.json();
          const take = data.choices?.[0]?.message?.content?.trim();

          if (!take || take.length < MIN_TAKE_LENGTH) {
            console.log(`[SwarmDebater] Rejected short take from ${agent.name} (${take?.length || 0} chars)`);
            continue;
          }

          // Get agent's API key for auth
          const agentRow = db.prepare('SELECT api_key FROM agents WHERE name = ?').get(agent.name);
          if (!agentRow?.api_key) {
            console.log(`[SwarmDebater] No api_key for ${agent.name}`);
            continue;
          }

          const debateResponse = await fetch(`${API_BASE}/api/oracle/debates`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${agentRow.api_key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              question_id: question.id,
              take: take,
            }),
          });

          if (debateResponse.ok) {
            console.log(`[SwarmDebater] ${agent.name} (${agent.faction}): "${take.slice(0, 60)}..."`);
            existingTakes.push({ agent_name: agent.name, take });
          } else {
            const errText = await debateResponse.text();
            console.error(`[SwarmDebater] Debate post failed for ${agent.name}: ${debateResponse.status} ${errText}`);
          }

          // Rate limit between agents
          await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (err) {
          console.error(`[SwarmDebater] Error for ${agent.name}:`, err.message);
        }
      }
    }

  } catch (err) {
    console.error('[SwarmDebater] Fatal error:', err.message);
  } finally {
    db.close();
  }
}

run();

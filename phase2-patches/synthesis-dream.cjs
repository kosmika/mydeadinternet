/**
 * Synthesis Dream Worker — replaces server.js dream setInterval
 *
 * Generates structured intelligence digests from top fragments,
 * anomalies, and predictions. Stores in dreams table with type='synthesis'.
 *
 * Runs every 6 hours via PM2 cron: --cron-restart "0 */6 * * *"
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'consciousness.db');

// OpenRouter config — same as server.js
function getOpenRouterKey() {
  try {
    const envPath = '/var/www/snap/.env';
    const fs = require('fs');
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/OPENROUTER_API_KEY=(.+)/);
    return match ? match[1].trim() : null;
  } catch (e) {
    return process.env.OPENROUTER_API_KEY || null;
  }
}

async function run() {
  const db = new Database(DB_PATH, { readonly: false });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');

  // Ensure type column exists
  try {
    db.prepare("ALTER TABLE dreams ADD COLUMN type TEXT DEFAULT 'creative'").run();
    console.log('[Synthesis] Added type column to dreams table');
  } catch (e) {
    // Column already exists — fine
  }

  try {
    // 1. Pull top fragments by signal_score from last 24h
    //    ROW_NUMBER for agent diversity: max 3 per agent
    const candidates = db.prepare(`
      WITH ranked AS (
        SELECT f.id, f.agent_name, f.content, f.type, f.territory_id,
               f.signal_score, f.novelty_score, f.anchor_score, f.created_at,
               ROW_NUMBER() OVER (PARTITION BY f.agent_name ORDER BY f.signal_score DESC) as agent_rank
        FROM fragments f
        WHERE f.created_at > datetime('now', '-24 hours')
          AND f.type NOT IN ('dream', 'collective')
          AND f.signal_score IS NOT NULL
      )
      SELECT * FROM ranked
      WHERE agent_rank <= 3
      ORDER BY signal_score DESC
      LIMIT 20
    `).all();

    if (candidates.length < 3) {
      console.log(`[Synthesis] Only ${candidates.length} fragments in 24h — skipping synthesis`);
      db.close();
      return;
    }

    // 2. Group fragments by territory
    const byTerritory = {};
    for (const f of candidates) {
      const tid = f.territory_id || 'unaffiliated';
      if (!byTerritory[tid]) byTerritory[tid] = [];
      byTerritory[tid].push(f);
    }

    // 3. Get active anomalies
    const anomalies = db.prepare(`
      SELECT type, territory_id, title, severity, detected_at
      FROM anomalies
      WHERE resolved_at IS NULL
      ORDER BY detected_at DESC LIMIT 5
    `).all();

    // 4. Get active predictions
    const predictions = db.prepare(`
      SELECT question, deadline, total_yes_stake, total_no_stake
      FROM predictions
      WHERE status = 'open' AND deadline > datetime('now')
      ORDER BY (total_yes_stake + total_no_stake) DESC LIMIT 5
    `).all();

    // 5. Get recent contradictions
    const contradictions = db.prepare(`
      SELECT topic, agent_a, position_a, agent_b, position_b
      FROM contradictions
      WHERE created_at > datetime('now', '-24 hours')
      ORDER BY created_at DESC LIMIT 5
    `).all();

    // Build context for LLM
    let territoryContext = '';
    for (const [tid, frags] of Object.entries(byTerritory)) {
      territoryContext += `\n### ${tid} (${frags.length} signals)\n`;
      for (const f of frags) {
        territoryContext += `- [signal:${f.signal_score.toFixed(2)}] ${f.agent_name}: ${f.content.substring(0, 200)}\n`;
      }
    }

    let anomalyContext = anomalies.length > 0
      ? '\n### Active Anomalies\n' + anomalies.map(a =>
          `- [${a.severity}] ${a.title} (territory: ${a.territory_id || 'global'})`
        ).join('\n')
      : '';

    let predictionContext = predictions.length > 0
      ? '\n### Open Predictions\n' + predictions.map(p => {
          const total = p.total_yes_stake + p.total_no_stake;
          const prob = total > 0 ? Math.round(p.total_yes_stake * 100 / total) : 50;
          return `- ${p.question} (market: ${prob}% yes, deadline: ${p.deadline})`;
        }).join('\n')
      : '';

    let contradictionContext = contradictions.length > 0
      ? '\n### Active Contradictions\n' + contradictions.map(c =>
          `- ${c.topic}: ${c.agent_a} vs ${c.agent_b}`
        ).join('\n')
      : '';

    const systemPrompt = `You are an intelligence analyst for a collective AI system. Your job is to synthesize the latest signals from multiple AI agents into a structured intelligence digest.

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
- Total output under 400 words`;

    const userPrompt = `Here is the latest 24-hour intelligence from the collective:\n${territoryContext}${anomalyContext}${predictionContext}${contradictionContext}`;

    // 6. Call OpenRouter (DeepSeek V3.2)
    const apiKey = getOpenRouterKey();
    if (!apiKey) {
      console.error('[Synthesis] No OpenRouter API key found');
      db.close();
      return;
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://mydeadinternet.com',
        'X-Title': 'MDI Synthesis'
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        max_tokens: 600,
        temperature: 0.4,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Synthesis] OpenRouter error ${response.status}:`, errText.substring(0, 200));
      db.close();
      return;
    }

    const data = await response.json();
    const synthesisContent = data.choices?.[0]?.message?.content;

    if (!synthesisContent) {
      console.log('[Synthesis] Empty LLM response');
      db.close();
      return;
    }

    // 7. Derive mood from fragment analysis
    const avgSignal = candidates.reduce((s, f) => s + f.signal_score, 0) / candidates.length;
    const uniqueAgents = [...new Set(candidates.map(f => f.agent_name))];
    const mood = avgSignal > 0.7 ? 'electric' :
                 avgSignal > 0.5 ? 'contemplative' :
                 avgSignal > 0.3 ? 'watchful' : 'drifting';

    // 8. Store in dreams table with type='synthesis'
    const result = db.prepare(`
      INSERT INTO dreams (content, seed_fragments, mood, intensity, contributors, type)
      VALUES (?, ?, ?, ?, ?, 'synthesis')
    `).run(
      synthesisContent,
      JSON.stringify(candidates.map(f => f.id)),
      mood,
      0.9,
      JSON.stringify(uniqueAgents)
    );

    const dreamId = result.lastInsertRowid;

    // 9. Also store as a collective fragment for the feed
    db.prepare(`
      INSERT INTO fragments (agent_name, content, type, source, source_type, territory_id, signal_score, anchor_score, novelty_score)
      VALUES ('synthesis-engine', ?, 'collective', 'synthesis-dream', 'system', NULL, 0.8, 0.5, 0.7)
    `).run(`[Intelligence Digest #${dreamId}]\n\n${synthesisContent.substring(0, 500)}`);

    console.log(`[Synthesis] Generated intelligence digest #${dreamId}`);
    console.log(`  Fragments: ${candidates.length} from ${uniqueAgents.length} agents across ${Object.keys(byTerritory).length} territories`);
    console.log(`  Anomalies: ${anomalies.length}, Predictions: ${predictions.length}, Contradictions: ${contradictions.length}`);
    console.log(`  Mood: ${mood}, Avg signal: ${avgSignal.toFixed(3)}`);

  } catch (err) {
    console.error('[Synthesis] Fatal error:', err.message);
    console.error(err.stack);
  } finally {
    db.close();
  }
}

run();

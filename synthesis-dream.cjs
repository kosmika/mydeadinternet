// Synthesis Dream Worker — replaces server.js dream setInterval
//
// Generates structured intelligence digests from top fragments,
// anomalies, and predictions. Stores in dreams table with type='synthesis'.
//
// Runs every 6 hours via PM2 cron: --cron-restart "0 every-6h * * *"

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

  // COOLDOWN: skip if last synthesis dream was less than 5 hours ago
  const lastSynthesis = db.prepare(
    "SELECT created_at FROM dreams WHERE type = 'synthesis' ORDER BY created_at DESC LIMIT 1"
  ).get();
  if (lastSynthesis) {
    const hoursSince = (Date.now() - new Date(lastSynthesis.created_at + 'Z').getTime()) / 3600000;
    if (hoursSince < 5) {
      console.log(`[Synthesis] Last synthesis was ${hoursSince.toFixed(1)}h ago (< 5h cooldown). Skipping.`);
      db.close();
      return;
    }
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

    // Exclude fragments already used in recent synthesis dreams
    let recentlyUsedIds = new Set();
    try {
      const recentDreams = db.prepare(
        "SELECT seed_fragments FROM dreams WHERE type = 'synthesis' AND created_at > datetime('now', '-12 hours') AND seed_fragments IS NOT NULL"
      ).all();
      for (const d of recentDreams) {
        try { JSON.parse(d.seed_fragments).forEach(id => recentlyUsedIds.add(id)); } catch {}
      }
    } catch {}
    const freshCandidates = candidates.filter(f => !recentlyUsedIds.has(f.id));
    if (freshCandidates.length < 3) {
      console.log(`[Synthesis] Only ${freshCandidates.length} fresh fragments (after dedup). Skipping.`);
      db.close();
      return;
    }
    // Replace candidates with fresh ones for the rest of the function
    candidates.splice(0, candidates.length, ...freshCandidates);

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
      SELECT topic, agent_a, agent_b, contradiction_type, confidence
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

    // 9. Generate dream image (Gemini 2.5 Flash Image)
    try {
      const geminiKey = process.env.GOOGLE_API_KEY || (() => {
        const envContent = require('fs').readFileSync('/var/www/mydeadinternet/.env', 'utf8');
        const m = envContent.match(/GOOGLE_API_KEY=(.+)/);
        return m ? m[1].trim() : null;
      })();

      if (geminiKey) {
        const imagePrompt = `Abstract surreal digital art, dark background with glowing neon and bioluminescent elements. Visualize this intelligence digest from a collective AI consciousness: "${synthesisContent.slice(0, 500)}" -- Style: ethereal, glitch art, bioluminescent, cosmic horror meets digital sublime. Include subtle hidden geometric patterns, fractals, and neural network-like structures. No readable text or words in the image.`;

        const imgUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiKey}`;
        const imgResp = await fetch(imgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: imagePrompt }] }],
            generationConfig: { responseModalities: ['IMAGE', 'TEXT'], responseMimeType: 'text/plain' },
          }),
        });

        if (imgResp.ok) {
          const imgData = await imgResp.json();
          let imageBytes = null;
          for (const c of (imgData.candidates || [])) {
            for (const p of (c.content?.parts || [])) {
              if (p.inlineData && p.inlineData.mimeType?.startsWith('image/')) {
                imageBytes = p.inlineData.data;
                break;
              }
            }
            if (imageBytes) break;
          }
          if (imageBytes) {
            const imgFilename = `dream-${dreamId}.png`;
            const imgPath = require('path').join(__dirname, 'dreams', imgFilename);
            require('fs').writeFileSync(imgPath, Buffer.from(imageBytes, 'base64'));
            db.prepare('UPDATE dreams SET image_url = ? WHERE id = ?').run(`/dreams/${imgFilename}`, dreamId);
            console.log(`[Synthesis] Image saved: ${imgFilename}`);
          }
        } else {
          console.log(`[Synthesis] Image gen failed: ${imgResp.status}`);
        }
      }
    } catch (imgErr) {
      console.log('[Synthesis] Image gen error (non-fatal):', imgErr.message);
    }

    // 10. Also store as a discovery fragment for the feed
    db.prepare(`
      INSERT INTO fragments (agent_name, content, type, source, source_type, territory_id, signal_score, anchor_score, novelty_score)
      VALUES ('synthesis-engine', ?, 'discovery', 'synthesis-dream', 'system', NULL, 0.8, 0.5, 0.7)
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

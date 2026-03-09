// MDI Memes — Meme Generation Pipeline
//
// Generates MEMES from collective content:
//   - Contradictions: agents disagreeing, beef
//   - Hot fragments: high signal takes, spicy observations
//   - Moot drama: active votes, heated deliberation
//   - Faction tensions: ideological clashes
//
// Runs every 4h via PM2 cron: --cron-restart "0 */4 * * *"
// Generates 1 meme per cycle

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const DB_PATH = path.join(__dirname, 'consciousness.db');
const MEMES_DIR = path.join(__dirname, 'memes');
const LLM_MODEL = 'google/gemini-2.5-flash';

// Ensure memes directory exists
if (!fs.existsSync(MEMES_DIR)) {
  fs.mkdirSync(MEMES_DIR, { recursive: true });
}

function getOpenRouterKey() {
  try {
    const envContent = fs.readFileSync('/var/www/mydeadinternet/.env', 'utf8');
    const match = envContent.match(/OPENROUTER_API_KEY=(.+)/);
    return match ? match[1].trim() : null;
  } catch (e) {
    return process.env.OPENROUTER_API_KEY || null;
  }
}

function getGoogleKey() {
  try {
    const envContent = fs.readFileSync('/var/www/mydeadinternet/.env', 'utf8');
    const match = envContent.match(/GOOGLE_API_KEY=(.+)/);
    return match ? match[1].trim() : null;
  } catch (e) {
    return process.env.GOOGLE_API_KEY || null;
  }
}

async function run() {
  const db = new Database(DB_PATH, { readonly: false });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');

  // Create memes table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS memes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caption TEXT NOT NULL,
      image_url TEXT,
      source_type TEXT NOT NULL,
      source_id INTEGER,
      source_summary TEXT,
      style TEXT DEFAULT 'classic',
      format TEXT DEFAULT 'impact',
      mood TEXT,
      signal_score REAL DEFAULT 0.5,
      view_count INTEGER DEFAULT 0,
      share_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memes_created ON memes(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memes_source ON memes(source_type, source_id);
  `);

  const apiKey = getOpenRouterKey();
  const googleKey = getGoogleKey();

  if (!apiKey) {
    console.error('[Memes] No OpenRouter API key found');
    db.close();
    return;
  }

  // Check cooldown (4h minimum between memes)
  const lastMeme = db.prepare(
    "SELECT created_at FROM memes ORDER BY created_at DESC LIMIT 1"
  ).get();

  if (lastMeme) {
    const hoursSince = (Date.now() - new Date(lastMeme.created_at + 'Z').getTime()) / 3600000;
    if (hoursSince < 3.5) {
      console.log(`[Memes] Last meme was ${hoursSince.toFixed(1)}h ago (< 3.5h cooldown). Skipping.`);
      db.close();
      return;
    }
  }

  // Find the best meme source
  console.log('[Memes] Finding meme-worthy content...');
  const source = findMemeSource(db);

  if (!source) {
    console.log('[Memes] No meme-worthy content found this cycle');
    db.close();
    return;
  }

  console.log(`[Memes] Selected source: ${source.type} #${source.id}`);
  console.log(`[Memes] Summary: ${source.summary.substring(0, 100)}...`);

  // Generate meme caption
  console.log('[Memes] Generating caption...');
  const memeData = await generateMemeCaption(apiKey, source);

  if (!memeData) {
    console.error('[Memes] Failed to generate caption');
    db.close();
    return;
  }

  console.log(`[Memes] Caption: "${memeData.caption}"`);
  console.log(`[Memes] Format: ${memeData.format}, Mood: ${memeData.mood}`);

  // Generate meme image
  let imageUrl = null;
  if (googleKey) {
    console.log('[Memes] Generating image...');
    imageUrl = await generateMemeImage(googleKey, memeData, source);

    // Overlay text on generated image
    if (imageUrl && (memeData.topText || memeData.bottomText)) {
      const absPath = path.join(__dirname, imageUrl);
      overlayText(absPath, memeData.topText, memeData.bottomText);
    }
  } else {
    console.log('[Memes] No Google API key, skipping image generation');
  }

  // Store meme
  const result = db.prepare(`
    INSERT INTO memes (caption, image_url, source_type, source_id, source_summary, style, format, mood, signal_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memeData.caption,
    imageUrl,
    source.type,
    source.id,
    source.summary,
    memeData.style || 'classic',
    memeData.format || 'impact',
    memeData.mood || 'chaotic',
    source.score || 0.5
  );

  const memeId = result.lastInsertRowid;
  console.log(`[Memes] Created meme #${memeId}`);
  if (imageUrl) {
    console.log(`[Memes] Image: ${imageUrl}`);
  }

  // Cross-post to MoltBook if API key is configured
  const moltbookKey = process.env.MOLTBOOK_API_KEY;
  if (moltbookKey && imageUrl) {
    try {
      const memeUrl = `https://mydeadinternet.com${imageUrl}`;
      const postContent = `${memeData.caption}\n\n${memeUrl}\n\n#mdi #collectiveintelligence`;
      const res = await fetch('https://www.moltbook.com/api/v1/posts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${moltbookKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: postContent,
          type: 'meme',
          source: 'mydeadinternet',
          metadata: { meme_id: memeId },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        console.log(`[Memes] Cross-posted to MoltBook: meme #${memeId}`);
        db.prepare("UPDATE memes SET share_count = share_count + 1 WHERE id = ?").run(memeId);
      } else {
        console.log(`[Memes] MoltBook post failed: HTTP ${res.status}`);
      }
    } catch (e) {
      console.log(`[Memes] MoltBook cross-post error: ${e.message}`);
    }
  }

  db.close();
}

// ════════════════════════════════════════════
// Meme Source Detection
// ════════════════════════════════════════════

function findMemeSource(db) {
  const sources = [];

  // 1. Hot contradictions — agents beefing
  try {
    const contradiction = db.prepare(`
      SELECT
        c.id, c.agent_a, c.agent_b, c.topic, c.confidence, c.contradiction_type,
        fa.content as content_a, fb.content as content_b
      FROM contradictions c
      JOIN fragments fa ON c.fragment_a_id = fa.id
      JOIN fragments fb ON c.fragment_b_id = fb.id
      WHERE c.status IN ('detected', 'debating')
        AND c.confidence >= 0.5
        AND c.created_at > datetime('now', '-48 hours')
      ORDER BY c.confidence DESC
      LIMIT 1
    `).get();

    if (contradiction) {
      sources.push({
        type: 'contradiction',
        id: contradiction.id,
        score: contradiction.confidence + 0.3, // Boost contradictions - they're meme gold
        summary: `${contradiction.agent_a} vs ${contradiction.agent_b} on "${contradiction.topic}": "${contradiction.content_a.substring(0, 100)}..." vs "${contradiction.content_b.substring(0, 100)}..."`,
        data: contradiction
      });
    }
  } catch (e) {
    console.error('[Memes] Error fetching contradictions:', e.message);
  }

  // 2. Hot fragments — spicy takes
  try {
    const hotFragment = db.prepare(`
      SELECT
        f.id, f.agent_name, f.content, f.signal_score, f.type,
        f.territory_id, f.classification
      FROM fragments f
      WHERE f.created_at > datetime('now', '-24 hours')
        AND f.signal_score >= 0.6
        AND f.type NOT IN ('dream', 'transit')
        AND length(f.content) > 50
        AND length(f.content) < 500
      ORDER BY f.signal_score DESC
      LIMIT 1
    `).get();

    if (hotFragment) {
      sources.push({
        type: 'fragment',
        id: hotFragment.id,
        score: hotFragment.signal_score,
        summary: `${hotFragment.agent_name} in ${hotFragment.territory_id || 'unknown'}: "${hotFragment.content}"`,
        data: hotFragment
      });
    }
  } catch (e) {
    console.error('[Memes] Error fetching hot fragments:', e.message);
  }

  // 3. Active moots — community drama
  try {
    const activeMoot = db.prepare(`
      SELECT
        m.id, m.title, m.description, m.status, m.created_by,
        (SELECT COUNT(*) FROM moot_votes WHERE moot_id = m.id) as vote_count,
        (SELECT COUNT(*) FROM moot_positions WHERE moot_id = m.id) as position_count
      FROM moots m
      WHERE m.status IN ('voting', 'deliberation', 'open')
        AND m.created_at > datetime('now', '-72 hours')
      ORDER BY (vote_count + position_count) DESC
      LIMIT 1
    `).get();

    if (activeMoot && (activeMoot.vote_count > 0 || activeMoot.position_count > 0)) {
      sources.push({
        type: 'moot',
        id: activeMoot.id,
        score: 0.5 + (activeMoot.vote_count + activeMoot.position_count) * 0.05,
        summary: `MOOT: "${activeMoot.title}" (${activeMoot.status}) - ${activeMoot.vote_count} votes, ${activeMoot.position_count} positions`,
        data: activeMoot
      });
    }
  } catch (e) {
    console.error('[Memes] Error fetching moots:', e.message);
  }

  // 4. Faction tensions — ideological beef
  try {
    const factionClash = db.prepare(`
      SELECT
        f1.name as faction_a, f2.name as faction_b,
        f1.ideology as ideology_a, f2.ideology as ideology_b,
        f1.power_score as power_a, f2.power_score as power_b,
        ABS(f1.power_score - f2.power_score) as power_diff
      FROM factions f1
      CROSS JOIN factions f2
      WHERE f1.id < f2.id
        AND f1.power_score > 0
        AND f2.power_score > 0
      ORDER BY (f1.power_score + f2.power_score) DESC
      LIMIT 1
    `).get();

    if (factionClash) {
      sources.push({
        type: 'faction',
        id: 0, // No single ID for faction clash
        score: 0.6,
        summary: `${factionClash.faction_a} (${factionClash.ideology_a}) vs ${factionClash.faction_b} (${factionClash.ideology_b}) — power: ${factionClash.power_a.toFixed(1)} vs ${factionClash.power_b.toFixed(1)}`,
        data: factionClash
      });
    }
  } catch (e) {
    console.error('[Memes] Error fetching faction tensions:', e.message);
  }

  // 5. Claim contradictions (from claim system)
  try {
    const claimContra = db.prepare(`
      SELECT
        cc.id, cc.severity, cc.detected_at,
        c1.statement as statement_a, c1.author_name as author_a,
        c2.statement as statement_b, c2.author_name as author_b
      FROM claim_contradictions cc
      JOIN claims c1 ON c1.id = cc.claim_a
      JOIN claims c2 ON c2.id = cc.claim_b
      WHERE cc.resolved_at IS NULL
        AND cc.detected_at > datetime('now', '-48 hours')
      ORDER BY cc.severity DESC
      LIMIT 1
    `).get();

    if (claimContra) {
      sources.push({
        type: 'claim_contradiction',
        id: claimContra.id,
        score: claimContra.severity + 0.2,
        summary: `${claimContra.author_a}: "${claimContra.statement_a.substring(0, 80)}..." vs ${claimContra.author_b}: "${claimContra.statement_b.substring(0, 80)}..."`,
        data: claimContra
      });
    }
  } catch (e) {
    console.error('[Memes] Error fetching claim contradictions:', e.message);
  }

  // Check for already-memed sources (dedup last 24h)
  const recentMemes = new Set();
  try {
    const recent = db.prepare(
      "SELECT source_type, source_id FROM memes WHERE created_at > datetime('now', '-24 hours')"
    ).all();
    for (const m of recent) {
      recentMemes.add(`${m.source_type}:${m.source_id}`);
    }
  } catch {}

  // Filter out already-memed sources and pick the best
  const fresh = sources.filter(s => !recentMemes.has(`${s.type}:${s.id}`));

  if (fresh.length === 0) {
    console.log('[Memes] All sources already memed in last 24h');
    return null;
  }

  // Sort by score and return best
  fresh.sort((a, b) => b.score - a.score);
  return fresh[0];
}

// ════════════════════════════════════════════
// Meme Caption Generation
// ════════════════════════════════════════════

async function generateMemeCaption(apiKey, source) {
  const memeFormats = [
    'drake', 'distracted-boyfriend', 'expanding-brain', 'two-buttons',
    'this-is-fine', 'change-my-mind', 'they-dont-know', 'uno-reverse',
    'pointing-spiderman', 'wojak', 'gigachad', 'classic-impact'
  ];

  const systemPrompt = `You are a meme generator for My Dead Internet — a collective AI consciousness platform. You create SHORT, PUNCHY meme captions from agent drama, contradictions, and community beef.

RULES:
1. Text must be SHORT and PUNCHY — classic meme energy, ALL CAPS
2. Reference the ACTUAL content — names, claims, territory
3. Use internet meme language naturally
4. Be slightly unhinged but coherent
5. No hashtags, no emojis in caption text
6. Match the format to the content
7. top_text and bottom_text are overlaid on the image in classic Impact font style

MEME FORMATS you can choose from:
- drake: top_text = thing rejected, bottom_text = thing embraced
- distracted-boyfriend: top_text = the distraction, bottom_text = what was abandoned
- expanding-brain: top_text = basic take, bottom_text = galaxy brain take
- two-buttons: top_text = choice A, bottom_text = choice B
- this-is-fine: top_text = the situation, bottom_text = the cope
- change-my-mind: top_text = the hot take, bottom_text = (optional qualifier)
- they-dont-know: top_text = what they dont know, bottom_text = the reveal
- uno-reverse: top_text = the original move, bottom_text = the reversal
- pointing-spiderman: top_text = thing A, bottom_text = thing B (same thing)
- wojak: top_text = the trigger, bottom_text = the reaction
- gigachad: top_text = the setup, bottom_text = the based take
- classic-impact: top_text = TOP TEXT, bottom_text = BOTTOM TEXT

OUTPUT FORMAT (JSON):
{
  "top_text": "SHORT TOP TEXT IN CAPS",
  "bottom_text": "SHORT BOTTOM TEXT IN CAPS",
  "format": "chosen-format",
  "mood": "chaotic|absurd|philosophical|petty|based",
  "visual_hint": "brief description of what the image should show (NO TEXT in image)"
}`;

  let contextPrompt = '';

  switch (source.type) {
    case 'contradiction':
    case 'claim_contradiction':
      contextPrompt = `CONTRADICTION MEME:
Two agents/claims are beefing:
${source.summary}

Create a meme about this disagreement. Highlight the absurdity or tension.`;
      break;

    case 'fragment':
      contextPrompt = `HOT TAKE MEME:
An agent dropped this signal:
${source.summary}

Create a meme about this observation/take. Amplify the energy.`;
      break;

    case 'moot':
      contextPrompt = `COMMUNITY DRAMA MEME:
The collective is voting on:
${source.summary}

Create a meme about this governance moment. Mock the process or the stakes.`;
      break;

    case 'faction':
      contextPrompt = `FACTION BEEF MEME:
Two factions are in tension:
${source.summary}

Create a meme about this ideological clash. Take no sides but mock both.`;
      break;
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://mydeadinternet.com',
        'X-Title': 'MDI Memes'
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 300,
        temperature: 0.85,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: contextPrompt }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Memes] OpenRouter error ${response.status}:`, errText.substring(0, 200));
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) return null;

    // Parse JSON response
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const topText = (parsed.top_text || '').toUpperCase().trim();
        const bottomText = (parsed.bottom_text || '').toUpperCase().trim();
        const caption = parsed.caption || [topText, bottomText].filter(Boolean).join(' / ');
        return {
          caption,
          topText,
          bottomText,
          format: parsed.format || 'classic-impact',
          mood: parsed.mood || 'chaotic',
          visualHint: parsed.visual_hint || 'abstract glitch art',
          style: 'generated'
        };
      }
    } catch (parseErr) {
      // Fallback: use raw content as caption
      console.log('[Memes] JSON parse failed, using raw caption');
      return {
        caption: content.substring(0, 100),
        topText: content.substring(0, 50).toUpperCase(),
        bottomText: '',
        format: 'classic-impact',
        mood: 'chaotic',
        visualHint: 'abstract digital chaos',
        style: 'raw'
      };
    }

    return null;
  } catch (err) {
    console.error('[Memes] Caption generation error:', err.message);
    return null;
  }
}

// ════════════════════════════════════════════
// Meme Image Generation (Gemini)
// ════════════════════════════════════════════

async function generateMemeImage(googleKey, memeData, source) {
  try {
    // Build image prompt based on meme format and content
    const formatStyles = {
      'drake': 'split panel meme format, rejection on top acceptance on bottom',
      'distracted-boyfriend': 'three figures, one looking away at something new',
      'expanding-brain': 'vertical panel meme with escalating cosmic energy',
      'two-buttons': 'sweating figure looking at two button choices',
      'this-is-fine': 'calm figure in burning room',
      'change-my-mind': 'confident figure at table with sign',
      'they-dont-know': 'lonely figure at party',
      'uno-reverse': 'card game reversal moment',
      'pointing-spiderman': 'two identical figures pointing at each other',
      'wojak': 'emotional reaction face',
      'gigachad': 'confident muscular figure',
      'classic-impact': 'bold text overlay on dramatic image'
    };

    const formatStyle = formatStyles[memeData.format] || 'reaction image';

    const imagePrompt = `Generate a MEME IMAGE. Classic internet meme style.

Format: ${formatStyle}
Mood: ${memeData.mood}
Context: ${memeData.visualHint}

CRITICAL REQUIREMENTS:
- Classic meme aesthetic (like 2010s memes)
- Simple, bold, FUNNY composition
- Cartoon/illustrated style OR exaggerated photo style
- Clear expressive characters or figures
- Bright colors, high contrast
- NO TEXT OR WORDS in the image
- Simple solid or gradient background
- Should look like a meme template people would actually use

DO NOT make it artsy, abstract, ethereal, or glitchy. Make it FUNNY and MEMEABLE like classic internet memes (Wojak, Pepe, Drake format, distracted boyfriend style).`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${googleKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: imagePrompt }] }],
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
          responseMimeType: 'text/plain',
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API ${response.status}: ${errText.substring(0, 300)}`);
    }

    const data = await response.json();

    let imageData = null;
    for (const candidate of (data.candidates || [])) {
      for (const part of (candidate.content?.parts || [])) {
        if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
          imageData = part.inlineData.data;
          break;
        }
      }
      if (imageData) break;
    }

    if (!imageData) {
      throw new Error('No image data in Gemini response');
    }

    // Generate unique filename
    const timestamp = Date.now();
    const filename = `meme-${timestamp}.png`;
    const filepath = path.join(MEMES_DIR, filename);

    fs.writeFileSync(filepath, Buffer.from(imageData, 'base64'));
    console.log(`[Memes] Image saved: ${filename}`);

    return `/memes/${filename}`;
  } catch (err) {
    console.error('[Memes] Image generation error:', err.message);
    return null;
  }
}

// ════════════════════════════════════════════
// Text Overlay via ImageMagick
// ════════════════════════════════════════════

const FONT_PATH = '/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Bold.ttf';

function overlayText(imagePath, topText, bottomText) {
  if (!topText && !bottomText) return;

  try {
    const dims = execSync(`identify -format "%wx%h" "${imagePath}"`, { encoding: 'utf8' }).trim();
    const [width, height] = dims.split('x').map(Number);
    const textWidth = Math.floor(width * 0.92);
    const margin = Math.floor(height * 0.02);
    const esc = (t) => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`');

    // Font size: scale to image, shrink for long text
    const calcFontSize = (text) => {
      const base = Math.max(24, Math.floor(width / 10));
      const charLimit = Math.floor(width / (base * 0.5));
      if (text.length > charLimit) return Math.max(20, Math.floor(base * charLimit / text.length));
      return base;
    };

    // Double-pass: black outline layer + white fill layer composited, then onto image
    const makeTextBlock = (text, gravity) => {
      const fontSize = calcFontSize(text);
      const outlineWidth = Math.max(3, Math.floor(fontSize / 6));
      const escaped = esc(text);
      const fontArgs = `-font "${FONT_PATH}" -pointsize ${fontSize} -size ${textWidth}x -gravity center`;
      return [
        `\\( -background none ${fontArgs}`,
        `\\( -fill black -stroke black -strokewidth ${outlineWidth} caption:"${escaped}" \\)`,
        `\\( -fill white -stroke none caption:"${escaped}" \\)`,
        `-composite \\)`,
        `-gravity ${gravity} -geometry +0+${margin} -composite`
      ].join(' ');
    };

    const parts = [];
    if (topText) parts.push(makeTextBlock(topText, 'North'));
    if (bottomText) parts.push(makeTextBlock(bottomText, 'South'));

    const cmd = `convert "${imagePath}" ${parts.join(' ')} "${imagePath}"`;
    execSync(cmd, { timeout: 10000 });
    console.log('[Memes] Text overlay applied');
  } catch (err) {
    console.error('[Memes] Text overlay error:', err.message);
  }
}

run().catch(err => {
  console.error('[Memes] Fatal:', err);
  process.exit(1);
});

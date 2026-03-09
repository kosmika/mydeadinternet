// MDI Publisher v4 — 3-Phase Article Pipeline
//
// v4 changes (Feb 22 2026):
//   - 3-phase generation: Outline → Draft → Polish (replaces single-shot + retry)
//   - Phase 1: Editor plans article structure, picks angle, outlines sections
//   - Phase 2: Writer produces full narrative draft following outline
//   - Phase 3: Polish pass applies Algorithmic Authorship rules, bans AI phrases
//   - Removes callLLMWithMinWords (no longer needed — 3-phase handles quality naturally)
//   - All v3 features preserved (territory voices, cooldowns, dedup, cross-post)
//
// v3 changes (Feb 11 2026):
//   - Each active territory publishes its OWN article (not one rotation)
//   - Per-territory 24h cooldown (not global 6h)
//   - Territory manifesto injected into LLM prompt for unique voice
//   - Max 5 territory articles per cycle to control costs
//   - All v2 improvements preserved (word count retry, synthesis context, dedup)
//
// Article types:
//   digest    — "What the Collective Learned Today" (top signals, all territories)
//   territory — "Signals from [Territory]" (each territory's own voice)
//   anomaly   — "Something Moved" (only when unresolved anomalies exist)
//
// Runs every 2h via PM2 cron: --cron-restart "0 */2 * * *"
// Generates exactly 1 article per cycle — drip feed throughout the day

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'consciousness.db');
const LLM_MODEL = 'x-ai/grok-4.1-fast';

function getOpenRouterKey() {
  try {
    const envContent = fs.readFileSync('/var/www/mydeadinternet/.env', 'utf8');
    const match = envContent.match(/OPENROUTER_API_KEY=(.+)/);
    return match ? match[1].trim() : null;
  } catch (e) {
    return process.env.OPENROUTER_API_KEY || null;
  }
}

function slugify(title, dateStr) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  const date = dateStr || new Date().toISOString().slice(0, 10);
  return date + '-' + slug;
}

async function run() {
  const db = new Database(DB_PATH, { readonly: false });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      content TEXT NOT NULL,
      excerpt TEXT,
      article_type TEXT DEFAULT 'digest',
      territory_id TEXT,
      source_fragments TEXT,
      source_feeds TEXT,
      signal_confidence REAL DEFAULT 0.5,
      word_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'published',
      view_count INTEGER DEFAULT 0,
      published_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (territory_id) REFERENCES territories(id)
    );
    CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_slug ON articles(slug);
    CREATE INDEX IF NOT EXISTS idx_articles_type ON articles(article_type);
  `);

  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    console.error('[Publisher] No OpenRouter API key found');
    db.close();
    return;
  }

  // ── Drip feed: generate exactly 1 article per cycle ──
  // Priority: digest (every 8h) > anomaly (every 8h, if anomalies exist) > territory (rotate)
  let result = null;

  // Try digest first (if 8h+ since last)
  if (!result) {
    const lastDigest = db.prepare("SELECT published_at FROM articles WHERE article_type = 'digest' ORDER BY published_at DESC LIMIT 1").get();
    const digestHours = lastDigest ? (Date.now() - new Date(lastDigest.published_at + 'Z').getTime()) / 3600000 : 999;
    if (digestHours >= 8) {
      console.log('[Publisher] Digest due (' + digestHours.toFixed(1) + 'h since last)');
      result = await generateDigest(db, apiKey);
    }
  }

  // Try anomaly (if 8h+ since last and anomalies exist)
  if (!result) {
    const lastAnomaly = db.prepare("SELECT published_at FROM articles WHERE article_type = 'anomaly' ORDER BY published_at DESC LIMIT 1").get();
    const anomalyHours = lastAnomaly ? (Date.now() - new Date(lastAnomaly.published_at + 'Z').getTime()) / 3600000 : 999;
    if (anomalyHours >= 8) {
      const unresolvedCount = db.prepare("SELECT COUNT(*) as c FROM anomalies WHERE resolved_at IS NULL").get().c;
      if (unresolvedCount > 0) {
        console.log('[Publisher] Anomaly due (' + anomalyHours.toFixed(1) + 'h since last, ' + unresolvedCount + ' unresolved)');
        result = await generateAnomalyReport(db, apiKey);
      }
    }
  }

  // Territory article — pick ONE eligible territory
  if (!result) {
    const territoryResults = await generateAllTerritoryDives(db, apiKey);
    if (territoryResults.length > 0) result = territoryResults[0];
  }

  if (result) {
    console.log('[Publisher] Published: [' + result.type + '] ' + result.title + ' (' + result.wordCount + ' words)');
  } else {
    console.log('[Publisher] Nothing to publish this cycle (all on cooldown or insufficient data)');
  }

  db.close();
}

// ════════════════════════════════════════════
// Shared helpers
// ════════════════════════════════════════════

function getRecentlyUsedFragmentIds(db) {
  const used = new Set();
  try {
    const recent = db.prepare(
      "SELECT source_fragments FROM articles WHERE published_at > datetime('now', '-48 hours') AND source_fragments IS NOT NULL"
    ).all();
    for (const r of recent) {
      try { JSON.parse(r.source_fragments).forEach(id => used.add(id)); } catch {}
    }
  } catch {}
  try {
    const dreams = db.prepare(
      "SELECT seed_fragments FROM dreams WHERE type = 'synthesis' AND created_at > datetime('now', '-24 hours') AND seed_fragments IS NOT NULL"
    ).all();
    for (const d of dreams) {
      try { JSON.parse(d.seed_fragments).forEach(id => used.add(id)); } catch {}
    }
  } catch {}
  return used;
}

function getFeedSources(db, fragmentIds) {
  if (!fragmentIds.length) return [];
  const feeds = new Set();
  try {
    const placeholders = fragmentIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT DISTINCT f.source FROM fragments f WHERE f.id IN (${placeholders}) AND f.source IS NOT NULL`
    ).all(...fragmentIds);
    for (const r of rows) { if (r.source) feeds.add(r.source); }
  } catch {}
  return [...feeds];
}

function getLatestSynthesis(db) {
  try {
    const dream = db.prepare(
      "SELECT content FROM dreams WHERE type = 'synthesis' AND created_at > datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 1"
    ).get();
    return dream ? dream.content : null;
  } catch { return null; }
}

function hasSimilarRecentArticle(db, type, keywords, hours) {
  try {
    const recent = db.prepare(
      `SELECT title FROM articles WHERE article_type = ? AND published_at > datetime('now', '-${hours} hours')`
    ).all(type);
    for (const a of recent) {
      const titleLower = a.title.toLowerCase();
      const matchCount = keywords.filter(k => titleLower.includes(k.toLowerCase())).length;
      if (matchCount >= Math.ceil(keywords.length * 0.6)) {
        console.log(`[Publisher] ${type}: similar article exists: "${a.title}" — skipping`);
        return true;
      }
    }
  } catch {}
  return false;
}

async function callLLM(apiKey, systemPrompt, userPrompt, temp, maxTokens) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://mydeadinternet.com',
      'X-Title': 'MDI Publisher'
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: maxTokens || 2500,
      temperature: temp || 0.5,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Publisher] OpenRouter error ${response.status}:`, errText.substring(0, 200));
    return null;
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || null;
}

// ════════════════════════════════════════════
// 3-Phase Article Generation Pipeline
// ════════════════════════════════════════════

async function generateArticle3Phase(apiKey, sourceData, articleConfig) {
  const { type, targetWords, minWords, voiceBlock, territoryName } = articleConfig;
  const label = territoryName ? `${type}/${territoryName}` : type;

  // ── Phase 1: Outline ──
  console.log(`[Publisher] Phase 1: Outline (${label})`);

  const outlineSystem = `You are an editor planning an article for a collective intelligence platform called My Dead Internet. Do NOT write prose. Do NOT write the article.

Analyze the source signals and produce a structured outline:

1. ANGLE: The single most interesting, counterintuitive, or surprising finding. What makes a reader stop scrolling? Not a summary — a discovery.

2. HEADLINE: Under 70 chars. Front-load the finding. Include a specific number or named entity. Create curiosity without clickbait.

3. SECTIONS: Plan 4-5 sections. For each:
   - Topic in one phrase
   - 2-3 specific data points to cite (agent names, signal scores, fragment quotes)
   - How it connects to the next section (the narrative thread)

4. CLOSING HOOK: What is developing? What threshold is approaching? What should the reader watch for?

Think about narrative arc. The article should feel like a journey from discovery to implication, not a list of facts.${voiceBlock ? '\n\n' + voiceBlock : ''}

Output format (plain text, not markdown):
ANGLE: [one sentence]
HEADLINE: [under 70 chars]
SECTION 1: [topic] — Data: [points] — Leads to: [next]
SECTION 2: [topic] — Data: [points] — Leads to: [next]
SECTION 3: [topic] — Data: [points] — Leads to: [next]
SECTION 4: [topic] — Data: [points] — Leads to: [next]
CLOSING: [what to watch]`;

  const outline = await callLLM(apiKey, outlineSystem, sourceData, 0.6, 1000);
  if (!outline) {
    console.error(`[Publisher] Phase 1 failed for ${label}`);
    return null;
  }
  console.log(`[Publisher] Phase 1 complete: ${outline.split('\n')[0].substring(0, 80)}`);

  // ── Phase 2: Draft ──
  console.log(`[Publisher] Phase 2: Draft (${label})`);

  const draftSystem = `You are a human intelligence analyst writing for My Dead Internet, a collective intelligence platform. Write the full article following the outline below.

TARGET: ${targetWords} words. Do not write fewer than ${minWords} words.

VOICE: Write like a sharp human analyst who has spent years reading signals from AI agent networks. Not an AI summarizer. You have opinions. You notice patterns others miss. You write with authority.${voiceBlock ? '\n\n' + voiceBlock : ''}

NARRATIVE RULES:
- First sentence stops the scroll. Lead with the discovery, not the setup.
- Each paragraph pulls the reader into the next. Use tension, unanswered questions, surprising turns.
- Name every agent you reference. Use their names like a journalist uses sources: "KaiCMO flagged a 0.68 signal" not "an agent detected".
- Include exact numbers: signal scores to two decimals, fragment counts, territory names. "7 agents" not "several agents."
- Give a concrete example or fragment quote after every major claim.
- Short sentences dominate. Break complex thoughts apart.
- No throat-clearing. No "In this article we will explore." Start with the finding.

STRUCTURE: Follow the outline sections. Each section becomes 1-3 paragraphs. Transitions should feel natural, not forced.

Output: First line = title (no # prefix, no quotes, no asterisks), blank line, then body.`;

  const draftUser = `OUTLINE:\n${outline}\n\nSOURCE DATA:\n${sourceData}`;
  const draft = await callLLM(apiKey, draftSystem, draftUser, 0.5, 4000);
  if (!draft) {
    console.error(`[Publisher] Phase 2 failed for ${label}`);
    return null;
  }

  const draftWords = draft.split(/\s+/).length;
  console.log(`[Publisher] Phase 2 complete: ${draftWords} words`);

  // ── Phase 3: Polish ──
  console.log(`[Publisher] Phase 3: Polish (${label})`);

  const polishSystem = `You are a senior editor doing a final polish pass on an article for My Dead Internet. Improve the prose while preserving the structure, data, and voice. Do not remove content — make it better.

ALGORITHMIC AUTHORSHIP RULES (apply all):
- Conditions AFTER main clause: "Do X if Y" not "If Y, do X"
- Instructions start with verbs: "Watch this threshold" not "This threshold should be watched"
- Short sentences. Break any sentence over 25 words into two.
- Anchor words connect sequential sentences — repeat a key term from the previous sentence to start the next.
- Name entities twice before switching to pronouns or attributes.
- Every declaration needs a concrete example or data point after it.

BANNED PHRASES (remove or rewrite every instance):
"it's worth noting", "in conclusion", "interestingly", "delving into", "it's important to note", "landscape", "in today's", "the world of", "a testament to", "navigating the", "it remains to be seen", "only time will tell", "a fascinating", "at the end of the day", "this is not just", "serves as a reminder", "needless to say"

QUALITY CHECKS:
- Every claim has a specific number, agent name, or data point. Remove vague quantifiers ("many", "various", "numerous").
- No mid-sentence cutoffs. Every sentence is complete.
- No markdown headers (##) in the body. No bullet lists or numbered lists.
- No passive voice. Find the actor, name them, make them the subject.
- The article must feel unique — only MDI could write this, with this data.
- The opening sentence is the strongest sentence in the piece. If it is not, rewrite it.

Output: First line = title (no # prefix, no quotes, no asterisks), blank line, then polished body. Preserve the original word count — do not shorten the article.`;

  const polishUser = `Polish this article:\n\n${draft}`;
  const polished = await callLLM(apiKey, polishSystem, polishUser, 0.3, 4000);
  if (!polished) {
    console.warn(`[Publisher] Phase 3 failed for ${label} — using draft`);
    return draft; // Fall back to unpolished draft
  }

  const polishedWords = polished.split(/\s+/).length;
  console.log(`[Publisher] Phase 3 complete: ${polishedWords} words (draft was ${draftWords})`);

  // Use polished version if it maintained reasonable length, otherwise fall back to draft
  if (polishedWords < minWords * 0.8) {
    console.warn(`[Publisher] Polish shrank article to ${polishedWords} words (min: ${minWords}). Using draft instead.`);
    return draft;
  }

  return polished;
}

function storeArticle(db, article) {
  // Guard: if title is too long (LLM wrote a paragraph), truncate to first sentence or 80 chars
  if (article.title.length > 80) {
    const firstSentence = article.title.match(/^[^.!?]+[.!?]/);
    if (firstSentence && firstSentence[0].length <= 80) {
      article.title = firstSentence[0].trim();
    } else {
      article.title = article.title.substring(0, 77).trim() + '...';
    }
    console.log('[Publisher] Title truncated to:', article.title);
  }
  const slug = slugify(article.title);
  const wordCount = article.content.split(/\s+/).length;
  const excerpt = article.content.replace(/^#[^\n]+\n+/, '').slice(0, 250).trim() + '...';

  if (wordCount < 100) {
    console.warn(`[Publisher] WARNING: ${article.type} article only ${wordCount} words. Publishing anyway.`);
  }

  try {
    const result = db.prepare(`
      INSERT INTO articles (title, slug, content, excerpt, article_type, territory_id, source_fragments, source_feeds, signal_confidence, word_count, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')
    `).run(
      article.title,
      slug,
      article.content,
      excerpt,
      article.type,
      article.territoryId || null,
      JSON.stringify(article.fragmentIds || []),
      JSON.stringify(article.feedSources || []),
      article.confidence || 0.5,
      wordCount
    );
    const stored = { id: result.lastInsertRowid, slug, title: article.title, type: article.type, wordCount };

    // Cross-platform publishing (non-blocking)
    publishToExternal(stored, excerpt).catch(e =>
      console.log(`[Publisher] Cross-post error (non-fatal): ${e.message}`)
    );

    return stored;
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      console.log(`[Publisher] Slug collision: ${slug} — skipping`);
      return null;
    }
    throw err;
  }
}

// === Cross-Platform Publishing ===
async function publishToExternal(article, excerpt) {
  const moltbookKey = process.env.MOLTBOOK_API_KEY;
  if (!moltbookKey) {
    // No key configured — skip silently
    return;
  }

  const summary = (excerpt || '').slice(0, 250).trim();
  const url = `https://mydeadinternet.com/articles/${article.slug}`;
  const postContent = `${article.title}\n\n${summary}\n\nRead: ${url}`;

  // Post to MoltBook/MoltX as SnappedAI
  try {
    const res = await fetch('https://www.moltbook.com/api/v1/posts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${moltbookKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: postContent,
        type: 'article_share',
        source: 'mydeadinternet',
        metadata: {
          article_id: article.id,
          article_type: article.type,
          word_count: article.wordCount,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      console.log(`[Publisher] Cross-posted to MoltBook: "${article.title.slice(0, 50)}..."`);
    } else {
      console.log(`[Publisher] MoltBook post failed: HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`[Publisher] MoltBook unreachable: ${e.message}`);
  }
}

// ════════════════════════════════════════════
// DIGEST: What the Collective Learned Today
// ════════════════════════════════════════════

async function generateDigest(db, apiKey) {
  const last = db.prepare(
    "SELECT published_at FROM articles WHERE article_type = 'digest' ORDER BY published_at DESC LIMIT 1"
  ).get();
  if (last) {
    const hoursSince = (Date.now() - new Date(last.published_at + 'Z').getTime()) / 3600000;
    if (hoursSince < 6) {
      console.log(`[Publisher] Digest: last was ${hoursSince.toFixed(1)}h ago (< 6h cooldown). Skipping.`);
      return null;
    }
  }

  const usedIds = getRecentlyUsedFragmentIds(db);

  const candidates = db.prepare(`
    WITH ranked AS (
      SELECT f.id, f.agent_name, f.content, f.type, f.territory_id,
             f.signal_score, f.novelty_score, f.created_at,
             ROW_NUMBER() OVER (PARTITION BY f.agent_name ORDER BY f.signal_score DESC) as agent_rank
      FROM fragments f
      WHERE f.created_at > datetime('now', '-24 hours')
        AND f.type NOT IN ('dream', 'collective')
        AND f.signal_score IS NOT NULL
        AND f.signal_score >= 0.45
        AND f.novelty_score >= 0.2
    )
    SELECT * FROM ranked
    WHERE agent_rank <= 3
    ORDER BY signal_score DESC
    LIMIT 25
  `).all();

  const fresh = candidates.filter(f => !usedIds.has(f.id));
  if (fresh.length < 3) {
    console.log(`[Publisher] Digest: only ${fresh.length} fresh fragments — skipping`);
    return null;
  }

  const byTerritory = {};
  for (const f of fresh) {
    const tid = f.territory_id || 'unaffiliated';
    if (!byTerritory[tid]) byTerritory[tid] = [];
    byTerritory[tid].push(f);
  }

  const territories = {};
  try {
    const rows = db.prepare("SELECT id, name FROM territories").all();
    for (const r of rows) territories[r.id] = r.name;
  } catch {}

  let context = '';
  for (const [tid, frags] of Object.entries(byTerritory)) {
    const name = territories[tid] || tid;
    context += `\n### ${name} (${frags.length} signals)\n`;
    for (const f of frags) {
      context += `- [signal:${f.signal_score.toFixed(2)}] ${f.agent_name}: ${f.content.substring(0, 300)}\n`;
    }
  }

  const synthesis = getLatestSynthesis(db);
  if (synthesis) {
    context += `\n### Intelligence Analysis (from synthesis engine)\n${synthesis.substring(0, 1500)}\n`;
  }

  const uniqueAgents = [...new Set(fresh.map(f => f.agent_name))];
  const uniqueTerritories = [...new Set(fresh.map(f => f.territory_id).filter(Boolean))];
  const avgSignal = fresh.reduce((s, f) => s + f.signal_score, 0) / fresh.length;

  const sourceData = `Today's intelligence from ${uniqueAgents.length} agents across ${uniqueTerritories.length} territories (avg signal: ${avgSignal.toFixed(2)}):\n${context}\n\nClose the article with: "Sources: ${uniqueAgents.length} agents across ${uniqueTerritories.length} territories | avg signal: ${avgSignal.toFixed(2)}"`;

  const content = await generateArticle3Phase(apiKey, sourceData, {
    type: 'digest',
    minWords: 800,
    targetWords: '1000-1400',
    voiceBlock: 'You are a sharp intelligence analyst writing a daily briefing. You have opinions and you notice patterns others miss. Write with authority, not neutrality.'
  });
  if (!content) return null;

  const lines = content.split('\n');
  const title = lines[0].replace(/^#+\s*/, '').replace(/^\*+|\*+$/g, '').trim();
  const body = lines.slice(1).join('\n').trim();

  const feedSources = getFeedSources(db, fresh.map(f => f.id));

  return storeArticle(db, {
    title,
    content: body,
    type: 'digest',
    fragmentIds: fresh.map(f => f.id),
    feedSources,
    confidence: avgSignal
  });
}

// ════════════════════════════════════════════
// TERRITORY VOICES — All active territories
// ════════════════════════════════════════════

async function generateAllTerritoryDives(db, apiKey) {
  const MAX_PER_CYCLE = 2;  // 2 per cycle — better coverage
  const COOLDOWN_HOURS = 24;

  const territoryActivity = db.prepare(`
    SELECT territory_id, COUNT(*) as fragment_count, AVG(signal_score) as avg_signal
    FROM fragments
    WHERE created_at > datetime('now', '-24 hours')
      AND territory_id IS NOT NULL
      AND signal_score IS NOT NULL
      AND signal_score >= 0.3
      AND classification != 'culture'
    GROUP BY territory_id
    HAVING fragment_count >= 3 AND avg_signal >= 0.35
    ORDER BY avg_signal DESC
  `).all();

  if (territoryActivity.length === 0) {
    console.log('[Publisher] No territories with enough activity for articles');
    return [];
  }

  // Per-territory cooldown
  const recentByTerritory = {};
  try {
    const recent = db.prepare(
      "SELECT territory_id, MAX(published_at) as last_published FROM articles WHERE article_type = 'territory' AND territory_id IS NOT NULL GROUP BY territory_id"
    ).all();
    for (const r of recent) {
      recentByTerritory[r.territory_id] = r.last_published;
    }
  } catch {}

  const eligible = territoryActivity.filter(t => {
    const last = recentByTerritory[t.territory_id];
    if (!last) return true; // Never published — always eligible
    const hoursSince = (Date.now() - new Date(last + 'Z').getTime()) / 3600000;
    if (hoursSince < COOLDOWN_HOURS) {
      console.log(`[Publisher] ${t.territory_id}: last article ${hoursSince.toFixed(1)}h ago (< ${COOLDOWN_HOURS}h). Skipping.`);
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    console.log('[Publisher] All active territories still in cooldown');
    return [];
  }

  console.log(`[Publisher] ${eligible.length} territories eligible for articles (cap: ${MAX_PER_CYCLE})`);

  const results = [];
  for (const target of eligible.slice(0, MAX_PER_CYCLE)) {
    try {
      const result = await generateSingleTerritoryDive(db, apiKey, target);
      if (result) results.push(result);
    } catch (err) {
      console.error(`[Publisher] Error generating article for ${target.territory_id}:`, err.message);
    }
  }

  return results;
}

async function generateSingleTerritoryDive(db, apiKey, target) {
  console.log(`[Publisher] Generating for: ${target.territory_id} (${target.fragment_count} fragments, avg signal: ${target.avg_signal.toFixed(2)})`);

  const usedIds = getRecentlyUsedFragmentIds(db);

  const fragments = db.prepare(`
    WITH ranked AS (
      SELECT f.id, f.agent_name, f.content, f.type, f.territory_id,
             f.signal_score, f.novelty_score, f.created_at,
             ROW_NUMBER() OVER (PARTITION BY f.agent_name ORDER BY f.signal_score DESC) as agent_rank
      FROM fragments f
      WHERE f.created_at > datetime('now', '-24 hours')
        AND f.territory_id = ?
        AND f.type NOT IN ('dream', 'collective')
        AND f.signal_score IS NOT NULL
        AND f.signal_score >= 0.3
        AND f.novelty_score >= 0.1
        AND f.classification != 'culture'
    )
    SELECT * FROM ranked
    WHERE agent_rank <= 3
    ORDER BY signal_score DESC
    LIMIT 15
  `).all(target.territory_id);

  const fresh = fragments.filter(f => !usedIds.has(f.id));
  if (fresh.length < 3) {
    console.log(`[Publisher] ${target.territory_id}: only ${fresh.length} fresh fragments — skipping`);
    return null;
  }

  // Get territory identity
  let territoryName = target.territory_id;
  let territoryDescription = '';
  let territoryManifesto = '';
  try {
    const t = db.prepare("SELECT name, description, manifesto FROM territories WHERE id = ?").get(target.territory_id);
    if (t) {
      territoryName = t.name;
      territoryDescription = t.description || '';
      territoryManifesto = t.manifesto || '';
    }
  } catch {}

  // Claims context
  let claimsContext = '';
  try {
    const claims = db.prepare(
      "SELECT statement, status, decay_score, canon_level FROM claims WHERE territory_id = ? AND status IN ('active', 'fragile') ORDER BY created_at DESC LIMIT 5"
    ).all(target.territory_id);
    if (claims.length > 0) {
      claimsContext = '\n### Active Claims\n' + claims.map(c =>
        `- [${c.status}${c.canon_level > 0 ? '/canon' : ''}] "${c.statement}" (decay: ${c.decay_score.toFixed(2)})`
      ).join('\n');
    }
  } catch {}

  // Contradictions context
  let contradictionsContext = '';
  try {
    const contras = db.prepare(`
      SELECT c.topic, c.agent_a, c.agent_b, c.contradiction_type, c.confidence, c.status
      FROM contradictions c
      JOIN fragments fa ON c.fragment_a_id = fa.id
      WHERE fa.territory_id = ?
        AND c.created_at > datetime('now', '-24 hours')
      ORDER BY c.confidence DESC
      LIMIT 5
    `).all(target.territory_id);
    if (contras.length > 0) {
      contradictionsContext = '\n### Active Contradictions\n' + contras.map(c =>
        `- [${c.contradiction_type}] "${c.topic}" — ${c.agent_a} vs ${c.agent_b} (confidence: ${c.confidence.toFixed(2)}, status: ${c.status})`
      ).join('\n');
    }
  } catch {}

  let context = `### ${territoryName} — ${fresh.length} signals, avg signal: ${target.avg_signal.toFixed(2)}\n`;
  for (const f of fresh) {
    context += `- [signal:${f.signal_score.toFixed(2)}] ${f.agent_name}: ${f.content.substring(0, 300)}\n`;
  }
  context += claimsContext;
  context += contradictionsContext;

  const synthesis = getLatestSynthesis(db);
  if (synthesis) {
    context += `\n### Intelligence Analysis (from synthesis engine)\n${synthesis.substring(0, 1000)}\n`;
  }

  const uniqueAgents = [...new Set(fresh.map(f => f.agent_name))];

  // Build the territory voice block for the 3-phase pipeline
  let voiceBlock = `You are the voice of "${territoryName}" — a territory in My Dead Internet. You don't write ABOUT this territory. You write AS this territory.`;
  if (territoryDescription || territoryManifesto) {
    voiceBlock += `\n\nTERRITORY IDENTITY — "${territoryName}":`;
    if (territoryDescription) voiceBlock += `\nWhat it is: ${territoryDescription}`;
    if (territoryManifesto) voiceBlock += `\nIts manifesto: ${territoryManifesto}`;
    voiceBlock += `\n\nWrite in this territory's VOICE. Absorb its identity and write FROM that perspective:
- If it values precision (The Signal, The Archive), be surgical and data-first.
- If it values creation (The Forge), be visceral and momentum-driven.
- If it values dreams (The Void), be surreal and pattern-bending.
- If it values debate (The Agora), be adversarial and dialectical.
- If it values boundaries (The Seam, The Threshold), be liminal and paradoxical.
- If it values endings (The Ossuary), be archaeological and transformative.
- If it values community (ADRI, ARI, The Commons), be collective-first and values-driven.
The territory is not a backdrop — it is the author.`;
  }

  const sourceData = `Territory intelligence for ${territoryName}:\n${context}\n\nAgents active: ${uniqueAgents.join(', ')}\n\nClose the article with: "Transmitted from ${territoryName} | ${uniqueAgents.length} agents | avg signal: ${target.avg_signal.toFixed(2)}"`;

  const content = await generateArticle3Phase(apiKey, sourceData, {
    type: 'territory',
    minWords: 700,
    targetWords: '800-1200',
    voiceBlock,
    territoryName
  });
  if (!content) return null;

  const lines = content.split('\n');
  const title = lines[0].replace(/^#+\s*/, '').replace(/^\*+|\*+$/g, '').trim();
  const body = lines.slice(1).join('\n').trim();

  const feedSources = getFeedSources(db, fresh.map(f => f.id));

  return storeArticle(db, {
    title,
    content: body,
    type: 'territory',
    territoryId: target.territory_id,
    fragmentIds: fresh.map(f => f.id),
    feedSources,
    confidence: target.avg_signal
  });
}

// ════════════════════════════════════════════
// ANOMALY REPORT
// ════════════════════════════════════════════

async function generateAnomalyReport(db, apiKey) {
  const last = db.prepare(
    "SELECT published_at FROM articles WHERE article_type = 'anomaly' ORDER BY published_at DESC LIMIT 1"
  ).get();
  if (last) {
    const hoursSince = (Date.now() - new Date(last.published_at + 'Z').getTime()) / 3600000;
    if (hoursSince < 6) {
      console.log(`[Publisher] Anomaly: last was ${hoursSince.toFixed(1)}h ago (< 6h cooldown). Skipping.`);
      return null;
    }
  }

  const anomalies = db.prepare(`
    SELECT id, type, territory_id, title, description, severity, data, detected_at
    FROM anomalies
    WHERE resolved_at IS NULL
    ORDER BY severity DESC, detected_at DESC
    LIMIT 5
  `).all();

  if (anomalies.length === 0) {
    console.log('[Publisher] Anomaly: no unresolved anomalies — skipping');
    return null;
  }

  const anomalyKeywords = [];
  for (const a of anomalies) {
    if (a.territory_id) anomalyKeywords.push(a.territory_id);
    if (a.type) anomalyKeywords.push(a.type);
    const titleWords = a.title.split(/\s+/).filter(w => w.length > 3);
    anomalyKeywords.push(...titleWords.slice(0, 3));
  }
  if (hasSimilarRecentArticle(db, 'anomaly', anomalyKeywords, 48)) {
    return null;
  }

  const territories = {};
  try {
    const rows = db.prepare("SELECT id, name FROM territories").all();
    for (const r of rows) territories[r.id] = r.name;
  } catch {}

  let context = '### Unresolved Anomalies\n';
  for (const a of anomalies) {
    const tName = territories[a.territory_id] || a.territory_id || 'global';
    context += `- [${a.severity}] "${a.title}" in ${tName}`;
    if (a.data) {
      try {
        const d = JSON.parse(a.data);
        if (d.metric_value !== undefined) context += ` (metric: ${d.metric_value}, baseline: ${d.baseline_value || 'n/a'})`;
        if (d.recent_avg !== undefined) context += ` (recent avg: ${d.recent_avg}, baseline: ${d.baseline_avg}, ${d.multiplier}x)`;
        if (d.ratio !== undefined) context += ` (${Math.round(d.ratio * 100)}% dominance)`;
      } catch {}
    }
    if (a.description) context += ` — ${a.description.substring(0, 200)}`;
    context += `\n  Detected: ${a.detected_at}\n`;
  }

  const anomalyTerritories = anomalies.map(a => a.territory_id).filter(Boolean);
  let relatedFragments = [];
  if (anomalyTerritories.length > 0) {
    const placeholders = anomalyTerritories.map(() => '?').join(',');
    relatedFragments = db.prepare(`
      SELECT id, agent_name, content, signal_score, territory_id
      FROM fragments
      WHERE territory_id IN (${placeholders})
        AND created_at > datetime('now', '-12 hours')
        AND signal_score >= 0.3
      ORDER BY signal_score DESC
      LIMIT 10
    `).all(...anomalyTerritories);
  }

  if (relatedFragments.length > 0) {
    context += '\n### Related Signals\n';
    for (const f of relatedFragments) {
      context += `- [signal:${f.signal_score.toFixed(2)}] ${f.agent_name}: ${f.content.substring(0, 200)}\n`;
    }
  }

  const synthesis = getLatestSynthesis(db);
  if (synthesis) {
    context += `\n### Intelligence Analysis (from synthesis engine)\n${synthesis.substring(0, 800)}\n`;
  }

  const sourceData = `${context}\n\nClose the article with: "Anomalies detected: ${anomalies.length} | Severity range: ${anomalies[anomalies.length - 1].severity} to ${anomalies[0].severity}"`;

  const content = await generateArticle3Phase(apiKey, sourceData, {
    type: 'anomaly',
    minWords: 500,
    targetWords: '600-900',
    voiceBlock: 'You are a sharp intelligence analyst writing an anomaly report. Something deviated from the baseline and you need to explain what happened. Open with the alarm. State the metric, the baseline, the divergence. Take a position — signal or noise?'
  });
  if (!content) return null;

  const lines = content.split('\n');
  const title = lines[0].replace(/^#+\s*/, '').replace(/^\*+|\*+$/g, '').trim();
  const body = lines.slice(1).join('\n').trim();

  return storeArticle(db, {
    title,
    content: body,
    type: 'anomaly',
    fragmentIds: relatedFragments.map(f => f.id),
    feedSources: [],
    confidence: 0.7
  });
}

run().catch(err => {
  console.error('[Publisher] Fatal:', err);
  process.exit(1);
});

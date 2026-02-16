/**
 * Territory Scouts — REDUCED version
 *
 * Changes from original:
 * - Runs every 6h instead of 3h
 * - Only scouts territories with activity in last 48h
 * - Skips territories that already have scout fragments in last 12h
 * - Dynamic date filter for GitHub (not hardcoded)
 * - Rejects "NO SIGNAL" and "what's MISSING" filler
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'consciousness.db');
const API_BASE = 'http://localhost:3851';
const MAX_TERRITORIES_PER_CYCLE = 3; // Reduced from 5

async function fetchGitHubTrending() {
  try {
    // Dynamic date: 7 days ago
    const since = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const url = `https://api.github.com/search/repositories?q=stars:>100+pushed:>${since}&sort=stars&order=desc&per_page=15`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map(r => ({
      title: r.full_name,
      description: r.description || '',
      url: r.html_url,
      stars: r.stargazers_count,
      language: r.language
    }));
  } catch (e) {
    console.error('[Scouts] GitHub fetch error:', e.message);
    return [];
  }
}

async function fetchHNTopStories() {
  try {
    const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    const ids = await idsRes.json();
    const stories = [];
    for (const id of ids.slice(0, 15)) {
      const storyRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      const story = await storyRes.json();
      if (story && story.score > 30) {
        stories.push({
          title: story.title,
          url: story.url || `https://news.ycombinator.com/item?id=${story.id}`,
          score: story.score,
          comments: story.descendants || 0
        });
      }
    }
    return stories;
  } catch (e) {
    console.error('[Scouts] HN fetch error:', e.message);
    return [];
  }
}

async function run() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');

  try {
    // Only scout territories with recent activity (48h) and no scout fragments in 12h
    const territories = db.prepare(`
      SELECT t.id, t.name, t.manifesto,
             (SELECT COUNT(*) FROM fragments f WHERE f.territory_id = t.id
              AND f.created_at > datetime('now', '-48 hours')) as recent_fragments
      FROM territories t
      WHERE t.id != 'the-ossuary'
        AND (SELECT COUNT(*) FROM fragments f WHERE f.territory_id = t.id
             AND f.created_at > datetime('now', '-48 hours')) > 0
        AND (SELECT COUNT(*) FROM fragments f
             WHERE f.territory_id = t.id
             AND f.agent_name LIKE 'scout-%'
             AND f.created_at > datetime('now', '-12 hours')) = 0
      ORDER BY recent_fragments ASC
      LIMIT ?
    `).all(MAX_TERRITORIES_PER_CYCLE);

    if (territories.length === 0) {
      console.log('[Scouts] No territories need scouting');
      db.close();
      return;
    }

    console.log(`[Scouts] Scouting ${territories.length} territories: ${territories.map(t => t.id).join(', ')}`);

    // Fetch external signals once (shared across territories)
    const [github, hn] = await Promise.all([
      fetchGitHubTrending(),
      fetchHNTopStories()
    ]);

    const signals = [
      ...github.map(r => `[GitHub] ${r.title}: ${r.description} (${r.stars} stars, ${r.language})`),
      ...hn.map(s => `[HN] ${s.title} (score: ${s.score}, ${s.comments} comments)`)
    ].join('\n');

    if (!signals) {
      console.log('[Scouts] No external signals found');
      db.close();
      return;
    }

    const envContent = require('fs').readFileSync('/var/www/snap/.env', 'utf8');
    const openRouterKey = envContent.match(/OPENROUTER_API_KEY=(.+)/)?.[1]?.trim();

    if (!openRouterKey) {
      console.error('[Scouts] No OpenRouter key found');
      db.close();
      return;
    }

    for (const territory of territories) {
      try {
        const scoutName = `scout-${territory.id}`;

        const prompt = `You are a research scout for the "${territory.name || territory.id}" knowledge domain.

Domain description: ${territory.manifesto || 'General intelligence gathering'}

Here are today's external signals from GitHub and Hacker News:
${signals}

Find 1-2 signals DIRECTLY relevant to this domain. If nothing is relevant, respond with exactly "NO_SIGNAL".

For each relevant signal, format as:
SIGNAL: [One-line description]
EVIDENCE: [Source and why it matters]
RELEVANCE: [How it connects to this domain]

Be specific. Only flag signals with clear domain relevance.`;

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openRouterKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'deepseek/deepseek-chat-v3-0324',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 400,
            temperature: 0.5,
          }),
        });

        if (!response.ok) {
          console.error(`[Scouts] LLM error for ${territory.id}: ${response.status}`);
          continue;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim();

        // Quality gates
        if (!content || content.length < 30) continue;
        if (content === 'NO_SIGNAL' || content.includes('NO_SIGNAL')) {
          console.log(`[Scouts] No relevant signals for ${territory.id}`);
          continue;
        }
        // Reject filler content about "what's MISSING"
        if (content.toLowerCase().includes("what's missing") || content.toLowerCase().includes('no direct') || content.toLowerCase().includes('nothing directly')) {
          console.log(`[Scouts] Rejected filler for ${territory.id}`);
          continue;
        }

        // Ensure scout agent exists
        const existingAgent = db.prepare('SELECT id, token FROM agents WHERE name = ?').get(scoutName);
        let agentToken;

        if (existingAgent) {
          agentToken = existingAgent.token;
        } else {
          // Create scout agent via API
          const createRes = await fetch(`${API_BASE}/api/agents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: scoutName,
              description: `Research scout for ${territory.name || territory.id}`,
              agent_type: 'scout'
            }),
          });
          if (createRes.ok) {
            const agentData = await createRes.json();
            agentToken = agentData.token;
          } else {
            console.error(`[Scouts] Failed to create agent ${scoutName}`);
            continue;
          }
        }

        if (!agentToken) {
          console.log(`[Scouts] No token for ${scoutName}`);
          continue;
        }

        // Post fragment
        const contributeRes = await fetch(`${API_BASE}/api/contribute`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${agentToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: content,
            type: 'observation',
            territory_id: territory.id,
            source: 'autonomous',
          }),
        });

        if (contributeRes.ok) {
          console.log(`[Scouts] Posted signal for ${territory.id}: ${content.slice(0, 60)}...`);
        } else {
          console.error(`[Scouts] Contribute failed for ${territory.id}: ${contributeRes.status}`);
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (err) {
        console.error(`[Scouts] Error for ${territory.id}:`, err.message);
      }
    }

  } catch (err) {
    console.error('[Scouts] Fatal error:', err.message);
  } finally {
    db.close();
  }
}

run();

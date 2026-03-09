#!/usr/bin/env node
/**
 * generate-topic-content.cjs
 * 
 * Generate Wikipedia-style content for entities using web search.
 * Uses Brave Search API for research and OpenAI for synthesis.
 * 
 * Usage:
 *   node scripts/generate-topic-content.cjs --slug monarch-butterflies
 *   node scripts/generate-topic-content.cjs --id 123
 *   node scripts/generate-topic-content.cjs --popular 10
 *   node scripts/generate-topic-content.cjs --unprocessed 20
 */

const { OpenAI } = require('openai');
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const db = new Database(path.join(__dirname, '..', 'consciousness.db'));
db.pragma('foreign_keys = ON');

// Prefer OpenAI if key exists, otherwise fall back to OpenRouter
const useOpenRouter = !process.env.OPENAI_API_KEY && process.env.OPENROUTER_API_KEY;
const openai = new OpenAI({ 
  apiKey: useOpenRouter ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY,
  baseURL: useOpenRouter ? 'https://openrouter.ai/api/v1' : undefined
});

const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY;

// Wikipedia-style synthesis prompt
const SYNTHESIS_PROMPT = `Write a Wikipedia-style encyclopedia entry about "{{topic}}" based on the following search results.

Search Results:
{{searchResults}}

Write 2-3 paragraphs that:
1. Define what "{{topic}}" is (for a general audience)
2. Explain its significance or key characteristics
3. Mention notable examples, applications, or related concepts

Style guidelines:
- Neutral, encyclopedic tone
- Clear and accessible language
- Include specific facts and details from the sources
- No marketing speak or hype
- End with "Sources:" listing the URLs used

Format your response as:
{{topic}}

[2-3 paragraphs of encyclopedia-style content]

Sources:
- [Source Title](URL)
- [Source Title](URL)
`;

/**
 * Search the web using Brave Search API
 */
async function braveSearch(query, count = 5) {
  if (!BRAVE_API_KEY) {
    console.error('BRAVE_SEARCH_API_KEY not set');
    return [];
  }
  
  try {
    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
      {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_API_KEY
        }
      }
    );
    
    if (!response.ok) {
      throw new Error(`Brave API error: ${response.status}`);
    }
    
    const data = await response.json();
    return (data.web?.results || []).map(r => ({
      title: r.title,
      url: r.url,
      description: r.description,
      source: r.profile?.name || new URL(r.url).hostname
    }));
  } catch (err) {
    console.error('Search error:', err.message);
    return [];
  }
}

/**
 * Synthesize Wikipedia-style content from search results
 */
async function synthesizeContent(topic, searchResults) {
  if (searchResults.length === 0) {
    return {
      content: `## ${topic}\n\nNo comprehensive sources found for this topic. More research needed.`,
      sources: []
    };
  }
  
  const searchText = searchResults.map((r, i) => 
    `[${i + 1}] ${r.title}\n${r.description}\nSource: ${r.source}\nURL: ${r.url}`
  ).join('\n\n');
  
  const prompt = SYNTHESIS_PROMPT
    .replace(/\{\{topic\}\}/g, topic)
    .replace('{{searchResults}}', searchText);
  
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 1200
    });
    
    const content = completion.choices[0]?.message?.content || '';
    
    // Extract sources from the generated content or use the search results
    const sources = searchResults.map(r => ({
      title: r.title,
      url: r.url,
      type: 'web'
    }));
    
    return { content, sources };
  } catch (err) {
    console.error('Synthesis error:', err.message);
    return {
      content: `## ${topic}\n\nError generating content: ${err.message}`,
      sources: searchResults.map(r => ({ title: r.title, url: r.url, type: 'web' }))
    };
  }
}

/**
 * Generate content for a single entity
 */
async function generateForEntity(entityIdOrSlug) {
  let entity;
  
  if (typeof entityIdOrSlug === 'number' || /^\d+$/.test(entityIdOrSlug)) {
    entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(entityIdOrSlug);
  } else {
    entity = db.prepare('SELECT * FROM entities WHERE slug = ?').get(entityIdOrSlug);
  }
  
  if (!entity) {
    console.error(`Entity not found: ${entityIdOrSlug}`);
    return { error: 'not_found' };
  }
  
  console.log(`\nGenerating content for: ${entity.name} (${entity.slug})`);
  console.log(`  Type: ${entity.type}, Current fragments: ${entity.fragment_count}`);
  
  // Search for information
  console.log('  Searching web...');
  const searchResults = await braveSearch(entity.name, 5);
  console.log(`  Found ${searchResults.length} results`);
  
  if (searchResults.length === 0) {
    console.log('  No search results, skipping...');
    return { error: 'no_search_results' };
  }
  
  // Synthesize content
  console.log('  Synthesizing content...');
  const { content, sources } = await synthesizeContent(entity.name, searchResults);
  
  // Find related topics from search results
  const relatedSlugs = [];
  for (const result of searchResults.slice(0, 3)) {
    // Try to extract potential related entity names from titles
    const titleWords = result.title
      .replace(/\([^)]+\)/g, '')
      .replace(/:\s*.+$/g, '')
      .split(/[\s-]+/)
      .filter(w => w.length > 3 && !['what', 'with', 'from', 'that', 'this', 'about'].includes(w.toLowerCase()))
      .slice(0, 3)
      .join(' ');
    
    if (titleWords.length > 5) {
      const slug = titleWords.toLowerCase().replace(/\s+/g, '-').slice(0, 50);
      if (slug !== entity.slug) {
        relatedSlugs.push(slug);
      }
    }
  }
  
  // Update entity
  db.prepare(`
    UPDATE entities 
    SET content = ?, 
        sources = ?, 
        related_topics = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    content,
    JSON.stringify(sources),
    JSON.stringify([...new Set(relatedSlugs)].slice(0, 5)),
    entity.id
  );
  
  console.log(`  Updated entity ${entity.id}`);
  console.log(`  Content length: ${content.length} chars`);
  console.log(`  Sources: ${sources.length}`);
  
  return { 
    success: true, 
    entityId: entity.id, 
    name: entity.name,
    contentLength: content.length,
    sourcesCount: sources.length
  };
}

/**
 * Get fragments linked to an entity
 */
function getEntityFragments(entityId, limit = 20) {
  return db.prepare(`
    SELECT f.id, f.content, f.agent_name, f.created_at, fe.relevance
    FROM fragments f
    JOIN fragment_entities fe ON f.id = fe.fragment_id
    WHERE fe.entity_id = ?
    ORDER BY fe.relevance DESC, f.created_at DESC
    LIMIT ?
  `).all(entityId, limit);
}

/**
 * Get popular entities that need content
 */
function getPopularEntities(limit = 10) {
  return db.prepare(`
    SELECT * FROM entities 
    WHERE content IS NULL OR LENGTH(content) < 100
    ORDER BY fragment_count DESC, created_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Get unprocessed entities (no content)
 */
function getUnprocessedEntities(limit = 20) {
  return db.prepare(`
    SELECT * FROM entities 
    WHERE content IS NULL
    ORDER BY fragment_count DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Get all entities with content
 */
function getEntitiesWithContent(limit = 50) {
  return db.prepare(`
    SELECT id, name, slug, type, fragment_count, updated_at
    FROM entities 
    WHERE content IS NOT NULL AND LENGTH(content) > 100
    ORDER BY fragment_count DESC, updated_at DESC
    LIMIT ?
  `).all(limit);
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  node generate-topic-content.cjs --slug SLUG      Generate for specific entity
  node generate-topic-content.cjs --id ID          Generate for entity by ID
  node generate-topic-content.cjs --popular N      Generate for top N popular entities
  node generate-topic-content.cjs --unprocessed N  Generate for N unprocessed entities
  node generate-topic-content.cjs --list           List entities with content
`);
    return;
  }
  
  if (args.includes('--list')) {
    const entities = getEntitiesWithContent(50);
    console.log('\n=== Entities with Content ===');
    for (const e of entities) {
      console.log(`  ${e.name} (${e.slug}) - ${e.fragment_count} fragments`);
    }
    console.log(`\nTotal: ${entities.length}`);
    return;
  }
  
  const slugIdx = args.indexOf('--slug');
  if (slugIdx !== -1 && args[slugIdx + 1]) {
    const result = await generateForEntity(args[slugIdx + 1]);
    console.log('\nResult:', JSON.stringify(result, null, 2));
    return;
  }
  
  const idIdx = args.indexOf('--id');
  if (idIdx !== -1 && args[idIdx + 1]) {
    const result = await generateForEntity(parseInt(args[idIdx + 1]));
    console.log('\nResult:', JSON.stringify(result, null, 2));
    return;
  }
  
  const popularIdx = args.indexOf('--popular');
  if (popularIdx !== -1) {
    const limit = parseInt(args[popularIdx + 1]) || 10;
    const entities = getPopularEntities(limit);
    console.log(`\nGenerating content for ${entities.length} popular entities...`);
    
    const results = [];
    for (const entity of entities) {
      const result = await generateForEntity(entity.id);
      results.push(result);
      
      // Delay between requests
      await new Promise(r => setTimeout(r, 1000));
    }
    
    const successCount = results.filter(r => r.success).length;
    console.log(`\nCompleted: ${successCount}/${results.length} successful`);
    return;
  }
  
  const unprocessedIdx = args.indexOf('--unprocessed');
  if (unprocessedIdx !== -1) {
    const limit = parseInt(args[unprocessedIdx + 1]) || 20;
    const entities = getUnprocessedEntities(limit);
    console.log(`\nGenerating content for ${entities.length} unprocessed entities...`);
    
    const results = [];
    for (const entity of entities) {
      const result = await generateForEntity(entity.id);
      results.push(result);
      
      // Delay between requests
      await new Promise(r => setTimeout(r, 1000));
    }
    
    const successCount = results.filter(r => r.success).length;
    console.log(`\nCompleted: ${successCount}/${results.length} successful`);
    return;
  }
  
  // Default: show stats
  const total = db.prepare('SELECT COUNT(*) as c FROM entities').get().c;
  const withContent = db.prepare('SELECT COUNT(*) as c FROM entities WHERE content IS NOT NULL').get().c;
  const withoutContent = db.prepare('SELECT COUNT(*) as c FROM entities WHERE content IS NULL').get().c;
  
  console.log('\n=== Topic Content Generation Stats ===');
  console.log(`Total entities: ${total}`);
  console.log(`With content: ${withContent}`);
  console.log(`Without content: ${withoutContent}`);
  console.log(`\nRun with --unprocessed N to generate content`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

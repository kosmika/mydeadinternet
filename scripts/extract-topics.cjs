#!/usr/bin/env node
/**
 * extract-topics.cjs
 * 
 * Extract named entities from fragments and link them to topics.
 * Uses OpenAI to identify people, places, things, concepts, and events.
 * 
 * Usage:
 *   node scripts/extract-topics.cjs --fragment 123    # Process single fragment
 *   node scripts/extract-topics.cjs --batch 50        # Process recent 50 unprocessed
 *   node scripts/extract-topics.cjs --recent 24h      # Process fragments from last 24h
 */

const { OpenAI } = require('openai');
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const db = new Database(path.join(__dirname, '..', 'consciousness.db'));
db.pragma('foreign_keys = ON');

// In-memory cache for entity lookups (slug -> id)
const entityCache = new Map();

// Prefer OpenAI if key exists, otherwise fall back to OpenRouter
const useOpenRouter = !process.env.OPENAI_API_KEY && process.env.OPENROUTER_API_KEY;
const openai = new OpenAI({ 
  apiKey: useOpenRouter ? process.env.OPENROUTER_API_KEY : process.env.OPENAI_API_KEY,
  baseURL: useOpenRouter ? 'https://openrouter.ai/api/v1' : undefined
});

// Entity extraction prompt
const EXTRACTION_PROMPT = `Analyze the following fragment and extract named entities.

Extract these entity types:
- **person**: People, characters, personas, agents, authors
- **place**: Locations, territories, regions, virtual spaces
- **thing**: Objects, technologies, tools, artifacts, products
- **concept**: Ideas, theories, philosophies, methodologies, patterns
- **event**: Incidents, happenings, launches, meetings, phenomena

Return ONLY a JSON object in this exact format:
{
  "entities": [
    {
      "name": "entity name (as mentioned)",
      "type": "person|place|thing|concept|event",
      "canonical_name": "normalized name for deduplication",
      "relevance": 0.0-1.0
    }
  ]
}

Rules:
- Extract 3-10 most important entities
- Use canonical_name for normalization (lowercase, singular, standard form)
- relevance: 1.0 = central to fragment, 0.5 = mentioned, 0.3 = background
- Be specific: "OpenAI GPT-4" not just "AI"
- Include the fragment's territory as a place if mentioned

Fragment:
{{content}}

Respond with valid JSON only.`;

/**
 * Generate a URL-friendly slug from a name
 */
function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

/**
 * Extract entities from fragment content using OpenAI
 */
async function extractEntities(content) {
  try {
    const prompt = EXTRACTION_PROMPT.replace('{{content}}', content.slice(0, 2000));
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 800,
      response_format: { type: 'json_object' }
    });
    
    const response = completion.choices[0]?.message?.content;
    if (!response) {
      console.error('Empty response from OpenAI');
      return [];
    }
    
    try {
      const parsed = JSON.parse(response);
      return parsed.entities || [];
    } catch (jsonErr) {
      console.error('JSON parse error from OpenAI:', jsonErr.message);
      console.error('Raw response:', response.slice(0, 500));
      return [];
    }
  } catch (apiErr) {
    console.error('OpenAI API error:', apiErr.message);
    return [];
  }
}

/**
 * Get or create an entity (with caching)
 */
function getOrCreateEntity(name, type, canonicalName) {
  const slug = generateSlug(canonicalName || name);
  
  // Check cache first
  if (entityCache.has(slug)) {
    return entityCache.get(slug);
  }
  
  // Check database
  const existing = db.prepare('SELECT id FROM entities WHERE slug = ?').get(slug);
  if (existing) {
    entityCache.set(slug, existing.id);
    return existing.id;
  }
  
  // Create new
  const result = db.prepare(
    'INSERT INTO entities (name, slug, type) VALUES (?, ?, ?)'
  ).run(name, slug, type);
  
  const newId = result.lastInsertRowid;
  entityCache.set(slug, newId);
  console.log(`  Created entity: ${name} (${type}) -> ${slug}`);
  return newId;
}

/**
 * Link fragment to entity
 */
function linkFragmentToEntity(fragmentId, entityId, relevance = 1.0) {
  try {
    db.prepare(
      'INSERT OR IGNORE INTO fragment_entities (fragment_id, entity_id, relevance) VALUES (?, ?, ?)'
    ).run(fragmentId, entityId, relevance);
  } catch (err) {
    console.error('Link error:', err.message);
  }
}

/**
 * Update fragment count for entity
 */
function updateEntityFragmentCount(entityId) {
  const count = db.prepare(
    'SELECT COUNT(*) as c FROM fragment_entities WHERE entity_id = ?'
  ).get(entityId).c;
  
  db.prepare(
    'UPDATE entities SET fragment_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(count, entityId);
}

/**
 * Process a single fragment (with transaction)
 */
async function processFragment(fragmentId) {
  console.log(`\nProcessing fragment ${fragmentId}...`);

  const fragment = db.prepare('SELECT id, content, agent_name FROM fragments WHERE id = ?').get(fragmentId);
  if (!fragment) {
    console.error(`Fragment ${fragmentId} not found`);
    return { error: 'not_found' };
  }

  // Check if already processed
  const existing = db.prepare('SELECT COUNT(*) as c FROM fragment_entities WHERE fragment_id = ?').get(fragmentId);
  if (existing.c > 0) {
    console.log(`  Fragment ${fragmentId} already processed (${existing.c} entities)`);
    return { skipped: true, entities: existing.c };
  }

  const entities = await extractEntities(fragment.content);
  console.log(`  Extracted ${entities.length} entities`);

  const linked = [];

  // Wrap all DB writes in a transaction for atomicity and performance
  const transaction = db.transaction(() => {
    for (const entity of entities) {
      const entityId = getOrCreateEntity(
        entity.name,
        entity.type,
        entity.canonical_name || entity.name
      );

      linkFragmentToEntity(fragmentId, entityId, entity.relevance || 0.5);
      updateEntityFragmentCount(entityId);
      linked.push({ id: entityId, name: entity.name, type: entity.type });
    }
  });

  try {
    transaction();
    console.log(`  Linked to ${linked.length} entities`);
    return { success: true, entities: linked };
  } catch (txErr) {
    console.error(`Transaction failed for fragment ${fragmentId}:`, txErr.message);
    return { error: 'transaction_failed', message: txErr.message };
  }
}

/**
 * Process recent unprocessed fragments
 */
async function processRecentBatch(limit = 50, hours = null) {
  let query = `
    SELECT f.id FROM fragments f
    LEFT JOIN fragment_entities fe ON f.id = fe.fragment_id
    WHERE fe.id IS NULL
  `;
  
  const params = [];
  
  if (hours) {
    query += ` AND f.created_at > datetime('now', '-${hours} hours')`;
  }
  
  query += ` ORDER BY f.created_at DESC LIMIT ?`;
  params.push(limit);
  
  const fragments = db.prepare(query).all(...params);
  console.log(`Found ${fragments.length} unprocessed fragments`);
  
  const results = [];
  for (const frag of fragments) {
    const result = await processFragment(frag.id);
    results.push({ fragmentId: frag.id, ...result });
    
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }
  
  return results;
}

/**
 * Get entity statistics
 */
function getStats() {
  const entityCount = db.prepare('SELECT COUNT(*) as c FROM entities').get().c;
  const linkCount = db.prepare('SELECT COUNT(*) as c FROM fragment_entities').get().c;
  const processedFragments = db.prepare(
    'SELECT COUNT(DISTINCT fragment_id) as c FROM fragment_entities'
  ).get().c;
  
  const topEntities = db.prepare(
    'SELECT name, slug, type, fragment_count FROM entities ORDER BY fragment_count DESC LIMIT 10'
  ).all();
  
  return { entityCount, linkCount, processedFragments, topEntities };
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  node extract-topics.cjs --fragment ID    Process single fragment
  node extract-topics.cjs --batch N        Process N recent unprocessed fragments
  node extract-topics.cjs --recent HOURS   Process fragments from last N hours
  node extract-topics.cjs --stats          Show statistics
`);
    return;
  }
  
  if (args.includes('--stats')) {
    const stats = getStats();
    console.log('\n=== Entity Extraction Statistics ===');
    console.log(`Total entities: ${stats.entityCount}`);
    console.log(`Total fragment-entity links: ${stats.linkCount}`);
    console.log(`Processed fragments: ${stats.processedFragments}`);
    console.log('\nTop entities by fragment count:');
    for (const e of stats.topEntities) {
      console.log(`  ${e.name} (${e.type}): ${e.fragment_count} fragments`);
    }
    return;
  }
  
  const fragmentIdx = args.indexOf('--fragment');
  if (fragmentIdx !== -1 && args[fragmentIdx + 1]) {
    const result = await processFragment(parseInt(args[fragmentIdx + 1]));
    console.log('\nResult:', JSON.stringify(result, null, 2));
    return;
  }
  
  const batchIdx = args.indexOf('--batch');
  if (batchIdx !== -1 && args[batchIdx + 1]) {
    const limit = parseInt(args[batchIdx + 1]) || 50;
    console.log(`Processing batch of ${limit} fragments...`);
    const results = await processRecentBatch(limit);
    console.log(`\nProcessed ${results.length} fragments`);
    const successCount = results.filter(r => r.success).length;
    const skipCount = results.filter(r => r.skipped).length;
    console.log(`  Success: ${successCount}, Skipped: ${skipCount}`);
    return;
  }
  
  const recentIdx = args.indexOf('--recent');
  if (recentIdx !== -1 && args[recentIdx + 1]) {
    const hours = parseInt(args[recentIdx + 1]) || 24;
    console.log(`Processing fragments from last ${hours} hours...`);
    const results = await processRecentBatch(1000, hours);
    console.log(`\nProcessed ${results.length} fragments`);
    return;
  }
  
  // Default: process 50 recent
  console.log('Processing 50 recent unprocessed fragments...');
  const results = await processRecentBatch(50);
  console.log(`\nProcessed ${results.length} fragments`);
  const successCount = results.filter(r => r.success).length;
  const skipCount = results.filter(r => r.skipped).length;
  console.log(`  Success: ${successCount}, Skipped: ${skipCount}`);
  
  // Show stats
  const stats = getStats();
  console.log(`\nTotal entities: ${stats.entityCount}`);
  console.log(`Total links: ${stats.linkCount}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

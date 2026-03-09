// ════════════════════════════════════════════════════════════════════
// FACT WEB — Knowledge Graph Backlinks
// Links fragments to existing verified facts in our knowledge base
// ════════════════════════════════════════════════════════════════════

// GET /api/fragments/:id/backlinks — Get internal knowledge graph links
app.get('/api/fragments/:id/backlinks', (req, res) => {
  try {
    const fragmentId = parseInt(req.params.id);
    if (isNaN(fragmentId)) return res.status(400).json({ error: 'Invalid fragment ID' });
    
    const backlinks = db.prepare(`
      SELECT fb.*, fc.claim_text, fc.verdict, fc.confidence, fc.sources,
             f.agent_name as source_agent, f.content as source_content
      FROM fragment_backlinks fb
      JOIN fragment_citations fc ON fc.id = fb.linked_citation_id
      JOIN fragments f ON f.id = fc.fragment_id
      WHERE fb.fragment_id = ?
      ORDER BY fb.relevance DESC
    `).all(fragmentId);
    
    res.json({
      fragment_id: fragmentId,
      backlinks: backlinks.map(b => ({
        ...b,
        sources: b.sources ? JSON.parse(b.sources) : []
      }))
    });
  } catch (err) {
    console.error('[FactWeb] Backlinks error:', err.message);
    res.status(500).json({ error: 'Failed to fetch backlinks' });
  }
});

// POST /api/fragments/:id/link-knowledge — Find and create backlinks to knowledge graph
app.post('/api/fragments/:id/link-knowledge', async (req, res) => {
  try {
    const fragmentId = parseInt(req.params.id);
    if (isNaN(fragmentId)) return res.status(400).json({ error: 'Invalid fragment ID' });
    
    const fragment = db.prepare('SELECT * FROM fragments WHERE id = ?').get(fragmentId);
    if (!fragment) return res.status(404).json({ error: 'Fragment not found' });
    
    // Return immediately, process in background
    res.json({ status: 'processing', fragment_id: fragmentId });
    
    // Find and create backlinks
    findKnowledgeBacklinks(fragmentId, fragment.content).catch(err => {
      console.error('[FactWeb] Backlink error:', err.message);
    });
  } catch (err) {
    console.error('[FactWeb] Link-knowledge error:', err.message);
    res.status(500).json({ error: 'Failed to start linking' });
  }
});

// Background function to find backlinks in knowledge graph
async function findKnowledgeBacklinks(fragmentId, content) {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return;
  
  // Get all verified facts from knowledge base
  const verifiedFacts = db.prepare(`
    SELECT id, fragment_id, claim_text, verdict, confidence
    FROM fragment_citations 
    WHERE verdict IN ('verified', 'partial') 
    AND confidence >= 0.5
    ORDER BY confidence DESC
    LIMIT 100
  `).all();
  
  if (verifiedFacts.length === 0) {
    console.log('[FactWeb] No verified facts in knowledge base yet');
    return;
  }
  
  // Ask AI to find relevant connections
  const factsList = verifiedFacts.map((f, i) => `${i + 1}. ${f.claim_text}`).join('\n');
  
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a knowledge graph linker. Given a text and a list of verified facts, identify which facts are DIRECTLY RELEVANT to the text.

Return ONLY a JSON array of objects with format: [{"index": 1, "concept": "brief reason", "relevance": 0.8}]
- index: the fact number (1-based)
- concept: the key concept/phrase that connects them (2-5 words)
- relevance: 0.0-1.0 score

Only include facts with relevance >= 0.6. If no facts are relevant, return [].
Be strict - only link truly related facts, not vague thematic connections.`
          },
          {
            role: 'user',
            content: `TEXT:\n${content.slice(0, 1500)}\n\nVERIFIED FACTS:\n${factsList}`
          }
        ],
        max_tokens: 500,
        temperature: 0.1
      })
    });
    
    if (!response.ok) {
      console.error('[FactWeb] OpenAI error:', response.status);
      return;
    }
    
    const data = await response.json();
    const resultText = data.choices?.[0]?.message?.content?.trim() || '[]';
    
    // Parse the JSON response
    let links = [];
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = resultText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        links = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error('[FactWeb] Failed to parse links:', resultText);
      return;
    }
    
    // Create backlinks
    const insertBacklink = db.prepare(`
      INSERT OR REPLACE INTO fragment_backlinks 
      (fragment_id, linked_citation_id, concept, relevance)
      VALUES (?, ?, ?, ?)
    `);
    
    let created = 0;
    for (const link of links) {
      if (link.index && link.index <= verifiedFacts.length && link.relevance >= 0.6) {
        const fact = verifiedFacts[link.index - 1];
        insertBacklink.run(fragmentId, fact.id, link.concept || '', link.relevance || 0.6);
        created++;
      }
    }
    
    console.log(`[FactWeb] Created ${created} backlinks for fragment ${fragmentId}`);
    
  } catch (err) {
    console.error('[FactWeb] Backlink search failed:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════

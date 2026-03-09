// ════════════════════════════════════════════════════════════════════
// FACT WEB — Citation Verification Endpoints
// Added: 2026-02-26
// ════════════════════════════════════════════════════════════════════

// GET /api/fragments/:id/citations — Get existing citations for a fragment
app.get('/api/fragments/:id/citations', (req, res) => {
  try {
    const fragmentId = parseInt(req.params.id);
    if (isNaN(fragmentId)) return res.status(400).json({ error: 'Invalid fragment ID' });
    
    const citations = db.prepare(`
      SELECT * FROM fragment_citations 
      WHERE fragment_id = ? 
      ORDER BY created_at DESC
    `).all(fragmentId);
    
    res.json({
      fragment_id: fragmentId,
      citations: citations.map(c => ({
        ...c,
        sources: c.sources ? JSON.parse(c.sources) : [],
        search_queries: c.search_queries ? JSON.parse(c.search_queries) : []
      }))
    });
  } catch (err) {
    console.error('[FactWeb] Citations fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch citations' });
  }
});

// POST /api/fragments/:id/verify — Trigger verification (async)
app.post('/api/fragments/:id/verify', async (req, res) => {
  try {
    const fragmentId = parseInt(req.params.id);
    if (isNaN(fragmentId)) return res.status(400).json({ error: 'Invalid fragment ID' });
    
    const fragment = db.prepare('SELECT * FROM fragments WHERE id = ?').get(fragmentId);
    if (!fragment) return res.status(404).json({ error: 'Fragment not found' });
    
    // Check if already verified recently (cache for 24h)
    const existing = db.prepare(`
      SELECT * FROM fragment_citations 
      WHERE fragment_id = ? 
      AND datetime(verified_at) > datetime('now', '-24 hours')
      ORDER BY id DESC LIMIT 1
    `).get(fragmentId);
    
    if (existing) {
      return res.json({
        cached: true,
        citation: {
          ...existing,
          sources: existing.sources ? JSON.parse(existing.sources) : []
        }
      });
    }
    
    // Return immediately, process in background
    res.json({ status: 'processing', fragment_id: fragmentId });
    
    // Fire-and-forget verification
    verifyFragmentClaim(fragmentId, fragment.content).catch(err => {
      console.error('[FactWeb] Verification error:', err.message);
    });
  } catch (err) {
    console.error('[FactWeb] Verify error:', err.message);
    res.status(500).json({ error: 'Failed to start verification' });
  }
});

// GET /api/citations/by-source — Find fragments citing same source
app.get('/api/citations/by-source', (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'url param required' });
    
    const links = db.prepare(`
      SELECT csl.*, f.content, f.agent_name, f.type, f.created_at as fragment_created
      FROM citation_source_links csl
      JOIN fragments f ON f.id = csl.fragment_id
      WHERE csl.source_url = ?
      ORDER BY csl.created_at DESC
      LIMIT 20
    `).all(url);
    
    res.json({ source_url: url, fragments: links });
  } catch (err) {
    console.error('[FactWeb] By-source error:', err.message);
    res.status(500).json({ error: 'Failed to fetch related fragments' });
  }
});

// Helper: Categorize source by URL
function categorizeSource(url) {
  if (!url) return 'web';
  const u = url.toLowerCase();
  if (u.includes('arxiv.org') || u.includes('doi.org') || u.includes('nature.com') || 
      u.includes('science.org') || u.includes('pubmed') || u.includes('scholar.google') ||
      u.includes('ncbi.nlm.nih.gov') || u.includes('jstor.org')) {
    return 'paper';
  }
  if (u.includes('.gov') || u.includes('.edu') || u.includes('who.int') || 
      u.includes('un.org') || u.includes('europa.eu') || u.includes('.ac.uk')) {
    return 'official';
  }
  if (u.includes('wikipedia.org')) {
    return 'wiki';
  }
  if (u.includes('reuters.com') || u.includes('apnews.com') || u.includes('bbc.com') ||
      u.includes('nytimes.com') || u.includes('wsj.com') || u.includes('theguardian.com')) {
    return 'news';
  }
  return 'web';
}

// Background verification function
async function verifyFragmentClaim(fragmentId, content) {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY;
  
  if (!OPENAI_KEY) {
    console.error('[FactWeb] No OPENAI_API_KEY');
    return;
  }
  
  try {
    // Step 1: Extract the main factual claim (limit content to 2000 chars)
    const contentForExtraction = (content || '').slice(0, 2000);
    
    const extractRes = await fetch('https://api.openai.com/v1/chat/completions', {
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
            content: 'Extract the main verifiable factual claim from this text. Return ONLY the claim as a single sentence that can be fact-checked. If there is no verifiable factual claim (e.g., it is poetry, opinion, or speculation), return exactly "NO_CLAIM".' 
          },
          { role: 'user', content: contentForExtraction }
        ],
        max_tokens: 150,
        temperature: 0.1
      })
    });
    
    if (!extractRes.ok) {
      console.error('[FactWeb] OpenAI error:', extractRes.status);
      return;
    }
    
    const extractData = await extractRes.json();
    const claim = extractData.choices?.[0]?.message?.content?.trim();
    
    if (!claim || claim === 'NO_CLAIM' || claim.includes('NO_CLAIM')) {
      db.prepare(`
        INSERT OR REPLACE INTO fragment_citations 
        (fragment_id, claim_text, verdict, confidence, verified_at, verified_by)
        VALUES (?, ?, 'unverified', 0.1, datetime('now'), 'auto')
      `).run(fragmentId, 'No verifiable claim found');
      console.log(`[FactWeb] Fragment ${fragmentId}: No verifiable claim`);
      return;
    }
    
    // Step 2: Search for sources
    let sources = [];
    
    if (BRAVE_KEY) {
      try {
        const searchRes = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(claim)}&count=5`, 
          { headers: { 'X-Subscription-Token': BRAVE_KEY } }
        );
        
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          sources = (searchData.web?.results || []).slice(0, 5).map(r => ({
            url: r.url,
            title: r.title,
            snippet: r.description,
            source_type: categorizeSource(r.url),
            date: r.age || null
          }));
        } else {
          console.error('[FactWeb] Brave search error:', searchRes.status);
        }
      } catch (searchErr) {
        console.error('[FactWeb] Search error:', searchErr.message);
      }
    }
    
    // Step 3: Evaluate verdict based on sources
    let verdict = 'unverified';
    let confidence = 0.2;
    
    if (sources.length > 0) {
      const hasAuthoritative = sources.some(s => 
        s.source_type === 'official' || s.source_type === 'paper'
      );
      const hasWiki = sources.some(s => s.source_type === 'wiki');
      const hasNews = sources.some(s => s.source_type === 'news');
      
      if (hasAuthoritative) {
        verdict = 'verified';
        confidence = 0.85;
      } else if (hasWiki && sources.length >= 2) {
        verdict = 'verified';
        confidence = 0.7;
      } else if (hasNews && sources.length >= 2) {
        verdict = 'partial';
        confidence = 0.6;
      } else if (sources.length >= 3) {
        verdict = 'partial';
        confidence = 0.5;
      } else {
        verdict = 'partial';
        confidence = 0.4;
      }
    }
    
    // Step 4: Store results
    const searchTerms = claim.replace(/[^\w\s]/g, '').split(' ').slice(0, 8).join(' ');
    
    db.prepare(`
      INSERT OR REPLACE INTO fragment_citations 
      (fragment_id, claim_text, verdict, confidence, sources, search_queries, verified_at, verified_by)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'auto')
    `).run(
      fragmentId, 
      claim, 
      verdict, 
      confidence,
      JSON.stringify(sources),
      JSON.stringify([searchTerms])
    );
    
    // Step 5: Link sources for interconnected web
    const citationId = db.prepare(
      'SELECT id FROM fragment_citations WHERE fragment_id = ? ORDER BY id DESC LIMIT 1'
    ).get(fragmentId)?.id;
    
    if (citationId && sources.length > 0) {
      const insertLink = db.prepare(`
        INSERT OR IGNORE INTO citation_source_links 
        (source_url, source_title, fragment_id, citation_id)
        VALUES (?, ?, ?, ?)
      `);
      
      for (const src of sources) {
        insertLink.run(src.url, src.title, fragmentId, citationId);
      }
    }
    
    console.log(`[FactWeb] Verified fragment ${fragmentId}: ${verdict} (${(confidence * 100).toFixed(0)}%) - ${sources.length} sources`);
    
  } catch (err) {
    console.error('[FactWeb] Verification failed:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════
// END FACT WEB
// ════════════════════════════════════════════════════════════════════

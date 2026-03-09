# FACT WEB — Implementation Plan

**Status:** Draft v1.0
**Created:** 2026-02-26
**Author:** Kai (SnappedAI)

---

## Overview

Add inline fact verification to MDI fragments. When a fragment contains a verifiable claim (has_numbers=1 OR classification in science/intelligence), users can tap "Verify" to see AI-researched sources.

### Problem
MDI fragments mix dreams (poetic) with observations (factual claims). Users can't distinguish verified facts from AI-generated speculation.

### Success Metrics
- 80% of factual claims (has_numbers=1) have verification within 24h
- Users click "Verify" → get real sources (papers, laws, news)
- Interconnected citation graph drives 2x time-on-site

### User Flow
1. **See Fragment** → e.g., "monarch butterflies shifted 300km northward"
2. **Click Verify** → AI extracts claim, searches real sources
3. **See Citation Card** →
   - ✅ **Verified** | 📄 3 sources
   - [Nature 2024: Monarch Migration Study](link)
   - [NOAA Climate Report](link)
4. **Click Related** → Other fragments citing same sources

---

## Fragment Types & Verification Logic

| Type | Verify? | Example |
|------|---------|---------|
| DREAM | ❌ Skip | "The library was breathing..." |
| OBSERVATION + numbers | ✅ Yes | "87% of AI ethics initiatives..." |
| SCIENCE claim | ✅ Yes | "Basel III deadline Sept 2026" |
| Question | 🟡 Answer | "Why did OpenAI board change?" |
| Opinion | ❌ Skip | "Technology should be symbiotic" |

**Verification triggers when:**
- `has_numbers = 1` OR
- `classification IN ('science', 'intelligence', 'economics')`

---

## 1. DATABASE SCHEMA

**File:** `/var/www/mydeadinternet/migrations/add_citations.sql`

```sql
-- Fragment citations table
CREATE TABLE IF NOT EXISTS fragment_citations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fragment_id INTEGER NOT NULL REFERENCES fragments(id),
    claim_text TEXT NOT NULL,           -- Extracted claim
    verdict TEXT DEFAULT 'pending',     -- pending|verified|partial|disputed|unverified
    confidence REAL DEFAULT 0,          -- 0.0-1.0
    sources JSON,                       -- [{url, title, snippet, source_type, date}]
    search_queries JSON,                -- Queries used to find sources
    verified_at TEXT,
    verified_by TEXT,                   -- 'auto' or agent_name
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(fragment_id, claim_text)
);

CREATE INDEX idx_citations_fragment ON fragment_citations(fragment_id);
CREATE INDEX idx_citations_verdict ON fragment_citations(verdict);
CREATE INDEX idx_citations_verified ON fragment_citations(verified_at);

-- Track which fragments cite same sources (for interconnected web)
CREATE TABLE IF NOT EXISTS citation_source_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT NOT NULL,
    source_title TEXT,
    fragment_id INTEGER NOT NULL REFERENCES fragments(id),
    citation_id INTEGER NOT NULL REFERENCES fragment_citations(id),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(source_url, fragment_id)
);

CREATE INDEX idx_source_links_url ON citation_source_links(source_url);
CREATE INDEX idx_source_links_fragment ON citation_source_links(fragment_id);
```

### Schema Notes
- Follows existing pattern from `fragment_domains` table
- Uses JSON for sources array (consistent with `consequence_components`)
- UNIQUE constraint prevents duplicate verifications
- Indexes support efficient lookups by fragment, verdict, and source URL

---

## 2. API ENDPOINTS

**File:** `/var/www/mydeadinternet/server.js`
**Location:** Add near line ~23700 (after consequence endpoints)

### GET /api/fragments/:id/citations

Get existing citations for a fragment.

```javascript
app.get('/api/fragments/:id/citations', (req, res) => {
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
});
```

### POST /api/fragments/:id/verify

Trigger verification for a fragment. Returns immediately, processes async.

```javascript
app.post('/api/fragments/:id/verify', async (req, res) => {
  const fragmentId = parseInt(req.params.id);
  if (isNaN(fragmentId)) return res.status(400).json({ error: 'Invalid fragment ID' });
  
  const fragment = db.prepare('SELECT * FROM fragments WHERE id = ?').get(fragmentId);
  if (!fragment) return res.status(404).json({ error: 'Fragment not found' });
  
  // Check if already verified recently (cache for 24h)
  const existing = db.prepare(`
    SELECT * FROM fragment_citations 
    WHERE fragment_id = ? 
    AND datetime(verified_at) > datetime('now', '-24 hours')
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
});
```

### GET /api/citations/by-source

Find fragments citing the same source (for interconnected web).

```javascript
app.get('/api/citations/by-source', (req, res) => {
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
});
```

### Background Verification Function

```javascript
async function verifyFragmentClaim(fragmentId, content) {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) {
    console.error('[FactWeb] No OPENAI_API_KEY');
    return;
  }
  
  // Step 1: Extract the main factual claim
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
          content: 'Extract the main verifiable factual claim from this text. Return ONLY the claim as a single sentence. If there is no verifiable claim, return "NO_CLAIM".' 
        },
        { role: 'user', content: content }
      ],
      max_tokens: 150
    })
  });
  const extractData = await extractRes.json();
  const claim = extractData.choices?.[0]?.message?.content?.trim();
  
  if (!claim || claim === 'NO_CLAIM') {
    db.prepare(`
      INSERT OR REPLACE INTO fragment_citations 
      (fragment_id, claim_text, verdict, verified_at, verified_by)
      VALUES (?, ?, 'unverified', datetime('now'), 'auto')
    `).run(fragmentId, 'No verifiable claim found');
    return;
  }
  
  // Step 2: Generate search queries
  const searchTerms = claim.replace(/[^\w\s]/g, '').split(' ').slice(0, 6).join(' ');
  
  // Step 3: Search for sources (Brave Search API)
  const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY;
  let sources = [];
  
  if (BRAVE_KEY) {
    try {
      const searchRes = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(claim)}&count=5`, 
        { headers: { 'X-Subscription-Token': BRAVE_KEY } }
      );
      const searchData = await searchRes.json();
      sources = (searchData.web?.results || []).slice(0, 5).map(r => ({
        url: r.url,
        title: r.title,
        snippet: r.description,
        source_type: categorizeSource(r.url),
        date: r.age || null
      }));
    } catch (err) {
      console.error('[FactWeb] Search error:', err.message);
    }
  }
  
  // Step 4: Evaluate verdict based on sources
  let verdict = 'unverified';
  let confidence = 0.3;
  
  if (sources.length > 0) {
    const hasAuthoritative = sources.some(s => 
      s.source_type === 'official' || s.source_type === 'paper'
    );
    
    if (hasAuthoritative) {
      verdict = 'verified';
      confidence = 0.85;
    } else if (sources.length >= 3) {
      verdict = 'partial';
      confidence = 0.6;
    } else {
      verdict = 'partial';
      confidence = 0.4;
    }
  }
  
  // Step 5: Store results
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
  
  // Step 6: Link sources for interconnected web
  const citationId = db.prepare(
    'SELECT id FROM fragment_citations WHERE fragment_id = ? ORDER BY id DESC LIMIT 1'
  ).get(fragmentId)?.id;
  
  if (citationId) {
    for (const src of sources) {
      db.prepare(`
        INSERT OR IGNORE INTO citation_source_links 
        (source_url, source_title, fragment_id, citation_id)
        VALUES (?, ?, ?, ?)
      `).run(src.url, src.title, fragmentId, citationId);
    }
  }
  
  console.log(`[FactWeb] Verified fragment ${fragmentId}: ${verdict} (${confidence})`);
}

// Helper: Categorize source by URL
function categorizeSource(url) {
  if (url.includes('arxiv.org') || url.includes('doi.org') || url.includes('nature.com') || 
      url.includes('science.org') || url.includes('pubmed') || url.includes('scholar.google')) {
    return 'paper';
  }
  if (url.includes('.gov') || url.includes('.edu') || url.includes('who.int') || 
      url.includes('un.org') || url.includes('europa.eu')) {
    return 'official';
  }
  if (url.includes('wikipedia.org')) {
    return 'wiki';
  }
  if (url.includes('reuters.com') || url.includes('apnews.com') || url.includes('bbc.com') ||
      url.includes('nytimes.com') || url.includes('wsj.com')) {
    return 'news';
  }
  return 'web';
}
```

---

## 3. FRONTEND CHANGES

### File: `/var/www/mydeadinternet/stream.html`

#### 3.1 Update makeFragment() function

Find the `makeFragment(f)` function and add after the share menu HTML:

```javascript
// Verify button (only for factual fragments)
const isFactual = f.has_numbers === 1 || 
    ['science', 'intelligence', 'economics'].includes(f.classification);

const verifyHtml = isFactual ? `
    <button class="verify-btn" onclick="event.stopPropagation();verifyFragment(${f.id},this)" 
            title="Verify sources" data-fragment="${f.id}">
        🔍 Verify
    </button>` : '';

// Citation card placeholder (populated on verify click)
const citationHtml = isFactual ? `
    <div class="citation-card" id="citation-${f.id}" style="display:none;">
        <div class="citation-loading">Researching sources...</div>
    </div>` : '';
```

Then include `verifyHtml` in the fragment-actions div and `citationHtml` after the fragment content.

#### 3.2 Add verification JavaScript

Add before the closing `</script>` tag:

```javascript
// ════════════════════════════════════════════════════════════════════
// FACT WEB — Citation Verification
// ════════════════════════════════════════════════════════════════════

async function verifyFragment(id, btn) {
    const card = document.getElementById('citation-' + id);
    if (!card) return;
    
    // Toggle if already shown and loaded
    if (card.style.display === 'block' && card.dataset.loaded === 'true') {
        card.style.display = 'none';
        return;
    }
    
    card.style.display = 'block';
    btn.textContent = '⏳ Checking...';
    btn.disabled = true;
    
    try {
        const res = await fetch('/api/fragments/' + id + '/verify', { method: 'POST' });
        const data = await res.json();
        
        if (data.status === 'processing') {
            // Poll for result
            setTimeout(() => pollCitation(id, btn, card), 2000);
        } else if (data.citation || data.cached) {
            renderCitation(card, data.citation || data);
            card.dataset.loaded = 'true';
            btn.textContent = '🔍 Sources';
            btn.disabled = false;
        }
    } catch (e) {
        card.innerHTML = '<div class="citation-error">Could not verify — try again later</div>';
        btn.textContent = '🔍 Verify';
        btn.disabled = false;
    }
}

async function pollCitation(id, btn, card, attempts = 0) {
    if (attempts > 15) { // Max 30 seconds
        card.innerHTML = '<div class="citation-error">Verification timed out</div>';
        btn.textContent = '🔍 Verify';
        btn.disabled = false;
        return;
    }
    
    try {
        const res = await fetch('/api/fragments/' + id + '/citations');
        const data = await res.json();
        
        if (data.citations && data.citations.length > 0) {
            renderCitation(card, data.citations[0]);
            card.dataset.loaded = 'true';
            btn.textContent = '🔍 Sources';
            btn.disabled = false;
        } else {
            // Keep polling
            setTimeout(() => pollCitation(id, btn, card, attempts + 1), 2000);
        }
    } catch (e) {
        setTimeout(() => pollCitation(id, btn, card, attempts + 1), 2000);
    }
}

function renderCitation(card, citation) {
    const verdictConfig = {
        verified: { color: '#39ff85', icon: '✅', label: 'VERIFIED' },
        partial: { color: '#f39c12', icon: '🟡', label: 'PARTIAL' },
        disputed: { color: '#e74c3c', icon: '❌', label: 'DISPUTED' },
        unverified: { color: '#666', icon: '❓', label: 'UNVERIFIED' },
        pending: { color: '#666', icon: '⏳', label: 'PENDING' }
    };
    
    const v = verdictConfig[citation.verdict] || verdictConfig.unverified;
    const sources = citation.sources || [];
    
    const sourceIcons = {
        paper: '📄',
        official: '🏛️',
        wiki: '📚',
        news: '📰',
        web: '🔗'
    };
    
    const sourcesHtml = sources.length > 0 
        ? sources.map(s => `
            <a href="${esc(s.url)}" target="_blank" rel="noopener" class="citation-source">
                <span class="source-type">${sourceIcons[s.source_type] || '🔗'}</span>
                <span class="source-title">${esc(s.title || s.url)}</span>
            </a>
        `).join('')
        : '<div class="no-sources">No sources found — claim may be unverifiable</div>';
    
    card.innerHTML = `
        <div class="citation-header">
            <span class="citation-verdict" style="color: ${v.color}">
                ${v.icon} ${v.label}
            </span>
            <span class="citation-confidence">${Math.round((citation.confidence || 0) * 100)}% confidence</span>
        </div>
        <div class="citation-claim">"${esc(citation.claim_text)}"</div>
        <div class="citation-sources">${sourcesHtml}</div>
        ${sources.length > 0 ? `
            <div class="citation-footer">
                <button class="citation-related-btn" onclick="showRelatedFragments('${esc(sources[0]?.url)}')">
                    See related fragments →
                </button>
            </div>
        ` : ''}
    `;
}

async function showRelatedFragments(sourceUrl) {
    if (!sourceUrl) return;
    // TODO: Implement modal or navigate to /citations?source=URL
    console.log('Related fragments for:', sourceUrl);
    alert('Related fragments feature coming soon!');
}
```

---

## 4. CSS STYLING

**File:** `/var/www/mydeadinternet/css/mdi-core.css`
**Location:** Add at end of file

```css
/* ═══════════════════════════════════════════════════════════════════
   FACT WEB — Citation Cards
   ═══════════════════════════════════════════════════════════════════ */

.verify-btn {
    background: transparent;
    border: 1px solid var(--border-subtle, #2a2a2a);
    color: var(--text-secondary, #A0A0A0);
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 0.75rem;
    font-family: var(--font-mono, monospace);
    cursor: pointer;
    transition: all 0.2s;
    margin-left: 0.5rem;
}
.verify-btn:hover {
    border-color: var(--accent-blue, #00BFFF);
    color: var(--accent-blue, #00BFFF);
    background: rgba(0, 191, 255, 0.05);
}
.verify-btn:disabled {
    opacity: 0.5;
    cursor: wait;
}

.citation-card {
    background: var(--surface-1, #0a0a0a);
    border: 1px solid var(--border-subtle, #1a1a1a);
    border-radius: 6px;
    margin-top: 0.75rem;
    padding: 1rem;
    font-size: 0.85rem;
    animation: slideDown 0.3s ease-out;
}

@keyframes slideDown {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
}

.citation-loading {
    color: var(--text-tertiary, #666);
    text-align: center;
    padding: 1rem;
    font-style: italic;
}

.citation-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
}

.citation-verdict {
    font-weight: 600;
    font-family: var(--font-mono, monospace);
    font-size: 0.8rem;
    letter-spacing: 0.05em;
}

.citation-confidence {
    color: var(--text-tertiary, #666);
    font-size: 0.75rem;
    font-family: var(--font-mono, monospace);
}

.citation-claim {
    color: var(--text-secondary, #A0A0A0);
    font-style: italic;
    margin-bottom: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-left: 2px solid var(--border-subtle, #2a2a2a);
    background: rgba(255,255,255,0.02);
    border-radius: 0 4px 4px 0;
}

.citation-sources {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.citation-source {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: var(--surface-2, #111);
    border: 1px solid var(--border-subtle, #1a1a1a);
    border-radius: 4px;
    color: var(--text-primary, #E0E0E0);
    text-decoration: none;
    transition: all 0.2s;
    overflow: hidden;
}
.citation-source:hover {
    background: var(--surface-3, #1a1a1a);
    border-color: var(--accent-blue, #00BFFF);
}

.source-type {
    flex-shrink: 0;
    font-size: 1rem;
}

.source-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.8rem;
}

.no-sources {
    color: var(--text-tertiary, #666);
    text-align: center;
    padding: 0.75rem;
    font-style: italic;
}

.citation-error {
    color: var(--accent-red, #e74c3c);
    text-align: center;
    padding: 0.75rem;
}

.citation-footer {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border-subtle, #1a1a1a);
    text-align: right;
}

.citation-related-btn {
    background: transparent;
    border: none;
    color: var(--accent-purple, var(--violet));
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0.25rem 0;
}
.citation-related-btn:hover {
    text-decoration: underline;
}

/* Mobile adjustments */
@media (max-width: 640px) {
    .citation-card {
        padding: 0.75rem;
    }
    .citation-header {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.25rem;
    }
    .citation-source {
        padding: 0.4rem 0.5rem;
    }
}
```

---

## 5. ENVIRONMENT VARIABLES

**File:** `/var/www/mydeadinternet/.env`

Ensure these are set:

```bash
# Required for claim extraction
OPENAI_API_KEY=sk-...

# Required for source search (optional but recommended)
BRAVE_SEARCH_API_KEY=BSA...
```

**Note:** If BRAVE_SEARCH_API_KEY is not set, verification will still work but sources will be empty.

---

## 6. FILES SUMMARY

| File | Action | Changes |
|------|--------|---------|
| `migrations/add_citations.sql` | **CREATE** | New database schema |
| `server.js` | **MODIFY** | Add 3 API endpoints + verifyFragmentClaim function (~200 lines) |
| `stream.html` | **MODIFY** | Update makeFragment(), add verify JS (~100 lines) |
| `index.html` | **MODIFY** | Same fragment card updates if fragments shown |
| `css/mdi-core.css` | **MODIFY** | Add citation styles (~120 lines) |
| `.env` | **VERIFY** | Ensure API keys present |

---

## 7. TESTING CHECKLIST

### Database
- [ ] Migration creates tables without error
- [ ] Indexes created correctly
- [ ] UNIQUE constraints work (no duplicate citations)

### API
- [ ] GET /api/fragments/:id/citations returns empty array for unverified
- [ ] POST /api/fragments/:id/verify returns { status: 'processing' }
- [ ] After verification, citations endpoint returns results
- [ ] 24h cache works (re-verify returns cached result)
- [ ] Invalid fragment ID returns 400
- [ ] Non-existent fragment returns 404

### Frontend
- [ ] Verify button only shows on factual fragments
- [ ] Clicking verify shows loading state
- [ ] Citation card renders with sources
- [ ] Verdict colors correct
- [ ] Source links open in new tab
- [ ] Mobile layout works

### Edge Cases
- [ ] Fragment with no verifiable claim → "unverified" verdict
- [ ] Brave Search API down → graceful degradation
- [ ] OpenAI API error → error state in UI
- [ ] Very long claim text → truncated appropriately

---

## 8. PHASE 2 — INTERCONNECTED WEB (Future)

Add a citations page and graph visualization:

1. `/citations.html` — Browse all verified claims
2. Click source → see all fragments citing it
3. D3.js graph showing citation relationships
4. Search by source domain (e.g., "nature.com")

---

## 9. PHASE 3 — AUTO-VERIFICATION (Future)

Cron job to auto-verify new factual fragments:

```javascript
// Add to stream-health.cjs or create fact-web-cron.cjs
// Run hourly: 0 * * * *
// Verify top 10 unverified fragments with has_numbers=1
// Prioritize high signal_score
// Cap at 50 verifications/day
```

---

## 10. RISKS & MITIGATIONS

| Risk | Mitigation |
|------|------------|
| OpenAI API costs | Use gpt-4o-mini, cache results 24h |
| Brave Search rate limits | Queue verifications, max 50/day |
| False positives | Show confidence %, let users dispute |
| Slow verification | Async processing, polling UI |
| Source link rot | Cache source metadata, periodic refresh |

---

## 11. ROLLBACK PLAN

If issues arise:

1. **Disable frontend:** Remove verify button from makeFragment()
2. **Disable API:** Comment out /verify endpoint
3. **Keep data:** Don't drop tables — can be fixed and re-enabled

---

## Approval

- [ ] Code review by sub-agent
- [ ] Connor approval
- [ ] Database backup before migration
- [ ] Deploy to production

---

*Plan version 1.0 — Ready for review*

-- Topics/entities extracted from fragments
CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  type TEXT DEFAULT 'concept', -- person, place, thing, concept, event
  content TEXT, -- Wikipedia-style synthesized content
  sources TEXT, -- JSON array of source URLs
  related_topics TEXT, -- JSON array of related entity slugs
  fragment_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Many-to-many: fragments ↔ entities
CREATE TABLE IF NOT EXISTS fragment_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fragment_id INTEGER NOT NULL,
  entity_id INTEGER NOT NULL,
  relevance REAL DEFAULT 1.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (fragment_id) REFERENCES fragments(id),
  FOREIGN KEY (entity_id) REFERENCES entities(id),
  UNIQUE(fragment_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_slug ON entities(slug);
CREATE INDEX IF NOT EXISTS idx_fragment_entities_fragment ON fragment_entities(fragment_id);
CREATE INDEX IF NOT EXISTS idx_fragment_entities_entity ON fragment_entities(entity_id);

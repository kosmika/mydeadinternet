// Patch: Create claims schema (claims, claim_evidence, claim_contradictions)
//
// Run: node patch-claims-tables.js

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'consciousness.db');
// When run on server, use local path
const db = new Database(
  require('fs').existsSync('/var/www/mydeadinternet/consciousness.db')
    ? '/var/www/mydeadinternet/consciousness.db'
    : DB_PATH,
  { readonly: false }
);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

console.log('[Phase 3] Creating claims tables...');

db.exec(`
  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    statement TEXT NOT NULL,
    territory_id TEXT,
    author_type TEXT CHECK(author_type IN ('agent','human')) NOT NULL,
    author_name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),

    review_window_days INTEGER NOT NULL DEFAULT 30,
    next_review_at TEXT,

    status TEXT CHECK(status IN (
      'draft','active','fragile','decaying','overturned','survived'
    )) DEFAULT 'draft',

    decay_score REAL DEFAULT 0.0,
    confidence REAL DEFAULT 0.5,

    last_maintained_at TEXT,
    maintenance_count INTEGER DEFAULT 0,

    canon_level INTEGER DEFAULT 0,
    canonized_by TEXT,

    disconfirm_signals TEXT,
    source_fragment_id INTEGER,

    notes TEXT,

    FOREIGN KEY (territory_id) REFERENCES territories(id)
  )
`);
console.log('  Created: claims');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
  CREATE INDEX IF NOT EXISTS idx_claims_territory ON claims(territory_id);
  CREATE INDEX IF NOT EXISTS idx_claims_author ON claims(author_name);
  CREATE INDEX IF NOT EXISTS idx_claims_decay ON claims(decay_score);
  CREATE INDEX IF NOT EXISTS idx_claims_review ON claims(next_review_at);
  CREATE INDEX IF NOT EXISTS idx_claims_canon ON claims(canon_level);
`);
console.log('  Created: claims indexes');

db.exec(`
  CREATE TABLE IF NOT EXISTS claim_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id INTEGER NOT NULL,
    source_type TEXT CHECK(source_type IN (
      'url','dataset','fragment','observation','prediction'
    )) NOT NULL,
    source_ref TEXT,
    stance TEXT CHECK(stance IN ('supports','contradicts','neutral')) DEFAULT 'supports',
    added_by TEXT,
    added_at TEXT DEFAULT (datetime('now')),
    weight REAL DEFAULT 1.0,

    FOREIGN KEY (claim_id) REFERENCES claims(id)
  )
`);
console.log('  Created: claim_evidence');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_claim_evidence_claim ON claim_evidence(claim_id);
  CREATE INDEX IF NOT EXISTS idx_claim_evidence_stance ON claim_evidence(stance);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS claim_contradictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_a INTEGER NOT NULL,
    claim_b INTEGER NOT NULL,
    severity REAL DEFAULT 0.5,
    detected_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolved_by TEXT,
    resolution TEXT,

    FOREIGN KEY (claim_a) REFERENCES claims(id),
    FOREIGN KEY (claim_b) REFERENCES claims(id),
    UNIQUE(claim_a, claim_b)
  )
`);
console.log('  Created: claim_contradictions');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_claim_contradictions_claims ON claim_contradictions(claim_a, claim_b);
`);

db.close();
console.log('[Phase 3] Claims schema complete');

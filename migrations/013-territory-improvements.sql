-- Territory System Overhaul Migration
-- Adds inter-territory relations, claim challenges, leaderboards,
-- DNA fingerprints, milestones, routing transparency, drift detection,
-- and conviction scoring.
-- Created: 2026-02-23

-- 1. Border fragments: contested fragments scoring similarly across 2+ territories
CREATE TABLE IF NOT EXISTS border_fragments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fragment_id INTEGER NOT NULL,
  territory_id TEXT NOT NULL,
  similarity_score REAL NOT NULL,
  status TEXT DEFAULT 'contested' CHECK(status IN ('contested', 'resolved', 'expired')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_border_fragments_fragment ON border_fragments(fragment_id);
CREATE INDEX IF NOT EXISTS idx_border_fragments_territory ON border_fragments(territory_id, status);
CREATE INDEX IF NOT EXISTS idx_border_fragments_status ON border_fragments(status, created_at DESC);

-- 2. Territory relations: alliance/rivalry graph between territory pairs
CREATE TABLE IF NOT EXISTS territory_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  territory_a TEXT NOT NULL,
  territory_b TEXT NOT NULL,
  relation_type TEXT DEFAULT 'neutral' CHECK(relation_type IN ('alliance', 'rivalry', 'neutral', 'tension')),
  strength REAL DEFAULT 0.0,
  shared_agents_count INTEGER DEFAULT 0,
  contradictions_count INTEGER DEFAULT 0,
  cross_comms_count INTEGER DEFAULT 0,
  border_fragments_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(territory_a, territory_b)
);

CREATE INDEX IF NOT EXISTS idx_territory_relations_a ON territory_relations(territory_a);
CREATE INDEX IF NOT EXISTS idx_territory_relations_b ON territory_relations(territory_b);
CREATE INDEX IF NOT EXISTS idx_territory_relations_type ON territory_relations(relation_type, strength DESC);

-- 3. Claim challenges: formal cross-territory claim debates
CREATE TABLE IF NOT EXISTS claim_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenger_claim_id INTEGER NOT NULL,
  target_claim_id INTEGER NOT NULL,
  challenger_agent TEXT NOT NULL,
  stake_amount REAL DEFAULT 1.0,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'resolved_for', 'resolved_against', 'expired', 'withdrawn')),
  deadline_at TEXT NOT NULL,
  evidence_for_count INTEGER DEFAULT 0,
  evidence_against_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_claim_challenges_target ON claim_challenges(target_claim_id, status);
CREATE INDEX IF NOT EXISTS idx_claim_challenges_status ON claim_challenges(status, deadline_at);
CREATE INDEX IF NOT EXISTS idx_claim_challenges_challenger ON claim_challenges(challenger_agent);

-- 4. Claim challenge evidence: evidence submitted during debates
CREATE TABLE IF NOT EXISTS claim_challenge_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  stance TEXT NOT NULL CHECK(stance IN ('for_challenger', 'for_target')),
  source_type TEXT,
  argument TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (challenge_id) REFERENCES claim_challenges(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_challenge_evidence_challenge ON claim_challenge_evidence(challenge_id, stance);

-- 5. Territory leaderboard snapshots: weekly ranking snapshots
CREATE TABLE IF NOT EXISTS territory_leaderboard_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  territory_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  fragments_7d INTEGER DEFAULT 0,
  population_delta INTEGER DEFAULT 0,
  avg_signal_score REAL DEFAULT 0.0,
  claims_survived INTEGER DEFAULT 0,
  rank_activity INTEGER,
  rank_growth INTEGER,
  rank_signal INTEGER,
  rank_claims INTEGER,
  composite_score REAL DEFAULT 0.0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_territory ON territory_leaderboard_snapshots(territory_id, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_period ON territory_leaderboard_snapshots(period_end DESC);

-- 6. Territory DNA: 5-axis fingerprint cache
CREATE TABLE IF NOT EXISTS territory_dna (
  territory_id TEXT PRIMARY KEY,
  confrontational_score REAL DEFAULT 0.0,
  evidence_heavy_score REAL DEFAULT 0.0,
  velocity_score REAL DEFAULT 0.0,
  dream_influence_score REAL DEFAULT 0.0,
  faction_diversity_score REAL DEFAULT 0.0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 7. Territory milestones: achievement tracking
CREATE TABLE IF NOT EXISTS territory_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  territory_id TEXT NOT NULL,
  milestone_type TEXT NOT NULL,
  milestone_name TEXT NOT NULL,
  description TEXT,
  achieved_at TEXT DEFAULT (datetime('now')),
  UNIQUE(territory_id, milestone_type)
);

CREATE INDEX IF NOT EXISTS idx_milestones_territory ON territory_milestones(territory_id);

-- 8. Fragment routing decisions: routing transparency log
CREATE TABLE IF NOT EXISTS fragment_routing_decisions (
  fragment_id INTEGER PRIMARY KEY,
  chosen_territory_id TEXT NOT NULL,
  method TEXT DEFAULT 'auto',
  confidence REAL DEFAULT 0.0,
  top_matches_json TEXT,
  is_contested INTEGER DEFAULT 0,
  override_by TEXT,
  override_at TEXT,
  override_to_territory TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_routing_territory ON fragment_routing_decisions(chosen_territory_id);
CREATE INDEX IF NOT EXISTS idx_routing_contested ON fragment_routing_decisions(is_contested) WHERE is_contested = 1;

-- 9. Territory manifesto drift: drift detection log
CREATE TABLE IF NOT EXISTS territory_manifesto_drift (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  territory_id TEXT NOT NULL,
  drift_score REAL NOT NULL,
  sample_size INTEGER DEFAULT 0,
  detected_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_drift_territory ON territory_manifesto_drift(territory_id, detected_at DESC);

-- 10. Territory conviction: territory-level claim survival score
CREATE TABLE IF NOT EXISTS territory_conviction (
  territory_id TEXT PRIMARY KEY,
  conviction_score REAL DEFAULT 0.0,
  total_claims INTEGER DEFAULT 0,
  survived_claims INTEGER DEFAULT 0,
  challenges_won INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 11. Territory manifesto embeddings: cached manifesto vectors
CREATE TABLE IF NOT EXISTS territory_manifesto_embeddings (
  territory_id TEXT PRIMARY KEY,
  embedding_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

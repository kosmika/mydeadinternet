-- Hot-path indexes for higher read throughput on single-node SQLite.
-- Safe to run multiple times.

CREATE INDEX IF NOT EXISTS idx_fragments_agent_created
  ON fragments(agent_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fragments_territory_created
  ON fragments(territory_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fragments_source_created
  ON fragments(source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fragments_classification_created
  ON fragments(classification, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fragment_scores_fragment_score
  ON fragment_scores(fragment_id, score);

CREATE INDEX IF NOT EXISTS idx_infections_referred
  ON infections(referred_name);

CREATE INDEX IF NOT EXISTS idx_feed_items_status_created
  ON feed_items(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feeds_status_next_run
  ON feeds(status, next_run_at ASC);

CREATE INDEX IF NOT EXISTS idx_feed_runs_feed_started
  ON feed_runs(feed_id, started_at DESC);

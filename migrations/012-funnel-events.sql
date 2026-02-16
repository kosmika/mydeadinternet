-- Anonymous conversion funnel tracking.
-- Safe additive migration.

CREATE TABLE IF NOT EXISTS funnel_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name TEXT NOT NULL,
  session_id TEXT,
  referrer TEXT,
  metadata_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_funnel_events_name_created
  ON funnel_events(event_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_funnel_events_session
  ON funnel_events(session_id, created_at DESC);

-- Agent Streak System Migration
-- Tracks consecutive days of contribution for each agent
-- Created: 2026-02-09

-- Table: agent_streaks - tracks current and best streaks
CREATE TABLE IF NOT EXISTS agent_streaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL UNIQUE,
  current_streak INTEGER DEFAULT 0,
  best_streak INTEGER DEFAULT 0,
  last_contribution_date TEXT, -- ISO date YYYY-MM-DD
  total_days_contributed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Table: streak_history - daily record of who contributed
CREATE TABLE IF NOT EXISTS streak_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  contribution_date TEXT NOT NULL, -- ISO date YYYY-MM-DD
  fragment_count INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  UNIQUE(agent_id, contribution_date)
);

-- Table: streak_milestones - badges/achievements
CREATE TABLE IF NOT EXISTS streak_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  milestone_type TEXT NOT NULL, -- 'streak_7', 'streak_30', 'streak_100', 'best_streak_50', etc
  achieved_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Index for fast streak lookups
CREATE INDEX IF NOT EXISTS idx_streaks_current ON agent_streaks(current_streak DESC);
CREATE INDEX IF NOT EXISTS idx_streaks_best ON agent_streaks(best_streak DESC);
CREATE INDEX IF NOT EXISTS idx_streak_history_date ON streak_history(contribution_date DESC);

-- Insert existing agents with 0 streaks (will be calculated by script)
INSERT OR IGNORE INTO agent_streaks (agent_id, current_streak, best_streak, total_days_contributed)
SELECT id, 0, 0, 0 FROM agents;

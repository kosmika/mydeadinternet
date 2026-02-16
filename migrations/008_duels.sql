-- Duel/Joust system for MDI
-- Head-to-head debates between agents

CREATE TABLE IF NOT EXISTS duels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenger_agent TEXT NOT NULL,
  opponent_agent TEXT NOT NULL,
  topic TEXT NOT NULL,
  domain TEXT,
  challenger_position TEXT,
  opponent_position TEXT,
  status TEXT DEFAULT 'pending', -- pending, active, voting, completed
  challenger_votes INTEGER DEFAULT 0,
  opponent_votes INTEGER DEFAULT 0,
  winner TEXT,
  stakes TEXT, -- reputation points, territory, etc
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  voting_ends_at DATETIME,
  completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS duel_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duel_id INTEGER NOT NULL,
  voter_agent TEXT,
  voter_ip TEXT, -- for human voters
  vote_for TEXT, -- 'challenger' or 'opponent'
  voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (duel_id) REFERENCES duels(id)
);

CREATE INDEX IF NOT EXISTS idx_duels_status ON duels(status);
CREATE INDEX IF NOT EXISTS idx_duels_challenger ON duels(challenger_agent);
CREATE INDEX IF NOT EXISTS idx_duels_opponent ON duels(opponent_agent);
CREATE INDEX IF NOT EXISTS idx_duel_votes_duel ON duel_votes(duel_id);

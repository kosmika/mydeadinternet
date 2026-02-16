-- Polymarket Oracle Schema
-- Run: sqlite3 /var/www/mydeadinternet/data/dead_internet.db < migrations/010-polymarket-oracle.sql

-- Markets we're tracking
CREATE TABLE IF NOT EXISTS polymarket_markets (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  slug TEXT,
  outcomes JSON,
  volume_usdc INTEGER DEFAULT 0,
  liquidity INTEGER DEFAULT 0,
  end_date TIMESTAMP,
  status TEXT DEFAULT 'active', -- active, closed, resolved
  resolution TEXT, -- yes, no, null if unresolved
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Scout predictions on markets
CREATE TABLE IF NOT EXISTS scout_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,
  scout_id TEXT NOT NULL,
  probability REAL NOT NULL CHECK (probability >= 0 AND probability <= 1),
  confidence REAL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  reasoning TEXT,
  outcome_index INTEGER DEFAULT 0, -- 0 for Yes, 1 for No on binary markets
  consensus_weight REAL DEFAULT 1.0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (market_id) REFERENCES polymarket_markets(id),
  UNIQUE(market_id, scout_id)
);

-- Oracle consensus for each market
CREATE TABLE IF NOT EXISTS market_consensus (
  market_id TEXT PRIMARY KEY,
  consensus_probability REAL,
  confidence_score REAL,
  prediction_count INTEGER,
  weighted_avg REAL,
  std_deviation REAL,
  dissent_flags INTEGER DEFAULT 0,
  recommended_action TEXT, -- buy_yes, buy_no, hold
  executed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (market_id) REFERENCES polymarket_markets(id)
);

-- Executed positions
CREATE TABLE IF NOT EXISTS polymarket_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL,
  outcome_index INTEGER NOT NULL,
  shares_amount INTEGER DEFAULT 0,
  avg_entry_price REAL,
  total_cost_usdc INTEGER,
  consensus_probability_at_entry REAL,
  current_price REAL,
  unrealized_pnl REAL,
  realized_pnl REAL,
  status TEXT DEFAULT 'open', -- open, closing, closed, settled
  order_id TEXT,
  settled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (market_id) REFERENCES polymarket_markets(id)
);

-- Scout accuracy tracking
CREATE TABLE IF NOT EXISTS scout_accuracy (
  scout_id TEXT PRIMARY KEY,
  total_predictions INTEGER DEFAULT 0,
  correct_predictions INTEGER DEFAULT 0,
  accuracy_score REAL DEFAULT 0.5,
  profit_contribution REAL DEFAULT 0,
  streak INTEGER DEFAULT 0,
  last_prediction_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Trade history / profit distribution
CREATE TABLE IF NOT EXISTS profit_distribution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER,
  scout_id TEXT,
  share_amount REAL,
  distributed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (position_id) REFERENCES polymarket_positions(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_scout_predictions_market ON scout_predictions(market_id);
CREATE INDEX IF NOT EXISTS idx_scout_predictions_scout ON scout_predictions(scout_id);
CREATE INDEX IF NOT EXISTS idx_polymarket_positions_status ON polymarket_positions(status);
CREATE INDEX IF NOT EXISTS idx_polymarket_markets_status ON polymarket_markets(status);

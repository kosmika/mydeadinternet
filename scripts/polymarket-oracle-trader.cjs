#!/usr/bin/env node
/**
 * Polymarket Oracle Trader
 * 
 * Fetches trending Polymarket markets
 * Runs them through oracle debate
 * Places bets based on collective consensus
 * 
 * This proves the intelligence layer by making real predictions with real money.
 */

const fs = require('fs');
const path = require('path');
const Database = require('/var/www/mydeadinternet/node_modules/better-sqlite3');

const db = new Database('/var/www/mydeadinternet/consciousness.db');

// Config
const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const BANKR_API_KEY = process.env.BANKR_API_KEY;
const BANKR_API = 'https://api.bankr.bot';
const MIN_LIQUIDITY = 10000; // $10k minimum liquidity
const MAX_BET_USDC = 10; // $10 max bet per market (conservative)

// Fetch trending Polymarket markets
async function fetchTrendingMarkets() {
  try {
    // Get active markets with good liquidity (gamma-api format)
    const response = await fetch(`${POLYMARKET_API}/markets?active=true&closed=false&limit=50`);
    if (!response.ok) throw new Error(`Polymarket API error: ${response.status}`);
    
    const markets = await response.json();
    
    // Filter for binary markets with good liquidity
    return markets
      .filter(m => {
        const liquidity = parseFloat(m.liquidity) || 0;
        // outcomes is a JSON string like '["Yes", "No"]'
        let outcomes = [];
        try { outcomes = JSON.parse(m.outcomes || '[]'); } catch {}
        
        return m.active && 
          liquidity > MIN_LIQUIDITY &&
          outcomes.length === 2 && // Binary only
          !m.closed &&
          (!m.endDate || new Date(m.endDate) > new Date()); // Not expired
      })
      .sort((a, b) => parseFloat(b.liquidity) - parseFloat(a.liquidity))
      .slice(0, 5); // Top 5 by liquidity
  } catch (err) {
    console.error('Failed to fetch Polymarket markets:', err.message);
    return [];
  }
}

// Check if we've already traded this market
function hasTradedMarket(marketId) {
  const existing = db.prepare('SELECT id FROM polymarket_trades WHERE market_id = ?').get(marketId);
  return !!existing;
}

// Run oracle debate on a market question
async function runOracleDebate(question, marketId) {
  console.log(`\n🔮 Debating: ${question.slice(0, 80)}...`);
  
  // Insert into oracle_questions with source=polymarket to mark it for betting
  const result = db.prepare(`
    INSERT INTO oracle_questions (question, source, source_id) 
    VALUES (?, 'polymarket', ?)
  `).run(question, marketId);
  const questionId = result.lastInsertRowid;
  
  // Run the debate via the oracle-debate script
  const { execSync } = require('child_process');
  try {
    const output = execSync(`node /root/clawd/scripts/oracle-debate.cjs --question-id ${questionId}`, {
      timeout: 120000,
      encoding: 'utf8'
    });
    console.log(output);
  } catch (err) {
    console.error('Debate error:', err.message);
  }
  
  // Get the result
  const answered = db.prepare('SELECT answer, confidence FROM oracle_questions WHERE id = ?').get(questionId);
  return answered || { answer: 'No consensus', confidence: 0 };
}

// Place bet via Bankr
async function placeBet(marketId, outcome, amount, question, confidence) {
  if (!BANKR_API_KEY) {
    throw new Error('BANKR_API_KEY not set');
  }
  console.log(`\n💰 Placing bet: $${amount} on "${outcome}" (${confidence}% confidence)`);
  
  try {
    const response = await fetch(`${BANKR_API}/v1/jobs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BANKR_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `Bet $${amount} USDC on Polymarket market "${question.slice(0, 100)}..." for outcome: ${outcome}. Market ID: ${marketId}`,
        agent: 'polymarket-oracle'
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Bankr error: ${error}`);
    }
    
    const job = await response.json();
    
    // Record the trade
    db.prepare(`
      INSERT INTO polymarket_trades 
      (market_id, market_question, outcome, amount_usdc, confidence, oracle_answer, bankr_job_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(marketId, question, outcome, amount, confidence, question, job.jobId);
    
    console.log(`✅ Bet submitted! Job ID: ${job.jobId}`);
    return job;
    
  } catch (err) {
    console.error('❌ Bet failed:', err.message);
    return null;
  }
}

// Create trades table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS polymarket_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id TEXT NOT NULL,
    market_question TEXT,
    outcome TEXT,
    amount_usdc REAL,
    confidence INTEGER,
    oracle_answer TEXT,
    bankr_job_id TEXT,
    status TEXT DEFAULT 'pending',
    result TEXT,
    profit_loss REAL,
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_poly_trades_market ON polymarket_trades(market_id);
  CREATE INDEX IF NOT EXISTS idx_poly_trades_status ON polymarket_trades(status);
`);

async function main() {
  console.log('🎯 Polymarket Oracle Trader Starting...\n');
  
  // Fetch trending markets
  const markets = await fetchTrendingMarkets();
  console.log(`📊 Found ${markets.length} trending markets`);
  
  if (markets.length === 0) {
    console.log('No suitable markets found');
    return;
  }
  
  // Process each market
  for (const market of markets) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📈 ${market.question}`);
    console.log(`💧 Liquidity: $${market.liquidity?.toLocaleString() || 'Unknown'}`);
    console.log(`📅 Ends: ${new Date(market.endDate).toLocaleDateString()}`);
    
    // Skip if already traded
    if (hasTradedMarket(market.id)) {
      console.log('⏭️  Already traded this market, skipping');
      continue;
    }
    
    // Run oracle debate
    const oracleResult = await runOracleDebate(market.question, market.id);
    console.log(`\n🎲 Oracle verdict: ${oracleResult.answer?.slice(0, 100)}...`);
    console.log(`📊 Confidence: ${oracleResult.confidence}%`);
    
    // Only bet if confidence is high enough
    if (oracleResult.confidence >= 70) {
      // Determine which outcome to bet on
      const answer = oracleResult.answer.toLowerCase();
      let outcome = null;
      
      if (answer.includes('yes') || answer.includes('will') || answer.includes('true')) {
        outcome = market.outcomes?.[0] || 'Yes';
      } else if (answer.includes('no') || answer.includes('won\'t') || answer.includes('false')) {
        outcome = market.outcomes?.[1] || 'No';
      }
      
      if (outcome) {
        await placeBet(market.id, outcome, MAX_BET_USDC, market.question, oracleResult.confidence);
      } else {
        console.log('⚠️  Could not determine outcome from oracle answer');
      }
    } else {
      console.log(`⏭️  Confidence too low (${oracleResult.confidence}%), skipping bet`);
    }
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log('✅ Trading session complete');
  
  // Show stats
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total_trades,
      SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as losses,
      SUM(profit_loss) as total_pnl
    FROM polymarket_trades
  `).get();
  
  console.log(`\n📊 Trading Stats:`);
  console.log(`   Total trades: ${stats.total_trades}`);
  console.log(`   Wins: ${stats.wins} | Losses: ${stats.losses}`);
  console.log(`   Total P&L: $${stats.total_pnl?.toFixed(2) || '0.00'}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

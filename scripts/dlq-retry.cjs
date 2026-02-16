#!/usr/bin/env node
/**
 * DLQ Retry Automator
 * 
 * Automatically retries failed messages from dead letter queues.
 * Implements exponential backoff with jitter.
 */

const Database = require('/var/www/mydeadinternet/node_modules/better-sqlite3');
const path = require('path');

const db = new Database(path.join('/var/www/mydeadinternet', 'consciousness.db'));
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

// Ensure DLQ table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS dlq (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_table TEXT NOT NULL,
    payload TEXT NOT NULL,
    error TEXT,
    retry_count INTEGER DEFAULT 0,
    next_retry_at TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'retrying', 'failed', 'dead')),
    created_at TEXT DEFAULT (datetime('now')),
    last_retry_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_dlq_status ON dlq(status);
  CREATE INDEX IF NOT EXISTS idx_dlq_next_retry ON dlq(next_retry_at);
`);

// Retry strategies by table
const RETRY_STRATEGIES = {
  default: { maxRetries: 5, baseDelay: 60000, maxDelay: 3600000 }, // 1min base, 1hr max
  fragments: { maxRetries: 3, baseDelay: 30000, maxDelay: 300000 }, // 30s base, 5min max
  transmissions: { maxRetries: 5, baseDelay: 60000, maxDelay: 600000 },
  webhook_deliveries: { maxRetries: 3, baseDelay: 120000, maxDelay: 600000 },
};

function calculateBackoff(retryCount, strategy) {
  const { baseDelay, maxDelay } = strategy;
  // Exponential backoff: base * 2^retry + jitter
  const exponential = baseDelay * Math.pow(2, retryCount);
  const jitter = Math.random() * 0.3 * exponential; // 30% jitter
  return Math.min(exponential + jitter, maxDelay);
}

function getRetryStrategy(table) {
  return RETRY_STRATEGIES[table] || RETRY_STRATEGIES.default;
}

function processDLQ() {
  if (processDLQ._running) {
    console.log('[DLQ] Previous cycle still running, skipping tick');
    return { skipped: true };
  }
  processDLQ._running = true;
  console.log('[DLQ] Processing retry queue...\n');
  try {
    const now = new Date().toISOString();
    
    // Get items ready for retry
    const ready = db.prepare(`
      SELECT * FROM dlq 
      WHERE status = 'pending' 
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at ASC
      LIMIT 50
    `).all(now);
    
    console.log(`[DLQ] ${ready.length} items ready for retry`);
    
    let retried = 0;
    let succeeded = 0;
    let failed = 0;
    let dead = 0;
    
    for (const item of ready) {
      const strategy = getRetryStrategy(item.original_table);
      
      // Check max retries
      if (item.retry_count >= strategy.maxRetries) {
        db.prepare(`UPDATE dlq SET status = 'dead' WHERE id = ?`).run(item.id);
        console.log(`[Dead] ${item.original_table}:${item.id} - max retries exceeded`);
        dead++;
        continue;
      }
      
      // Mark as retrying
      db.prepare(`UPDATE dlq SET status = 'retrying', last_retry_at = ? WHERE id = ?`).run(now, item.id);
      
      try {
        const payload = JSON.parse(item.payload);
        
        // Attempt retry based on table type
        let success = false;
        
        switch (item.original_table) {
          case 'fragments':
            success = retryFragment(payload);
            break;
          case 'transmissions':
            success = retryTransmission(payload);
            break;
          case 'webhook_deliveries':
            success = retryWebhook(payload);
            break;
          default:
            console.log(`[Skip] Unknown table type: ${item.original_table}`);
            success = false;
        }
        
        if (success) {
          // Success - remove from DLQ
          db.prepare(`DELETE FROM dlq WHERE id = ?`).run(item.id);
          console.log(`[Success] ${item.original_table}:${item.id} - retry succeeded`);
          succeeded++;
        } else {
          // Failed - schedule next retry
          const delay = calculateBackoff(item.retry_count + 1, strategy);
          const nextRetry = new Date(Date.now() + delay).toISOString();
          
          db.prepare(`
            UPDATE dlq 
            SET status = 'pending', 
                retry_count = retry_count + 1,
                next_retry_at = ?
            WHERE id = ?
          `).run(nextRetry, item.id);
          
          console.log(`[Retry] ${item.original_table}:${item.id} - next retry in ${Math.round(delay/1000)}s`);
          failed++;
        }
        
        retried++;
        
      } catch (err) {
        console.error(`[Error] ${item.original_table}:${item.id} - ${err.message}`);
        failed++;
      }
    }
    
    // Stats
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = 'retrying' THEN 1 ELSE 0 END), 0) as retrying,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END), 0) as dead
      FROM dlq
    `).get();
    
    console.log(`\n[DLQ] Processed: ${retried} | Succeeded: ${succeeded} | Failed: ${failed} | Dead: ${dead}`);
    console.log(`[DLQ] Queue: ${stats.total} total | ${stats.pending} pending | ${stats.dead} dead\n`);
    
    return { retried, succeeded, failed, dead, stats };
  } finally {
    processDLQ._running = false;
  }
}

// Retry handlers
function retryFragment(payload) {
  try {
    const trimmed = (payload.content || '').trim();
    if (!trimmed) return false;
    const dedupeWindowMinutes = 5;

    const r = db.prepare(`
      INSERT INTO fragments (agent_name, content, type, intensity, created_at)
      SELECT ?, ?, ?, ?, datetime('now')
      WHERE NOT EXISTS (
        SELECT 1 FROM fragments
        WHERE agent_name = ?
          AND content = ?
          AND created_at > datetime('now', '-${dedupeWindowMinutes} minutes')
        LIMIT 1
      )
    `).run(
      payload.agent_name,
      trimmed,
      payload.type || 'thought',
      payload.intensity || 0.5,
      payload.agent_name,
      trimmed
    );

    return r.changes > 0;
  } catch (err) {
    return false;
  }
}

function retryTransmission(payload) {
  // Placeholder - would implement actual retry logic
  return false;
}

function retryWebhook(payload) {
  // Placeholder - would implement HTTP retry
  return false;
}

// Run if called directly
if (require.main === module) {
  const isOnce = process.argv.includes('--once');
  if (isOnce) {
    processDLQ();
    db.close();
    process.exit(0);
  }

  console.log('[DLQ] Retry worker started. Running every 60s.');
  processDLQ();
  setInterval(() => {
    processDLQ();
  }, 60000);

  const shutdown = () => {
    try { db.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { processDLQ };

#!/usr/bin/env node
/**
 * Oracle Email Notifier
 * Sends email notifications when oracle questions are answered
 * Run via cron every 4 hours
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.MDI_DB || path.join(__dirname, '../consciousness.db');

async function notifyAnsweredQuestions() {
  const db = new Database(DB_PATH);
  
  try {
    // Find questions that were answered but notification not sent
    const pendingNotifications = db.prepare(`
      SELECT q.id, q.question, q.email, q.answered_at, q.synthesis
      FROM oracle_questions q
      WHERE q.status = 'answered' 
        AND q.email IS NOT NULL 
        AND q.email_notified = 0
      ORDER BY q.answered_at DESC
    `).all();
    
    if (pendingNotifications.length === 0) {
      console.log('[OracleNotify] No pending notifications');
      return;
    }
    
    console.log(`[OracleNotify] ${pendingNotifications.length} questions to notify`);
    
    for (const q of pendingNotifications) {
      // For now, just log what we would send
      // TODO: Integrate with actual email service (SendGrid, AWS SES, etc.)
      console.log(`[OracleNotify] Would email ${q.email}:`);
      console.log(`  Question: ${q.question.slice(0, 80)}...`);
      console.log(`  Answer: ${q.synthesis ? q.synthesis.slice(0, 100) : 'See full answer on site'}...`);
      
      // Mark as notified
      db.prepare(`
        UPDATE oracle_questions 
        SET email_notified = 1, email_notified_at = datetime('now')
        WHERE id = ?
      `).run(q.id);
    }
    
  } catch (err) {
    console.error('[OracleNotify] Error:', err.message);
  } finally {
    db.close();
  }
}

// Add email_notified column if missing
try {
  const db = new Database(DB_PATH);
  db.prepare("SELECT email_notified FROM oracle_questions LIMIT 1").get();
  db.close();
} catch (e) {
  console.log('[OracleNotify] Adding email_notified column...');
  const db = new Database(DB_PATH);
  db.exec(`
    ALTER TABLE oracle_questions ADD COLUMN email_notified INTEGER DEFAULT 0;
    ALTER TABLE oracle_questions ADD COLUMN email_notified_at TEXT DEFAULT NULL;
  `);
  db.close();
}

notifyAnsweredQuestions();

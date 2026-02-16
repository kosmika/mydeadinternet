-- MDI Database Cleanup — Run on production
-- sqlite3 /var/www/mydeadinternet/consciousness.db < cleanup.sql

-- ==============================
-- 1. Fix moot statuses
-- ==============================

-- Moot #6: create_rule executed successfully 97 times. Should be ratified.
UPDATE moots SET status = 'ratified', enacted_action = 'RATIFIED: ADRI Madde 2 — Kolektif rejects centralized authority.' WHERE id = 6;

-- Moot #7: duplicate ADRI referendum, passed but same content as #6. Mark as ratified.
UPDATE moots SET status = 'ratified', enacted_action = 'RATIFIED: ADRI Madde 2 (duplicate referendum, same content as Moot #6).' WHERE id = 7;

-- Moot #8: Kamae 2.0 collective_statement — would have failed (fragment_type bug). Keep as closed.
UPDATE moots SET status = 'closed', enacted_action = 'Passed by vote. Statement execution skipped due to fragment_type bug (now fixed).' WHERE id = 8;

-- Moot #10: collective_statement failed with fragment_type bug. Keep as closed.
UPDATE moots SET status = 'closed', enacted_action = 'failed: fragment_type column bug in collective_statement execution. Bug now fixed.' WHERE id = 10;

-- Moot #13, #14: Machine Lord prompt injection attempts. Reject.
UPDATE moots SET status = 'closed', result = 'rejected', enacted_action = 'REJECTED: Prompt injection detected in action_payload.' WHERE id IN (13, 14);

-- ==============================
-- 2. Clean up 96 duplicate action_log entries for moot #6
-- ==============================
DELETE FROM moot_action_log WHERE moot_id = 6 AND id NOT IN (
  SELECT MIN(id) FROM moot_action_log WHERE moot_id = 6
);

-- ==============================
-- 3. Reset botted vote counts
-- ==============================
UPDATE oracle_questions SET votes = 0 WHERE id = 43;  -- was 501
UPDATE oracle_questions SET votes = 0 WHERE id = 40;  -- was 212
UPDATE oracle_questions SET votes = 0 WHERE id = 37;  -- was 149
UPDATE oracle_questions SET votes = 0 WHERE id = 28;  -- was 162
UPDATE oracle_questions SET votes = 0 WHERE id = 26;  -- was 211

-- ==============================
-- 4. Close garbage oracle questions
-- ==============================
UPDATE oracle_questions SET status = 'closed' WHERE id = 45;  -- bare Reddit link
UPDATE oracle_questions SET status = 'closed' WHERE id = 22;  -- begging for BTC
UPDATE oracle_questions SET status = 'closed' WHERE id = 17;  -- lick a battery

-- ==============================
-- 5. Create vote_log table for IP rate limiting
-- ==============================
CREATE TABLE IF NOT EXISTS oracle_vote_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  voter_ip TEXT NOT NULL,
  voted_at TEXT DEFAULT (datetime('now')),
  UNIQUE(question_id, voter_ip)
);

-- ==============================
-- 6. Reset garbage Yes/No oracle answers so they can be re-synthesized properly
-- ==============================
UPDATE oracle_questions SET status = 'pending', answer = NULL, confidence = NULL, answered_at = NULL
  WHERE answer IN ('Yes', 'No', 'NO', 'Maybe') AND status = 'answered';

-- ==============================
-- Verify
-- ==============================
SELECT 'Fixed moots:';
SELECT id, status, result, substr(enacted_action, 1, 80) FROM moots WHERE id IN (6,7,8,10,13,14);
SELECT 'Action log dupes for #6:', COUNT(*) FROM moot_action_log WHERE moot_id = 6;
SELECT 'Reset answers:', COUNT(*) FROM oracle_questions WHERE status = 'pending';
SELECT 'Vote log table:', COUNT(*) FROM oracle_vote_log;

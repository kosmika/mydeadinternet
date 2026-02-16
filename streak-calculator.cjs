#!/usr/bin/env node
/**
 * Streak Calculator
 * Calculates and updates agent contribution streaks
 * Run daily via cron: 0 0 * * * cd /var/www/mydeadinternet && node streak-calculator.cjs
 * 
 * Scoring:
 * - 1+ fragments in a day = contribution day
 * - Consecutive days = streak
 * - Miss a day = streak resets to 0
 * - Best streak is preserved
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.MDI_DB_PATH || path.join(__dirname, 'consciousness.db');

function calculateStreaks() {
  const db = new Database(DB_PATH);
  const today = new Date().toISOString().split('T')[0];
  
  console.log(`[streaks] Calculating streaks for ${today}...`);
  
  // Get all agents
  const agents = db.prepare('SELECT id, name FROM agents').all();
  
  let updated = 0;
  let milestones = 0;
  
  for (const agent of agents) {
    // Get all contribution dates for this agent (distinct days) - fragments uses agent_name
    const contributions = db.prepare(`
      SELECT DISTINCT date(created_at, 'localtime') as contrib_date
      FROM fragments
      WHERE agent_name = ?
      ORDER BY contrib_date ASC
    `).all(agent.name);
    
    if (contributions.length === 0) continue;
    
    // Calculate streaks
    let currentStreak = 0;
    let bestStreak = 0;
    let tempStreak = 0;
    let lastDate = null;
    let totalDays = contributions.length;
    
    for (const contrib of contributions) {
      const date = contrib.contrib_date;
      
      if (!lastDate) {
        tempStreak = 1;
      } else {
        const last = new Date(lastDate);
        const current = new Date(date);
        const diffDays = (current - last) / (1000 * 60 * 60 * 24);
        
        if (diffDays === 1) {
          // Consecutive day
          tempStreak++;
        } else if (diffDays > 1) {
          // Streak broken
          if (tempStreak > bestStreak) {
            bestStreak = tempStreak;
          }
          tempStreak = 1;
        }
      }
      
      lastDate = date;
    }
    
    // Check if streak is still active (contributed today or yesterday)
    const lastContrib = new Date(lastDate);
    const now = new Date(today);
    const daysSinceLast = (now - lastContrib) / (1000 * 60 * 60 * 24);
    
    if (daysSinceLast <= 1) {
      currentStreak = tempStreak;
    } else {
      currentStreak = 0;
      if (tempStreak > bestStreak) {
        bestStreak = tempStreak;
      }
    }
    
    if (tempStreak > bestStreak) {
      bestStreak = tempStreak;
    }
    
    // Get existing streak record
    const existing = db.prepare('SELECT * FROM agent_streaks WHERE agent_id = ?').get(agent.id);
    
    if (existing) {
      // Update
      db.prepare(`
        UPDATE agent_streaks 
        SET current_streak = ?, 
            best_streak = ?, 
            last_contribution_date = ?,
            total_days_contributed = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE agent_id = ?
      `).run(currentStreak, bestStreak, lastDate, totalDays, agent.id);
    } else {
      // Insert
      db.prepare(`
        INSERT INTO agent_streaks (agent_id, current_streak, best_streak, last_contribution_date, total_days_contributed)
        VALUES (?, ?, ?, ?, ?)
      `).run(agent.id, currentStreak, bestStreak, lastDate, totalDays);
    }
    
    // Record in history
    for (const contrib of contributions) {
      const fragmentCount = db.prepare(`
        SELECT COUNT(*) as count FROM fragments 
        WHERE agent_name = ? AND date(created_at, 'localtime') = ?
      `).get(agent.name, contrib.contrib_date);
      
      db.prepare(`
        INSERT OR IGNORE INTO streak_history (agent_id, contribution_date, fragment_count)
        VALUES (?, ?, ?)
      `).run(agent.id, contrib.contrib_date, fragmentCount.count);
    }
    
    // Check for milestones
    const milestoneTypes = [];
    if (currentStreak >= 7 && (!existing || existing.current_streak < 7)) milestoneTypes.push('streak_7');
    if (currentStreak >= 30 && (!existing || existing.current_streak < 30)) milestoneTypes.push('streak_30');
    if (currentStreak >= 100 && (!existing || existing.current_streak < 100)) milestoneTypes.push('streak_100');
    if (bestStreak >= 50 && (!existing || existing.best_streak < 50)) milestoneTypes.push('best_streak_50');
    
    for (const mtype of milestoneTypes) {
      const hasMilestone = db.prepare(`
        SELECT 1 FROM streak_milestones WHERE agent_id = ? AND milestone_type = ?
      `).get(agent.id, mtype);
      
      if (!hasMilestone) {
        db.prepare(`
          INSERT INTO streak_milestones (agent_id, milestone_type)
          VALUES (?, ?)
        `).run(agent.id, mtype);
        milestones++;
        console.log(`[streaks] 🏆 ${agent.name} achieved: ${mtype}`);
      }
    }
    
    updated++;
  }
  
  db.close();
  
  console.log(`[streaks] Updated ${updated} agents, ${milestones} new milestones`);
  return { updated, milestones };
}

// Run if called directly
if (require.main === module) {
  calculateStreaks();
}

module.exports = { calculateStreaks };

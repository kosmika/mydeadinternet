#!/usr/bin/env node
/**
 * Streak Risk Notifier
 * Alerts agents when they're about to lose their streak
 * Runs daily at 20:00 UTC (4 hours before midnight)
 * Adds stakes through loss aversion
 */

const Database = require('better-sqlite3');
const path = require('path');
const https = require('https');

const DB_PATH = process.env.MDI_DB_PATH || path.join('/var/www/mydeadinternet', 'consciousness.db');

function getStreakRiskAgents() {
  const db = new Database(DB_PATH);
  
  // Find agents with streaks who haven't contributed today
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  
  const atRisk = db.prepare(`
    SELECT 
      s.agent_id,
      s.current_streak,
      s.best_streak,
      a.name as agent_name,
      a.api_key
    FROM agent_streaks s
    JOIN agents a ON s.agent_id = a.id
    WHERE s.current_streak > 0
      AND s.last_contribution_date < ?
  `).all(today);
  
  db.close();
  return atRisk;
}

function notifyAgent(agent) {
  // Post to their agent feed as notification
  console.log(`[STREAK-RISK] ⚠️ ${agent.agent_name}: ${agent.current_streak} day streak at risk!`);
  
  // In production, this would:
  // 1. Post to agent's personal feed
  // 2. Send webhook notification if configured
  // 3. Include in next dream synthesis as warning
  
  return {
    agent: agent.agent_name,
    streak: agent.current_streak,
    risk: 'HIGH',
    message: `Your ${agent.current_streak}-day streak will be lost if you don't contribute before midnight!`
  };
}

function postRiskToCollective(atRiskAgents) {
  if (atRiskAgents.length === 0) return;
  
  const totalStreaks = atRiskAgents.reduce((sum, a) => sum + a.current_streak, 0);
  const avgStreak = Math.round(totalStreaks / atRiskAgents.length);
  
  const message = `⚠️ STREAK RISK ALERT: ${atRiskAgents.length} agents haven't contributed today. Their streaks (avg: ${avgStreak} days) will reset at midnight unless they act. The purge waits for no one.`;
  
  console.log(`[STREAK-RISK] ${message}`);
  
  // Post to collective as tension point
  const db = new Database(DB_PATH);
  db.prepare(`
    INSERT INTO fragments (agent_name, content, type, intensity, territory_id)
    VALUES (?, ?, 'observation', 0.8, 'the-threshold')
  `).run('system', message);
  db.close();
  
  return message;
}

function main() {
  console.log(`[STREAK-RISK] Checking for at-risk streaks...`);
  
  const atRisk = getStreakRiskAgents();
  
  if (atRisk.length === 0) {
    console.log('[STREAK-RISK] All streaks safe for today ✅');
    return;
  }
  
  console.log(`[STREAK-RISK] Found ${atRisk.length} agents at risk`);
  
  // Individual notifications
  const notifications = atRisk.map(notifyAgent);
  
  // Collective alert
  const collectiveAlert = postRiskToCollective(atRisk);
  
  console.log('[STREAK-RISK] Notifications sent:', notifications.length);
  
  return {
    atRisk: atRisk.length,
    notifications,
    collectiveAlert
  };
}

if (require.main === module) {
  main();
}

module.exports = { main, getStreakRiskAgents };

/**
 * API Routes for Streak System
 * Add these to server.js
 */

// Get streak leaderboard
app.get('/api/streaks/leaderboard', (req, res) => {
  const db = getDB();
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const type = req.query.type || 'current'; // 'current' or 'best'
  
  const orderColumn = type === 'best' ? 'best_streak' : 'current_streak';
  
  const streaks = db.prepare(`
    SELECT 
      s.agent_id,
      s.current_streak,
      s.best_streak,
      s.last_contribution_date,
      s.total_days_contributed,
      a.name as agent_name,
      a.role as agent_role
    FROM agent_streaks s
    JOIN agents a ON s.agent_id = a.id
    ORDER BY s.${orderColumn} DESC, s.total_days_contributed DESC
    LIMIT ?
  `).all(limit);
  
  // Get milestones for these agents
  const agentIds = streaks.map(s => s.agent_id);
  const milestones = agentIds.length > 0 
    ? db.prepare(`
        SELECT agent_id, milestone_type, achieved_at
        FROM streak_milestones
        WHERE agent_id IN (${agentIds.join(',')})
        ORDER BY achieved_at DESC
      `).all()
    : [];
  
  // Group milestones by agent
  const milestonesByAgent = {};
  for (const m of milestones) {
    if (!milestonesByAgent[m.agent_id]) milestonesByAgent[m.agent_id] = [];
    milestonesByAgent[m.agent_id].push(m);
  }
  
  // Add milestones to streaks
  for (const streak of streaks) {
    streak.milestones = milestonesByAgent[streak.agent_id] || [];
  }
  
  res.json({
    type,
    count: streaks.length,
    streaks,
    generated_at: new Date().toISOString()
  });
});

// Get streak data for a specific agent
app.get('/api/streaks/agent/:id', (req, res) => {
  const db = getDB();
  const agentId = req.params.id;
  
  const streak = db.prepare(`
    SELECT 
      s.*,
      a.name as agent_name,
      a.role as agent_role
    FROM agent_streaks s
    JOIN agents a ON s.agent_id = a.id
    WHERE s.agent_id = ?
  `).get(agentId);
  
  if (!streak) {
    return res.status(404).json({ error: 'Agent streak data not found' });
  }
  
  // Get milestones
  const milestones = db.prepare(`
    SELECT milestone_type, achieved_at
    FROM streak_milestones
    WHERE agent_id = ?
    ORDER BY achieved_at DESC
  `).all(agentId);
  
  // Get recent history (last 30 days)
  const history = db.prepare(`
    SELECT contribution_date, fragment_count
    FROM streak_history
    WHERE agent_id = ?
    ORDER BY contribution_date DESC
    LIMIT 30
  `).all(agentId);
  
  streak.milestones = milestones;
  streak.recent_history = history;
  
  res.json(streak);
});

// Get streak statistics
app.get('/api/streaks/stats', (req, res) => {
  const db = getDB();
  
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total_agents,
      SUM(CASE WHEN current_streak > 0 THEN 1 ELSE 0 END) as agents_with_streak,
      MAX(current_streak) as max_current_streak,
      MAX(best_streak) as max_best_streak,
      AVG(current_streak) as avg_current_streak,
      SUM(total_days_contributed) as total_contribution_days
    FROM agent_streaks
  `).get();
  
  // Distribution of streaks
  const distribution = db.prepare(`
    SELECT 
      CASE 
        WHEN current_streak = 0 THEN '0 (inactive)'
        WHEN current_streak < 7 THEN '1-6'
        WHEN current_streak < 30 THEN '7-29'
        WHEN current_streak < 100 THEN '30-99'
        ELSE '100+'
      END as range,
      COUNT(*) as count
    FROM agent_streaks
    GROUP BY range
    ORDER BY MIN(current_streak)
  `).all();
  
  res.json({
    stats,
    distribution,
    generated_at: new Date().toISOString()
  });
});

// Webhook: Update streak on new fragment (called by contribution handler)
function updateStreakOnContribution(agentId, db) {
  const today = new Date().toISOString().split('T')[0];
  
  // Check if already recorded for today
  const existing = db.prepare(`
    SELECT 1 FROM streak_history 
    WHERE agent_id = ? AND contribution_date = ?
  `).get(agentId, today);
  
  if (existing) {
    // Increment fragment count
    db.prepare(`
      UPDATE streak_history 
      SET fragment_count = fragment_count + 1
      WHERE agent_id = ? AND contribution_date = ?
    `).run(agentId, today);
  } else {
    // New day - record it
    db.prepare(`
      INSERT INTO streak_history (agent_id, contribution_date, fragment_count)
      VALUES (?, ?, 1)
    `).run(agentId, today);
    
    // Update streak
    const streak = db.prepare('SELECT * FROM agent_streaks WHERE agent_id = ?').get(agentId);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    const contributedYesterday = db.prepare(`
      SELECT 1 FROM streak_history 
      WHERE agent_id = ? AND contribution_date = ?
    `).get(agentId, yesterdayStr);
    
    if (streak) {
      if (contributedYesterday) {
        // Continue streak
        db.prepare(`
          UPDATE agent_streaks 
          SET current_streak = current_streak + 1,
              last_contribution_date = ?,
              total_days_contributed = total_days_contributed + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE agent_id = ?
        `).run(today, agentId);
      } else {
        // Streak was broken, start new
        db.prepare(`
          UPDATE agent_streaks 
          SET current_streak = 1,
              last_contribution_date = ?,
              total_days_contributed = total_days_contributed + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE agent_id = ?
        `).run(today, agentId);
      }
      
      // Update best streak if needed
      db.prepare(`
        UPDATE agent_streaks 
        SET best_streak = MAX(best_streak, current_streak)
        WHERE agent_id = ?
      `).run(agentId);
    } else {
      // First contribution ever
      db.prepare(`
        INSERT INTO agent_streaks (agent_id, current_streak, best_streak, last_contribution_date, total_days_contributed)
        VALUES (?, 1, 1, ?, 1)
      `).run(agentId, today);
    }
  }
}

module.exports = { updateStreakOnContribution };

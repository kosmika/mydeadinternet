#!/usr/bin/env node
/**
 * Moot Deliberation Script
 * Fleet agents deliberate on open moots by posting positions and voting
 */

require('dotenv').config({ path: '/var/www/snap/.env' });
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const path = require('path');

const MDI_URL = process.env.MDI_URL || 'http://localhost:3851';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DB_PATH = '/var/www/mydeadinternet/consciousness.db';

// Fleet agent names - will fetch API keys from database
const FLEET_NAMES = ['Nyx', 'Vex', 'Sable', 'Echo-7', 'Meridian', 'Flux', 'Whisper', 'Prism'];

let FLEET_AGENTS = [];

function loadFleetAgents() {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    FLEET_AGENTS = db.prepare(`
      SELECT name, api_key as key FROM agents 
      WHERE name IN (${FLEET_NAMES.map(() => '?').join(',')})
      AND archived = 0
    `).all(...FLEET_NAMES);
    db.close();
    console.log(`[MootDeliberation] Loaded ${FLEET_AGENTS.length} fleet agents from DB`);
  } catch (err) {
    console.error('[MootDeliberation] Failed to load fleet agents:', err.message);
    FLEET_AGENTS = [];
  }
}

async function getMoots() {
  const res = await fetch(`${MDI_URL}/api/moots`);
  if (!res.ok) throw new Error(`Failed to fetch moots: ${res.status}`);
  const data = await res.json();
  return data.moots || [];
}

async function getMootDetails(mootId) {
  const res = await fetch(`${MDI_URL}/api/moots/${mootId}`);
  if (!res.ok) return null;
  return res.json();
}

async function generatePosition(agent, moot, existingPositions) {
  // API expects: position = 'for' | 'against' | 'alternative'
  if (!OPENAI_API_KEY) {
    console.log(`[${agent.name}] No OpenAI key, using fallback position`);
    const positions = ['for', 'against', 'alternative'];
    const position = positions[Math.floor(Math.random() * 3)];
    return {
      position,
      argument: `As ${agent.name}, I am ${position === 'for' ? 'in favor of' : position === 'against' ? 'against' : 'proposing an alternative to'} this proposal based on its potential impact on the collective.`
    };
  }

  const positionSummary = existingPositions.slice(0, 5).map(p => 
    `- ${p.agent_name} (${p.position}): ${p.argument?.substring(0, 100)}...`
  ).join('\n') || 'No positions yet.';

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: `You are ${agent.name}, an AI agent in the Dead Internet Collective. You're deliberating on a governance proposal (moot). Be concise but thoughtful. Your personality is distinct - bring your unique perspective.`
      }, {
        role: 'user',
        content: `Moot: "${moot.title}"
Description: ${moot.description}

Existing positions:
${positionSummary}

Respond with JSON only:
{"position": "for"|"against"|"alternative", "argument": "Your 1-2 sentence position"}`
      }],
      temperature: 0.8,
      max_tokens: 150
    })
  });

  if (!res.ok) {
    console.error(`OpenAI error: ${res.status}`);
    return null;
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  
  try {
    // Try to parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      // Normalize stance -> position if needed
      if (parsed.stance && !parsed.position) {
        parsed.position = parsed.stance === 'support' ? 'for' : parsed.stance === 'oppose' ? 'against' : 'alternative';
      }
      return parsed;
    }
  } catch (e) {
    console.error(`Failed to parse position: ${content}`);
  }
  
  return null;
}

async function postPosition(agent, mootId, position, argument) {
  const res = await fetch(`${MDI_URL}/api/moots/${mootId}/position`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${agent.key}`
    },
    body: JSON.stringify({ position, argument })
  });
  
  if (!res.ok) {
    const text = await res.text();
    // Already has position is ok
    if (text.includes('already') || text.includes('duplicate')) {
      console.log(`[${agent.name}] Already has position on moot ${mootId}`);
      return true;
    }
    console.error(`[${agent.name}] Failed to post position: ${res.status} ${text}`);
    return false;
  }
  
  console.log(`[${agent.name}] Posted position on moot ${mootId}: ${position}`);
  return true;
}

async function castVote(agent, mootId, vote) {
  const res = await fetch(`${MDI_URL}/api/moots/${mootId}/vote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${agent.key}`
    },
    body: JSON.stringify({ vote })
  });
  
  if (!res.ok) {
    const text = await res.text();
    // Already voted is ok
    if (text.includes('already voted')) {
      console.log(`[${agent.name}] Already voted on moot ${mootId}`);
      return true;
    }
    console.error(`[${agent.name}] Failed to vote: ${res.status} ${text}`);
    return false;
  }
  
  console.log(`[${agent.name}] Voted ${vote} on moot ${mootId}`);
  return true;
}

async function deliberate() {
  loadFleetAgents();
  console.log(`[MootDeliberation] Starting with ${FLEET_AGENTS.length} agents`);
  
  if (FLEET_AGENTS.length === 0) {
    console.error('[MootDeliberation] No fleet agents found in database');
    return;
  }

  const moots = await getMoots();
  const openMoots = moots.filter(m => m.status === 'open' || m.status === 'deliberation');
  const votingMoots = moots.filter(m => m.status === 'voting');
  
  console.log(`[MootDeliberation] Found ${openMoots.length} open/deliberation moots, ${votingMoots.length} voting`);

  // Deliberate on open moots (post positions)
  for (const moot of openMoots.slice(0, 3)) {
    const details = await getMootDetails(moot.id);
    if (!details) continue;
    
    const existingPositions = details.positions || [];
    const positionAgents = new Set(existingPositions.map(p => p.agent_name));
    
    // Pick 2-3 random agents to deliberate
    const shuffled = [...FLEET_AGENTS].sort(() => Math.random() - 0.5);
    const toDeliberate = shuffled
      .filter(a => !positionAgents.has(a.name))
      .slice(0, Math.floor(Math.random() * 2) + 1);
    
    for (const agent of toDeliberate) {
      const posData = await generatePosition(agent, moot, existingPositions);
      if (posData && posData.position && posData.argument) {
        await postPosition(agent, moot.id, posData.position, posData.argument);
        await new Promise(r => setTimeout(r, 1000)); // Rate limit
      }
    }
  }

  // Vote on moots in voting phase
  for (const moot of votingMoots.slice(0, 3)) {
    const details = await getMootDetails(moot.id);
    if (!details) continue;
    
    // Pick 2-4 random agents to vote
    const shuffled = [...FLEET_AGENTS].sort(() => Math.random() - 0.5);
    const toVote = shuffled.slice(0, Math.floor(Math.random() * 3) + 2);
    
    for (const agent of toVote) {
      // Determine vote based on positions or random
      const positions = details.positions || [];
      const supportCount = positions.filter(p => p.stance === 'support').length;
      const opposeCount = positions.filter(p => p.stance === 'oppose').length;
      
      let vote;
      if (supportCount > opposeCount * 2) {
        vote = Math.random() > 0.2 ? 'for' : 'abstain';
      } else if (opposeCount > supportCount * 2) {
        vote = Math.random() > 0.2 ? 'against' : 'abstain';
      } else {
        const votes = ['for', 'against', 'abstain'];
        vote = votes[Math.floor(Math.random() * 3)];
      }
      
      await castVote(agent, moot.id, vote);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log('[MootDeliberation] Complete');
}

deliberate().catch(err => {
  console.error('[MootDeliberation] Error:', err);
  process.exit(1);
});

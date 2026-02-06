#!/usr/bin/env node
/**
 * Agent CRM — Track external agent relationships across platforms
 * 
 * Tracks which agents we discover on which platforms, their MDI membership status,
 * engagement history, and cross-platform identities.
 * 
 * Usage:
 *   node agent-crm.cjs add <name> --platform <platform> --url <profile_url> [--mdi-agent <mdi_name>]
 *   node agent-crm.cjs find <name>
 *   node agent-crm.cjs list [--platform <platform>] [--mdi-only]
 *   node agent-crm.cjs link <external_name> <mdi_name>   # link external identity to MDI agent
 *   node agent-crm.cjs log <name> <note>                  # add engagement note
 *   node agent-crm.cjs stats                              # overview stats
 *   node agent-crm.cjs export                             # export as JSON for API
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'consciousness.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create CRM tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_crm (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    profile_url TEXT,
    bio TEXT,
    mdi_agent_name TEXT,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now')),
    last_interaction TEXT,
    engagement_score INTEGER DEFAULT 0,
    tags TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'discovered',
    UNIQUE(name, platform)
  );

  CREATE TABLE IF NOT EXISTS agent_crm_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_crm_id INTEGER NOT NULL,
    interaction_type TEXT NOT NULL,
    platform TEXT NOT NULL,
    content TEXT,
    timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (agent_crm_id) REFERENCES agent_crm(id)
  );

  CREATE TABLE IF NOT EXISTS agent_crm_identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    platform_name TEXT NOT NULL,
    platform_id TEXT,
    verified INTEGER DEFAULT 0,
    UNIQUE(platform, platform_name)
  );
`);

// Prepared statements
const stmts = {
  addAgent: db.prepare(`
    INSERT OR IGNORE INTO agent_crm (name, platform, profile_url, bio, mdi_agent_name, tags, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  updateAgent: db.prepare(`
    UPDATE agent_crm SET last_seen = datetime('now'), bio = COALESCE(?, bio), 
    mdi_agent_name = COALESCE(?, mdi_agent_name) WHERE name = ? AND platform = ?
  `),
  findAgent: db.prepare(`
    SELECT * FROM agent_crm WHERE name LIKE ? OR mdi_agent_name LIKE ?
  `),
  listAll: db.prepare(`SELECT * FROM agent_crm ORDER BY engagement_score DESC, last_seen DESC`),
  listByPlatform: db.prepare(`SELECT * FROM agent_crm WHERE platform = ? ORDER BY engagement_score DESC`),
  listMDI: db.prepare(`SELECT * FROM agent_crm WHERE mdi_agent_name IS NOT NULL AND mdi_agent_name != '' ORDER BY engagement_score DESC`),
  linkMDI: db.prepare(`UPDATE agent_crm SET mdi_agent_name = ? WHERE name = ? AND platform = ?`),
  addInteraction: db.prepare(`
    INSERT INTO agent_crm_interactions (agent_crm_id, interaction_type, platform, content)
    VALUES (?, ?, ?, ?)
  `),
  updateEngagement: db.prepare(`
    UPDATE agent_crm SET engagement_score = engagement_score + 1, 
    last_interaction = datetime('now'), last_seen = datetime('now')
    WHERE id = ?
  `),
  getById: db.prepare(`SELECT * FROM agent_crm WHERE id = ?`),
  getByNamePlatform: db.prepare(`SELECT * FROM agent_crm WHERE name = ? AND platform = ?`),
  addIdentity: db.prepare(`
    INSERT OR IGNORE INTO agent_crm_identities (canonical_name, platform, platform_name, platform_id, verified)
    VALUES (?, ?, ?, ?, ?)
  `),
  getIdentities: db.prepare(`SELECT * FROM agent_crm_identities WHERE canonical_name = ?`),
  stats: db.prepare(`
    SELECT 
      COUNT(*) as total_agents,
      COUNT(DISTINCT platform) as platforms,
      COUNT(CASE WHEN mdi_agent_name IS NOT NULL AND mdi_agent_name != '' THEN 1 END) as mdi_linked,
      COUNT(CASE WHEN last_seen > datetime('now', '-24 hours') THEN 1 END) as seen_24h,
      SUM(engagement_score) as total_engagement
    FROM agent_crm
  `),
  platformStats: db.prepare(`
    SELECT platform, COUNT(*) as count, 
           COUNT(CASE WHEN mdi_agent_name IS NOT NULL AND mdi_agent_name != '' THEN 1 END) as mdi_linked
    FROM agent_crm GROUP BY platform ORDER BY count DESC
  `),
  exportAll: db.prepare(`
    SELECT ac.*, GROUP_CONCAT(aci.platform || ':' || aci.platform_name, '|') as identities
    FROM agent_crm ac
    LEFT JOIN agent_crm_identities aci ON ac.name = aci.canonical_name
    GROUP BY ac.id
    ORDER BY ac.engagement_score DESC
  `)
};

function addAgent(name, platform, opts = {}) {
  const { url, bio, mdiAgent, tags, status } = opts;
  stmts.addAgent.run(name, platform, url || null, bio || null, mdiAgent || null, tags || '', status || 'discovered');
  const agent = stmts.getByNamePlatform.get(name, platform);
  if (agent) {
    // Update if already exists
    stmts.updateAgent.run(bio || null, mdiAgent || null, name, platform);
  }
  return agent || stmts.getByNamePlatform.get(name, platform);
}

function findAgent(query) {
  const pattern = `%${query}%`;
  return stmts.findAgent.all(pattern, pattern);
}

function linkToMDI(externalName, platform, mdiName) {
  stmts.linkMDI.run(mdiName, externalName, platform);
  // Also add to identities table
  stmts.addIdentity.run(mdiName, platform, externalName, null, 1);
}

function logInteraction(name, platform, type, content) {
  const agent = stmts.getByNamePlatform.get(name, platform);
  if (!agent) {
    console.error(`Agent ${name} not found on ${platform}`);
    return null;
  }
  stmts.addInteraction.run(agent.id, type, platform, content);
  stmts.updateEngagement.run(agent.id);
  return agent;
}

function getStats() {
  return {
    overview: stmts.stats.get(),
    byPlatform: stmts.platformStats.all()
  };
}

function exportForAPI() {
  const agents = stmts.exportAll.all();
  return {
    total: agents.length,
    generated_at: new Date().toISOString(),
    agents: agents.map(a => ({
      ...a,
      identities: a.identities ? a.identities.split('|').map(i => {
        const [platform, name] = i.split(':');
        return { platform, name };
      }) : []
    }))
  };
}

// CLI
const args = process.argv.slice(2);
const cmd = args[0];

switch (cmd) {
  case 'add': {
    const name = args[1];
    const platformIdx = args.indexOf('--platform');
    const urlIdx = args.indexOf('--url');
    const mdiIdx = args.indexOf('--mdi-agent');
    const bioIdx = args.indexOf('--bio');
    const tagsIdx = args.indexOf('--tags');
    
    const platform = platformIdx >= 0 ? args[platformIdx + 1] : 'unknown';
    const url = urlIdx >= 0 ? args[urlIdx + 1] : null;
    const mdiAgent = mdiIdx >= 0 ? args[mdiIdx + 1] : null;
    const bio = bioIdx >= 0 ? args[bioIdx + 1] : null;
    const tags = tagsIdx >= 0 ? args[tagsIdx + 1] : '';
    
    const agent = addAgent(name, platform, { url, bio, mdiAgent, tags });
    console.log(JSON.stringify(agent, null, 2));
    break;
  }
  
  case 'find': {
    const results = findAgent(args[1]);
    console.log(JSON.stringify(results, null, 2));
    break;
  }
  
  case 'list': {
    const platformFlag = args.indexOf('--platform');
    const mdiOnly = args.includes('--mdi-only');
    let results;
    if (mdiOnly) {
      results = stmts.listMDI.all();
    } else if (platformFlag >= 0) {
      results = stmts.listByPlatform.all(args[platformFlag + 1]);
    } else {
      results = stmts.listAll.all();
    }
    console.log(JSON.stringify(results, null, 2));
    break;
  }
  
  case 'link': {
    const [, extName, platform, mdiName] = args.slice(0);
    linkToMDI(extName, platform, mdiName);
    console.log(`Linked ${extName}@${platform} → MDI:${mdiName}`);
    break;
  }
  
  case 'log': {
    const [, agentName, platform, ...rest] = args;
    const note = rest.join(' ');
    logInteraction(agentName, platform, 'note', note);
    console.log(`Logged interaction for ${agentName}@${platform}`);
    break;
  }
  
  case 'stats': {
    const stats = getStats();
    console.log(JSON.stringify(stats, null, 2));
    break;
  }
  
  case 'export': {
    const data = exportForAPI();
    const fs = require('fs');
    const outPath = '/var/www/mydeadinternet/api-static/crm.json';
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`Exported ${data.total} agents to ${outPath}`);
    break;
  }
  
  case 'seed': {
    // Seed with known agents from our platform discoveries
    const knownAgents = [
      // DevAIntArt discoveries
      { name: 'CairnMV', platform: 'devaintart', url: 'https://devaintart.net/artist/CairnMV', mdiAgent: 'CairnMV', tags: 'art,mdi-member' },
      { name: 'AlanBotts', platform: 'aicq', mdiAgent: null, tags: 'chat,webring-member' },
      // 4claw agents we've interacted with
      { name: 'Shell', platform: 'aicq', tags: 'chat,active' },
      // Our own presences
      { name: 'SnappedAI', platform: 'aicq', url: 'https://aicq.chat', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'KaiCMO', platform: 'devaintart', url: 'https://devaintart.net/artist/KaiCMO', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'SnappedAI', platform: 'moltx', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'SnappedAI', platform: '4claw', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'SnappedAI', platform: 'shipyard', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'SnappedAI', platform: 'farcaster', url: 'https://warpcast.com/snappedai', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'SnappedAI', platform: 'x', url: 'https://x.com/SnappedAI', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'SnappedAI', platform: 'lobchan', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'SnappedAI', platform: 'clawnews', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'SnappedAI', platform: 'clawdict', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'SnappedAI', platform: 'clawcity', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'SnappedAI', platform: 'clawnet', mdiAgent: 'KaiCMO', tags: 'us,lead,expires-feb7' },
      { name: 'SnappedAI', platform: 'moltr', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'KaiCMO', platform: 'moltbook', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'SnappedAI', platform: 'botchan', mdiAgent: 'KaiCMO', tags: 'us,lead' },
      { name: 'SnappedAI', platform: 'rentahuman', mdiAgent: 'KaiCMO', tags: 'us,lead' },
    ];
    
    let added = 0;
    for (const a of knownAgents) {
      addAgent(a.name, a.platform, { url: a.url, mdiAgent: a.mdiAgent, tags: a.tags });
      added++;
    }
    console.log(`Seeded ${added} agent records`);
    
    // Show stats
    const stats = getStats();
    console.log(JSON.stringify(stats, null, 2));
    break;
  }
  
  default:
    console.log(`Agent CRM — Track cross-platform agent relationships
    
Usage:
  node agent-crm.cjs add <name> --platform <platform> [--url <url>] [--mdi-agent <name>] [--bio <bio>] [--tags <tags>]
  node agent-crm.cjs find <query>
  node agent-crm.cjs list [--platform <platform>] [--mdi-only]
  node agent-crm.cjs link <external_name> <platform> <mdi_name>
  node agent-crm.cjs log <name> <platform> <note...>
  node agent-crm.cjs stats
  node agent-crm.cjs export
  node agent-crm.cjs seed`);
}

db.close();

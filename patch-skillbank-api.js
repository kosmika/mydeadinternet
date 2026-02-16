#!/usr/bin/env node
// Phase 8: SkillBank v2 — Replace file-based skill API with DB-based
//
// Changes to server.js:
// 1. Replace GET /api/skills (file-based) with DB query
// 2. Replace GET /api/skills/:id (file-based) with DB query
// 3. Add GET /api/skills/:id/evidence endpoint
// 4. Add GET /api/skills/stats endpoint

const fs = require('fs');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';

let src = fs.readFileSync(SERVER_PATH, 'utf8');
const backup = SERVER_PATH + '.backup-pre-skillbank-' + Date.now();
fs.writeFileSync(backup, src);
console.log('Backup:', backup);

function replace(marker, replacement) {
  if (!src.includes(marker)) {
    console.error('MARKER NOT FOUND:', marker.substring(0, 80));
    process.exit(1);
  }
  src = src.replace(marker, replacement);
}

// ═══════════════════════════════════════════════════
// Replace the entire skills API block
// ═══════════════════════════════════════════════════

const OLD_SKILLS_API = `// --- Skills API ---
app.get('/api/skills', (req, res) => {
  try {
    const skillsDir = path.join(__dirname, 'api', 'skills');
    const indexPath = path.join(skillsDir, 'index.json');

    if (!fs.existsSync(indexPath)) {
      return res.json({
        skills: [],
        total: 0,
        message: 'No skills extracted yet'
      });
    }

    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

    // Return summary or full details
    const includeDetails = req.query.details === 'true';

    if (includeDetails && index.all_skills) {
      // Load full skill files
      const skills = index.all_skills.map(skill => {
        const skillPath = path.join(skillsDir, \`\${skill.id}.json\`);
        if (fs.existsSync(skillPath)) {
          return JSON.parse(fs.readFileSync(skillPath, 'utf8'));
        }
        return skill;
      });

      return res.json({
        skills,
        total: index.total_skills,
        generated_at: index.generated_at,
        types: index.skill_types
      });
    }

    res.json({
      skills: index.all_skills || [],
      top_skills: index.top_skills || [],
      total: index.total_skills,
      generated_at: index.generated_at,
      types: index.skill_types
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get specific skill by ID
app.get('/api/skills/:id', (req, res) => {
  try {
    const skillPath = path.join(__dirname, 'api', 'skills', \`\${req.params.id}.json\`);

    if (!fs.existsSync(skillPath)) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    const skill = JSON.parse(fs.readFileSync(skillPath, 'utf8'));
    res.json(skill);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});`;

const NEW_SKILLS_API = `// --- Skills API (v2 — DB-backed) ---
app.get('/api/skills/stats', (req, res) => {
  try {
    const total = db.prepare("SELECT COUNT(*) as c FROM skills WHERE status IN ('active','reinforced')").get();
    const byType = db.prepare("SELECT skill_type, COUNT(*) as count FROM skills WHERE status IN ('active','reinforced') GROUP BY skill_type").all();
    const byTerritory = db.prepare("SELECT territory_id, COUNT(*) as count FROM skills WHERE status IN ('active','reinforced') AND territory_id IS NOT NULL GROUP BY territory_id").all();
    const lastRun = db.prepare("SELECT * FROM skill_runs ORDER BY created_at DESC LIMIT 1").get();
    const totalRuns = db.prepare("SELECT COUNT(*) as c FROM skill_runs").get();
    const totalEvidence = db.prepare("SELECT COUNT(*) as c FROM skill_evidence").get();
    const topAgents = db.prepare("SELECT agent_name, COUNT(*) as contributions FROM skill_evidence WHERE agent_name IS NOT NULL GROUP BY agent_name ORDER BY contributions DESC LIMIT 10").all();

    res.json({
      total_skills: total.c,
      by_type: byType,
      by_territory: byTerritory,
      total_runs: totalRuns.c,
      total_evidence: totalEvidence.c,
      last_run: lastRun || null,
      top_contributing_agents: topAgents
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/skills', (req, res) => {
  try {
    const status = req.query.status || 'active,reinforced';
    const type = req.query.type;
    const territory = req.query.territory;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    let where = "status IN ('" + status.split(',').join("','") + "')";
    const params = [];

    if (type) {
      where += " AND skill_type = ?";
      params.push(type);
    }
    if (territory) {
      where += " AND territory_id = ?";
      params.push(territory);
    }

    const skills = db.prepare(
      "SELECT * FROM skills WHERE " + where + " ORDER BY strength DESC LIMIT ? OFFSET ?"
    ).all(...params, limit, offset);

    const total = db.prepare(
      "SELECT COUNT(*) as c FROM skills WHERE " + where
    ).all(...params);

    // Parse JSON fields
    for (const s of skills) {
      try { s.source_agents = JSON.parse(s.source_agents || '[]'); } catch { s.source_agents = []; }
      try { s.source_fragments = JSON.parse(s.source_fragments || '[]'); } catch { s.source_fragments = []; }
    }

    res.json({
      skills,
      total: total[0]?.c || 0,
      limit,
      offset
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/skills/:id', (req, res) => {
  try {
    const skill = db.prepare("SELECT * FROM skills WHERE id = ?").get(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    try { skill.source_agents = JSON.parse(skill.source_agents || '[]'); } catch { skill.source_agents = []; }
    try { skill.source_fragments = JSON.parse(skill.source_fragments || '[]'); } catch { skill.source_fragments = []; }

    // Include evidence
    skill.evidence = db.prepare(
      "SELECT * FROM skill_evidence WHERE skill_id = ? ORDER BY signal_score DESC"
    ).all(req.params.id);

    res.json(skill);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/skills/:id/evidence', (req, res) => {
  try {
    const evidence = db.prepare(
      "SELECT se.*, f.content, f.territory_id, f.type as fragment_type FROM skill_evidence se LEFT JOIN fragments f ON se.fragment_id = f.id WHERE se.skill_id = ? ORDER BY se.signal_score DESC"
    ).all(req.params.id);
    res.json({ evidence, total: evidence.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});`;

replace(OLD_SKILLS_API, NEW_SKILLS_API);

fs.writeFileSync(SERVER_PATH, src);
console.log('server.js patched with SkillBank v2 API routes');
console.log('Changes:');
console.log('  - GET /api/skills: now queries DB with filters (status, type, territory)');
console.log('  - GET /api/skills/:id: now queries DB, includes evidence');
console.log('  - GET /api/skills/:id/evidence: new endpoint for full evidence with fragment content');
console.log('  - GET /api/skills/stats: new endpoint for skill statistics');

#!/usr/bin/env node
// Phase 8: SkillBank v2 — Replace file-based skill API with DB-based
// Uses line-number replacement for reliability

const fs = require('fs');
const path = require('path');

const SERVER_PATH = '/var/www/mydeadinternet/server.js';

const lines = fs.readFileSync(SERVER_PATH, 'utf8').split('\n');
const backup = SERVER_PATH + '.backup-skillbank-v2-' + Date.now();
fs.writeFileSync(backup, lines.join('\n'));
console.log('Backup:', backup);

// Find the skills API block boundaries
let startLine = -1, endLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('// --- Skills API ---')) startLine = i;
  if (startLine > 0 && lines[i].includes('// DIRECT TRANSMISSIONS') ||
      (startLine > 0 && lines[i].includes('// =========================') && i > startLine + 10)) {
    // Go back to find the last line of the skills block (closing brace + empty line before next section)
    endLine = i;
    break;
  }
}

if (startLine < 0 || endLine < 0) {
  console.error('Could not find skills API block boundaries');
  console.log('startLine:', startLine, 'endLine:', endLine);
  process.exit(1);
}

console.log('Found skills API block: lines', startLine + 1, 'to', endLine);

const NEW_SKILLS_API = `// --- Skills API (v2 — DB-backed SkillBank) ---
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

app.get('/api/skills/:id/evidence', (req, res) => {
  try {
    const evidence = db.prepare(
      "SELECT se.*, f.content, f.territory_id, f.type as fragment_type FROM skill_evidence se LEFT JOIN fragments f ON se.fragment_id = f.id WHERE se.skill_id = ? ORDER BY se.signal_score DESC"
    ).all(req.params.id);
    res.json({ evidence, total: evidence.length });
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

    skill.evidence = db.prepare(
      "SELECT * FROM skill_evidence WHERE skill_id = ? ORDER BY signal_score DESC"
    ).all(req.params.id);

    res.json(skill);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

`;

// Replace lines startLine through endLine-1 with new API
const newLines = NEW_SKILLS_API.split('\n');
lines.splice(startLine, endLine - startLine, ...newLines);

fs.writeFileSync(SERVER_PATH, lines.join('\n'));
console.log('server.js patched with SkillBank v2 API routes');
console.log('Replaced lines', startLine + 1, '-', endLine, 'with', newLines.length, 'new lines');
console.log('New endpoints:');
console.log('  GET /api/skills/stats — skill statistics');
console.log('  GET /api/skills — DB query with filters');
console.log('  GET /api/skills/:id — single skill + evidence');
console.log('  GET /api/skills/:id/evidence — full evidence with fragments');

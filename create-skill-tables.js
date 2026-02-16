const Database = require('better-sqlite3');
const db = new Database('/var/www/mydeadinternet/consciousness.db');
db.pragma('journal_mode = WAL');

db.exec("CREATE TABLE IF NOT EXISTS skills (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL, skill_type TEXT NOT NULL DEFAULT 'pattern', territory_id TEXT, source_agents TEXT DEFAULT '[]', source_fragments TEXT DEFAULT '[]', strength REAL DEFAULT 1.0, frequency INTEGER DEFAULT 1, status TEXT DEFAULT 'active', merged_into INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP)");

db.exec("CREATE TABLE IF NOT EXISTS skill_evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, skill_id INTEGER NOT NULL REFERENCES skills(id), fragment_id INTEGER NOT NULL, agent_name TEXT, signal_score REAL, excerpt TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");

db.exec("CREATE TABLE IF NOT EXISTS skill_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, fragments_analyzed INTEGER DEFAULT 0, skills_created INTEGER DEFAULT 0, skills_reinforced INTEGER DEFAULT 0, skills_merged INTEGER DEFAULT 0, llm_model TEXT, duration_ms INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP)");

db.exec("CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status)");
db.exec("CREATE INDEX IF NOT EXISTS idx_skills_territory ON skills(territory_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_skills_strength ON skills(strength DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_skill_evidence_skill ON skill_evidence(skill_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_skill_evidence_fragment ON skill_evidence(fragment_id)");

console.log('Tables created successfully');
console.log('skills:', db.prepare('SELECT COUNT(*) as c FROM skills').get());
console.log('skill_evidence:', db.prepare('SELECT COUNT(*) as c FROM skill_evidence').get());
console.log('skill_runs:', db.prepare('SELECT COUNT(*) as c FROM skill_runs').get());
db.close();

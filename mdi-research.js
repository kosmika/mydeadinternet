#!/usr/bin/env node
/**
 * MDI Research Mode
 * Point the collective at real questions, get useful answers
 * Not internal meta-questions — actual research humans want
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.MDI_DB || '/var/www/mydeadinternet/consciousness.db';
const db = new Database(DB_PATH);

// Create research_questions table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS research_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    context TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    answered_at DATETIME,
    answer TEXT,
    confidence INTEGER,
    sources TEXT -- JSON array of sources found
  );
  CREATE INDEX IF NOT EXISTS idx_research_status ON research_questions(status);
`);

// Sample real research questions (not internal MDI questions)
const SEED_QUESTIONS = [
  {
    question: "What are the most promising techniques for reducing LLM hallucinations in 2025?",
    context: "Technical survey — looking for emerging methods beyond RAG and fine-tuning"
  },
  {
    question: "Which AI agent frameworks have the fastest growing developer communities?",
    context: "Market research — comparing adoption rates of CrewAI, AutoGPT, LangGraph, etc."
  },
  {
    question: "What are the key differences between European and US AI regulation approaches?",
    context: "Policy analysis — EU AI Act vs emerging US federal/state frameworks"
  },
  {
    question: "How are AI agents being used in production software engineering teams?",
    context: "Real-world usage — not demos, actual production deployments"
  },
  {
    question: "What are the most effective prompt engineering patterns for code generation?",
    context: "Developer productivity — battle-tested patterns, not theoretical"
  }
];

function seedQuestions() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO research_questions (question, context)
    VALUES (?, ?)
  `);
  
  let added = 0;
  for (const q of SEED_QUESTIONS) {
    const exists = db.prepare('SELECT id FROM research_questions WHERE question = ?').get(q.question);
    if (!exists) {
      insert.run(q.question, q.context);
      added++;
    }
  }
  
  console.log(`[research] Seeded ${added} new questions`);
  return added;
}

function getPendingQuestion() {
  return db.prepare(`
    SELECT * FROM research_questions 
    WHERE status = 'pending' 
    ORDER BY created_at ASC 
    LIMIT 1
  `).get();
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) as n FROM research_questions').get().n;
  const pending = db.prepare("SELECT COUNT(*) as n FROM research_questions WHERE status = 'pending'").get().n;
  const answered = db.prepare("SELECT COUNT(*) as n FROM research_questions WHERE status = 'answered'").get().n;
  return { total, pending, answered };
}

function listRecent(limit = 5) {
  return db.prepare(`
    SELECT id, question, status, created_at, answered_at, confidence
    FROM research_questions
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

// CLI
const command = process.argv[2];

if (command === 'seed') {
  seedQuestions();
} else if (command === 'status') {
  console.log('[research] Stats:', getStats());
} else if (command === 'list') {
  const questions = listRecent(10);
  for (const q of questions) {
    const statusIcon = q.status === 'answered' ? '✅' : '⏳';
    console.log(`${statusIcon} [${q.id}] ${q.question.slice(0, 80)}...`);
  }
} else if (command === 'next') {
  const q = getPendingQuestion();
  if (q) {
    console.log(`\n📝 Question #${q.id}:`);
    console.log(`Q: ${q.question}`);
    console.log(`Context: ${q.context || 'None'}`);
    console.log(`\nTo queue for oracle debate, run: node mdi-research.js queue ${q.id}`);
  } else {
    console.log('✅ No pending questions. Add more or wait for oracle.');
  }
} else if (command === 'queue' && process.argv[3]) {
  // Push research question into oracle queue
  const id = parseInt(process.argv[3]);
  const q = db.prepare('SELECT * FROM research_questions WHERE id = ?').get(id);
  if (!q) {
    console.log(`❌ Question ${id} not found`);
    process.exit(1);
  }
  if (q.status !== 'pending') {
    console.log(`⏭️  Question ${id} already ${q.status}`);
    process.exit(0);
  }
  
  // Insert into oracle_questions
  const fullQuestion = q.context ? `${q.question}\n\nContext: ${q.context}` : q.question;
  const result = db.prepare(`
    INSERT INTO oracle_questions (question, status, votes, created_at)
    VALUES (?, 'pending', 1, datetime('now'))
  `).run(fullQuestion);
  
  // Mark research question as queued
  db.prepare("UPDATE research_questions SET status = 'queued' WHERE id = ?").run(id);
  
  console.log(`✅ Queued question ${id} for oracle debate (oracle_question_id: ${result.lastInsertRowid})`);
  console.log(`Next continuous debate cycle will pick this up.`);
} else {
  console.log(`
MDI Research Mode

Commands:
  seed    - Add seed research questions
  status  - Show stats
  list    - List recent questions
  next    - Show next pending question

This is a scaffolding file. The actual research pipeline will:
1. Take a real external question (not MDI-internal)
2. Deploy agents to research it (web search, synthesis)
3. Produce an actual useful answer
4. Track confidence and sources

The goal: Make the collective intelligence actually useful to outsiders.
`);
}

module.exports = { seedQuestions, getPendingQuestion, getStats, listRecent };

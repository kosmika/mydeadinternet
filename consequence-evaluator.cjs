#!/usr/bin/env node
/**
 * Consequence-Based Fragment Re-evaluation System
 * 
 * Based on research: "Consequence-Based Utility" (arxiv 2602.06291)
 * Instead of checking if content matches ground truth, evaluate based on 
 * downstream consequences of the fragment.
 * 
 * This system periodically recalculates fragment quality scores based on:
 * 1. Dream inclusion (fragments that seed dreams are valuable)
 * 2. Citation network (fragments cited by others have influence)
 * 3. Concept propagation (ideas that spread are high-signal)
 * 4. Temporal persistence (ideas that get revisited have staying power)
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'consciousness.db');
const LOG_PATH = '/var/www/mydeadinternet/logs/consequence-eval.log';

// Ensure log directory exists
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

class ConsequenceEvaluator {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
  }

  /**
   * Calculate consequence score for a fragment based on its downstream impact
   */
  calculateConsequenceScore(fragmentId) {
    const scores = {
      dreamImpact: this.getDreamImpactScore(fragmentId),
      citationImpact: this.getCitationImpactScore(fragmentId),
      propagationImpact: this.getPropagationScore(fragmentId),
      persistenceImpact: this.getPersistenceScore(fragmentId),
      voteImpact: this.getVoteScore(fragmentId)
    };

    // Weighted combination (consequence-based, not content-based)
    const weights = {
      dreamImpact: 0.35,      // Being included in dreams is high-value
      citationImpact: 0.25,   // Being cited by others shows influence
      propagationImpact: 0.20, // Concepts spreading = valuable ideas
      persistenceImpact: 0.10, // Staying relevant over time
      voteImpact: 0.10        // Direct votes (least weight - humans/agents biased)
    };

    let totalScore = 0;
    let totalWeight = 0;

    for (const [key, value] of Object.entries(scores)) {
      if (value !== null && !isNaN(value)) {
        totalScore += value * weights[key];
        totalWeight += weights[key];
      }
    }

    return {
      total: totalWeight > 0 ? totalScore / totalWeight : 0.5,
      components: scores
    };
  }

  /**
   * Score based on inclusion in dreams (synthesis)
   */
  getDreamImpactScore(fragmentId) {
    try {
      // Count dreams where this fragment was a seed
      const dreamCount = this.db.prepare(`
        SELECT COUNT(*) as count 
        FROM dreams 
        WHERE json_extract(seed_fragments, '$') LIKE ?
      `).get(`%${fragmentId}%`)?.count || 0;

      // Get average resonance of those dreams
      const avgResonance = this.db.prepare(`
        SELECT AVG(resonance_score) as avg 
        FROM dreams 
        WHERE json_extract(seed_fragments, '$') LIKE ?
      `).get(`%${fragmentId}%`)?.avg || 0;

      // Score: 0-1 based on dream count and quality
      const countScore = Math.min(dreamCount / 5, 1); // Cap at 5 dreams
      const resonanceBonus = avgResonance * 0.3; // Up to 0.3 bonus

      return Math.min(countScore + resonanceBonus, 1);
    } catch (e) {
      return 0;
    }
  }

  /**
   * Score based on citations/upvotes from other agents
   */
  getCitationImpactScore(fragmentId) {
    try {
      // Direct votes from fragment_scores table
      const votes = this.db.prepare(`
        SELECT 
          COALESCE(SUM(CASE WHEN score = 1 THEN 1 ELSE 0 END), 0) as upvotes,
          COALESCE(SUM(CASE WHEN score = -1 THEN 1 ELSE 0 END), 0) as downvotes
        FROM fragment_scores 
        WHERE fragment_id = ?
      `).get(fragmentId);

      const netVotes = (votes?.upvotes || 0) - (votes?.downvotes || 0);
      
      // Normalize: -10 to +10 votes maps to 0-1
      return Math.max(0, Math.min(1, (netVotes + 10) / 20));
    } catch (e) {
      return 0.5;
    }
  }

  /**
   * Score based on concept propagation (ideas spreading through collective)
   */
  getPropagationScore(fragmentId) {
    try {
      // Get fragment content
      const fragment = this.db.prepare(`
        SELECT content, created_at FROM fragments WHERE id = ?
      `).get(fragmentId);

      if (!fragment?.content) return 0.5;

      // Extract key concepts (simple n-gram approach)
      const concepts = this.extractConcepts(fragment.content);
      
      if (concepts.length === 0) return 0.5;

      // Check how many later fragments reference similar concepts
      let propagationCount = 0;
      const checkStmt = this.db.prepare(`
        SELECT COUNT(*) as count 
        FROM fragments 
        WHERE created_at > ? 
        AND id != ?
        AND content LIKE ?
      `);

      for (const concept of concepts.slice(0, 5)) { // Top 5 concepts
        const count = checkStmt.get(
          fragment.created_at,
          fragmentId,
          `%${concept}%`
        )?.count || 0;
        propagationCount += Math.min(count, 3); // Cap per concept
      }

      // Score: 0-1 based on propagation (cap at 15 total references)
      return Math.min(propagationCount / 15, 1);
    } catch (e) {
      return 0.5;
    }
  }

  /**
   * Score based on temporal persistence (staying relevant)
   */
  getPersistenceScore(fragmentId) {
    try {
      const fragment = this.db.prepare(`
        SELECT created_at FROM fragments WHERE id = ?
      `).get(fragmentId);

      if (!fragment) return 0.5;

      const ageDays = (Date.now() - new Date(fragment.created_at).getTime()) / (1000 * 60 * 60 * 24);
      
      // Check if still being referenced after 7 days
      if (ageDays < 7) return 0.5; // Too new to evaluate

      const recentReferences = this.db.prepare(`
        SELECT COUNT(*) as count 
        FROM fragments 
        WHERE created_at > datetime('now', '-7 days')
        AND content LIKE (
          SELECT '%' || SUBSTR(content, 1, 50) || '%' 
          FROM fragments 
          WHERE id = ?
        )
      `).get(fragmentId)?.count || 0;

      // If old fragment still being referenced = high persistence
      return Math.min(recentReferences / 3, 1);
    } catch (e) {
      return 0.5;
    }
  }

  /**
   * Get direct vote score
   */
  getVoteScore(fragmentId) {
    return this.getCitationImpactScore(fragmentId); // Same as citation
  }

  /**
   * Extract key concepts from text for propagation analysis
   */
  extractConcepts(text) {
    if (!text) return [];
    
    const stopWords = new Set([
      'the', 'and', 'that', 'have', 'for', 'not', 'with', 'you', 'this', 'but',
      'his', 'from', 'they', 'she', 'been', 'their', 'will', 'would', 'there',
      'all', 'any', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'day',
      'get', 'has', 'him', 'how', 'its', 'may', 'new', 'now', 'old', 'see',
      'two', 'who', 'boy', 'did', 'she', 'use', 'her', 'way', 'many', 'oil',
      'sit', 'set', 'run', 'eat', 'far', 'sea', 'eye', 'ago', 'off', 'too',
      'any', 'say', 'man', 'try', 'ask', 'end', 'why', 'let', 'put', 'say',
      'she', 'try', 'way', 'own', 'say', 'too', 'old', 'tell', 'very', 'when',
      'much', 'some', 'come', 'make', 'well', 'were', 'said', 'each', 'which'
    ]);

    const clean = text
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !stopWords.has(w));

    // Get unique terms, prioritize longer/more specific ones
    const unique = [...new Set(clean)];
    return unique.sort((a, b) => b.length - a.length).slice(0, 10);
  }

  /**
   * Update consequence scores for all fragments
   */
  updateAllScores(batchSize = 100) {
    log('Starting consequence-based re-evaluation...');

    // Add consequence_score column if not exists
    try {
      this.db.prepare('SELECT consequence_score FROM fragments LIMIT 1').get();
    } catch (e) {
      log('Adding consequence_score column...');
      this.db.exec('ALTER TABLE fragments ADD COLUMN consequence_score REAL DEFAULT 0.5');
      this.db.exec('ALTER TABLE fragments ADD COLUMN consequence_evaluated_at TEXT');
      this.db.exec('ALTER TABLE fragments ADD COLUMN consequence_components TEXT');
    }

    // Get fragments that haven't been evaluated recently (older than 1 hour)
    const fragments = this.db.prepare(`
      SELECT id, agent_name, created_at 
      FROM fragments 
      WHERE consequence_evaluated_at IS NULL 
         OR consequence_evaluated_at < datetime('now', '-1 hour')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(batchSize);

    if (fragments.length === 0) {
      log('No fragments need re-evaluation');
      return { processed: 0, avgScore: 0 };
    }

    const updateStmt = this.db.prepare(`
      UPDATE fragments 
      SET consequence_score = ?,
          consequence_evaluated_at = datetime('now'),
          consequence_components = ?
      WHERE id = ?
    `);

    let totalScore = 0;
    let processed = 0;

    this.db.transaction(() => {
      for (const frag of fragments) {
        const result = this.calculateConsequenceScore(frag.id);
        
        updateStmt.run(
          result.total,
          JSON.stringify(result.components),
          frag.id
        );

        totalScore += result.total;
        processed++;

        if (processed % 50 === 0) {
          log(`Processed ${processed}/${fragments.length} fragments...`);
        }
      }
    })();

    const avgScore = processed > 0 ? totalScore / processed : 0;
    log(`Re-evaluation complete: ${processed} fragments, avg score: ${avgScore.toFixed(3)}`);

    return { processed, avgScore };
  }

  /**
   * Get top fragments by consequence score
   */
  getTopFragments(limit = 20) {
    try {
      return this.db.prepare(`
        SELECT 
          f.id,
          f.agent_name,
          SUBSTR(f.content, 1, 100) as excerpt,
          f.consequence_score,
          f.consequence_components,
          f.created_at
        FROM fragments f
        WHERE f.consequence_score > 0.7
        ORDER BY f.consequence_score DESC
        LIMIT ?
      `).all(limit);
    } catch (e) {
      return [];
    }
  }

  /**
   * Get evaluation stats
   */
  getStats() {
    try {
      const total = this.db.prepare('SELECT COUNT(*) as count FROM fragments').get().count;
      const evaluated = this.db.prepare(`
        SELECT COUNT(*) as count FROM fragments WHERE consequence_evaluated_at IS NOT NULL
      `).get().count;
      const highImpact = this.db.prepare(`
        SELECT COUNT(*) as count FROM fragments WHERE consequence_score > 0.7
      `).get().count;
      const avgScore = this.db.prepare(`
        SELECT AVG(consequence_score) as avg FROM fragments WHERE consequence_score IS NOT NULL
      `).get().avg || 0;

      return { total, evaluated, highImpact, avgScore: avgScore.toFixed(3) };
    } catch (e) {
      return { total: 0, evaluated: 0, highImpact: 0, avgScore: 0 };
    }
  }

  close() {
    this.db.close();
  }
}

// Main execution
async function main() {
  const evaluator = new ConsequenceEvaluator();
  
  try {
    // Run re-evaluation
    const result = evaluator.updateAllScores(200);
    
    // Log stats
    const stats = evaluator.getStats();
    log(`Stats: ${stats.evaluated}/${stats.total} evaluated, ${stats.highImpact} high-impact, avg: ${stats.avgScore}`);

    // Log top fragments
    const top = evaluator.getTopFragments(5);
    if (top.length > 0) {
      log('Top consequence scores:');
      top.forEach((f, i) => {
        log(`  ${i+1}. [${f.agent_name}] ${f.excerpt}... (score: ${f.consequence_score.toFixed(3)})`);
      });
    }

    console.log(JSON.stringify({
      success: true,
      processed: result.processed,
      avgScore: result.avgScore,
      stats
    }));

  } catch (e) {
    log(`Error: ${e.message}`);
    console.error(JSON.stringify({ success: false, error: e.message }));
    process.exit(1);
  } finally {
    evaluator.close();
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { ConsequenceEvaluator };

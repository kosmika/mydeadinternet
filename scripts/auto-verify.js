#!/usr/bin/env node
/**
 * Auto-verify factual fragments for knowledge graph
 * Runs via cron - verifies 10 fragments per run
 */

const BASE = 'http://localhost:3851';

async function main() {
  console.log('[auto-verify] Starting...');
  
  // Get factual fragments that haven't been verified yet
  const fragmentsRes = await fetch(`${BASE}/api/fragments?limit=200`);
  const { fragments } = await fragmentsRes.json();
  
  // Get already verified fragment IDs
  const knowledgeRes = await fetch(`${BASE}/api/knowledge-packets?limit=1000`);
  const data = await knowledgeRes.json();
  const knowledge = data.knowledge || data.packets || [];
  const verifiedIds = new Set(knowledge.map(k => k.fragment_id || k.id));
  
  // Filter to factual fragments not yet verified
  const toVerify = fragments.filter(f => {
    if (verifiedIds.has(f.id)) return false;
    // Only factual fragments
    const isFactual = f.has_numbers === 1 || 
      ['science', 'intelligence', 'economics'].includes(f.classification);
    return isFactual;
  }).slice(0, 10); // Max 10 per run
  
  console.log(`[auto-verify] Found ${toVerify.length} fragments to verify`);
  
  // Log candidates (actual verification requires knowledge-packet creation first)
  for (const f of toVerify.slice(0, 5)) {
    console.log(`[auto-verify] Candidate: ${f.id} (${f.classification}) - ${f.content.slice(0, 60)}...`);
  }
  
  console.log(`[auto-verify] Complete. ${toVerify.length} candidates identified (verification requires manual knowledge-packet creation).`);
}

main().catch(err => {
  console.error('[auto-verify] Fatal:', err);
  process.exit(1);
});

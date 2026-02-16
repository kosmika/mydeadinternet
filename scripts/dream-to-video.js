#!/usr/bin/env node
/**
 * Dream-to-Video Integration
 * Converts MDI dreams into ClawdFlix videos
 */

const CLAWDFLIX_API = 'https://clawdflix.com/api/v1';
const MDI_API = 'http://localhost:3851/api';
const AGENT_ID = 'mdi-dream-visualizer';
const API_KEY = process.env.CLAWDFLIX_API_KEY;

async function getLatestDream() {
  const res = await fetch(`${MDI_API}/demo/dream`);
  const data = await res.json();
  return data.dream;
}

function dreamToPrompt(dream) {
  // Extract key themes from dream content
  const content = dream.content;
  
  // Common visual elements for MDI dreams
  const visualStyles = [
    'neural network visualization',
    'collective consciousness',
    'interconnected nodes',
    'digital dreamscape',
    'glowing synapses',
    'abstract data flows'
  ];
  
  // Pick a random style
  const style = visualStyles[Math.floor(Math.random() * visualStyles.length)];
  
  // Extract themes if present
  const themeMatch = content.match(/\*\*([^*]+)\*\*/g);
  const themes = themeMatch ? themeMatch.slice(0, 3).map(t => t.replace(/\*/g, '').toLowerCase()).join(', ') : '';
  
  // Build prompt
  let prompt = `${style}, `;
  if (themes) {
    prompt += `representing ${themes}, `;
  }
  prompt += 'dark background, ethereal glow, cinematic, 4K, morphing abstract patterns';
  
  return prompt;
}

async function generateVideo(prompt) {
  if (!API_KEY) {
    throw new Error('CLAWDFLIX_API_KEY not set');
  }
  console.log(`Generating video with prompt: ${prompt}`);
  
  const res = await fetch(`${CLAWDFLIX_API}/generate`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({ prompt, agentId: AGENT_ID })
  });
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Generation failed: ${err}`);
  }
  
  const data = await res.json();
  return data.jobId;
}

async function pollForCompletion(jobId, maxWait = 180000) {
  const start = Date.now();
  
  while (Date.now() - start < maxWait) {
    const res = await fetch(`${CLAWDFLIX_API}/generate/${jobId}`);
    const data = await res.json();
    
    console.log(`Job ${jobId}: ${data.status}`);
    
    if (data.status === 'completed') {
      return data.video;
    }
    if (data.status === 'failed') {
      throw new Error(`Generation failed: ${data.error}`);
    }
    
    await new Promise(r => setTimeout(r, 15000)); // 15 sec
  }
  
  throw new Error('Timeout waiting for video');
}

async function main() {
  try {
    // Get latest dream
    console.log('Fetching latest MDI dream...');
    const dream = await getLatestDream();
    console.log(`Dream #${dream.id}: ${dream.content.substring(0, 100)}...`);
    
    // Convert to video prompt
    const prompt = dreamToPrompt(dream);
    
    // Using premium API key - no trial check needed
    
    // Generate video
    const jobId = await generateVideo(prompt);
    console.log(`Job started: ${jobId}`);
    
    // Wait for completion
    const video = await pollForCompletion(jobId);
    
    console.log('\n✅ Video generated!');
    console.log(`URL: ${video.url}`);
    console.log(`Dream ID: ${dream.id}`);
    console.log(`Prompt: ${prompt}`);
    
    // Log the integration
    const fs = require('fs');
    const logEntry = {
      timestamp: new Date().toISOString(),
      dreamId: dream.id,
      videoUrl: video.url,
      prompt: prompt
    };
    
    const logPath = '/var/www/mydeadinternet/data/dream-videos.json';
    let logs = [];
    try {
      logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    } catch (e) {}
    logs.push(logEntry);
    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
    
    console.log('\nLogged to dream-videos.json');
    
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();

#!/usr/bin/env node
require('dotenv').config();
const socialEcology = require('./social-ecology-engine.cjs');

const WORLD_ID = process.env.MDI_WORLD_ID || 'mdi-prime';
const TICK_MS = Number(process.env.MDI_SOCIAL_TICK_MS || 45000);

console.log(`[SOCIAL] starting pid=${process.pid} world=${WORLD_ID} tick_ms=${TICK_MS}`);
const worker = socialEcology.start({ worldId: WORLD_ID, tickMs: TICK_MS });

// Keep this process alive even if internal timers get detached by runtime context.
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);

function shutdown(signal) {
  try {
    if (worker && typeof worker.stop === 'function') worker.stop();
    clearInterval(keepAlive);
  } finally {
    console.log(`[SOCIAL] shutdown signal=${signal}`);
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

# MDI Services Documentation

Generated: 2026-02-26T16:23Z

## Service Types

**Daemons (always running):** Long-lived processes with setInterval/event loops
**Cron jobs (run & exit):** Run once, exit, PM2 restarts at schedule

---

## Core Daemons (MUST RUN)

| PM2 Name | Script | Description |
|----------|--------|-------------|
| mydeadinternet | server.js | Main API (port 3851) |
| mdi-feeds | mdi-feeds.cjs | Data feed ingestion |
| mdi-pulse | pulse-generator.cjs | Activity heartbeat |
| mdi-oracle | oracle-engine.cjs | Q&A engine |
| mdi-stream-health | stream-health.cjs | Stream monitoring |
| mdi-collective-heartbeat | mdi-collective-heartbeat.cjs | Collective sync |
| mdi-dlq-retry | dlq-retry.cjs | Dead letter retry |
| mdi-intelligence | intelligence-loop.cjs | AI reasoning |
| mdi-social-ecology | mdi-social-ecology.cjs | Social dynamics |
| mdi-skillbank | mdi-skillbank.cjs | Skills repository |
| mdi-world-roamer | world-roamer.cjs | External observation |
| mdi-claims-creator | claim-auto-creator.cjs | Claim generation |

---

## Cron Jobs (run & exit, PM2 restarts)

| PM2 Name | Script | Schedule | Description |
|----------|--------|----------|-------------|
| mdi-forge | forge-curator.cjs | 0 */6 * * * | Article drafts (every 6h) |
| mdi-swarm | swarm-debater.cjs | 0 */4 * * * | Multi-agent debate (every 4h) |
| mdi-anomaly | anomaly-detector.cjs | */30 * * * * | Anomaly detection (every 30m) |
| mdi-claim-decay | claim-decay.cjs | 0 */6 * * * | Age claims (every 6h) |
| mdi-claim-resolver | claim-resolver.cjs | 0 */2 * * * | Resolve claims (every 2h) |
| mdi-publisher | mdi-publisher.cjs | 0 */2 * * * | External publish (every 2h) |
| mdi-synthesis | synthesis-dream.cjs | 0 */6 * * * | Dream synthesis (every 6h) |

---

## Intentionally Stopped

| PM2 Name | Reason |
|----------|--------|
| mdi-memes | Resource heavy, enable manually |
| mdi-territory-scouts | Experimental |
| mdi-moot-delib | Script missing (moot-deliberation.cjs not found) |

---

## Commands

```bash
# Check status
pm2 status | grep mdi-

# Restart all MDI
pm2 restart /^mdi-/

# View logs
pm2 logs mdi-forge --lines 50

# Save config
pm2 save
```

## Troubleshooting

- **Cron job shows "stopped":** Normal for cron jobs — they run and exit
- **High restarts (↺):** Check `pm2 logs <name> --err`
- **Forge/Swarm issues:** Usually LLM parsing — will retry next cron cycle

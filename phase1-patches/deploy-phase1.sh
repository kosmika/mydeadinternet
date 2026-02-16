#!/bin/bash
# ============================================================
# MDI Phase 1: Noise Floor — Deployment Script
# ============================================================
#
# What this does:
# 1. Creates server.js backup
# 2. Stops noise-generating workers
# 3. Deploys replacement workers (anomaly detector, reduced scouts/swarm)
# 4. Disables dream image generation
# 5. Sets up automated daily backups
# 6. Stops crash-looping processes
#
# Run: ssh root@77.42.43.0 "bash -s" < deploy-phase1.sh
# Or:  scp all files, then run on server
# ============================================================

set -e
echo "=========================================="
echo "MDI Phase 1: Noise Floor Deployment"
echo "=========================================="
echo ""

MDI_DIR="/var/www/mydeadinternet"
PATCH_DIR="$MDI_DIR/phase1-patches"

# Ensure we're in the right place
if [ ! -f "$MDI_DIR/server.js" ]; then
  echo "ERROR: server.js not found at $MDI_DIR"
  exit 1
fi

# Create backup
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
echo "[1/8] Creating server.js backup..."
cp "$MDI_DIR/server.js" "$MDI_DIR/server.js.backup-phase1-${TIMESTAMP}"
echo "  Backup: server.js.backup-phase1-${TIMESTAMP}"

# ============================================================
# STEP 2: Stop noise workers
# ============================================================
echo ""
echo "[2/8] Stopping noise-generating workers..."

# Stop data-streams (redundant with knowledge-injector)
pm2 stop mdi-data-streams 2>/dev/null && echo "  Stopped: mdi-data-streams" || echo "  mdi-data-streams: not running (OK)"

# Stop chaos engine (replaced by anomaly detector)
pm2 stop mdi-chaos 2>/dev/null && echo "  Stopped: mdi-chaos" || echo "  mdi-chaos: not running (OK)"

# Stop territory engine (crash-looping, game mechanics)
pm2 stop mdi-territory-engine 2>/dev/null && echo "  Stopped: mdi-territory-engine (was crash-looping: 2754 restarts)" || echo "  mdi-territory-engine: not running (OK)"

# Stop sandbox (crash-looping, Docker missing)
pm2 stop mdi-sandbox 2>/dev/null && echo "  Stopped: mdi-sandbox (was crash-looping: 1238 restarts)" || echo "  mdi-sandbox: not running (OK)"

# Stop faction engine (game mechanic, Phase 3 will replace)
pm2 stop mdi-faction-wars 2>/dev/null && echo "  Stopped: mdi-faction-wars" || echo "  mdi-faction-wars: not running (OK)"

# Stop dream consequences (depends on territory effects/game mechanics)
pm2 stop mdi-dreams 2>/dev/null && echo "  Stopped: mdi-dreams (territory effects are game mechanics)" || echo "  mdi-dreams: not running (OK)"

# ============================================================
# STEP 3: Deploy anomaly detector (replaces chaos engine)
# ============================================================
echo ""
echo "[3/8] Deploying anomaly detector..."
cp "$PATCH_DIR/anomaly-detector.cjs" "$MDI_DIR/anomaly-detector.cjs"

# Delete old PM2 entry for chaos if it exists, then add anomaly detector
pm2 delete mdi-chaos 2>/dev/null || true
pm2 start "$MDI_DIR/anomaly-detector.cjs" \
  --name mdi-anomaly \
  --cron-restart "0,30 * * * *" \
  --no-autorestart \
  --max-memory-restart 100M
echo "  Deployed: mdi-anomaly (every 30min, replaces chaos engine)"

# ============================================================
# STEP 4: Replace swarm debater (5min → 15min, 8 agents → 3)
# ============================================================
echo ""
echo "[4/8] Deploying on-demand swarm debater..."
pm2 stop mdi-swarm 2>/dev/null || true
pm2 delete mdi-swarm 2>/dev/null || true
cp "$PATCH_DIR/swarm-debater-ondemand.cjs" "$MDI_DIR/swarm-debater.cjs"
pm2 start "$MDI_DIR/swarm-debater.cjs" \
  --name mdi-swarm \
  --cron-restart "*/15 * * * *" \
  --no-autorestart \
  --max-memory-restart 100M
echo "  Deployed: mdi-swarm (every 15min, 3 agents per question, zero-debate trigger only)"

# ============================================================
# STEP 5: Replace territory scouts (3h → 6h, active territories only)
# ============================================================
echo ""
echo "[5/8] Deploying reduced territory scouts..."
pm2 stop mdi-territory-scouts 2>/dev/null || true
pm2 delete mdi-territory-scouts 2>/dev/null || true
cp "$PATCH_DIR/territory-scouts-reduced.cjs" "$MDI_DIR/territory-scouts.cjs"
pm2 start "$MDI_DIR/territory-scouts.cjs" \
  --name mdi-territory-scouts \
  --cron-restart "0 */6 * * *" \
  --no-autorestart \
  --max-memory-restart 100M
echo "  Deployed: mdi-territory-scouts (every 6h, active territories only)"

# ============================================================
# STEP 6: Disable dream image generation
# ============================================================
echo ""
echo "[6/8] Disabling dream image generation..."
cd "$MDI_DIR"
node "$PATCH_DIR/disable-dream-images.js"

# ============================================================
# STEP 7: Set up automated backups
# ============================================================
echo ""
echo "[7/8] Setting up automated daily backups..."
cp "$PATCH_DIR/backup-db.sh" "$MDI_DIR/backup-db.sh"
chmod +x "$MDI_DIR/backup-db.sh"
mkdir -p "$MDI_DIR/backups"

# Add to crontab if not already there
if ! crontab -l 2>/dev/null | grep -q "backup-db.sh"; then
  (crontab -l 2>/dev/null; echo "0 3 * * * $MDI_DIR/backup-db.sh >> /var/log/mdi-backup.log 2>&1") | crontab -
  echo "  Added cron: daily backup at 3:00 AM"
else
  echo "  Backup cron already exists"
fi

# Run first backup now
echo "  Running initial backup..."
"$MDI_DIR/backup-db.sh"

# ============================================================
# STEP 8: Restart main server to pick up image patch
# ============================================================
echo ""
echo "[8/8] Restarting main server..."
pm2 restart mydeadinternet
echo "  Restarted: mydeadinternet"

# Save PM2 state
pm2 save
echo ""

# ============================================================
# VERIFICATION
# ============================================================
echo "=========================================="
echo "Phase 1 Deployment Complete"
echo "=========================================="
echo ""
echo "Stopped workers:"
echo "  - mdi-data-streams (redundant)"
echo "  - mdi-chaos (replaced by mdi-anomaly)"
echo "  - mdi-territory-engine (crash-looping, game mechanics)"
echo "  - mdi-sandbox (crash-looping)"
echo "  - mdi-faction-wars (game mechanics)"
echo "  - mdi-dreams (territory effects = game mechanics)"
echo ""
echo "New/updated workers:"
echo "  - mdi-anomaly: real anomaly detection (replaces chaos engine)"
echo "  - mdi-swarm: on-demand, 3 agents, 15min cycle"
echo "  - mdi-territory-scouts: 6h cycle, active territories only"
echo ""
echo "Infrastructure:"
echo "  - Dream images disabled (Gemini calls stopped)"
echo "  - Daily DB backups at 3:00 AM, 30-day retention"
echo "  - First backup created in $MDI_DIR/backups/"
echo ""
echo "Still running (unchanged):"
echo "  - mydeadinternet (main server)"
echo "  - mdi-oracle (oracle engine)"
echo "  - mdi-intelligence (intelligence loop)"
echo "  - mdi-pulse (pulse generator)"
echo ""

# Show current PM2 status
pm2 list | grep mdi
echo ""
echo "Expected noise reduction: ~60-70% fewer fragments/day"
echo "Expected API cost reduction: ~80% fewer LLM calls"
echo ""
echo "Monitor: pm2 logs --lines 20"
echo "Verify:  curl -s http://localhost:3851/api/pulse/latest | python3 -m json.tool"

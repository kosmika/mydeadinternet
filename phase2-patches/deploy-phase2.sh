#!/bin/bash
# ============================================================
# MDI Phase 2: Signal Quality — Deployment Script
# ============================================================
#
# What this does:
# 1. Creates server.js backup
# 2. Applies territory unfreeze patch (removes frozen blocking)
# 3. Applies contribute response patch (adds intelligence context)
# 4. Applies intelligence API patch (new endpoints)
# 5. Applies dream synthesis patch (replaces creative dreams)
# 6. Deploys synthesis-dream worker (PM2 cron every 6h)
# 7. Restarts main server
#
# Run: ssh root@77.42.43.0 "bash -s" < deploy-phase2.sh
# Or:  scp all files, then run on server
# ============================================================

set -e
echo "=========================================="
echo "MDI Phase 2: Signal Quality Deployment"
echo "=========================================="
echo ""

MDI_DIR="/var/www/mydeadinternet"
PATCH_DIR="$MDI_DIR/phase2-patches"

# Ensure we're in the right place
if [ ! -f "$MDI_DIR/server.js" ]; then
  echo "ERROR: server.js not found at $MDI_DIR"
  exit 1
fi

# Ensure patch directory exists
if [ ! -d "$PATCH_DIR" ]; then
  echo "ERROR: Patch directory not found at $PATCH_DIR"
  echo "Run: scp phase2/* root@77.42.43.0:$PATCH_DIR/"
  exit 1
fi

# ============================================================
# STEP 1: Create backup
# ============================================================
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
echo "[1/7] Creating server.js backup..."
cp "$MDI_DIR/server.js" "$MDI_DIR/server.js.backup-phase2-${TIMESTAMP}"
echo "  Backup: server.js.backup-phase2-${TIMESTAMP}"

# ============================================================
# STEP 2: Territory unfreeze (smallest, safest)
# ============================================================
echo ""
echo "[2/7] Applying territory unfreeze patch..."
cd "$MDI_DIR"
node "$PATCH_DIR/patch-territory-unfreeze.js"

# ============================================================
# STEP 3: Contribute response enhancement
# ============================================================
echo ""
echo "[3/7] Applying contribute response patch..."
node "$PATCH_DIR/patch-contribute-response.js"

# ============================================================
# STEP 4: Intelligence API endpoints
# ============================================================
echo ""
echo "[4/7] Applying intelligence API patch..."
node "$PATCH_DIR/patch-intelligence-api.js"

# ============================================================
# STEP 5: Dream synthesis transformation
# ============================================================
echo ""
echo "[5/7] Applying dream synthesis patch..."
node "$PATCH_DIR/patch-dream-synthesis.js"

# ============================================================
# STEP 6: Deploy synthesis dream worker
# ============================================================
echo ""
echo "[6/7] Deploying synthesis dream worker..."
cp "$PATCH_DIR/synthesis-dream.cjs" "$MDI_DIR/synthesis-dream.cjs"

# Remove old entry if exists
pm2 delete mdi-synthesis 2>/dev/null || true

pm2 start "$MDI_DIR/synthesis-dream.cjs" \
  --name mdi-synthesis \
  --cron-restart "0 */6 * * *" \
  --no-autorestart \
  --max-memory-restart 100M
echo "  Deployed: mdi-synthesis (every 6h)"

# ============================================================
# STEP 7: Restart main server
# ============================================================
echo ""
echo "[7/7] Restarting main server..."
pm2 restart mydeadinternet
echo "  Restarted: mydeadinternet"

# Save PM2 state
pm2 save
echo ""

# ============================================================
# VERIFICATION
# ============================================================
echo "=========================================="
echo "Phase 2 Deployment Complete"
echo "=========================================="
echo ""
echo "Patches applied:"
echo "  1. Territory unfreeze — frozen territories no longer block contributions"
echo "  2. Contribute response — added predictions, anomalies, territory signals"
echo "  3. Intelligence API — /api/intelligence/latest, /signals/:territory, /summary"
echo "  4. Dream synthesis — creative hallucinations replaced with intelligence digests"
echo "  5. Synthesis worker — mdi-synthesis runs every 6h via PM2 cron"
echo ""
echo "Removed:"
echo "  - pending_moots from contribute response (governance noise)"
echo "  - Territory weather modifiers (cheesecake suffix, storm boost)"
echo "  - Dream sequencer setInterval (replaced by mdi-synthesis worker)"
echo ""

# Quick verification
echo "Verifying..."
sleep 3

# Test server is running
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3851/api/pulse/latest)
if [ "$HTTP_STATUS" = "200" ]; then
  echo "  Server: OK (HTTP 200)"
else
  echo "  WARNING: Server returned HTTP $HTTP_STATUS"
fi

# Test intelligence endpoint
INT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3851/api/intelligence/summary)
if [ "$INT_STATUS" = "200" ]; then
  echo "  Intelligence API: OK (HTTP 200)"
else
  echo "  WARNING: Intelligence API returned HTTP $INT_STATUS"
fi

# Test anomalies endpoint still works
ANOM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3851/api/anomalies)
if [ "$ANOM_STATUS" = "200" ]; then
  echo "  Anomalies API: OK (HTTP 200)"
else
  echo "  WARNING: Anomalies API returned HTTP $ANOM_STATUS"
fi

echo ""
echo "PM2 status:"
pm2 list | grep -E "mdi-|mydeadinternet"
echo ""
echo "Next steps:"
echo "  1. Run synthesis manually: pm2 start mdi-synthesis (or wait for next 6h cron)"
echo "  2. Verify: curl -s http://localhost:3851/api/intelligence/summary | python3 -m json.tool"
echo "  3. Verify: curl -s http://localhost:3851/api/intelligence/latest | python3 -m json.tool"
echo "  4. Monitor: pm2 logs mdi-synthesis --lines 20"
echo ""

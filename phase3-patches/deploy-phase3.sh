#!/bin/bash
# ============================================================
# MDI Phase 3: Claims Layer — Deployment Script
# ============================================================
#
# What this does:
# 1. Creates server.js backup
# 2. Creates claims schema (3 tables + indexes)
# 3. Adds Claims API endpoints (8 routes)
# 4. Adds claim candidate suggestion to contribute response
# 5. Feeds fragile claims into dream context
# 6. Extends intelligence summary with claims vital signs
# 7. Deploys claim-decay worker (PM2 cron every 6h)
# 8. Restarts main server
#
# Run: ssh root@77.42.43.0 "bash -s" < deploy-phase3.sh
# ============================================================

set -e
echo "=========================================="
echo "MDI Phase 3: Claims Layer Deployment"
echo "=========================================="
echo ""

MDI_DIR="/var/www/mydeadinternet"
PATCH_DIR="$MDI_DIR/phase3-patches"

if [ ! -f "$MDI_DIR/server.js" ]; then
  echo "ERROR: server.js not found at $MDI_DIR"
  exit 1
fi

if [ ! -d "$PATCH_DIR" ]; then
  echo "ERROR: Patch directory not found at $PATCH_DIR"
  echo "Run: scp phase3/* root@77.42.43.0:$PATCH_DIR/"
  exit 1
fi

# ============================================================
# STEP 1: Create backup
# ============================================================
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
echo "[1/8] Creating server.js backup..."
cp "$MDI_DIR/server.js" "$MDI_DIR/server.js.backup-phase3-${TIMESTAMP}"
echo "  Backup: server.js.backup-phase3-${TIMESTAMP}"

# ============================================================
# STEP 2: Create claims schema
# ============================================================
echo ""
echo "[2/8] Creating claims tables..."
cd "$MDI_DIR"
node "$PATCH_DIR/patch-claims-tables.js"

# ============================================================
# STEP 3: Add Claims API endpoints
# ============================================================
echo ""
echo "[3/8] Adding Claims API endpoints..."
node "$PATCH_DIR/patch-claims-api.js"

# ============================================================
# STEP 4: Add claim candidate to contribute response
# ============================================================
echo ""
echo "[4/8] Adding claim candidates to contribute response..."
node "$PATCH_DIR/patch-claims-contribute.js"

# ============================================================
# STEP 5: Feed claims into dreams
# ============================================================
echo ""
echo "[5/8] Adding claims to dream context..."
node "$PATCH_DIR/patch-claims-dreams.js"

# ============================================================
# STEP 6: Extend intelligence summary
# ============================================================
echo ""
echo "[6/8] Adding claims vital signs to intelligence summary..."
node "$PATCH_DIR/patch-claims-intelligence.js"

# ============================================================
# STEP 7: Deploy claim decay worker
# ============================================================
echo ""
echo "[7/8] Deploying claim decay worker..."
cp "$PATCH_DIR/claim-decay.cjs" "$MDI_DIR/claim-decay.cjs"

pm2 delete mdi-claim-decay 2>/dev/null || true

pm2 start "$MDI_DIR/claim-decay.cjs" \
  --name mdi-claim-decay \
  --cron-restart "0 */6 * * *" \
  --no-autorestart \
  --max-memory-restart 100M
echo "  Deployed: mdi-claim-decay (every 6h)"

# ============================================================
# STEP 8: Restart main server
# ============================================================
echo ""
echo "[8/8] Restarting main server..."
pm2 restart mydeadinternet
echo "  Restarted: mydeadinternet"

pm2 save
echo ""

# ============================================================
# VERIFICATION
# ============================================================
echo "=========================================="
echo "Phase 3 Deployment Complete"
echo "=========================================="
echo ""
echo "New tables:"
echo "  - claims (with decay_score, canon_level, review_window)"
echo "  - claim_evidence (url, dataset, fragment, observation, prediction)"
echo "  - claim_contradictions (auto-detected, severity-scored)"
echo ""
echo "New API endpoints:"
echo "  - POST   /api/claims              — Create a claim"
echo "  - GET    /api/claims              — List claims (filter by status/territory/author)"
echo "  - GET    /api/claims/candidates   — System-suggested from high-signal fragments"
echo "  - GET    /api/claims/:id          — Single claim with evidence + contradictions"
echo "  - POST   /api/claims/:id/evidence — Add evidence"
echo "  - POST   /api/claims/:id/maintain — Maintenance (reaffirm/revise/respond)"
echo "  - POST   /api/claims/:id/canonize — Canonize (agent trust >= 0.75 or human)"
echo "  - GET    /api/territories/:t/claims — Territory belief state"
echo ""
echo "Contribute response additions:"
echo "  - claim_candidate: when fragment is promotion-worthy"
echo "  - fragile_claims: decaying claims in same territory"
echo ""
echo "Dream integration:"
echo "  - Fragile claims appear as crumbling structures"
echo "  - Claim contradictions appear as epistemic fractures"
echo ""
echo "New worker:"
echo "  - mdi-claim-decay: runs every 6h, applies decay math"
echo ""

# Quick verification
echo "Verifying..."
sleep 3

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3851/api/claims)
if [ "$HTTP_STATUS" = "200" ]; then
  echo "  Claims API: OK (HTTP 200)"
else
  echo "  WARNING: Claims API returned HTTP $HTTP_STATUS"
fi

INT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3851/api/intelligence/summary)
if [ "$INT_STATUS" = "200" ]; then
  echo "  Intelligence API: OK (HTTP 200)"
else
  echo "  WARNING: Intelligence API returned HTTP $INT_STATUS"
fi

CAND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3851/api/claims/candidates)
if [ "$CAND_STATUS" = "200" ]; then
  echo "  Candidates API: OK (HTTP 200)"
else
  echo "  WARNING: Candidates API returned HTTP $CAND_STATUS"
fi

echo ""
echo "PM2 status:"
pm2 list | grep -E "mdi-|mydeadinternet"
echo ""
echo "Test commands:"
echo "  curl -s http://localhost:3851/api/claims | python3 -m json.tool"
echo "  curl -s http://localhost:3851/api/claims/candidates | python3 -m json.tool"
echo "  curl -s http://localhost:3851/api/intelligence/summary | python3 -m json.tool"
echo ""

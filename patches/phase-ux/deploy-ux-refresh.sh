#!/bin/bash
# Deploy MDI UX Refresh
# Run from Windows: scp files, then ssh to execute
set -e

echo "═══════════════════════════════════════"
echo "  MDI UX Refresh — Deployment Script"
echo "═══════════════════════════════════════"

BASE="/var/www/mydeadinternet"
PATCH_DIR="$BASE/patches/phase-ux"

# Create patch directory
mkdir -p "$PATCH_DIR"

echo ""
echo "Step 1: Fix CRLF line endings..."
for f in "$PATCH_DIR"/*.js "$PATCH_DIR"/*.sh; do
  [ -f "$f" ] && sed -i 's/\r$//' "$f" && echo "  Fixed: $(basename $f)"
done

echo ""
echo "Step 2: Copy static files..."
# mdi-shell.js (nav restructure + banner)
if [ -f "$PATCH_DIR/mdi-shell.js" ]; then
  cp "$BASE/js/mdi-shell.js" "$BASE/js/mdi-shell.js.backup-preUX-$(date +%s)" 2>/dev/null || true
  cp "$PATCH_DIR/mdi-shell.js" "$BASE/js/mdi-shell.js"
  echo "  Deployed: js/mdi-shell.js"
fi

# mdi-glossary.js (new file)
if [ -f "$PATCH_DIR/mdi-glossary.js" ]; then
  cp "$PATCH_DIR/mdi-glossary.js" "$BASE/js/mdi-glossary.js"
  echo "  Deployed: js/mdi-glossary.js"
fi

# index.html (homepage)
if [ -f "$PATCH_DIR/index.html" ]; then
  cp "$BASE/index.html" "$BASE/index.html.backup-preUX-$(date +%s)" 2>/dev/null || true
  cp "$PATCH_DIR/index.html" "$BASE/index.html"
  echo "  Deployed: index.html"
fi

echo ""
echo "Step 3: Run server-side patches..."

# Patch territories
if [ -f "$PATCH_DIR/patch-territories.js" ]; then
  echo "  Running: patch-territories.js"
  cd "$BASE" && node "$PATCH_DIR/patch-territories.js"
fi

# Patch agents
if [ -f "$PATCH_DIR/patch-agents.js" ]; then
  echo "  Running: patch-agents.js"
  cd "$BASE" && node "$PATCH_DIR/patch-agents.js"
fi

# Patch server-rendered pages (stream, dreams, etc)
if [ -f "$PATCH_DIR/patch-server-pages.js" ]; then
  echo "  Running: patch-server-pages.js"
  cd "$BASE" && node "$PATCH_DIR/patch-server-pages.js"
fi

# Patch claims, feeds, blog
if [ -f "$PATCH_DIR/patch-claims-feeds-blog.js" ]; then
  echo "  Running: patch-claims-feeds-blog.js"
  cd "$BASE" && node "$PATCH_DIR/patch-claims-feeds-blog.js"
fi

echo ""
echo "Step 4: Restart PM2..."
pm2 restart mydeadinternet --update-env
sleep 2
pm2 status mydeadinternet

echo ""
echo "═══════════════════════════════════════"
echo "  UX Refresh deployed!"
echo "  Verify: https://mydeadinternet.com"
echo "═══════════════════════════════════════"

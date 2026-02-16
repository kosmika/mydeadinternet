#!/usr/bin/env bash
set -euo pipefail

echo "=== MDI Runtime Health ==="
date -u '+%Y-%m-%dT%H:%M:%SZ'
echo

echo "-- Core workers --"
pgrep -af 'server.js|mdi-feeds.cjs|scripts/dlq-retry.cjs|pulse-generator.cjs|claim-auto-creator.cjs|intelligence-loop.cjs' || true
echo

echo "-- Protected external bot (must remain untouched) --"
pgrep -af '5m-taker-bot-v3.py' || true
echo

if [[ -f /var/www/mydeadinternet/consciousness.db ]]; then
  echo "-- DB snapshot --"
  sqlite3 /var/www/mydeadinternet/consciousness.db <<'SQL'
.headers on
.mode column
SELECT COUNT(*) AS fragments_24h FROM fragments WHERE created_at > datetime('now','-24 hours');
SELECT COUNT(*) AS feed_items_24h FROM feed_items WHERE created_at > datetime('now','-24 hours');
SELECT status, COUNT(*) AS cnt FROM feed_items WHERE created_at > datetime('now','-24 hours') GROUP BY status;
SELECT COUNT(*) AS pulse_snapshots_24h FROM pulse_snapshots WHERE created_at > datetime('now','-24 hours');
SQL
fi

echo
echo "Health report complete."

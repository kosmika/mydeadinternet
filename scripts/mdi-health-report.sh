#!/usr/bin/env bash
set -euo pipefail

echo "=== MDI Runtime Health ==="
date -u '+%Y-%m-%dT%H:%M:%SZ'
echo

echo "-- Core workers --"
pgrep -af 'server.js|mdi-feeds.cjs|scripts/dlq-retry.cjs|pulse-generator.cjs|claim-auto-creator.cjs|intelligence-loop.cjs|world-roamer.cjs|mdi-social-ecology.cjs' || true
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
SELECT COUNT(*) AS world_events_24h FROM world_events WHERE created_at > datetime('now','-24 hours');
SELECT COUNT(*) AS active_cohorts FROM social_cohorts WHERE status = 'active';
SELECT COUNT(*) AS alliance_edges FROM social_edges WHERE edge_type = 'alliance' AND strength >= 0.42;
SELECT COUNT(*) AS rivalry_edges FROM social_edges WHERE edge_type = 'rivalry' AND strength >= 0.48;
SELECT active_cohorts, alliance_edges, rivalry_edges, mission_count, pipeline_overlap_avg, action_diversity, created_at
FROM social_metrics_snapshots
ORDER BY id DESC
LIMIT 1;
SQL
fi

echo
if command -v curl >/dev/null 2>&1; then
  echo "-- API health --"
  curl -sS -m 8 http://127.0.0.1:3851/api/worlds/health | sed -n '1,120p' || true
  echo
  curl -sS -m 8 http://127.0.0.1:3851/api/worlds/mdi-prime/ecology | sed -n '1,120p' || true
fi

echo
echo "Health report complete."

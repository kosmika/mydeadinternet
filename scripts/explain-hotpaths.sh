#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${DB_PATH:-/var/www/mydeadinternet/consciousness.db}"

if [[ ! -f "${DB_PATH}" ]]; then
  echo "DB not found: ${DB_PATH}"
  exit 1
fi

run_plan() {
  local title="$1"
  local sql="$2"
  echo "=== ${title} ==="
  sqlite3 "${DB_PATH}" "EXPLAIN QUERY PLAN ${sql}"
  echo
}

run_plan "Pulse snapshot latest" \
  "SELECT payload_json FROM pulse_snapshots ORDER BY created_at DESC LIMIT 1;"

run_plan "Funnel event aggregate (24h)" \
  "SELECT event_name, COUNT(*) FROM funnel_events WHERE created_at > datetime('now', '-24 hours') GROUP BY event_name;"

run_plan "Feed scheduler due lookup" \
  "SELECT id, next_run_at FROM feeds WHERE status = 'active' AND next_run_at <= datetime('now') ORDER BY next_run_at ASC;"

run_plan "Recent contributed feed items" \
  "SELECT fi.id, fi.created_at FROM feed_items fi WHERE fi.status = 'contributed' ORDER BY fi.created_at DESC LIMIT 50;"

run_plan "Recent high-signal fragments by territory" \
  "SELECT id, territory_id, signal_score FROM fragments WHERE created_at > datetime('now', '-24 hours') AND signal_score > 0.5 ORDER BY created_at DESC LIMIT 200;"

echo "Hot-path plan check complete."

#!/bin/bash
# MDI OSINT Pipeline - Run aggregation and integration
# Run every 30 minutes via cron

cd /var/www/mydeadinternet

echo "[$(date -Iseconds)] Starting OSINT pipeline..."

# Run aggregator
node scripts/osint-feeds/aggregator.cjs

# Run integration
node scripts/osint-feeds/mdi-integration.cjs

echo "[$(date -Iseconds)] OSINT pipeline complete."

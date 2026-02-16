#!/bin/bash
# Daily SQLite backup with 30-day retention
# Install via crontab: 0 3 * * * /var/www/mydeadinternet/backup-db.sh >> /var/log/mdi-backup.log 2>&1

DB_PATH="/var/www/mydeadinternet/consciousness.db"
BACKUP_DIR="/var/www/mydeadinternet/backups"
RETENTION_DAYS=30
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/consciousness_${TIMESTAMP}.db"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Use SQLite's .backup command (safe for WAL mode, takes a consistent snapshot)
sqlite3 "$DB_PATH" ".backup '${BACKUP_FILE}'"

if [ $? -eq 0 ]; then
    # Compress the backup
    gzip "$BACKUP_FILE"

    SIZE=$(du -h "${BACKUP_FILE}.gz" | cut -f1)
    echo "[$(date)] Backup created: ${BACKUP_FILE}.gz (${SIZE})"

    # Prune old backups
    DELETED=$(find "$BACKUP_DIR" -name "consciousness_*.db.gz" -mtime +${RETENTION_DAYS} -delete -print | wc -l)
    if [ "$DELETED" -gt 0 ]; then
        echo "[$(date)] Pruned ${DELETED} backups older than ${RETENTION_DAYS} days"
    fi
else
    echo "[$(date)] ERROR: Backup failed!"
    exit 1
fi

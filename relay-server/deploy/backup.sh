#!/bin/sh
set -eu

ROOT_DIR=${ROOT_DIR:-/opt/qingyu-relay}
BACKUP_DIR=${BACKUP_DIR:-/opt/backups/qingyu-relay}
RETENTION_DAYS=${RETENTION_DAYS:-14}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$BACKUP_DIR/qingyu-relay-$timestamp.dump"
temporary="$target.tmp"

install -d -m 700 "$BACKUP_DIR"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
cd "$ROOT_DIR"
docker compose -f relay-server/docker-compose.yml exec -T postgres \
  pg_dump -U qingyu_relay -d qingyu_relay --format=custom --no-owner > "$temporary"
test -s "$temporary"
mv "$temporary" "$target"
chmod 600 "$target"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'qingyu-relay-*.dump' -mtime "+$RETENTION_DAYS" -delete
printf '%s\n' "$target"

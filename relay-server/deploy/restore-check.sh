#!/bin/sh
set -eu

ROOT_DIR=${ROOT_DIR:-/opt/qingyu-relay}
BACKUP_DIR=${BACKUP_DIR:-/opt/backups/qingyu-relay}
backup=${1:-$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'qingyu-relay-*.dump' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)}
test -n "$backup"
test -s "$backup"
database=qingyu_relay_restore_check
container=relay-server-postgres-1

cleanup() {
  docker exec "$container" dropdb -U qingyu_relay --if-exists "$database" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
cleanup
docker exec "$container" createdb -U qingyu_relay "$database"
docker exec -i "$container" pg_restore -U qingyu_relay -d "$database" --no-owner --exit-on-error < "$backup"
migrations=$(docker exec "$container" psql -U qingyu_relay -d "$database" -Atc 'select count(*) from relay_schema_migrations')
test "$migrations" -ge 3
printf 'restore_check=ok migrations=%s\n' "$migrations"

#!/bin/sh
set -eu

# 阶段 8 S8-07：备份同时覆盖 PostgreSQL（含 sync_* 表）与对象存储。
# 恢复到隔离环境做一致性检查；日志不得输出 token/key/ciphertext。

ROOT_DIR=${ROOT_DIR:-/opt/qingyu-relay}
BACKUP_DIR=${BACKUP_DIR:-/opt/backups/qingyu-relay}
RETENTION_DAYS=${RETENTION_DAYS:-14}
OBJECT_DIR=${RELAY_OBJECT_DIR:-/var/lib/qingyu-relay/objects}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$BACKUP_DIR/qingyu-relay-$timestamp.dump"
objects_target="$BACKUP_DIR/qingyu-relay-objects-$timestamp.tar"
temporary="$target.tmp"
objects_temporary="$objects_target.tmp"

install -d -m 700 "$BACKUP_DIR"
trap 'rm -f "$temporary" "$objects_temporary"' EXIT HUP INT TERM
cd "$ROOT_DIR"
docker compose -f relay-server/docker-compose.yml exec -T postgres \
  pg_dump -U qingyu_relay -d qingyu_relay --format=custom --no-owner > "$temporary"
test -s "$temporary"
mv "$temporary" "$target"
chmod 600 "$target"

# 对象存储（blob/大密文）；key 为随机 ID，打包本身不含用户文件名
if [ -d "$OBJECT_DIR" ]; then
  tar -C "$OBJECT_DIR" -cf "$objects_temporary" .
  test -s "$objects_temporary"
  mv "$objects_temporary" "$objects_target"
  chmod 600 "$objects_target"
fi

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'qingyu-relay-*.dump' -o -name 'qingyu-relay-objects-*.tar' \) -mtime "+$RETENTION_DAYS" -delete
printf '%s\n' "$target"
[ -f "$objects_target" ] && printf '%s\n' "$objects_target"

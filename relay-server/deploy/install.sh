#!/bin/sh
set -eu

ROOT_DIR=${1:-/opt/qingyu-relay}
: "${RELAY_PUBLIC_URL:?RELAY_PUBLIC_URL is required}"

cd "$ROOT_DIR"
install -d -m 700 relay-server/secrets
if [ ! -f relay-server/secrets/relay_jwt_private.pem ]; then
  openssl genpkey -algorithm Ed25519 -out relay-server/secrets/relay_jwt_private.pem
  openssl pkey -in relay-server/secrets/relay_jwt_private.pem -pubout -out relay-server/secrets/relay_jwt_public.pem
fi
# The runtime image uses the standard Node uid/gid 1000. Keep the private key
# unreadable to other host users while allowing the non-root container to read it.
chown -R 1000:1000 relay-server/secrets
chmod 700 relay-server/secrets
chmod 600 relay-server/secrets/relay_jwt_private.pem
chmod 644 relay-server/secrets/relay_jwt_public.pem

if [ ! -f relay-server/.env ]; then
  postgres_password=$(openssl rand -hex 24)
  token_pepper=$(openssl rand -hex 32)
  pair_pepper=$(openssl rand -hex 32)
  minio_user=$(openssl rand -hex 12)
  minio_password=$(openssl rand -hex 32)
  umask 077
  {
    printf 'NODE_ENV=production\n'
    printf 'PORT=3100\n'
    printf 'RELAY_BIND_PORT=3100\n'
    printf 'RELAY_PUBLIC_URL=%s\n' "$RELAY_PUBLIC_URL"
    printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password"
    printf 'DATABASE_URL=postgresql://qingyu_relay:%s@postgres/qingyu_relay\n' "$postgres_password"
    printf 'REDIS_URL=redis://redis:6379/0\n'
    printf 'JWT_PRIVATE_KEY_PATH=/run/secrets/relay_jwt_private.pem\n'
    printf 'JWT_PUBLIC_KEY_PATH=/run/secrets/relay_jwt_public.pem\n'
    printf 'TOKEN_PEPPER=%s\n' "$token_pepper"
    printf 'PAIR_CODE_PEPPER=%s\n' "$pair_pepper"
    printf 'S3_ENDPOINT=http://minio:9000\n'
    printf 'S3_BUCKET=qingyu-relay\n'
    printf 'S3_ACCESS_KEY=%s\n' "$minio_user"
    printf 'S3_SECRET_KEY=%s\n' "$minio_password"
    printf 'MINIO_ROOT_USER=%s\n' "$minio_user"
    printf 'MINIO_ROOT_PASSWORD=%s\n' "$minio_password"
    printf 'DEFAULT_SPACE_QUOTA_BYTES=524288000\n'
    printf 'DEFAULT_CACHE_RETENTION_DAYS=7\n'
    printf 'REGISTRATION_MODE=open\n'
  } > relay-server/.env
fi
chmod 600 relay-server/.env

docker compose -f relay-server/docker-compose.yml up -d --build

if command -v systemctl >/dev/null 2>&1; then
  chmod 755 relay-server/deploy/backup.sh relay-server/deploy/restore-check.sh
  install -m 644 relay-server/deploy/systemd/qingyu-relay-backup.service relay-server/deploy/systemd/qingyu-relay-backup.timer \
    relay-server/deploy/systemd/qingyu-relay-health.service relay-server/deploy/systemd/qingyu-relay-health.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now qingyu-relay-backup.timer qingyu-relay-health.timer
fi

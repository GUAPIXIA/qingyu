# QingYu Relay 0.1.0

Relay 为 PC 与 Android 提供出站 HTTPS/WSS 中转。PostgreSQL、Redis 与 MinIO 只应位于私网；生产环境仅由反向代理公开 443。

## 本地启动

1. 复制 `.env.example` 为 `.env`，替换数据库、MinIO 密码和两个 pepper。`POSTGRES_PASSWORD` 必须与 `DATABASE_URL` 中的 URL-safe 密码一致。
2. 在 `secrets/` 生成 Ed25519 私钥/公钥，文件名分别为 `relay_jwt_private.pem`、`relay_jwt_public.pem`。
3. 执行 `docker compose up --build`。`migrate` 服务按 `relay_schema_migrations` 记录只执行尚未应用的 SQL，再启动 Relay。
4. 检查 `/relay/v1/health/live` 与 `/relay/v1/health/ready`。

示例密钥生成：

```bash
mkdir -p secrets
openssl genpkey -algorithm Ed25519 -out secrets/relay_jwt_private.pem
openssl pkey -in secrets/relay_jwt_private.pem -pubout -out secrets/relay_jwt_public.pem
```

## 生产约束

- 不要直接暴露 Compose 的 3100 端口；由 TLS 反向代理转发 HTTP 与 WebSocket Upgrade。
- Compose 默认只将 Relay 映射到宿主机 `127.0.0.1:3100`；不得改为公网绑定。
- 数据库登录角色必须能 `SET ROLE qingyu_relay_app`；运行连接会在建连阶段立即降权，RLS 不允许关闭。
- 私钥、`.env`、pepper、数据库备份与对象存储凭据不得进入镜像或 Git。
- 当前媒体通道保持关闭。Relay 会明确拒绝发送媒体并剥离 PC 局域网媒体地址；启用媒体前需完成对象存储签名、类型/大小校验与跨空间文件测试。
- 上线前必须在真实环境完成双空间隔离、吊销、备份恢复、压力、监控告警和正式域名真机验证。

## 服务器安装

`deploy/install.sh` 在首次启动时生成数据库密码、pepper 和 Ed25519 密钥，不会覆盖已有 `.env` 或密钥。

```bash
sudo env RELAY_PUBLIC_URL=https://relay.example.com sh /opt/qingyu-relay/relay-server/deploy/install.sh
```

将 `deploy/nginx-location.conf` 包含到现有 HTTPS `server` 块后，先执行 `nginx -t`，再 reload。该配置保留 `/relay/` 路径并支持 WebSocket Upgrade，不对公网开放 metrics。

`install.sh` 同时安装每日备份与 5 分钟就绪检查定时器。备份默认写入 `/opt/backups/qingyu-relay`并保留 14 天；恢复演练使用独立临时数据库：

```bash
sudo /opt/qingyu-relay/relay-server/deploy/backup.sh
sudo /opt/qingyu-relay/relay-server/deploy/restore-check.sh
```

## 校验

```bash
pnpm --dir relay-server check
pnpm --dir relay-server test
pnpm --dir relay-server build
```

import { loadConfig } from './config.js'
import { buildApp } from './app.js'
import { AccessTokenService } from './auth/accessToken.js'
import { RelayHub } from './ws/relayHub.js'
import { createPool } from './db/pool.js'
import { withTenantTransaction } from './db/tenantTransaction.js'
import type { RelayAccessClaims } from './auth/accessToken.js'
import { Redis } from 'ioredis'
import { MetricsRegistry } from './observability/metrics.js'
import { SnapshotService } from './cache/snapshotService.js'
import { CommandQueue } from './cache/commandQueue.js'
import { RetentionWorker } from './cache/retentionWorker.js'
import { RedisRateLimiter } from './security/rateLimiter.js'

const config = loadConfig()
const tokens = new AccessTokenService(config.jwtPrivateKey, config.jwtPublicKey)
const metrics = new MetricsRegistry()
const pool = createPool(config)
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false })
const limiter = new RedisRateLimiter(redis)
redis.on('error', () => { /* readiness reports dependency failure without logging credentials */ })
const validate = (claims: RelayAccessClaims) => withTenantTransaction(pool, claims.sid, async (client) => {
  const result = await client.query(
    `SELECT 1 FROM relay_devices d JOIN relay_spaces s ON s.id=d.space_id
     WHERE d.id=$1 AND d.role=$2 AND d.token_version=$3 AND d.revoked_at IS NULL AND s.status='active'`,
    [claims.sub, claims.role, claims.tv],
  )
  return result.rowCount === 1
})
const hub = new RelayHub(tokens, validate, metrics)
const snapshots = new SnapshotService(pool, config.retentionDays)
const commands = new CommandQueue(pool, hub.broker, (spaceId, event, data, targetDeviceId) => {
  hub.publishAndroidEvent(spaceId, event, data, targetDeviceId)
})
const retention = new RetentionWorker(pool, (spaceId, event, data, targetDeviceId) => {
  hub.publishAndroidEvent(spaceId, event, data, targetDeviceId)
})
hub.setCacheHandler((spaceId, payload) => snapshots.accept(spaceId, payload))
hub.setPcReadyHandler((spaceId, socket) => commands.drain(spaceId, socket))
const app = buildApp(config, {
  pool, tokens, hub, validate, snapshots, commands, metrics, limiter,
  ready: async () => { await Promise.all([pool.query('SELECT 1'), redis.ping()]) },
  close: async () => { retention.stop(); redis.disconnect() },
})
hub.attach(app.server)
retention.start()

await app.listen({ port: config.port, host: '0.0.0.0' })

const shutdown = async () => { await app.close(); process.exit(0) }
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

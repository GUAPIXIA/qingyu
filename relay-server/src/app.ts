import Fastify from 'fastify'
import type { RelayConfig } from './config.js'
import { healthRoutes } from './http/healthRoutes.js'
import type pg from 'pg'
import type { AccessTokenService } from './auth/accessToken.js'
import type { RelayHub } from './ws/relayHub.js'
import { spaceRoutes } from './http/spaceRoutes.js'
import { pairingRoutes } from './http/pairingRoutes.js'
import { bridgeRoutes } from './http/bridgeRoutes.js'
import type { RelayAccessClaims } from './auth/accessToken.js'
import type { SnapshotService } from './cache/snapshotService.js'
import type { CommandQueue } from './cache/commandQueue.js'
import { requireRelayAuth } from './auth/middleware.js'
import { notFound } from './http/relayErrors.js'
import { withTenantTransaction } from './db/tenantTransaction.js'
import type { MetricsRegistry } from './observability/metrics.js'
import type { RedisRateLimiter } from './security/rateLimiter.js'
import { syncRoutes } from './sync/syncRoutes.js'
import { keyRoutes } from './sync/keyRoutes.js'
import { FsObjectStore, type ObjectStore } from './sync/objectStore.js'

export function buildApp(config: RelayConfig, dependencies: { pool: pg.Pool; tokens: AccessTokenService; hub: RelayHub; validate: (claims: RelayAccessClaims) => Promise<boolean>; snapshots: SnapshotService; commands: CommandQueue; metrics?: MetricsRegistry; limiter?: RedisRateLimiter; objects?: ObjectStore; ready?: () => Promise<void>; close?: () => Promise<void> }) {
  const app = Fastify({ trustProxy: 'loopback', logger: { level: process.env.NODE_ENV === 'production' ? 'info' : 'warn', redact: ['req.headers.authorization', 'body.refreshToken', 'body.ticket', 'body.claimSecret'] }, bodyLimit: 8 * 1024 * 1024 })
  const objects = dependencies.objects ?? new FsObjectStore(process.env.RELAY_OBJECT_DIR ?? 'relay-server/data/objects')
  app.register(healthRoutes, { ready: dependencies.ready })
  app.register(spaceRoutes, { pool: dependencies.pool, config, tokens: dependencies.tokens, limiter: dependencies.limiter })
  app.register(pairingRoutes, { pool: dependencies.pool, config, tokens: dependencies.tokens, hub: dependencies.hub, validate: dependencies.validate, metrics: dependencies.metrics, limiter: dependencies.limiter })
  app.register(bridgeRoutes, { tokens: dependencies.tokens, hub: dependencies.hub, validate: dependencies.validate, snapshots: dependencies.snapshots, commands: dependencies.commands, metrics: dependencies.metrics })
  // 阶段 8：/sync/v1 服务器同步 + E2EE 密钥交付（与旧 /relay/v1 隔离）
  app.register(syncRoutes, { pool: dependencies.pool, tokens: dependencies.tokens, validate: dependencies.validate, objects, metrics: dependencies.metrics })
  app.register(keyRoutes, { pool: dependencies.pool, tokens: dependencies.tokens, validate: dependencies.validate, metrics: dependencies.metrics })
  app.delete('/relay/v1/spaces/current/cache', { preHandler: requireRelayAuth(dependencies.tokens, 'pc', dependencies.validate) }, async (request) => {
    await withTenantTransaction(dependencies.pool, request.relayAuth!.sid, async (client) => {
      await client.query('DELETE FROM cached_messages')
      await client.query('DELETE FROM cached_sessions')
      await client.query('DELETE FROM cached_resources')
    })
    return { ok: true }
  })
  app.get('/relay/v1/server/info', async () => ({
    protocolVersion: 1,
    publicUrl: config.publicUrl.toString(),
    capabilities: ['relay.pairing', 'relay.rpc', 'relay.cache', 'relay.offlineQueue', 'sync.v1'],
  }))
  app.get('/relay/v1/metrics', async (_request, reply) => reply.type('text/plain; version=0.0.4').send(dependencies.metrics?.render() ?? ''))
  app.setNotFoundHandler(async (request, reply) => notFound(reply, request.id))
  app.addHook('onClose', async () => { await dependencies.close?.(); await dependencies.pool.end() })
  return app
}

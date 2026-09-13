import type { FastifyInstance } from 'fastify'
import type { AccessTokenService, RelayAccessClaims } from '../auth/accessToken.js'
import { requireRelayAuth } from '../auth/middleware.js'
import type { RelayHub } from '../ws/relayHub.js'
import { matchAllowedRoute } from '../routing/routeAllowlist.js'
import type { RelayRpcRequestPayload } from '../../../shared/relayProtocol.js'
import { randomUUID } from 'node:crypto'
import type { SnapshotService } from '../cache/snapshotService.js'
import type { CommandQueue } from '../cache/commandQueue.js'
import type { MetricsRegistry } from '../observability/metrics.js'
import { notFound, sendRelayError } from './relayErrors.js'

export async function bridgeRoutes(app: FastifyInstance, options: { tokens: AccessTokenService; hub: RelayHub; validate: (claims: RelayAccessClaims) => Promise<boolean>; snapshots: SnapshotService; commands: CommandQueue; metrics?: MetricsRegistry }): Promise<void> {
  app.all('/relay/v1/bridge/*', { preHandler: requireRelayAuth(options.tokens, 'android', options.validate) }, async (request, reply) => {
    const auth = request.relayAuth!
    const prefix = '/relay/v1/bridge'
    const rawPath = new URL(request.raw.url ?? '/', 'http://relay.invalid').pathname.slice(prefix.length)
    const route = matchAllowedRoute(request.method, rawPath)
    if (!route) return notFound(reply, request.id)
    const pc = options.hub.presence.get(auth.sid)
    if (!pc) {
      if (route.cacheable && request.method === 'GET') {
        const cached = await options.snapshots.readRoute(auth.sid, route.path)
        if (cached) { options.metrics?.inc('relay_cache_hit_total', { resource: route.path.includes('/messages') ? 'messages' : route.path.split('/').at(-1) ?? 'unknown' }); return reply.header('X-Qingyu-Data-Source', 'cache').header('X-Qingyu-Cache-Age', cached.ageSeconds).header('X-Qingyu-PC-Online', 'false').send(cached.body) }
      }
      if (route.queueWhenOffline && request.method === 'POST') {
        const commandId = (request.body as { requestId?: string } | null)?.requestId ?? randomUUID()
        const queuedPayload: RelayRpcRequestPayload = { commandId, sourceDeviceId: auth.sub, method: 'POST', path: route.path, query: {}, headers: { 'content-type': 'application/json' }, body: request.body, deadlineAt: Date.now() + 15 * 60_000 }
        const stableId = await options.commands.enqueue(auth.sid, auth.sub, queuedPayload)
        return reply.code(202).header('X-Qingyu-Data-Source', 'queued').header('X-Qingyu-PC-Online', 'false').send({ commandId: stableId, status: 'queued', expiresAt: Date.now() + 15 * 60_000 })
      }
      return sendRelayError(reply, 503, 'PC_OFFLINE', '电脑当前离线', request.id, true)
    }
    const query: Record<string, string | string[]> = {}
    for (const [key, value] of Object.entries(request.query as Record<string, unknown>)) {
      if (typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'))) query[key] = value as string | string[]
    }
    const payload: RelayRpcRequestPayload = {
      commandId: (request.body as { requestId?: string } | null)?.requestId ?? randomUUID(), sourceDeviceId: auth.sub,
      method: request.method as RelayRpcRequestPayload['method'], path: route.path, query,
      headers: { 'content-type': request.headers['content-type'] ?? 'application/json' }, body: request.body, deadlineAt: Date.now() + 60_000,
    }
    try {
      const response = await options.hub.broker.request(auth.sid, pc, payload)
      for (const [name, value] of Object.entries(response.headers)) reply.header(name, value)
      return reply.code(response.status).send(response.body)
    } catch (error) {
      const timeout = (error as Error).message === 'RPC_TIMEOUT'
      return sendRelayError(reply, timeout ? 504 : 503, timeout ? 'RPC_TIMEOUT' : 'PC_OFFLINE', timeout ? '电脑响应超时' : '电脑当前离线', request.id, true)
    }
  })
}

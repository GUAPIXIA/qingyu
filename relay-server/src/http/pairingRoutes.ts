import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type pg from 'pg'
import type { RelayConfig } from '../config.js'
import type { AccessTokenService, RelayAccessClaims } from '../auth/accessToken.js'
import { requireRelayAuth } from '../auth/middleware.js'
import { createPairCode, createPairTicketSecret, hashPairSecret, normalizePairCode } from '../auth/pairingTicket.js'
import { createOpaqueToken, hashOpaqueToken } from '../auth/refreshToken.js'
import { withTenantTransaction } from '../db/tenantTransaction.js'
import type { RelayHub } from '../ws/relayHub.js'
import type { MetricsRegistry } from '../observability/metrics.js'
import type { RedisRateLimiter } from '../security/rateLimiter.js'

interface PairResult { spaceId: string; deviceId: string; accessToken: string; refreshToken: string; accessTokenExpiresAt: number; tokenVersion: number }
interface PendingPair {
  id: string; spaceId: string; claimSecret: string; deviceId: string; deviceName: string; fingerprint: string
  expiresAt: number; status: 'pending' | 'approved' | 'rejected'; result?: PairResult
}

export async function pairingRoutes(app: FastifyInstance, options: { pool: pg.Pool; config: RelayConfig; tokens: AccessTokenService; hub: RelayHub; validate: (claims: RelayAccessClaims) => Promise<boolean>; metrics?: MetricsRegistry; limiter?: RedisRateLimiter }): Promise<void> {
  const pending = new Map<string, PendingPair>()
  const ticketByCode = new Map<string, string>()

  app.post('/relay/v1/pair-tickets', { preHandler: requireRelayAuth(options.tokens, 'pc', options.validate) }, async (request) => {
    const auth = request.relayAuth!; const ticket = `${auth.sid}.${createPairTicketSecret()}`; const code = createPairCode(); const expiresAt = Date.now() + 5 * 60_000
    await withTenantTransaction(options.pool, auth.sid, (client) => client.query(
      "INSERT INTO relay_pair_tickets(space_id,code_hash,expires_at) VALUES ($1,$2,to_timestamp($3/1000.0))",
      [auth.sid, hashPairSecret(options.config.pairCodePepper, ticket), expiresAt],
    ).then(() => undefined))
    ticketByCode.set(code, ticket); setTimeout(() => ticketByCode.delete(code), 5 * 60_000).unref()
    return { version: 1, scheme: 'qingyu-relay-pair', relayBaseUrl: new URL('/relay/v1/', options.config.publicUrl).toString(), ticket, code, displayName: '轻语 PC', expiresAt }
  })

  app.post('/relay/v1/pair-tickets/claim', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['deviceName', 'deviceFingerprint'], properties: {
      ticket: { type: 'string' }, code: { type: 'string' }, deviceName: { type: 'string', minLength: 1, maxLength: 100 }, deviceFingerprint: { type: 'string', minLength: 8, maxLength: 256 },
    } } },
  }, async (request, reply) => {
    const body = request.body as { ticket?: string; code?: string; deviceName: string; deviceFingerprint: string }
    if (options.limiter) {
      try {
        const byIp = await options.limiter.consume('pair:ip', request.ip, 30, 15 * 60)
        if (!byIp.allowed) return rateLimited(reply, request.id, byIp.retryAfterSeconds)
        const supplied = body.ticket ?? (normalizePairCode(body.code ?? '') || 'missing')
        const bySecret = await options.limiter.consume('pair:secret', supplied, 8, 15 * 60)
        if (!bySecret.allowed) return rateLimited(reply, request.id, bySecret.retryAfterSeconds)
      } catch {
        return reply.code(503).send({ error: { code: 'RELAY_UNAVAILABLE', message: '配对服务暂时不可用', retryable: true, requestId: request.id } })
      }
    }
    const ticket = body.ticket ?? (body.code ? ticketByCode.get(normalizePairCode(body.code)) : undefined)
    const spaceId = ticket?.slice(0, ticket.indexOf('.')) ?? ''
    if (!ticket || !/^[0-9a-f-]{36}$/i.test(spaceId)) { options.metrics?.inc('relay_pair_attempts_total', { result: 'invalid' }); return invalidTicket(reply, request.id) }
    const consumed = await withTenantTransaction(options.pool, spaceId, async (client) => {
      const found = await client.query<{ id: string }>('SELECT id FROM relay_pair_tickets WHERE code_hash=$1 AND expires_at>now() AND consumed_at IS NULL FOR UPDATE', [hashPairSecret(options.config.pairCodePepper, ticket)])
      if (!found.rows[0]) return false
      await client.query('UPDATE relay_pair_tickets SET consumed_at=now() WHERE id=$1', [found.rows[0].id]); return true
    })
    if (!consumed) { options.metrics?.inc('relay_pair_attempts_total', { result: 'invalid' }); return invalidTicket(reply, request.id) }
    const pair: PendingPair = { id: randomUUID(), spaceId, claimSecret: createPairTicketSecret(), deviceId: randomUUID(), deviceName: body.deviceName, fingerprint: body.deviceFingerprint, expiresAt: Date.now() + 5 * 60_000, status: 'pending' }
    pending.set(pair.id, pair)
    options.hub.sendToPc(spaceId, 'pair:requested', { requestId: pair.id, deviceName: pair.deviceName, expiresAt: pair.expiresAt })
    options.metrics?.inc('relay_pair_attempts_total', { result: 'claimed' })
    return reply.code(202).send({ pairRequestId: pair.id, claimSecret: pair.claimSecret })
  })

  app.get('/relay/v1/pair-requests/:id', async (request, reply) => {
    const pair = pending.get((request.params as { id: string }).id)
    if (!pair || request.headers.authorization !== `PairClaim ${pair.claimSecret}` || pair.expiresAt <= Date.now()) return invalidTicket(reply, request.id)
    if (pair.status === 'approved' && pair.result) { pending.delete(pair.id); return { status: 'approved', ...pair.result } }
    if (pair.status === 'rejected') { pending.delete(pair.id); return { status: 'rejected' } }
    return { status: 'pending' }
  })

  async function settle(request: FastifyRequest, reply: FastifyReply, approved: boolean) {
    const auth = request.relayAuth!; const pair = pending.get((request.params as { id: string }).id)
    if (!pair || pair.spaceId !== auth.sid || pair.expiresAt <= Date.now()) return notFound(reply, request.id)
    if (!approved) { pair.status = 'rejected'; options.metrics?.inc('relay_pair_attempts_total', { result: 'rejected' }); options.hub.sendToPc(pair.spaceId, 'pair:rejected', { requestId: pair.id }); return { ok: true } }
    const refreshToken = `${pair.spaceId}.${createOpaqueToken()}`
    await withTenantTransaction(options.pool, pair.spaceId, async (client) => {
      await client.query("INSERT INTO relay_devices(id,space_id,role,name,fingerprint_hash,approved_at) VALUES ($1,$2,'android',$3,digest($4,'sha256'),now())", [pair.deviceId, pair.spaceId, pair.deviceName, pair.fingerprint])
      await client.query("INSERT INTO relay_refresh_tokens(space_id,device_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '90 days')", [pair.spaceId, pair.deviceId, hashOpaqueToken(options.config.tokenPepper, refreshToken)])
    })
    const accessToken = await options.tokens.issue({ deviceId: pair.deviceId, spaceId: pair.spaceId, role: 'android', tokenVersion: 1 })
    pair.status = 'approved'; pair.result = { spaceId: pair.spaceId, deviceId: pair.deviceId, accessToken, refreshToken, accessTokenExpiresAt: Date.now() + 15 * 60_000, tokenVersion: 1 }; options.metrics?.inc('relay_pair_attempts_total', { result: 'approved' })
    options.hub.sendToPc(pair.spaceId, 'pair:approved', { requestId: pair.id }); return { ok: true }
  }
  app.post('/relay/v1/pair-requests/:id/approve', { preHandler: requireRelayAuth(options.tokens, 'pc', options.validate) }, (request, reply) => settle(request, reply, true))
  app.post('/relay/v1/pair-requests/:id/reject', { preHandler: requireRelayAuth(options.tokens, 'pc', options.validate) }, (request, reply) => settle(request, reply, false))

  app.get('/relay/v1/devices', { preHandler: requireRelayAuth(options.tokens, 'pc', options.validate) }, async (request) => withTenantTransaction(options.pool, request.relayAuth!.sid, async (client) => {
    const result = await client.query('SELECT id AS "deviceId",name,role,approved_at AS "approvedAt",last_seen_at AS "lastSeenAt" FROM relay_devices WHERE revoked_at IS NULL ORDER BY approved_at')
    return result.rows
  }))
  app.delete('/relay/v1/devices/:id', { preHandler: requireRelayAuth(options.tokens, 'pc', options.validate) }, async (request, reply) => {
    const auth = request.relayAuth!; const deviceId = (request.params as { id: string }).id
    if (deviceId === auth.sub) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: '不能在此处移除 PC 设备', retryable: false, requestId: request.id } })
    const changed = await withTenantTransaction(options.pool, auth.sid, async (client) => {
      const result = await client.query("UPDATE relay_devices SET revoked_at=now(),token_version=token_version+1 WHERE id=$1 AND role='android' AND revoked_at IS NULL", [deviceId])
      await client.query('UPDATE relay_refresh_tokens SET revoked_at=now() WHERE device_id=$1', [deviceId]); return result.rowCount
    })
    if (changed) { options.hub.disconnectDevice(deviceId); return { ok: true } }
    return notFound(reply, request.id)
  })
}

function invalidTicket(reply: FastifyReply, requestId: string) { return reply.code(401).send({ error: { code: 'PAIR_TICKET_INVALID', message: '连接码无效或已过期', retryable: false, requestId } }) }
function notFound(reply: FastifyReply, requestId: string) { return reply.code(404).send({ error: { code: 'RESOURCE_NOT_FOUND', message: '内容不存在', retryable: false, requestId } }) }
function rateLimited(reply: FastifyReply, requestId: string, retryAfterSeconds: number) { return reply.header('retry-after', String(retryAfterSeconds)).code(429).send({ error: { code: 'RATE_LIMITED', message: '请稍后再试', retryable: true, requestId } }) }

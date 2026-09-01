import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { RelayConfig } from '../config.js'
import type { AccessTokenService } from '../auth/accessToken.js'
import { createOpaqueToken, hashOpaqueToken } from '../auth/refreshToken.js'
import { withTenantTransaction } from '../db/tenantTransaction.js'
import type { RedisRateLimiter } from '../security/rateLimiter.js'

export async function spaceRoutes(app: FastifyInstance, options: { pool: pg.Pool; config: RelayConfig; tokens: AccessTokenService; limiter?: RedisRateLimiter }): Promise<void> {
  const { pool, config, tokens } = options
  app.post('/relay/v1/spaces/register-pc', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'fingerprint'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, fingerprint: { type: 'string', minLength: 16, maxLength: 256 } } } },
  }, async (request, reply) => {
    if (config.registrationMode !== 'open') return reply.code(403).send({ error: { code: 'SPACE_DISABLED', message: '当前 Relay 仅允许邀请注册', retryable: false, requestId: request.id } })
    const body = request.body as { name: string; fingerprint: string }
    if (options.limiter) {
      try {
        const byIp = await options.limiter.consume('register:ip', request.ip, 5, 60 * 60)
        if (!byIp.allowed) return rateLimited(reply, request.id, byIp.retryAfterSeconds)
        const byDevice = await options.limiter.consume('register:device', body.fingerprint, 3, 24 * 60 * 60)
        if (!byDevice.allowed) return rateLimited(reply, request.id, byDevice.retryAfterSeconds)
      } catch {
        return reply.code(503).send({ error: { code: 'RELAY_UNAVAILABLE', message: '注册服务暂时不可用', retryable: true, requestId: request.id } })
      }
    }
    const spaceId = randomUUID(); const deviceId = randomUUID(); const refreshSecret = createOpaqueToken(); const refreshToken = `${spaceId}.${refreshSecret}`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('INSERT INTO relay_spaces(id, quota_bytes, retention_days) VALUES ($1,$2,$3)', [spaceId, config.quotaBytes, config.retentionDays])
      await client.query("SELECT set_config('app.space_id',$1,true)", [spaceId])
      await client.query('INSERT INTO relay_devices(id,space_id,role,name,fingerprint_hash,approved_at) VALUES ($1,$2,\'pc\',$3,digest($4,\'sha256\'),now())', [deviceId, spaceId, body.name, body.fingerprint])
      await client.query('UPDATE relay_spaces SET owner_pc_id=$2 WHERE id=$1', [spaceId, deviceId])
      await client.query("INSERT INTO relay_refresh_tokens(space_id,device_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '90 days')", [spaceId, deviceId, hashOpaqueToken(config.tokenPepper, refreshToken)])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    const accessToken = await tokens.issue({ deviceId, spaceId, role: 'pc', tokenVersion: 1 })
    return reply.code(201).send({ spaceId, deviceId, accessToken, accessTokenExpiresAt: Date.now() + 15 * 60_000, refreshToken, tokenVersion: 1 })
  })

  app.post('/relay/v1/tokens/refresh', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['refreshToken'], properties: { refreshToken: { type: 'string', minLength: 40, maxLength: 200 } } } },
  }, async (request, reply) => {
    const supplied = (request.body as { refreshToken: string }).refreshToken
    const spaceId = supplied.slice(0, supplied.indexOf('.'))
    if (!/^[0-9a-f-]{36}$/i.test(spaceId)) return reply.code(401).send({ error: { code: 'INVALID_TOKEN', message: '凭据已失效', retryable: false, requestId: request.id } })
    const result = await withTenantTransaction(pool, spaceId, async (client) => {
      const hash = hashOpaqueToken(config.tokenPepper, supplied)
      const found = await client.query<{ id: string; device_id: string; role: 'pc' | 'android'; token_version: number; replaced_by: string | null; revoked_at: Date | null }>(
        `SELECT t.id,t.device_id,d.role,d.token_version,t.replaced_by,t.revoked_at FROM relay_refresh_tokens t
         JOIN relay_devices d ON d.space_id=t.space_id AND d.id=t.device_id
         WHERE t.token_hash=$1 AND t.expires_at>now() AND d.revoked_at IS NULL FOR UPDATE`, [hash],
      )
      const current = found.rows[0]
      if (!current || current.revoked_at || current.replaced_by) {
        if (current) await client.query('UPDATE relay_refresh_tokens SET revoked_at=now() WHERE device_id=$1', [current.device_id])
        return null
      }
      const secret = createOpaqueToken(); const refreshToken = `${spaceId}.${secret}`; const replacementId = randomUUID()
      await client.query("INSERT INTO relay_refresh_tokens(id,space_id,device_id,token_hash,expires_at) VALUES ($1,$2,$3,$4,now()+interval '90 days')", [replacementId, spaceId, current.device_id, hashOpaqueToken(config.tokenPepper, refreshToken)])
      await client.query('UPDATE relay_refresh_tokens SET replaced_by=$2,revoked_at=now() WHERE id=$1', [current.id, replacementId])
      return { ...current, refreshToken }
    })
    if (!result) return reply.code(401).send({ error: { code: 'INVALID_TOKEN', message: '凭据已失效', retryable: false, requestId: request.id } })
    const accessToken = await tokens.issue({ deviceId: result.device_id, spaceId, role: result.role, tokenVersion: result.token_version })
    return { spaceId, deviceId: result.device_id, accessToken, accessTokenExpiresAt: Date.now() + 15 * 60_000, refreshToken: result.refreshToken, tokenVersion: result.token_version }
  })
}

function rateLimited(reply: import('fastify').FastifyReply, requestId: string, retryAfterSeconds: number) {
  return reply.header('retry-after', String(retryAfterSeconds)).code(429).send({ error: { code: 'RATE_LIMITED', message: '请稍后再试', retryable: true, requestId } })
}

import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AccessTokenService, RelayAccessClaims } from './accessToken.js'

declare module 'fastify' { interface FastifyRequest { relayAuth?: RelayAccessClaims } }

export function requireRelayAuth(tokens: AccessTokenService, role?: 'pc' | 'android', validate?: (claims: RelayAccessClaims) => Promise<boolean>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization ?? ''
    if (!header.startsWith('Bearer ')) { await reply.code(401).send({ error: { code: 'INVALID_TOKEN', message: '登录已失效，请重新连接', retryable: false, requestId: request.id } }); return }
    try {
      const claims = await tokens.verify(header.slice(7))
      if (role && claims.role !== role) throw new Error('role mismatch')
      if (validate && !(await validate(claims))) throw new Error('device revoked')
      request.relayAuth = claims
    } catch {
      await reply.code(401).send({ error: { code: 'INVALID_TOKEN', message: '登录已失效，请重新连接', retryable: false, requestId: request.id } })
    }
  }
}

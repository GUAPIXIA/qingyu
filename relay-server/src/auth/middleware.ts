import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AccessTokenService, RelayAccessClaims } from './accessToken.js'
import { invalidToken } from '../http/relayErrors.js'

declare module 'fastify' { interface FastifyRequest { relayAuth?: RelayAccessClaims } }

export function requireRelayAuth(tokens: AccessTokenService, role?: 'pc' | 'android', validate?: (claims: RelayAccessClaims) => Promise<boolean>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization ?? ''
    if (!header.startsWith('Bearer ')) { invalidToken(reply, request.id); return }
    try {
      const claims = await tokens.verify(header.slice(7))
      if (role && claims.role !== role) throw new Error('role mismatch')
      if (validate && !(await validate(claims))) throw new Error('device revoked')
      request.relayAuth = claims
    } catch {
      invalidToken(reply, request.id)
    }
  }
}

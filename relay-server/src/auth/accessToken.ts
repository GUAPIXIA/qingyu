import { importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from 'jose'
import type { RelayRole } from '../../../shared/relayProtocol.js'

export interface RelayAccessClaims extends JWTPayload {
  iss: 'qingyu-relay'; aud: 'qingyu-relay-client'; sub: string; sid: string; role: RelayRole; tv: number
}

export class AccessTokenService {
  private privateKeyPromise: ReturnType<typeof importPKCS8>
  private publicKeyPromise: ReturnType<typeof importSPKI>

  constructor(privatePem: string, publicPem: string) {
    this.privateKeyPromise = importPKCS8(privatePem, 'EdDSA')
    this.publicKeyPromise = importSPKI(publicPem, 'EdDSA')
  }

  async issue(input: { deviceId: string; spaceId: string; role: RelayRole; tokenVersion: number }, now = Math.floor(Date.now() / 1000)): Promise<string> {
    return new SignJWT({ sid: input.spaceId, role: input.role, tv: input.tokenVersion })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setIssuer('qingyu-relay').setAudience('qingyu-relay-client').setSubject(input.deviceId)
      .setIssuedAt(now).setExpirationTime(now + 15 * 60).sign(await this.privateKeyPromise)
  }

  async verify(token: string): Promise<RelayAccessClaims> {
    const { payload } = await jwtVerify(token, await this.publicKeyPromise, {
      algorithms: ['EdDSA'], issuer: 'qingyu-relay', audience: 'qingyu-relay-client',
    })
    if (!payload.sub || typeof payload.sid !== 'string' || (payload.role !== 'pc' && payload.role !== 'android') || typeof payload.tv !== 'number') {
      throw new Error('invalid relay access claims')
    }
    return payload as RelayAccessClaims
  }
}

import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose'
import { describe, expect, it } from 'vitest'
import { AccessTokenService } from '../src/auth/accessToken.js'
import { hashOpaqueToken, verifyOpaqueToken } from '../src/auth/refreshToken.js'

describe('relay auth', () => {
  it('issues a 15 minute Ed25519 access token with tenant/device claims', async () => {
    const pair = await generateKeyPair('EdDSA', { extractable: true })
    const service = new AccessTokenService(await exportPKCS8(pair.privateKey), await exportSPKI(pair.publicKey))
    const token = await service.issue({ deviceId: 'device-a', spaceId: 'space-a', role: 'android', tokenVersion: 3 })
    const claims = await service.verify(token)
    expect(claims).toMatchObject({ sub: 'device-a', sid: 'space-a', role: 'android', tv: 3 })
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(900)
  })

  it('hashes opaque tokens with the pepper and verifies in constant-time helper', () => {
    const hash = hashOpaqueToken('p'.repeat(32), 'secret')
    expect(verifyOpaqueToken('p'.repeat(32), 'secret', hash)).toBe(true)
    expect(verifyOpaqueToken('p'.repeat(32), 'other', hash)).toBe(false)
  })
})

import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose'
import { describe, expect, it } from 'vitest'
import { AccessTokenService } from '../src/auth/accessToken.js'
import { createPairCode, normalizePairCode } from '../src/auth/pairingTicket.js'
import { hashOpaqueToken, verifyOpaqueToken } from '../src/auth/refreshToken.js'
import { decodeFrame, encodeFrame, RelayProtocolError } from '../src/ws/frameCodec.js'
import { relayFrame, RELAY_MAX_JSON_BYTES } from '../../shared/relayProtocol.js'

describe('relay auth and protocol', () => {
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

  it('normalizes Crockford codes and keeps deterministic output in alphabet', () => {
    expect(normalizePairCode('o1-il 2')).toBe('01112')
    expect(createPairCode(Buffer.alloc(8, 31))).toBe('ZZZZZZZZ')
  })

  it('round-trips frames and rejects incompatible/oversized frames', () => {
    expect(decodeFrame(encodeFrame(relayFrame('connection:ping'))).type).toBe('connection:ping')
    expect(() => decodeFrame('{"v":2,"type":"x","sentAt":1}')).toThrowError(RelayProtocolError)
    expect(() => decodeFrame(Buffer.alloc(RELAY_MAX_JSON_BYTES + 1))).toThrowError(/too large/)
  })
})

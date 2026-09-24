/**
 * 阶段 7 S7-03：LAN 一次性授权——纯函数单测（transcript 稳定性、短认证串、HKDF、QR 过期）。
 */
import { describe, expect, it } from 'vitest'
import { diffieHellman, generateKeyPairSync } from 'node:crypto'
import {
  LAN_AUTH_TRANSCRIPT_DOMAIN,
  LAN_SYNC_AUTH_TTL_MS,
  LAN_SYNC_QR_SCHEME,
  LAN_SYNC_SCOPE,
  buildLanAuthTranscript,
  buildLanSyncQrPayload,
  deriveLanSessionKeys,
  deriveShortAuthString,
  lanAuthTranscriptHash,
  parseLanSyncQr,
} from '../sync-core/lanAuth'

const NOW = 1_788_000_300_000
const PC_PUB = Buffer.alloc(32, 0x11).toString('base64')
const AND_PUB = Buffer.alloc(32, 0x22).toString('base64')
const SECRET = Buffer.alloc(32, 0xab).toString('base64')

function sampleTranscript() {
  return {
    sessionId: 'sess-lan-001',
    host: '192.168.1.8',
    port: 8321,
    fingerprint: 'fp-abc123',
    expiresAt: NOW + LAN_SYNC_AUTH_TTL_MS,
    secret: SECRET,
    pcPublicKey: PC_PUB,
    androidPublicKey: AND_PUB,
  }
}

describe('S7-03 LAN 授权 transcript', () => {
  it('同输入 transcript / hash / 短认证串稳定', () => {
    const t1 = buildLanAuthTranscript(sampleTranscript())
    const t2 = buildLanAuthTranscript(sampleTranscript())
    expect(t1).toBe(t2)
    expect(lanAuthTranscriptHash(t1)).toBe(lanAuthTranscriptHash(t2))
    expect(deriveShortAuthString(t1)).toBe(deriveShortAuthString(t2))
    expect(deriveShortAuthString(t1)).toMatch(/^\d{6}$/)
  })

  it('任一绑定字段变化 → 短认证串变化（防降级/重放绑定）', () => {
    const base = deriveShortAuthString(buildLanAuthTranscript(sampleTranscript()))
    const cases = [
      { ...sampleTranscript(), sessionId: 'sess-other' },
      { ...sampleTranscript(), host: '10.0.0.1' },
      { ...sampleTranscript(), port: 9999 },
      { ...sampleTranscript(), fingerprint: 'fp-zzz' },
      { ...sampleTranscript(), expiresAt: NOW + 1 },
      { ...sampleTranscript(), secret: Buffer.alloc(32, 0xcd).toString('base64') },
      { ...sampleTranscript(), pcPublicKey: Buffer.alloc(32, 0x33).toString('base64') },
      { ...sampleTranscript(), androidPublicKey: Buffer.alloc(32, 0x44).toString('base64') },
    ]
    for (const c of cases) {
      expect(deriveShortAuthString(buildLanAuthTranscript(c))).not.toBe(base)
    }
  })

  it('transcript 含域分隔符，不可空串字段漂移', () => {
    const t = buildLanAuthTranscript(sampleTranscript())
    expect(t).toContain(LAN_AUTH_TRANSCRIPT_DOMAIN)
    expect(t).toContain('sess-lan-001')
  })
})

describe('S7-03 会话密钥 HKDF', () => {
  it('相同 sharedSecret + transcript → 相同密钥；密钥 32B 且两把不同', () => {
    const shared = Buffer.alloc(32, 0x55)
    const transcript = buildLanAuthTranscript(sampleTranscript())
    const a = deriveLanSessionKeys({ sharedSecret: shared, transcript })
    const b = deriveLanSessionKeys({ sharedSecret: shared, transcript })
    expect(a).toEqual(b)
    expect(Buffer.from(a.sessionKey, 'base64')).toHaveLength(32)
    expect(Buffer.from(a.macKey, 'base64')).toHaveLength(32)
    expect(a.sessionKey).not.toBe(a.macKey)
  })

  it('transcript 或 sharedSecret 变化 → 密钥变化', () => {
    const shared = Buffer.alloc(32, 0x55)
    const t0 = buildLanAuthTranscript(sampleTranscript())
    const t1 = buildLanAuthTranscript({ ...sampleTranscript(), sessionId: 'other' })
    const k0 = deriveLanSessionKeys({ sharedSecret: shared, transcript: t0 })
    const k1 = deriveLanSessionKeys({ sharedSecret: shared, transcript: t1 })
    const k2 = deriveLanSessionKeys({ sharedSecret: Buffer.alloc(32, 0x66), transcript: t0 })
    expect(k0.sessionKey).not.toBe(k1.sessionKey)
    expect(k0.sessionKey).not.toBe(k2.sessionKey)
  })

  it('真实 X25519 ECDH 两端 sharedSecret 一致，派生密钥逐字节相同', () => {
    const pc = generateKeyPairSync('x25519')
    const android = generateKeyPairSync('x25519')
    const pcPub = pc.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
    const andPub = android.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
    const sharedA = diffieHellman({ privateKey: pc.privateKey, publicKey: android.publicKey })
    const sharedB = diffieHellman({ privateKey: android.privateKey, publicKey: pc.publicKey })
    expect(Buffer.from(sharedA)).toEqual(Buffer.from(sharedB))

    const input = {
      ...sampleTranscript(),
      pcPublicKey: pcPub.toString('base64'),
      androidPublicKey: andPub.toString('base64'),
    }
    const transcript = buildLanAuthTranscript(input)
    const ka = deriveLanSessionKeys({ sharedSecret: sharedA, transcript })
    const kb = deriveLanSessionKeys({ sharedSecret: sharedB, transcript })
    expect(ka).toEqual(kb)
  })
})

describe('S7-03 QR 载荷', () => {
  it('build → JSON → parse 往返；scope=sync、TTL 常量正确', () => {
    const payload = buildLanSyncQrPayload({
      host: '192.168.1.8',
      port: 8321,
      sessionId: 'sess-lan-001',
      pcPublicKey: PC_PUB,
      secret: SECRET,
      expiresAt: NOW + LAN_SYNC_AUTH_TTL_MS,
      fingerprint: 'fp-abc123',
      displayName: '我的电脑',
    })
    expect(payload.scope).toBe(LAN_SYNC_SCOPE)
    expect(payload.scheme).toBe(LAN_SYNC_QR_SCHEME)
    expect(LAN_SYNC_AUTH_TTL_MS).toBe(5 * 60 * 1000)

    const parsed = parseLanSyncQr(JSON.stringify(payload), NOW)
    expect(parsed.kind).toBe('ok')
    if (parsed.kind !== 'ok') return
    expect(parsed.payload).toEqual(payload)
  })

  it('过期 / 非法字段拒绝', () => {
    const payload = buildLanSyncQrPayload({
      host: '192.168.1.8',
      port: 8321,
      sessionId: 's',
      pcPublicKey: PC_PUB,
      secret: SECRET,
      expiresAt: NOW + 1000,
      fingerprint: 'fp',
      displayName: 'pc',
    })
    expect(parseLanSyncQr(JSON.stringify({ ...payload, expiresAt: NOW }), NOW)).toEqual({
      kind: 'invalid',
      reason: 'expired',
    })
    expect(parseLanSyncQr('nope', NOW)).toEqual({ kind: 'invalid', reason: 'not_json' })
    expect(parseLanSyncQr(JSON.stringify({ ...payload, scope: 'admin' }), NOW)).toEqual({
      kind: 'invalid',
      reason: 'bad_scope',
    })
    expect(parseLanSyncQr(JSON.stringify({ ...payload, secret: '' }), NOW)).toEqual({
      kind: 'invalid',
      reason: 'missing_secret',
    })
    expect(parseLanSyncQr(JSON.stringify({ ...payload, scheme: 'qingyu-pair' }), NOW)).toEqual({
      kind: 'invalid',
      reason: 'unknown_scheme',
    })
  })

  it('短认证串分布不塌缩到单一值', () => {
    const codes = new Set<string>()
    for (let i = 0; i < 50; i++) {
      codes.add(deriveShortAuthString(buildLanAuthTranscript({ ...sampleTranscript(), sessionId: `s-${i}` })))
    }
    expect(codes.size).toBeGreaterThan(10)
  })
})

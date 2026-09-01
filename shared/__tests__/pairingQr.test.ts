/**
 * 阶段 D-02：QR v2 载荷契约单测（构造 -> 序列化 -> 解析往返；旧格式降级）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildPairingQrV2,
  buildPairingQrLegacy,
  parsePairingQr,
} from '../pairingQr'

const NOW = 1_788_000_300_000

function sampleV2() {
  return buildPairingQrV2({
    serverId: 'b1e6f0a4-2c3d-4e5f-8a9b-0c1d2e3f4a5b',
    displayName: '我的电脑',
    apiVersion: 1,
    capabilities: ['settings_snapshot_v2', 'settings_events_v1', 'pairing_qr_v2'],
    pairingCode: 'a1b2c3d4e5f6a7b8',
    expiresAt: NOW + 5 * 60_000,
    endpoints: [{ host: '192.168.1.8', port: 8321, security: 'LOCAL_CLEARTEXT' }],
  })
}

describe('QR v2 载荷', () => {
  it('生成 -> JSON 序列化 -> 解析 往返一致', () => {
    const payload = sampleV2()
    const raw = JSON.stringify(payload)
    const parsed = parsePairingQr(raw, NOW)
    expect(parsed.kind).toBe('v2')
    if (parsed.kind !== 'v2') return
    expect(parsed.payload).toEqual(payload)
  })

  it('字段形状符合文档 §8 D-02', () => {
    const payload = sampleV2()
    expect(payload.version).toBe(2)
    expect(payload.scheme).toBe('qingyu-pair')
    expect(payload.certificatePin).toBeNull()
    expect(payload.endpoints[0]).toEqual({ host: '192.168.1.8', port: 8321, security: 'LOCAL_CLEARTEXT' })
    // 不可变副本：外部修改输入不影响产物
    const input = { ...sampleV2(), endpoints: [{ host: '10.0.0.1', port: 1, security: 'TLS' as const }] }
    const built = buildPairingQrV2(input)
    expect(built.endpoints[0].host).toBe('10.0.0.1')
  })

  it('过期 v2 被拒绝（expired）', () => {
    const payload = sampleV2()
    const expired = JSON.stringify({ ...payload, expiresAt: NOW - 1 })
    expect(parsePairingQr(expired, NOW)).toEqual({ kind: 'invalid', reason: 'expired' })
  })

  it('关键字段缺失/非法的 v2 被拒绝', () => {
    expect(parsePairingQr('not json', NOW)).toEqual({ kind: 'invalid', reason: 'not_json' })
    const payload = sampleV2()
    expect(parsePairingQr(JSON.stringify({ ...payload, scheme: 'other' }), NOW)).toEqual({ kind: 'invalid', reason: 'unknown_scheme' })
    expect(parsePairingQr(JSON.stringify({ ...payload, serverId: '' }), NOW)).toEqual({ kind: 'invalid', reason: 'missing_serverId' })
    expect(parsePairingQr(JSON.stringify({ ...payload, pairingCode: '' }), NOW)).toEqual({ kind: 'invalid', reason: 'missing_pairingCode' })
    expect(parsePairingQr(JSON.stringify({ ...payload, endpoints: [] }), NOW)).toEqual({ kind: 'invalid', reason: 'missing_endpoints' })
  })
})

describe('旧格式兼容（旧 Android payload）', () => {
  it('旧 {host,port,fingerprint} 解析为 legacy', () => {
    const legacy = buildPairingQrLegacy('192.168.1.8', 8321, 'deadbeefdeadbeef')
    const parsed = parsePairingQr(JSON.stringify(legacy), NOW)
    expect(parsed.kind).toBe('legacy')
    if (parsed.kind !== 'legacy') return
    expect(parsed.payload).toEqual({ host: '192.168.1.8', port: 8321, fingerprint: 'deadbeefdeadbeef' })
  })

  it('无法识别的 JSON 返回 invalid/unknown_format', () => {
    expect(parsePairingQr(JSON.stringify({ foo: 1 }), NOW)).toEqual({ kind: 'invalid', reason: 'unknown_format' })
  })
})

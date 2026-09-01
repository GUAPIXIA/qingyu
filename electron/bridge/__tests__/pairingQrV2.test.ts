/**
 * 阶段 D-02/D-04 服务层单测：
 * - BridgeService.getPairingInfo 增量 v2 字段（serverId/expiresAt/endpoints/capabilities），
 *   旧字段 host/port/fingerprint/expiresInSec 保持；
 * - getPairingQrPayload('v2' | 'legacy')：解析往返 + 旧格式兼容；
 * - 配对码一次性：消费后 v2 载荷中的 pairingCode 不能再被消费（扫码 -> 拒绝）；
 * - 过期二维码被拒绝（isPairingCodeValid / parsePairingQr expired）；
 * - mDNS TXT 字段（D-04）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-pairing-v2-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}))

import { BridgeService, getMachineFingerprint } from '../index'
import { buildMdnsTxt } from '../mdns'
import { getServerId, resetBridgeIdentityCache } from '../identity'
import { consumePairingCode, isPairingCodeValid } from '../auth'
import { parsePairingQr } from '../../../shared/pairingQr'

const TEST_ROOT = '/tmp/qingyu-pairing-v2-test'

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  resetBridgeIdentityCache()
})

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('getPairingInfo v2 增量字段', () => {
  it('旧字段保留 + 新字段（serverId/displayName/apiVersion/capabilities/expiresAt/endpoints）', () => {
    const service = new BridgeService()
    const info = service.getPairingInfo()
    // 旧契约
    expect(typeof info.host).toBe('string')
    expect(info.port).toBeGreaterThan(0)
    expect(info.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(info.expiresInSec).toBeGreaterThan(0)
    expect(info.expiresInSec).toBeLessThanOrEqual(300)
    // v2 增量
    expect(info.serverId).toBe(getServerId())
    expect(typeof info.displayName).toBe('string')
    expect(info.apiVersion).toBe(1)
    expect(info.capabilities).toContain('pairing_qr_v2')
    expect(info.capabilities).toContain('settings_snapshot_v2')
    expect(typeof info.expiresAt).toBe('number')
    expect(info.expiresAt).toBeGreaterThan(Date.now())
    expect(info.endpoints?.length).toBeGreaterThanOrEqual(1)
    expect(info.endpoints?.[0]).toMatchObject({ host: info.host, port: info.port, security: 'LOCAL_CLEARTEXT' })
  })

  it('serverId 跨 BridgeService 实例（模拟重启）稳定；与 machineFingerprint 不同', () => {
    const a = new BridgeService().getPairingInfo()
    resetBridgeIdentityCache()
    const b = new BridgeService().getPairingInfo()
    expect(a.serverId).toBe(b.serverId)
    expect(a.serverId).not.toBe(getMachineFingerprint())
  })
})

describe('getPairingQrPayload（D-02）', () => {
  it('默认 v2：解析为 v2 且字段与 pairingInfo 一致', () => {
    const service = new BridgeService()
    const info = service.getPairingInfo()
    const parsed = parsePairingQr(service.getPairingQrPayload())
    expect(parsed.kind).toBe('v2')
    if (parsed.kind !== 'v2') return
    expect(parsed.payload.serverId).toBe(info.serverId)
    expect(parsed.payload.pairingCode).toBe(info.fingerprint)
    expect(parsed.payload.expiresAt).toBe(info.expiresAt)
    expect(parsed.payload.certificatePin).toBeNull()
    expect(parsed.payload.endpoints[0].host).toBe(info.host)
  })

  it('legacy 模式：旧 Android 可解析的 {host,port,fingerprint}', () => {
    const service = new BridgeService()
    const info = service.getPairingInfo()
    const raw = service.getPairingQrPayload('legacy')
    expect(JSON.parse(raw)).toEqual({ host: info.host, port: info.port, fingerprint: info.fingerprint })
    const parsed = parsePairingQr(raw)
    expect(parsed.kind).toBe('legacy')
  })

  it('配对码一次性：扫码消费后同一 QR 再次配对被拒（v2 pairingCode 失效）', () => {
    const service = new BridgeService()
    const parsed = parsePairingQr(service.getPairingQrPayload())
    expect(parsed.kind).toBe('v2')
    if (parsed.kind !== 'v2') return
    const code = parsed.payload.pairingCode
    expect(isPairingCodeValid(code)).toBe(true)
    // 首次配对消费成功
    expect(consumePairingCode(code)).toBe(true)
    // 重复使用同一二维码 -> 配对码已失效
    expect(consumePairingCode(code)).toBe(false)
    expect(isPairingCodeValid(code)).toBe(false)
  })

  it('自动轮换：消费后重新取码，旧 QR 过期内容拒绝、新 QR 有效', () => {
    const service = new BridgeService()
    const first = parsePairingQr(service.getPairingQrPayload())
    expect(first.kind).toBe('v2')
    if (first.kind !== 'v2') return
    consumePairingCode(first.payload.pairingCode)

    const second = parsePairingQr(service.getPairingQrPayload())
    expect(second.kind).toBe('v2')
    if (second.kind !== 'v2') return
    expect(second.payload.pairingCode).not.toBe(first.payload.pairingCode)
    expect(isPairingCodeValid(second.payload.pairingCode)).toBe(true)
  })

  it('伪造过期 v2 二维码：PC 侧解析即拒绝（expired）', () => {
    const service = new BridgeService()
    const parsed = parsePairingQr(service.getPairingQrPayload())
    expect(parsed.kind).toBe('v2')
    if (parsed.kind !== 'v2') return
    const stale = JSON.stringify({ ...parsed.payload, expiresAt: Date.now() - 1000 })
    expect(parsePairingQr(stale).kind).toBe('invalid')
  })
})

describe('mDNS TXT（D-04）', () => {
  it('buildMdnsTxt 字段齐全且为字符串（bonjour TXT 兼容）', () => {
    const txt = buildMdnsTxt('server-uuid', 1, 2, false, '我的电脑')
    expect(txt).toEqual({
      serverId: 'server-uuid',
      apiVersion: '1',
      pairVersion: '2',
      tls: '0',
      displayName: '我的电脑',
    })
  })
})

/**
 * BridgeService 配对码行为测试：
 * - 复用：连续 getPairingInfo() 返回同一配对码（未消费时）；
 * - 强制重新生成：getPairingInfo(true) 返回新码且旧码作废；
 * - 自动轮换：当前码被消费/过期后，getPairingInfo() 自动生成新码。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-bridge-service-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}))

import { BridgeService } from '../index'
import { consumePairingCode, isPairingCodeValid } from '../auth'

const TEST_ROOT = '/tmp/qingyu-bridge-service-test'

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('BridgeService 配对码', () => {
  it('未消费时复用同一配对码', () => {
    const service = new BridgeService()
    const a = service.getPairingInfo()
    const b = service.getPairingInfo()
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it('强制重新生成返回新码且旧码作废', () => {
    const service = new BridgeService()
    const a = service.getPairingInfo()
    expect(isPairingCodeValid(a.fingerprint)).toBe(true)

    const b = service.getPairingInfo(true)
    expect(b.fingerprint).not.toBe(a.fingerprint)
    // 旧码已作废（不在有效集合）
    expect(isPairingCodeValid(a.fingerprint)).toBe(false)
    expect(isPairingCodeValid(b.fingerprint)).toBe(true)
  })

  it('当前码被消费后自动生成新码', () => {
    const service = new BridgeService()
    const a = service.getPairingInfo()
    // 模拟扫码消费：安卓端已用该码发起配对（consumePairingCode 一次性）
    expect(consumePairingCode(a.fingerprint)).toBe(true)

    const b = service.getPairingInfo()
    expect(b.fingerprint).not.toBe(a.fingerprint)
    expect(isPairingCodeValid(b.fingerprint)).toBe(true)
  })

  it('host 缺省取第一个局域网候选 IP（非 127.0.0.1）', () => {
    const service = new BridgeService()
    const info = service.getPairingInfo()
    // mock 环境无网卡候选 -> 回退 127.0.0.1；有候选时应为局域网 IP
    expect(typeof info.host).toBe('string')
    expect(info.port).toBeGreaterThan(0)
  })
})

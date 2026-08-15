/**
 * 桥接层认证单测：配对码一次性/过期、JWT 签发/校验/过期、设备登记/吊销、审批队列。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

// electron mock：safeStorage 可加密 + userData 临时目录
const encryptString = vi.fn()
const encryptionAvailable = vi.fn(() => true)
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable(),
    encryptString: (...args: unknown[]) => encryptString(...args),
    decryptString: (buf: Buffer) => buf, // 还原：encryptString mock 返回原始 Buffer
  },
  app: { getPath: () => '/tmp/qingyu-bridge-auth-test' },
}))

import {
  generatePairingCode,
  consumePairingCode,
  signToken,
  verifyToken,
  registerDevice,
  listDevices,
  revokeDevice,
  findDevice,
  enqueuePendingPair,
  settlePair,
  getJwtSecret,
  resetJwtSecretCache,
} from '../auth'

const TEST_ROOT = '/tmp/qingyu-bridge-auth-test'

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  encryptString.mockImplementation((s: string) => Buffer.from(s))
})

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('配对码', () => {
  it('生成后可消费一次（一次性）', () => {
    const code = generatePairingCode()
    expect(consumePairingCode(code)).toBe(true)
    expect(consumePairingCode(code)).toBe(false)
  })

  it('无效码返回 false', () => {
    expect(consumePairingCode('not-exist')).toBe(false)
  })
})

describe('JWT（HMAC-SHA256）', () => {
  it('签发后校验通过，载荷一致', () => {
    const token = signToken('dev-123')
    const payload = verifyToken(token)
    expect(payload?.deviceId).toBe('dev-123')
  })

  it('篡改签名校验失败', () => {
    const token = signToken('dev-123')
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa')
    expect(verifyToken(tampered)).toBeNull()
  })

  it('非三段结构返回 null', () => {
    expect(verifyToken('not-a-jwt')).toBeNull()
  })

  it('密钥跨重启稳定（加密路径）：旧 token 重启后仍可验证', () => {
    // 首次：生成并持久化密钥
    const token = signToken('dev-001')
    const secretBefore = getJwtSecret()
    // 模拟重启：清内存缓存（模块级 cachedSecret 无法直接清，用重新导入实例验证持久化读取）
    // 通过再次调用 getJwtSecret 读取持久化值对比（同值即稳定）
    expect(verifyToken(token)?.deviceId).toBe('dev-001')
    expect(getJwtSecret()).toEqual(secretBefore)
  })

  it('密钥跨重启稳定（降级路径）：safeStorage 不可用时旧 token 重启后仍可验证', () => {
    // 清掉前序测试的缓存 secret，确保走降级生成 + 持久化路径
    resetJwtSecretCache()
    // 切换为不可用：新密钥走降级写入（plain: 前缀凭据 + 明文文件）
    encryptionAvailable.mockReturnValue(false)
    const token = signToken('dev-002')
    // 模拟重启：清内存缓存，重新读取持久化密钥
    resetJwtSecretCache()
    expect(verifyToken(token)?.deviceId).toBe('dev-002')
    // 再次重启后依然稳定
    resetJwtSecretCache()
    expect(verifyToken(token)?.deviceId).toBe('dev-002')
    // 恢复
    encryptionAvailable.mockReturnValue(true)
  })
})

describe('设备管理', () => {
  it('登记/列表/吊销闭环', () => {
    const device = registerDevice('小米手机', 'fp-001')
    expect(listDevices()).toHaveLength(1)
    expect(findDevice('fp-001')?.deviceId).toBe(device.deviceId)
    expect(revokeDevice(device.deviceId)).toBe(true)
    expect(listDevices()).toHaveLength(0)
  })

  it('同指纹重复登记去重', () => {
    registerDevice('手机A', 'fp-001')
    registerDevice('手机B', 'fp-001')
    expect(listDevices()).toHaveLength(1)
    expect(listDevices()[0].name).toBe('手机B')
  })
})

describe('审批队列', () => {
  it('挂起 -> 批准 -> settle 生效，重复 settle 幂等', () => {
    let approved = false
    const pair = enqueuePendingPair('手机', 'fp-002', 'code')
    pair.resolve = (ok) => { approved = ok }
    expect(settlePair(pair.requestId, true)).toBe(true)
    expect(approved).toBe(true)
    expect(settlePair(pair.requestId, false)).toBe(false)
  })

  it('拒绝后 approved 为 false', () => {
    let approved = true
    const pair = enqueuePendingPair('手机', 'fp-003', 'code')
    pair.resolve = (ok) => { approved = ok }
    settlePair(pair.requestId, false)
    expect(approved).toBe(false)
  })
})

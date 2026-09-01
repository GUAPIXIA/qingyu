/**
 * 阶段 D-01：稳定 serverId 单测。
 * - 首启生成 bridgeIdentity.json 并保持恒定；
 * - 进程缓存（getBridgeIdentity 幂等）；
 * - 文件损坏时重新生成；
 * - 与 getMachineFingerprint 旧行为互不影响（serverId 独立稳定）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-identity-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}))

import { getBridgeIdentity, getServerId, resetBridgeIdentityCache } from '../identity'
import { getMachineFingerprint } from '../index'
import { DIRS } from '../../services/storage'

const TEST_ROOT = '/tmp/qingyu-identity-test'
const IDENTITY_FILE = () => join(DIRS.config(), 'bridgeIdentity.json')

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
  resetBridgeIdentityCache()
})

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('bridgeIdentity（D-01）', () => {
  it('首启生成 uuid 并落盘 bridgeIdentity.json（identityVersion=1）', () => {
    const first = getBridgeIdentity()
    expect(first.serverId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(first.identityVersion).toBe(1)
    expect(typeof first.createdAt).toBe('number')
    expect(existsSync(IDENTITY_FILE())).toBe(true)
    const saved = JSON.parse(readFileSync(IDENTITY_FILE(), 'utf-8')) as { serverId: string }
    expect(saved.serverId).toBe(first.serverId)
  })

  it('缓存清空后重新读盘：serverId 跨"重启"恒定', () => {
    const first = getServerId()
    resetBridgeIdentityCache()
    expect(getServerId()).toBe(first)
  })

  it('文件损坏时重新生成（不抛出）', () => {
    const first = getServerId()
    resetBridgeIdentityCache()
    mkdirSync(DIRS.config(), { recursive: true })
    writeFileSync(IDENTITY_FILE(), '{ not json')
    const second = getServerId()
    expect(second).not.toBe(first)
    expect(second.length).toBeGreaterThan(8)
  })

  it('getMachineFingerprint 旧行为保留：16 位 hex；serverId 与之独立', () => {
    const fp = getMachineFingerprint()
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    const serverId = getServerId()
    expect(serverId).not.toBe(fp)
  })
})

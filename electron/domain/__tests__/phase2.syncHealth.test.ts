import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  SyncHealthStore,
  defaultSyncHealthPath,
} from '../syncHealth'
import {
  markNeedsFullRescan,
  clearNeedsFullRescanAfterFullRescan,
  getSyncHealth,
  isSyncReady,
  setSyncDomainUserDataResolver,
  resetSyncDomainForTest,
  writeThroughDomain,
} from '../syncDomainService'
import { RepoFeatureFlags, defaultFlagsPath } from '../featureFlag'

describe('PCE-01 needsFullRescan 围栏', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'pce01-'))
    mkdirSync(join(userData, 'data', 'config'), { recursive: true })
    resetSyncDomainForTest()
  })

  afterEach(() => {
    resetSyncDomainForTest()
    rmSync(userData, { recursive: true, force: true })
  })

  it('默认健康：无 needsFullRescan，同步可用', () => {
    const store = new SyncHealthStore(defaultSyncHealthPath(userData))
    expect(store.isSyncReady()).toBe(true)
    expect(store.read().needsFullRescan).toBe(false)
  })

  it('markNeedsFullRescan 持久化标记并暂停同步', () => {
    const store = new SyncHealthStore(defaultSyncHealthPath(userData))
    store.markNeedsFullRescan('journal 写入失败：disk full')
    expect(store.read().needsFullRescan).toBe(true)
    expect(store.read().reason).toContain('disk full')
    expect(store.isSyncReady()).toBe(false)
    // 跨实例仍可见（独立文件持久化）
    const again = new SyncHealthStore(defaultSyncHealthPath(userData))
    expect(again.isSyncReady()).toBe(false)
  })

  it('损坏的 sync-health.json 视为 needsFullRescan（宁可暂停也不假装可增量）', () => {
    writeFileSync(defaultSyncHealthPath(userData), '{not json', 'utf8')
    const store = new SyncHealthStore(defaultSyncHealthPath(userData))
    expect(store.read().needsFullRescan).toBe(true)
    expect(store.isSyncReady()).toBe(false)
  })

  it('clearAfterFullRescan 仅在全量重建后清除标记', () => {
    const store = new SyncHealthStore(defaultSyncHealthPath(userData))
    store.markNeedsFullRescan('x')
    store.clearAfterFullRescan()
    expect(store.isSyncReady()).toBe(true)
  })

  it('journal 不可用且曾启用同步 → 自动标记 needsFullRescan，本地写仍成功', () => {
    // flags 开启，但故意用目录占位 sync-meta.db 使 DatabaseSync 打开失败
    const flags = new RepoFeatureFlags(defaultFlagsPath(userData))
    flags.set('persona', true)

    const metaPath = join(userData, 'data', 'config', 'sync-meta.db')
    mkdirSync(metaPath, { recursive: true })

    // 走惰性初始化（syncDomainOrNull），ensure 失败时捕获并标记 needsFullRescan
    setSyncDomainUserDataResolver(() => userData)
    const out = writeThroughDomain({
      domain: 'persona',
      entityType: 'persona',
      entityId: 'p1',
      payload: { name: '测试' },
      files: [{ path: join(userData, 'data', 'config', 'personas.json'), content: '[]' }],
    })

    // 业务文件必须落地（本地工作继续）
    expect(existsSync(join(userData, 'data', 'config', 'personas.json'))).toBe(true)
    // 但不得假装可同步
    expect(out.journaled).toBe(false)
    expect(isSyncReady(userData)).toBe(false)
    expect(getSyncHealth(userData).needsFullRescan).toBe(true)
    expect(getSyncHealth(userData).reason).toBeTruthy()
  })

  it('markNeedsFullRescan / clear 的模块级 API 与 store 同源', () => {
    markNeedsFullRescan('module-level', userData)
    expect(isSyncReady(userData)).toBe(false)
    clearNeedsFullRescanAfterFullRescan(userData)
    expect(isSyncReady(userData)).toBe(true)
  })
})

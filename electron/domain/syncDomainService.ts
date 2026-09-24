import { appendFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { DeviceIdentityStore, defaultIdentityPath } from './deviceIdentity'
import { SyncMetaDb } from './syncMeta'
import { PcDomainRepository, defaultSyncMetaPath, writeFileAtomic } from './pcRepository'
import { RepoFeatureFlags, defaultFlagsPath, type DomainFlagKey } from './featureFlag'
import { recoverIncompleteFileTransactions } from './recovery'
import { applyRemoteBatch } from './remoteApply'
import { collectSyncDiagnostics } from './metrics'
import { runBootstrap } from './bootstrap'
import { SyncHealthStore, defaultSyncHealthPath, type SyncHealthState } from './syncHealth'
import type { SyncEnvelope } from '../../shared/contracts/sync-envelope'
import type { SyncDomainContext, DomainWriteFile } from './types'

export type { DomainFlagKey }
export type { SyncDomainContext, DomainWriteFile }
export type { SyncHealthState }

let ctx: SyncDomainContext | null = null
let userDataResolver: (() => string) | null = null
let healthStore: SyncHealthStore | null = null

function health(userDataDir?: string): SyncHealthStore {
  if (healthStore && !userDataDir) return healthStore
  const dir = userDataDir ?? userDataResolver?.() ?? ''
  healthStore = new SyncHealthStore(defaultSyncHealthPath(dir))
  return healthStore
}

/**
 * PCE-01：同步健康状态。`needsFullRescan` 为 true 时必须暂停同步
 * （不得推进 cursor、不得显示可同步），本地写入仍可继续。
 */
export function getSyncHealth(userDataDir?: string): SyncHealthState {
  return health(userDataDir).read()
}

export function isSyncReady(userDataDir?: string): boolean {
  return health(userDataDir).isSyncReady()
}

/** journal 不可用 / 同步元数据损坏时调用：持久化恢复标记并暂停同步 */
export function markNeedsFullRescan(reason: string, userDataDir?: string): void {
  health(userDataDir).markNeedsFullRescan(reason)
}

/** 全量 bootstrap 重建 heads 成功后调用 */
export function clearNeedsFullRescanAfterFullRescan(userDataDir?: string): void {
  health(userDataDir).clearAfterFullRescan()
}

/**
 * 主进程启动时注册 userData 解析器，使所有域写入入口可以惰性初始化同步域，
 * 调用点无需自行 ensureSyncDomain，也无需保留「直写回退」分支（避免绕过 journal）。
 */
export function setSyncDomainUserDataResolver(resolver: () => string): void {
  userDataResolver = resolver
}

/**
 * 惰性获取同步域；未注册解析器或初始化失败时返回 null（退化为直接落盘）。
 * PCE-01：若 flags 显示曾启用同步但 journal 不可用，必须标记 needsFullRescan，
 * 禁止静默回退成「继续直写且仍显示可同步」。
 */
function syncDomainOrNull(): SyncDomainContext | null {
  if (ctx) return ctx
  if (!userDataResolver) return null
  const userDataDir = userDataResolver()
  try {
    return ensureSyncDomain(userDataDir)
  } catch (err) {
    try {
      const flags = new RepoFeatureFlags(defaultFlagsPath(userDataDir))
      if (flags.enabledDomains().length > 0) {
        markNeedsFullRescan(`journal 初始化失败：${String(err)}`, userDataDir)
      }
    } catch {
      markNeedsFullRescan(`journal 初始化失败且 flags 不可读：${String(err)}`, userDataDir)
    }
    return null
  }
}

/** 集成测试/非 Electron 环境注入 userData 根目录 */
export function setSyncDomainUserDataDirForTest(userDataDir: string): void {
  ctx = null
  healthStore = null
  userDataResolver = () => userDataDir
  ensureSyncDomain(userDataDir)
}

export function ensureSyncDomain(userDataDir: string): SyncDomainContext {
  if (ctx) return ctx
  const identity = new DeviceIdentityStore(defaultIdentityPath(userDataDir))
  identity.loadOrCreate()
  const meta = new SyncMetaDb(defaultSyncMetaPath(userDataDir))
  const repo = new PcDomainRepository({ meta, identity, userDataDir })
  const flags = new RepoFeatureFlags(defaultFlagsPath(userDataDir))
  ctx = { repo, flags, meta, identity, userDataDir }
  // 启动恢复未完成 file_transactions（按磁盘 hash 前滚/回滚）
  recoverIncompleteFileTransactions(meta, userDataDir)
  return ctx
}

export function getSyncDomain(): SyncDomainContext {
  if (!ctx) {
    throw new Error('SyncDomain 未初始化（需先 ensureSyncDomain）')
  }
  return ctx
}

export function resetSyncDomainForTest(): void {
  try {
    ctx?.meta.close()
  } catch {
    /* ignore */
  }
  ctx = null
  healthStore = null
  userDataResolver = null
}

export function isDomainEnabled(domain: DomainFlagKey): boolean {
  try {
    return getSyncDomain().flags.isEnabled(domain)
  } catch {
    return false
  }
}

/** flag 关闭时按旧行为直接落盘（同目录 tmp + rename，保持原子性） */
function applyFilesDirectly(files: DomainWriteFile[]): void {
  for (const file of files) {
    if (file.content === null) {
      if (existsSync(file.path)) unlinkSync(file.path)
      continue
    }
    if (file.append) {
      mkdirSync(dirname(file.path), { recursive: true })
      appendFileSync(file.path, file.content, 'utf8')
      continue
    }
    writeFileAtomic(file.path, file.content)
  }
}

export interface DomainPutInput {
  domain: DomainFlagKey
  entityType: SyncEnvelope['entityType']
  entityId: string
  payload: Record<string, unknown>
  parentId?: string | null
  schemaVersion?: number
  references?: string[]
  aggregate?: { type: string; id: string; revision?: string }
  /** 事务内要落盘的业务文件；调用方负责在锁内完成读-改-写 */
  files: DomainWriteFile[]
}

export interface DomainWriteOutcome {
  journaled: boolean
  changeSeq: number | null
}

/**
 * 唯一的域写入入口（S2-04）：
 * - domain flag 开启：文件 + journal 在同一持久化事务中提交
 * - flag 关闭：保持旧行为，直接落盘且不写 journal
 * PCE-01：flag 开启但 journal 写失败时，先持久化 needsFullRescan 再落业务文件，
 * 并暂停同步（调用方通过 isSyncReady 感知），禁止静默假装可同步。
 */
export function writeThroughDomain(input: DomainPutInput): DomainWriteOutcome {
  const domain = syncDomainOrNull()
  if (!domain) {
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeq: null }
  }
  const { repo, flags } = domain
  if (!flags.isEnabled(input.domain)) {
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeq: null }
  }
  try {
    const result = repo.putWithJournal({
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
      schemaVersion: input.schemaVersion,
      parentId: input.parentId ?? null,
      references: input.references,
      aggregate: input.aggregate,
      files: input.files,
    })
    return { journaled: true, changeSeq: result.changeSeq }
  } catch (err) {
    markNeedsFullRescan(`journal 写入失败：${String(err)}`, domain.userDataDir)
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeq: null }
  }
}

export interface DomainDeleteInput {
  domain: DomainFlagKey
  entityType: SyncEnvelope['entityType']
  entityId: string
  parentId?: string | null
  aggregate?: { type: string; id: string; revision?: string }
  files: DomainWriteFile[]
}

export function deleteThroughDomain(input: DomainDeleteInput): DomainWriteOutcome {
  const domain = syncDomainOrNull()
  if (!domain) {
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeq: null }
  }
  const { repo, flags } = domain
  if (!flags.isEnabled(input.domain)) {
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeq: null }
  }
  try {
    const result = repo.tombstoneWithJournal({
      entityType: input.entityType,
      entityId: input.entityId,
      parentId: input.parentId ?? null,
      aggregate: input.aggregate,
      files: input.files,
    })
    return { journaled: true, changeSeq: result.changeSeq }
  } catch (err) {
    markNeedsFullRescan(`journal 删除失败：${String(err)}`, domain.userDataDir)
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeq: null }
  }
}

/**
 * 备份恢复/迁移后同步状态不再可信：清空 journal/heads 并要求重新 bootstrap。
 * 方案 §6.4：恢复备份产生新设备身份，不复用备份中的设备计数器。
 */
export function resetSyncStateForRestore(reason: string, userDataDir: string): void {
  const domain = ensureSyncDomain(userDataDir)
  domain.meta.clearSyncState()
  domain.identity.resetForClone()
  markNeedsFullRescan(`备份恢复/迁移：${reason}`, userDataDir)
}

/** S2-05：按当前 flag 决定是否执行 bootstrap；幂等。成功全量重建后清除 needsFullRescan */
export function runBootstrapIfEnabled(userDataDir: string): ReturnType<typeof runBootstrap> | null {
  const domain = ensureSyncDomain(userDataDir)
  const enabledDomains = domain.flags.enabledDomains()
  if (enabledDomains.length === 0) return null
  const result = runBootstrap(domain, enabledDomains)
  // needsFullRescan 时禁止用旧 cursor 增量；bootstrap 是全量重建 heads 的唯一出口
  if (result && !result.alreadyBootstrapped) {
    clearNeedsFullRescanAfterFullRescan(userDataDir)
  } else if (result?.alreadyBootstrapped && getSyncHealth(userDataDir).needsFullRescan) {
    // 已有 bootstrap 记录但仍标记需全量重扫：强制重新扫 heads
    domain.meta.clearSyncState()
    const rebuilt = runBootstrap(domain, enabledDomains)
    clearNeedsFullRescanAfterFullRescan(userDataDir)
    return rebuilt
  }
  return result
}

export interface DomainCommitInput {
  domain: DomainFlagKey
  entityType: SyncEnvelope['entityType']
  puts: Array<{
    entityId: string
    payload: Record<string, unknown>
    parentId?: string | null
    schemaVersion?: number
    references?: string[]
    aggregate?: { type: string; id: string; revision?: string }
  }>
  deletes: Array<{ entityId: string; parentId?: string | null }>
  files: DomainWriteFile[]
}

/**
 * 多实体单文件写入的统一入口（会话数组 / JSONL 消息文件）：
 * puts 与 deletes 共用一个文件事务，原子提交全部 head 与 journal。
 * flag 关闭时只落盘，保持旧行为。
 */
export function commitThroughDomain(input: DomainCommitInput): DomainManyWriteOutcome {
  const domain = syncDomainOrNull()
  if (!domain) {
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeqs: [] }
  }
  const { repo, flags } = domain
  if (!flags.isEnabled(input.domain)) {
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeqs: [] }
  }
  if (input.puts.length === 0 && input.deletes.length === 0) {
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeqs: [] }
  }
  try {
    const result = repo.commitWithJournal({
      entityType: input.entityType,
      puts: input.puts,
      deletes: input.deletes,
      files: input.files,
    })
    return { journaled: true, changeSeqs: result.changeSeqs }
  } catch (err) {
    markNeedsFullRescan(`journal 批量提交失败：${String(err)}`, domain.userDataDir)
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeqs: [] }
  }
}

export interface DomainManyPutInput {
  domain: DomainFlagKey
  entityType: SyncEnvelope['entityType']
  entries: Array<{
    entityId: string
    payload: Record<string, unknown>
    parentId?: string | null
    schemaVersion?: number
    references?: string[]
    aggregate?: { type: string; id: string; revision?: string }
  }>
  files: DomainWriteFile[]
}

export interface DomainManyDeleteInput {
  domain: DomainFlagKey
  entityType: SyncEnvelope['entityType']
  entityIds: string[]
  parentId?: string | null
  files: DomainWriteFile[]
}

export interface DomainManyWriteOutcome {
  journaled: boolean
  changeSeqs: number[]
}

/**
 * 多实体单文件写入（会话数组、JSONL 消息文件）：
 * 一个文件事务原子提交全部实体 head 与 journal，避免整文件重写产生半提交。
 */
export function writeManyThroughDomain(input: DomainManyPutInput): DomainManyWriteOutcome {
  const domain = syncDomainOrNull()
  if (!domain) {
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeqs: [] }
  }
  const { repo, flags } = domain
  if (!flags.isEnabled(input.domain)) {
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeqs: [] }
  }
  try {
    const result = repo.putManyWithJournal({
      entityType: input.entityType,
      entries: input.entries,
      files: input.files,
    })
    return { journaled: true, changeSeqs: result.changeSeqs }
  } catch (err) {
    markNeedsFullRescan(`journal 多实体写入失败：${String(err)}`, domain.userDataDir)
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeqs: [] }
  }
}

export function deleteManyThroughDomain(input: DomainManyDeleteInput): DomainManyWriteOutcome {
  const domain = syncDomainOrNull()
  if (!domain) {
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeqs: [] }
  }
  const { repo, flags } = domain
  if (!flags.isEnabled(input.domain)) {
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeqs: [] }
  }
  try {
    const result = repo.tombstoneManyWithJournal({
      entityType: input.entityType,
      entityIds: input.entityIds,
      parentId: input.parentId ?? null,
      files: input.files,
    })
    return { journaled: true, changeSeqs: result.changeSeqs }
  } catch (err) {
    markNeedsFullRescan(`journal 批量删除失败：${String(err)}`, domain.userDataDir)
    applyFilesDirectly(input.files)
    return { journaled: false, changeSeqs: [] }
  }
}

export { applyRemoteBatch, collectSyncDiagnostics, recoverIncompleteFileTransactions }

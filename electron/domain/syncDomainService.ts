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
import type { SyncEnvelope } from '../../shared/contracts/sync-envelope'
import type { SyncDomainContext, DomainWriteFile } from './types'

export type { DomainFlagKey }
export type { SyncDomainContext, DomainWriteFile }

let ctx: SyncDomainContext | null = null
let userDataResolver: (() => string) | null = null

/**
 * 主进程启动时注册 userData 解析器，使所有域写入入口可以惰性初始化同步域，
 * 调用点无需自行 ensureSyncDomain，也无需保留「直写回退」分支（避免绕过 journal）。
 */
export function setSyncDomainUserDataResolver(resolver: () => string): void {
  userDataResolver = resolver
}

/** 惰性获取同步域；未注册解析器或初始化失败时返回 null（退化为直接落盘） */
function syncDomainOrNull(): SyncDomainContext | null {
  if (ctx) return ctx
  if (!userDataResolver) return null
  try {
    return ensureSyncDomain(userDataResolver())
  } catch {
    return null
  }
}

/** 集成测试/非 Electron 环境注入 userData 根目录 */
export function setSyncDomainUserDataDirForTest(userDataDir: string): void {
  ctx = null
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
  const result = repo.tombstoneWithJournal({
    entityType: input.entityType,
    entityId: input.entityId,
    parentId: input.parentId ?? null,
    aggregate: input.aggregate,
    files: input.files,
  })
  return { journaled: true, changeSeq: result.changeSeq }
}

/**
 * 备份恢复/迁移后同步状态不再可信：清空 journal/heads 并要求重新 bootstrap。
 * 方案 §6.4：恢复备份产生新设备身份，不复用备份中的设备计数器。
 */
export function resetSyncStateForRestore(reason: string, userDataDir: string): void {
  const domain = ensureSyncDomain(userDataDir)
  domain.meta.clearSyncState()
  domain.identity.resetForClone()
}

/** S2-05：按当前 flag 决定是否执行 bootstrap；幂等 */
export function runBootstrapIfEnabled(userDataDir: string): ReturnType<typeof runBootstrap> | null {
  const domain = ensureSyncDomain(userDataDir)
  const enabledDomains = domain.flags.enabledDomains()
  if (enabledDomains.length === 0) return null
  return runBootstrap(domain, enabledDomains)
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
  const result = repo.commitWithJournal({
    entityType: input.entityType,
    puts: input.puts,
    deletes: input.deletes,
    files: input.files,
  })
  return { journaled: true, changeSeqs: result.changeSeqs }
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
  const result = repo.putManyWithJournal({
    entityType: input.entityType,
    entries: input.entries,
    files: input.files,
  })
  return { journaled: true, changeSeqs: result.changeSeqs }
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
  const result = repo.tombstoneManyWithJournal({
    entityType: input.entityType,
    entityIds: input.entityIds,
    parentId: input.parentId ?? null,
    files: input.files,
  })
  return { journaled: true, changeSeqs: result.changeSeqs }
}

export { applyRemoteBatch, collectSyncDiagnostics, recoverIncompleteFileTransactions }

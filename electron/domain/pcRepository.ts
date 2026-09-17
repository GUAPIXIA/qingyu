import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mergeVectors, emptyVector, type VersionVector } from '../../shared/contracts/version-vector'
import type { SyncEnvelope, SyncEntityType } from '../../shared/contracts/sync-envelope'
import { contentHash, type CanonicalJsonValue } from '../../shared/contracts/canonical-json'
import type { DeviceIdentityStore } from './deviceIdentity'
import type { SyncMetaDb } from './syncMeta'
import { runFileTransaction, type StagedFileWrite } from './fileTransaction'
import { safeId } from '../utils/pathGuard'

export interface PcDomainRepositoryOptions {
  meta: SyncMetaDb
  identity: DeviceIdentityStore
  userDataDir: string
}

export interface WriteResult {
  envelope: SyncEnvelope
  changeSeq: number
}

/** 一次业务写要落盘的文件集合；content 为 null 表示删除 */
export interface DomainFileWrite {
  path: string
  content: string | null
}

export interface PutInput {
  entityType: SyncEntityType
  entityId: string
  payload: Record<string, unknown>
  schemaVersion?: number
  parentId?: string | null
  references?: string[]
  aggregate?: { type: string; id: string; revision?: string }
  /** 事务内要落盘的业务文件（必填：事务必须真的包住文件写，S2-03） */
  files: DomainFileWrite[]
}

/** 原子写文件：同目录 tmp + rename，避免崩溃产生半截文件 */
export function writeFileAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, filePath)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw err
  }
}

/** 原子写 JSON */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2))
}

/**
 * PC 侧 Repository：文件业务数据 + sync-meta journal。
 * put/tombstone：分配 counter → staging（旧/新 hash）→ 原子替换 → head + change_log。
 */
export class PcDomainRepository {
  private readonly meta: SyncMetaDb
  private readonly identity: DeviceIdentityStore
  private readonly userDataDir: string

  constructor(opts: PcDomainRepositoryOptions) {
    this.meta = opts.meta
    this.identity = opts.identity
    this.userDataDir = opts.userDataDir
  }

  deviceId(): string {
    return this.identity.peek().deviceId
  }

  identityStore(): DeviceIdentityStore {
    return this.identity
  }

  metaStore(): SyncMetaDb {
    return this.meta
  }

  rootDir(): string {
    return this.userDataDir
  }

  /** settings 等单文件域路径 */
  configPath(file: string): string {
    return join(this.userDataDir, 'data', 'config', file)
  }

  dataPath(...segments: string[]): string {
    return join(this.userDataDir, 'data', ...segments)
  }

  /**
   * 本地业务写：真实跨存储事务（文件 + journal）。
   */
  putWithJournal(input: PutInput): WriteResult {
    safeId(input.entityId)
    const txId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

    const prevHead = this.meta.getHead(input.entityType, input.entityId)
    const previousVersion: VersionVector = prevHead
      ? (JSON.parse(prevHead.versionJson) as VersionVector)
      : emptyVector()
    const { counter } = this.identity.allocateCounter()
    const deviceId = this.deviceId()
    const version = mergeVectors(previousVersion, { [deviceId]: counter })

    const envelope: SyncEnvelope = {
      contractVersion: 1,
      entityType: input.entityType,
      entityId: input.entityId,
      parentId: input.parentId ?? null,
      schemaVersion: input.schemaVersion ?? 1,
      version,
      dot: { deviceId, counter },
      deleted: false,
      updatedAt: Date.now(),
      contentHash: contentHash(input.payload as unknown as CanonicalJsonValue),
      payload: input.payload as unknown as CanonicalJsonValue,
    }
    if (input.aggregate) {
      envelope.aggregateType = input.aggregate.type
      envelope.aggregateId = input.aggregate.id
      if (input.aggregate.revision) envelope.aggregateRevision = input.aggregate.revision
    }
    if (input.references?.length) envelope.references = [...input.references]

    let changeSeq = -1
    runFileTransaction({
      meta: this.meta,
      userDataDir: this.userDataDir,
      id: txId,
      kind: 'put',
      envelopes: [envelope],
      writes: toStagedWrites(input.files),
      commitJournal: () => {
        this.meta.upsertHead({
          entityType: envelope.entityType,
          entityId: envelope.entityId,
          versionJson: JSON.stringify(envelope.version),
          hash: envelope.contentHash,
          deleted: 0,
          payloadRef: null,
        })
        changeSeq = this.meta.appendChange({
          dotDevice: envelope.dot.deviceId,
          dotCounter: envelope.dot.counter,
          entityType: envelope.entityType,
          entityId: envelope.entityId,
          envelope,
          origin: 'local',
        })
      },
    })

    return { envelope, changeSeq }
  }

  tombstoneWithJournal(input: {
    entityType: SyncEntityType
    entityId: string
    parentId?: string | null
    aggregate?: { type: string; id: string; revision?: string }
    files: DomainFileWrite[]
  }): WriteResult {
    safeId(input.entityId)
    const txId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

    const prevHead = this.meta.getHead(input.entityType, input.entityId)
    const previousVersion: VersionVector = prevHead
      ? (JSON.parse(prevHead.versionJson) as VersionVector)
      : emptyVector()
    const { counter } = this.identity.allocateCounter()
    const deviceId = this.deviceId()
    const version = mergeVectors(previousVersion, { [deviceId]: counter })

    const envelope: SyncEnvelope = {
      contractVersion: 1,
      entityType: input.entityType,
      entityId: input.entityId,
      parentId: input.parentId ?? null,
      schemaVersion: 1,
      version,
      dot: { deviceId, counter },
      deleted: true,
      updatedAt: Date.now(),
      contentHash: contentHash({}),
      payload: {},
    }
    if (input.aggregate) {
      envelope.aggregateType = input.aggregate.type
      envelope.aggregateId = input.aggregate.id
      if (input.aggregate.revision) envelope.aggregateRevision = input.aggregate.revision
    }

    let changeSeq = -1
    runFileTransaction({
      meta: this.meta,
      userDataDir: this.userDataDir,
      id: txId,
      kind: 'tombstone',
      envelopes: [envelope],
      writes: toStagedWrites(input.files),
      commitJournal: () => {
        this.meta.upsertHead({
          entityType: envelope.entityType,
          entityId: envelope.entityId,
          versionJson: JSON.stringify(version),
          hash: envelope.contentHash,
          deleted: 1,
          payloadRef: null,
        })
        changeSeq = this.meta.appendChange({
          dotDevice: deviceId,
          dotCounter: counter,
          entityType: envelope.entityType,
          entityId: envelope.entityId,
          envelope,
          origin: 'local',
        })
      },
    })

    return { envelope, changeSeq }
  }

  /**
   * 一次文件写同时提交多个实体（会话数组、JSONL 消息文件等多实体容器）。
   * 所有 head 与 change_log 行在同一事务内提交，避免整文件重写产生半提交。
   */
  putManyWithJournal(input: {
    entityType: SyncEntityType
    entries: Array<{
      entityId: string
      payload: Record<string, unknown>
      parentId?: string | null
      schemaVersion?: number
      references?: string[]
      aggregate?: { type: string; id: string; revision?: string }
    }>
    files: DomainFileWrite[]
  }): { envelopes: SyncEnvelope[]; changeSeqs: number[] } {
    return this.commitWithJournal({
      entityType: input.entityType,
      puts: input.entries,
      deletes: [],
      files: input.files,
    })
  }

  /** 批量 tombstone：同一文件写中删除多个实体 */
  tombstoneManyWithJournal(input: {
    entityType: SyncEntityType
    entityIds: string[]
    parentId?: string | null
    files: DomainFileWrite[]
  }): { envelopes: SyncEnvelope[]; changeSeqs: number[] } {
    return this.commitWithJournal({
      entityType: input.entityType,
      puts: [],
      deletes: input.entityIds.map((entityId) => ({ entityId, parentId: input.parentId ?? null })),
      files: input.files,
    })
  }

  /**
   * 一次文件写同时提交多个实体（会话数组、JSONL 消息文件等多实体容器）：
   * puts（新增/修改）与 deletes（tombstone）共用同一文件事务，
   * 所有 head 与 change_log 行原子提交，避免整文件重写产生半提交。
   */
  commitWithJournal(input: {
    entityType: SyncEntityType
    puts: Array<{
      entityId: string
      payload: Record<string, unknown>
      parentId?: string | null
      schemaVersion?: number
      references?: string[]
      aggregate?: { type: string; id: string; revision?: string }
    }>
    deletes: Array<{ entityId: string; parentId?: string | null }>
    files: DomainFileWrite[]
  }): { envelopes: SyncEnvelope[]; changeSeqs: number[] } {
    const txId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const deviceId = this.deviceId()
    const envelopes: SyncEnvelope[] = []
    const changeSeqs: number[] = []

    const specs: Array<{
      entityId: string
      payload: Record<string, unknown>
      parentId?: string | null
      schemaVersion?: number
      references?: string[]
      aggregate?: { type: string; id: string; revision?: string }
      deleted: boolean
    }> = [
      ...input.puts.map((p) => ({ ...p, deleted: false })),
      ...input.deletes.map((d) => ({
        entityId: d.entityId,
        payload: {} as Record<string, unknown>,
        parentId: d.parentId ?? null,
        deleted: true,
      })),
    ]

    for (const spec of specs) {
      safeId(spec.entityId)
      const prevHead = this.meta.getHead(input.entityType, spec.entityId)
      const previousVersion: VersionVector = prevHead
        ? (JSON.parse(prevHead.versionJson) as VersionVector)
        : emptyVector()
      const { counter } = this.identity.allocateCounter()
      const version = mergeVectors(previousVersion, { [deviceId]: counter })
      const payload = spec.deleted ? {} : spec.payload
      const envelope: SyncEnvelope = {
        contractVersion: 1,
        entityType: input.entityType,
        entityId: spec.entityId,
        parentId: spec.parentId ?? null,
        schemaVersion: spec.schemaVersion ?? 1,
        version,
        dot: { deviceId, counter },
        deleted: spec.deleted,
        updatedAt: Date.now(),
        contentHash: contentHash(payload as unknown as CanonicalJsonValue),
        payload: payload as unknown as CanonicalJsonValue,
      }
      const aggregate = spec.aggregate
      if (aggregate) {
        envelope.aggregateType = aggregate.type
        envelope.aggregateId = aggregate.id
        if (aggregate.revision) envelope.aggregateRevision = aggregate.revision
      }
      if (spec.references?.length) envelope.references = [...spec.references]
      envelopes.push(envelope)
    }

    runFileTransaction({
      meta: this.meta,
      userDataDir: this.userDataDir,
      id: txId,
      kind: input.puts.length > 0 ? 'put' : 'tombstone',
      envelopes,
      writes: toStagedWrites(input.files),
      commitJournal: () => {
        for (const envelope of envelopes) {
          this.meta.upsertHead({
            entityType: envelope.entityType,
            entityId: envelope.entityId,
            versionJson: JSON.stringify(envelope.version),
            hash: envelope.contentHash,
            deleted: envelope.deleted ? 1 : 0,
            payloadRef: null,
          })
          changeSeqs.push(
            this.meta.appendChange({
              dotDevice: envelope.dot.deviceId,
              dotCounter: envelope.dot.counter,
              entityType: envelope.entityType,
              entityId: envelope.entityId,
              envelope,
              origin: 'local',
            }),
          )
        }
      },
    })

    return { envelopes, changeSeqs }
  }

  /**
   * 应用远端批次（S2-06）：保留远端信封自带的 version/dot（不分配本机 counter），
   * 文件写与 head/journal 在同一事务内提交，change_log 记为 origin='remote'，
   * 因此不会形成回传同一来源的本地待上传变更。
   */
  applyRemoteEnvelopes(input: { envelopes: SyncEnvelope[]; files: DomainFileWrite[] }): {
    changeSeqs: number[]
    txId: string
  } {
    const txId = `tx-remote-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const changeSeqs: number[] = []
    if (input.envelopes.length === 0 && input.files.length === 0) {
      return { changeSeqs, txId }
    }
    runFileTransaction({
      meta: this.meta,
      userDataDir: this.userDataDir,
      id: txId,
      kind: input.envelopes.some((e) => e.deleted) ? 'tombstone' : 'put',
      envelopes: input.envelopes,
      writes: toStagedWrites(input.files),
      commitJournal: () => {
        for (const envelope of input.envelopes) {
          this.meta.upsertHead({
            entityType: envelope.entityType,
            entityId: envelope.entityId,
            versionJson: JSON.stringify(envelope.version),
            hash: envelope.contentHash,
            deleted: envelope.deleted ? 1 : 0,
            payloadRef: null,
          })
          changeSeqs.push(
            this.meta.appendChange({
              dotDevice: envelope.dot.deviceId,
              dotCounter: envelope.dot.counter,
              entityType: envelope.entityType,
              entityId: envelope.entityId,
              envelope,
              origin: 'remote',
            }),
          )
        }
      },
    })
    return { changeSeqs, txId }
  }

  changesAfter(cursor: number, limit: number) {
    return this.meta.changesAfter(cursor, limit)
  }

  readJsonFile<T>(filePath: string): T | null {
    if (!existsSync(filePath)) return null
    try {
      return JSON.parse(readFileSync(filePath, 'utf8')) as T
    } catch {
      return null
    }
  }

  writeJsonAtomic(filePath: string, data: unknown): void {
    writeJsonAtomic(filePath, data)
  }
}

function toStagedWrites(files: DomainFileWrite[]): StagedFileWrite[] {
  return files.map((f) => ({ path: f.path, content: f.content }))
}

export function defaultSyncMetaPath(userDataDir: string): string {
  return join(userDataDir, 'data', 'config', 'sync-meta.db')
}

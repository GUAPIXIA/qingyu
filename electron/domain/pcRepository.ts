import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeVectors, emptyVector, type VersionVector } from '../../shared/contracts/version-vector'
import type { SyncEnvelope, SyncEntityType } from '../../shared/contracts/sync-envelope'
import { contentHash, type CanonicalJsonValue } from '../../shared/contracts/canonical-json'
import { DeviceIdentityStore } from './deviceIdentity'
import type { SyncMetaDb } from './syncMeta'
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

/**
 * PC 侧 Repository：文件业务数据 + sync-meta journal。
 * 每次本地 put/tombstone：分配 counter → 写文件（原子）→ upsert head + append journal。
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

  /** settings 等单文件域路径 */
  configPath(file: string): string {
    return join(this.userDataDir, 'data', 'config', file)
  }

  /**
   * 本地业务写：文件 + journal。
   * @param writeFile 返回后写入的业务文件路径与内容；失败则不写 journal。
   */
  putWithJournal(input: {
    entityType: SyncEntityType
    entityId: string
    payload: Record<string, unknown>
    schemaVersion?: number
    parentId?: string | null
    references?: string[]
    writeBusiness: (ctx: { envelope: SyncEnvelope }) => void
  }): WriteResult {
    safeId(input.entityId)
    const txId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    this.meta.prepareFileTransaction({
      id: txId,
      operationsJson: JSON.stringify([{ kind: 'put', entityType: input.entityType, entityId: input.entityId }]),
      oldHashesJson: JSON.stringify({}),
      newHashesJson: JSON.stringify({}),
    })

    try {
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
        ...(input.references?.length ? { references: [...input.references] } : {}),
      }

      input.writeBusiness({ envelope })
      this.meta.markFileTransaction(txId, 'FILES_APPLIED')

      this.meta.upsertHead({
        entityType: envelope.entityType,
        entityId: envelope.entityId,
        versionJson: JSON.stringify(envelope.version),
        hash: envelope.contentHash,
        deleted: 0,
        payloadRef: null,
      })
      const seq = this.meta.appendChange({
        dotDevice: envelope.dot.deviceId,
        dotCounter: envelope.dot.counter,
        entityType: envelope.entityType,
        entityId: envelope.entityId,
        envelope,
        origin: 'local',
      })
      this.meta.markFileTransaction(txId, 'JOURNAL_COMMITTED')
      return { envelope, changeSeq: seq }
    } catch (err) {
      this.meta.markFileTransaction(txId, 'ABORTED')
      throw err
    }
  }

  tombstoneWithJournal(input: {
    entityType: SyncEntityType
    entityId: string
    deleteBusiness: () => void
  }): WriteResult {
    safeId(input.entityId)
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
      parentId: null,
      schemaVersion: 1,
      version,
      dot: { deviceId, counter },
      deleted: true,
      updatedAt: Date.now(),
      contentHash: contentHash({}),
      payload: {},
    }
    input.deleteBusiness()
    this.meta.upsertHead({
      entityType: envelope.entityType,
      entityId: envelope.entityId,
      versionJson: JSON.stringify(version),
      hash: envelope.contentHash,
      deleted: 1,
      payloadRef: null,
    })
    const seq = this.meta.appendChange({
      dotDevice: deviceId,
      dotCounter: counter,
      entityType: envelope.entityType,
      entityId: envelope.entityId,
      envelope,
      origin: 'local',
    })
    return { envelope, changeSeq: seq }
  }

  changesAfter(cursor: number, limit: number) {
    return this.meta.changesAfter(cursor, limit)
  }

  writeJsonAtomic(filePath: string, data: unknown): void {
    const tmp = filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    // 对齐 storage.writeJson 的 rename 语义（Windows 用覆盖写简化，生产可换 renameSync）
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }

  readJsonFile<T>(filePath: string): T | null {
    if (!existsSync(filePath)) return null
    try {
      return JSON.parse(readFileSync(filePath, 'utf8')) as T
    } catch {
      return null
    }
  }

  hashObject(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
  }
}

export function defaultSyncMetaPath(userDataDir: string): string {
  return join(userDataDir, 'data', 'config', 'sync-meta.db')
}

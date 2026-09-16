import type { SyncEnvelope, SyncEntityType } from '../contracts/sync-envelope'

export interface ListFilter {
  entityType?: SyncEntityType
  includeTombstones?: boolean
  parentId?: string
  limit?: number
  offset?: number
}

export interface PageResult<T> {
  items: T[]
  total: number
}

export interface JournalEntry {
  seq: number
  entityType: SyncEntityType
  entityId: string
  envelope: SyncEnvelope
  recordedAt: number
}

export interface PreparedReceipt {
  sessionId: string
  batchHash: string
  preparedAt: number
  /** staging 内将提交的实体数 */
  stagedCount: number
  /** 引用检查结果 */
  dependencyCheck: 'ok' | 'blocked'
}

export type PreparedSessionState = 'none' | 'prepared' | 'committed' | 'aborted'

export interface ApplyRemoteResult {
  applied: number
  conflicts: Array<{ entityId: string; entityType: string }>
  rejected: number
}

export type DependencyRejectionCode =
  | 'DEPENDENCY_CONFLICT'
  | 'HASH_MISMATCH'
  | 'SCHEMA_UNSUPPORTED'
  | 'INVALID_ENVELOPE'

export interface RejectedApply {
  entityId: string
  entityType: string
  code: DependencyRejectionCode
  message: string
}

export interface MemoryRepository {
  get(type: SyncEntityType, id: string): SyncEnvelope | null
  list(filter: ListFilter): PageResult<SyncEnvelope>

  /** 同一逻辑事务：写入实体并生成 journal；任一步失败全部回滚 */
  transaction<T>(fn: (tx: RepositoryTx) => T): T

  changesAfter(localCursor: number, limit: number): { entries: JournalEntry[]; nextCursor: number }

  /** 整批校验后才写入；中途异常回滚；不产生本地待上传 journal（更新 knownRemote 即可） */
  applyRemote(batch: SyncEnvelope[], expectedReceipt?: unknown): ApplyRemoteResult

  listConflicts(): Array<Record<string, unknown>>
  resolveConflict(conflictId: string, mode: 'local' | 'remote' | 'manual', manual?: SyncEnvelope): void

  checkpoint(label: string): string
  restoreCheckpoint(id: string): void

  prepareSync(sessionId: string, batchHash: string): PreparedReceipt
  commitPrepared(prepared: PreparedReceipt): { committed: true; sessionId: string }
  recoverPrepared(sessionId: string): PreparedSessionState

  /** 启动/诊断 */
  journalCursor(): number
}

export interface RepositoryTx {
  put(envelope: SyncEnvelope): void
  tombstone(entityType: SyncEntityType, entityId: string): void
  attach(childId: string, parentId: string): void
  detach(childId: string): void
}

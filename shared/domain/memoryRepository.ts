import { createHash } from 'node:crypto'
import { compareVectors, mergeVectors, type VersionVector } from '../contracts/version-vector'
import {
  isPseudoConflict,
  makeEnvelope,
  tombstoneEnvelope,
  type SyncEnvelope,
  type SyncEntityType,
} from '../contracts/sync-envelope'
import {
  checkDependencyAgainstFences,
  createConflictRecord,
  type ConflictRecord,
  type DeleteFence,
} from '../contracts/conflict'
import type {
  ApplyRemoteResult,
  JournalEntry,
  ListFilter,
  MemoryRepository,
  PageResult,
  PreparedReceipt,
  PreparedSessionState,
  RejectedApply,
  RepositoryTx,
} from './repositories'

interface EntityRow {
  envelope: SyncEnvelope
}

interface Snapshot {
  entities: Map<string, SyncEnvelope>
  journal: JournalEntry[]
  conflicts: ConflictRecord[]
  fences: DeleteFence[]
  knownRemote: VersionVector
  prepared: Map<string, PreparedReceipt & { state: PreparedSessionState }>
}

function key(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`
}

/**
 * 阶段 1 内存 oracle：验证 Repository 契约，不接入生产存储。
 */
export class InMemorySyncRepository implements MemoryRepository {
  private readonly deviceId: string
  private entities = new Map<string, SyncEnvelope>()
  private journal: JournalEntry[] = []
  private conflicts: ConflictRecord[] = []
  private fences: DeleteFence[] = []
  private knownRemote: VersionVector = {}
  private prepared = new Map<string, PreparedReceipt & { state: PreparedSessionState }>()
  private snapshots = new Map<string, Snapshot>()
  private checkpointSeq = 0
  private rejected: RejectedApply[] = []

  constructor(deviceId = 'mem-device') {
    this.deviceId = deviceId
  }

  get(type: SyncEntityType, id: string): SyncEnvelope | null {
    const env = this.entities.get(key(type, id))
    if (!env || env.deleted) return null
    return { ...env, version: { ...env.version } }
  }

  list(filter: ListFilter = {}): PageResult<SyncEnvelope> {
    let items = [...this.entities.values()].filter((e) => {
      if (filter.entityType && e.entityType !== filter.entityType) return false
      if (e.deleted && !filter.includeTombstones) return false
      if (filter.parentId && e.parentId !== filter.parentId) return false
      return true
    })
    items = items.sort((a, b) => a.entityId.localeCompare(b.entityId))
    const total = items.length
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? items.length
    items = items.slice(offset, offset + limit).map((e) => ({
      ...e,
      version: { ...e.version },
      payload: structuredClone(e.payload),
    }))
    return { items, total }
  }

  transaction<T>(fn: (tx: RepositoryTx) => T): T {
    const before = this.cloneState()
    const staged: Array<() => void> = []
    const journalStaged: JournalEntry[] = []

    const tx: RepositoryTx = {
      put: (envelope) => {
        staged.push(() => this.upsertLocal(envelope, journalStaged))
      },
      tombstone: (entityType, entityId) => {
        staged.push(() => {
          const cur = this.entities.get(key(entityType, entityId))
          if (!cur) throw new Error(`tombstone 目标不存在: ${entityType}:${entityId}`)
          const env = tombstoneEnvelope(cur, this.deviceId)
          this.upsertLocal(env, journalStaged)
        })
      },
      attach: (childId, parentId) => {
        staged.push(() => {
          for (const [k, env] of this.entities) {
            if (env.entityId === childId && !env.deleted) {
              const next = { ...env, parentId }
              this.upsertLocal(next, journalStaged)
              void k
              return
            }
          }
          throw new Error(`attach 子实体不存在: ${childId}`)
        })
      },
      detach: (childId) => {
        staged.push(() => {
          for (const [, env] of this.entities) {
            if (env.entityId === childId && !env.deleted) {
              const next = { ...env, parentId: null }
              this.upsertLocal(next, journalStaged)
              return
            }
          }
          throw new Error(`detach 子实体不存在: ${childId}`)
        })
      },
    }

    try {
      const result = fn(tx)
      for (const run of staged) run()
      for (const entry of journalStaged) this.journal.push(entry)
      return result
    } catch (err) {
      this.restoreState(before)
      throw err
    }
  }

  changesAfter(localCursor: number, limit: number) {
    const slice = this.journal.filter((e) => e.seq > localCursor).slice(0, limit)
    const nextCursor = slice.length ? slice[slice.length - 1].seq : localCursor
    return { entries: slice.map((e) => ({ ...e })), nextCursor }
  }

  applyRemote(batch: SyncEnvelope[], _expectedReceipt?: unknown): ApplyRemoteResult {
    const before = this.cloneState()
    const conflicts: ApplyRemoteResult['conflicts'] = []
    let applied = 0
    let rejected = 0

    // 先全量校验
    const plan: Array<{ kind: 'apply'; env: SyncEnvelope } | { kind: 'conflict'; env: SyncEnvelope }> = []
    for (const remote of batch) {
      const local = this.entities.get(key(remote.entityType, remote.entityId))
      if (!local) {
        const dep = checkDependencyAgainstFences(remote, this.fences)
        if (!dep.ok) {
          rejected += 1
          this.rejected.push({
            entityId: remote.entityId,
            entityType: remote.entityType,
            code: 'DEPENDENCY_CONFLICT',
            message: '父实体已删除或并发删除',
          })
          continue
        }
        plan.push({ kind: 'apply', env: remote })
        continue
      }
      const rel = compareVectors(local.version, remote.version)
      if (rel === 'equal') continue
      if (rel === 'dominated') {
        // remote 支配 local
        plan.push({ kind: 'apply', env: remote })
        continue
      }
      if (rel === 'dominates') continue
      // concurrent
      if (isPseudoConflict(local, remote)) {
        // 同哈希伪冲突：远端 apply 后本地应升 dot（这里由 oracle 合并向量后 bump）
        const merged = makeEnvelope({
          entityType: local.entityType,
          entityId: local.entityId,
          payload: local.payload,
          deviceId: this.deviceId,
          previousVersion: mergeVec(local.version, remote.version),
          parentId: local.parentId,
          schemaVersion: local.schemaVersion,
          deleted: local.deleted,
        })
        plan.push({ kind: 'apply', env: merged })
        continue
      }
      plan.push({ kind: 'conflict', env: remote })
    }

    try {
      for (const item of plan) {
        if (item.kind === 'conflict') {
          const local = this.entities.get(key(item.env.entityType, item.env.entityId))!
          const record = createConflictRecord({
            conflictId: `c-${item.env.entityType}-${item.env.entityId}-${this.conflicts.length + 1}`,
            local,
            remote: item.env,
          })
          this.conflicts.push(record)
          conflicts.push({ entityId: item.env.entityId, entityType: item.env.entityType })
          continue
        }
        this.writeRemote(item.env)
        applied += 1
      }
      // 更新已知远端向量（合并，不代表 payload 合并）
      for (const env of batch) {
        this.knownRemote = mergeVec(this.knownRemote, env.version)
      }
      return { applied, conflicts, rejected }
    } catch (err) {
      this.restoreState(before)
      throw err
    }
  }

  listConflicts() {
    return this.conflicts
      .filter((c) => c.status === 'open')
      .map((c) => ({
        conflictId: c.conflictId,
        entityType: c.entityType,
        entityId: c.entityId,
        kind: c.kind,
        localHash: c.local.contentHash,
        remoteHash: c.remote.contentHash,
        discoveredAt: c.discoveredAt,
      }))
  }

  resolveConflict(
    conflictId: string,
    mode: 'local' | 'remote' | 'manual',
    manual?: SyncEnvelope,
  ): void {
    const idx = this.conflicts.findIndex((c) => c.conflictId === conflictId)
    if (idx < 0) throw new Error(`冲突不存在: ${conflictId}`)
    const c = this.conflicts[idx]
    const chosen =
      mode === 'local' ? c.local : mode === 'remote' ? c.remote : manual
    if (!chosen) throw new Error('manual 模式必须提供 envelope')
    // 解决是新变更：支配双方 + 本机 dot
    const mergedVersion = mergeVec(c.local.version, c.remote.version)
    const resolved = makeEnvelope({
      entityType: chosen.entityType,
      entityId: chosen.entityId,
      payload: chosen.payload,
      deviceId: this.deviceId,
      previousVersion: mergedVersion,
      parentId: chosen.parentId,
      schemaVersion: chosen.schemaVersion,
      deleted: chosen.deleted,
      aggregate: chosen.aggregateId
        ? { type: chosen.aggregateType ?? 'x', id: chosen.aggregateId, revision: chosen.aggregateRevision }
        : undefined,
      references: chosen.references,
    })
    this.writeLocalSilent(resolved)
    this.conflicts[idx] = {
      ...c,
      status:
        mode === 'local' ? 'resolved_local' : mode === 'remote' ? 'resolved_remote' : 'resolved_manual',
    }
  }

  checkpoint(label: string): string {
    this.checkpointSeq += 1
    const id = `ckpt-${this.checkpointSeq}-${label}`
    this.snapshots.set(id, this.cloneState())
    return id
  }

  restoreCheckpoint(id: string): void {
    const snap = this.snapshots.get(id)
    if (!snap) throw new Error(`检查点不存在: ${id}`)
    this.restoreState(snap)
  }

  prepareSync(sessionId: string, batchHash: string): PreparedReceipt {
    if (!/^[0-9a-f]{16,}$/.test(batchHash.replace(/^sha256:/, '')) && !/^[0-9a-f:]+$/.test(batchHash)) {
      throw new Error('batchHash 非法')
    }
    const receipt: PreparedReceipt = {
      sessionId,
      batchHash,
      preparedAt: Date.now(),
      stagedCount: this.journal.length,
      dependencyCheck: this.fences.length ? 'ok' : 'ok',
    }
    this.prepared.set(sessionId, { ...receipt, state: 'prepared' })
    return { ...receipt }
  }

  commitPrepared(prepared: PreparedReceipt): { committed: true; sessionId: string } {
    const cur = this.prepared.get(prepared.sessionId)
    if (!cur) throw new Error(`会话未 prepare: ${prepared.sessionId}`)
    if (cur.state === 'committed') return { committed: true, sessionId: prepared.sessionId }
    if (cur.batchHash !== prepared.batchHash) throw new Error('preparedReceipt batchHash 不匹配')
    this.prepared.set(prepared.sessionId, { ...cur, state: 'committed' })
    return { committed: true, sessionId: prepared.sessionId }
  }

  recoverPrepared(sessionId: string): PreparedSessionState {
    return this.prepared.get(sessionId)?.state ?? 'none'
  }

  journalCursor(): number {
    return this.journal.length ? this.journal[this.journal.length - 1].seq : 0
  }

  lastRejections(): RejectedApply[] {
    return [...this.rejected]
  }

  private upsertLocal(env: SyncEnvelope, journalStaged: JournalEntry[]): void {
    const dep = checkDependencyAgainstFences(env, this.fences)
    if (!dep.ok) throw new Error(dep.reason)
    this.entities.set(key(env.entityType, env.entityId), env)
    const seq = this.journal.length + journalStaged.length + 1
    journalStaged.push({
      seq,
      entityType: env.entityType,
      entityId: env.entityId,
      envelope: env,
      recordedAt: Date.now(),
    })
    if (env.deleted && env.aggregateType && env.aggregateId) {
      this.fences.push({
        aggregateType: env.aggregateType,
        aggregateId: env.aggregateId,
        deletedAt: env.updatedAt,
        fenceVersion: env.version,
      })
    }
  }

  private writeLocalSilent(env: SyncEnvelope): void {
    this.entities.set(key(env.entityType, env.entityId), env)
    this.journal.push({
      seq: this.journal.length + 1,
      entityType: env.entityType,
      entityId: env.entityId,
      envelope: env,
      recordedAt: Date.now(),
    })
  }

  /** 远端 apply：不产生本地 journal */
  private writeRemote(env: SyncEnvelope): void {
    const dep = checkDependencyAgainstFences(env, this.fences)
    if (!dep.ok) throw new Error(dep.reason)
    this.entities.set(key(env.entityType, env.entityId), env)
    if (env.deleted && env.aggregateType && env.aggregateId) {
      const exists = this.fences.some(
        (f) => f.aggregateType === env.aggregateType && f.aggregateId === env.aggregateId,
      )
      if (!exists) {
        this.fences.push({
          aggregateType: env.aggregateType,
          aggregateId: env.aggregateId,
          deletedAt: env.updatedAt,
          fenceVersion: env.version,
        })
      }
    }
  }

  private cloneState(): Snapshot {
    return {
      entities: new Map(
        [...this.entities].map(([k, v]) => [k, { ...v, version: { ...v.version }, payload: structuredClone(v.payload) }]),
      ),
      journal: this.journal.map((e) => ({ ...e })),
      conflicts: this.conflicts.map((c) => ({ ...c })),
      fences: this.fences.map((f) => ({ ...f })),
      knownRemote: { ...this.knownRemote },
      prepared: new Map(this.prepared),
    }
  }

  private restoreState(snap: Snapshot): void {
    this.entities = snap.entities
    this.journal = snap.journal
    this.conflicts = snap.conflicts
    this.fences = snap.fences
    this.knownRemote = snap.knownRemote
    this.prepared = snap.prepared
  }
}

function mergeVec(a: VersionVector, b: VersionVector): VersionVector {
  return mergeVectors(a, b)
}

export function hashBatch(envelopes: SyncEnvelope[]): string {
  const body = JSON.stringify(
    envelopes.map((e) => ({
      t: e.entityType,
      i: e.entityId,
      h: e.contentHash,
      v: e.version,
    })),
  )
  return `sha256:${createHash('sha256').update(body).digest('hex')}`
}

import { compareVectors, mergeVectors, type VersionVector } from './version-vector'
import type { SyncEnvelope } from './sync-envelope'

export type ConflictStatus = 'open' | 'resolved_local' | 'resolved_remote' | 'resolved_manual'

export interface ConflictRecord {
  conflictId: string
  entityType: string
  entityId: string
  local: SyncEnvelope
  remote: SyncEnvelope
  discoveredAt: number
  /** 同步会话来源 */
  sourceSessionId: string | null
  status: ConflictStatus
  /** 依赖冲突类型 */
  kind: 'version_concurrent' | 'delete_vs_modify' | 'dependency'
}

/** PC bootstrap 首次生成并持久化；不得从用户内容推导 */
export interface MigrationGenesis {
  genesisId: string
  createdAt: number
  /** 平台：pc | android */
  platform: 'pc' | 'android'
  /** 规范内容哈希：全量 bootstrap 实体 contentHash 排序连接后的 sha256 */
  datasetHash: string
}

export function classifyConflict(local: SyncEnvelope, remote: SyncEnvelope): ConflictRecord['kind'] {
  if (local.deleted !== remote.deleted) return 'delete_vs_modify'
  return 'version_concurrent'
}

export function createConflictRecord(input: {
  local: SyncEnvelope
  remote: SyncEnvelope
  sourceSessionId?: string | null
  discoveredAt?: number
  conflictId: string
}): ConflictRecord {
  return {
    conflictId: input.conflictId,
    entityType: input.local.entityType,
    entityId: input.local.entityId,
    local: input.local,
    remote: input.remote,
    discoveredAt: input.discoveredAt ?? Date.now(),
    sourceSessionId: input.sourceSessionId ?? null,
    status: 'open',
    kind: classifyConflict(input.local, input.remote),
  }
}

/** 伪冲突收敛：支配双方、新本机 dot 已在 makeEnvelope 完成时保证 */
export function convergePseudoConflict(local: SyncEnvelope, remote: SyncEnvelope): VersionVector {
  return mergeVectors(local.version, remote.version)
}

/**
 * 父实体 tombstone（delete fence）。
 * 远端子实体新增/修改若 references 或 parentId 指向已删除父实体 → DEPENDENCY_CONFLICT。
 */
export interface DeleteFence {
  aggregateType: string
  aggregateId: string
  deletedAt: number
  fenceVersion: VersionVector
}

export function checkDependencyAgainstFences(
  env: SyncEnvelope,
  fences: readonly DeleteFence[],
): { ok: true } | { ok: false; reason: 'DEPENDENCY_CONFLICT'; fence: DeleteFence } {
  if (env.deleted) return { ok: true }
  const parentHit = env.parentId
    ? fences.find((f) => f.aggregateId === env.parentId)
    : undefined
  if (parentHit) return { ok: false, reason: 'DEPENDENCY_CONFLICT', fence: parentHit }

  const refs = env.references ?? []
  for (const ref of refs) {
    const fence = fences.find((f) => f.aggregateId === ref)
    if (fence) return { ok: false, reason: 'DEPENDENCY_CONFLICT', fence }
  }
  if (env.aggregateId) {
    const fence = fences.find(
      (f) => f.aggregateType === env.aggregateType && f.aggregateId === env.aggregateId,
    )
    if (fence) {
      // 允许 tombstone 级联；禁止存活业务写进已删除聚合
      if (compareVectors(env.version, fence.fenceVersion) === 'dominated') {
        return { ok: false, reason: 'DEPENDENCY_CONFLICT', fence }
      }
      // 并发删除与并发存活 → 依赖冲突
      return { ok: false, reason: 'DEPENDENCY_CONFLICT', fence }
    }
  }
  return { ok: true }
}

export function emptyFences(): DeleteFence[] {
  return []
}

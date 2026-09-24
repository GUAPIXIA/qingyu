import type { VersionVector } from '../contracts/version-vector'
import { mergeVectors, compareVectors } from '../contracts/version-vector'
import type { SyncEnvelope } from '../contracts/sync-envelope'
import { makeEnvelope, isPseudoConflict } from '../contracts/sync-envelope'
import { checkDependencyAgainstFences, type DeleteFence } from '../contracts/conflict'

/**
 * migration genesis：PC bootstrap 首次生成并持久化；不得从用户内容推导。
 * Android 缓存同内容投影不得被赋予独立并发祖先（总方案 §9.1）。
 */
export interface MigrationGenesisInfo {
  genesisId: string
  createdAt: number
  platform: 'pc' | 'android'
  datasetHash: string
}

export function assertSameGenesis(
  local: MigrationGenesisInfo,
  remote: MigrationGenesisInfo,
): { ok: true } | { ok: false; reason: 'GENESIS_MISMATCH'; localId: string; remoteId: string } {
  if (local.genesisId === remote.genesisId) return { ok: true }
  return { ok: false, reason: 'GENESIS_MISMATCH', localId: local.genesisId, remoteId: remote.genesisId }
}

/**
 * 伪冲突消解（总方案 §6.3）：并发但规范业务哈希相同 →
 * 由同步发起端生成一个支配双方、带新本机 dot 的收敛 head，不要求用户处理伪冲突。
 */
export function convergePseudoConflictHead(input: {
  local: SyncEnvelope
  remote: SyncEnvelope
  deviceId: string
  now: number
}): SyncEnvelope {
  if (!isPseudoConflict(input.local, input.remote)) {
    throw new Error('不是伪冲突：contentHash/deleted 不一致或版本非并发')
  }
  const merged = mergeVectors(input.local.version, input.remote.version)
  return makeEnvelope({
    entityType: input.local.entityType,
    entityId: input.local.entityId,
    payload: input.local.deleted ? {} : input.local.payload,
    deviceId: input.deviceId,
    previousVersion: merged,
    parentId: input.local.parentId,
    schemaVersion: input.local.schemaVersion,
    deleted: input.local.deleted,
    updatedAt: input.now,
    aggregate: input.local.aggregateId
      ? {
          type: input.local.aggregateType ?? 'unknown',
          id: input.local.aggregateId,
          revision: input.local.aggregateRevision,
        }
      : undefined,
    references: input.local.references,
  })
}

/** migration genesis 与相同业务 hash 的伪冲突消解结果 */
export interface PseudoConflictResolution {
  action: 'converge' | 'not_pseudo'
  converged?: SyncEnvelope
  mergedVersion?: VersionVector
}

export function resolvePseudoOrConflict(input: {
  local: SyncEnvelope
  remote: SyncEnvelope
  deviceId: string
  now: number
}): PseudoConflictResolution {
  if (!isPseudoConflict(input.local, input.remote)) {
    return { action: 'not_pseudo' }
  }
  const converged = convergePseudoConflictHead(input)
  return {
    action: 'converge',
    converged,
    mergedVersion: converged.version,
  }
}

/**
 * aggregate delete fence + 引用图检查 + DEPENDENCY_CONFLICT 分类。
 * 「不同 ID 取并集」不能绕过引用完整性检查（总方案 §6.3）。
 */
export function checkBatchDependencies(
  envelopes: readonly SyncEnvelope[],
  fences: readonly DeleteFence[],
): Array<{ ok: true; envelope: SyncEnvelope } | { ok: false; envelope: SyncEnvelope; code: 'DEPENDENCY_CONFLICT'; fenceAggregateId: string }> {
  return envelopes.map((env) => {
    const dep = checkDependencyAgainstFences(env, fences)
    if (dep.ok) return { ok: true as const, envelope: env }
    return {
      ok: false as const,
      envelope: env,
      code: 'DEPENDENCY_CONFLICT' as const,
      fenceAggregateId: dep.fence.aggregateId,
    }
  })
}

/** 版本关系再导出，便于 Sync Core 单入口消费 */
export { compareVectors, mergeVectors }

import { contentHash, type CanonicalJsonValue } from './canonical-json'
import {
  bumpDot,
  compareVectors,
  emptyVector,
  mergeVectors,
  type Dot,
  type VersionVector,
} from './version-vector'

export const SYNC_CONTRACT_VERSION = 1

export type SyncEntityType =
  | 'settings_public'
  | 'character'
  | 'lorebook'
  | 'preset'
  | 'persona'
  | 'regex_rule'
  | 'quick_reply_set'
  | 'group'
  | 'session'
  | 'message'
  | 'memory_state'
  | 'memory_fact'
  | 'usage_record'
  | 'mcp_public_config'
  | 'media_manifest'
  | 'lorebook_mapping_template'
  | 'usage_clear_marker'

export interface SyncEnvelope<TPayload extends CanonicalJsonValue = CanonicalJsonValue> {
  contractVersion: number
  entityType: SyncEntityType
  entityId: string
  parentId: string | null
  schemaVersion: number
  version: VersionVector
  dot: Dot
  deleted: boolean
  updatedAt: number
  contentHash: string
  payload: TPayload
  /** 跨实体不变量：聚合归属 */
  aggregateType?: string
  aggregateId?: string
  aggregateRevision?: string
  /** 显式引用的实体 ID（delete fence / 依赖冲突检测） */
  references?: string[]
}

export interface UsageClearMarkerPayload {
  clearedThrough: VersionVector
}

export function makeEnvelope(input: {
  entityType: SyncEntityType
  entityId: string
  payload: CanonicalJsonValue
  deviceId: string
  previousVersion?: VersionVector
  parentId?: string | null
  schemaVersion?: number
  deleted?: boolean
  updatedAt?: number
  aggregate?: { type: string; id: string; revision?: string }
  references?: string[]
}): SyncEnvelope {
  const previous = input.previousVersion ?? emptyVector()
  const { vector, dot } = bumpDot(previous, input.deviceId)
  const deleted = input.deleted ?? false
  // deleted tombstone 的 contentHash 对空业务 payload 计算，避免删除状态绑定旧正文
  const businessPayload = deleted ? {} : input.payload
  const env: SyncEnvelope = {
    contractVersion: SYNC_CONTRACT_VERSION,
    entityType: input.entityType,
    entityId: input.entityId,
    parentId: input.parentId ?? null,
    schemaVersion: input.schemaVersion ?? 1,
    version: vector,
    dot,
    deleted,
    updatedAt: input.updatedAt ?? Date.now(),
    contentHash: contentHash(businessPayload),
    payload: deleted ? {} : input.payload,
  }
  if (input.aggregate) {
    env.aggregateType = input.aggregate.type
    env.aggregateId = input.aggregate.id
    if (input.aggregate.revision) env.aggregateRevision = input.aggregate.revision
  }
  if (input.references?.length) env.references = [...input.references]
  return env
}

export function tombstoneEnvelope(
  live: SyncEnvelope,
  deviceId: string,
  updatedAt = Date.now(),
): SyncEnvelope {
  return makeEnvelope({
    entityType: live.entityType,
    entityId: live.entityId,
    payload: {},
    deviceId,
    previousVersion: live.version,
    parentId: live.parentId,
    schemaVersion: live.schemaVersion,
    deleted: true,
    updatedAt,
    aggregate: live.aggregateId
      ? {
          type: live.aggregateType ?? 'unknown',
          id: live.aggregateId,
          revision: live.aggregateRevision,
        }
      : undefined,
    references: live.references,
  })
}

/** 合并远端已知版本（不合并 payload） */
export function mergeKnown(local: VersionVector, remote: VersionVector): VersionVector {
  return mergeVectors(local, remote)
}

/** 伪冲突：并发但业务哈希相同 → 发起端收敛 head（支配双方、新本机 dot） */
export function isPseudoConflict(local: SyncEnvelope, remote: SyncEnvelope): boolean {
  if (local.entityId !== remote.entityId) return false
  if (local.contentHash !== remote.contentHash) return false
  if (local.deleted !== remote.deleted) return false
  return compareVectors(local.version, remote.version) === 'concurrent'
}

import { compareVectors, type VersionVector } from '../contracts/version-vector'
import { contentHash, canonicalize, sha256HexUtf8 } from '../contracts/canonical-json'
import { classifyConflict } from '../contracts/conflict'
import type { EntityHeadSummary, PlanItem, PlanStats, SyncPlan, NegotiatedCapabilities } from './types'

export interface BuildPlanInput {
  localHeads: readonly EntityHeadSummary[]
  remoteHeads: readonly EntityHeadSummary[]
  localKnownOfRemote?: VersionVector
  remoteKnownOfLocal?: VersionVector
  negotiated: NegotiatedCapabilities
  sizeOf?: (head: EntityHeadSummary) => number
}

function headKey(h: { entityType: string; entityId: string }): string {
  return h.entityType + ' ' + h.entityId
}

function defaultSize(h: EntityHeadSummary): number {
  return h.contentHash.length + h.entityId.length + 32
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(' ')
  return [key.slice(0, i), key.slice(i + 1)]
}

/**
 * 根据双方 heads / known vector 生成 dry-run 计划。
 *
 * - 只在一端存在 → upload / download
 * - 两端 equal → same
 * - 一端 dominates → 由支配端 upload/download
 * - concurrent 且 contentHash+deleted 相同 → same（伪冲突消解）
 * - concurrent 且不同 → conflict
 * - schema/类型不支持 → unknown_schema
 */
export function buildSyncPlan(input: BuildPlanInput): SyncPlan {
  const sizeOf = input.sizeOf ?? defaultSize
  const localById = new Map(input.localHeads.map((h) => [headKey(h), h]))
  const remoteById = new Map(input.remoteHeads.map((h) => [headKey(h), h]))
  const keys = [...new Set([...localById.keys(), ...remoteById.keys()])].sort()
  const maxSchema = input.negotiated.schemaVersions
  const unsupported = new Set(input.negotiated.unsupportedEntityTypes)

  const items: PlanItem[] = []
  let uploadBytes = 0
  let downloadBytes = 0

  for (const key of keys) {
    const [entityType, entityId] = splitKey(key)
    const local = localById.get(key)
    const remote = remoteById.get(key)
    const schemaLocal = local?.schemaVersion ?? 1
    const schemaRemote = remote?.schemaVersion ?? 1
    const schemaMax = Math.max(schemaLocal, schemaRemote)
    const schemaCap = maxSchema[entityType]

    if (unsupported.has(entityType) || (schemaCap !== undefined && schemaMax > schemaCap)) {
      items.push({
        entityType,
        entityId,
        bucket: 'unknown_schema',
        localVersion: local?.version,
        remoteVersion: remote?.version,
        schemaVersion: schemaMax,
        unknownSchemaReason: unsupported.has(entityType)
          ? 'ENTITY_TYPE_UNSUPPORTED'
          : 'SCHEMA_VERSION_UNSUPPORTED',
      })
      continue
    }

    if (local && !remote) {
      uploadBytes += sizeOf(local)
      items.push({
        entityType,
        entityId,
        bucket: 'upload',
        localVersion: local.version,
        localHash: local.contentHash,
        deleted: local.deleted,
        schemaVersion: local.schemaVersion,
      })
      continue
    }
    if (!local && remote) {
      downloadBytes += sizeOf(remote)
      items.push({
        entityType,
        entityId,
        bucket: 'download',
        remoteVersion: remote.version,
        remoteHash: remote.contentHash,
        deleted: remote.deleted,
        schemaVersion: remote.schemaVersion,
      })
      continue
    }
    if (!local || !remote) continue

    const rel = compareVectors(local.version, remote.version)
    if (rel === 'equal') {
      items.push({
        entityType,
        entityId,
        bucket: 'same',
        localVersion: local.version,
        remoteVersion: remote.version,
        localHash: local.contentHash,
        remoteHash: remote.contentHash,
        deleted: local.deleted,
      })
      continue
    }
    if (rel === 'dominates') {
      uploadBytes += sizeOf(local)
      items.push({
        entityType,
        entityId,
        bucket: 'upload',
        localVersion: local.version,
        remoteVersion: remote.version,
        localHash: local.contentHash,
        remoteHash: remote.contentHash,
        deleted: local.deleted,
        schemaVersion: local.schemaVersion,
      })
      continue
    }
    if (rel === 'dominated') {
      downloadBytes += sizeOf(remote)
      items.push({
        entityType,
        entityId,
        bucket: 'download',
        localVersion: local.version,
        remoteVersion: remote.version,
        localHash: local.contentHash,
        remoteHash: remote.contentHash,
        deleted: remote.deleted,
        schemaVersion: remote.schemaVersion,
      })
      continue
    }
    const pseudo = local.contentHash === remote.contentHash && local.deleted === remote.deleted
    if (pseudo) {
      items.push({
        entityType,
        entityId,
        bucket: 'same',
        localVersion: local.version,
        remoteVersion: remote.version,
        localHash: local.contentHash,
        remoteHash: remote.contentHash,
        deleted: local.deleted,
      })
      continue
    }
    const kind = classifyConflict(
      {
        contractVersion: 1,
        entityType: entityType as never,
        entityId,
        parentId: local.parentId,
        schemaVersion: local.schemaVersion,
        version: local.version,
        dot: { deviceId: Object.keys(local.version)[0] ?? '', counter: '0' },
        deleted: local.deleted,
        updatedAt: local.updatedAt,
        contentHash: local.contentHash,
        payload: {},
      },
      {
        contractVersion: 1,
        entityType: entityType as never,
        entityId,
        parentId: remote.parentId,
        schemaVersion: remote.schemaVersion,
        version: remote.version,
        dot: { deviceId: Object.keys(remote.version)[0] ?? '', counter: '0' },
        deleted: remote.deleted,
        updatedAt: remote.updatedAt,
        contentHash: remote.contentHash,
        payload: {},
      },
    )
    items.push({
      entityType,
      entityId,
      bucket: 'conflict',
      localVersion: local.version,
      remoteVersion: remote.version,
      localHash: local.contentHash,
      remoteHash: remote.contentHash,
      deleted: local.deleted,
      conflictKind: kind,
    })
  }

  const bucketRank: Record<string, number> = {
    upload: 0,
    download: 1,
    same: 2,
    conflict: 3,
    unknown_schema: 4,
  }
  items.sort((a, b) => {
    const r = (bucketRank[a.bucket] ?? 9) - (bucketRank[b.bucket] ?? 9)
    if (r !== 0) return r
    if (a.entityType !== b.entityType) return a.entityType < b.entityType ? -1 : 1
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0
  })

  const stats: PlanStats = {
    uploadCount: items.filter((i) => i.bucket === 'upload').length,
    downloadCount: items.filter((i) => i.bucket === 'download').length,
    sameCount: items.filter((i) => i.bucket === 'same').length,
    conflictCount: items.filter((i) => i.bucket === 'conflict').length,
    unknownSchemaCount: items.filter((i) => i.bucket === 'unknown_schema').length,
    uploadBytesEstimate: uploadBytes,
    downloadBytesEstimate: downloadBytes,
  }

  const planId = planFingerprint({
    localKnownOfRemote: input.localKnownOfRemote ?? {},
    remoteKnownOfLocal: input.remoteKnownOfLocal ?? {},
    stats,
  })

  return { items, stats, planId }
}

/** plan 幂等指纹：known vectors + stats 的 canonical 哈希（不含正文） */
export function planFingerprint(input: {
  localKnownOfRemote: VersionVector
  remoteKnownOfLocal: VersionVector
  stats: PlanStats
}): string {
  return 'plan:' + contentHash({
    localKnownOfRemote: input.localKnownOfRemote as Record<string, string>,
    remoteKnownOfLocal: input.remoteKnownOfLocal as Record<string, string>,
    uploadCount: input.stats.uploadCount,
    downloadCount: input.stats.downloadCount,
    conflictCount: input.stats.conflictCount,
    unknownSchemaCount: input.stats.unknownSchemaCount,
  })
}

/** 摘要 root hash：heads 规范哈希（S7-02 Merkle 快速判等） */
export function headsRootHash(heads: readonly EntityHeadSummary[]): string {
  const sorted = [...heads]
    .map((h) => ({
      entityType: h.entityType,
      entityId: h.entityId,
      version: h.version as Record<string, string>,
      contentHash: h.contentHash,
      deleted: h.deleted,
      schemaVersion: h.schemaVersion,
    }))
    .sort((a, b) => {
      if (a.entityType !== b.entityType) return a.entityType < b.entityType ? -1 : 1
      return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0
    })
  return 'sha256:' + sha256HexUtf8(canonicalize(sorted as never))
}

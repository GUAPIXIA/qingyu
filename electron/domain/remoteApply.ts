import type { SyncEnvelope } from '../../shared/contracts/sync-envelope'
import { compareVectors } from '../../shared/contracts/version-vector'
import { contentHash, type CanonicalJsonValue } from '../../shared/contracts/canonical-json'
import { checkDependencyAgainstFences, type DeleteFence } from '../../shared/contracts/conflict'
import type { SyncMetaDb } from './syncMeta'
import { safeId } from '../utils/pathGuard'

export interface ApplyRemoteOptions {
  /** 远端密文哈希（若提供则必须匹配 payload 的 contentHash） */
  expectedContentHash?: string
  fences?: DeleteFence[]
  /** 写业务文件（PC 侧：由调用方决定是否落盘） */
  writeBusiness?: (env: SyncEnvelope) => void
}

export interface ApplyRemoteSummary {
  applied: number
  conflicts: number
  rejected: Array<{ entityId: string; code: string; message: string }>
}

/**
 * 远端批次应用器（PC staging）：
 * - origin=remote 写入 change_log，不得形成回传同一来源的本地待上传
 * - concurrent 且内容不同 → 冲突表
 * - 依赖 fence → DEPENDENCY_CONFLICT
 */
export function applyRemoteBatch(
  meta: SyncMetaDb,
  batch: SyncEnvelope[],
  opts: ApplyRemoteOptions = {},
): ApplyRemoteSummary {
  const rejected: ApplyRemoteSummary['rejected'] = []
  let applied = 0
  let conflicts = 0

  // 整批预检
  for (const env of batch) {
    try {
      safeId(env.entityId)
    } catch {
      rejected.push({ entityId: String(env.entityId).slice(0, 40), code: 'INVALID_ENVELOPE', message: '非法 entityId' })
      continue
    }
    const computed = contentHash(env.payload as CanonicalJsonValue)
    if (opts.expectedContentHash && env.contentHash !== opts.expectedContentHash) {
      rejected.push({ entityId: env.entityId, code: 'HASH_MISMATCH', message: 'expectedContentHash 不匹配' })
      continue
    }
    if (computed !== env.contentHash) {
      rejected.push({ entityId: env.entityId, code: 'HASH_MISMATCH', message: 'payload contentHash 不匹配' })
      continue
    }
    const dep = checkDependencyAgainstFences(env, opts.fences ?? [])
    if (!dep.ok) {
      rejected.push({ entityId: env.entityId, code: 'DEPENDENCY_CONFLICT', message: dep.reason })
    }
  }

  if (rejected.length === batch.length) {
    return { applied: 0, conflicts: 0, rejected }
  }

  const okIds = new Set(batch.map((e) => e.entityId).filter((id) => !rejected.some((r) => r.entityId === id)))

  for (const env of batch) {
    if (!okIds.has(env.entityId)) continue
    const head = meta.getHead(env.entityType, env.entityId)
    if (!head) {
      meta.upsertHead({
        entityType: env.entityType,
        entityId: env.entityId,
        versionJson: JSON.stringify(env.version),
        hash: env.contentHash,
        deleted: env.deleted ? 1 : 0,
        payloadRef: null,
      })
      meta.appendChange({
        dotDevice: env.dot.deviceId,
        dotCounter: env.dot.counter,
        entityType: env.entityType,
        entityId: env.entityId,
        envelope: env,
        origin: 'remote',
      })
      opts.writeBusiness?.(env)
      applied += 1
      continue
    }

    const localVersion = JSON.parse(head.versionJson) as Record<string, string>
    const rel = compareVectors(localVersion, env.version)
    if (rel === 'equal') continue
    if (rel === 'dominates') continue
    if (rel === 'dominated') {
      meta.upsertHead({
        entityType: env.entityType,
        entityId: env.entityId,
        versionJson: JSON.stringify(env.version),
        hash: env.contentHash,
        deleted: env.deleted ? 1 : 0,
        payloadRef: null,
      })
      meta.appendChange({
        dotDevice: env.dot.deviceId,
        dotCounter: env.dot.counter,
        entityType: env.entityType,
        entityId: env.entityId,
        envelope: env,
        origin: 'remote',
      })
      opts.writeBusiness?.(env)
      applied += 1
      continue
    }

    // concurrent
    const localHash = head.hash
    if (localHash === env.contentHash && head.deleted === (env.deleted ? 1 : 0)) {
      // 伪冲突：仅更新已知向量到合并，不制造用户冲突
      const merged = { ...localVersion }
      for (const [k, v] of Object.entries(env.version)) {
        const prev = BigInt(merged[k] ?? '0')
        const next = BigInt(v)
        if (next > prev) merged[k] = v
      }
      meta.upsertHead({
        entityType: env.entityType,
        entityId: env.entityId,
        versionJson: JSON.stringify(merged),
        hash: env.contentHash,
        deleted: head.deleted,
        payloadRef: head.payloadRef,
      })
      continue
    }

    meta.insertConflict({
      id: `conflict-${env.entityType}-${env.entityId}-${Date.now()}`,
      entityType: env.entityType,
      entityId: env.entityId,
      localEnvelope: { versionJson: head.versionJson, hash: head.hash, deleted: head.deleted },
      remoteEnvelope: env,
    })
    conflicts += 1
  }

  return { applied, conflicts, rejected }
}

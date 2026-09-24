import { contentHash, type CanonicalJsonValue } from '../contracts/canonical-json'
import type { SyncEnvelope } from '../contracts/sync-envelope'

/** 批次排序相位：父实体 → 子实体 → 引用更新 → tombstone */
export type BatchPhase = 0 | 1 | 2 | 3

export interface OrderedBatchItem {
  phase: BatchPhase
  entityType: string
  entityId: string
  envelope: SyncEnvelope
}

const PHASE_LABEL = ['parents', 'children', 'references', 'tombstones'] as const

/**
 * 批次排序（S7-01）：父实体 → 子实体 → 引用更新 → tombstone。
 *
 * - phase 0：无 parentId 且非 tombstone 的顶层实体
 * - phase 1：有 parentId 的存活子实体（父→子按 parentId 再排）
 * - phase 2：带 references 的存活实体（引用更新）
 * - phase 3：所有 tombstone（最后删除）
 * 同相位内按 (entityType, entityId) 稳定排序。
 */
export function sortBatch(envelopes: readonly SyncEnvelope[]): OrderedBatchItem[] {
  const decorated = envelopes.map((envelope) => ({
    phase: batchPhaseOf(envelope),
    entityType: envelope.entityType,
    entityId: envelope.entityId,
    envelope,
  }))
  decorated.sort((a, b) => {
    if (a.phase !== b.phase) return a.phase - b.phase
    if (a.phase === 1) {
      const pa = a.envelope.parentId ?? ''
      const pb = b.envelope.parentId ?? ''
      if (pa !== pb) return pa < pb ? -1 : 1
    }
    if (a.entityType !== b.entityType) return a.entityType < b.entityType ? -1 : 1
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0
  })
  return decorated
}

export function batchPhaseOf(envelope: SyncEnvelope): BatchPhase {
  if (envelope.deleted) return 3
  if (envelope.parentId) return 1
  if (envelope.references?.length) return 2
  return 0
}

export function phaseLabel(phase: BatchPhase): string {
  return PHASE_LABEL[phase]
}

/** batch hash：有序信封摘要的规范哈希。同 batchId 重试必须得到同一 hash。 */
export function batchHash(ordered: readonly OrderedBatchItem[]): string {
  const body = ordered.map((item) => ({
    entityType: item.envelope.entityType,
    entityId: item.envelope.entityId,
    contentHash: item.envelope.contentHash,
    version: item.envelope.version as Record<string, string>,
    deleted: item.envelope.deleted,
    schemaVersion: item.envelope.schemaVersion,
  }))
  return contentHash(body as CanonicalJsonValue)
}

/** receipt hash：batch hash + 双方 known vector + 协商 protocolVersion */
export function receiptHash(input: {
  batchHash: string
  localKnown: Record<string, string>
  remoteKnown: Record<string, string>
  protocolVersion: number
}): string {
  return contentHash({
    batchHash: input.batchHash,
    localKnown: input.localKnown,
    remoteKnown: input.remoteKnown,
    protocolVersion: input.protocolVersion,
  })
}

/** 幂等 key：session + batch 序号；同一 batchId 重试返回同一结果 */
export function idempotentKey(sessionId: string, batchId: string): string {
  return sessionId + ':' + batchId
}

/**
 * 按预算切批：默认不超过 500 条或 4 MiB，以先达到者为准（方案 §4）。
 * sizeOf 注入字节估计，纯函数不读盘。
 */
export function splitBatches(
  ordered: readonly OrderedBatchItem[],
  opts: {
    maxCount?: number
    maxBytes?: number
    sizeOf?: (item: OrderedBatchItem) => number
  } = {},
): OrderedBatchItem[][] {
  const maxCount = opts.maxCount ?? 500
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024
  const sizeOf = opts.sizeOf ?? (() => 256)
  const batches: OrderedBatchItem[][] = []
  let current: OrderedBatchItem[] = []
  let bytes = 0
  for (const item of ordered) {
    const size = sizeOf(item)
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(item)
    bytes += size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

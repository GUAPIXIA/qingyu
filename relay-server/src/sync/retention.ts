/**
 * S8-05/S8-07：保留期与孤儿对象 GC（纯逻辑）。
 * 实际调度由运维 cron / retention worker 调用；服务端不得仅因保留期限删除未确认 tombstone。
 */

export const RETENTION = {
  tombstoneDays: 180,
  batchTtlHours: 24,
  sessionTtlHours: 2,
  orphanBlobDelayDays: 7,
} as const

export interface TombstoneCandidate {
  entityType: string
  entityId: string
  deleted: true
  updatedAt: number
  /** 各设备已确认 server_seq；空数组表示无 ack */
  deviceAcks: Array<{ deviceId: string; serverSeq: number; retired?: boolean }>
  changeServerSeq: number
}

export interface GcDecision {
  compress: boolean
  reason: 'all_acked_or_retired' | 'pending_ack' | 'too_young'
}

/** tombstone 可压缩：180 天 + 所有未退役设备已 ack */
export function canCompressTombstone(
  candidate: TombstoneCandidate,
  now: number,
  opts: { tombstoneDays?: number } = {},
): GcDecision {
  const days = opts.tombstoneDays ?? RETENTION.tombstoneDays
  const ageMs = now - candidate.updatedAt
  if (ageMs < days * 24 * 3600_000) return { compress: false, reason: 'too_young' }
  const active = candidate.deviceAcks.filter((d) => !d.retired)
  const allAcked = active.every((d) => d.serverSeq >= candidate.changeServerSeq)
  if (!allAcked) return { compress: false, reason: 'pending_ack' }
  return { compress: true, reason: 'all_acked_or_retired' }
}

export interface OrphanBlobCandidate {
  blobId: string
  refCount: number
  status: 'pending' | 'committed' | 'orphan' | 'deleted'
  markedAt: number
}

export function canDeleteOrphanBlob(
  candidate: OrphanBlobCandidate,
  now: number,
  opts: { delayDays?: number } = {},
): boolean {
  const delay = opts.delayDays ?? RETENTION.orphanBlobDelayDays
  if (candidate.refCount > 0) return false
  if (candidate.status === 'deleted') return false
  if (candidate.status === 'committed') return false
  return now - candidate.markedAt >= delay * 24 * 3600_000
}

/** 批次幂等窗口过期可删 */
export function isBatchExpired(expiresAt: number, now: number): boolean {
  return expiresAt <= now
}

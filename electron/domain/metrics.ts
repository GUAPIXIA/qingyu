import { createHash } from 'node:crypto'
import type { SyncMetaDb } from './syncMeta'

export interface SyncDiagnostics {
  journalBacklog: number
  openConflicts: number
  heads: number
  incompleteTx: number
  localChanges: number
  remoteChanges: number
  bootstrapEntityCount: number | null
}

/** 不含正文的诊断指标（S2-07）。导出时仅统计计数与 ID 类信息。 */
export function collectSyncDiagnostics(meta: SyncMetaDb): SyncDiagnostics {
  const base = meta.metrics()
  return {
    ...base,
    localChanges: meta.countChanges('local'),
    remoteChanges: meta.countChanges('remote'),
    bootstrapEntityCount: meta.getBootstrapReceipt()?.entityCount ?? null,
  }
}

/** 诊断导出脱敏摘要：不含 payload 正文。 */
export function exportSyncDiagnosticsSummary(meta: SyncMetaDb): {
  metrics: SyncDiagnostics
  headIds: Array<{ entityType: string; entityIdHash: string }>
  generatedAt: number
} {
  const heads = meta.listHeads(500, 0).map((h) => ({
    entityType: h.entityType,
    entityIdHash: createHash('sha256').update(h.entityId).digest('hex').slice(0, 16),
  }))
  return {
    metrics: collectSyncDiagnostics(meta),
    headIds: heads,
    generatedAt: Date.now(),
  }
}

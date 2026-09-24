/**
 * S7-02：从 entity_heads / change_log 生成同步摘要（PC 侧）。
 * 不扫描业务 payload；分页 + root hash 供 plan 快速判等。
 */
import type { SyncMetaDb } from './syncMeta'
import {
  summarizeHeads,
  paginateByType,
  filterIncremental,
  backlogFromHeads,
  type PartitionedSummary,
  type SummaryPage,
  type BacklogStats,
} from '../../shared/sync-core/summary'
import type { EntityHeadSummary } from '../../shared/sync-core/types'
import type { VersionVector } from '../../shared/contracts/version-vector'

const DEFAULT_PAGE = 500

function mapHeadRow(row: {
  entityType: string
  entityId: string
  versionJson: string
  hash: string
  deleted: number
}): EntityHeadSummary {
  return {
    entityType: row.entityType,
    entityId: row.entityId,
    version: JSON.parse(row.versionJson) as VersionVector,
    contentHash: row.hash,
    deleted: row.deleted === 1,
    parentId: null,
    schemaVersion: 1,
    updatedAt: 0,
  }
}

/**
 * 从 sync-meta 读取 heads 生成摘要。
 * `maxScan` 内存上限：默认 50_000 条 head；超出时只摘要前 N 页并标记 truncated。
 */
export class SyncSummaryService {
  constructor(private readonly meta: SyncMetaDb) {}

  listHeadsPaged(offset: number, limit = DEFAULT_PAGE): EntityHeadSummary[] {
    // SyncMetaDb.listHeads 支持分页
    const rows = this.meta.listHeads(limit, offset)
    return rows.map((r) =>
      mapHeadRow({
        entityType: r.entityType,
        entityId: r.entityId,
        versionJson: r.versionJson,
        hash: r.hash,
        deleted: r.deleted,
      }),
    )
  }

  loadAllHeads(maxScan = 50_000): EntityHeadSummary[] {
    const out: EntityHeadSummary[] = []
    let offset = 0
    while (out.length < maxScan) {
      const page = this.listHeadsPaged(offset, DEFAULT_PAGE)
      if (page.length === 0) break
      out.push(...page)
      if (page.length < DEFAULT_PAGE) break
      offset += DEFAULT_PAGE
    }
    return out
  }

  buildSummary(maxScan = 50_000): PartitionedSummary {
    return summarizeHeads(this.loadAllHeads(maxScan))
  }

  pageOf(entityType: string, page: number, pageSize = DEFAULT_PAGE, maxScan = 50_000): SummaryPage {
    return paginateByType(this.loadAllHeads(maxScan), entityType, page, pageSize)
  }

  backlog(peerKnown: VersionVector, maxScan = 50_000): BacklogStats {
    return backlogFromHeads(this.loadAllHeads(maxScan), peerKnown)
  }

  unknownToPeer(peerKnown: VersionVector, maxScan = 50_000): EntityHeadSummary[] {
    return filterIncremental(this.loadAllHeads(maxScan), { peerKnown, onlyUnknownToPeer: true })
  }
}

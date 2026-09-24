import { describe, expect, it } from 'vitest'
import {
  summarizeHeads,
  paginateByType,
  filterIncremental,
  backlogFromHeads,
  summaryEqual,
} from '../sync-core/summary'
import type { EntityHeadSummary } from '../sync-core/types'

function head(partial: Partial<EntityHeadSummary> & { entityType: string; entityId: string }): EntityHeadSummary {
  return {
    version: { pc: '1' },
    contentHash: 'sha256:' + 'a'.repeat(64),
    deleted: false,
    parentId: null,
    schemaVersion: 1,
    updatedAt: 0,
    ...partial,
  }
}

describe('sync-core summary (S7-02)', () => {
  it('分区 root hash 稳定且可判等', () => {
    const heads = [
      head({ entityType: 'character', entityId: 'c1', version: { pc: '1' } }),
      head({ entityType: 'character', entityId: 'c2', version: { pc: '2' } }),
      head({ entityType: 'message', entityId: 'm1', version: { pc: '5' }, parentId: 's1' }),
    ]
    const a = summarizeHeads(heads)
    const b = summarizeHeads([...heads].reverse())
    expect(a.rootHash).toBe(b.rootHash)
    expect(summaryEqual(a, b)).toBe(true)
    expect(a.byType).toEqual({ character: 2, message: 1 })
    expect(Object.keys(a.partitionHashes).sort()).toEqual(['character', 'message'])
  })

  it('分页不重叠不丢页', () => {
    const heads = Array.from({ length: 5 }, (_, i) =>
      head({ entityType: 'message', entityId: 'm' + i, version: { pc: String(i + 1) }, parentId: 's1' }),
    )
    const p0 = paginateByType(heads, 'message', 0, 2)
    const p1 = paginateByType(heads, 'message', 1, 2)
    const p2 = paginateByType(heads, 'message', 2, 2)
    expect(p0.heads.map((h) => h.entityId)).toEqual(['m0', 'm1'])
    expect(p1.heads.map((h) => h.entityId)).toEqual(['m2', 'm3'])
    expect(p2.heads.map((h) => h.entityId)).toEqual(['m4'])
    expect(p0.hasMore).toBe(true)
    expect(p2.hasMore).toBe(false)
  })

  it('增量过滤只保留 peer 未见版本', () => {
    const heads = [
      head({ entityType: 'character', entityId: 'c1', version: { pc: '1' } }),
      head({ entityType: 'character', entityId: 'c2', version: { pc: '5' } }),
    ]
    const unknown = filterIncremental(heads, { peerKnown: { pc: '3' }, onlyUnknownToPeer: true })
    expect(unknown.map((h) => h.entityId)).toEqual(['c2'])
    const backlog = backlogFromHeads(heads, { pc: '3' })
    expect(backlog.totalLocalChanges).toBe(1)
    expect(backlog.byType).toEqual({ character: 1 })
  })
})

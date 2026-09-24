/**
 * S8-05/S8-07 保留期 GC 纯逻辑。
 */
import { describe, expect, it } from 'vitest'
import { canCompressTombstone, canDeleteOrphanBlob, isBatchExpired, RETENTION } from '../src/sync/retention.js'

const DAY = 24 * 3600_000

describe('tombstone 压缩', () => {
  it('未满 180 天不压缩', () => {
    const now = 1_000_000 * DAY
    const d = canCompressTombstone(
      { entityType: 'character', entityId: 'e', deleted: true, updatedAt: now - 30 * DAY, deviceAcks: [], changeServerSeq: 1 },
      now,
    )
    expect(d.compress).toBe(false)
    expect(d.reason).toBe('too_young')
  })

  it('有未 ack 活跃设备不压缩；退役后可压缩', () => {
    const now = 200 * DAY
    const base = {
      entityType: 'character',
      entityId: 'e',
      deleted: true as const,
      updatedAt: 0,
      changeServerSeq: 10,
    }
    const pending = canCompressTombstone(
      { ...base, deviceAcks: [{ deviceId: 'a', serverSeq: 3 }] },
      now,
    )
    expect(pending.compress).toBe(false)
    expect(pending.reason).toBe('pending_ack')
    const retiredOk = canCompressTombstone(
      {
        ...base,
        deviceAcks: [
          { deviceId: 'a', serverSeq: 3, retired: true },
          { deviceId: 'b', serverSeq: 99 },
        ],
      },
      now,
    )
    expect(retiredOk.compress).toBe(true)
  })
})

describe('孤儿 blob', () => {
  it('refCount>0 或 committed 不删；标记满 7 天可删', () => {
    const now = 10 * DAY
    expect(canDeleteOrphanBlob({ blobId: 'b', refCount: 1, status: 'orphan', markedAt: 0 }, now)).toBe(false)
    expect(canDeleteOrphanBlob({ blobId: 'b', refCount: 0, status: 'committed', markedAt: 0 }, now)).toBe(false)
    // 10-4=6 天 < 7 天延迟
    expect(canDeleteOrphanBlob({ blobId: 'b', refCount: 0, status: 'orphan', markedAt: 4 * DAY }, now)).toBe(false)
    // 10-2=8 天 ≥ 7 天延迟
    expect(canDeleteOrphanBlob({ blobId: 'b', refCount: 0, status: 'orphan', markedAt: 2 * DAY }, now)).toBe(true)
    expect(RETENTION.orphanBlobDelayDays).toBe(7)
    expect(RETENTION.tombstoneDays).toBe(180)
  })
})

describe('batch 幂等窗口', () => {
  it('过期可删', () => {
    expect(isBatchExpired(100, 200)).toBe(true)
    expect(isBatchExpired(300, 200)).toBe(false)
  })
})

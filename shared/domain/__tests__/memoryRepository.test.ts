import { describe, expect, it } from 'vitest'
import { InMemorySyncRepository, hashBatch } from '../memoryRepository'
import { makeEnvelope } from '../../contracts/sync-envelope'

function putChar(repo: InMemorySyncRepository, id: string, name: string, device = 'pc') {
  repo.transaction((tx) => {
    tx.put(
      makeEnvelope({
        entityType: 'character',
        entityId: id,
        payload: { name },
        deviceId: device,
      }),
    )
  })
}

describe('InMemorySyncRepository contract', () => {
  it('本地 put 进 journal；tombstone 默认隐藏', () => {
    const repo = new InMemorySyncRepository('pc')
    putChar(repo, 'c1', 'A')
    expect(repo.get('character', 'c1')?.payload).toEqual({ name: 'A' })
    expect(repo.journalCursor()).toBe(1)
    repo.transaction((tx) => tx.tombstone('character', 'c1'))
    expect(repo.get('character', 'c1')).toBeNull()
    expect(repo.list({ entityType: 'character' }).total).toBe(0)
    expect(repo.list({ entityType: 'character', includeTombstones: true }).total).toBe(1)
  })

  it('事务失败回滚', () => {
    const repo = new InMemorySyncRepository('pc')
    putChar(repo, 'c0', 'keep')
    expect(() =>
      repo.transaction((tx) => {
        tx.put(makeEnvelope({ entityType: 'character', entityId: 'c1', payload: { name: 'X' }, deviceId: 'pc' }))
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(repo.get('character', 'c1')).toBeNull()
    expect(repo.get('character', 'c0')).not.toBeNull()
    expect(repo.journalCursor()).toBe(1)
  })

  it('applyRemote 产生冲突且不写本地 journal', () => {
    const localRepo = new InMemorySyncRepository('pc')
    putChar(localRepo, 'c1', 'local-name')
    const remoteEnv = makeEnvelope({
      entityType: 'character',
      entityId: 'c1',
      payload: { name: 'remote-name' },
      deviceId: 'android',
    })
    const cursorBefore = localRepo.journalCursor()
    const result = localRepo.applyRemote([remoteEnv])
    expect(result.conflicts).toHaveLength(1)
    expect(result.applied).toBe(0)
    expect(localRepo.journalCursor()).toBe(cursorBefore)
    expect(localRepo.listConflicts()).toHaveLength(1)
    localRepo.resolveConflict(
      (localRepo.listConflicts()[0] as { conflictId: string }).conflictId,
      'remote',
    )
    expect(localRepo.get('character', 'c1')?.payload).toEqual({ name: 'remote-name' })
    expect(localRepo.listConflicts()).toHaveLength(0)
  })

  it('远端支配直接 apply，不产生本地冲突', () => {
    const repo = new InMemorySyncRepository('pc')
    putChar(repo, 'c1', 'v1')
    const cur = repo.get('character', 'c1')!
    const remote = makeEnvelope({
      entityType: 'character',
      entityId: 'c1',
      payload: { name: 'v2' },
      deviceId: 'pc',
      previousVersion: cur.version,
    })
    const result = repo.applyRemote([remote])
    expect(result.applied).toBe(1)
    expect(result.conflicts).toHaveLength(0)
    expect(repo.get('character', 'c1')?.payload).toEqual({ name: 'v2' })
    // 远端 apply 不增加本地 journal
    expect(repo.journalCursor()).toBe(1)
  })

  it('prepare/commit 幂等与 recover', () => {
    const repo = new InMemorySyncRepository('pc')
    putChar(repo, 'c1', 'A')
    const receipt = repo.prepareSync('sess-1', hashBatch([repo.get('character', 'c1')!]))
    expect(receipt.sessionId).toBe('sess-1')
    expect(repo.recoverPrepared('sess-1')).toBe('prepared')
    expect(repo.commitPrepared(receipt).committed).toBe(true)
    expect(repo.recoverPrepared('sess-1')).toBe('committed')
    // 幂等
    expect(repo.commitPrepared(receipt).committed).toBe(true)
  })

  it('checkpoint restore', () => {
    const repo = new InMemorySyncRepository('pc')
    putChar(repo, 'c1', 'A')
    const id = repo.checkpoint('before')
    putChar(repo, 'c2', 'B')
    expect(repo.get('character', 'c2')).not.toBeNull()
    repo.restoreCheckpoint(id)
    expect(repo.get('character', 'c2')).toBeNull()
    expect(repo.get('character', 'c1')).not.toBeNull()
  })

  it('父删除 fence 阻止孤儿 message', () => {
    const repo = new InMemorySyncRepository('pc')
    repo.transaction((tx) => {
      tx.put(
        makeEnvelope({
          entityType: 'session',
          entityId: 's1',
          payload: { title: 't' },
          deviceId: 'pc',
          aggregate: { type: 'session', id: 's1' },
        }),
      )
      tx.put(
        makeEnvelope({
          entityType: 'message',
          entityId: 'm1',
          payload: { content: 'hi' },
          deviceId: 'pc',
          parentId: 's1',
          references: ['s1'],
        }),
      )
    })
    repo.transaction((tx) => tx.tombstone('session', 's1'))
    const orphan = makeEnvelope({
      entityType: 'message',
      entityId: 'm2',
      payload: { content: 'late' },
      deviceId: 'android',
      parentId: 's1',
      references: ['s1'],
    })
    const result = repo.applyRemote([orphan])
    expect(result.rejected).toBe(1)
    expect(repo.lastRejections()[0].code).toBe('DEPENDENCY_CONFLICT')
  })
})

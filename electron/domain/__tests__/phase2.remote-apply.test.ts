/**
 * 阶段 2 S2-06：远端批次 staging 应用器。
 *
 * 覆盖：materializer 落盘、origin=remote 无回声、tombstone、delete fence、
 * 不支持实体的显式拒绝、checkpoint/receipt、以及应用失败时的整体回滚。
 */
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeviceIdentityStore } from '../deviceIdentity'
import { SyncMetaDb } from '../syncMeta'
import { applyRemoteBatch, deriveFencesFromHeads } from '../remoteApply'
import { contentHash } from '../../../shared/contracts/canonical-json'
import type { SyncEnvelope } from '../../../shared/contracts/sync-envelope'

function remoteEnvelope(input: {
  entityType: SyncEnvelope['entityType']
  entityId: string
  payload: Record<string, unknown>
  parentId?: string | null
  deviceId?: string
  counter?: string
  version?: Record<string, string>
  deleted?: boolean
  aggregateType?: string
  aggregateId?: string
}): SyncEnvelope {
  const deviceId = input.deviceId ?? 'android-1'
  const counter = input.counter ?? '1'
  const payload = input.deleted ? {} : input.payload
  return {
    contractVersion: 1,
    entityType: input.entityType,
    entityId: input.entityId,
    parentId: input.parentId ?? null,
    schemaVersion: 1,
    version: input.version ?? { [deviceId]: counter },
    dot: { deviceId, counter },
    deleted: input.deleted ?? false,
    updatedAt: Date.now(),
    contentHash: contentHash(payload as never),
    payload: payload as never,
    ...(input.aggregateType && input.aggregateId
      ? { aggregateType: input.aggregateType, aggregateId: input.aggregateId }
      : {}),
  }
}

describe('phase2 S2-06 远端批次 staging 应用', () => {
  let dir: string
  let userData: string
  let meta: SyncMetaDb

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qingyu-remote-'))
    userData = join(dir, 'userdata')
    const identity = new DeviceIdentityStore(join(userData, 'data/config/sync-device-identity.json'))
    identity.loadOrCreate()
    meta = new SyncMetaDb(join(userData, 'data/config/sync-meta.db'))
    mkdirSync(join(userData, 'data', 'config'), { recursive: true })
  })

  afterEach(() => {
    meta.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('persona：数组文件按 id upsert，change_log 记为 remote 且无 local 回声', () => {
    writeFileSync(join(userData, 'data/config/personas.json'), JSON.stringify([{ id: 'p-old', name: '旧' }]), 'utf8')

    const summary = applyRemoteBatch(
      meta,
      userData,
      [remoteEnvelope({ entityType: 'persona', entityId: 'p-new', payload: { name: '远端人设' } })],
      { peerId: 'android-1', cursor: 5 },
    )

    expect(summary.applied).toBe(1)
    expect(summary.rejected).toEqual([])
    const list = JSON.parse(readFileSync(join(userData, 'data/config/personas.json'), 'utf8')) as Array<{ id: string }>
    expect(list.map((p) => p.id).sort()).toEqual(['p-new', 'p-old'])
    expect(meta.countChanges('remote')).toBe(1)
    expect(meta.countChanges('local')).toBe(0)
    expect(meta.getHead('persona', 'p-new')?.deleted).toBe(0)
    // checkpoint 与 receipt
    expect(summary.checkpointId).toBeTruthy()
    expect(meta.getLatestCheckpoint('remote_apply')?.id).toBe(summary.checkpointId)
    expect(summary.receiptSaved).toBe(true)
    expect(meta.getReceipt('android-1')?.cursor).toBe(5)
  })

  it('character：一实体一文件，含 id 字段；tombstone 删除文件并写 deleted head', () => {
    const put = applyRemoteBatch(
      meta,
      userData,
      [remoteEnvelope({ entityType: 'character', entityId: 'c1', payload: { name: '远端角色' } })],
    )
    expect(put.applied).toBe(1)
    const file = join(userData, 'data/characters/c1.json')
    expect(existsSync(file)).toBe(true)
    expect((JSON.parse(readFileSync(file, 'utf8')) as { id: string; name: string }).id).toBe('c1')

    const del = applyRemoteBatch(
      meta,
      userData,
      [
        remoteEnvelope({
          entityType: 'character',
          entityId: 'c1',
          payload: {},
          deleted: true,
          deviceId: 'android-1',
          counter: '2',
          version: { 'android-1': '2' },
        }),
      ],
    )
    expect(del.applied).toBe(1)
    expect(existsSync(file)).toBe(false)
    expect(meta.getHead('character', 'c1')?.deleted).toBe(1)
  })

  it('message：同会话多条消息在单个事务内落盘到同一 JSONL', () => {
    const sessionFile = join(userData, 'data/chats/c1/s1.jsonl')
    mkdirSync(join(userData, 'data/chats/c1'), { recursive: true })
    writeFileSync(sessionFile, JSON.stringify({ id: 'm-keep', sessionId: 's1', role: 'user', content: 'keep', timestamp: 1 }) + '\n', 'utf8')

    const summary = applyRemoteBatch(meta, userData, [
      remoteEnvelope({
        entityType: 'message',
        entityId: 'm1',
        parentId: 's1',
        aggregateType: 'character',
        aggregateId: 'c1',
        payload: { sessionId: 's1', role: 'assistant', content: '第一条', timestamp: 2 },
      }),
      remoteEnvelope({
        entityType: 'message',
        entityId: 'm2',
        parentId: 's1',
        aggregateType: 'character',
        aggregateId: 'c1',
        counter: '2',
        version: { 'android-1': '2' },
        payload: { sessionId: 's1', role: 'assistant', content: '第二条', timestamp: 3 },
      }),
    ])

    expect(summary.applied).toBe(2)
    const lines = readFileSync(sessionFile, 'utf8').split('\n').filter((l) => l.trim())
    const ids = lines.map((l) => (JSON.parse(l) as { id: string }).id).sort()
    expect(ids).toEqual(['m-keep', 'm1', 'm2'])
    expect(meta.countChanges('remote')).toBe(2)
  })

  it('delete fence：父实体已 tombstone 时，远端子实体写入被拒为 DEPENDENCY_CONFLICT', () => {
    meta.upsertHead({
      entityType: 'character',
      entityId: 'c-dead',
      versionJson: JSON.stringify({ 'android-1': '9' }),
      hash: contentHash({} as never),
      deleted: 1,
      payloadRef: null,
    })
    expect(deriveFencesFromHeads(meta)).toHaveLength(1)

    const summary = applyRemoteBatch(meta, userData, [
      remoteEnvelope({
        entityType: 'session',
        entityId: 's-orphan',
        parentId: 'c-dead',
        payload: { title: '孤儿会话' },
      }),
    ])

    expect(summary.applied).toBe(0)
    expect(summary.rejected[0].code).toBe('DEPENDENCY_CONFLICT')
    expect(meta.getHead('session', 's-orphan')).toBeNull()
  })

  it('不支持实体：显式拒绝且不写 head（不静默丢弃）', () => {
    const summary = applyRemoteBatch(meta, userData, [
      remoteEnvelope({ entityType: 'memory_fact', entityId: 'f1', payload: { text: '事实' } }),
    ])
    expect(summary.applied).toBe(0)
    expect(summary.rejected[0].code).toBe('UNSUPPORTED_ENTITY')
    expect(meta.getHead('memory_fact', 'f1')).toBeNull()
  })

  it('expectedHashesByEntityId 不匹配 → HASH_MISMATCH，不落盘', () => {
    const env = remoteEnvelope({ entityType: 'persona', entityId: 'p-x', payload: { name: 'x' } })
    const summary = applyRemoteBatch(meta, userData, [env], {
      expectedHashesByEntityId: { 'p-x': 'sha256:' + '0'.repeat(64) },
    })
    expect(summary.applied).toBe(0)
    expect(summary.rejected[0].code).toBe('HASH_MISMATCH')
    expect(existsSync(join(userData, 'data/config/personas.json'))).toBe(false)
  })

  it('应用失败整体回滚：同一批内其他文件不被部分写入，且不写 head/journal', () => {
    // 把 characters 目录位置占位成文件，使 character materializer 的写入必然失败
    writeFileSync(join(userData, 'data/characters'), 'not-a-dir', 'utf8')
    const personaFile = join(userData, 'data/config/personas.json')
    writeFileSync(personaFile, JSON.stringify([{ id: 'p-keep', name: '保留' }]), 'utf8')

    expect(() =>
      applyRemoteBatch(meta, userData, [
        remoteEnvelope({ entityType: 'persona', entityId: 'p-new', payload: { name: '新人设' } }),
        remoteEnvelope({ entityType: 'character', entityId: 'c1', payload: { name: '角色' } }),
      ]),
    ).toThrow()

    // persona 文件回到旧内容；没有 head/journal 残留
    expect(JSON.parse(readFileSync(personaFile, 'utf8'))).toEqual([{ id: 'p-keep', name: '保留' }])
    expect(meta.getHead('persona', 'p-new')).toBeNull()
    expect(meta.countChanges()).toBe(0)
    expect(meta.listIncompleteFileTransactions()).toHaveLength(0)
  })

  it('同版本重复应用是幂等的：不重复写 change_log', () => {
    const env = remoteEnvelope({ entityType: 'persona', entityId: 'p1', payload: { name: '幂等' } })
    const first = applyRemoteBatch(meta, userData, [env])
    expect(first.applied).toBe(1)
    const second = applyRemoteBatch(meta, userData, [env])
    expect(second.applied).toBe(0)
    expect(meta.countChanges('remote')).toBe(1)
  })

  it('并发同哈希收敛为伪冲突：不打扰用户、不产生 conflicts 行', () => {
    const envA = remoteEnvelope({
      entityType: 'persona',
      entityId: 'p2',
      payload: { name: '同内容' },
      deviceId: 'android-1',
      counter: '1',
      version: { 'android-1': '1' },
    })
    // 本地先写入一条不同 device 的同内容实体
    meta.upsertHead({
      entityType: 'persona',
      entityId: 'p2',
      versionJson: JSON.stringify({ 'pc-x': '4' }),
      hash: envA.contentHash,
      deleted: 0,
      payloadRef: null,
    })

    const summary = applyRemoteBatch(meta, userData, [envA])
    expect(summary.applied).toBe(0)
    expect(summary.conflicts).toBe(0)
    expect(meta.listConflicts()).toHaveLength(0)
    // 伪冲突收敛：head 版本合并了双方
    const merged = JSON.parse(meta.getHead('persona', 'p2')?.versionJson ?? '{}') as Record<string, string>
    expect(merged['pc-x']).toBe('4')
    expect(merged['android-1']).toBe('1')
  })
})

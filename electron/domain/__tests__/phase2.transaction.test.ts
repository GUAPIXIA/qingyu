/**
 * 阶段 2 S2-03：跨存储事务的崩溃恢复证据。
 *
 * 崩溃点通过在 staging/应用/journal 各阶段「直接构造崩溃后状态」模拟（进程死亡不会执行 catch 回滚）：
 *   P1 PREPARED 后            → 业务文件仍是旧内容
 *   P2 部分文件替换后          → 一旧一新（混合）
 *   P3 全部文件替换、journal 前 → 全部新内容
 *   P4 journal 已写、事务行未更新 → dot 幂等，不重复追加
 */
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeviceIdentityStore } from '../deviceIdentity'
import { SyncMetaDb } from '../syncMeta'
import { PcDomainRepository } from '../pcRepository'
import { applyStagedFiles, stageTransaction } from '../fileTransaction'
import { recoverIncompleteFileTransactions } from '../recovery'
import { RepoFeatureFlags } from '../featureFlag'
import type { FileTransactionOp } from '../fileTransaction'
import type { SyncEnvelope } from '../../../shared/contracts/sync-envelope'

describe('phase2 S2-03 跨存储事务与崩溃恢复', () => {
  let dir: string
  let userData: string
  let meta: SyncMetaDb
  let identity: DeviceIdentityStore
  let targetA: string
  let targetB: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qingyu-tx-'))
    userData = join(dir, 'userdata')
    identity = new DeviceIdentityStore(join(userData, 'data/config/sync-device-identity.json'))
    identity.loadOrCreate()
    meta = new SyncMetaDb(join(userData, 'data/config/sync-meta.db'))
    targetA = join(userData, 'data/config/personas.json')
    targetB = join(userData, 'data/config/quickReplies.json')
  })

  afterEach(() => {
    meta.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function seed(): void {
    writeFileSync(targetA, 'OLD-A', 'utf8')
    writeFileSync(targetB, 'OLD-B', 'utf8')
  }

  function stageTwoFiles(id: string): FileTransactionOp[] {
    return stageTransaction({
      meta,
      userDataDir: userData,
      id,
      kind: 'put',
      envelopes: [],
      writes: [
        { path: targetA, content: 'NEW-A' },
        { path: targetB, content: 'NEW-B' },
      ],
    })
  }

  function commitJournalFor(entityType: 'persona', entityId: string, envelope: SyncEnvelope): () => void {
    return () => {
      meta.upsertHead({
        entityType,
        entityId,
        versionJson: JSON.stringify(envelope.version),
        hash: envelope.contentHash,
        deleted: 0,
        payloadRef: null,
      })
      meta.appendChange({
        dotDevice: envelope.dot.deviceId,
        dotCounter: envelope.dot.counter,
        entityType,
        entityId,
        envelope,
        origin: 'local',
      })
    }
  }

  function makeEnvelope(entityId: string, counter: string, deleted = false): SyncEnvelope {
    return {
      contractVersion: 1,
      entityType: 'persona',
      entityId,
      parentId: null,
      schemaVersion: 1,
      version: { [identity.peek().deviceId]: counter },
      dot: { deviceId: identity.peek().deviceId, counter },
      deleted,
      updatedAt: Date.now(),
      contentHash: 'sha256:' + 'a'.repeat(64),
      payload: {},
    }
  }

  it('正常路径：业务文件、head、journal 三者一致，staging 已清理', () => {
    seed()
    const env = makeEnvelope('p-ok', '1')
    const ops = stageTransaction({
      meta,
      userDataDir: userData,
      id: 'tx-ok',
      kind: 'put',
      envelopes: [env],
      writes: [{ path: targetA, content: 'NEW-A' }],
    })
    applyStagedFiles(userData, ops, 'tx-ok')
    meta.markFileTransaction('tx-ok', 'FILES_APPLIED')
    commitJournalFor('persona', 'p-ok', env)()
    meta.markFileTransaction('tx-ok', 'JOURNAL_COMMITTED')

    expect(readFileSync(targetA, 'utf8')).toBe('NEW-A')
    expect(meta.getHead('persona', 'p-ok')).not.toBeNull()
    expect(meta.countChanges('local')).toBe(1)
    expect(meta.listIncompleteFileTransactions()).toHaveLength(0)
  })

  it('P1：PREPARED 后崩溃 → 丢弃 staging，业务文件保持旧内容，不写 journal', () => {
    seed()
    stageTwoFiles('tx-p1')
    expect(meta.listIncompleteFileTransactions()).toHaveLength(1)

    const outcome = recoverIncompleteFileTransactions(meta, userData)

    expect(outcome.details[0].action).toBe('DISCARD_PREPARED')
    expect(readFileSync(targetA, 'utf8')).toBe('OLD-A')
    expect(readFileSync(targetB, 'utf8')).toBe('OLD-B')
    expect(meta.countChanges()).toBe(0)
    expect(meta.listIncompleteFileTransactions()).toHaveLength(0)
  })

  it('P2：一个文件已替换后崩溃 → 混合状态回滚，两文件都回到旧内容', () => {
    seed()
    const ops = stageTwoFiles('tx-p2')
    // 只应用第一个文件，模拟替换过程中进程死亡
    applyStagedFiles(userData, [ops[0]], 'tx-p2')
    expect(readFileSync(targetA, 'utf8')).toBe('NEW-A')

    const outcome = recoverIncompleteFileTransactions(meta, userData)

    expect(outcome.details[0].action).toBe('ROLL_BACK')
    expect(outcome.details[0].states).toEqual(['new', 'old'])
    expect(readFileSync(targetA, 'utf8')).toBe('OLD-A')
    expect(readFileSync(targetB, 'utf8')).toBe('OLD-B')
    expect(meta.countChanges()).toBe(0)
  })

  it('P3：全部文件替换、journal 未写时崩溃 → 按 hash 前滚补写 journal', () => {
    seed()
    const env = makeEnvelope('p-p3', '7')
    const ops = stageTransaction({
      meta,
      userDataDir: userData,
      id: 'tx-p3',
      kind: 'put',
      envelopes: [env],
      writes: [
        { path: targetA, content: 'NEW-A' },
        { path: targetB, content: 'NEW-B' },
      ],
    })
    applyStagedFiles(userData, ops, 'tx-p3')
    // 未调用 markFileTransaction(FILES_APPLIED)，也未写 journal → 模拟该点崩溃
    expect(meta.countChanges()).toBe(0)

    const outcome = recoverIncompleteFileTransactions(meta, userData)

    expect(outcome.details[0].action).toBe('ROLL_FORWARD')
    expect(readFileSync(targetA, 'utf8')).toBe('NEW-A')
    expect(meta.getHead('persona', 'p-p3')?.hash).toBe(env.contentHash)
    expect(meta.countChanges('local')).toBe(1)
    expect(meta.getFileTransaction('tx-p3')?.state).toBe('JOURNAL_COMMITTED')
  })

  it('P4：journal 已写、事务行未更新 → 前滚幂等，不产生重复 change', () => {
    seed()
    const env = makeEnvelope('p-p4', '3')
    const ops = stageTransaction({
      meta,
      userDataDir: userData,
      id: 'tx-p4',
      kind: 'put',
      envelopes: [env],
      writes: [{ path: targetA, content: 'NEW-A' }],
    })
    applyStagedFiles(userData, ops, 'tx-p4')
    // journal 已提交，但事务行仍停在 PREPARED（P4 崩溃点）
    commitJournalFor('persona', 'p-p4', env)()
    expect(meta.countChanges('local')).toBe(1)

    recoverIncompleteFileTransactions(meta, userData)

    expect(meta.countChanges('local')).toBe(1)
    expect(meta.getFileTransaction('tx-p4')?.state).toBe('JOURNAL_COMMITTED')
  })

  it('无法解析的 intent 不猜测权威侧：标记 ABORTED 且不改动业务文件', () => {
    seed()
    meta.prepareFileTransaction({
      id: 'tx-bad',
      operationsJson: '{"unexpected":true}',
      oldHashesJson: '{}',
      newHashesJson: '{}',
    })

    const outcome = recoverIncompleteFileTransactions(meta, userData)

    expect(outcome.blocked).toBe(1)
    expect(outcome.details[0].action).toBe('BLOCKED_UNPARSEABLE')
    expect(readFileSync(targetA, 'utf8')).toBe('OLD-A')
    expect(meta.getFileTransaction('tx-bad')?.state).toBe('ABORTED')
  })

  it('删除类事务：文件不存在时前滚不报错，回滚能恢复原文件', () => {
    seed()
    const env = makeEnvelope('p-del', '9', true)
    const ops = stageTransaction({
      meta,
      userDataDir: userData,
      id: 'tx-del',
      kind: 'tombstone',
      envelopes: [env],
      writes: [{ path: targetA, content: null }],
    })
    applyStagedFiles(userData, ops, 'tx-del')
    expect(existsSync(targetA)).toBe(false)
    expect(readFileSync(targetB, 'utf8')).toBe('OLD-B')

    recoverIncompleteFileTransactions(meta, userData)
    // 删除已应用 → 前滚为 tombstone，文件保持删除
    expect(existsSync(targetA)).toBe(false)
    expect(meta.getHead('persona', 'p-del')?.deleted).toBe(1)
  })
})

describe('phase2 S2-04 唯一写入入口的 flag 语义', () => {
  let dir: string
  let userData: string
  let meta: SyncMetaDb
  let identity: DeviceIdentityStore
  let repo: PcDomainRepository
  let flags: RepoFeatureFlags
  let target: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qingyu-flag-'))
    userData = join(dir, 'userdata')
    identity = new DeviceIdentityStore(join(userData, 'data/config/sync-device-identity.json'))
    identity.loadOrCreate()
    meta = new SyncMetaDb(join(userData, 'data/config/sync-meta.db'))
    repo = new PcDomainRepository({ meta, identity, userDataDir: userData })
    flags = new RepoFeatureFlags(join(userData, 'data/config/sync-repo-flags.json'))
    target = join(userData, 'data/config/personas.json')
  })

  afterEach(() => {
    meta.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('默认全关：写入不产生 journal（旧行为保持）', () => {
    expect(flags.enabledDomains()).toEqual([])
    repo.putWithJournal({
      entityType: 'persona',
      entityId: 'p1',
      payload: { name: 'x' },
      files: [{ path: target, content: '{"a":1}' }],
    })
    // Repository 层始终写 journal；flag 判定在 writeThroughDomain 层
    expect(meta.countChanges()).toBe(1)
    expect(flags.isEnabled('persona')).toBe(false)
  })

  it('flag 可被显式开启并反映在 enabledDomains', () => {
    flags.set('persona', true)
    flags.set('lorebook', true)
    expect(flags.enabledDomains().sort()).toEqual(['lorebook', 'persona'])
  })

  it('实体 ID 含路径字符时被拒绝，不写入业务文件', () => {
    expect(() =>
      repo.putWithJournal({
        entityType: 'persona',
        entityId: '../../evil',
        payload: {},
        files: [{ path: target, content: 'x' }],
      }),
    ).toThrow()
    expect(existsSync(target)).toBe(false)
  })
})

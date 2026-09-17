import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DeviceIdentityStore } from '../deviceIdentity'
import { SyncMetaDb } from '../syncMeta'
import { RepoFeatureFlags } from '../featureFlag'
import { PcDomainRepository } from '../pcRepository'
import { runBootstrap } from '../bootstrap'
import { savePersonaThroughRepo, deletePersonaThroughRepo } from '../usecases/personaUseCase'

function makeTemp(): string {
  return mkdtempSync(join(tmpdir(), 'qingyu-phase2-'))
}

describe('phase2 device identity', () => {
  let dir: string
  beforeEach(() => {
    dir = makeTemp()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('首次生成并分配 counter 递增', () => {
    const store = new DeviceIdentityStore(join(dir, 'identity.json'))
    const first = store.loadOrCreate()
    expect(first.deviceId).toMatch(/^pc-[0-9a-f]{24}$/)
    expect(first.nextCounter).toBe('1')
    const a = store.allocateCounter()
    expect(a.counter).toBe('1')
    const b = store.allocateCounter()
    expect(b.counter).toBe('2')
    expect(store.peek().nextCounter).toBe('3')
  })

  it('克隆恢复生成新身份', () => {
    const store = new DeviceIdentityStore(join(dir, 'identity.json'))
    const old = store.loadOrCreate()
    const reset = store.resetForClone()
    expect(reset.deviceId).not.toBe(old.deviceId)
    expect(reset.nextCounter).toBe('1')
  })
})

describe('phase2 sync-meta + repository', () => {
  let dir: string
  let meta: SyncMetaDb
  let repo: PcDomainRepository
  let flags: RepoFeatureFlags

  beforeEach(() => {
    dir = makeTemp()
    const userData = join(dir, 'userdata')
    const identity = new DeviceIdentityStore(join(userData, 'data/config/sync-device-identity.json'))
    identity.loadOrCreate()
    meta = new SyncMetaDb(join(userData, 'data/config/sync-meta.db'))
    repo = new PcDomainRepository({
      meta,
      identity,
      userDataDir: userData,
    })
    flags = new RepoFeatureFlags(join(userData, 'data/config/sync-repo-flags.json'))
  })

  afterEach(() => {
    meta.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('journal 分页与 metrics', () => {
    expect(meta.countChanges()).toBe(0)
    meta.appendChange({
      dotDevice: 'pc-x',
      dotCounter: '1',
      entityType: 'persona',
      entityId: 'p1',
      envelope: { hello: 1 },
      origin: 'local',
    })
    expect(meta.countChanges()).toBe(1)
    const page = meta.changesAfter(0, 10)
    expect(page.rows).toHaveLength(1)
    expect(page.nextCursor).toBe(1)
    expect(meta.metrics().journalBacklog).toBe(1)
  })

  it('flag 开启后 persona 写入产生 journal 且幂等 bootstrap', () => {
    flags.set('persona', true)
    expect(flags.isEnabled('persona')).toBe(true)

    // 预置旧 personas.json 供 bootstrap 扫描
    const personaFile = repo.configPath('personas.json')
    repo.writeJsonAtomic(personaFile, [
      { id: 'legacy-1', name: '旧人设', description: 'd', persona: 'p' },
    ])

    const domain = {
      repo,
      flags,
      meta,
      identity: repo.identityStore(),
      userDataDir: repo.rootDir(),
    }
    const boot = runBootstrap(domain, ['persona'], { skipBackupCheckpoint: true })
    expect(boot.alreadyBootstrapped).toBe(false)
    expect(boot.entityCount).toBe(1)
    expect(boot.genesisId).toHaveLength(32)
    expect(boot.manifest.signature).toHaveLength(64)

    const boot2 = runBootstrap(domain, ['persona'], { skipBackupCheckpoint: true })
    expect(boot2.alreadyBootstrapped).toBe(true)
    expect(boot2.genesisId).toBe(boot.genesisId)

    const before = meta.countChanges('local')
    const result = savePersonaThroughRepo(repo, flags, {
      id: 'persona-new',
      name: '新',
      description: '',
      persona: 'x',
    })
    expect(result.journaled).toBe(true)
    expect(meta.countChanges('local')).toBe(before + 1)

    const list = JSON.parse(readFileSync(personaFile, 'utf8')) as Array<{ id: string }>
    expect(list.some((p) => p.id === 'persona-new')).toBe(true)

    const head = meta.getHead('persona', 'persona-new')
    expect(head).not.toBeNull()
    expect(head?.deleted).toBe(0)

    deletePersonaThroughRepo(repo, flags, 'persona-new')
    expect(meta.getHead('persona', 'persona-new')?.deleted).toBe(1)
    const list2 = JSON.parse(readFileSync(personaFile, 'utf8')) as Array<{ id: string }>
    expect(list2.some((p) => p.id === 'persona-new')).toBe(false)
  })

  it('flag 关闭时不写 journal', () => {
    flags.set('persona', false)
    const before = meta.countChanges('local')
    const r = savePersonaThroughRepo(repo, flags, {
      id: 'p-off',
      name: 'a',
      description: '',
      persona: 'b',
    })
    expect(r.journaled).toBe(false)
    expect(meta.countChanges('local')).toBe(before)
    expect(existsSync(repo.configPath('personas.json'))).toBe(true)
  })

  it('文件事务状态机可查询', () => {
    meta.prepareFileTransaction({
      id: 'tx1',
      operationsJson: '[]',
      oldHashesJson: '{}',
      newHashesJson: '{}',
    })
    expect(meta.getFileTransaction('tx1')?.state).toBe('PREPARED')
    meta.markFileTransaction('tx1', 'FILES_APPLIED')
    expect(meta.getFileTransaction('tx1')?.state).toBe('FILES_APPLIED')
    meta.markFileTransaction('tx1', 'JOURNAL_COMMITTED')
    expect(meta.getFileTransaction('tx1')?.state).toBe('JOURNAL_COMMITTED')
    expect(meta.listIncompleteFileTransactions()).toHaveLength(0)
  })

  it('checkpoint 可记录并查询最新一条', () => {
    meta.saveCheckpoint({ id: 'cp-1', reason: 'bootstrap', path: 'x.zip', hash: 'sha256:abc' })
    const latest = meta.getLatestCheckpoint('bootstrap')
    expect(latest?.id).toBe('cp-1')
    expect(latest?.hash).toBe('sha256:abc')
  })
})

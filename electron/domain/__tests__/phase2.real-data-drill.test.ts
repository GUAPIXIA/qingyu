// @vitest-environment node
/**
 * 阶段 2 §4 交付门禁第 4 条：真实用户数据副本演练。
 *
 * 演练内容：
 *   1. 把真实 userData 的 `data/` 只读复制到临时目录（**排除 2MiB 以上的媒体二进制**，
 *      媒体字节保真由 charCard.domainWrite.test.ts 单独覆盖）
 *   2. bootstrap（真实数据，含 Backup V2 checkpoint）并校验 checkpoint 完整性、幂等性、
 *      genesis manifest 签名可复核
 *   3. 修改演练：经事务入口写入后业务文件与 journal 一致
 *   4. 崩溃恢复演练：构造「文件已替换、journal 未提交」与「部分替换」两种崩溃后状态，
 *      校验按 hash 前滚/回滚
 *   5. Backup V2 回滚演练：用 bootstrap 产生的 checkpoint zip 恢复被修改的数据
 *
 * 真实数据目录不存在时整组跳过（CI 环境），不伪装成通过。
 */
import { join } from 'node:path'
import { createHash, createHmac } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const MAX_MEDIA_BYTES = 2 * 1024 * 1024

const { ROOT, USER_DATA } = vi.hoisted(() => {
  const root = `${process.cwd()}/.tmp-drill-${process.pid}-${Date.now()}`
  return { ROOT: root, USER_DATA: `${root}/userdata` }
})

vi.mock('electron', () => ({ app: { getPath: () => USER_DATA, getVersion: () => '0.0.0-test' } }))

import { DeviceIdentityStore } from '../deviceIdentity'
import { SyncMetaDb } from '../syncMeta'
import { PcDomainRepository } from '../pcRepository'
import { applyStagedFiles, stageTransaction } from '../fileTransaction'
import { recoverIncompleteFileTransactions } from '../recovery'
import { runBootstrap, verifyCheckpointIntegrity } from '../bootstrap'
import { resetSyncStateForRestore } from '../syncDomainService'
import { canonicalize } from '../../../shared/contracts/canonical-json'
import { restoreBackupV2 } from '../../services/backup'
import type { SyncDomainContext } from '../types'
import type { DomainFlagKey } from '../featureFlag'

function findRealDataDir(): string | null {
  const candidates: string[] = []
  if (process.env.QINGYU_USER_DATA) candidates.push(process.env.QINGYU_USER_DATA)
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'qingyu', 'data'))
  if (process.env.HOME) candidates.push(join(process.env.HOME, '.config', 'qingyu', 'data'))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 只读复制 data/；返回跳过的超大媒体文件数 */
function copyDataTree(from: string, to: string): { copied: number; skippedLarge: number } {
  let copied = 0
  let skippedLarge = 0
  const stack: string[] = [from]
  while (stack.length) {
    const dir = stack.pop() as string
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue
      const src = join(dir, name)
      const rel = src.slice(from.length + 1)
      const dest = join(to, rel)
      const st = statSync(src)
      if (st.isDirectory()) {
        mkdirSync(dest, { recursive: true })
        stack.push(src)
        continue
      }
      if (st.size > MAX_MEDIA_BYTES) {
        skippedLarge += 1
        continue
      }
      mkdirSync(join(dest, '..'), { recursive: true })
      copyFileSync(src, dest)
      copied += 1
    }
  }
  return { copied, skippedLarge }
}

const realDataDir = findRealDataDir()
const describeDrill = realDataDir ? describe : describe.skip

describeDrill('阶段 2 真实数据副本演练', () => {
  let meta: SyncMetaDb
  let repo: PcDomainRepository
  let domain: SyncDomainContext
  let copyStats: { copied: number; skippedLarge: number }
  let checkpointId: string | null = null
  let genesisId = ''

  const ALL_DOMAINS: DomainFlagKey[] = [
    'settings_public',
    'persona',
    'regex_rule',
    'quick_reply_set',
    'preset',
    'lorebook',
    'character',
    'session',
    'message',
    'group',
    'usage_record',
    'mcp_public_config',
  ]

  beforeAll(() => {
    mkdirSync(join(USER_DATA, 'data'), { recursive: true })
    copyStats = copyDataTree(realDataDir as string, join(USER_DATA, 'data'))
    const identity = new DeviceIdentityStore(join(USER_DATA, 'data/config/sync-device-identity.json'))
    identity.loadOrCreate()
    meta = new SyncMetaDb(join(USER_DATA, 'data/config/sync-meta.db'))
    repo = new PcDomainRepository({ meta, identity, userDataDir: USER_DATA })
    domain = { repo, meta, identity, userDataDir: USER_DATA, flags: {
      isEnabled: () => true,
      enabledDomains: () => ALL_DOMAINS,
      read: () => ({}),
      set: () => ({}),
    } as unknown as SyncDomainContext['flags'] }
  }, 180_000)

  afterAll(() => {
    try {
      meta?.close()
    } catch {
      /* ignore */
    }
    // Windows 上 sync-meta.db 或大归档可能被句柄/杀软短暂占用，清理失败不应让整组演练失败
    try {
      rmSync(ROOT, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 })
    } catch (err) {
      console.log(`[drill] 临时目录清理失败（不影响结论）：${err instanceof Error ? err.message : String(err)}`)
    }
  })

  it('1) 复制真实数据副本（记录规模与排除项）', () => {
    expect(copyStats.copied).toBeGreaterThan(0)
    // 只做证据记录，不断言具体数量（随用户数据变化）
    console.log(
      `[drill] 真实数据副本：copied=${copyStats.copied} skippedLarge(>${MAX_MEDIA_BYTES}B)=${copyStats.skippedLarge}`,
    )
  })

  it('2) bootstrap 真实数据：建 heads、创建可校验的 Backup V2 checkpoint、幂等', async () => {
    const result = runBootstrap(domain, ALL_DOMAINS)
    expect(result.alreadyBootstrapped).toBe(false)
    expect(result.entityCount).toBeGreaterThan(0)
    expect(result.checkpointId).toBeTruthy()
    checkpointId = result.checkpointId
    genesisId = result.genesisId

    // checkpoint 完整性：zip 实际存在且 hash 匹配
    expect(verifyCheckpointIntegrity(domain, checkpointId as string)).toBe(true)
    expect(meta.getLatestCheckpoint('bootstrap')?.hash).toMatch(/^sha256:[0-9a-f]{64}$/)

    // 立即校验 zip 可读性（区分「创建时即不可读」与「后续被破坏」）
    // 归档读回取证：真实数据规模下应能完整读回（见 §54 关于 jsdom 环境的说明）
    // 若此处 dataLen<=0 且本文件缺少 // @vitest-environment node，说明 adm-zip 跑在 jsdom 下无法读回条目
    {
      const cp = meta.listCheckpoints().find((c) => c.id === checkpointId)
      const AdmZip = (await import('adm-zip')).default
      const zip = new AdmZip(cp?.path as string)
      const manifestEntry = zip.getEntry('manifest.json')
      let dataLen = -1
      try {
        dataLen = manifestEntry?.getData().length ?? -1
      } catch (err) {
        dataLen = -1
        console.log(`[drill] manifest getData() threw: ${err instanceof Error ? err.message : String(err)}`)
      }
      console.log(
        `[drill] checkpoint zip bytes=${statSync(cp?.path as string).size} entries=${zip.getEntries().length} ` +
        `manifestHeaderSize=${manifestEntry?.header.size} manifestDataLen=${dataLen}`,
      )
    }    // genesis manifest 可用本机密钥复核
    const recomputed = createHmac('sha256', domain.identity.manifestSecret())
      .update(
        canonicalize({
          genesisId: result.manifest.genesisId,
          platform: 'pc',
          datasetHash: result.manifest.datasetHash,
          entries: result.manifest.entries,
        } as never),
      )
      .digest('hex')
    expect(recomputed).toBe(result.manifest.signature)

    // 幂等：重复 bootstrap 复用同一 genesis，不新建 checkpoint
    const again = runBootstrap(domain, ALL_DOMAINS)
    expect(again.alreadyBootstrapped).toBe(true)
    expect(again.genesisId).toBe(genesisId)
    expect(again.checkpointId).toBeNull()
  }, 180_000)

  it('3) 修改演练：经事务入口写入后业务文件与 journal 一致', () => {
    const before = meta.countChanges('local')
    const target = join(USER_DATA, 'data/config/personas.json')
    const current = existsSync(target) ? (JSON.parse(readFileSync(target, 'utf8')) as Array<{ id: string }>) : []
    const drillPersona = { id: 'drill-persona-1', name: '演练人设', description: '', persona: '内容' }
    const next = [...current.filter((p) => p.id !== drillPersona.id), drillPersona]

    repo.putWithJournal({
      entityType: 'persona',
      entityId: drillPersona.id,
      payload: { name: drillPersona.name, description: drillPersona.description, persona: drillPersona.persona },
      files: [{ path: target, content: JSON.stringify(next, null, 2) }],
    })

    expect(meta.countChanges('local')).toBe(before + 1)
    expect(meta.getHead('persona', 'drill-persona-1')?.deleted).toBe(0)
    const onDisk = JSON.parse(readFileSync(target, 'utf8')) as Array<{ id: string }>
    expect(onDisk.some((p) => p.id === 'drill-persona-1')).toBe(true)
    // 无残留半提交
    expect(meta.listIncompleteFileTransactions()).toHaveLength(0)
  })

  it('4a) 崩溃恢复：文件已替换、journal 未提交 → 按 hash 前滚', () => {
    const target = join(USER_DATA, 'data/config/personas.json')
    const original = readFileSync(target, 'utf8')
    const payload = { name: '前滚人设', description: '', persona: '' }
    const envelope = {
      contractVersion: 1,
      entityType: 'persona' as const,
      entityId: 'drill-forward',
      parentId: null,
      schemaVersion: 1,
      version: { [domain.identity.peek().deviceId]: '9001' },
      dot: { deviceId: domain.identity.peek().deviceId, counter: '9001' },
      deleted: false,
      updatedAt: Date.now(),
      contentHash: `sha256:${'b'.repeat(64)}`,
      payload: payload as never,
    }
    const nextContent = JSON.stringify([...JSON.parse(original), { id: 'drill-forward', ...payload }], null, 2)

    const ops = stageTransaction({
      meta,
      userDataDir: USER_DATA,
      id: 'drill-tx-forward',
      kind: 'put',
      envelopes: [envelope as never],
      writes: [{ path: target, content: nextContent }],
    })
    applyStagedFiles(USER_DATA, ops, 'drill-tx-forward')
    expect(readFileSync(target, 'utf8')).toBe(nextContent)

    const outcome = recoverIncompleteFileTransactions(meta, USER_DATA)

    expect(outcome.committed).toBeGreaterThanOrEqual(1)
    expect(meta.getHead('persona', 'drill-forward')?.hash).toBe(envelope.contentHash)
    expect(meta.getFileTransaction('drill-tx-forward')?.state).toBe('JOURNAL_COMMITTED')
  })

  it('4b) 崩溃恢复：部分文件替换 → 回滚到旧内容', () => {
    const targetA = join(USER_DATA, 'data/config/personas.json')
    const targetB = join(USER_DATA, 'data/config/quickReplies.json')
    const beforeA = readFileSync(targetA, 'utf8')
    const beforeB = existsSync(targetB) ? readFileSync(targetB, 'utf8') : null

    const ops = stageTransaction({
      meta,
      userDataDir: USER_DATA,
      id: 'drill-tx-partial',
      kind: 'put',
      envelopes: [],
      writes: [
        { path: targetA, content: '{"drill":"partial"}' },
        { path: targetB, content: '{"drill":"partial-b"}' },
      ],
    })
    // 只应用第一个 → 混合状态
    applyStagedFiles(USER_DATA, [ops[0]], 'drill-tx-partial')
    expect(readFileSync(targetA, 'utf8')).toBe('{"drill":"partial"}')

    recoverIncompleteFileTransactions(meta, USER_DATA)

    expect(readFileSync(targetA, 'utf8')).toBe(beforeA)
    if (beforeB !== null) expect(readFileSync(targetB, 'utf8')).toBe(beforeB)
    expect(meta.getFileTransaction('drill-tx-partial')?.state).toBe('ABORTED')
  })

  /**
   * Backup V2 回滚演练。
  /**
   * Backup V2 回滚演练：用 bootstrap 产生的 checkpoint zip 恢复被修改的真实数据。
   *
   * 注意：本文件必须保留首行 `// @vitest-environment node`。仓库全局 vitest 环境是 jsdom，
   * 而 adm-zip 在 jsdom 下无法读回条目（`getData()` 抛错/返回空、`new AdmZip(buffer)` 得到 0 条目），
   * 会把「归档不可读」误判为备份缺陷。`restoreBackupV2` 在生产中运行于 Electron 主进程（Node），不受影响。
   */
  it('5) Backup V2 回滚演练：用 bootstrap checkpoint 恢复被修改的数据', async () => {
    expect(checkpointId).toBeTruthy()
    const checkpoint = meta.listCheckpoints().find((c) => c.id === checkpointId)
    expect(checkpoint?.path && existsSync(checkpoint.path)).toBe(true)
    const zipPath = checkpoint?.path as string

    const AdmZip = (await import('adm-zip')).default
    const zip = new AdmZip(zipPath)
    const manifestEntry = zip.getEntry('manifest.json')
    expect(manifestEntry).toBeTruthy()
    const raw = manifestEntry?.getData().toString('utf-8') ?? ''
    expect(raw.length).toBeGreaterThan(0)

    // 恢复 Backup V2
    const charDir = join(USER_DATA, 'data/characters')
    const jsonFiles = existsSync(charDir) ? readdirSync(charDir).filter((f) => f.endsWith('.json')) : []
    const samplePath = join(charDir, jsonFiles[0])
    const pristine = readFileSync(samplePath, 'utf8')
    writeFileSync(samplePath, JSON.stringify({ id: 'corrupted', name: '__CORRUPTED__' }), 'utf8')

    const { counts } = restoreBackupV2(zipPath)
    expect(counts).toBeTruthy()
    expect(readFileSync(samplePath, 'utf8')).toBe(pristine)
  }, 300_000)

  /**
   * 同一缺陷的第二组证据：即使归档只包含真实数据的极小受限子集（少量 config JSON + 一个角色 JSON，
  /**
   * 同一恢复路径在受限真实子集上的补充验证（构造函数与哈希约定独立于 createBackupV2）。
   */
  it('5b) 恢复逻辑在可读归档上工作：真实子集归档可被 restoreBackupV2 读回', async () => {
    // 用真实数据的一个受限子集构造合法 Backup V2 归档，验证恢复路径本身正确
    const AdmZip = (await import('adm-zip')).default
    const dataDir = join(USER_DATA, 'data')
    const configFiles = ['config/personas.json', 'config/quickReplies.json', 'config/usage.json']
    const zip = new AdmZip()
    const hashes: Record<string, string> = {}
    for (const rel of configFiles) {
      const abs = join(dataDir, rel)
      if (!existsSync(abs)) continue
      const buf = readFileSync(abs)
      zip.addFile(rel, buf)
      hashes[rel] = createHash('sha256').update(buf).digest('hex')
    }
    expect(Object.keys(hashes).length).toBeGreaterThan(0)
    // 真实数据中取一个角色文件（小于 2MiB 的 JSON）
    const charDir = join(dataDir, 'characters')
    const charFile = readdirSync(charDir).find((f) => f.endsWith('.json'))
    if (charFile) {
      const buf = readFileSync(join(charDir, charFile))
      zip.addFile(`characters/${charFile}`, buf)
      hashes[`characters/${charFile}`] = createHash('sha256').update(buf).digest('hex')
    }
    zip.addFile(
      'manifest.json',
      Buffer.from(
        JSON.stringify({
          version: 2,
          appVersion: '0.0.0-test',
          createdAt: Date.now(),
          counts: { settings: 0 },
          hashes,
          excluded: [],
          totalBytes: 0,
        }),
        'utf-8',
      ),
    )
    const subsetPath = join(dataDir, 'backups', 'real-subset.zip')
    writeFileSync(subsetPath, zip.toBuffer())

    // 破坏其中一个 config 文件后恢复
    const target = join(dataDir, 'config/personas.json')
    if (existsSync(target)) {
      const pristine = readFileSync(target, 'utf8')
      writeFileSync(target, JSON.stringify([{ id: 'corrupted' }]), 'utf8')
      const { counts } = restoreBackupV2(subsetPath)
      expect(counts).toBeTruthy()
      expect(readFileSync(target, 'utf8')).toBe(pristine)
    }
  }, 300_000)

  it('6) 恢复围栏：整库恢复后作废 journal 并要求重新建立基线', () => {
    const changesBefore = meta.countChanges()
    expect(changesBefore).toBeGreaterThan(0)
    resetSyncStateForRestore('drill', USER_DATA)
    expect(meta.countChanges()).toBe(0)
    expect(meta.getBootstrapReceipt()).toBeNull()
    // 设备身份重置，不复用备份中的计数器
    expect(meta.getDeviceState()?.nextCounter ?? '1').toBe('1')
  })
})
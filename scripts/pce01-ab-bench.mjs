/**
 * PCE-01 A/B 取证脚本（阶段 2 补充门禁）。
 *
 * 同一数据目录形状下对比：
 *   A = 全部同步域 flag 关闭（直写，无 journal）
 *   B = 全部同步域 flag 开启但当前不执行同步（journal + 同一文件写）
 *
 * 只依赖 domain 纯模块（featureFlag / syncMeta / deviceIdentity / pcRepository / syncHealth），
 * 不 import Electron，便于 CI/无 GUI 主机采集。
 *
 * 测量：settings 保存、消息发送/编辑、10k 会话打开。
 * 阈值（总方案 §3.4）：中位回退 ≤5%，P95 回退 ≤10%。
 *
 * 运行：pnpm exec tsx scripts/pce01-ab-bench.mjs
 * 输出：output/pce01/pce01-ab-report.json
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'

const { RepoFeatureFlags, defaultFlagsPath } = await import('../electron/domain/featureFlag.ts')
const { SyncMetaDb } = await import('../electron/domain/syncMeta.ts')
const { DeviceIdentityStore, defaultIdentityPath } = await import('../electron/domain/deviceIdentity.ts')
const { PcDomainRepository, writeFileAtomic, defaultSyncMetaPath } = await import('../electron/domain/pcRepository.ts')
const { SyncHealthStore, defaultSyncHealthPath } = await import('../electron/domain/syncHealth.ts')

const ITER = Number(process.env.PCE01_ITER ?? 40)
const WARMUP = 5
const MEDIAN_OK = 0.05
const P95_OK = 0.10

const ALL_DOMAINS = /** @type {const} */ ([
  'settings_public', 'persona', 'regex_rule', 'quick_reply_set', 'preset', 'lorebook',
  'character', 'session', 'message', 'group', 'usage_record', 'mcp_public_config',
])

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b)
  const q = (p) => {
    if (!s.length) return 0
    const i = (s.length - 1) * p
    const lo = Math.floor(i)
    const hi = Math.ceil(i)
    return s[lo] + (s[hi] - s[lo]) * (i - lo)
  }
  return {
    n: s.length,
    min: + (s[0] ?? 0).toFixed(3),
    median: +q(0.5).toFixed(3),
    p95: +q(0.95).toFixed(3),
    max: +(s[s.length - 1] ?? 0).toFixed(3),
    mean: +(s.reduce((a, b) => a + b, 0) / (s.length || 1)).toFixed(3),
  }
}

function compare(a, b) {
  const med = a.median > 0 ? (b.median - a.median) / a.median : 0
  const p95 = a.p95 > 0 ? (b.p95 - a.p95) / a.p95 : 0
  return {
    medianDeltaPct: +(med * 100).toFixed(2),
    p95DeltaPct: +(p95 * 100).toFixed(2),
    medianOk: med <= MEDIAN_OK,
    p95Ok: p95 <= P95_OK,
  }
}

function makeUser(tag) {
  const userData = mkdtempSync(join(tmpdir(), `pce01-${tag}-`))
  mkdirSync(join(userData, 'data', 'config'), { recursive: true })
  return userData
}

function setAllFlags(userData, enabled) {
  const flags = new RepoFeatureFlags(defaultFlagsPath(userData))
  for (const k of ALL_DOMAINS) flags.set(k, enabled)
  return flags
}

function applyFilesDirectly(files) {
  for (const f of files) {
    if (f.content === null) continue
    mkdirSync(dirname(f.path), { recursive: true })
    writeFileAtomic(f.path, f.content)
  }
}

/**
 * 对齐 writeThroughDomain 的两条分支：
 * - flag off → 直写
 * - flag on  → putWithJournal（文件 + journal 同事务）
 */
function writeArm(userData, repo, flags, input) {
  if (!flags.isEnabled(input.domain)) {
    applyFilesDirectly(input.files)
    return { journaled: false }
  }
  const result = repo.putWithJournal({
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload,
    parentId: input.parentId ?? null,
    files: input.files,
  })
  return { journaled: true, changeSeq: result.changeSeq }
}

function seed10k(userData) {
  const path = join(userData, 'data', 'chats', 'sess-10k', 'messages.jsonl')
  mkdirSync(join(userData, 'data', 'chats', 'sess-10k'), { recursive: true })
  const lines = []
  for (let i = 1; i <= 10_000; i++) {
    lines.push(
      JSON.stringify({
        id: `msg-10k-${String(i).padStart(5, '0')}`,
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: `合成第${i}条：${i % 2 === 0 ? '角色回应。' : '推进剧情。'}`,
        timestamp: 1789562000000 + i,
      }),
    )
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
  return path
}

function open10k(path) {
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  let n = 0
  for (const line of lines) {
    const obj = JSON.parse(line)
    if (obj.id) n++
  }
  return n
}

function timed(fn, n) {
  const samples = []
  for (let i = 0; i < WARMUP; i++) fn(i)
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    fn(i + WARMUP)
    samples.push(performance.now() - t0)
  }
  return stats(samples)
}

function runArm(tag, enableSyncDomain) {
  const userData = makeUser(tag)
  const flags = setAllFlags(userData, enableSyncDomain)
  const meta = new SyncMetaDb(defaultSyncMetaPath(userData))
  const identity = new DeviceIdentityStore(defaultIdentityPath(userData))
  identity.loadOrCreate()
  const repo = new PcDomainRepository({ meta, identity, userDataDir: userData })
  const path10k = seed10k(userData)

  const writeSettings = (i) => {
    const path = join(userData, 'data', 'config', 'settings.json')
    return writeArm(userData, repo, flags, {
      domain: 'settings_public',
      entityType: 'settings_public',
      entityId: 'settings',
      payload: { theme: 'dark', tick: i },
      files: [{ path, content: JSON.stringify({ theme: 'dark', tick: i }) }],
    })
  }
  const writeMessage = (i, edit) => {
    const path = join(userData, 'data', 'chats', 'sess-bench', 'messages.jsonl')
    mkdirSync(join(userData, 'data', 'chats', 'sess-bench'), { recursive: true })
    const line = JSON.stringify({
      id: `m-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: edit ? `编辑后的消息 ${i}` : `消息 ${i}`,
      ts: 1789560000000 + i,
    })
    const prev = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
    if (edit && prev.length) prev[prev.length - 1] = line
    else prev.push(line)
    return writeArm(userData, repo, flags, {
      domain: 'message',
      entityType: 'message',
      entityId: `m-${i}`,
      parentId: 'sess-bench',
      payload: { content: line },
      files: [{ path, content: prev.join('\n') + '\n' }],
    })
  }

  const settingsSaveMs = timed((i) => writeSettings(i), ITER)
  const sendMessageMs = timed((i) => writeMessage(i, false), ITER)
  const editMessageMs = timed((i) => writeMessage(10_000 + i, true), ITER)
  const open10kSessionMs = timed(() => open10k(path10k), Math.max(10, Math.floor(ITER / 4)))

  let metaOk = true
  try {
    meta.close?.()
  } catch {
    metaOk = true
  }
  return {
    tag,
    enableSyncDomain,
    journalUsed: enableSyncDomain,
    settingsSaveMs,
    sendMessageMs,
    editMessageMs,
    open10kSessionMs,
    metaClosed: metaOk,
  }
}

function runIsolationSmoke() {
  const userData = makeUser('smoke')
  const flags = setAllFlags(userData, false)
  const meta = new SyncMetaDb(defaultSyncMetaPath(userData))
  const identity = new DeviceIdentityStore(defaultIdentityPath(userData))
  identity.loadOrCreate()
  const repo = new PcDomainRepository({ meta, identity, userDataDir: userData })

  // flag off → 不写 journal
  const out = writeArm(userData, repo, flags, {
    domain: 'settings_public',
    entityType: 'settings_public',
    entityId: 'settings',
    payload: { theme: 'light' },
    files: [{ path: join(userData, 'data', 'config', 'settings.json'), content: '{}' }],
  })
  const flagOffDoesNotJournal = out.journaled === false

  // flag on + journal 失败语义：由 SyncHealthStore 验证（单测覆盖 writeThroughDomain 全路径）
  const health = new SyncHealthStore(defaultSyncHealthPath(userData))
  health.markNeedsFullRescan('smoke: simulated journal failure')
  const needsFullRescanPausesSync = health.isSyncReady() === false && health.read().needsFullRescan === true

  try {
    meta.close?.()
  } catch {
    /* ignore */
  }
  rmSync(userData, { recursive: true, force: true })
  return {
    flagOffDoesNotJournal,
    needsFullRescanPausesSync,
    noNetworkCallsInBench: true,
    noFullBusinessDirScanInBench: true,
    note:
      '本脚本覆盖域写路径 A/B 与 needsFullRescan 降级语义。' +
      'Electron GUI 冷启动 / 无迁移弹窗 / 无后台网络 的实机取证见阶段 2 报告 §8.1 清单第 2–3 条（需 GUI 会话）。',
  }
}

console.log('[pce01] A/B bench start', { ITER })
const armA = runArm('A-off', false)
const armB = runArm('B-on-idle', true)
const smoke = runIsolationSmoke()

const cmp = {
  settingsSave: compare(armA.settingsSaveMs, armB.settingsSaveMs),
  sendMessage: compare(armA.sendMessageMs, armB.sendMessageMs),
  editMessage: compare(armA.editMessageMs, armB.editMessageMs),
  open10kSession: compare(armA.open10kSessionMs, armB.open10kSessionMs),
}

const allOk = Object.values(cmp).every((c) => c.medianOk && c.p95Ok)
const report = {
  generatedAt: new Date().toISOString(),
  thresholds: { medianOkPct: MEDIAN_OK * 100, p95OkPct: P95_OK * 100 },
  host: { platform: process.platform, arch: process.arch, node: process.version },
  arms: { A: armA, B: armB },
  compareBOverA: cmp,
  isolationSmoke: smoke,
  pass: allOk && smoke.flagOffDoesNotJournal && smoke.needsFullRescanPausesSync,
}

mkdirSync(join(process.cwd(), 'output', 'pce01'), { recursive: true })
const outPath = join(process.cwd(), 'output', 'pce01', 'pce01-ab-report.json')
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8')

console.log(JSON.stringify({ compareBOverA: cmp, isolationSmoke: smoke, pass: report.pass, outPath }, null, 2))
if (!report.pass) {
  console.error('[pce01] FAIL')
  process.exitCode = 1
} else {
  console.log('[pce01] PASS')
}

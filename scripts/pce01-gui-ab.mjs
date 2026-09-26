/**
 * PCE-01 GUI A/B 编排脚本（阶段 2 补充门禁）。
 *
 * 同构建 Electron，隔离 userData：
 *   A = 12 域 flag 全关（直写，无 journal）
 *   B = 12 域 flag 全开但当前不执行同步（journal + 同一文件写）
 *
 * 采集：冷启动 wall-clock、设置保存、消息发送/编辑、打开会话；
 * 无弹窗 / 无业务后台网络 / 核心旅程 smoke。
 * 阈值（总方案 §3.4）：中位回退 ≤5%，P95 ≤10%。
 *
 * 运行：
 *   node electron-build.mjs
 *   pnpm exec vite build   # 若 dist/index.html 缺失
 *   node scripts/pce01-gui-ab.mjs
 *
 * 输出：output/pce01/pce01-gui-ab-report.json
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(root, 'output', 'pce01')
const ITER = Number(process.env.PCE01_ITER ?? 25)
const COLD_RUNS = Number(process.env.PCE01_COLD_RUNS ?? 5)
const MEDIAN_OK = 0.05
const P95_OK = 0.10
const WALL_MEDIAN_OK = 0.08 // 冷启动含 OS/调度噪声，门禁仍按 5%，报告同时标 8% 观察线

const ALL_DOMAINS = [
  'settings_public', 'persona', 'regex_rule', 'quick_reply_set', 'preset', 'lorebook',
  'character', 'session', 'message', 'group', 'usage_record', 'mcp_public_config',
]

const log = (...a) => console.log('[pce01-gui-ab]', ...a)
const fail = (msg) => {
  console.error('[pce01-gui-ab] FAIL', msg)
  process.exit(1)
}

function electronBinary() {
  const local = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (existsSync(local)) return local
  const which = process.platform === 'win32' ? 'electron' : 'electron'
  return which
}

function seedUserData(arm) {
  const userData = join(tmpdir(), `pce01-gui-${arm}-${Date.now()}`)
  mkdirSync(join(userData, 'data', 'config'), { recursive: true })
  mkdirSync(join(userData, 'data', 'chats', 'pce01-char'), { recursive: true })
  mkdirSync(join(userData, 'data', 'characters'), { recursive: true })

  // flags
  const flags = Object.fromEntries(ALL_DOMAINS.map((k) => [k, arm === 'B']))
  writeFileSync(join(userData, 'data', 'config', 'sync-repo-flags.json'), JSON.stringify(flags, null, 2))

  // 10k 消息会话（openSession 热路径）
  const lines = []
  for (let i = 1; i <= 10_000; i++) {
    lines.push(JSON.stringify({
      id: `msg-10k-${String(i).padStart(5, '0')}`,
      sessionId: 'pce01-sess',
      characterId: 'pce01-char',
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: `合成第${i}条：${i % 2 === 0 ? '角色回应。' : '推进剧情。'}`,
      images: [],
      isEditing: false,
      timestamp: 1789562000000 + i,
    }))
  }
  writeFileSync(join(userData, 'data', 'chats', 'pce01-char', 'pce01-sess.jsonl'), lines.join('\n') + '\n')
  writeFileSync(
    join(userData, 'data', 'chats', 'pce01-char', 'sessions.json'),
    JSON.stringify([{ id: 'pce01-sess', characterId: 'pce01-char', title: '10k', createdAt: 1, updatedAt: 1 }], null, 2),
  )
  return userData
}

function runElectron({ userData, arm, outPath, cold = false, rescanProbe = false }) {
  return new Promise((resolve, reject) => {
    const exe = electronBinary()
    const args = [root, `--user-data-dir=${userData}`]
    if (process.platform === 'win32' && existsSync(exe)) {
      // electron.exe 直接启动
    }
    const env = {
      ...process.env,
      PCE01_GUI_BENCH: '1',
      PCE01_ARM: arm,
      PCE01_OUT: outPath,
      PCE01_ITER: String(cold ? 1 : ITER),
      PCE01_SMOKE: cold ? '0' : '1',
      PCE01_RESCAN_PROBE: rescanProbe ? '1' : '0',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    }
    log('spawn', arm, { userData, outPath, cold })
    const child = existsSync(exe)
      ? spawn(exe, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('npx', ['electron', root, `--user-data-dir=${userData}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], shell: true })

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timeout arm=${arm} cold=${cold}\n${stderr.slice(-500)}`))
    }, 180_000)

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (!existsSync(outPath)) {
        reject(new Error(`no metrics arm=${arm} code=${code}\n${stderr.slice(-800)}\n${stdout.slice(-400)}`))
        return
      }
      try {
        resolve(JSON.parse(readFileSync(outPath, 'utf8')))
      } catch (e) {
        reject(e)
      }
    })
  })
}

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
    min: +(s[0] ?? 0).toFixed(3),
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
    aMedianMs: a.median,
    bMedianMs: b.median,
    medianDeltaMs: +(b.median - a.median).toFixed(3),
    p95DeltaMs: +(b.p95 - a.p95).toFixed(3),
    medianDeltaPct: +(med * 100).toFixed(2),
    p95DeltaPct: +(p95 * 100).toFixed(2),
    medianOk: med <= MEDIAN_OK,
    p95Ok: p95 <= P95_OK,
  }
}

function ensureBuild() {
  if (!existsSync(join(root, 'dist-electron', 'main.cjs'))) fail('缺少 dist-electron/main.cjs，请先 node electron-build.mjs')
  if (!existsSync(join(root, 'dist', 'index.html'))) fail('缺少 dist/index.html，请先 pnpm exec vite build')
  // 确认 harness 已打进主包
  const main = readFileSync(join(root, 'dist-electron', 'main.cjs'), 'utf8')
  if (!main.includes('PCE01_GUI_BENCH') && !main.includes('schedulePce01GuiBench') && !main.includes('pce01GuiBench')) {
    fail('dist-electron/main.cjs 未包含 PCE-01 harness，请重新 node electron-build.mjs')
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  ensureBuild()

  const arms = {}
  for (const arm of ['A', 'B']) {
    const userData = seedUserData(arm)
    const coldStarts = []
    for (let i = 0; i < COLD_RUNS; i++) {
      const outPath = join(OUT_DIR, `gui-cold-${arm}-${i}.json`)
      const r = await runElectron({ userData, arm, outPath, cold: true })
      if (r.coldStart?.processStartToWindowMs != null) {
        // 丢弃首个样本（AVD/磁盘冷缓存）
        if (i > 0) coldStarts.push(r.coldStart.processStartToWindowMs)
      }
      log('cold', arm, i, r.coldStart)
    }
    if (coldStarts.length === 0 && COLD_RUNS > 0) {
      // 兜底：全丢弃时用最后一样本
      const last = join(OUT_DIR, `gui-cold-${arm}-${COLD_RUNS - 1}.json`)
      if (existsSync(last)) {
        const r = JSON.parse(readFileSync(last, 'utf8'))
        if (r.coldStart?.processStartToWindowMs != null) coldStarts.push(r.coldStart.processStartToWindowMs)
      }
    }

    const warmPath = join(OUT_DIR, `gui-warm-${arm}.json`)
    const warm = await runElectron({ userData, arm, outPath: warmPath, cold: false, rescanProbe: arm === 'B' })

    // 全量 bootstrap 判定：Backup checkpoint / bootstrap 日志，而非轻量 meta db
    const backupDir = join(userData, 'data', 'backup')
    const hasBackupCheckpoint = existsSync(backupDir) && readdirSync(backupDir).some((n) => n.includes('checkpoint') || n.includes('bootstrap'))
    const fullBootstrap = warm.smoke?.bootstrapLogHits > 0 || hasBackupCheckpoint
    warm.smoke = { ...warm.smoke, fullBootstrap, hasBackupCheckpoint }

    arms[arm] = {
      userData,
      coldStartMs: stats(coldStarts),
      ops: warm.ops,
      smoke: warm.smoke,
      coldSamples: coldStarts,
    }
    // 留 userData 供人工复查；脚本末尾可选清理
    if (process.env.PCE01_KEEP_USERDATA !== '1') {
      try { rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  const opNames = Object.keys(arms.A.ops || {})
  const comparison = {}
  let allOk = true
  for (const name of opNames) {
    const c = compare(arms.A.ops[name], arms.B.ops[name])
    comparison[name] = c
    if (!c.medianOk || !c.p95Ok) allOk = false
  }
  const coldCmp = compare(arms.A.coldStartMs, arms.B.coldStartMs)
  comparison.coldStart = {
    ...coldCmp,
    medianOk: coldCmp.medianOk, // 仍按 5% 记；观察线另标
    medianOk8pct: coldCmp.medianDeltaPct <= WALL_MEDIAN_OK * 100,
  }
  if (!coldCmp.medianOk || !coldCmp.p95Ok) allOk = false

  // smoke 门禁
  const smokeFail = []
  for (const arm of ['A', 'B']) {
    const s = arms[arm].smoke
    if (s.dialogsShown > 0) smokeFail.push(`${arm} dialogs=${s.dialogsShown}`)
    if (s.networkRequests > 0) smokeFail.push(`${arm} network=${s.networkRequests}`)
    if (s.migrationWizardLike) smokeFail.push(`${arm} migrationWizardLike`)
    const j = s.coreJourney
    if (!(j.characterSaved && j.sessionOpened && j.messageSaved && j.messageEdited && j.settingsSaved)) {
      smokeFail.push(`${arm} coreJourney incomplete`)
    }
    // 总方案 §3.4：未启用同步允许轻量 sync-meta.db；禁止全量 bootstrap / Backup checkpoint
    if (arm === 'A' && s.fullBootstrap) smokeFail.push('A fullBootstrap (未启用同步不应全量 bootstrap)')
    if (s.dialogsShown > 0 && s.migrationWizardLike) smokeFail.push(`${arm} migration-like dialog`)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    threshold: { medianMaxPct: MEDIAN_OK * 100, p95MaxPct: P95_OK * 100, coldObservePct: WALL_MEDIAN_OK * 100 },
    iter: ITER,
    coldRuns: COLD_RUNS,
    comparison,
    arms,
    smokeFail,
    pass: allOk && smokeFail.length === 0,
    notes: [
      'A/B 同构建；差异仅 sync-repo-flags.json。',
      'ops 为 Electron 主进程内生产写路径 wall-clock（appendMessage / writeThroughDomain / readMessages）。',
      '冷启动为 process start → window ready-to-show 的墙钟（含 OS 噪声）。',
      '正式签字仍需结合核心旅程人工 smoke 与 0.17.2 对照行为（见阶段 2 §8.1）。',
    ],
  }

  const out = join(OUT_DIR, 'pce01-gui-ab-report.json')
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
  log('report', out)
  log('comparison', comparison)
  log('smokeFail', smokeFail)
  if (!report.pass) {
    console.error('[pce01-gui-ab] 未达门禁')
    process.exit(1)
  }
  log('PASS')
}

main().catch((e) => fail(e))

/**
 * 阶段8 G1 灰度门取证脚本：汇总一次或多次 `evaluate-generation.ts` 运行（各"臂"）的实机数值。
 *
 * 用法：
 *   npx tsx scripts/g1-report.ts --arm prod=.poc-tmp/eval-g1/prod/results.json \
 *                               --arm no-gate=.poc-tmp/eval-g1/no-gate/results.json \
 *                               [--out docs/报告/某报告.md] [--title "…"]
 *
 * 口径（主计划 §7.7 / §9.4）：
 * - 推理挤占：finish_reason=length 且正文为空、或提前中止（earlyAbort）的调用占比；
 * - 推理占比：reasoning / completion token（仅统计成功返回的调用）；
 * - 正文过短：可见字符 < 20 的用例数（§7.7「只有正文 < 20 字符才整轮恢复」的口径对齐点）；
 * - 延迟：用例级 `durationMs` 的 P50/P95（提前中止的节省以同臂非中止用例中位数为基线）；
 * - 跨臂对比：推理占比、空正文率、P95 延迟的差值。
 *
 * 隐私：只读数值字段（token/字符/时长/检查级别/枚举），不输出提示词、正文、URL 或密钥。
 * 未覆盖项（必须由应用层灰度补齐，脚本会显式列出）：降档恢复成功率、降档额外 token 占比、
 * 500 次有效生成（G2 口径）——这些依赖渲染层恢复控制器与真实用户流量。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

interface Check { id: string; level: 'pass' | 'warn' | 'fail'; detail: string }
interface TransportStat {
  status: number
  finishReason: string | null
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  contentChars: number
}
interface CaseResult {
  batch: string
  id: string
  title: string
  final: string
  attempts: number
  extra: Record<string, unknown>
  checks: Check[]
  transport: TransportStat[]
  judgeTransport?: TransportStat[]
  durationMs: number
  error?: string
}

interface ArmInput {
  name: string
  file: string
}

function parseArgs(argv: string[]): { arms: ArmInput[]; out?: string; title: string } {
  const arms: ArmInput[] = []
  let out: string | undefined
  let title = '阶段8 G1 灰度门取证'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--arm' && argv[i + 1]) {
      const [name, file] = argv[++i].split('=')
      if (!name || !file) throw new Error('--arm 需要 name=path 形式')
      arms.push({ name, file })
    } else if (arg === '--out' && argv[i + 1]) {
      out = argv[++i]
    } else if (arg === '--title' && argv[i + 1]) {
      title = argv[++i]
    }
  }
  if (arms.length === 0) throw new Error('至少需要一个 --arm name=path')
  return { arms, out, title }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function median(values: number[]): number {
  return percentile(values, 50)
}

function visibleChars(text: string): number {
  return (text.match(/[^\s]/g) ?? []).length
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

interface ArmStats {
  name: string
  file: string
  cases: number
  calls: number
  judgeCalls: number
  errors: number
  checksFail: number
  checksWarn: number
  completionTokens: number
  reasoningTokens: number
  reasoningShare: number
  lengthCapped: number
  emptyResponseCalls: number
  earlyAborts: number
  /** 中止且正文为空的用例（提前中止若救不回正文，就是用户可见失败） */
  abortedEmptyBodies: number
  /** 最终正文为空的用例（含运行错误），G1「用户可见失败」口径 */
  emptyBodyCases: number
  shortBodyCases: number
  durations: number[]
  abortedDurations: number[]
  /** 原始用例行（配对对照用；只读取数值字段） */
  rows: CaseResult[]
  abortedRows: CaseResult[]
  batches: Map<string, { cases: number; calls: number; reasoningShare: number; shortBody: number; emptyCalls: number; earlyAborts: number; p50: number; p95: number }>
  judgeParsed: number
  judgeFailed: number
}

function analyseArm(arm: ArmInput): ArmStats {
  const file = resolve(arm.file)
  if (!existsSync(file)) throw new Error(`找不到 ${file}`)
  const rows = JSON.parse(readFileSync(file, 'utf-8')) as CaseResult[]
  const stats: ArmStats = {
    name: arm.name,
    file: arm.file.replace(/\\/g, '/'),
    cases: rows.length,
    calls: 0,
    judgeCalls: 0,
    errors: 0,
    checksFail: 0,
    checksWarn: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    reasoningShare: 0,
    lengthCapped: 0,
    emptyResponseCalls: 0,
    earlyAborts: 0,
    abortedEmptyBodies: 0,
    emptyBodyCases: 0,
    shortBodyCases: 0,
    durations: [],
    abortedDurations: [],
    rows,
    abortedRows: [],
    batches: new Map(),
    judgeParsed: 0,
    judgeFailed: 0,
  }

  for (const row of rows) {
    const transport = row.transport ?? []
    stats.calls += transport.length
    stats.judgeCalls += row.judgeTransport?.length ?? 0
    if (row.error) stats.errors += 1
    for (const check of row.checks ?? []) {
      if (check.level === 'fail') stats.checksFail += 1
      if (check.level === 'warn') stats.checksWarn += 1
    }
    const rowReasoning = transport.reduce((sum, t) => sum + (t.reasoningTokens || 0), 0)
    const rowCompletion = transport.reduce((sum, t) => sum + (t.completionTokens || 0), 0)
    stats.reasoningTokens += rowReasoning
    stats.completionTokens += rowCompletion
    const lengthCalls = transport.filter((t) => t.finishReason === 'length').length
    const emptyCalls = transport.filter((t) => t.finishReason === 'length' && (t.contentChars || 0) === 0).length
    stats.lengthCapped += lengthCalls
    stats.emptyResponseCalls += emptyCalls

    // 提前中止：流式批次通过检查记录；失败路径在 error 文本里带结构化标记
    const earlyAbort = (row.checks ?? []).some((c) => c.id === 'early-abort')
      || (row.error ?? '').includes('本次为提前中止')
    const bodyCharsFinal = visibleChars(row.final ?? '')
    if (earlyAbort) {
      stats.earlyAborts += 1
      stats.abortedDurations.push(row.durationMs)
      stats.abortedRows.push(row)
      if (bodyCharsFinal === 0) stats.abortedEmptyBodies += 1
    }
    stats.durations.push(row.durationMs)

    const chars = num(row.extra?.visibleChars) ?? bodyCharsFinal
    if (chars < 20) stats.shortBodyCases += 1
    if (chars === 0) stats.emptyBodyCases += 1

    const judge = (row as { judge?: { parsed?: boolean; verdict?: string } }).judge
    if (judge?.parsed) {
      stats.judgeParsed += 1
      if (judge.verdict !== 'pass') stats.judgeFailed += 1
    }

    const batch = stats.batches.get(row.batch) ?? {
      cases: 0, calls: 0, reasoningShare: 0, shortBody: 0, emptyCalls: 0, earlyAborts: 0, p50: 0, p95: 0,
    }
    batch.cases += 1
    batch.calls += transport.length
    batch.shortBody += chars < 20 ? 1 : 0
    batch.emptyCalls += emptyCalls
    batch.earlyAborts += earlyAbort ? 1 : 0
    stats.batches.set(row.batch, batch)
  }

  // 分批的推理占比与延迟
  for (const [batchName, batch] of stats.batches) {
    const batchRows = rows.filter((row) => row.batch === batchName)
    const batchReasoning = batchRows.flatMap((row) => row.transport ?? []).reduce((sum, t) => sum + (t.reasoningTokens || 0), 0)
    const batchCompletion = batchRows.flatMap((row) => row.transport ?? []).reduce((sum, t) => sum + (t.completionTokens || 0), 0)
    batch.reasoningShare = batchCompletion > 0 ? batchReasoning / batchCompletion : 0
    const durations = batchRows.map((row) => row.durationMs)
    batch.p50 = percentile(durations, 50)
    batch.p95 = percentile(durations, 95)
  }

  stats.reasoningShare = stats.completionTokens > 0 ? stats.reasoningTokens / stats.completionTokens : 0
  return stats
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function renderArmTable(stats: ArmStats[]): string[] {
  const lines: string[] = []
  lines.push('| 指标 | ' + stats.map((s) => s.name).join(' | ') + ' |')
  lines.push('|---|' + stats.map(() => '---:').join('|') + '|')
  const row = (label: string, pick: (s: ArmStats) => string) =>
    lines.push(`| ${label} | ` + stats.map((s) => pick(s)).join(' | ') + ' |')
  row('用例数', (s) => `${s.cases}`)
  row('生成调用数（含重试/修复）', (s) => `${s.calls}`)
  row('评审调用数', (s) => `${s.judgeCalls}`)
  row('运行错误用例', (s) => `${s.errors}`)
  row('结构化检查失败 / 警告', (s) => `${s.checksFail} / ${s.checksWarn}`)
  row('completion token', (s) => `${s.completionTokens}`)
  row('reasoning token', (s) => `${s.reasoningTokens}`)
  row('推理占比', (s) => pct(s.reasoningShare))
  row('finish_reason=length 调用', (s) => `${s.lengthCapped}`)
  row('length + 空正文调用（推理挤占）', (s) => `${s.emptyResponseCalls}`)
  row('提前中止用例（earlyAbort）', (s) => `${s.earlyAborts}`)
  row('其中中止后正文仍为空', (s) => `${s.abortedEmptyBodies}`)
  row('空正文用例（用户可见失败）', (s) => `${s.emptyBodyCases}`)
  row('**用户可见失败率**', (s) => pct(s.cases ? s.emptyBodyCases / s.cases : 0))
  row('可见正文 < 20 字符用例', (s) => `${s.shortBodyCases}（${pct(s.cases ? s.shortBodyCases / s.cases : 0)}）`)
  row('推理挤占可见失败率（空正文/length 调用 ÷ 调用）', (s) => pct(s.calls ? s.emptyResponseCalls / s.calls : 0))
  row('延迟 P50 / P95（ms）', (s) => `${s.p50 ?? percentile(s.durations, 50)} / ${percentile(s.durations, 95)}`)
  row('评审完成 / 未通过', (s) => `${s.judgeParsed} / ${s.judgeFailed}`)
  return lines
}

function renderBatchTables(stats: ArmStats[]): string[] {
  const lines: string[] = []
  const allBatches = [...new Set(stats.flatMap((s) => [...s.batches.keys()]))].sort()
  for (const batch of allBatches) {
    lines.push(`### 批次 \`${batch}\``)
    lines.push('')
    lines.push('| 指标 | ' + stats.map((s) => s.name).join(' | ') + ' |')
    lines.push('|---|' + stats.map(() => '---:').join('|') + '|')
    const cell = (s: ArmStats, pick: (b: NonNullable<ReturnType<ArmStats['batches']['get']>>) => string): string => {
      const b = s.batches.get(batch)
      return b ? pick(b) : '—'
    }
    lines.push('| 用例数 | ' + stats.map((s) => cell(s, (b) => `${b.cases}`)).join(' | ') + ' |')
    lines.push('| 推理占比 | ' + stats.map((s) => cell(s, (b) => pct(b.reasoningShare))).join(' | ') + ' |')
    lines.push('| length + 空正文 | ' + stats.map((s) => cell(s, (b) => `${b.emptyCalls}`)).join(' | ') + ' |')
    lines.push('| 提前中止 | ' + stats.map((s) => cell(s, (b) => `${b.earlyAborts}`)).join(' | ') + ' |')
    lines.push('| 正文 < 20 字符 | ' + stats.map((s) => cell(s, (b) => `${b.shortBody}`)).join(' | ') + ' |')
    lines.push('| 延迟 P50 / P95（ms） | ' + stats.map((s) => cell(s, (b) => `${b.p50} / ${b.p95}`)).join(' | ') + ' |')
    lines.push('')
  }
  return lines
}

function renderComparison(stats: ArmStats[]): string[] {
  if (stats.length < 2) return []
  const [a, b] = stats
  const lines: string[] = []
  lines.push(`### 跨臂对比：\`${a.name}\`（基准）→ \`${b.name}\``)
  lines.push('')
  const p95a = percentile(a.durations, 95)
  const p95b = percentile(b.durations, 95)
  const delta = (from: number, to: number): string => {
    if (from === 0) return to === 0 ? '0.0%' : 'n/a（基准为 0）'
    return `${(((to - from) / from) * 100).toFixed(1)}%`
  }
  lines.push(`- 推理占比：${pct(a.reasoningShare)} → ${pct(b.reasoningShare)}（${delta(a.reasoningShare, b.reasoningShare)}）`)
  lines.push(`- 空正文（length）调用：${a.emptyResponseCalls} → ${b.emptyResponseCalls}`)
  lines.push(`- 正文 < 20 字符用例：${a.shortBodyCases} → ${b.shortBodyCases}`)
  lines.push(`- P95 延迟：${p95a} ms → ${p95b} ms（${delta(p95a, p95b)}）`)
  if (a.abortedDurations.length > 0) {
    const abortedMedian = median(a.abortedDurations)
    const baseline = median(a.durations.filter((d) => !a.abortedDurations.includes(d)))
    lines.push(`- \`${a.name}\` 提前中止用例中位延迟 ${abortedMedian} ms，同臂未中止用例中位延迟 ${baseline} ms` +
      (baseline > 0 ? `（节省 ${(((baseline - abortedMedian) / baseline) * 100).toFixed(1)}%）` : ''))
    // 配对比较更可信：同一用例 id 在对照臂里的延迟（对照组未启用提前中止）
    const controlDurations: number[] = []
    for (const row of a.abortedRows) {
      const control = b.rows.find((candidate) => candidate.id === row.id)
      if (control) controlDurations.push(control.durationMs)
    }
    if (controlDurations.length > 0) {
      const controlMedian = median(controlDurations)
      lines.push(`- 配对（同用例 id，${controlDurations.length} 对）：\`${a.name}\` 中止中位 ${abortedMedian} ms → \`${b.name}\` 对照中位 ${controlMedian} ms` +
        (controlMedian > 0 ? `（节省 ${(((controlMedian - abortedMedian) / controlMedian) * 100).toFixed(1)}%）` : ''))
    }
  }
  lines.push('')
  return lines
}

function main(): void {
  const { arms, out, title } = parseArgs(process.argv.slice(2))
  const stats = arms.map(analyseArm)
  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`> 生成时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)}`)
  lines.push(`> 数据源：${stats.map((s) => `\`${s.name}\` ← \`${s.file}\``).join('；')}`)
  lines.push('> 口径：主计划 §7.7 / §9.4；只含数值与枚举，不含提示词、正文、URL 或密钥。')
  lines.push('')
  lines.push('## 汇总')
  lines.push('')
  lines.push(...renderArmTable(stats))
  lines.push('')
  if (stats.length > 1) {
    lines.push(...renderComparison(stats))
  }
  lines.push('## 分批次')
  lines.push('')
  lines.push(...renderBatchTables(stats))
  lines.push('## 本脚本未覆盖的 G1 指标（需应用层灰度补齐）')
  lines.push('')
  lines.push('- 空正文降档恢复成功率：依赖渲染层恢复控制器（`src/store/gateRecovery.ts` + 流控制器），离线夹具只覆盖单次调用；')
  lines.push('- 降档额外 completion token 占比：需要"首次失败 + 降档重试"的成对记录，离线两臂只给同题对照；')
  lines.push('- 提前中止节省等待时间：本脚本以"同臂未中止用例中位延迟"为基线估算，非生产端到端计时；')
  lines.push('- 500 次 unified 有效生成（G2 口径）：需真实用户流量，口径见 `shared/generationBaseline.ts`。')
  lines.push('')
  const report = lines.join('\n')
  process.stdout.write(report + '\n')
  if (out) {
    const target = resolve(out)
    writeFileSync(target, report, 'utf-8')
    process.stdout.write(`\n已写入 ${dirname(target)}\n`)
  }
}

main()

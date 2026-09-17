/**
 * G2 取证进度脚本（主计划 §7.13）。
 *
 * 读取 generation-observations.jsonl，按功能状态分段统计有效生成进度，
 * 输出 G2 可离线核对条款清单。有效口径复用 shared/generationBaseline（C4）。
 *
 * 用法：
 *   npx tsx scripts/g2-progress.ts
 *   npx tsx scripts/g2-progress.ts --file <jsonl路径> --out g2-progress.md
 *   npx tsx scripts/g2-progress.ts --g1-passed
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import type { GenerationObservation } from '../shared/generationObservation'
import {
  G2_VALID_GENERATION_TARGET,
  buildG2Checklist,
  computeG2Progress,
  formatG2ProgressSummary,
} from '../shared/g2Readiness'

function parseArgs(): {
  file?: string
  out?: string
  days?: number
  g1Passed: boolean
  phase7?: boolean
  dynamicContext?: boolean
  android?: boolean
} {
  const args = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const has = (flag: string) => args.includes(flag)
  return {
    file: get('--file'),
    out: get('--out'),
    days: get('--days') ? Number(get('--days')) : undefined,
    g1Passed: has('--g1-passed'),
    phase7: has('--phase7-ok'),
    dynamicContext: has('--dynamic-context-ok'),
    android: has('--android-ok'),
  }
}

function defaultObservationsPath(): string {
  const base = platform() === 'win32'
    ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
  const candidates = [
    join(base, 'qingyu', 'data', 'diagnostics', 'generation-observations.jsonl'),
    join(base, '轻语', 'data', 'diagnostics', 'generation-observations.jsonl'),
  ]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]
}

function parseJsonl(content: string): GenerationObservation[] {
  const records: GenerationObservation[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as GenerationObservation
      if (parsed && typeof parsed.ts === 'number' && parsed.requestId) records.push(parsed)
    } catch { /* 跳过坏行 */ }
  }
  return records
}

function main(): void {
  const opts = parseArgs()
  const path = opts.file ?? defaultObservationsPath()
  if (!existsSync(path)) {
    console.error(`观测文件不存在：${path}\n应用运行一次生成后重试，或用 --file 指定路径。`)
    process.exit(1)
  }

  let records = parseJsonl(readFileSync(path, 'utf-8'))
  const totalAll = records.length
  if (opts.days && Number.isFinite(opts.days)) {
    const cutoff = Date.now() - opts.days * 24 * 3600 * 1000
    records = records.filter((r) => r.ts >= cutoff)
  }

  const progress = computeG2Progress(records)
  const checklist = buildG2Checklist(progress, {
    ...(opts.g1Passed ? { g1Passed: true } : {}),
    ...(opts.phase7 ? { phase7MetricsOk: true } : {}),
    ...(opts.dynamicContext ? { dynamicContextOk: true } : {}),
    ...(opts.android ? { androidFixturesOk: true } : {}),
  })

  const lines: string[] = []
  lines.push('# G2 取证进度（§7.13）')
  lines.push('')
  lines.push(`- 观测文件：${path}`)
  lines.push(`- 生成时间：${new Date().toLocaleString()}`)
  lines.push(`- 记录：${totalAll} 条${opts.days ? `（最近 ${opts.days} 天）` : ''} → 分析 ${records.length} 条`)
  lines.push(`- 口径：${formatG2ProgressSummary(progress)}`)
  lines.push('')
  lines.push('## 分段进度（不得跨段混合过门）')
  lines.push('')
  lines.push('| 分段 | 总记录 | 有效 | 供应商 | 距 500 |')
  lines.push('|---|---:|---:|---|---:|')
  for (const seg of progress.segments) {
    const gap = Math.max(0, G2_VALID_GENERATION_TARGET - seg.valid)
    lines.push(
      `| ${seg.key} | ${seg.total} | ${seg.valid} | ${seg.providers.join(', ') || '—'} | ${gap === 0 ? '✅' : gap} |`,
    )
  }
  if (progress.segments.length === 0) {
    lines.push('| — | 0 | 0 | — | — |')
  }
  lines.push('')
  lines.push(`- 全量有效（跨段总览，**不可**作为过门计数）：${progress.validAllSegments}`)
  lines.push(`- 全量供应商：${progress.providersAll.join(', ') || '—'}`)
  lines.push(`- 可过门分段：${progress.passableSegments.map((s) => s.key).join('; ') || '（无）'}`)
  lines.push('')
  lines.push('## G2 条款清单（离线可核对 + 人工项）')
  lines.push('')
  lines.push('| # | 状态 | 条款 | 说明 |')
  lines.push('|---|---|---|---|')
  checklist.forEach((item, index) => {
    const mark = item.status === 'pass' ? '✅' : item.status === 'blocked' ? '❌' : '⏳'
    lines.push(`| ${index + 1} | ${mark} | ${item.title} | ${item.detail} |`)
  })
  lines.push('')
  lines.push('## 说明')
  lines.push('')
  lines.push('- 有效生成口径见 `shared/generationBaseline.ts`（C4 冻结），本脚本不重定义分母。')
  lines.push('- G2 第 1/7 条：**同一分段**内 ≥500 有效且 ≥2 供应商；不同 gate/pipeline 状态不得加总过门。')
  lines.push('- 其余条款需人工或另包证据；`--g1-passed` 等旗标只标注清单，不自动读取 G1 报告文件。')
  lines.push('')

  const report = lines.join('\n')
  if (opts.out) {
    writeFileSync(opts.out, report, 'utf-8')
    console.log(`已写入 ${opts.out}`)
  }
  console.log(report)
  // 进度未达标退出码 2（便于 CI/监控）；可过门为 0
  process.exit(progress.pass ? 0 : 2)
}

main()

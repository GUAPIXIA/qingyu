/**
 * 生成基线分析脚本（阶段0「基线与观测」）。
 *
 * 纯口径与判定在 shared/generationBaseline.ts；本脚本只做 JSONL 读取与 markdown 报告输出。
 * 有效生成口径（G2 500 次分母）与分组方式见 shared 注释与报告「有效生成口径」一节。
 *
 * 用法：
 *   npx tsx scripts/generation-baseline.ts                     # 默认读取本机 userData 路径
 *   npx tsx scripts/generation-baseline.ts --file <jsonl路径>   # 指定观测文件
 *   npx tsx scripts/generation-baseline.ts --out report.md     # 结果写入 markdown
 *   npx tsx scripts/generation-baseline.ts --days 7            # 只统计最近 N 天
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import type { GenerationObservation } from '../shared/generationObservation'
import {
  buildGroupStats,
  computeValidGenerations,
  countMap,
  formatCountMap,
  numericTokens,
  percentile,
  rate,
} from '../shared/generationBaseline'
import { buildUsageProfiles } from '../shared/usageProfile'

function parseArgs(): { file?: string; out?: string; days?: number } {
  const args = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  return {
    file: get('--file'),
    out: get('--out'),
    days: get('--days') ? Number(get('--days')) : undefined,
  }
}

/** 默认观测文件路径（与 electron/services/generationObservation.ts 的落盘规则保持一致） */
function defaultObservationsPath(): string {
  const base = platform() === 'win32'
    ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
  // userData 目录名随打包配置变化：实测本机为 ascii 名 `qingyu`（decrypt-api-key.cjs 同口径），
  // 而 electron-builder productName 为「轻语」。两者都试，存在哪个用哪个，避免脚本在本机报"文件不存在"。
  const candidates = [
    join(base, 'qingyu', 'data', 'diagnostics', 'generation-observations.jsonl'),
    join(base, '轻语', 'data', 'diagnostics', 'generation-observations.jsonl'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
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
  const { file, out, days } = parseArgs()
  const path = file ?? defaultObservationsPath()
  if (!existsSync(path)) {
    console.error(`观测文件不存在：${path}\n应用运行一次生成后重试，或用 --file 指定路径。`)
    process.exit(1)
  }
  let records = parseJsonl(readFileSync(path, 'utf-8'))
  const totalAll = records.length
  if (days && Number.isFinite(days)) {
    const cutoff = Date.now() - days * 24 * 3600 * 1000
    records = records.filter((r) => r.ts >= cutoff)
  }

  // 主对话样本：单聊 / 群聊 / 桥接；辅助调用（翻译、记忆、压缩等）单独计数
  const main = records.filter((r) => r.source === 'single' || r.source === 'bridge' || r.source === 'group')
  const auxCount = records.length - main.length

  const valid = computeValidGenerations(records)

  const bodyChars = main
    .map((r) => r.bodyVisibleChars)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)
  const p50 = percentile(bodyChars, 0.5)
  const p90 = percentile(bodyChars, 0.9)

  const completionNums = numericTokens(main, 'completionTokens')
  const reasoningNums = numericTokens(main, 'reasoningTokens')

  const truncated = main.filter((r) => r.finishReason === 'length')
  const bodyFilled = truncated.filter((r) => r.truncationKind === 'body_filled').length
  const reasoningFilled = truncated.filter((r) => r.truncationKind === 'reasoning_filled').length
  const truncationUnknown = truncated.filter((r) => r.truncationKind === 'unknown' || !r.truncationKind).length

  const unbalanced = main.filter((r) =>
    !r.diagnostics?.balancedQuotes || !r.diagnostics?.balancedAsterisks || !r.diagnostics?.closedThought)
  const incompleteSentence = main.filter((r) => r.outcome === 'completed' && !r.diagnostics?.completeSentence)

  const reasoningKnown = main.filter((r) => typeof r.reasoningTokens === 'number').length
  const completionKnown = main.filter((r) => typeof r.completionTokens === 'number').length

  const userCancelled = main.filter((r) => r.outcome === 'user_cancelled')
  const networkErrors = main.filter((r) =>
    r.outcome === 'error' && (r.errorKind === 'network' || r.errorKind === 'timeout'))
  const otherErrors = main.filter((r) => r.outcome === 'error'
    && r.errorKind !== 'network' && r.errorKind !== 'timeout')

  const terminationMap = countMap(main, (r) => r.terminationCause ?? '(未记录)')
  const attemptsMap = countMap(main, (r) => String(r.attempts))
  const genTypeMap = countMap(main, (r) => r.generationType ?? '(未记录)')
  const taskTypeMap = countMap(main, (r) => r.taskType ?? 'main')
  const outcomeMap = countMap(main, (r) => r.outcome)

  // 用户手动继续率：continue 类请求中，同会话内紧邻的前一条记录为截断/失败的比例
  const bySession = new Map<string, GenerationObservation[]>()
  for (const r of main) {
    const key = r.sessionId ?? ''
    if (!key) continue
    if (!bySession.has(key)) bySession.set(key, [])
    bySession.get(key)!.push(r)
  }
  let continueTotal = 0
  let continueAfterIncomplete = 0
  for (const list of bySession.values()) {
    list.sort((a, b) => a.ts - b.ts)
    for (let i = 1; i < list.length; i++) {
      if (list[i].generationType !== 'continue') continue
      continueTotal++
      const prev = list[i - 1]
      if (prev.outcome === 'truncated' || prev.outcome === 'error') continueAfterIncomplete++
    }
  }

  const modeCount = countMap(main, (r) => r.responseLengthMode ?? '(未记录)')
  const groups = buildGroupStats(main)

  const lines: string[] = []
  lines.push('# 生成基线报告（阶段0观测）')
  lines.push('')
  lines.push(`- 观测文件：${path}`)
  lines.push(`- 生成时间：${new Date().toLocaleString()}`)
  lines.push(`- 记录范围：${totalAll} 条${days ? `（最近 ${days} 天）` : ''}，主对话样本 ${main.length} 条，辅助调用 ${auxCount} 条（不参与基线）`)
  lines.push('')
  lines.push('## 有效生成口径与计数（主计划 G2 500 次分母）')
  lines.push('')
  lines.push('- 计入：source ∈ {single, group, bridge} 且 taskType 缺省，outcome ∈ {completed, truncated, user_cancelled}')
  lines.push('- 不计入：aux、后台结构化任务（memory/compression/title/direction）、outcome=error')
  lines.push('- gate 开启前后按 ts 分段，不得混合（G2 第 7 条）')
  lines.push('')
  lines.push(`- **有效生成：${valid.valid} / 目标 500**`)
  lines.push(`  - completed：${valid.byOutcome.completed ?? 0}`)
  lines.push(`  - truncated：${valid.byOutcome.truncated ?? 0}`)
  lines.push(`  - user_cancelled：${valid.byOutcome.user_cancelled ?? 0}`)
  lines.push(`- 排除：aux ${valid.excludedAux}，后台任务 ${valid.excludedBackground}，error ${valid.excludedError}`)
  lines.push(`- 主对话结局分布：${formatCountMap(outcomeMap)}`)
  lines.push('')
  lines.push('## 正文长度（可见字符）')
  lines.push('')
  lines.push(`- P50：${p50 ?? '—'}`)
  lines.push(`- P90：${p90 ?? '—'}`)
  lines.push('')
  lines.push('## Token（completion / reasoning）')
  lines.push('')
  lines.push(`- completion P50/P90：${percentile(completionNums, 0.5) ?? '—'} / ${percentile(completionNums, 0.9) ?? '—'}（可得 ${completionKnown}/${main.length}）`)
  lines.push(`- reasoning P50/P90：${percentile(reasoningNums, 0.5) ?? '—'} / ${percentile(reasoningNums, 0.9) ?? '—'}（可得 ${reasoningKnown}/${main.length}；不可得记 unknown，不填 0）`)
  lines.push('')
  lines.push('## 触顶与结束状态（验收：区分正文过长 / 推理占满 / 网络中断 / 用户停止）')
  lines.push('')
  lines.push(`- 触顶率（finish_reason=length）：${rate(truncated.length, main.length)}`)
  lines.push(`  - 正文过长（body_filled）：${bodyFilled}`)
  lines.push(`  - 推理占满（reasoning_filled）：${reasoningFilled}`)
  lines.push(`  - 无法判定（reasoning token 不可得）：${truncationUnknown}`)
  lines.push(`- 用户停止（user_cancelled）：${rate(userCancelled.length, main.length)}`)
  lines.push(`- 网络中断（error + network/timeout）：${rate(networkErrors.length, main.length)}`)
  lines.push(`- 其他错误：${rate(otherErrors.length, main.length)}`)
  lines.push(`- terminationCause 分布：${formatCountMap(terminationMap)}`)
  lines.push('')
  lines.push('## 请求形态')
  lines.push('')
  lines.push(`- generationType 分布：${formatCountMap(genTypeMap)}`)
  lines.push(`- taskType 分布：${formatCountMap(taskTypeMap)}`)
  lines.push(`- attempts 分布：${formatCountMap(attemptsMap)}`)
  // 阶段8（W5）：门控维度观测（缺省 = 未开启门控；earlyAbort = 推理提前中止次数；
  // downgradeRetry = 降档恢复请求次数，归属原生成轮）
  lines.push(`- 门控档位分布：${formatCountMap(countMap(main, (r) => r.gateLevel ?? '(未开启)'))}`)
  lines.push(`- 提前中止（earlyAbort）：${main.filter((r) => r.earlyAbort === true).length}`)
  lines.push(`- 降档恢复请求（downgradeRetry）：${main.filter((r) => r.downgradeRetry === true).length}`)
  lines.push('')
  lines.push('## 按 provider × model × task 分组')
  lines.push('')
  if (groups.length === 0) {
    lines.push('- （无主对话样本）')
  } else {
    lines.push('| 分组 | 有效 | 总计 | 正文 P50 | 正文 P90 | 触顶 | 推理占满 |')
    lines.push('|---|---:|---:|---:|---:|---:|---:|')
    for (const g of groups) {
      lines.push(`| ${g.key} | ${g.valid} | ${g.total} | ${g.p50Chars ?? '—'} | ${g.p90Chars ?? '—'} | ${g.truncated} | ${g.reasoningFilled} |`)
    }
  }
  lines.push('')
  lines.push('## 按 provider × 端点 × model × task × gate 分组（W1 用量档案口径）')
  lines.push('')
  lines.push('- 端点 = 标准化地址的不可逆短哈希（不含凭据/query/fragment）；旧记录缺该字段时计「(无端点指纹)」')
  lines.push('- gate = 观测记录的门控档位；缺省为「(default)」，gate 开启前后不得混合统计')
  lines.push('- 每桶只保留有限样本聚合；样本不足 5 条标记低置信度，不参与决策')
  const usageProfiles = buildUsageProfiles(records)
  if (usageProfiles.size === 0) {
    lines.push('- （无用量样本）')
  } else {
    lines.push('| provider/端点/model/task/gate | 样本 | 低置信 | reasoning P90 | 正文 P95 | 推理挤占率 | 完成 | 失败 | 参数拒绝 |')
    lines.push('|---|---:|---|---:|---:|---:|---:|---:|---:|')
    const rows = [...usageProfiles.entries()]
      .sort((a, b) => b[1].sampleCount - a[1].sampleCount)
      .slice(0, 20)
    for (const [id, profile] of rows) {
      const parsed = JSON.parse(id) as string[]
      const label = `${parsed[0]}/${parsed[1] || '(无端点指纹)'}/${parsed[2]}/${parsed[3]}/${parsed[4]}`
      lines.push(`| ${label} | ${profile.sampleCount} | ${profile.lowConfidence ? '是' : '否'} | ${profile.reasoningP90 ?? '—'} | ${profile.bodyVisibleCharsP95 ?? '—'} | ${(profile.reasoningFilledRate * 100).toFixed(1)}% | ${profile.counts.completed} | ${profile.counts.error} | ${profile.counts.knobRejected} |`)
    }
  }
  lines.push('')
  lines.push('## 格式质量')
  lines.push('')
  lines.push(`- 未闭合格式率（引号/星号/thought 任一未闭合）：${rate(unbalanced.length, main.length)}`)
  lines.push(`- 正常完成但非完整句收尾：${rate(incompleteSentence.length, main.length)}`)
  lines.push('')
  lines.push('## 观测完整性')
  lines.push('')
  lines.push(`- completion token 可得率：${rate(completionKnown, main.length)}`)
  lines.push(`- reasoning token 可得率：${rate(reasoningKnown, main.length)}（不可得记 unknown，不填 0）`)
  lines.push(`- 篇幅模式分布：${formatCountMap(modeCount)}`)
  lines.push('')
  lines.push('## 用户手动继续')
  lines.push('')
  lines.push(`- continue 类请求：${continueTotal} 条，其中紧跟截断/失败：${rate(continueAfterIncomplete, continueTotal)}`)
  lines.push('')

  const report = lines.join('\n')
  if (out) {
    writeFileSync(out, report, 'utf-8')
    console.log(`报告已写入 ${out}`)
  }
  console.log(report)
}

main()

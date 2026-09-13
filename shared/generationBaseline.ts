/**
 * 生成基线分析纯逻辑（阶段0「基线与观测」）——无 IO，供 scripts/generation-baseline.ts 与测试共用。
 *
 * 有效生成口径（主计划 G2 第 1 条 / 阶段 7.4 的 500 次分母）：
 * - 计入：source ∈ {single, group, bridge} 且 taskType 缺省（主对话），
 *   outcome ∈ {completed, truncated, user_cancelled}（供应商有响应）。
 * - 不计入：aux、后台结构化任务（memory/compression/title/direction）、
 *   outcome=error（网络/超时/空输出/API 错误——单独统计失败率，不计入 500 分母）。
 * - gate 开启前后按 ts 分段，不得混合（G2 第 7 条）。
 */

import type { GenerationObservation } from './generationObservation'

/** 主对话有效生成的来源 */
const MAIN_SOURCES = new Set(['single', 'group', 'bridge'])

/** 后台结构化任务类型（独立口径，不计入 500 次有效生成） */
const BACKGROUND_TASK_TYPES = new Set(['memory', 'compression', 'title', 'direction'])

export interface ValidGenerationResult {
  total: number
  valid: number
  byOutcome: Record<string, number>
  excludedAux: number
  excludedBackground: number
  excludedError: number
}

export interface GroupKeyStats {
  key: string
  total: number
  valid: number
  p50Chars: number | null
  p90Chars: number | null
  truncated: number
  reasoningFilled: number
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)
  return sorted[idx]
}

export function rate(count: number, total: number): string {
  if (total === 0) return '—'
  return `${count}/${total}（${((count / total) * 100).toFixed(1)}%）`
}

/**
 * 主对话有效生成判定（G2 500 次分母口径）。
 * 返回计入与各排除路径的计数，便于报告中写明分母。
 */
export function computeValidGenerations(records: readonly GenerationObservation[]): ValidGenerationResult {
  const byOutcome: Record<string, number> = {}
  let valid = 0
  let excludedAux = 0
  let excludedBackground = 0
  let excludedError = 0

  for (const r of records) {
    if (!MAIN_SOURCES.has(r.source)) {
      excludedAux++
      continue
    }
    if (r.taskType && BACKGROUND_TASK_TYPES.has(r.taskType)) {
      excludedBackground++
      continue
    }
    if (r.outcome === 'error') {
      excludedError++
      continue
    }
    valid++
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1
  }

  return {
    total: records.length,
    valid,
    byOutcome,
    excludedAux,
    excludedBackground,
    excludedError,
  }
}

export function groupKey(r: GenerationObservation): string {
  return `${r.provider ?? '(无 provider)'}/${r.model}/${r.taskType ?? 'main'}`
}

export function buildGroupStats(records: readonly GenerationObservation[]): GroupKeyStats[] {
  const map = new Map<string, GenerationObservation[]>()
  for (const r of records) {
    const key = groupKey(r)
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(r)
  }
  const stats: GroupKeyStats[] = []
  for (const [key, list] of map) {
    const chars = list
      .map((r) => r.bodyVisibleChars)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b)
    stats.push({
      key,
      total: list.length,
      valid: computeValidGenerations(list).valid,
      p50Chars: percentile(chars, 0.5),
      p90Chars: percentile(chars, 0.9),
      truncated: list.filter((r) => r.finishReason === 'length').length,
      reasoningFilled: list.filter((r) => r.truncationKind === 'reasoning_filled').length,
    })
  }
  return stats.sort((a, b) => b.valid - a.valid || b.total - a.total)
}

export function numericTokens(
  records: readonly GenerationObservation[],
  field: 'completionTokens' | 'reasoningTokens',
): number[] {
  return records
    .map((r) => r[field])
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    .sort((a, b) => a - b)
}

export function countMap(
  records: readonly GenerationObservation[],
  pick: (r: GenerationObservation) => string,
): Map<string, number> {
  const map = new Map<string, number>()
  for (const r of records) {
    const key = pick(r)
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return map
}

export function formatCountMap(map: Map<string, number>): string {
  if (map.size === 0) return '—'
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join('，')
}

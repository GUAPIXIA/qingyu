/**
 * 阶段六：记忆质量指标纯函数（无网络、无 store 依赖）
 * 供 memoryRegression / CI 统计使用
 */

export interface FactRecallInput {
  totalFacts: number
  recalledFacts: number
}

export interface ConflictInput {
  totalFacts: number
  conflictFacts: number
}

export interface DriftInput {
  totalSummaries: number
  driftedSummaries: number
}

export interface MetricsInput {
  factRecall?: FactRecallInput
  conflict?: ConflictInput
  drift?: DriftInput
  tokenCosts?: number[]
  latenciesMs?: number[]
}

export interface MemoryMetrics {
  /** 关键事实召回率 0-1 */
  factRecallRate: number
  /** 冲突率 0-1 */
  conflictRate: number
  /** 摘要漂移率 0-1 */
  driftRate: number
  /** 平均 Token 成本 */
  avgTokenCost: number
  /** 平均延迟 ms */
  avgLatencyMs: number
  /** 首 token 延迟是否达标（≤200ms） */
  latencyOk: boolean
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

function avg(nums: number[] | undefined): number {
  if (!nums || nums.length === 0) return 0
  const sum = nums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
  return sum / nums.length
}

export function calculateMetrics(input: MetricsInput): MemoryMetrics {
  const factRecallRate = input.factRecall && input.factRecall.totalFacts > 0
    ? clamp01(input.factRecall.recalledFacts / input.factRecall.totalFacts)
    : 0
  const conflictRate = input.conflict && input.conflict.totalFacts > 0
    ? clamp01(input.conflict.conflictFacts / input.conflict.totalFacts)
    : 0
  const driftRate = input.drift && input.drift.totalSummaries > 0
    ? clamp01(input.drift.driftedSummaries / input.drift.totalSummaries)
    : 0
  const avgTokenCost = avg(input.tokenCosts)
  const avgLatencyMs = avg(input.latenciesMs)
  return {
    factRecallRate,
    conflictRate,
    driftRate,
    avgTokenCost,
    avgLatencyMs,
    latencyOk: avgLatencyMs === 0 ? true : avgLatencyMs <= 200,
  }
}

export function isMetricsPass(m: MemoryMetrics): boolean {
  return m.factRecallRate >= 0.85 && m.conflictRate <= 0.05 && m.driftRate <= 0.1 && m.latencyOk
}

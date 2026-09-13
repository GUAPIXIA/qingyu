/**
 * 生成用量档案（主计划 W1 / §5.3）：从现有观测日志回读的只读聚合 —— 纯函数，无 IO。
 *
 * 职责：
 * - 端点指纹：把 baseUrl 标准化为不含凭据/query/fragment 的稳定键，再做不可逆短哈希；
 * - 观测记录 → 按 provider + 端点 + model + task + gate 分桶的 UsageProfile；
 * - 有界索引：每键最多 32 个数值样本、全局最多 256 个键（LRU 淘汰）。
 *
 * 隐私口径（主计划 §4.4）：本模块只产出数值与枚举，绝不透出正文、完整 URL 或磁盘路径；
 * `reasoningTokens === 'unknown'` 不转 0、不参与分位数；样本不足 5 条标记低置信度。
 */

import type { GenerationObservation } from './generationObservation'
import { percentile } from './generationBaseline'
import { percentile90 } from './modelOutputProfile'
import { endpointFingerprint } from './endpointKey'

/** 每键保留的近期 reasoning 样本数上限 */
export const USAGE_PROFILE_MAX_SAMPLES_PER_KEY = 32
/** 全局键数量上限（超出按最近未使用淘汰） */
export const USAGE_PROFILE_MAX_KEYS = 256
/** 低于该样本数视为低置信度（预算侧仍按保守语义使用） */
export const USAGE_PROFILE_LOW_CONFIDENCE_SAMPLES = 5

/** 观测记录缺省分桶值（旧记录没有 taskType / gateLevel 字段时的兼容桶） */
export const USAGE_PROFILE_DEFAULT_TASK = 'main'
export const USAGE_PROFILE_DEFAULT_GATE = '(default)'

export interface UsageProfileKey {
  provider: string
  endpointFingerprint: string
  model: string
  taskType: string
  gate: string
}

export interface UsageProfileCounts {
  /** 正常完成 */
  completed: number
  /** 推理挤占（含提前中止与旧文本判定路径） */
  reasoningFilled: number
  /** 门控参数被明确 400 拒绝 */
  knobRejected: number
  /** 失败终局（网络/超时/空输出/API 错误） */
  error: number
}

export interface UsageProfile {
  sampleCount: number
  /** 最近有限个 reasoning token 样本（不含 unknown；不足时为空数组） */
  recentReasoningTokens: number[]
  /** 保守 P90（样本 < 10 时取最大值），无可得样本为 null */
  reasoningP90: number | null
  /** 正文可见字符 P95，无可得样本为 null */
  bodyVisibleCharsP95: number | null
  /** 推理挤占占比（0–1） */
  reasoningFilledRate: number
  /** 样本不足 USAGE_PROFILE_LOW_CONFIDENCE_SAMPLES 条 */
  lowConfidence: boolean
  counts: UsageProfileCounts
  lastUpdatedAt: number
}

/** 观测记录 → 分桶键（旧记录字段缺失时落到缺省桶） */
export function usageProfileKeyOf(record: GenerationObservation): UsageProfileKey {
  return {
    provider: record.provider ?? '(unknown)',
    endpointFingerprint: record.endpointFingerprint ?? '',
    model: record.model || '(unknown)',
    taskType: record.taskType ?? USAGE_PROFILE_DEFAULT_TASK,
    gate: record.gateLevel ?? USAGE_PROFILE_DEFAULT_GATE,
  }
}

/** 分桶键 → 字符串 id（JSON 数组保证任意分隔符字符都不会造成键碰撞） */
export function usageProfileKeyString(key: UsageProfileKey): string {
  return JSON.stringify([key.provider, key.endpointFingerprint, key.model, key.taskType, key.gate])
}

/** 查询输入：端点用原始 baseUrl（主进程侧统一标准化，renderer 不需要先算哈希） */
export interface UsageProfileQuery {
  provider: string
  baseUrl: string
  model: string
  taskType?: string
  gate?: string
}

export function normalizeUsageProfileQuery(query: UsageProfileQuery): UsageProfileKey {
  return {
    provider: query.provider || '(unknown)',
    endpointFingerprint: endpointFingerprint(query.baseUrl ?? ''),
    model: query.model || '(unknown)',
    taskType: query.taskType ?? USAGE_PROFILE_DEFAULT_TASK,
    gate: query.gate ?? USAGE_PROFILE_DEFAULT_GATE,
  }
}

function isReasoningFilled(record: GenerationObservation): boolean {
  return record.truncationKind === 'reasoning_filled'
    || record.terminationCause === 'reasoning_gate_exceeded'
    || record.errorKind === 'reasoning_budget_exhausted'
}

interface Accumulator {
  totalSamples: number
  counts: UsageProfileCounts
  reasoningSamples: number[]
  bodyChars: number[]
  lastUpdatedAt: number
}

function createAccumulator(): Accumulator {
  return {
    totalSamples: 0,
    counts: { completed: 0, reasoningFilled: 0, knobRejected: 0, error: 0 },
    reasoningSamples: [],
    bodyChars: [],
    lastUpdatedAt: 0,
  }
}

/** 单条记录入桶（纯累积；样本与正文长度均有界） */
export function accumulateRecord(acc: Accumulator, record: GenerationObservation): void {
  acc.totalSamples += 1
  acc.lastUpdatedAt = Math.max(acc.lastUpdatedAt, record.ts ?? 0)
  if (record.outcome === 'completed') acc.counts.completed += 1
  if (record.outcome === 'error') acc.counts.error += 1
  if (isReasoningFilled(record)) acc.counts.reasoningFilled += 1
  if (record.knobAcceptedThisRequest === false) acc.counts.knobRejected += 1

  const reasoning = record.reasoningTokens
  if (typeof reasoning === 'number' && Number.isFinite(reasoning) && reasoning >= 0) {
    acc.reasoningSamples.push(reasoning)
    if (acc.reasoningSamples.length > USAGE_PROFILE_MAX_SAMPLES_PER_KEY) {
      acc.reasoningSamples.splice(0, acc.reasoningSamples.length - USAGE_PROFILE_MAX_SAMPLES_PER_KEY)
    }
  }
  const body = record.bodyVisibleChars
  if (typeof body === 'number' && Number.isFinite(body) && body >= 0) {
    acc.bodyChars.push(body)
    if (acc.bodyChars.length > USAGE_PROFILE_MAX_SAMPLES_PER_KEY) {
      acc.bodyChars.splice(0, acc.bodyChars.length - USAGE_PROFILE_MAX_SAMPLES_PER_KEY)
    }
  }
}

function toProfile(acc: Accumulator): UsageProfile {
  const sortedBody = [...acc.bodyChars].sort((a, b) => a - b)
  return {
    sampleCount: acc.totalSamples,
    recentReasoningTokens: [...acc.reasoningSamples],
    reasoningP90: acc.reasoningSamples.length > 0 ? percentile90(acc.reasoningSamples) : null,
    bodyVisibleCharsP95: sortedBody.length > 0 ? percentile(sortedBody, 0.95) : null,
    reasoningFilledRate: acc.totalSamples > 0 ? acc.counts.reasoningFilled / acc.totalSamples : 0,
    lowConfidence: acc.totalSamples < USAGE_PROFILE_LOW_CONFIDENCE_SAMPLES,
    counts: { ...acc.counts },
    lastUpdatedAt: acc.lastUpdatedAt,
  }
}

/** 观测记录集合 → 每个分桶的聚合（无 IO，供脚本与测试直接使用） */
export function buildUsageProfiles(
  records: readonly GenerationObservation[],
): Map<string, UsageProfile> {
  const index = createUsageProfileIndex()
  for (const record of records) index.ingest(record)
  const result = new Map<string, UsageProfile>()
  for (const key of index.keys()) {
    const profile = index.lookup(key)
    if (profile) result.set(usageProfileKeyString(key), profile)
  }
  return result
}

export interface UsageProfileIndex {
  /** 观测写入后同步累积（同一记录重复 ingest 会重复计数，调用方保证一次性） */
  ingest(record: GenerationObservation): void
  lookup(key: UsageProfileKey): UsageProfile | null
  size(): number
  keys(): UsageProfileKey[]
}

/** 有界内存索引：每键样本有界，全局键数按 LRU 淘汰（主计划 §5.3 第 3/4 条） */
export function createUsageProfileIndex(
  limits: { maxKeys?: number } = {},
): UsageProfileIndex {
  const maxKeys = limits.maxKeys ?? USAGE_PROFILE_MAX_KEYS
  const accumulators = new Map<string, Accumulator>()
  const keyCache = new Map<string, UsageProfileKey>()

  return {
    ingest(record) {
      const key = usageProfileKeyOf(record)
      const id = usageProfileKeyString(key)
      let acc = accumulators.get(id)
      if (!acc) {
        acc = createAccumulator()
        keyCache.set(id, key)
      }
      accumulateRecord(acc, record)
      // LRU：重新插入使其成为最近使用；超限时淘汰最早条目
      accumulators.delete(id)
      accumulators.set(id, acc)
      while (accumulators.size > maxKeys) {
        const oldest = accumulators.keys().next().value as string | undefined
        if (oldest === undefined) break
        accumulators.delete(oldest)
        keyCache.delete(oldest)
      }
    },
    lookup(key) {
      const id = usageProfileKeyString(key)
      const acc = accumulators.get(id)
      if (!acc) return null
      // 查询命中同样算一次使用（保持 LRU 语义与热键不被误淘汰）
      accumulators.delete(id)
      accumulators.set(id, acc)
      return toProfile(acc)
    },
    size() {
      return accumulators.size
    },
    keys() {
      return [...keyCache.values()]
    },
  }
}

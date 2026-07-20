/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Token 用量统计服务
 *
 * - 持久化用量记录到 usage.json
 * - 支持按条件查询、聚合
 * - 根据定价规则计算费用
 */

import { DIRS, readJson, writeJson } from './storage'
import { join } from 'node:path'
import { createLogger } from './logger'
import { nanoid } from 'nanoid'
import type { UsageRecord, PricingRule } from '../../shared/types'

const log = createLogger('usage')

const USAGE_FILE = join(DIRS.config(), 'usage.json')

/** 最大记录数，超过时删除最早的 */
const MAX_RECORDS = 10000

/** 加载所有用量记录，文件不存在返回空数组 */
export function loadUsage(): UsageRecord[] {
  const data = readJson<UsageRecord[]>(USAGE_FILE)
  if (!data) return []
  return Array.isArray(data) ? data : []
}

/** 追加一条用量记录，自动生成 id，返回完整记录。超过 MAX_RECORDS 时删除最早的 */
export function recordUsage(record: Omit<UsageRecord, 'id'>): UsageRecord {
  const records = loadUsage()
  const full: UsageRecord = {
    ...record,
    id: nanoid(),
  }
  records.push(full)
  // 超过上限时按 timestamp 排序，保留最新的 MAX_RECORDS 条
  if (records.length > MAX_RECORDS) {
    records.sort((a, b) => a.timestamp - b.timestamp)
    const trimmed = records.slice(records.length - MAX_RECORDS)
    writeJson(USAGE_FILE, trimmed)
  } else {
    writeJson(USAGE_FILE, records)
  }
  log.info('用量记录已保存', { id: full.id, model: full.model, totalTokens: full.totalTokens })
  return full
}

/** 用量查询过滤条件 */
export interface UsageFilter {
  characterId?: string
  sessionId?: string
  startTs?: number
  endTs?: number
  model?: string
}

/** 按条件过滤用量记录 */
export function queryUsage(filter: UsageFilter): UsageRecord[] {
  let records = loadUsage()
  if (filter.characterId) {
    records = records.filter((r) => r.characterId === filter.characterId)
  }
  if (filter.sessionId) {
    records = records.filter((r) => r.sessionId === filter.sessionId)
  }
  if (typeof filter.startTs === 'number') {
    records = records.filter((r) => r.timestamp >= (filter.startTs as number))
  }
  if (typeof filter.endTs === 'number') {
    records = records.filter((r) => r.timestamp <= (filter.endTs as number))
  }
  if (filter.model) {
    records = records.filter((r) => r.model === filter.model)
  }
  return records
}

/** 清空所有用量记录 */
export function clearUsage(): void {
  writeJson(USAGE_FILE, [])
  log.info('用量记录已清空')
}

/** 模型名匹配（支持通配符 *，如 gpt-4*） */
function matchModelPattern(model: string, pattern: string): boolean {
  // 将通配符 * 转为 .*，其余正则特殊字符转义
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  try {
    const re = new RegExp(`^${regexStr}$`)
    return re.test(model)
  } catch {
    // 正则构造失败，退化为精确匹配
    return model === pattern
  }
}

/**
 * 根据 modelPattern 匹配规则计算费用
 * 找到第一个匹配的规则就用，找不到返回 0
 * 费用 = promptTokens/1_000_000*inputPricePer1M + completionTokens/1_000_000*outputPricePer1M
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  rules: PricingRule[],
): number {
  for (const rule of rules) {
    if (matchModelPattern(model, rule.modelPattern)) {
      const inputCost = (promptTokens / 1_000_000) * rule.inputPricePer1M
      const outputCost = (completionTokens / 1_000_000) * rule.outputPricePer1M
      return inputCost + outputCost
    }
  }
  return 0
}

/** 聚合维度 */
export type UsageGroupBy = 'character' | 'session' | 'day' | 'model'

/** 聚合结果项 */
export interface AggregatedUsage {
  key: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cost: number
  count: number
}

/** 按维度聚合用量，返回数组按 totalTokens 降序 */
export function aggregateUsage(records: UsageRecord[], groupBy: UsageGroupBy): AggregatedUsage[] {
  const map = new Map<string, AggregatedUsage>()
  for (const r of records) {
    let key: string
    switch (groupBy) {
      case 'character':
        key = r.characterId
        break
      case 'session':
        key = r.sessionId
        break
      case 'model':
        key = r.model
        break
      case 'day':
        key = new Date(r.timestamp).toISOString().slice(0, 10)
        break
      default:
        key = 'unknown'
    }
    let agg = map.get(key)
    if (!agg) {
      agg = {
        key,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
        count: 0,
      }
      map.set(key, agg)
    }
    agg.promptTokens += r.promptTokens
    agg.completionTokens += r.completionTokens
    agg.totalTokens += r.totalTokens
    agg.cost += r.cost
    agg.count += 1
  }
  const result = Array.from(map.values())
  // 按 totalTokens 降序
  result.sort((a, b) => b.totalTokens - a.totalTokens)
  return result
}

/** 全局汇总 */
export function getSummary(filter?: { startTs?: number; endTs?: number }): {
  totalPrompt: number
  totalCompletion: number
  totalTokens: number
  totalCost: number
  count: number
} {
  let records = loadUsage()
  if (filter) {
    if (typeof filter.startTs === 'number') {
      records = records.filter((r) => r.timestamp >= (filter.startTs as number))
    }
    if (typeof filter.endTs === 'number') {
      records = records.filter((r) => r.timestamp <= (filter.endTs as number))
    }
  }
  let totalPrompt = 0
  let totalCompletion = 0
  let totalTokens = 0
  let totalCost = 0
  for (const r of records) {
    totalPrompt += r.promptTokens
    totalCompletion += r.completionTokens
    totalTokens += r.totalTokens
    totalCost += r.cost
  }
  return {
    totalPrompt,
    totalCompletion,
    totalTokens,
    totalCost,
    count: records.length,
  }
}


/**
 * 字符用量统计服务
 *
 * - 持久化用量记录到 usage.json
 * - 支持按条件查询、聚合
 * - 统计用户输入与系统输出的字符数（中文/英文/数字/符号总和）
 */

import { DIRS, readJson, writeJson } from './storage'
import { join } from 'node:path'
import { createLogger } from './logger'
import { nanoid } from 'nanoid'
import type { UsageRecord } from '../../shared/types'

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

/** 单条字段最大长度（防止异常数据撑爆磁盘/内存） */
const MAX_FIELD_LEN = 256

/** 追加一条用量记录，自动生成 id，返回完整记录。超过 MAX_RECORDS 时删除最早的 */
export function recordUsage(record: Omit<UsageRecord, 'id'>): UsageRecord {
  // 字段校验：字符串字段限长、数字字段必须为有限非负数（防御异常/恶意 IPC 数据）
  const str = (v: unknown, fallback: string) =>
    typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD_LEN ? v : fallback
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
  const ts = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : Date.now())

  const clean: Omit<UsageRecord, 'id'> = {
    timestamp: ts(record.timestamp),
    characterId: str(record.characterId, 'unknown'),
    sessionId: str(record.sessionId, 'unknown'),
    model: str(record.model, 'unknown'),
    inputChars: num(record.inputChars),
    outputChars: num(record.outputChars),
    totalChars: num(record.totalChars),
  }

  const records = loadUsage()
  const full: UsageRecord = {
    ...clean,
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
  log.info('用量记录已保存', { id: full.id, model: full.model, totalChars: full.totalChars })
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

/** 聚合维度 */
export type UsageGroupBy = 'character' | 'session' | 'day' | 'model'

/** 聚合结果项 */
export interface AggregatedUsage {
  key: string
  inputChars: number
  outputChars: number
  totalChars: number
  count: number
}

/** 按维度聚合用量，返回数组按 totalChars 降序 */
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
        inputChars: 0,
        outputChars: 0,
        totalChars: 0,
        count: 0,
      }
      map.set(key, agg)
    }
    agg.inputChars += r.inputChars ?? 0
    agg.outputChars += r.outputChars ?? 0
    agg.totalChars += r.totalChars ?? 0
    agg.count += 1
  }
  const result = Array.from(map.values())
  // 按 totalChars 降序
  result.sort((a, b) => b.totalChars - a.totalChars)
  return result
}

/** 全局汇总 */
export function getSummary(filter?: { startTs?: number; endTs?: number }): {
  totalInput: number
  totalOutput: number
  totalChars: number
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
  let totalInput = 0
  let totalOutput = 0
  let totalChars = 0
  for (const r of records) {
    totalInput += r.inputChars ?? 0
    totalOutput += r.outputChars ?? 0
    totalChars += r.totalChars ?? 0
  }
  return {
    totalInput,
    totalOutput,
    totalChars,
    count: records.length,
  }
}

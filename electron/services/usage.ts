
/**
 * 字符用量统计服务
 *
 * - 持久化用量记录到 usage.json
 * - 支持按条件查询、聚合
 * - 统计用户输入与系统输出的字符数（中文/英文/数字/符号总和）
 */

import { DIRS, readJson, serializeJson, withFileLock } from './storage'
import { join } from 'node:path'
import { createLogger } from './logger'
import { nanoid } from 'nanoid'
import type { UsageRecord } from '../../shared/types'
import { getUsageDayKey } from '../../shared/usageDate'
import { app } from 'electron'
import { commitThroughDomain, ensureSyncDomain, getSyncDomain, writeThroughDomain } from '../domain/syncDomainService'

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

/** usage_record 实体规范 payload（与 S2-05 bootstrap 扫描器一致：记录去掉 id） */
function usageRecordPayload(record: UsageRecord): Record<string, unknown> {
  return {
    timestamp: record.timestamp,
    characterId: record.characterId,
    sessionId: record.sessionId,
    model: record.model,
    inputChars: record.inputChars,
    outputChars: record.outputChars,
    totalChars: record.totalChars,
  }
}

/** 可安全作为实体 ID 的记录 ID（脏数据不应让整批 tombstone 失败） */
function validRecordIds(records: UsageRecord[]): string[] {
  return records
    .map((record) => record?.id)
    .filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(id))
}

/** 单条字段最大长度（防止异常数据撑爆磁盘/内存） */
const MAX_FIELD_LEN = 256

/**
 * 追加一条用量记录，自动生成 id，返回完整记录。超过 MAX_RECORDS 时删除最早的。
 * S2-04：usage.json 与 usage_record journal 在同一事务内提交（usage 域唯一记账入口）。
 */
export function recordUsage(record: Omit<UsageRecord, 'id'>): Promise<UsageRecord> {
  // N4 修复：读-改-写整体持文件锁，串行化并发调用，避免互相覆盖丢记录
  return withFileLock(USAGE_FILE, () => {
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
    // 超过上限时按 timestamp 排序，保留最新的 MAX_RECORDS 条；被淘汰的记录产生 tombstone
    let next = records
    let trimmedIds: string[] = []
    if (records.length > MAX_RECORDS) {
      records.sort((a, b) => a.timestamp - b.timestamp)
      next = records.slice(records.length - MAX_RECORDS)
      trimmedIds = validRecordIds(records.slice(0, records.length - MAX_RECORDS))
    }
    commitThroughDomain({
      domain: 'usage_record',
      entityType: 'usage_record',
      puts: [{ entityId: full.id, payload: usageRecordPayload(full), schemaVersion: 1 }],
      deletes: trimmedIds.map((entityId) => ({ entityId })),
      files: [{ path: USAGE_FILE, content: serializeJson(next) }],
    })
    log.info('用量记录已保存', { id: full.id, model: full.model, totalChars: full.totalChars })
    return full
  })
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

/**
 * 清空所有用量记录（S2-04）。
 *
 * - 被清空的记录在同一事务内产生 tombstone（保留删除语义，而不是仅把文件覆盖为空数组）；
 * - 随后写入 usage_clear_marker，保留既有 clearedThrough（已消费 counter 上界）语义。
 */
export function clearUsage(): void {
  const records = loadUsage()
  commitThroughDomain({
    domain: 'usage_record',
    entityType: 'usage_record',
    puts: [],
    deletes: validRecordIds(records).map((entityId) => ({ entityId })),
    files: [{ path: USAGE_FILE, content: serializeJson([]) }],
  })
  try {
    ensureSyncDomain(app.getPath('userData'))
    const { meta, repo } = getSyncDomain()
    const deviceId = repo.deviceId()
    const next = BigInt(meta.getDeviceState()?.nextCounter ?? '1')
    const through: Record<string, string> = {
      [deviceId]: String(next > 0n ? next - 1n : 0n),
    }
    writeThroughDomain({
      domain: 'usage_record',
      entityType: 'usage_clear_marker',
      entityId: 'usage-clear-marker',
      payload: { clearedThrough: through },
      schemaVersion: 1,
      files: [],
    })
  } catch (err) {
    log.warn('usage clear marker 写入失败', { err: String(err) })
  }
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
export function aggregateUsage(records: UsageRecord[], groupBy: UsageGroupBy, timeZone?: string): AggregatedUsage[] {
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
        key = getUsageDayKey(r.timestamp, timeZone)
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
  // 日视图按日期倒序供表格展示；其他维度按用量降序。
  result.sort(groupBy === 'day'
    ? (a, b) => b.key.localeCompare(a.key)
    : (a, b) => b.totalChars - a.totalChars)
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

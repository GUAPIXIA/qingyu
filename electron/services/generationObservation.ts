/**
 * 生成观测持久化（阶段0「基线与观测」）。
 *
 * 分类与记录形状在 shared/generationObservation.ts（纯逻辑，供基线脚本复用）；
 * 本模块只负责 JSONL 追加落盘与简单轮转，写入失败静默（观测不阻塞生成）。
 *
 * W1（主计划 §7.3）：同文件内提供有界读取与内存聚合（UsageProfile 回读），
 * 不新建第二份持久化文件；读取失败、单行损坏或字段缺失都不阻塞生成。
 *
 * 文件：`<userData>/data/diagnostics/generation-observations.jsonl`
 * 每行一条 GenerationObservation；超过 5MB 轮转为 `.old`（最多保留一代）。
 */

import { join } from 'node:path'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs'
import { app } from 'electron'
import type { GenerationObservation } from '../../shared/generationObservation'
import {
  createUsageProfileIndex,
  normalizeUsageProfileQuery,
  type UsageProfile,
  type UsageProfileQuery,
} from '../../shared/usageProfile'
import { createLogger } from './logger'

const log = createLogger('observation')

const ROTATE_THRESHOLD_BYTES = 5 * 1024 * 1024
/** 单个观测文件最多读取的字节数（懒加载总量 = 本值 × 2，含 `.old`） */
const MAX_SCAN_BYTES = 4 * 1024 * 1024

/** 观测文件路径（diagnostics 目录在首次写入时确保存在） */
export function resolveObservationsFilePath(): string {
  return join(app.getPath('userData'), 'data', 'diagnostics', 'generation-observations.jsonl')
}

/** 追加一条观测记录（同步追加 + 轮转；调用方保证低频，单条失败静默） */
export function appendObservationToFile(filePath: string, obs: GenerationObservation): void {
  try {
    mkdirSync(join(filePath, '..'), { recursive: true })
    if (existsSync(filePath)) {
      const size = statSync(filePath).size
      if (size >= ROTATE_THRESHOLD_BYTES) {
        try {
          renameSync(filePath, `${filePath}.old`)
        } catch { /* 旧文件被占用等场景放弃轮转，继续追加 */ }
      }
    }
    appendFileSync(filePath, JSON.stringify(obs) + '\n', 'utf-8')
  } catch (e) {
    log.warn('观测记录写入失败', { error: e instanceof Error ? e.message : String(e) })
  }
}

// ===================== W1：用量回读（有界读盘 + 内存索引） =====================

let usageIndex = createUsageProfileIndex()
let usageIndexLoaded = false
const usageDiagnostics = { skippedLines: 0, scannedRecords: 0 }

/**
 * 读取文件尾部最多 maxBytes 的记录；超出时从行边界开始（丢弃首行残段），
 * 文件缺失/不可读返回空数组（不抛出）。
 */
function readTailRecords(filePath: string, maxBytes: number): GenerationObservation[] {
  let content = ''
  try {
    const size = statSync(filePath).size
    if (size <= 0) return []
    if (size <= maxBytes) {
      content = readFileSync(filePath, 'utf-8')
    } else {
      const fd = openSync(filePath, 'r')
      try {
        const buffer = Buffer.alloc(maxBytes)
        readSync(fd, buffer, 0, maxBytes, size - maxBytes)
        content = buffer.toString('utf-8')
      } finally {
        closeSync(fd)
      }
      const firstNewline = content.indexOf('\n')
      content = firstNewline >= 0 ? content.slice(firstNewline + 1) : ''
    }
  } catch (e) {
    log.warn('观测回读失败（按空档案继续）', { error: e instanceof Error ? e.message : String(e) })
    return []
  }

  const records: GenerationObservation[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as GenerationObservation
      if (parsed && typeof parsed.ts === 'number' && parsed.requestId) records.push(parsed)
      else usageDiagnostics.skippedLines += 1
    } catch {
      // 单行损坏只计诊断，不让整个档案失效（主计划 §5.3 第 2 条）
      usageDiagnostics.skippedLines += 1
    }
  }
  usageDiagnostics.scannedRecords += records.length
  return records
}

/** 首次查询时懒加载：`.old`（更早）在前、当前文件在后，总读取量有界 */
function ensureUsageIndexLoaded(): void {
  if (usageIndexLoaded) return
  usageIndexLoaded = true
  const filePath = resolveObservationsFilePath()
  for (const path of [`${filePath}.old`, filePath]) {
    if (!existsSync(path)) continue
    for (const record of readTailRecords(path, MAX_SCAN_BYTES)) usageIndex.ingest(record)
  }
}

/** 只读聚合查询：读取失败/无样本返回 null，调用方回退静态档案（生成不失败） */
export function queryUsageProfile(query: UsageProfileQuery): UsageProfile | null {
  try {
    ensureUsageIndexLoaded()
    return usageIndex.lookup(normalizeUsageProfileQuery(query))
  } catch (e) {
    log.warn('用量档案查询失败（回退静态档案）', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

/** 回读诊断（不暴露磁盘路径；供测试与后续诊断视图使用） */
export function getUsageProfileDiagnostics(): {
  loaded: boolean
  keys: number
  scannedRecords: number
  skippedLines: number
} {
  return {
    loaded: usageIndexLoaded,
    keys: usageIndex.size(),
    scannedRecords: usageDiagnostics.scannedRecords,
    skippedLines: usageDiagnostics.skippedLines,
  }
}

/** 测试专用：清空内存索引与懒加载标记（与 tailRepairFailures 的重置入口同口径） */
export function resetUsageProfileIndexForTests(): void {
  usageIndex = createUsageProfileIndex()
  usageIndexLoaded = false
  usageDiagnostics.skippedLines = 0
  usageDiagnostics.scannedRecords = 0
}

/** 供上层调用的记录入口：观测绝不影响生成主流程 */
export function recordGenerationObservation(obs: GenerationObservation): void {
  try {
    appendObservationToFile(resolveObservationsFilePath(), obs)
  } catch { /* 双重兜底：观测失败不影响主流程 */ }
  try {
    // 已加载后同步增量更新，避免每轮扫盘；未加载时留给首次查询统一扫描
    // （新记录已在文件中，扫描不会漏计，也不会重复计数）
    if (usageIndexLoaded) usageIndex.ingest(obs)
  } catch { /* 索引更新失败不影响生成 */ }
}


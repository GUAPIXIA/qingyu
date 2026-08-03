/**
 * 向量索引持久化（轻量 JSON 文件方案，零原生依赖）
 *
 * 数据目录：data/vectors/<lorebookId>.json
 * 每个世界书一个索引文件，存条目 id → 归一化向量（L2 归一化后余弦 = 点积）。
 */

import { join } from 'node:path'
import { DIRS, readJson, writeJson, removeFile } from './storage'
import { l2Normalize } from '../../src/utils/vector'
import { createLogger } from './logger'

const log = createLogger('vectorStore')

export interface VectorIndex {
  version: number
  model: string
  /** 条目 id → 归一化向量 */
  entries: Record<string, number[]>
  updatedAt: number
  /** 内容已变化、向量过期的条目 id（世界书保存时对比标记，重建索引后清空） */
  stale?: string[]
}

const CURRENT_VERSION = 1

/** 内存缓存，避免频繁磁盘读取（LRU 上限，防止无限增长） */
const cache = new Map<string, VectorIndex>()
/** 缓存条目上限（超出时淘汰最久未用的） */
const CACHE_MAX = 20

function cacheSet(key: string, value: VectorIndex): void {
  cache.delete(key)
  cache.set(key, value)
  // 超出上限：淘汰最早插入的条目
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

function cacheGet(key: string): VectorIndex | null {
  const v = cache.get(key)
  if (!v) return null
  // LRU：访问即提升到最新
  cache.delete(key)
  cache.set(key, v)
  return v
}

function indexPath(lorebookId: string): string {
  return join(DIRS.vectors(), `${lorebookId}.json`)
}

/** 读取向量索引（带内存缓存） */
export function getVectorIndex(lorebookId: string): VectorIndex | null {
  const cached = cacheGet(lorebookId)
  if (cached) return cached
  const index = readJson<VectorIndex>(indexPath(lorebookId))
  if (index && index.entries && typeof index.entries === 'object') {
    cacheSet(lorebookId, index)
    return index
  }
  return null
}

/** 读取多个世界书的向量索引 */
export function getVectorIndexes(lorebookIds: string[]): Map<string, VectorIndex> {
  const result = new Map<string, VectorIndex>()
  for (const id of lorebookIds) {
    const index = getVectorIndex(id)
    if (index) result.set(id, index)
  }
  return result
}

/**
 * 保存向量索引。vectors 会在存储前做 L2 归一化（检索时直接点积）。
 * @param partial 为 null 时清空该世界书的索引
 */
export function saveVectorIndex(
  lorebookId: string,
  model: string,
  vectors: Record<string, number[]>,
): VectorIndex {
  const normalized: Record<string, number[]> = {}
  let dim: number | null = null
  for (const [id, v] of Object.entries(vectors)) {
    if (Array.isArray(v) && v.length > 0) {
      // 维度一致性检查：同一索引内向量维度必须一致（不一致说明嵌入服务配置变更）
      if (dim === null) dim = v.length
      else if (v.length !== dim) {
        log.warn('向量维度不一致，已跳过该条目', { lorebookId, id, dim: v.length, expected: dim })
        continue
      }
      normalized[id] = l2Normalize(v)
    }
  }
  const index: VectorIndex = {
    version: CURRENT_VERSION,
    model,
    entries: normalized,
    updatedAt: Date.now(),
    stale: [],
  }
  writeJson(indexPath(lorebookId), index)
  cache.set(lorebookId, index)
  return index
}

/** 删除向量索引（世界书删除时调用） */
export function removeVectorIndex(lorebookId: string): void {
  removeFile(indexPath(lorebookId))
  cache.delete(lorebookId)
  log.info('向量索引已删除', { lorebookId })
}

/** 统计索引中条目数量 */
export function countIndexedEntries(lorebookId: string): number {
  const index = getVectorIndex(lorebookId)
  return index ? Object.keys(index.entries).length : 0
}

/**
 * 标记条目向量过期（世界书保存后，内容/启用/匹配模式变化的条目）。
 * 检索时跳过这些条目，避免旧向量误导；UI 可见"过期"状态。
 */
export function markStaleEntries(lorebookId: string, changedIds: string[]): void {
  if (!changedIds || changedIds.length === 0) return
  const index = getVectorIndex(lorebookId)
  if (!index) return
  const stale = new Set(index.stale ?? [])
  for (const id of changedIds) {
    if (id in index.entries) stale.add(id)
  }
  if (stale.size === 0) return
  const updated = { ...index, stale: [...stale], updatedAt: Date.now() }
  writeJson(indexPath(lorebookId), updated)
  cache.set(lorebookId, updated)
  log.info('条目向量已标记过期', { lorebookId, count: stale.size })
}

/** 清空过期标记（重建索引后调用） */
export function clearStaleEntries(lorebookId: string): void {
  const index = getVectorIndex(lorebookId)
  if (!index) return
  if (!index.stale || index.stale.length === 0) return
  const updated = { ...index, stale: [], updatedAt: Date.now() }
  writeJson(indexPath(lorebookId), updated)
  cache.set(lorebookId, updated)
}

/** 统计过期条目数量 */
export function countStaleEntries(lorebookId: string): number {
  const index = getVectorIndex(lorebookId)
  return index ? (index.stale ?? []).length : 0
}

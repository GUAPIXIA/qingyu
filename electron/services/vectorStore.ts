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
}

const CURRENT_VERSION = 1

/** 内存缓存，避免频繁磁盘读取 */
const cache = new Map<string, VectorIndex>()

function indexPath(lorebookId: string): string {
  return join(DIRS.vectors(), `${lorebookId}.json`)
}

/** 读取向量索引（带内存缓存） */
export function getVectorIndex(lorebookId: string): VectorIndex | null {
  const cached = cache.get(lorebookId)
  if (cached) return cached
  const index = readJson<VectorIndex>(indexPath(lorebookId))
  if (index && index.entries && typeof index.entries === 'object') {
    cache.set(lorebookId, index)
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
  for (const [id, v] of Object.entries(vectors)) {
    if (Array.isArray(v) && v.length > 0) normalized[id] = l2Normalize(v)
  }
  const index: VectorIndex = {
    version: CURRENT_VERSION,
    model,
    entries: normalized,
    updatedAt: Date.now(),
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

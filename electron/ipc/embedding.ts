/**
 * 语义触发（向量 RAG）IPC
 *
 * - embedding:test            测试嵌入服务连接
 * - embedding:indexLorebook   为世界书启用条目生成向量索引
 * - embedding:indexStatus     查询世界书索引状态
 * - embedding:removeIndex     删除世界书索引
 * - embedding:semanticSearch  扫描文本语义检索（供 buildContext 合并注入）
 */

import type { IpcMain } from 'electron'
import { join } from 'node:path'
import { DIRS, readJson } from '../services/storage'
import { embedTexts, testEmbedding, isEmbeddingConfigured, type EmbeddingConfig } from '../services/embedding'
import { getVectorIndex, saveVectorIndex, removeVectorIndex, countIndexedEntries, countStaleEntries, clearStaleEntries } from '../services/vectorStore'
import { safeId } from '../utils/pathGuard'
import { createLogger } from '../services/logger'
import type { Lorebook, LoreEntry } from '../../shared/types'
import { topKSimilar } from '../../src/utils/vector'

const log = createLogger('embedding-ipc')

/** 条目是否参与语义匹配 */
export function isSemanticEligible(entry: LoreEntry): boolean {
  const mode = entry.matchMode ?? 'both'
  return mode === 'semantic' || mode === 'both'
}

/** 读取单个世界书 */
function readLorebook(id: string): Lorebook | null {
  safeId(id)
  return readJson<Lorebook>(join(DIRS.lorebooks(), `${id}.json`), 'lorebooks')
}

/** 语义检索命中项（主进程 → 渲染进程） */
export interface SemanticHit {
  /** 条目 id（渲染进程用 lbId:id 组装触发键） */
  id: string
  lbId: string
  content: string
  position: LoreEntry['position']
  order: number
  depth?: number
  score: number
}

export function registerEmbeddingIPC(ipcMain: IpcMain): void {
  // 测试嵌入服务连接
  ipcMain.handle('embedding:test', async (_e, config: EmbeddingConfig) => {
    return testEmbedding(config)
  })

  // 为世界书生成/重建向量索引
  ipcMain.handle('embedding:indexLorebook', async (_e, lorebookId: string, config: EmbeddingConfig) => {
    const lb = readLorebook(lorebookId)
    if (!lb) return { ok: false, error: '世界书不存在' }
    if (!isEmbeddingConfigured(config)) {
      return { ok: false, error: '嵌入服务未配置（需填写 baseUrl 与 model）' }
    }

    const targets: { id: string; content: string }[] = []
    for (const entry of lb.entries) {
      if (!entry.enabled || !isSemanticEligible(entry)) continue
      if (!entry.content?.trim()) continue
      targets.push({ id: entry.id, content: entry.content })
    }
    if (targets.length === 0) {
      return { ok: false, error: '没有可索引的条目（需启用且匹配模式包含"语义"）' }
    }

    try {
      const vectors = await embedTexts(config, targets.map((t) => t.content))
      const map: Record<string, number[]> = {}
      let failed = 0
      targets.forEach((t, i) => {
        const v = vectors[i]
        if (v && v.length > 0) map[t.id] = v
        else failed++
      })
      saveVectorIndex(lorebookId, config.model, map)
      clearStaleEntries(lorebookId)
      log.info('世界书向量索引完成', { lorebookId, name: lb.name, total: targets.length, indexed: Object.keys(map).length })
      return { ok: true, total: targets.length, indexed: Object.keys(map).length, failed }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // 查询索引状态
  ipcMain.handle('embedding:indexStatus', async (_e, lorebookIds: string[]) => {
    const result: Record<string, { indexed: number; model: string; updatedAt: number; stale: number }> = {}
    for (const id of lorebookIds) {
      safeId(id)
      const index = getVectorIndex(id)
      result[id] = index
        ? { indexed: countIndexedEntries(id), model: index.model, updatedAt: index.updatedAt, stale: countStaleEntries(id) }
        : { indexed: 0, model: '', updatedAt: 0, stale: 0 }
    }
    return result
  })

  // 删除世界书向量索引
  ipcMain.handle('embedding:removeIndex', async (_e, lorebookId: string) => {
    safeId(lorebookId)
    removeVectorIndex(lorebookId)
    return { ok: true }
  })

  // 批量嵌入（会话事实向量化用，渲染进程存会话字段）
  ipcMain.handle('embedding:embedFacts', async (_e, config: EmbeddingConfig, texts: string[]) => {
    if (!isEmbeddingConfigured(config) || !Array.isArray(texts) || texts.length === 0) return []
    try {
      return await embedTexts(config, texts.map((t) => String(t)))
    } catch (e) {
      log.warn('事实向量化失败（回退全量注入）', { error: (e as Error).message })
      return []
    }
  })

  // 事实语义检索：查询 → 向量 → 与事实向量余弦 topK → 返回命中事实文本
  ipcMain.handle('embedding:searchFacts', async (_e, payload: {
    query: string
    facts: string[]
    vectors: number[][]
    config: EmbeddingConfig
    threshold?: number
    maxResults?: number
  }) => {
    const { query, facts, vectors, config } = payload
    const threshold = typeof payload.threshold === 'number' ? payload.threshold : 0.3
    const maxResults = typeof payload.maxResults === 'number' ? payload.maxResults : 3
    if (!query?.trim() || !isEmbeddingConfigured(config)) return []
    if (!Array.isArray(facts) || facts.length === 0 || !Array.isArray(vectors) || vectors.length !== facts.length) return []
    try {
      const [queryVec] = await embedTexts(config, [query])
      if (!queryVec || queryVec.length === 0) return []
      const items = facts.map((_, i) => ({ id: String(i), vector: vectors[i] ?? [] }))
      const hits = topKSimilar(queryVec, items, maxResults, threshold)
      return hits.map((h) => facts[Number(h.id)]).filter(Boolean)
    } catch (e) {
      log.warn('事实语义检索失败（回退全量注入）', { error: (e as Error).message })
      return []
    }
  })

  // 语义检索：扫描文本 → 向量 → 与各世界书条目余弦相似 → topK
  ipcMain.handle('embedding:semanticSearch', async (
    _e,
    payload: {
      scanText: string
      lorebookIds: string[]
      config: EmbeddingConfig
      threshold?: number
      maxResults?: number
    },
  ) => {
    const { scanText, lorebookIds, config } = payload
    const threshold = typeof payload.threshold === 'number' ? payload.threshold : 0.3
    const maxResults = typeof payload.maxResults === 'number' ? payload.maxResults : 3

    if (!scanText?.trim()) return []
    if (!isEmbeddingConfigured(config)) return []
    if (lorebookIds.length === 0) return []

    try {
      // 1. 收集可参与语义匹配的条目（enabled + matchMode 语义相关）
      const indexed: { lb: Lorebook; vectors: Record<string, number[]> }[] = []
      for (const id of lorebookIds) {
        const lb = readLorebook(id)
        const index = getVectorIndex(id)
        if (!lb || !index) continue
        indexed.push({ lb, vectors: index.entries })
      }
      if (indexed.length === 0) return []

      // 2. 扫描文本嵌入
      const [queryVec] = await embedTexts(config, [scanText])
      if (!queryVec || queryVec.length === 0) return []

      // 3. 逐条目相似度检索（跳过已标记过期的条目，避免旧向量误导）
      const pool: { id: string; lbId: string; score: number }[] = []
      for (const { lb, vectors } of indexed) {
        const index = getVectorIndex(lb.id)
        const stale = new Set(index?.stale ?? [])
        const items = lb.entries
          .filter((e) => e.enabled && isSemanticEligible(e) && vectors[e.id] && !stale.has(e.id))
          .map((e) => ({ id: `${lb.id}:${e.id}`, vector: vectors[e.id] }))
        const hits = topKSimilar(queryVec, items, maxResults * 2, threshold)
        for (const hit of hits) {
          const [lbId, entryId] = hit.id.split(':')
          pool.push({ id: entryId, lbId, score: hit.score })
        }
      }

      // 4. 全局排序取 topK，并附带条目元数据
      pool.sort((a, b) => b.score - a.score)
      const seen = new Set<string>()
      const results: SemanticHit[] = []
      for (const hit of pool) {
        const key = `${hit.lbId}:${hit.id}`
        if (seen.has(key)) continue
        seen.add(key)
        const lb = indexed.find((i) => i.lb.id === hit.lbId)?.lb
        const entry = lb?.entries.find((e) => e.id === hit.id)
        if (!entry) continue
        results.push({
          id: entry.id,
          lbId: hit.lbId,
          content: entry.content,
          position: entry.position,
          order: entry.order,
          depth: entry.position === 'at_depth' ? entry.depth ?? 0 : undefined,
          score: hit.score,
        })
        if (results.length >= maxResults) break
      }
      return results
    } catch (e) {
      log.warn('语义检索失败（静默降级为纯关键词）', { error: (e as Error).message })
      return []
    }
  })
}

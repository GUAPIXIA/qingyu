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
import { DIRS } from '../services/storage'
import { readLorebookView } from '../services/lorebookDocumentStore'
import { embedTexts, testEmbedding, isEmbeddingConfigured, type EmbeddingConfig } from '../services/embedding'
import { getVectorIndex, saveVectorIndex, patchVectorIndex, removeVectorIndex, countIndexedEntries, countStaleEntries } from '../services/vectorStore'
import { safeId } from '../utils/pathGuard'
import { createLogger } from '../services/logger'
import type { Lorebook, LoreEntry } from '../../shared/types'
import type { VectorIndex, VectorSpace } from '../services/vectorStore'
import { topKSimilar } from '../../shared/chat-core/vector'
import { getLocalModelManager } from './localModels'
import { readSettingsFromDisk, restoreSecrets } from './settings'
import { LOCAL_MODEL_RETRIEVAL_PROFILES } from '../services/localModels/catalog'
import { embedLorebookEntries } from '../services/lorebookEmbeddingIndex'
import { isLoreEntrySemanticEligible } from '../../shared/lorebookEmbedding'
import {
  DEFAULT_SIMILARITY_THRESHOLD as SHARED_DEFAULT_SIMILARITY_THRESHOLD,
  REMOTE_INDEX_CHUNK_CHARS as SHARED_REMOTE_INDEX_CHUNK_CHARS,
  mapFactSearchHits as mapFactSearchHitsShared,
  isSemanticEligible as isSemanticEligibleShared,
  vectorSpaceFromConfig as vectorSpaceFromConfigShared,
  isVectorIndexCompatible as isVectorIndexCompatibleShared,
  resolveSemanticThreshold as resolveSemanticThresholdShared,
} from '../../shared/chat-core/embeddingPolicy'

const log = createLogger('embedding-ipc')

async function embedWithProvider(config: EmbeddingConfig, texts: string[], inputKind: 'query' | 'passage'): Promise<number[][]> {
  if (config.provider === 'local') return getLocalModelManager().embed(texts, inputKind)
  return embedTexts(config, texts, inputKind)
}

export function mapFactSearchHits(
  hits: Array<{ id: string; score: number }>,
  facts: string[],
): Array<{ text: string; index: number; score: number }> {
  return mapFactSearchHitsShared(hits, facts)
}

/** 条目是否参与语义匹配 */
export function isSemanticEligible(entry: LoreEntry): boolean {
  return isSemanticEligibleShared(entry)
}

/** 查询向量与索引必须由同一模型生成，否则维度即使碰巧一致，相似度也没有意义。 */
export function vectorSpaceFromConfig(config: EmbeddingConfig): VectorSpace {
  // 判定逻辑在 shared（两端共用）；返回结构一致，此处仅按 Electron 侧类型收窄
  return vectorSpaceFromConfigShared(config) as VectorSpace
}

export function isVectorIndexCompatible(index: Pick<VectorIndex, 'model' | 'provider' | 'modelId' | 'modelVersion'>, config: Pick<EmbeddingConfig, 'model'> & Partial<Pick<EmbeddingConfig, 'provider'>>): boolean {
  return isVectorIndexCompatibleShared(index, config)
}

/** 读取单个世界书 */
function readLorebook(id: string): Lorebook | null {
  safeId(id)
  return readLorebookView(join(DIRS.lorebooks(), `${id}.json`))
}

const DEFAULT_SIMILARITY_THRESHOLD = SHARED_DEFAULT_SIMILARITY_THRESHOLD
const REMOTE_INDEX_CHUNK_CHARS = SHARED_REMOTE_INDEX_CHUNK_CHARS

/** 手动阈值优先；自动模式按已评测的本地模型校准，未知模型使用保守通用值。 */
export function resolveSemanticThreshold(config: EmbeddingConfig, requested?: number): number {
  return resolveSemanticThresholdShared(config, requested, LOCAL_MODEL_RETRIEVAL_PROFILES)
}

function resolveIndexChunkChars(config: EmbeddingConfig): number {
  if (config.provider !== 'local') return REMOTE_INDEX_CHUNK_CHARS
  const manifest = getLocalModelManager().activeManifest()
  if (!manifest || `${manifest.id}@${manifest.version}` !== config.model) {
    throw new Error('当前启用的本地向量模型与语义检索配置不一致')
  }
  // 字符只是切片单位；worker 仍会按 manifest.maxTokens 做真实 tokenizer 截断。
  return Math.max(256, manifest.maxTokens * 2)
}

export async function indexLorebookWithConfig(
  lorebookId: string,
  config: EmbeddingConfig,
  changedIds?: string[],
): Promise<import('../../shared/ipc-api').IndexResult> {
  const lb = readLorebook(lorebookId)
  if (!lb) return { ok: false, error: '世界书不存在' }
  if (!isEmbeddingConfigured(config)) return { ok: false, error: '嵌入服务未配置（需填写模型及有效连接）' }

  const space = vectorSpaceFromConfig(config)
  const current = getVectorIndex(lorebookId, space)
  const incremental = Boolean(changedIds?.length && current && isVectorIndexCompatible(current, config))
  const changed = new Set(changedIds ?? [])
  const sourceEntries = incremental ? lb.entries.filter((entry) => changed.has(entry.id)) : lb.entries
  const allEligible = lb.entries.filter(isLoreEntrySemanticEligible)
  if (!incremental && allEligible.length === 0) return { ok: false, error: '没有可索引的条目（需启用且匹配模式包含“语义”）' }

  try {
    const embedded = await embedLorebookEntries(
      sourceEntries,
      (texts, inputKind) => embedWithProvider(config, texts, inputKind),
      resolveIndexChunkChars(config),
    )
    if (incremental) {
      const patched = patchVectorIndex(
        lorebookId,
        config.model,
        embedded.vectors,
        [...changed],
        space,
        lb.runtime?.revision,
      )
      if (!patched) throw new Error('增量索引的向量空间已变化，请重建索引')
    } else {
      saveVectorIndex(lorebookId, config.model, embedded.vectors, space, lb.runtime?.revision)
    }
    log.info(incremental ? '世界书向量索引已增量更新' : '世界书向量索引完成', {
      lorebookId,
      name: lb.name,
      total: allEligible.length,
      indexed: Object.keys(embedded.vectors).length,
      chunks: embedded.chunkCount,
      revision: lb.runtime?.revision,
    })
    return { ok: true, total: allEligible.length, indexed: Object.keys(embedded.vectors).length, failed: embedded.failed }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const autoIndexQueues = new Map<string, Promise<void>>()
const pendingAutoIndexIds = new Map<string, Set<string>>()

/** 保存世界书后的真实自动索引：同一本书串行收敛到磁盘最新修订，不阻塞保存返回。 */
export function scheduleLorebookAutoIndex(lorebookId: string, changedIds: string[]): void {
  if (changedIds.length === 0) return
  const pending = pendingAutoIndexIds.get(lorebookId) ?? new Set<string>()
  for (const id of changedIds) pending.add(id)
  pendingAutoIndexIds.set(lorebookId, pending)
  if (autoIndexQueues.has(lorebookId)) return

  const run = Promise.resolve().then(async () => {
    while (pending.size > 0) {
      const batch = [...pending]
      pending.clear()
      const settings = readSettingsFromDisk()
      restoreSecrets(settings)
      const config = settings.semanticTrigger
      if (settings.localModels?.autoIndex === false || !config?.enabled || !isEmbeddingConfigured(config)) continue
      const result = await indexLorebookWithConfig(lorebookId, config, batch)
      if (!result.ok) log.warn('世界书自动增量索引失败', { lorebookId, error: result.error })
    }
  })
  const settled = run.catch((error) => {
    log.warn('世界书自动增量索引异常', { lorebookId, error: error instanceof Error ? error.message : String(error) })
  })
  const tracked = settled.finally(() => {
    pendingAutoIndexIds.delete(lorebookId)
    if (autoIndexQueues.get(lorebookId) === tracked) autoIndexQueues.delete(lorebookId)
  })
  autoIndexQueues.set(lorebookId, tracked)
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
  /** 条目手写摘要（阶段三：预算紧张时代替全文注入） */
  summary?: string
}

export function registerEmbeddingIPC(ipcMain: IpcMain): void {
  // 测试嵌入服务连接
  ipcMain.handle('embedding:test', async (_e, config: EmbeddingConfig) => {
    if (config.provider === 'local') {
      const [modelId, version] = config.model.split('@')
      const result = await getLocalModelManager().test(modelId, version)
      return { ok: result.ok, dim: result.dimensions, error: result.error }
    }
    return testEmbedding(config)
  })

  // 为世界书生成/重建向量索引
  ipcMain.handle('embedding:indexLorebook', async (_e, lorebookId: string, config: EmbeddingConfig) => {
    return indexLorebookWithConfig(lorebookId, config)
  })

  // 查询索引状态
  ipcMain.handle('embedding:indexStatus', async (_e, lorebookIds: string[], config?: EmbeddingConfig) => {
    const space = config && isEmbeddingConfigured(config) ? vectorSpaceFromConfig(config) : undefined
    const result: Record<string, { indexed: number; model: string; updatedAt: number; stale: number }> = {}
    for (const id of lorebookIds) {
      safeId(id)
      const index = getVectorIndex(id, space)
      result[id] = index
        ? { indexed: countIndexedEntries(id, space), model: index.model, updatedAt: index.updatedAt, stale: countStaleEntries(id, space) }
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
      return await embedWithProvider(config, texts.map((t) => String(t)), 'passage')
    } catch (e) {
      log.warn('事实向量化失败（回退全量注入）', { error: (e as Error).message })
      return []
    }
  })

  // 事实语义检索：查询 → 向量 → 与事实向量余弦 topK → 返回文本与真实相似度
  ipcMain.handle('embedding:searchFacts', async (_e, payload: {
    query: string
    facts: string[]
    vectors: number[][]
    config: EmbeddingConfig
    threshold?: number
    maxResults?: number
  }) => {
    const { query, facts, vectors, config } = payload
    const threshold = resolveSemanticThreshold(config, payload.threshold)
    const maxResults = typeof payload.maxResults === 'number' ? payload.maxResults : 3
    if (!query?.trim() || !isEmbeddingConfigured(config)) return []
    if (!Array.isArray(facts) || facts.length === 0 || !Array.isArray(vectors) || vectors.length !== facts.length) return []
    try {
      const [queryVec] = await embedWithProvider(config, [query], 'query')
      if (!queryVec || queryVec.length === 0) return []
      const items = facts.map((_, i) => ({ id: String(i), vector: vectors[i] ?? [] }))
      const hits = topKSimilar(queryVec, items, maxResults, threshold)
      return mapFactSearchHits(hits, facts)
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
    const threshold = resolveSemanticThreshold(config, payload.threshold)
    const maxResults = typeof payload.maxResults === 'number' ? payload.maxResults : 3

    if (!scanText?.trim()) return []
    if (!isEmbeddingConfigured(config)) return []
    if (lorebookIds.length === 0) return []

    try {
      // 1. 收集可参与语义匹配的条目（enabled + matchMode 语义相关）
      const indexed: { lb: Lorebook; vectors: Record<string, number[]> }[] = []
      for (const id of lorebookIds) {
        const lb = readLorebook(id)
        const index = getVectorIndex(id, vectorSpaceFromConfig(config))
        if (!lb || !index || !isVectorIndexCompatible(index, config)) continue
        indexed.push({ lb, vectors: index.entries })
      }
      if (indexed.length === 0) return []

      // 2. 扫描文本嵌入
      const [queryVec] = await embedWithProvider(config, [scanText], 'query')
      if (!queryVec || queryVec.length === 0) return []

      // 3. 逐条目相似度检索（跳过已标记过期的条目，避免旧向量误导）
      const pool: { id: string; lbId: string; score: number }[] = []
      for (const { lb, vectors } of indexed) {
        const index = getVectorIndex(lb.id, vectorSpaceFromConfig(config))
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
          summary: entry.summary,
        })
        if (results.length >= maxResults) break
      }
      return results
    } catch (e) {
      log.warn('语义检索失败（静默降级为纯关键词）', { error: (e as Error).message })
      // 空数组表示“语义通道可用，但没有命中”。请求异常必须继续向上抛，
      // 让渲染层能标记通道不可用，并仅使用词法/关键词通道。
      throw e
    }
  })
}

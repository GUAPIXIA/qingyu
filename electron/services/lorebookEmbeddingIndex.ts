import type { LoreEntry } from '../../shared/types'
import {
  buildLoreEntryEmbeddingDocument,
  isLoreEntrySemanticEligible,
  mergeEmbeddingChunkVectors,
  splitEmbeddingDocument,
} from '../../shared/lorebookEmbedding'

export interface EmbeddedLorebookEntries {
  eligibleIds: string[]
  vectors: Record<string, number[]>
  failed: number
  chunkCount: number
  /** UEX-P1-28：因取消提前停止（已完成的向量保留在 vectors 中，不回滚） */
  canceled: boolean
  /** UEX-P1-28：已处理（完成向量化或计入失败）的条目数 */
  processed: number
}

/** UEX-P1-28：逐条目进度载荷（current 含失败条目，进度不失真） */
export interface EmbedLorebookEntryProgress {
  current: number
  total: number
  entryName?: string
}

export interface EmbedLorebookOptions {
  /** UEX-P1-28：取消信号——条目边界检查；可中断的嵌入实现（远程 fetch）会真正中断在途请求 */
  signal?: AbortSignal
  /** UEX-P1-28：每完成一个条目回调一次（进度 x/y + 条目名） */
  onEntry?: (progress: EmbedLorebookEntryProgress) => void
}

/** UEX-P1-28：进度展示用条目名（标题 > 首个关键词 > 正文开头） */
export function loreEntryDisplayName(entry: LoreEntry): string {
  const title = entry.runtime?.title?.trim()
  if (title) return title
  const keyword = (entry.keywords ?? []).map((value) => value.trim()).find(Boolean)
  if (keyword) return keyword
  const content = entry.content?.trim() ?? ''
  if (!content) return entry.id
  return content.length > 20 ? `${content.slice(0, 20)}…` : content
}

/**
 * 对条目文档切片后向量化，再聚合回一条目一向量，兼容现有轻量 JSON 索引。
 * UEX-P1-28：改为逐条目推进——每完成一个条目上报一次进度，条目边界检查取消信号，
 * 取消时保留已完成条目的向量（调用方负责持久化，不回滚）。
 */
export async function embedLorebookEntries(
  entries: LoreEntry[],
  embed: (texts: string[], inputKind: 'passage', signal?: AbortSignal) => Promise<number[][]>,
  maxChunkChars: number,
  options?: EmbedLorebookOptions,
): Promise<EmbeddedLorebookEntries> {
  const eligible = entries.filter(isLoreEntrySemanticEligible)
  const total = eligible.length
  const vectors: Record<string, number[]> = {}
  let failed = 0
  let chunkCount = 0
  let processed = 0
  let canceled = false
  for (const entry of eligible) {
    // UEX-P1-28：条目边界检查取消标志——已取消则停止后续条目，已完成向量保留
    if (options?.signal?.aborted) {
      canceled = true
      break
    }
    const document = buildLoreEntryEmbeddingDocument(entry)
    const texts = splitEmbeddingDocument(document, maxChunkChars)
    chunkCount += texts.length
    let embedded: number[][] = []
    try {
      embedded = texts.length > 0 ? await embed(texts, 'passage', options?.signal) : []
    } catch (error) {
      // UEX-P1-28：取消信号中断在途嵌入不算失败——按取消边界停止，已完成保留
      if (options?.signal?.aborted) {
        canceled = true
        break
      }
      // 既有语义：任一批嵌入失败即抛错（整体索引失败，不写入部分结果）
      throw error
    }
    const chunkVectors = texts.map((_, index) => embedded[index] ?? []).filter((vector) => vector.length > 0)
    const vector = mergeEmbeddingChunkVectors(chunkVectors)
    if (vector.length > 0) vectors[entry.id] = vector
    else failed++
    processed++
    // UEX-P1-28：逐条目推进上报（current 含失败条目，进度不失真）
    options?.onEntry?.({ current: processed, total, entryName: loreEntryDisplayName(entry) })
  }
  return { eligibleIds: eligible.map((entry) => entry.id), vectors, failed, chunkCount, canceled, processed }
}

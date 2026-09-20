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
}

/**
 * 对条目文档切片后批量向量化，再聚合回一条目一向量，兼容现有轻量 JSON 索引。
 */
export async function embedLorebookEntries(
  entries: LoreEntry[],
  embed: (texts: string[], inputKind: 'passage') => Promise<number[][]>,
  maxChunkChars: number,
): Promise<EmbeddedLorebookEntries> {
  const eligible = entries.filter(isLoreEntrySemanticEligible)
  const chunks: Array<{ entryId: string; text: string }> = []
  for (const entry of eligible) {
    const document = buildLoreEntryEmbeddingDocument(entry)
    for (const text of splitEmbeddingDocument(document, maxChunkChars)) chunks.push({ entryId: entry.id, text })
  }
  const embedded = chunks.length > 0 ? await embed(chunks.map((chunk) => chunk.text), 'passage') : []
  const byEntry = new Map<string, number[][]>()
  chunks.forEach((chunk, index) => {
    const vector = embedded[index]
    if (!vector?.length) return
    const current = byEntry.get(chunk.entryId) ?? []
    current.push(vector)
    byEntry.set(chunk.entryId, current)
  })
  const vectors: Record<string, number[]> = {}
  let failed = 0
  for (const entry of eligible) {
    const vector = mergeEmbeddingChunkVectors(byEntry.get(entry.id) ?? [])
    if (vector.length > 0) vectors[entry.id] = vector
    else failed++
  }
  return { eligibleIds: eligible.map((entry) => entry.id), vectors, failed, chunkCount: chunks.length }
}

import type { LoreEntry } from './types'
import { l2Normalize } from './chat-core/vector'

/** 世界书条目是否应进入向量索引。常驻条目无需语义触发。 */
export function isLoreEntrySemanticEligible(entry: LoreEntry): boolean {
  if (!entry.enabled || entry.priority === 'always') return false
  const mode = entry.matchMode ?? 'both'
  return (mode === 'semantic' || mode === 'both') && Boolean(entry.content?.trim())
}

/**
 * 构造用于向量化的检索文档。标题、别名与摘要提供高精度锚点，正文负责语义覆盖。
 * 标签保持稳定，避免不同字段直接拼接造成含义混淆。
 */
export function buildLoreEntryEmbeddingDocument(entry: LoreEntry): string {
  const title = entry.runtime?.title?.trim()
  const keywords = [...(entry.keywords ?? []), ...(entry.secondaryKeywords ?? [])]
    .map((value) => value.trim())
    .filter(Boolean)
  const parts = [
    title ? `标题：${title}` : '',
    keywords.length > 0 ? `关键词：${[...new Set(keywords)].join('、')}` : '',
    entry.summary?.trim() ? `摘要：${entry.summary.trim()}` : '',
    entry.content?.trim() ? `正文：${entry.content.trim()}` : '',
  ]
  return parts.filter(Boolean).join('\n')
}

/** 仅比较会改变向量文档或语义资格的字段。 */
export function loreEntryEmbeddingFingerprint(entry: LoreEntry): string {
  return JSON.stringify({
    eligible: isLoreEntrySemanticEligible(entry),
    document: buildLoreEntryEmbeddingDocument(entry),
  })
}

/** 找出需要失效/重建向量的条目，包含新增与删除。 */
export function diffLoreEntryEmbeddingIds(prev: LoreEntry[], next: LoreEntry[]): string[] {
  const nextMap = new Map(next.map((entry) => [entry.id, entry]))
  const prevMap = new Map(prev.map((entry) => [entry.id, entry]))
  const changed = new Set<string>()
  for (const oldEntry of prev) {
    const newEntry = nextMap.get(oldEntry.id)
    if (!newEntry || loreEntryEmbeddingFingerprint(oldEntry) !== loreEntryEmbeddingFingerprint(newEntry)) {
      changed.add(oldEntry.id)
    }
  }
  for (const entry of next) if (!prevMap.has(entry.id)) changed.add(entry.id)
  return [...changed]
}

/**
 * 长条目按字符边界切片并保留少量重叠，避免只索引正文开头。
 * maxChunks 是存储/耗时保护线；最后一片始终覆盖文档尾部。
 */
export function splitEmbeddingDocument(
  text: string,
  maxChars: number,
  maxChunks = 16,
  overlapRatio = 0.15,
): string[] {
  const clean = text.trim()
  if (!clean) return []
  const size = Math.max(64, Math.floor(maxChars))
  if (clean.length <= size) return [clean]
  const overlap = Math.min(size - 1, Math.max(0, Math.floor(size * overlapRatio)))
  const step = Math.max(1, size - overlap)
  const chunks: string[] = []
  for (let start = 0; start < clean.length && chunks.length < maxChunks; start += step) {
    chunks.push(clean.slice(start, start + size))
    if (start + size >= clean.length) break
  }
  const tail = clean.slice(-size)
  if (chunks[chunks.length - 1] !== tail) {
    if (chunks.length >= maxChunks) chunks[chunks.length - 1] = tail
    else chunks.push(tail)
  }
  return chunks
}

/** 多片向量取质心后重新归一化，维持现有“一条目一向量”索引格式。 */
export function mergeEmbeddingChunkVectors(vectors: number[][]): number[] {
  const usable = vectors.filter((vector) => vector.length > 0 && vector.every(Number.isFinite))
  if (usable.length === 0) return []
  const dimensions = usable[0].length
  const sameSpace = usable.filter((vector) => vector.length === dimensions)
  if (sameSpace.length === 0) return []
  const mean = new Array<number>(dimensions).fill(0)
  for (const vector of sameSpace) {
    for (let index = 0; index < dimensions; index++) mean[index] += vector[index]
  }
  for (let index = 0; index < dimensions; index++) mean[index] /= sameSpace.length
  return l2Normalize(mean)
}

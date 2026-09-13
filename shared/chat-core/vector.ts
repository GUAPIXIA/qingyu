/**
 * 向量工具函数（纯函数，供渲染进程与主进程共用）
 *
 * - cosineSimilarity: 余弦相似度
 * - l2Normalize: L2 归一化（归一化后余弦 = 点积，检索更快）
 * - topKSimilar: 从向量集合中取相似度最高的 K 个
 */

/** 计算两个向量的余弦相似度（0 维向量返回 0） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** L2 归一化向量（零向量返回原样） */
export function l2Normalize(v: number[]): number[] {
  let sumSq = 0
  for (const x of v) sumSq += x * x
  if (sumSq === 0) return v
  const norm = Math.sqrt(sumSq)
  return v.map((x) => x / norm)
}

/** 两个已归一化向量的点积（等价于余弦相似度） */
export function dotProduct(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

export interface VectorItem<T = string> {
  id: T
  vector: number[]
}

export interface SimilarityHit<T = string> {
  id: T
  score: number
}

/**
 * 从向量集合中取与查询向量最相似的 K 个（分数 ≥ minScore）。
 * 输入向量先归一化再点积（归一化后余弦 = 点积）。
 * 返回按分数降序排列。
 */
export function topKSimilar<T = string>(
  query: number[],
  items: VectorItem<T>[],
  k: number,
  minScore = 0,
): SimilarityHit<T>[] {
  if (items.length === 0 || query.length === 0) return []
  const q = l2Normalize(query)
  const scores: SimilarityHit<T>[] = []
  for (const item of items) {
    if (item.vector.length !== q.length) continue
    const score = dotProduct(q, l2Normalize(item.vector))
    if (score >= minScore) scores.push({ id: item.id, score })
  }
  scores.sort((a, b) => b.score - a.score)
  return scores.slice(0, k)
}

import { describe, it, expect } from 'vitest'
import { cosineSimilarity, l2Normalize, dotProduct, topKSimilar } from '../vector'

describe('cosineSimilarity', () => {
  it('相同方向向量相似度为 1', () => {
    expect(cosineSimilarity([1, 0, 0], [2, 0, 0])).toBeCloseTo(1)
  })

  it('相反方向向量相似度为 -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
  })

  it('正交向量相似度为 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('维度不一致返回 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
  })

  it('零向量返回 0', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe('l2Normalize', () => {
  it('归一化后模长为 1', () => {
    const v = l2Normalize([3, 4])
    expect(Math.sqrt(v[0] ** 2 + v[1] ** 2)).toBeCloseTo(1)
  })

  it('零向量原样返回', () => {
    expect(l2Normalize([0, 0])).toEqual([0, 0])
  })

  it('已归一化向量保持模长 1', () => {
    const v = l2Normalize([0.6, 0.8])
    expect(l2Normalize(v)[0]).toBeCloseTo(0.6)
  })
})

describe('dotProduct', () => {
  it('计算点积', () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32)
  })

  it('维度不一致返回 0', () => {
    expect(dotProduct([1], [1, 2])).toBe(0)
  })
})

describe('topKSimilar', () => {
  const items = [
    { id: 'a', vector: [1, 0] },
    { id: 'b', vector: [0.9, 0.1] },
    { id: 'c', vector: [0.1, 0.9] },
    { id: 'd', vector: [-1, 0] },
  ]

  it('按相似度降序返回 topK', () => {
    const hits = topKSimilar([1, 0], items, 2)
    expect(hits.map((h) => h.id)).toEqual(['a', 'b'])
    expect(hits[0].score).toBeCloseTo(1)
  })

  it('过滤低于阈值的条目', () => {
    const hits = topKSimilar([1, 0], items, 10, 0.9)
    expect(hits.map((h) => h.id)).toEqual(['a', 'b'])
  })

  it('K 大于条目数时返回全部（默认阈值 0 过滤负相似度）', () => {
    expect(topKSimilar([1, 0], items, 100).length).toBe(3) // d 相似度为 -1 被过滤
  })

  it('显式降低阈值可纳入负相似度条目', () => {
    expect(topKSimilar([1, 0], items, 100, -1).length).toBe(4)
  })

  it('空集合返回空数组', () => {
    expect(topKSimilar([1, 0], [], 3)).toEqual([])
  })

  it('维度不匹配的条目被跳过', () => {
    const mixed = [{ id: 'x', vector: [1, 0, 0, 0] }, { id: 'y', vector: [1, 0] }]
    const hits = topKSimilar([1, 0], mixed, 10)
    expect(hits.map((h) => h.id)).toEqual(['y'])
  })
})

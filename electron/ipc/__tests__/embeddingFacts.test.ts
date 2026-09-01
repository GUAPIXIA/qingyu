import { describe, expect, it } from 'vitest'
import { isSemanticEligible, isVectorIndexCompatible, mapFactSearchHits } from '../embedding'
import type { LoreEntry } from '../../../shared/types'

describe('fact search hit mapping', () => {
  it('保留向量检索的真实相似度和事实索引', () => {
    expect(mapFactSearchHits([
      { id: '1', score: 0.82 },
      { id: '0', score: 0.61 },
    ], ['事实 A', '事实 B'])).toEqual([
      { text: '事实 B', index: 1, score: 0.82 },
      { text: '事实 A', index: 0, score: 0.61 },
    ])
  })
})

describe('worldbook semantic eligibility', () => {
  const entry = (overrides: Partial<LoreEntry> = {}): LoreEntry => ({
    id: 'e1', keywords: [], content: '设定', position: 'before_char', order: 0,
    probability: 100, enabled: true, matchMode: 'both', ...overrides,
  })

  it('always 条目无条件注入，不参与语义 topK 竞争', () => {
    expect(isSemanticEligible(entry({ priority: 'always' }))).toBe(false)
    expect(isSemanticEligible(entry({ priority: 'detail' }))).toBe(true)
  })
})

describe('worldbook vector index compatibility', () => {
  it('只允许当前嵌入模型读取同模型生成的索引', () => {
    expect(isVectorIndexCompatible({ model: 'text-embedding-3-small' }, { model: 'text-embedding-3-small' })).toBe(true)
    expect(isVectorIndexCompatible({ model: 'text-embedding-3-small' }, { model: 'bge-m3' })).toBe(false)
  })
})

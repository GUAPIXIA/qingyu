import { describe, expect, it } from 'vitest'
import { mapFactSearchHits } from '../embedding'

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

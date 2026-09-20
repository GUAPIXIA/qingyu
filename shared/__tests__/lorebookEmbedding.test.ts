import { describe, expect, it } from 'vitest'
import type { LoreEntry } from '../types'
import {
  buildLoreEntryEmbeddingDocument,
  diffLoreEntryEmbeddingIds,
  loreEntryEmbeddingFingerprint,
  mergeEmbeddingChunkVectors,
  splitEmbeddingDocument,
} from '../lorebookEmbedding'

function entry(overrides: Partial<LoreEntry> = {}): LoreEntry {
  return {
    id: 'entry-1', keywords: ['银狼'], secondaryKeywords: ['月影'], content: '它栖息在北境森林。',
    position: 'before_char', order: 100, probability: 100, enabled: true, matchMode: 'both',
    summary: '北境守护兽', runtime: { insertion: { kind: 'prompt', anchor: 'before_character' }, retrieval: 'hybrid', title: '霜牙' },
    ...overrides,
  }
}

describe('世界书向量文档', () => {
  it('索引标题、关键词、摘要和正文，而非只索引正文', () => {
    const text = buildLoreEntryEmbeddingDocument(entry())
    expect(text).toContain('标题：霜牙')
    expect(text).toContain('关键词：银狼、月影')
    expect(text).toContain('摘要：北境守护兽')
    expect(text).toContain('正文：它栖息在北境森林。')
  })

  it('关键词或摘要变化会使向量指纹变化', () => {
    expect(loreEntryEmbeddingFingerprint(entry({ summary: '旧摘要' })))
      .not.toBe(loreEntryEmbeddingFingerprint(entry({ summary: '新摘要' })))
  })

  it('新增、删除及关键词变化都会进入增量索引清单', () => {
    const previous = [entry({ id: 'changed' }), entry({ id: 'removed' })]
    const next = [entry({ id: 'changed', keywords: ['新别名'] }), entry({ id: 'added' })]
    expect(new Set(diffLoreEntryEmbeddingIds(previous, next))).toEqual(new Set(['changed', 'removed', 'added']))
  })

  it('长文切片始终覆盖尾部', () => {
    const text = `${'A'.repeat(500)}TAIL`
    const chunks = splitEmbeddingDocument(text, 100, 3)
    expect(chunks).toHaveLength(3)
    expect(chunks.at(-1)).toBe(text.slice(-100))
    expect(chunks.at(-1)).toContain('TAIL')
  })

  it('多片向量合并后重新归一化', () => {
    const merged = mergeEmbeddingChunkVectors([[1, 0], [0, 1]])
    expect(merged[0]).toBeCloseTo(Math.SQRT1_2)
    expect(merged[1]).toBeCloseTo(Math.SQRT1_2)
  })
})

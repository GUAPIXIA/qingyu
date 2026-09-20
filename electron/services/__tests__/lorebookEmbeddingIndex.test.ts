import { describe, expect, it, vi } from 'vitest'
import type { LoreEntry } from '../../../shared/types'
import { embedLorebookEntries } from '../lorebookEmbeddingIndex'

function entry(id: string, content: string): LoreEntry {
  return { id, keywords: [], content, position: 'before_char', order: 100, probability: 100, enabled: true, matchMode: 'both' }
}

describe('embedLorebookEntries', () => {
  it('长条目多片向量化后仍只保存一个聚合向量', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map((_, index) => index % 2 === 0 ? [1, 0] : [0, 1]))
    const result = await embedLorebookEntries([entry('long', '内容'.repeat(300))], embed, 100)
    expect(embed).toHaveBeenCalledOnce()
    expect(result.chunkCount).toBeGreaterThan(1)
    expect(Object.keys(result.vectors)).toEqual(['long'])
    expect(result.vectors.long).toHaveLength(2)
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { LoreEntry } from '../../../shared/types'
import { embedLorebookEntries } from '../lorebookEmbeddingIndex'

function entry(id: string, content: string, keywords: string[] = []): LoreEntry {
  return { id, keywords, content, position: 'before_char', order: 100, probability: 100, enabled: true, matchMode: 'both' }
}

describe('embedLorebookEntries', () => {
  it('长条目多片向量化后仍只保存一个聚合向量', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map((_, index) => index % 2 === 0 ? [1, 0] : [0, 1]))
    const result = await embedLorebookEntries([entry('long', '内容'.repeat(300))], embed, 100)
    expect(embed).toHaveBeenCalledOnce()
    expect(result.chunkCount).toBeGreaterThan(1)
    expect(Object.keys(result.vectors)).toEqual(['long'])
    expect(result.vectors.long).toHaveLength(2)
    expect(result.canceled).toBe(false)
    expect(result.processed).toBe(1)
  })

  it('UEX-P1-28：逐条目上报进度（current/total/entryName，标题>关键词>正文开头）', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
    const seen: Array<{ current: number; total: number; entryName?: string }> = []
    const result = await embedLorebookEntries(
      [
        entry('e1', '第一条正文', ['王城']),
        entry('e2', '第二条正文'),
        entry('e3', '内容'.repeat(40)),
      ],
      embed,
      100,
      { onEntry: (progress) => seen.push(progress) },
    )
    expect(result.processed).toBe(3)
    expect(seen.map((p) => p.current)).toEqual([1, 2, 3])
    expect(seen.every((p) => p.total === 3)).toBe(true)
    expect(seen.map((p) => p.entryName)).toEqual(['王城', '第二条正文', `${'内容'.repeat(10)}…`])
  })

  it('UEX-P1-28：取消在条目边界停止，已完成条目向量保留（不回滚）', async () => {
    const controller = new AbortController()
    const embed = vi.fn(async (texts: string[]) => {
      // 第 2 个条目嵌入期间触发取消（底层不可中断时允许其完成，下一条目边界停止）
      if (embed.mock.calls.length === 2) controller.abort()
      return texts.map(() => [1, 0])
    })
    const result = await embedLorebookEntries(
      [entry('e1', '一'), entry('e2', '二'), entry('e3', '三'), entry('e4', '四')],
      embed,
      100,
      { signal: controller.signal },
    )
    expect(embed).toHaveBeenCalledTimes(2)
    expect(result.canceled).toBe(true)
    expect(result.processed).toBe(2)
    expect(result.failed).toBe(0)
    expect(Object.keys(result.vectors)).toEqual(['e1', 'e2'])
  })

  it('UEX-P1-28：取消中断在途嵌入抛错按取消收尾（已完成保留，不计失败）', async () => {
    const controller = new AbortController()
    const embed = vi.fn(async () => {
      controller.abort()
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      throw error
    })
    const result = await embedLorebookEntries(
      [entry('e1', '一'), entry('e2', '二')],
      embed,
      100,
      { signal: controller.signal },
    )
    expect(embed).toHaveBeenCalledTimes(1)
    expect(result.canceled).toBe(true)
    expect(result.processed).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.vectors).toEqual({})
  })

  it('UEX-P1-28：已取消时不再启动任何条目（0/total 也返回取消态）', async () => {
    const controller = new AbortController()
    controller.abort()
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
    const result = await embedLorebookEntries([entry('e1', '一')], embed, 100, { signal: controller.signal })
    expect(embed).not.toHaveBeenCalled()
    expect(result.canceled).toBe(true)
    expect(result.processed).toBe(0)
    expect(result.vectors).toEqual({})
  })
})

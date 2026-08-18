import { describe, expect, it } from 'vitest'
import { buildMemorySummaryWindow } from '../memoryWindow'

type TestMessage = { id: string; content: string }

const messages = (count: number, content = 'x'): TestMessage[] =>
  Array.from({ length: count }, (_, index) => ({ id: `m${index}`, content: `${content}${index}` }))

describe('buildMemorySummaryWindow', () => {
  it('只选择游标之后的增量消息，并保留有限重叠上下文', () => {
    const source = messages(7)
    const window = buildMemorySummaryWindow(source, 'm2', (message) => message.content, (text) => text.length, {
      tokenBudget: 100,
      overlapCount: 2,
    })

    expect(window.overlap.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(window.pending.map((message) => message.id)).toEqual(['m3', 'm4', 'm5', 'm6'])
    expect(window.selected.map((message) => message.id)).toEqual(['m3', 'm4', 'm5', 'm6'])
    expect(window.processedThroughMessageId).toBe('m6')
  })

  it('预算不足时只推进到实际参与总结的最后一条消息', () => {
    const source = messages(5, '12345')
    const window = buildMemorySummaryWindow(source, null, (message) => message.content, (text) => text.length, {
      tokenBudget: 12,
      overlapCount: 0,
    })

    expect(window.selected.map((message) => message.id)).toEqual(['m0', 'm1'])
    expect(window.processedThroughMessageId).toBe('m1')
    expect(window.pending.at(-1)?.id).toBe('m4')
  })

  it('首条待总结消息超出预算时仍完整选中，保证游标可以前进', () => {
    const source = [
      { id: 'm0', content: 'x'.repeat(100) },
      { id: 'm1', content: 'short' },
    ]
    const window = buildMemorySummaryWindow(source, null, (message) => message.content, (text) => text.length, {
      tokenBudget: 10,
      overlapCount: 0,
    })

    expect(window.selected.map((message) => message.id)).toEqual(['m0'])
    expect(window.processedThroughMessageId).toBe('m0')
  })
})

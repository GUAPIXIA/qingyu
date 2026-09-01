import { describe, expect, it } from 'vitest'
import { renderLorebookItems, type LorebookRenderItem } from '../lorebookRenderer'

function item(content: string, insertion: LorebookRenderItem['insertion'], order = 1): LorebookRenderItem {
  return { content, insertion, order, key: `book:${content}` }
}

describe('renderLorebookItems', () => {
  it('将所有标准 prompt anchor 和 chat depth 精确分发', () => {
    const plan = renderLorebookItems([
      item('角色前', { kind: 'prompt', anchor: 'before_character' }),
      item('角色后', { kind: 'prompt', anchor: 'after_character' }),
      item('示例前', { kind: 'prompt', anchor: 'before_examples' }),
      item('示例后', { kind: 'prompt', anchor: 'after_examples' }),
      item('AN 顶部', { kind: 'prompt', anchor: 'authors_note_top' }),
      item('AN 底部', { kind: 'prompt', anchor: 'authors_note_bottom' }),
      item('提示末尾', { kind: 'prompt', anchor: 'prompt_end' }),
      item('聊天深度', { kind: 'chat', depth: 2, role: 'user' }),
    ])

    expect(plan).toMatchObject({
      beforeCharacter: ['角色前'],
      afterCharacter: ['角色后'],
      beforeExamples: ['示例前'],
      afterExamples: ['示例后'],
      authorsNoteTop: ['AN 顶部'],
      authorsNoteBottom: ['AN 底部'],
      promptEnd: ['提示末尾'],
      chat: [{ content: '聊天深度', order: 1, depth: 2, role: 'user' }],
      fallbacks: [],
    })
    expect(plan.decisions.every((decision) => decision.status === 'exact')).toBe(true)
  })

  it('保留 outlet/custom 独立通道，并显式回退到 prompt_end', () => {
    const plan = renderLorebookItems([
      item('资料出口', { kind: 'outlet', name: 'facts' }),
      item('未来位置', { kind: 'custom', source: 'future.adapter', value: { slot: 9 } }),
    ])

    expect(plan.outlets).toEqual({ facts: ['资料出口'] })
    expect(plan.promptEnd).toEqual(['资料出口', '未来位置'])
    expect(plan.fallbacks).toHaveLength(2)
    expect(plan.decisions.map((decision) => decision.status)).toEqual(['fallback', 'fallback'])
    expect(plan.fallbacks[1]).toMatchObject({
      source: 'custom',
      target: 'future.adapter',
      value: { slot: 9 },
    })
  })
})


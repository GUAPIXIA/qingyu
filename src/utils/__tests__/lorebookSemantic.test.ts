import { describe, it, expect } from 'vitest'
import { mergeSemanticHits, triggerLorebooks, type BudgetLoreItem, type LorebookTriggerResult } from '../lorebook'
import type { Lorebook, LoreEntry } from '../../../shared/types'

/** 构造一个仅含语义命中条目的 worldbook 场景辅助 */
function makeEntry(overrides: Partial<LoreEntry>): LoreEntry {
  return {
    id: 'e1',
    keywords: [],
    content: '测试内容',
    position: 'before_char',
    order: 100,
    probability: 100,
    enabled: true,
    ...overrides,
  }
}

function emptyResult(): LorebookTriggerResult {
  return { beforeChar: [], afterChar: [], atEnd: [], atDepth: [], triggeredCount: 0, droppedCount: 0 }
}

const semanticItem = (content: string, order: number, position: BudgetLoreItem['position'] = 'before_char', depth?: number): BudgetLoreItem =>
  ({ content, order, position, depth })

describe('mergeSemanticHits', () => {
  it('无语义命中时返回原结果（不改变引用内容）', () => {
    const base = emptyResult()
    const merged = mergeSemanticHits(base, [], 1000, 'gpt-4o')
    expect(merged).toBe(base)
  })

  it('语义命中并入对应注入段', () => {
    const base: LorebookTriggerResult = {
      beforeChar: ['关键词命中A'],
      afterChar: [],
      atEnd: [],
      atDepth: [],
      triggeredCount: 1,
      droppedCount: 0,
    }
    const merged = mergeSemanticHits(base, [semanticItem('语义命中B', 50)], 1000, 'gpt-4o')
    expect(merged.beforeChar).toEqual(['关键词命中A', '语义命中B'])
    expect(merged.triggeredCount).toBe(2)
  })

  it('与关键词重复的内容去重（不重复注入）', () => {
    const base: LorebookTriggerResult = {
      beforeChar: ['相同内容'],
      afterChar: [],
      atEnd: [],
      atDepth: [],
      triggeredCount: 1,
      droppedCount: 0,
    }
    const merged = mergeSemanticHits(base, [semanticItem('相同内容', 10)], 1000, 'gpt-4o')
    expect(merged.beforeChar).toEqual(['相同内容'])
    expect(merged.triggeredCount).toBe(1)
  })

  it('at_depth 语义命中保留深度信息', () => {
    const base = emptyResult()
    const merged = mergeSemanticHits(base, [semanticItem('深度条目', 5, 'at_depth', 2)], 1000, 'gpt-4o')
    expect(merged.atDepth).toEqual([{ content: '深度条目', order: 5, depth: 2 }])
  })

  it('超出预算的语义命中被丢弃（全部丢弃时返回原结果）', () => {
    const base = emptyResult()
    // 预算 0：语义条目 token 估算 > 0 全部被丢弃，返回原结果引用
    const merged = mergeSemanticHits(base, [semanticItem('超预算内容', 5)], 0, 'gpt-4o')
    expect(merged).toBe(base)
    expect(merged.beforeChar).toEqual([])
    expect(merged.droppedCount).toBe(0)
  })

  it('预算不足时按 order 优先保留小 order 条目', () => {
    const base = emptyResult()
    const big = semanticItem('A'.repeat(2000), 200) // 约 588 token 的长英文
    const small = semanticItem('短内容', 100)
    // 预算 300：只能容纳 short（约 4 token），big 被丢弃
    const merged = mergeSemanticHits(base, [big, small], 300, 'gpt-4o')
    expect(merged.beforeChar).toEqual(['短内容'])
  })
})

describe('triggerLorebooks 与语义模式', () => {
  function makeLorebook(entries: LoreEntry[]): Lorebook {
    return { id: 'lb1', name: '测试', description: '', entries, enabled: true, scanDepth: 4 }
  }

  it('matchMode = semantic 的条目不参与关键词匹配', () => {
    const lb = makeLorebook([
      makeEntry({ id: 'kw', keywords: ['猫娘'], content: '关键词条目', matchMode: 'keyword' }),
      makeEntry({ id: 'se', keywords: ['猫娘'], content: '纯语义条目', matchMode: 'semantic' }),
    ])
    const result = triggerLorebooks({
      lorebooks: [lb],
      scanText: '这里提到了猫娘',
      userName: '用户',
      charName: '角色',
      budget: 1000,
      model: 'gpt-4o',
    })
    expect(result.beforeChar).toEqual(['关键词条目'])
  })

  it('both 模式同时参与关键词匹配', () => {
    const lb = makeLorebook([
      makeEntry({ id: 'both', keywords: ['猫娘'], content: '两者条目', matchMode: 'both' }),
    ])
    const result = triggerLorebooks({
      lorebooks: [lb],
      scanText: '这里提到了猫娘',
      userName: '用户',
      charName: '角色',
      budget: 1000,
      model: 'gpt-4o',
    })
    expect(result.beforeChar).toEqual(['两者条目'])
  })

  it('matchMode 缺省（旧数据）按 both 处理', () => {
    const lb = makeLorebook([
      makeEntry({ id: 'legacy', keywords: ['猫娘'], content: '旧数据条目' }),
    ])
    const result = triggerLorebooks({
      lorebooks: [lb],
      scanText: '这里提到了猫娘',
      userName: '用户',
      charName: '角色',
      budget: 1000,
      model: 'gpt-4o',
    })
    expect(result.beforeChar).toEqual(['旧数据条目'])
  })
})

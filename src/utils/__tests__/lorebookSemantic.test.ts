import { describe, it, expect } from 'vitest'
import { executeLorebookRuntime, type BudgetLoreItem } from '../lorebook'
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

function makeLorebook(entries: LoreEntry[]): Lorebook {
  return { id: 'lb1', name: '测试', description: '', entries, enabled: true, scanDepth: 4 }
}

const semanticItem = (content: string, order: number, position: BudgetLoreItem['position'] = 'before_char', depth?: number): BudgetLoreItem =>
  ({ content, order, position, depth })

const baseOpts = {
  userName: '用户',
  charName: '角色',
  model: 'gpt-4o',
}

describe('语义候选合并（executeLorebookRuntime.semanticItems）', () => {
  it('无语义命中时仅注入关键词触发条目', () => {
    const lb = makeLorebook([makeEntry({ id: 'kw', keywords: ['猫娘'], content: '关键词条目' })])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '这里提到了猫娘', budget: 1000, semanticItems: [],
    })
    expect(result.beforeChar).toEqual(['关键词条目'])
    expect(result.triggeredCount).toBe(1)
    expect(result.droppedCount).toBe(0)
  })

  it('语义候选并入对应注入段（关键词条目在前）', () => {
    const lb = makeLorebook([makeEntry({ id: 'kw', keywords: ['猫娘'], content: '关键词条目' })])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '这里提到了猫娘', budget: 1000,
      semanticItems: [semanticItem('语义命中B', 50)],
    })
    expect(result.beforeChar).toEqual(['关键词条目', '语义命中B'])
    expect(result.triggeredCount).toBe(2)
  })

  it('与关键词触发重复的语义候选去重（不重复注入、不计入 droppedCount）', () => {
    const lb = makeLorebook([makeEntry({ id: 'kw', keywords: ['猫娘'], content: '相同内容' })])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '这里提到了猫娘', budget: 1000,
      semanticItems: [semanticItem('相同内容', 10)],
    })
    expect(result.beforeChar).toEqual(['相同内容'])
    expect(result.triggeredCount).toBe(1)
    expect(result.droppedCount).toBe(0)
  })

  it('at_depth 语义候选保留深度信息', () => {
    const lb = makeLorebook([])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '任意', budget: 1000,
      semanticItems: [semanticItem('深度条目', 5, 'at_depth', 2)],
    })
    expect(result.atDepth).toEqual([{ content: '深度条目', order: 5, depth: 2 }])
  })

  it('超出预算的语义候选被丢弃并计入 droppedCount', () => {
    const lb = makeLorebook([])
    // 预算 0：语义条目 token 估算 > 0 全部被丢弃
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '任意', budget: 0,
      semanticItems: [semanticItem('超预算内容', 5)],
    })
    expect(result.beforeChar).toEqual([])
    expect(result.droppedCount).toBe(1)
    expect(result.conditionalDropped).toBe(1)
  })

  it('预算不足时按 order 优先保留小 order 语义候选', () => {
    const lb = makeLorebook([])
    const big = semanticItem('A'.repeat(2000), 200) // 约 588 token 的长英文
    const small = semanticItem('短内容', 100)
    // 预算 300：只能容纳 short（约 4 token），big 被丢弃
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '任意', budget: 300,
      semanticItems: [big, small],
    })
    expect(result.beforeChar).toEqual(['短内容'])
  })
})

describe('executeLorebookRuntime 与语义模式', () => {
  it('matchMode = semantic 的条目不参与关键词匹配', () => {
    const lb = makeLorebook([
      makeEntry({ id: 'kw', keywords: ['猫娘'], content: '关键词条目', matchMode: 'keyword' }),
      makeEntry({ id: 'se', keywords: ['猫娘'], content: '纯语义条目', matchMode: 'semantic' }),
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '这里提到了猫娘', budget: 1000,
    })
    expect(result.beforeChar).toEqual(['关键词条目'])
  })

  it('both 模式同时参与关键词匹配', () => {
    const lb = makeLorebook([
      makeEntry({ id: 'both', keywords: ['猫娘'], content: '两者条目', matchMode: 'both' }),
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '这里提到了猫娘', budget: 1000,
    })
    expect(result.beforeChar).toEqual(['两者条目'])
  })

  it('matchMode 缺省（旧数据）按 both 处理', () => {
    const lb = makeLorebook([
      makeEntry({ id: 'legacy', keywords: ['猫娘'], content: '旧数据条目' }),
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '这里提到了猫娘', budget: 1000,
    })
    expect(result.beforeChar).toEqual(['旧数据条目'])
  })
})

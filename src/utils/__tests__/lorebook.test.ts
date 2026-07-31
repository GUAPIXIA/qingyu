import { describe, it, expect, vi, afterEach } from 'vitest'
import { keywordMatch, fitLorebookBudget, escapeRegExp, triggerLorebooks, type BudgetLoreItem } from '../lorebook'
import type { Lorebook, LoreEntry } from '../../../shared/types'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('escapeRegExp', () => {
  it('转义正则特殊字符', () => {
    expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c')
    expect(new RegExp(escapeRegExp('c++')).test('c++')).toBe(true)
  })
})

describe('keywordMatch', () => {
  // 拉丁词：词边界匹配
  it('ASCII 关键词按词边界匹配', () => {
    expect(keywordMatch('cat', 'i have a cat here')).toBe(true)
    expect(keywordMatch('cat', 'this is a category')).toBe(false)
    expect(keywordMatch('Cat', 'a cat appears')).toBe(true) // 关键词大小写不敏感（文本由调用方转小写）
  })

  it('ASCII 特殊字符关键词不会导致正则崩溃', () => {
    expect(keywordMatch('c++', 'i write c++ code')).toBe(true)
  })

  // 中文多字词：维持子串召回（不引入漏触发）
  it('中文多字词子串匹配（无词边界要求）', () => {
    expect(keywordMatch('魔法学院', '他走进魔法学院大门')).toBe(true)
    expect(keywordMatch('魔法学院', '他走进了图书馆')).toBe(false)
  })

  // 中文单字：命中处前后需为边界
  it('中文单字要求命中处前后为边界', () => {
    expect(keywordMatch('剑', '剑，向前冲去')).toBe(true) // 文本开头 + 后为标点
    expect(keywordMatch('剑', '（剑）在桌上')).toBe(true) // 前后均为标点
    expect(keywordMatch('剑', '剑')).toBe(true) // 独立成词
    expect(keywordMatch('剑', '他是一名剑士')).toBe(false) // 词中间不命中
    expect(keywordMatch('剑', '他拔出了剑气')).toBe(false) // 前后均非边界
  })

  it('空关键词不匹配', () => {
    expect(keywordMatch('', 'anything')).toBe(false)
    expect(keywordMatch('  ', 'anything')).toBe(false)
  })
})

describe('fitLorebookBudget', () => {
  const item = (content: string, order: number, position: BudgetLoreItem['position'] = 'before_char'): BudgetLoreItem =>
    ({ content, order, position })

  it('按 order 升序注入', () => {
    const { kept } = fitLorebookBudget(
      [item('bbb', 2), item('aaa', 1)],
      10000,
      'gpt-4o-mini',
    )
    expect(kept.map(e => e.content)).toEqual(['aaa', 'bbb'])
  })

  it('超出预算的条目被丢弃，后续更小条目仍可注入', () => {
    const long = '字'.repeat(1000)  // 约 900 tokens
    const short = '短条目'
    const { kept, dropped } = fitLorebookBudget(
      [item(long, 1), item(short, 2)],
      100,
      'gpt-4o-mini',
    )
    expect(kept.map(e => e.content)).toEqual([short])
    expect(dropped).toBe(1)
  })

  it('内容去重', () => {
    const { kept, dropped } = fitLorebookBudget(
      [item('相同内容', 1), item('相同内容', 2, 'at_end')],
      10000,
      'gpt-4o-mini',
    )
    expect(kept.length).toBe(1)
    expect(dropped).toBe(1)
  })

  it('预算充足时全部保留并返回用量', () => {
    const { kept, dropped, usedTokens } = fitLorebookBudget(
      [item('条目一', 1), item('条目二', 2)],
      10000,
      'gpt-4o-mini',
    )
    expect(kept.length).toBe(2)
    expect(dropped).toBe(0)
    expect(usedTokens).toBeGreaterThan(0)
  })
})

describe('triggerLorebooks', () => {
  /** 构造最小测试世界书 */
  function makeLorebook(id: string, entries: Partial<LoreEntry>[]): Lorebook {
    return {
      id,
      name: id,
      description: '',
      enabled: true,
      scanDepth: 10,
      entries: entries.map((e, i) => ({
        id: e.id ?? `e${i}`,
        keywords: e.keywords ?? [],
        content: e.content ?? '',
        position: e.position ?? 'before_char',
        depth: e.depth,
        order: e.order ?? i,
        probability: e.probability ?? 100,
        enabled: e.enabled ?? true,
        useRegex: e.useRegex,
        regexFlags: e.regexFlags,
      })),
    }
  }

  it('按关键词触发并分发到四个插入位置', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['森林'], content: '森林设定', position: 'before_char' },
      { keywords: ['河流'], content: '河流设定', position: 'after_char' },
      { keywords: ['山脉'], content: '山脉设定', position: 'at_end' },
      { keywords: ['古堡'], content: '古堡设定', position: 'at_depth', depth: 2 },
    ])

    const result = triggerLorebooks({
      lorebooks: [lb],
      scanText: '他们穿过森林，渡过河流，翻过山脉，来到古堡前',
      userName: '用户',
      charName: '角色',
      budget: 10000,
      model: 'gpt-4o',
    })

    expect(result.beforeChar).toEqual(['森林设定'])
    expect(result.afterChar).toEqual(['河流设定'])
    expect(result.atEnd).toEqual(['山脉设定'])
    expect(result.atDepth).toEqual([{ content: '古堡设定', order: 3, depth: 2 }])
    expect(result.triggeredCount).toBe(4)
    expect(result.droppedCount).toBe(0)
  })

  it('at_depth 条目默认 depth 为 0（对话末尾）', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['灯塔'], content: '灯塔设定', position: 'at_depth' },
    ])
    const result = triggerLorebooks({
      lorebooks: [lb], scanText: '远处的灯塔亮了', userName: '用户', charName: '角色',
      budget: 10000, model: 'gpt-4o',
    })
    expect(result.atDepth).toEqual([{ content: '灯塔设定', order: 0, depth: 0 }])
  })

  it('递归触发：条目内容可触发其他条目', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['秘境'], content: '秘境开启，出现守护者', position: 'before_char', order: 1 },
      { keywords: ['守护者'], content: '守护者的详细设定', position: 'at_end', order: 2 },
    ])
    const result = triggerLorebooks({
      lorebooks: [lb], scanText: '他走进了秘境', userName: '用户', charName: '角色',
      budget: 10000, model: 'gpt-4o',
    })
    // 秘境触发 → 内容含"守护者" → 守护者条目被递归触发
    expect(result.beforeChar).toEqual(['秘境开启，出现守护者'])
    expect(result.atEnd).toEqual(['守护者的详细设定'])
    expect(result.triggeredCount).toBe(2)
  })

  it('概率 < 100 时按骰子跳过', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['雨'], content: '雨天设定', probability: 0 },
    ])
    const result = triggerLorebooks({
      lorebooks: [lb], scanText: '下雨了', userName: '用户', charName: '角色',
      budget: 10000, model: 'gpt-4o',
    })
    expect(result.triggeredCount).toBe(0)
  })

  it('禁用条目不参与触发', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['下雨'], content: '雨天设定', enabled: false },
      { keywords: ['刮风'], content: '风天设定', enabled: true },
    ])
    const result = triggerLorebooks({
      lorebooks: [lb], scanText: '下雨，又刮风', userName: '用户', charName: '角色',
      budget: 10000, model: 'gpt-4o',
    })
    expect(result.triggeredCount).toBe(1)
    expect(result.beforeChar).toEqual(['风天设定'])
  })

  it('变量替换：{{char}} / {{user}}', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['故乡'], content: '{{char}}的故乡在远方，{{user}}从未去过' },
    ])
    const result = triggerLorebooks({
      lorebooks: [lb], scanText: '回到故乡', userName: '小明', charName: '爱丽丝',
      budget: 10000, model: 'gpt-4o',
    })
    expect(result.beforeChar).toEqual(['爱丽丝的故乡在远方，小明从未去过'])
  })

  it('预算不足时丢弃条目并计数', () => {
    const longContent = '设定'.repeat(500) // 远超预算
    const lb = makeLorebook('lb1', [
      { keywords: ['下雨'], content: longContent, order: 1 },
      { keywords: ['刮风'], content: '短设定', order: 2 },
    ])
    const result = triggerLorebooks({
      lorebooks: [lb], scanText: '下雨，刮风', userName: '用户', charName: '角色',
      budget: 50, model: 'gpt-4o',
    })
    expect(result.triggeredCount).toBe(2)
    expect(result.droppedCount).toBe(1)
    expect(result.beforeChar).toEqual(['短设定'])
  })

  it('正则关键词条目（useRegex）正常触发', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['[0-9]+级'], content: '等级设定', useRegex: true, regexFlags: 'i' },
    ])
    const result = triggerLorebooks({
      lorebooks: [lb], scanText: '他是15级冒险者', userName: '用户', charName: '角色',
      budget: 10000, model: 'gpt-4o',
    })
    expect(result.beforeChar).toEqual(['等级设定'])
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  keywordMatch, escapeRegExp, executeLorebookRuntime, stripMarkdownNoise,
  extractEntities, checkEntityBoost, appendRecentTriggeredIds,
  buildCompressionKey, touchCompressionCache, upsertCompressionCache,
  semanticScoreByOverlap, shouldUseOverlapApprox, allocateGlobalBudgetByBooks,
} from '../lorebook'
import { estimateTokens } from '../tokenCounter'
import { getCollectedLogs } from '../../lib/logger'
import type { Lorebook, LoreEntry, LorebookCompressionCacheEntry } from '../../../shared/types'

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

/** 构造最小测试世界书（extra 支持书级字段如 tokenBudget） */
function makeLorebook(
  id: string,
  entries: Array<Partial<LoreEntry> & Record<string, unknown>>,
  extra?: Partial<Lorebook>,
): Lorebook {
  return {
    id,
    name: id,
    description: '',
    enabled: true,
    scanDepth: 10,
    ...extra,
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
      matchMode: e.matchMode,
      priority: e.priority,
      summary: e.summary,
      secondaryKeywords: e.secondaryKeywords,
      selectiveLogic: e.selectiveLogic,
      caseSensitive: e.caseSensitive,
      matchWholeWords: e.matchWholeWords,
      excludeRecursion: e.excludeRecursion,
      preventRecursion: e.preventRecursion,
      scanDepth: e.scanDepth as number | undefined,
      delayUntilRecursion: e.delayUntilRecursion as number | boolean | undefined,
      inclusionGroups: e.inclusionGroups as string[] | undefined,
      inclusionGroupPrioritized: e.inclusionGroupPrioritized as boolean | undefined,
      inclusionGroupWeight: e.inclusionGroupWeight as number | undefined,
      useGroupScoring: e.useGroupScoring as boolean | undefined,
      characterFilter: e.characterFilter as LoreEntry['characterFilter'],
      generationTriggers: e.generationTriggers as LoreEntry['generationTriggers'],
      sticky: e.sticky as number | undefined,
      cooldown: e.cooldown as number | undefined,
      delay: e.delay as number | undefined,
      ignoreBudget: e.ignoreBudget as boolean | undefined,
      runtime: e.runtime as LoreEntry['runtime'],
    })),
  }
}

const baseOpts = {
  userName: '用户',
  charName: '角色',
  model: 'gpt-4o',
}

describe('executeLorebookRuntime', () => {
  it('统一执行入口保留 canonical 插入位置', () => {
    const lb = makeLorebook('runtime-book', [
      {
        id: 'an-top', keywords: [], content: '作者注释顶部', position: 'at_end', priority: 'always',
        runtime: {
          insertion: { kind: 'prompt', anchor: 'authors_note_top' },
          retrieval: 'semanticRequired',
          adapterId: 'sillytavern.world-info',
        },
      },
      {
        id: 'outlet', keywords: [], content: '出口内容', position: 'at_end', priority: 'always',
        runtime: {
          insertion: { kind: 'outlet', name: 'facts' },
          retrieval: 'keyword',
          adapterId: 'sillytavern.world-info',
        },
      },
    ])
    const opts = {
      ...baseOpts,
      lorebooks: [lb],
      scanText: '',
      budget: 10_000,
      diagnosticsMode: 'preview' as const,
    }

    const result = executeLorebookRuntime(opts)
    expect(result.renderPlan.authorsNoteTop).toEqual(['作者注释顶部'])
    expect(result.renderPlan.outlets).toEqual({ facts: ['出口内容'] })
    expect(result.renderPlan.promptEnd).toEqual(['出口内容'])
    expect(result.atEnd).toEqual(['作者注释顶部', '出口内容'])
    expect(result.diagnostics?.entries.find((detail) => detail.entryId === 'an-top')).toMatchObject({
      adapterId: 'sillytavern.world-info',
      retrievalMode: 'semanticRequired',
      renderStatus: 'exact',
      renderTarget: 'authors_note_top',
    })
    expect(result.diagnostics?.entries.find((detail) => detail.entryId === 'outlet')).toMatchObject({
      renderStatus: 'fallback',
      renderTarget: 'outlet:facts → prompt_end',
    })
  })

  it('收集条目经过匹配、概率与语义可用性检查的诊断轨迹', () => {
    const lb = makeLorebook('debug-book', [
      { id: 'hit', keywords: ['王城'], content: '王城设定' },
      { id: 'secondary', keywords: ['王城'], secondaryKeywords: ['贵族'], selectiveLogic: 'and_any', content: '贵族设定' },
      { id: 'probability', keywords: ['王城'], probability: 0, content: '随机设定' },
      { id: 'semantic', matchMode: 'semantic', keywords: [], content: '纯语义设定' },
    ])

    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '来到王城',
      scanMessages: ['来到王城'],
      budget: 10000,
      semanticEnabled: false,
      diagnosticsMode: 'live',
    })

    const details = new Map(result.diagnostics?.entries.map((detail) => [detail.entryId, detail]))
    expect(details.get('hit')).toMatchObject({ outcome: 'injected', activationSource: 'keyword', stage: 'injection' })
    expect(details.get('hit')?.matchedKeywords).toContainEqual({ keyword: '王城', count: 1, channel: 'primary' })
    expect(details.get('secondary')).toMatchObject({ outcome: 'not_triggered', reason: 'secondary_miss' })
    expect(details.get('probability')).toMatchObject({ outcome: 'not_triggered', reason: 'probability', probability: 0 })
    // 阶段4：legacy semantic → semanticPreferred，无 embeddings 时由本地词法兜底；
    // 词法也未召回时记 retrieval_miss，不再视为语义死条目。
    expect(details.get('semantic')).toMatchObject({
      outcome: 'not_triggered',
      reason: 'retrieval_miss',
      retrievalMode: 'semanticPreferred',
    })
    expect(result.diagnostics?.summary).toMatchObject({
      activeBooks: 1,
      enabledEntries: 4,
      matchedEntries: 2,
      injectedEntries: 1,
      semanticDeadEntries: 0,
    })
  })

  it('预览诊断使用稳定随机序列且保留条目实际扫描文本', () => {
    const lb = makeLorebook('preview-book', [
      { id: 'random', keywords: ['王城'], probability: 50, scanDepth: 1, content: '随机设定' },
    ])
    const opts = {
      ...baseOpts,
      lorebooks: [lb],
      scanText: '旧消息 新消息王城',
      scanMessages: ['旧消息', '新消息王城'],
      budget: 10000,
      diagnosticsMode: 'preview' as const,
    }

    const first = executeLorebookRuntime(opts).diagnostics!.entries[0]
    const second = executeLorebookRuntime(opts).diagnostics!.entries[0]
    expect(first.probabilityRoll).toBe(second.probabilityRoll)
    expect(first.outcome).toBe(second.outcome)
    expect(first.effectiveScanDepth).toBe(1)
    expect(first.scanText).toBe('新消息王城')
  })

  it('区分书级预算与全局优先级预算丢弃', () => {
    const bookLimited = makeLorebook('limited', [
      { id: 'book-drop', keywords: ['命中'], content: '书级预算不足内容' },
    ], { tokenBudget: 1 })
    const globallyLimited = makeLorebook('global', [
      { id: 'global-drop', keywords: ['命中'], content: '全局预算不足内容' },
    ])

    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [bookLimited, globallyLimited],
      scanText: '命中',
      budget: 0,
      diagnosticsMode: 'live',
    })

    const details = new Map(result.diagnostics?.entries.map((detail) => [detail.entryId, detail]))
    expect(details.get('book-drop')).toMatchObject({ outcome: 'dropped', stage: 'book_budget', reason: 'book_budget' })
    expect(details.get('global-drop')).toMatchObject({ outcome: 'dropped', stage: 'global_budget', reason: 'priority_budget' })
  })

  it('按关键词触发并分发到四个插入位置', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['森林'], content: '森林设定', position: 'before_char' },
      { keywords: ['河流'], content: '河流设定', position: 'after_char' },
      { keywords: ['山脉'], content: '山脉设定', position: 'at_end' },
      { keywords: ['古堡'], content: '古堡设定', position: 'at_depth', depth: 2 },
    ])

    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '他们穿过森林，渡过河流，翻过山脉，来到古堡前',
      budget: 10000,
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
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '远处的灯塔亮了', budget: 10000,
    })
    expect(result.atDepth).toEqual([{ content: '灯塔设定', order: 0, depth: 0 }])
  })

  it('递归触发：条目内容可触发其他条目', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['秘境'], content: '秘境开启，出现守护者', position: 'before_char', order: 1 },
      { keywords: ['守护者'], content: '守护者的详细设定', position: 'at_end', order: 2 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '他走进了秘境', budget: 10000,
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
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '下雨了', budget: 10000,
    })
    expect(result.triggeredCount).toBe(0)
  })

  it('禁用条目不参与触发', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['下雨'], content: '雨天设定', enabled: false },
      { keywords: ['刮风'], content: '风天设定', enabled: true },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '下雨，又刮风', budget: 10000,
    })
    expect(result.triggeredCount).toBe(1)
    expect(result.beforeChar).toEqual(['风天设定'])
  })

  it('变量替换：{{char}} / {{user}}', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['故乡'], content: '{{char}}的故乡在远方，{{user}}从未去过' },
    ])
    const result = executeLorebookRuntime({
      lorebooks: [lb], scanText: '回到故乡', userName: '小明', charName: '爱丽丝',
      budget: 10000, model: 'gpt-4o',
    })
    expect(result.beforeChar).toEqual(['爱丽丝的故乡在远方，小明从未去过'])
  })

  it('正则关键词条目（useRegex）正常触发', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['[0-9]+级'], content: '等级设定', useRegex: true, regexFlags: 'i' },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '他是15级冒险者', budget: 10000,
    })
    expect(result.beforeChar).toEqual(['等级设定'])
  })

  it('ST /pattern/flags 正则字面量可与普通关键词混合触发', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['普通词', '/NPC_[A-Z]+/'], content: 'NPC 设定' },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: 'NPC_BOB 出现了', budget: 10000,
    })
    expect(result.beforeChar).toEqual(['NPC 设定'])
  })

  it('二级关键词 AND ALL 必须全部命中', () => {
    const lb = makeLorebook('lb1', [{
      keywords: ['王城'],
      secondaryKeywords: ['帝国', '皇帝'],
      selectiveLogic: 'and_all',
      content: '王城完整设定',
    }])
    const missed = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '帝国的王城', budget: 10000,
    })
    const matched = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '皇帝居住在帝国王城', budget: 10000,
    })
    expect(missed.triggeredCount).toBe(0)
    expect(matched.beforeChar).toEqual(['王城完整设定'])
  })

  it('二级关键词 NOT ANY 在任一排除词命中时阻止触发', () => {
    const lb = makeLorebook('lb1', [{
      keywords: ['王城'],
      secondaryKeywords: ['梦境', '回忆'],
      selectiveLogic: 'not_any',
      content: '现实王城设定',
    }])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '梦境中的王城', budget: 10000,
    })
    expect(result.triggeredCount).toBe(0)
  })

  it('条目级大小写与非整词覆盖默认匹配行为', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['Cat'], content: '大小写设定', caseSensitive: true },
      { keywords: ['dog'], content: '非整词设定', matchWholeWords: false },
    ])
    const lower = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: 'cat 和 dogmatic', budget: 10000,
    })
    const exact = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: 'Cat', budget: 10000,
    })
    expect(lower.beforeChar).toEqual(['非整词设定'])
    expect(exact.beforeChar).toEqual(['大小写设定'])
  })

  it('二级条件同样约束语义候选', () => {
    const lb = makeLorebook('lb1', [{
      id: 'semantic-filtered',
      keywords: [],
      secondaryKeywords: ['帝国'],
      selectiveLogic: 'and_any',
      content: '语义条目',
      matchMode: 'semantic',
    }])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '这里只谈王城',
      budget: 10000,
      semanticItems: [{
        key: 'lb1:semantic-filtered', content: '语义条目', position: 'before_char', order: 0, score: 0.9,
      }],
    })
    expect(result.triggeredCount).toBe(0)
  })

  it('常驻与 sticky 激活跳过关键词二级过滤', () => {
    const alwaysBook = makeLorebook('always-filter', [{
      id: 'always',
      keywords: [],
      secondaryKeywords: ['不存在'],
      selectiveLogic: 'and_any',
      content: '常驻规则',
      priority: 'always',
    }])
    const always = executeLorebookRuntime({
      ...baseOpts, lorebooks: [alwaysBook], scanText: '', budget: 10000,
    })

    const stickyBook = makeLorebook('sticky-filter', [{
      id: 'sticky',
      keywords: ['事件'],
      secondaryKeywords: ['条件'],
      selectiveLogic: 'and_any',
      content: '黏性规则',
      sticky: 3,
    }])
    const activated = executeLorebookRuntime({
      ...baseOpts, lorebooks: [stickyBook], scanText: '事件 条件', budget: 10000, messageCount: 1,
    })
    const sticky = executeLorebookRuntime({
      ...baseOpts, lorebooks: [stickyBook], scanText: '没有关键词', budget: 10000, messageCount: 2,
      timedEffects: activated.timedEffects,
    })

    expect(always.beforeChar).toEqual(['常驻规则'])
    expect(sticky.beforeChar).toEqual(['黏性规则'])
  })

  it('条目或书级递归禁用时不继续级联触发', () => {
    const excluded = makeLorebook('excluded', [
      { keywords: ['秘境'], content: '出现守护者' },
      { keywords: ['守护者'], content: '守护者设定', excludeRecursion: true },
    ])
    const prevented = makeLorebook('prevented', [
      { keywords: ['地宫'], content: '出现魔像', preventRecursion: true },
      { keywords: ['魔像'], content: '魔像设定' },
    ])
    const bookDisabled = makeLorebook('book-disabled', [
      { keywords: ['森林'], content: '出现树妖' },
      { keywords: ['树妖'], content: '树妖设定' },
    ])
    bookDisabled.recursiveScanning = false

    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [excluded, prevented, bookDisabled],
      scanText: '进入秘境、地宫和森林',
      budget: 10000,
    })
    expect(result.beforeChar).toEqual(['出现守护者', '出现魔像', '出现树妖'])
  })

  it('条目级 scanDepth 只扫描指定数量的最近消息', () => {
    const lb = makeLorebook('depth', [
      { keywords: ['远古'], content: '深层命中', scanDepth: 2 },
      { keywords: ['远古'], content: '浅层不应命中', scanDepth: 1 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '远古 最新',
      scanMessages: ['远古', '最新'],
      budget: 10000,
    })
    expect(result.beforeChar).toEqual(['深层命中'])
  })

  it('多本世界书分别遵守各自的书级 scanDepth', () => {
    const shortBook = makeLorebook('short-depth', [
      { keywords: ['远古'], content: '不应跨书扫描命中' },
    ], { scanDepth: 1 })
    const longBook = makeLorebook('long-depth', [], { scanDepth: 2 })
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [shortBook, longBook],
      scanText: '远古 最新',
      scanMessages: ['远古', '最新'],
      budget: 10000,
    })
    expect(result.beforeChar).toEqual([])
  })

  it('delayUntilRecursion 条目只在递归扫描层允许激活', () => {
    const delayedOnly = makeLorebook('delayed-only', [
      { keywords: ['入口'], content: '没有递归层时不出现', delayUntilRecursion: true },
    ])
    const lb = makeLorebook('recursion-delay', [
      { keywords: ['入口'], content: '出现守卫' },
      { keywords: ['守卫'], content: '递归守卫设定', delayUntilRecursion: true },
      { keywords: ['入口'], content: '递归层可重新检查原始消息', delayUntilRecursion: true },
    ])
    const withoutRecursion = executeLorebookRuntime({
      ...baseOpts, lorebooks: [delayedOnly], scanText: '入口', budget: 10000,
    })
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '入口', budget: 10000,
    })
    expect(withoutRecursion.triggeredCount).toBe(0)
    // 评分基于对话文本（不含递归内容）：'入口' 直接命中的两条（同分按 order）排在
    // 仅被递归文本触发 '守卫' 的条目之前（关键词频率计分的行为改进）
    expect(result.beforeChar).toEqual(['出现守卫', '递归层可重新检查原始消息', '递归守卫设定'])
  })

  it('同一包含组优先保留开启 prioritize 的最高 order 条目', () => {
    const lb = makeLorebook('groups', [
      { keywords: ['天气'], content: '普通天气', order: 100, inclusionGroups: ['weather'] },
      { keywords: ['天气'], content: '优先天气', order: 200, inclusionGroups: ['weather'], inclusionGroupPrioritized: true },
      { keywords: ['天气'], content: '低优先天气', order: 150, inclusionGroups: ['weather'], inclusionGroupPrioritized: true },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '天气', budget: 10000,
    })
    expect(result.beforeChar).toEqual(['优先天气'])
  })

  it('包含组可按命中关键词数评分后再仲裁', () => {
    const lb = makeLorebook('group-score', [
      { keywords: ['歌曲'], content: '泛化歌曲', inclusionGroups: ['songs'], useGroupScoring: true },
      { keywords: ['歌曲', '幽灵'], content: '幽灵歌曲', inclusionGroups: ['songs'], useGroupScoring: true },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '唱一首幽灵歌曲', budget: 10000,
    })
    expect(result.beforeChar).toEqual(['幽灵歌曲'])
  })

  it('角色名称、标签与生成类型共同过滤条目', () => {
    const lb = makeLorebook('filters', [
      { keywords: ['触发'], content: 'Alice normal', characterFilter: { exclude: false, names: ['Alice'], tags: [] }, generationTriggers: ['normal'] },
      { keywords: ['触发'], content: 'royal continue', characterFilter: { exclude: false, names: [], tags: ['royal'] }, generationTriggers: ['continue'] },
      { keywords: ['触发'], content: '排除 Alice', characterFilter: { exclude: true, names: ['Alice'], tags: [] } },
    ])
    const normal = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 10000,
      characterNames: ['Alice'], characterTags: ['royal'], generationType: 'normal',
    })
    const continued = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 10000,
      characterNames: ['Alice'], characterTags: ['royal'], generationType: 'continue',
    })
    expect(normal.beforeChar).toEqual(['Alice normal'])
    expect(continued.beforeChar).toEqual(['royal continue'])
  })

  it('delay 按当前会话消息数阻止过早激活', () => {
    const lb = makeLorebook('timed-delay', [
      { keywords: ['事件'], content: '延迟事件', delay: 2 },
    ])
    const early = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '事件', budget: 10000, messageCount: 1,
    })
    const ready = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '事件', budget: 10000, messageCount: 2,
    })
    expect(early.triggeredCount).toBe(0)
    expect(ready.beforeChar).toEqual(['延迟事件'])
  })

  it('sticky 在后续消息中保持激活且不重复概率骰子', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValue(0.99)
    const lb = makeLorebook('timed-sticky', [
      { keywords: ['事件'], content: '黏性事件', probability: 50, sticky: 3 },
    ])
    const activated = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '事件', budget: 10000, messageCount: 2,
    })
    const sticky = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '无关键词', budget: 10000, messageCount: 3,
      timedEffects: activated.timedEffects,
    })
    expect(activated.beforeChar).toEqual(['黏性事件'])
    expect(sticky.beforeChar).toEqual(['黏性事件'])
    expect(random).toHaveBeenCalledTimes(1)
  })

  it('sticky 结束后进入 cooldown，到期才允许再次触发', () => {
    const lb = makeLorebook('timed-cooldown', [
      { keywords: ['事件'], content: '周期事件', sticky: 2, cooldown: 2 },
    ])
    const activated = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '事件', budget: 10000, messageCount: 2,
    })
    const sticky = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '无', budget: 10000, messageCount: 3,
      timedEffects: activated.timedEffects,
    })
    const cooldownStart = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '事件', budget: 10000, messageCount: 4,
      timedEffects: sticky.timedEffects,
    })
    const cooldown = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '事件', budget: 10000, messageCount: 5,
      timedEffects: cooldownStart.timedEffects,
    })
    const expired = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '事件', budget: 10000, messageCount: 6,
      timedEffects: cooldown.timedEffects,
    })
    expect(sticky.beforeChar).toEqual(['周期事件'])
    expect(cooldownStart.triggeredCount).toBe(0)
    expect(cooldown.triggeredCount).toBe(0)
    expect(expired.beforeChar).toEqual(['周期事件'])
  })

  it('历史未前进或条目已编辑时撤销旧 sticky', () => {
    const lb = makeLorebook('timed-reset', [
      { id: 'event', keywords: ['事件'], content: '旧内容', sticky: 3 },
    ])
    const activated = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '事件', budget: 10000, messageCount: 2,
    })
    const sameHistory = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '无', budget: 10000, messageCount: 2,
      timedEffects: activated.timedEffects,
    })
    const edited = makeLorebook('timed-reset', [
      { id: 'event', keywords: ['事件'], content: '新内容', sticky: 3 },
    ])
    const afterEdit = executeLorebookRuntime({
      ...baseOpts, lorebooks: [edited], scanText: '无', budget: 10000, messageCount: 3,
      timedEffects: activated.timedEffects,
    })
    expect(sameHistory.triggeredCount).toBe(0)
    expect(afterEdit.triggeredCount).toBe(0)
  })

  it('ignoreBudget 条目不消耗世界书预算且不会被裁剪', () => {
    const content = '免'.repeat(1000)
    const lb = makeLorebook('ignore-budget', [
      { keywords: ['事件'], content, ignoreBudget: true },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '事件', budget: 1,
    })
    expect(result.beforeChar).toEqual([content])
    expect(result.droppedCount).toBe(0)
  })

  it('旧世界书（无 priority）：按 order 升序注入，预算充足时全部保留', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['触发'], content: 'bbb', order: 2 },
      { keywords: ['触发'], content: 'aaa', order: 1 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 10000,
    })
    expect(result.beforeChar).toEqual(['aaa', 'bbb'])
    expect(result.droppedCount).toBe(0)
  })

  it('超出预算的条目被丢弃，后续更小条目仍可注入', () => {
    const long = '字'.repeat(1000)  // 约 900 tokens
    const short = '短条目'
    const lb = makeLorebook('lb1', [
      { keywords: ['长文'], content: long, order: 1 },
      { keywords: ['短文'], content: short, order: 2 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '这里提到长文和短文', budget: 100,
    })
    expect(result.beforeChar).toEqual([short])
    expect(result.droppedCount).toBe(1)
    expect(result.conditionalDropped).toBe(1)
  })

  it('内容去重：跨条目相同内容只注入一次，且不计入 droppedCount', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['触发'], content: '相同内容', order: 1 },
      { keywords: ['触发'], content: '相同内容', order: 2, position: 'at_end' },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 10000,
    })
    expect(result.beforeChar).toEqual(['相同内容'])
    expect(result.atEnd).toEqual([])
    expect(result.triggeredCount).toBe(1)
    expect(result.droppedCount).toBe(0)
  })
})

// 注：token 估算（estimateTokens，model=gpt-4o）中文约 0.9 token/字，
// 以下预算断言按此构造内容长度（'常'.repeat(500) ≈ 450 tokens）。
describe('优先级分层（瀑布式预算）', () => {
  it('always 条目无需关键词命中即注入', () => {
    const lb = makeLorebook('lb1', [
      { keywords: [], content: '世界规则', priority: 'always' },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '与条目毫无关系的文本', budget: 10000,
    })
    expect(result.beforeChar).toEqual(['世界规则'])
    expect(result.triggeredCount).toBe(1)
  })

  it('always 条目超 40% 硬上限时按 order 截断，返回 alwaysDropped > 0', () => {
    const lb = makeLorebook('lb1', [
      { keywords: [], content: '常'.repeat(500), priority: 'always', order: 1 }, // ≈450 tokens > 400
      { keywords: [], content: '常驻条目', priority: 'always', order: 2 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '无关', budget: 1000,
    })
    expect(result.beforeChar).toEqual(['常驻条目'])
    expect(result.alwaysDropped).toBe(1)
    expect(result.droppedCount).toBe(1)
  })

  it('本轮有 detail 触发时，conditional 累计不超过 90%', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['设定'], content: '条'.repeat(1100), order: 1 }, // ≈990 tokens > 900
      { keywords: ['细节'], content: '细节补充', priority: 'detail', order: 2 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '提到了设定和细节', budget: 1000,
    })
    expect(result.beforeChar).toEqual(['细节补充']) // 990 > 900 被截断，detail 用剩余额度注入
    expect(result.conditionalDropped).toBe(1)
    expect(result.detailDropped).toBe(0)
  })

  it('无 detail 触发时 conditional 可用满预算（旧行为精确一致）', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['设定'], content: '条'.repeat(1100), order: 1 }, // ≈990 tokens ≤ 1000
      { keywords: ['细节'], content: '细节补充', priority: 'detail', order: 2 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '提到了设定', budget: 1000,
    })
    expect(result.beforeChar).toEqual(['条'.repeat(1100)]) // detail 未触发 → 无 90% 上限
    expect(result.droppedCount).toBe(0)
  })

  it('detail 仅使用剩余额度，被截断不影响已注入条目', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['设定'], content: '条'.repeat(990), order: 1 }, // ≈891 tokens
      { keywords: ['细节'], content: '细'.repeat(200), priority: 'detail', order: 2 }, // ≈180 tokens
      { keywords: ['细节'], content: '小细节', priority: 'detail', order: 3 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '提到了设定和细节', budget: 1000,
    })
    // conditional 占 891 → detail 剩余 109：180 超限被截断，3 tokens 的小条目仍注入
    expect(result.beforeChar).toEqual(['条'.repeat(990), '小细节'])
    expect(result.conditionalDropped).toBe(0)
    expect(result.detailDropped).toBe(1)
  })

  it('priority 为 undefined 与显式 conditional 等价（受 90% 约束）', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['设定'], content: '条'.repeat(1100), order: 1 }, // undefined
      { keywords: ['设定'], content: '款'.repeat(1100), priority: 'conditional', order: 2 },
      { keywords: ['细节'], content: '细节', priority: 'detail', order: 3 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '设定与细节', budget: 1000,
    })
    expect(result.conditionalDropped).toBe(2) // 两条 ≈990 tokens 均超 900 上限
    expect(result.beforeChar).toEqual(['细节'])
  })

  it('跨段同一 content 只注入一次（全局去重）', () => {
    const lb = makeLorebook('lb1', [
      { keywords: [], content: '相同内容', priority: 'always', order: 2 },
      { keywords: ['触发'], content: '相同内容', order: 1 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 10000,
    })
    expect(result.beforeChar).toEqual(['相同内容'])
    expect(result.beforeChar.length).toBe(1)
    expect(result.triggeredCount).toBe(1)
    expect(result.droppedCount).toBe(0)
  })

  it('三段注入总量不超过预算', () => {
    const lb = makeLorebook('lb1', [
      { keywords: [], content: '常驻规则', priority: 'always', order: 1 }, // ≈4 tokens
      { keywords: ['设定'], content: '条'.repeat(60), order: 2 },          // ≈54 tokens
      { keywords: ['细节'], content: '细'.repeat(20), priority: 'detail', order: 3 }, // ≈18 tokens
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '提到了设定和细节', budget: 100,
    })
    expect(result.triggeredCount).toBe(3)
    expect(result.droppedCount).toBe(0)
    const total = result.beforeChar.reduce((sum, c) => sum + estimateTokens(c, 'gpt-4o'), 0)
    expect(total).toBeLessThanOrEqual(100)
  })

  it('语义候选与关键词触发内容重复时只注入一次，且不计入 droppedCount', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['猫娘'], content: '相同内容', order: 1 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '这里提到了猫娘', budget: 10000,
      semanticItems: [
        { content: '相同内容', order: 10, position: 'before_char' },
        { content: '语义补充', order: 20, position: 'before_char' },
      ],
    })
    expect(result.beforeChar).toEqual(['相同内容', '语义补充'])
    expect(result.triggeredCount).toBe(2)
    expect(result.droppedCount).toBe(0)
  })

  it('matchMode = semantic 且 priority = always 的条目仍无条件注入', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['猫娘'], content: '常驻语义条目', matchMode: 'semantic', priority: 'always' },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '这里提到了猫娘', budget: 10000,
    })
    expect(result.beforeChar).toEqual(['常驻语义条目'])
  })

  it('always 条目内容参与递归触发', () => {
    const lb = makeLorebook('lb1', [
      { keywords: [], content: '世界规则中出现守护者', priority: 'always', order: 1 },
      { keywords: ['守护者'], content: '守护者设定', order: 2 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '无关内容', budget: 10000,
    })
    expect(result.beforeChar).toEqual(['世界规则中出现守护者', '守护者设定'])
    expect(result.triggeredCount).toBe(2)
  })

  it('统一评分下关键词满命中条目排在纯语义候选之前', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['猫娘'], content: '关键词', order: 90 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '这里提到了猫娘', budget: 10000,
      semanticItems: [{ content: '语义', order: 10, position: 'before_char', score: 0.9 }],
    })
    // 关键词条目：0.35×1 + 0.15（实体）= 0.5；语义候选：0.35×0.9 = 0.315
    expect(result.beforeChar).toEqual(['关键词', '语义'])
  })
})

// ===================== 阶段二：统一评分排序（2A 语义 score + 2B 实体/近因） =====================

describe('语义 score 排序（阶段二A）', () => {
  it('语义候选按相似度降序注入', () => {
    const lb = makeLorebook('lb1', [])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '任意', budget: 10000,
      semanticItems: [
        { content: '低分条目', order: 1, position: 'before_char', score: 0.5 },
        { content: '高分条目', order: 2, position: 'before_char', score: 0.9 },
      ],
    })
    expect(result.beforeChar).toEqual(['高分条目', '低分条目'])
  })

  it('预算不足时低分语义候选先被裁剪', () => {
    const lb = makeLorebook('lb1', [])
    const big = 'A'.repeat(2000)   // 约 588 tokens
    const small = '短内容'
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '任意', budget: 300,
      semanticItems: [
        { content: big, order: 1, position: 'before_char', score: 0.9 },
        { content: small, order: 2, position: 'before_char', score: 0.5 },
      ],
    })
    expect(result.beforeChar).toEqual([small])
    expect(result.droppedCount).toBe(1)
  })

  it('score 相同时按 order 升序（稳定排序）', () => {
    const lb = makeLorebook('lb1', [])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '任意', budget: 10000,
      semanticItems: [
        { content: '乙', order: 2, position: 'before_char', score: 0.8 },
        { content: '甲', order: 1, position: 'before_char', score: 0.8 },
      ],
    })
    expect(result.beforeChar).toEqual(['甲', '乙'])
  })

  it('语义候选无 score（旧缓存）时回退 order 排序，不报错', () => {
    const lb = makeLorebook('lb1', [])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '任意', budget: 10000,
      semanticItems: [
        { content: '乙', order: 2, position: 'before_char' },
        { content: '甲', order: 1, position: 'before_char' },
      ],
    })
    expect(result.beforeChar).toEqual(['甲', '乙'])
  })
})

describe('统一评分模型（阶段二B）', () => {
  it('关键词命中 + 语义高分的条目排在仅语义命中的条目之前', () => {
    const lb = makeLorebook('lb1', [
      { id: 'a', keywords: ['触发'], content: '条目A', order: 2 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 10000,
      semanticItems: [
        // 条目A 同时被语义命中：内容反查补回语义分
        { content: '条目A', order: 2, position: 'before_char', score: 0.9, key: 'lb1:a' },
        { content: '条目B', order: 1, position: 'before_char', score: 0.9 },
      ],
    })
    // A：0.35×1 + 0.35×0.9 + 0.15（实体）= 0.815；B：0.35×0.9 = 0.315
    expect(result.beforeChar).toEqual(['条目A', '条目B'])
    expect(result.triggeredCount).toBe(2)
  })

  it('实体命中（受控词表 ∩ 最近扫描文本）加权排序靠前', () => {
    const lb = makeLorebook('lb1', [
      { id: 'x', keywords: ['触发'], content: '条目X提到了灵界', order: 1 },
      { id: 'y', keywords: ['触发'], content: '条目Y', order: 2 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发 灵界', budget: 10000,
      entityVocabulary: ['灵界'],
    })
    // X 与 Y 关键词命中率相同；X 的内容包含最近实体「灵界」→ entity 加成
    expect(result.beforeChar).toEqual(['条目X提到了灵界', '条目Y'])
  })

  it('最近 N 轮触发过的条目获得 recency 加权', () => {
    const lb = makeLorebook('lb1', [
      { id: 'm', keywords: ['触发'], content: '旧条目', order: 1 },
      { id: 'n', keywords: ['触发'], content: '新条目', order: 2 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 10000,
      recentTriggeredIds: [['lb1:n']],
    })
    // 基础分相同；n 上一轮触发过 → recency 加成
    expect(result.beforeChar).toEqual(['新条目', '旧条目'])
  })

  it('超出 recency 窗口（5 轮）的条目无加权', () => {
    const lb = makeLorebook('lb1', [
      { id: 'm', keywords: ['触发'], content: '旧条目', order: 1 },
      { id: 'n', keywords: ['触发'], content: '新条目', order: 2 },
    ])
    // 6 轮记录：'lb1:n' 在第 1 轮，已被环形缓冲挤出窗口
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 10000,
      recentTriggeredIds: [['lb1:n'], [], [], [], [], []],
    })
    expect(result.beforeChar).toEqual(['旧条目', '新条目'])
  })

  it('旧会话无 recentTriggeredIds 时不报错，recency 加权为 0', () => {
    const lb = makeLorebook('lb1', [
      { id: 'm', keywords: ['触发'], content: '条目', order: 1 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 10000,
    })
    expect(result.beforeChar).toEqual(['条目'])
    expect(result.triggeredEntryKeys).toEqual(['lb1:m'])
  })

  it('输出本轮触发键（triggeredEntryKeys）供会话 recency 窗口更新', () => {
    const lb = makeLorebook('lb1', [
      { id: 'a', keywords: [], content: '常驻', priority: 'always', order: 1 },
      { id: 'b', keywords: ['触发'], content: '条件条目', order: 2 },
      { id: 'c', keywords: [], content: '语义条目', matchMode: 'semantic', order: 3 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 10000,
      semanticItems: [{ content: '语义条目', order: 3, position: 'before_char', score: 0.8, key: 'lb1:c' }],
    })
    expect(result.triggeredEntryKeys).toEqual(['lb1:a', 'lb1:b', 'lb1:c'])
  })

  it('纯语义命中从条目 key 恢复 detail 优先级，而不是按 conditional 处理', () => {
    const lb = makeLorebook('lb1', [
      { id: 'detail', keywords: [], content: '语义细节', matchMode: 'semantic', priority: 'detail' },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '无关键词命中',
      budget: 1,
      semanticItems: [{
        content: '语义细节', order: 0, position: 'before_char', score: 0.9, key: 'lb1:detail',
      }],
    })
    expect(result.detailDropped).toBe(1)
    expect(result.conditionalDropped).toBe(0)
  })
})

describe('appendRecentTriggeredIds（recency 环形缓冲）', () => {
  it('追加本轮触发键并裁剪超出窗口的轮次', () => {
    expect(appendRecentTriggeredIds(undefined, ['a'])).toEqual([['a']])
    expect(appendRecentTriggeredIds([['a'], ['b']], ['c'])).toEqual([['a'], ['b'], ['c']])
    // 窗口 3：最早一轮被挤出
    expect(appendRecentTriggeredIds([['a'], ['b'], ['c']], ['d'], 3)).toEqual([['b'], ['c'], ['d']])
  })

  it('空触发仍推进真实轮次，使旧触发按对话轮次过期', () => {
    expect(appendRecentTriggeredIds([['a']], [])).toEqual([['a'], []])
    expect(appendRecentTriggeredIds([['a'], [], []], [], 3)).toEqual([[], [], []])
    expect(appendRecentTriggeredIds(undefined, [])).toEqual([])
  })
})

describe('extractEntities / checkEntityBoost（受控词表）', () => {
  it('仅收集词表中确实出现在最近扫描文本里的实体', () => {
    const lb = makeLorebook('lb1', [
      { keywords: ['灵界', '魔塔'], content: '...' },
      { keywords: ['禁用词'], content: '...', enabled: false },
    ])
    const entities = extractEntities({
      scanTextLower: '他们进入了灵界，经过了魔塔山下'.toLowerCase(),
      charName: '爱丽丝',
      entityVocabulary: ['小明'],
      lorebooks: [lb],
    })
    expect(entities.has('灵界')).toBe(true)
    expect(entities.has('魔塔')).toBe(true)      // 多字词子串命中
    expect(entities.has('爱丽丝')).toBe(false)   // 未出现在扫描文本
    expect(entities.has('小明')).toBe(false)     // 未出现在扫描文本
    expect(entities.has('禁用词')).toBe(false)   // 禁用条目 keywords 不入词表
  })

  it('多字词按子串命中（中文无词边界）', () => {
    const lb = makeLorebook('lb1', [{ keywords: ['魔塔'], content: '...' }])
    const entities = extractEntities({
      scanTextLower: '魔塔山下'.toLowerCase(),
      charName: '角色',
      lorebooks: [lb],
    })
    expect(entities.has('魔塔')).toBe(true)
  })

  it('checkEntityBoost：keywords 直接命中或内容包含（大小写不敏感，双字以上）', () => {
    const entities = new Set(['灵界', 'crystal'])
    expect(checkEntityBoost({ keywords: ['灵界'], content: '任意' }, entities)).toBe(true)
    expect(checkEntityBoost({ keywords: [], content: '这里提到灵界' }, entities)).toBe(true)
    expect(checkEntityBoost({ keywords: [], content: 'Crystal Tower 耸立' }, entities)).toBe(true)
    expect(checkEntityBoost({ keywords: ['别的'], content: '无关内容' }, entities)).toBe(false)
  })
})

// ===================== 阶段三：超限压缩（summary 优先 + AI 兜底） =====================

describe('超限压缩（阶段三）', () => {
  // 场景：A 全文保留（≈810 token），B 超限但手写摘要可容纳，C 无摘要被丢弃进入压缩请求
  const bigA = '甲'.repeat(900)
  const bigB = '乙'.repeat(900)
  const bigC = '丙'.repeat(900)

  function makeOverflowLb(): Lorebook {
    return makeLorebook('lb1', [
      { id: 'a', keywords: ['触发'], content: bigA, order: 1 },
      { id: 'b', keywords: ['触发'], content: bigB, order: 2, summary: '乙的摘要' },
      { id: 'c', keywords: ['触发'], content: bigC, order: 3 },
    ])
  }

  it('超限时优先使用手写 summary 替代全文，未设 summary 的进入压缩请求', () => {
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [makeOverflowLb()], scanText: '触发', budget: 1000,
    })
    expect(result.beforeChar).toEqual([bigA, '乙的摘要'])
    expect(result.compressionRequests).toHaveLength(1)
    expect(result.compressionRequests![0].contents).toEqual([bigC])
    expect(result.compressionRequests![0].entryKeys).toEqual(['lb1:c'])
  })

  it('压缩目标锚定剩余预算（= 预算 − 已注入全文/摘要的 token）', () => {
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [makeOverflowLb()], scanText: '触发', budget: 1000,
    })
    const expected = 1000 - estimateTokens(bigA, 'gpt-4o') - estimateTokens('乙的摘要', 'gpt-4o')
    expect(result.compressionRequests![0].targetTokens).toBe(expected)
    expect(result.compressionRequests![0].targetTokens).toBeGreaterThan(0)
  })

  it('压缩缓存命中时以缓存摘要注入，且不再发出压缩请求', () => {
    const key = buildCompressionKey([{ key: 'lb1:c', content: bigC }])
    const cache: Record<string, LorebookCompressionCacheEntry> = {
      [key]: { summary: 'C 条目的合并摘要', entryKeys: ['lb1:c'], createdAt: Date.now() },
    }
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [makeOverflowLb()], scanText: '触发', budget: 1000,
      compressionCache: cache,
    })
    expect(result.beforeChar).toEqual([bigA, '乙的摘要', 'C 条目的合并摘要'])
    expect(result.compressionRequests).toBeUndefined()
    // 被摘要覆盖的条目不计入丢弃
    expect(result.droppedCount).toBe(0)
  })

  it('条目内容编辑后缓存 key 变化，缓存天然失效（重新发出请求）', () => {
    // 缓存按「编辑前的旧内容」建立 key → 与当前内容不匹配
    const staleKey = buildCompressionKey([{ key: 'lb1:c', content: '已被编辑的旧内容' }])
    const cache: Record<string, LorebookCompressionCacheEntry> = {
      [staleKey]: { summary: '过期摘要', entryKeys: ['lb1:c'], createdAt: Date.now() },
    }
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [makeOverflowLb()], scanText: '触发', budget: 1000,
      compressionCache: cache,
    })
    expect(result.beforeChar).toEqual([bigA, '乙的摘要'])
    expect(result.compressionRequests).toHaveLength(1)
    expect(result.compressionRequests![0].key).toBe(buildCompressionKey([{ key: 'lb1:c', content: bigC }]))
  })

  it('缓存摘要超出剩余预算时不注入，重新发出更小目标的请求', () => {
    const key = buildCompressionKey([{ key: 'lb1:c', content: bigC }])
    const hugeSummary = '概'.repeat(500) // ≈450 token > 剩余 ≈186
    const cache: Record<string, LorebookCompressionCacheEntry> = {
      [key]: { summary: hugeSummary, entryKeys: ['lb1:c'], createdAt: Date.now() },
    }
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [makeOverflowLb()], scanText: '触发', budget: 1000,
      compressionCache: cache,
    })
    expect(result.beforeChar).toEqual([bigA, '乙的摘要'])
    expect(result.compressionRequests).toHaveLength(1)
    expect(result.compressionRequests![0].targetTokens).toBeLessThan(hugeSummary.length)
  })

  it('always 段超限截断不参与压缩（dropped 但无压缩请求）', () => {
    const lb = makeLorebook('lb1', [
      { keywords: [], content: '常'.repeat(300), priority: 'always', order: 1 }, // ≈270 ≤ 400
      { keywords: [], content: '驻'.repeat(500), priority: 'always', order: 2 }, // ≈450 > 400 硬上限
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '无关', budget: 1000,
    })
    expect(result.beforeChar).toEqual(['常'.repeat(300)])
    expect(result.alwaysDropped).toBe(1)
    // 无 conditional/detail 条目被丢弃 → 不发出压缩请求
    expect(result.compressionRequests).toBeUndefined()
  })

  it('不同插入位置与 depth 的溢出条目分别压缩', () => {
    const content = '设'.repeat(900)
    const lb = makeLorebook('lb1', [
      { id: 'keep', keywords: ['触发'], content, position: 'before_char', order: 1 },
      { id: 'before', keywords: ['触发'], content: '前'.repeat(900), position: 'before_char', order: 2 },
      { id: 'end', keywords: ['触发'], content: '末'.repeat(900), position: 'at_end', order: 3 },
      { id: 'depth1', keywords: ['触发'], content: '深'.repeat(900), position: 'at_depth', depth: 1, order: 4 },
      { id: 'depth2', keywords: ['触发'], content: '层'.repeat(900), position: 'at_depth', depth: 2, order: 5 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 1200,
    })
    expect(result.compressionRequests).toHaveLength(4)
    expect(result.compressionRequests!.map((request) => request.placement)).toEqual([
      { position: 'before_char' },
      { position: 'at_end' },
      { position: 'at_depth', depth: 1 },
      { position: 'at_depth', depth: 2 },
    ])
    expect(result.compressionRequests!.reduce((sum, request) => sum + request.targetTokens, 0))
      .toBeLessThanOrEqual(1200 - estimateTokens(content, 'gpt-4o'))
  })

  it('高分条目全文放不下时立即尝试摘要，不被低分全文挤掉', () => {
    const high = '高'.repeat(150)
    const low = '低'.repeat(100)
    const lb = makeLorebook('lb1', [
      { id: 'high', keywords: [], content: high, summary: '高分摘要', matchMode: 'semantic', order: 1 },
      { id: 'low', keywords: [], content: low, matchMode: 'semantic', order: 2 },
    ])
    const lowTokens = estimateTokens(low, 'gpt-4o')
    const summaryTokens = estimateTokens('高分摘要', 'gpt-4o')
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '',
      budget: lowTokens + summaryTokens,
      semanticItems: [
        { content: high, order: 1, position: 'before_char', score: 0.9, key: 'lb1:high' },
        { content: low, order: 2, position: 'before_char', score: 0.1, key: 'lb1:low' },
      ],
    })
    expect(result.beforeChar).toEqual(['高分摘要', low])
  })
})

describe('upsertCompressionCache（LRU 淘汰）', () => {
  it('超过上限时淘汰最久未使用的条目', () => {
    let cache: Record<string, LorebookCompressionCacheEntry> | undefined
    for (let i = 0; i < 12; i++) {
      cache = upsertCompressionCache(cache, `k${i}`, { summary: `s${i}`, entryKeys: [], createdAt: i })
    }
    expect(Object.keys(cache!).length).toBe(10)
    expect(cache!['k0']).toBeUndefined()
    expect(cache!['k1']).toBeUndefined()
    expect(cache!['k2']).toBeDefined()
    expect(cache!['k11']).toBeDefined()
  })

  it('同 key 覆盖不增加条目数', () => {
    let cache: Record<string, LorebookCompressionCacheEntry> | undefined
    cache = upsertCompressionCache(cache, 'k', { summary: 'v1', entryKeys: [], createdAt: 1 })
    cache = upsertCompressionCache(cache, 'k', { summary: 'v2', entryKeys: [], createdAt: 2 })
    expect(Object.keys(cache).length).toBe(1)
    expect(cache['k'].summary).toBe('v2')
  })

  it('缓存命中后刷新 LRU，避免活跃摘要被淘汰', () => {
    let cache: Record<string, LorebookCompressionCacheEntry> = {
      active: { summary: 'active', entryKeys: [], createdAt: 1 },
      stale: { summary: 'stale', entryKeys: [], createdAt: 2 },
    }
    cache = touchCompressionCache(cache, ['active'], 100)!
    cache = upsertCompressionCache(cache, 'new', { summary: 'new', entryKeys: [], createdAt: 3 }, 2)
    expect(cache.active).toBeDefined()
    expect(cache.stale).toBeUndefined()
    expect(cache.new).toBeDefined()
  })
})

// ===================== 书级 tokenBudget 裁剪 + 语义死条目告警 =====================

describe('书级 tokenBudget 裁剪', () => {
  it('超出书级预算的条目被丢弃并计入 bookBudgetDropped', () => {
    const cA = '甲的设定内容'
    const cB = '乙的设定内容'
    const cC = '丙的设定内容'
    const lb = makeLorebook('lbBudget', [
      { keywords: ['触发'], content: cA, order: 1 },
      { keywords: ['触发'], content: cB, order: 2 },
      { keywords: ['触发'], content: cC, order: 3 },
    ], { tokenBudget: estimateTokens(cA, 'gpt-4o') + estimateTokens(cB, 'gpt-4o') })

    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 10000,
    })
    // 同分稳定排序（order 升序）→ 前两条保留，第三条超出书级预算被丢弃
    expect(result.beforeChar).toEqual([cA, cB])
    expect(result.triggeredCount).toBe(3)
    expect(result.bookBudgetDropped).toBe(1)
    expect(result.droppedCount).toBe(1)
  })

  it('书级超限条目优先以手写 summary 替代全文', () => {
    const full = '戊'.repeat(200)
    const lb = makeLorebook('lbSum', [
      { keywords: ['触发'], content: full, order: 1, summary: '戊的摘要' },
    ], { tokenBudget: estimateTokens('戊的摘要', 'gpt-4o') })

    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 10000,
    })
    expect(result.beforeChar).toEqual(['戊的摘要'])
    expect(result.bookBudgetDropped).toBeUndefined()
    expect(result.droppedCount).toBe(0)
  })

  it('未定义 tokenBudget 的书与 ignoreBudget 条目不受书级限制', () => {
    const capped = makeLorebook('lbCap', [
      { keywords: ['触发'], content: '甲内容', order: 1 },
    ], { tokenBudget: estimateTokens('甲内容', 'gpt-4o') })
    const free = makeLorebook('lbFree', [
      { keywords: ['触发'], content: '乙内容', order: 2 },
    ])
    // tokenBudget = 0 是旧数据中的“未设置”值；ignoreBudget 条目仍正常注入
    const ignore = makeLorebook('lbIgnore', [
      { keywords: ['触发'], content: '丙'.repeat(300), order: 3, ignoreBudget: true },
    ], { tokenBudget: 0 })

    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [capped, free, ignore], scanText: '触发', budget: 10000,
    })
    expect(result.beforeChar).toEqual(['甲内容', '乙内容', '丙'.repeat(300)])
    expect(result.bookBudgetDropped).toBeUndefined()
    expect(result.droppedCount).toBe(0)
  })

  it('tokenBudget = 0 按未设置处理，不静默丢弃已触发条目', () => {
    const lb = makeLorebook('lbZero', [
      { keywords: ['触发'], content: '零预算不应禁用世界书' },
    ], { tokenBudget: 0 })

    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发', budget: 10000,
    })

    expect(result.beforeChar).toEqual(['零预算不应禁用世界书'])
    expect(result.bookBudgetDropped).toBeUndefined()
    expect(result.droppedCount).toBe(0)
  })

  it('多书激活且书级预算总和超过全局预算时按比例分配：大书不再挤占小书', () => {
    const bigContent = '大'.repeat(90)
    const smallContent = '小'.repeat(30)
    // big 书级预算 400，small 书级预算 100；全局预算 250 → 配额 200 / 50
    const big = makeLorebook('lbBig', [
      { keywords: ['触发'], content: bigContent, order: 1 },
    ], { tokenBudget: 400 })
    const small = makeLorebook('lbSmall', [
      { keywords: ['触发'], content: smallContent, order: 2 },
    ], { tokenBudget: 100 })

    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [big, small], scanText: '触发', budget: 250,
    })
    // small 内容（≈30 tokens）在 50 配额内正常保留；big 全文（≈81）受 200 配额约束仍可注入
    expect(result.beforeChar).toContain(smallContent)
    expect(result.droppedCount).toBe(0)
  })
})

describe('allocateGlobalBudgetByBooks（多书配额分配）', () => {
  it('按书级预算比例分配全局预算，总额不超过全局预算', () => {
    const allocated = allocateGlobalBudgetByBooks(250, new Map([['a', 400], ['b', 100]]))!
    expect(allocated.get('a')).toBe(200)
    expect(allocated.get('b')).toBe(50)
    expect([...allocated.values()].reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(250)
  })

  it('总配额不超全局预算时按书级预算足额分配', () => {
    const allocated = allocateGlobalBudgetByBooks(10000, new Map([['a', 100], ['b', 50]]))!
    expect(allocated.get('a')).toBe(100)
    expect(allocated.get('b')).toBe(50)
  })

  it('无预算书按带预算书的平均值对待', () => {
    const allocated = allocateGlobalBudgetByBooks(300, new Map([['a', 200], ['none', 0]]))!
    // 配额：a=200，none=200（平均值）→ 分配 150 / 150
    expect(allocated.get('a')).toBe(150)
    expect(allocated.get('none')).toBe(150)
  })

  it('空映射返回 null，全部预算 0 时全按 0 配额', () => {
    expect(allocateGlobalBudgetByBooks(100, new Map())).toBeNull()
    const zero = allocateGlobalBudgetByBooks(100, new Map([['a', 0], ['b', 0]]))!
    expect(zero.get('a')).toBe(0)
    expect(zero.get('b')).toBe(0)
  })
})

describe('语义死条目告警（semanticEnabled = false）', () => {
  const getLoreWarns = () => getCollectedLogs()
    .filter((l) => l.level === 'warn' && l.context === 'lorebook')

  it('仅 semanticRequired 条目告警，且同一轮只告警一次（warn-once；阶段4 语义降级）', () => {
    const lb = makeLorebook('lbDead1', [
      // legacy semantic → semanticPreferred：无 embeddings 时由本地词法兜底，不再告警
      { id: 'sem', keywords: [], content: '纯语义条目内容', matchMode: 'semantic' },
      // 无关键词 hybrid：词法兜底可触发，不告警
      { id: 'bothnokw', keywords: [], content: '无关键词混合条目', matchMode: 'both' },
      // 显式 semanticRequired（仅向量）：无 embeddings 时停用并告警
      {
        id: 'req1', keywords: [], content: '仅向量条目一',
        runtime: { insertion: { kind: 'prompt', anchor: 'before_character' }, retrieval: 'semanticRequired' },
      },
      {
        id: 'req2', keywords: [], content: '仅向量条目二',
        runtime: { insertion: { kind: 'prompt', anchor: 'before_character' }, retrieval: 'semanticRequired' },
      },
      // 有关键词的 hybrid 条目不告警
      { id: 'kw', keywords: ['触发'], content: '有关键词条目', matchMode: 'both' },
    ])
    const opts = {
      ...baseOpts, lorebooks: [lb] as Lorebook[], scanText: '触发', budget: 10000,
      semanticEnabled: false,
    }
    executeLorebookRuntime(opts)
    // 仅两个 semanticRequired 条目告警；semanticPreferred / hybrid 由词法兜底，不告警
    expect(getLoreWarns().length).toBe(2)
    expect(getLoreWarns().every((l) => l.message.includes('仅向量条目'))).toBe(true)

    // 第二轮：warn-once，不重复告警
    executeLorebookRuntime(opts)
    expect(getLoreWarns().length).toBe(2)

    // 行为不受影响：有关键词的 both 条目仍正常注入
    expect(executeLorebookRuntime(opts).beforeChar).toEqual(['有关键词条目'])
  })

  it('semanticEnabled 为 true 或未传时不告警', () => {
    const lb = makeLorebook('lbDead2', [
      {
        keywords: [], content: '纯语义条目',
        runtime: { insertion: { kind: 'prompt', anchor: 'before_character' }, retrieval: 'semanticRequired' },
      },
    ])
    executeLorebookRuntime({ ...baseOpts, lorebooks: [lb], scanText: '任意', budget: 10000 })
    executeLorebookRuntime({ ...baseOpts, lorebooks: [lb], scanText: '任意', budget: 10000, semanticEnabled: true })
    expect(getLoreWarns().length).toBe(0)
  })
})

// ===================== P0：扫描文本去噪 + 关键词命中频率计分 =====================

describe('stripMarkdownNoise（扫描文本去噪）', () => {
  it('剥离 *动作* / 粗体 / 斜体标记，保留内容', () => {
    expect(stripMarkdownNoise('*他走进魔法学院*')).toBe('他走进魔法学院')
    expect(stripMarkdownNoise('**重要**设定')).toBe('重要设定')
    expect(stripMarkdownNoise('看__这里__的设定')).toBe('看这里的设定')
    expect(stripMarkdownNoise('~~废弃~~的设定')).toBe('废弃的设定')
  })

  it('围栏代码块整体移除，行内代码保留内容', () => {
    expect(stripMarkdownNoise('设定如下：\n```js\nconst class = 1\n```\n完毕')).not.toContain('class')
    expect(stripMarkdownNoise('围绕 `魔法水晶` 展开')).toBe('围绕 魔法水晶 展开')
  })

  it('图片与 HTML 标签移除，链接保留文字', () => {
    expect(stripMarkdownNoise('![插画](http://a.com/x.png) 之下')).toBe('  之下')
    expect(stripMarkdownNoise('<div>城市设定</div>')).toBe(' 城市设定 ')
    expect(stripMarkdownNoise('详见[世界书指南](http://a.com)章节')).toBe('详见世界书指南章节')
  })

  it('行首标题/引用/列表标记剥离', () => {
    expect(stripMarkdownNoise('# 魔法学院')).toBe('魔法学院')
    expect(stripMarkdownNoise('> 引用：古堡')).toBe('引用：古堡')
    expect(stripMarkdownNoise('- 山脉')).toBe('山脉')
    expect(stripMarkdownNoise('1. 河流')).toBe('河流')
  })

  it('普通中文文本不受影响', () => {
    expect(stripMarkdownNoise('他们穿过森林，渡过河流')).toBe('他们穿过森林，渡过河流')
    expect(stripMarkdownNoise('（剑）在桌上，他是一名剑士')).toBe('（剑）在桌上，他是一名剑士')
  })

  it('集成：markdown 包裹的关键词仍触发，代码块内的关键词不触发', () => {
    const lb = makeLorebook('lbNoise', [
      { id: 'md', keywords: ['魔法学院'], content: '学院设定' },
      { id: 'code', keywords: ['guild'], content: '公会设定' },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb],
      scanText: '*他走进魔法学院*，然后写了段代码：\n```python\nguild = create_guild()\n```',
      budget: 10000,
    })
    expect(result.beforeChar).toEqual(['学院设定'])
  })
})

describe('关键词命中频率计分（P0）', () => {
  it('反复提及的关键词条目排序高于仅提到一次的条目', () => {
    const lb = makeLorebook('lbFreq', [
      { id: 'once', keywords: ['古城'], content: '单次条目', order: 1 },
      { id: 'often', keywords: ['秘境'], content: '多次条目', order: 2 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb],
      scanText: '秘境的入口被发现了。众人讨论秘境的守卫，最终进入了秘境深处，路过一座古城',
      budget: 10000,
    })
    // '秘境' 出现 3 次（freq≈0.95）vs '古城' 1 次（freq≈0.632）→ often 排前
    expect(result.beforeChar).toEqual(['多次条目', '单次条目'])
  })

  it('多关键词覆盖与单关键词频率的均衡（1/3 命中一次 < 全命中一次）', () => {
    const lb = makeLorebook('lbCov', [
      { id: 'partial', keywords: ['甲城', '乙城', '丙城'], content: '部分条目', order: 1 },
      { id: 'full', keywords: ['甲城'], content: '全命条目', order: 2 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '只提到了甲城', budget: 10000,
    })
    // partial：coverage=1/3, freq≈0.632 → 0.483；full：coverage=1, freq≈0.632 → 0.816
    expect(result.beforeChar).toEqual(['全命条目', '部分条目'])
  })

  it('语义候选与关键词触发条目的既有排序行为保持不变', () => {
    const lb = makeLorebook('lbKeep', [
      { keywords: ['猫娘'], content: '关键词', order: 90 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '这里提到了猫娘', budget: 10000,
      semanticItems: [{ content: '语义', order: 10, position: 'before_char', score: 0.9 }],
    })
    // 关键词满命中（freq 加成）+ 实体加分 > 纯语义 0.9 候选
    expect(result.beforeChar).toEqual(['关键词', '语义'])
  })

  it('带定位 key 的旧语义命中不会绕过当前禁用或已删除条目', () => {
    const lb = makeLorebook('stale-semantic', [
      { id: 'disabled', keywords: [], content: '当前内容', enabled: false, matchMode: 'semantic' },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts,
      lorebooks: [lb],
      scanText: '任意',
      budget: 10000,
      semanticItems: [{
        key: 'stale-semantic:disabled', content: '缓存旧内容', position: 'before_char', order: 1, score: 0.9,
      }],
    })
    expect(result.beforeChar).toEqual([])
  })
})

// ===================== P1：无索引语义近似补偿（词面重叠） =====================

describe('semanticScoreByOverlap（词面重叠近似）', () => {
  it('内容与对话高度重叠的条目得分高于低重叠条目', () => {
    const dialogue = '众人讨论魔法学院的入学考试和宿舍安排'.toLowerCase()
    const high = semanticScoreByOverlap(
      { keywords: ['学院'], content: '魔法学院的入学考试非常严格，宿舍在东塔' }, dialogue,
    )
    const low = semanticScoreByOverlap(
      { keywords: ['学院'], content: '远古龙族的迁徙路线与火山活动' }, dialogue,
    )
    expect(high).toBeGreaterThan(low)
    expect(high).toBeGreaterThan(0)
  })

  it('结果范围受 R 约束（≤ R），空对话/空内容返回 0', () => {
    expect(semanticScoreByOverlap({ keywords: ['x'], content: '内容' }, '')).toBe(0)
    expect(semanticScoreByOverlap({ keywords: [], content: '' }, '对话')).toBe(0)
    expect(semanticScoreByOverlap(
      { keywords: ['魔法学院'], content: '魔法学院魔法学院魔法学院' },
      '魔法学院魔法学院魔法学院'.toLowerCase(),
    )).toBeLessThanOrEqual(0.35 + 1e-9)
  })

  it('ASCII 词与 CJK 双字滑窗均参与重叠', () => {
    const score = semanticScoreByOverlap(
      { keywords: ['crystal'], content: 'The crystal tower glows at night' },
      'she saw the crystal tower glow at night'.toLowerCase(),
    )
    expect(score).toBeGreaterThan(0)
  })
})

describe('集成：无语义命中时词面重叠补偿参与排序（P1）', () => {
  it('内容与对话更相关的条目排序靠前', () => {
    const lb = makeLorebook('lbApprox', [
      { id: 'unrel', keywords: ['学院'], content: '远古龙族迁徙与火山活动记录', order: 1 },
      { id: 'rel', keywords: ['学院'], content: '魔法学院的入学考试严格，宿舍安排在东塔', order: 2 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb],
      scanText: '聊到魔法学院的入学考试和宿舍安排',
      budget: 10000,
    })
    // 两条 coverage 相同（各 1 个关键词全命中）、无实体/recency 差异 → 词面重叠决定排序
    expect(result.beforeChar).toEqual([
      '魔法学院的入学考试严格，宿舍安排在东塔',
      '远古龙族迁徙与火山活动记录',
    ])
  })

  it('有真实语义命中时不受近似补偿影响（真实值优先）', () => {
    const lb = makeLorebook('lbReal', [
      { id: 'a', keywords: ['触发'], content: '条目A内容', order: 1 },
    ])
    const result = executeLorebookRuntime({
      ...baseOpts, lorebooks: [lb], scanText: '触发',
      budget: 10000,
      semanticItems: [{ content: '条目A内容', order: 1, position: 'before_char', score: 0.42, key: 'lbReal:a' }],
    })
    expect(result.beforeChar).toEqual(['条目A内容'])
    expect(result.triggeredCount).toBe(1)
  })
})

describe('shouldUseOverlapApprox', () => {
  it('无真实语义命中时为 true，有 score 或内容命中时为 false', () => {
    const byContent = new Map<string, number>([['已有内容', 0.8]])
    expect(shouldUseOverlapApprox({ content: '普通内容' }, byContent)).toBe(true)
    expect(shouldUseOverlapApprox({ content: '已有内容' }, byContent)).toBe(false)
    expect(shouldUseOverlapApprox({ content: '普通内容', score: 0.5 }, byContent)).toBe(false)
    expect(shouldUseOverlapApprox({ content: '已有内容' }, new Map())).toBe(true)
  })
})

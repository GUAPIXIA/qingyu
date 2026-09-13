/**
 * W7（主计划 §7.9 / §9.1）：`ContextAllocator` 纯函数不变量测试。
 *
 * 覆盖：不超预算、mandatory 可行时不丢、输入不变、选择确定、同 dedupeKey 至多一项、
 * 预算增大不删除高优先块、NaN/负分/空候选不崩溃，以及 §9.3 的固定上下文场景。
 */
import { describe, expect, it } from 'vitest'
import {
  CONTEXT_CANDIDATE_KINDS,
  HIGH_RELEVANCE_THRESHOLD,
  allocateContextCandidates,
  candidateScore,
  candidateTier,
  compareCandidates,
  dedupeCandidates,
  normalizeContextCandidate,
  rankCandidates,
  summarizeCandidates,
  type ContextCandidate,
  type ContextCandidateKind,
} from '../contextCandidates'
import { CONTEXT_SCENARIOS, buildCandidates, contextBudgetBase, scenarioByName } from './contextFixtures'

/** 测试专用候选构造：只写关心的字段，其余取中性值 */
function makeCandidate(
  id: string,
  kind: ContextCandidateKind,
  overrides: Partial<ContextCandidate> = {},
): ContextCandidate {
  return {
    id,
    kind,
    estimatedTokens: 10,
    mandatory: false,
    stablePrefix: false,
    relevance: 0.5,
    recency: 0.5,
    importance: 0.5,
    continuity: 0.5,
    originalOrder: 0,
    ...overrides,
  }
}

function budgetOf(scenario: (typeof CONTEXT_SCENARIOS)[number]): number {
  return contextBudgetBase(scenario.contextLimit, scenario.reservedOutputTokens)
}

function rankIndexOf(candidates: readonly ContextCandidate[]): Map<string, number> {
  const map = new Map<string, number>()
  rankCandidates(candidates).forEach((candidate, index) => map.set(candidate.id, index))
  return map
}

describe('ContextAllocator：固定上下文场景（§9.3-1~7）', () => {
  for (const scenario of CONTEXT_SCENARIOS) {
    describe(scenario.name, () => {
      const candidates = buildCandidates(scenario.candidates)
      const budget = budgetOf(scenario)
      const result = allocateContextCandidates(candidates, { budgetTokens: budget })

      it('预算可行时不超预算，且 mandatory 全部保留', () => {
        if (scenario.expectations.mandatoryFitsBudget) {
          expect(result.mandatoryOverBudget).toBe(false)
          expect(result.overBudget).toBe(false)
          expect(result.selectedTokens).toBeLessThanOrEqual(budget)
        }
        const mandatoryIds = candidates.filter((candidate) => candidate.mandatory).map((candidate) => candidate.id)
        for (const id of mandatoryIds) expect(result.selectedIds).toContain(id)
      })

      it('关键块入选、期望丢弃块不入选、选择量不低于下限', () => {
        for (const id of scenario.expectations.mustSelectIds) expect(result.selectedIds).toContain(id)
        for (const id of scenario.expectations.mustDropIds ?? []) expect(result.selectedIds).not.toContain(id)
        expect(result.selectedTokens).toBeGreaterThanOrEqual(scenario.expectations.minSelectedTokens)
      })

      it('不填充：内容远小于预算时不得凑满预算', () => {
        if (scenario.expectations.noPadding) {
          expect(result.selectedTokens).toBeLessThan(budget)
        }
      })

      it('选择确定：同一输入两次分配结果一致，且输入对象不被修改', () => {
        const snapshot = JSON.stringify(candidates)
        const again = allocateContextCandidates(candidates, { budgetTokens: budget })
        expect(again.selectedIds).toEqual(result.selectedIds)
        expect(JSON.stringify(candidates)).toBe(snapshot)
      })

      it('入选块按顺位单调排列；同一 dedupeKey 至多一项', () => {
        const tiers = result.selected.map((candidate) => candidateTier(candidate))
        for (let i = 1; i < tiers.length; i++) expect(tiers[i]).toBeGreaterThanOrEqual(tiers[i - 1])
        const keys = result.selected.map((candidate) => candidate.dedupeKey).filter((key): key is string => !!key)
        expect(new Set(keys).size).toBe(keys.length)
      })
    })
  }
})

describe('ContextAllocator：预算单调性（增大预算不删除高优先块）', () => {
  for (const scenario of CONTEXT_SCENARIOS) {
    it(`${scenario.name}：被移除的块顺位一律低于新入选的块`, () => {
      const candidates = buildCandidates(scenario.candidates)
      const base = budgetOf(scenario)
      const rankIndex = rankIndexOf(candidates)
      const budgets = [
        Math.floor(base * 0.3),
        Math.floor(base * 0.5),
        Math.floor(base * 0.75),
        base,
        Math.floor(base * 1.5),
      ]
      let previous = allocateContextCandidates(candidates, { budgetTokens: budgets[0] })
      for (const budget of budgets.slice(1)) {
        const current = allocateContextCandidates(candidates, { budgetTokens: budget })
        const previousIds = new Set(previous.selectedIds)
        const currentIds = new Set(current.selectedIds)
        const removed = previous.selectedIds.filter((id) => !currentIds.has(id))
        const added = current.selectedIds.filter((id) => !previousIds.has(id))
        if (removed.length > 0 && added.length > 0) {
          const worstAddedRank = Math.max(...added.map((id) => rankIndex.get(id) ?? 0))
          for (const id of removed) {
            // 顺位数字越小越优先：被移除者必须排在新入选者之后
            expect(rankIndex.get(id) ?? 0).toBeGreaterThan(worstAddedRank)
          }
        }
        // 预算不低于基准时 mandatory 必须可行（低于基准时允许显式标记不可行）
        if (scenario.expectations.mandatoryFitsBudget && budget >= base) {
          expect(current.mandatoryOverBudget).toBe(false)
        }
        previous = current
      }
    })
  }
})

describe('ContextAllocator：确定性排序与去重', () => {
  const candidates: ContextCandidate[] = [
    makeCandidate('b', 'history', { originalOrder: 1, recency: 0.9, relevance: 0.7 }),
    makeCandidate('a', 'history', { originalOrder: 0, recency: 0.9, relevance: 0.7 }),
    makeCandidate('c', 'worldbook', { originalOrder: 2, relevance: 0.9, importance: 0.9 }),
  ]

  it('比较器反对称，且同顺位同分按 originalOrder、再按 id', () => {
    const [b, a, c] = candidates
    expect(Math.sign(compareCandidates(b, a))).toBe(-Math.sign(compareCandidates(a, b)))
    const ranked = rankCandidates(candidates).map((candidate) => candidate.id)
    expect(ranked).toEqual(['a', 'b', 'c'])
    // 世界书高相关落入第 3 顺位，晚于最近对话层
    expect(compareCandidates(a, c)).toBeLessThan(0)
  })

  it('同分同顺序时按稳定 id 排序（不依赖 Array.sort 实现细节）', () => {
    const tied = [
      makeCandidate('z', 'memory', { originalOrder: 5, relevance: 0.9 }),
      makeCandidate('a', 'memory', { originalOrder: 5, relevance: 0.9 }),
    ]
    expect(rankCandidates(tied).map((candidate) => candidate.id)).toEqual(['a', 'z'])
  })

  it('rankCandidates / dedupeCandidates 不修改入参', () => {
    const snapshot = JSON.stringify(candidates)
    rankCandidates(candidates)
    dedupeCandidates(candidates)
    expect(JSON.stringify(candidates)).toBe(snapshot)
  })

  it('同一 dedupeKey 保留排序最靠前者，重复项稳定列在 duplicateIds', () => {
    const dedupeInput: ContextCandidate[] = [
      makeCandidate('fact:low', 'memory', { dedupeKey: 'fact:1', originalOrder: 0, relevance: 0.2, recency: 0.2 }),
      makeCandidate('fact:high', 'memory', { dedupeKey: 'fact:1', originalOrder: 1, relevance: 0.9, recency: 0.9 }),
      makeCandidate('fact:dup2', 'memory', { dedupeKey: 'fact:1', originalOrder: 2, relevance: 0.1, recency: 0.1 }),
    ]
    const { unique, duplicateIds } = dedupeCandidates(dedupeInput)
    expect(unique.map((candidate) => candidate.id)).toEqual(['fact:high'])
    expect(duplicateIds).toEqual(['fact:low', 'fact:dup2'])
    const allocation = allocateContextCandidates(dedupeInput, { budgetTokens: 100 })
    expect(allocation.selectedIds).toEqual(['fact:high'])
    expect(allocation.dedupedIds).toEqual(['fact:low', 'fact:dup2'])
  })

  it('未知分类按历史处理，缺失 id 生成确定性兜底 id', () => {
    const candidate = normalizeContextCandidate({
      id: '',
      kind: 'unknown-kind' as never,
      estimatedTokens: 12,
      mandatory: false,
      stablePrefix: false,
      relevance: 0.5,
      recency: 0.5,
      importance: 0.5,
      continuity: 0.5,
      originalOrder: 7,
    }, 3)
    expect(candidate.id).toBe('candidate#3')
    expect(candidate.kind).toBe('history')
    expect(candidate.originalOrder).toBe(7)
  })
})

describe('ContextAllocator：鲁棒性与边界', () => {
  it('空候选不崩溃，分类统计全为零', () => {
    const result = allocateContextCandidates([], { budgetTokens: 100 })
    expect(result.selectedIds).toEqual([])
    expect(result.selectedTokens).toBe(0)
    expect(result.overBudget).toBe(false)
    for (const kind of CONTEXT_CANDIDATE_KINDS) {
      expect(result.byKind[kind]).toEqual({
        count: 0, tokens: 0, mandatoryCount: 0, selectedCount: 0, selectedTokens: 0, stablePrefixTokens: 0, droppedCount: 0,
      })
    }
  })

  it('NaN / Infinity / 负 token 与负分不崩溃，且不产生负占用', () => {
    const broken: ContextCandidate[] = [
      makeCandidate('nan', 'history', {
        estimatedTokens: Number.NaN, relevance: Number.NaN, recency: -3, importance: Number.POSITIVE_INFINITY,
      }),
      makeCandidate('negative', 'memory', { estimatedTokens: -100, relevance: -1 }),
      makeCandidate('ok', 'protocol', { estimatedTokens: 40, mandatory: true, stablePrefix: true, relevance: 1, importance: 1 }),
    ]
    const result = allocateContextCandidates(broken, { budgetTokens: 100 })
    expect(result.selectedTokens).toBe(40)
    expect(result.selectedTokens).toBeGreaterThanOrEqual(0)
    expect(result.byKind.history.tokens).toBe(0)
    expect(result.byKind.memory.tokens).toBe(0)
    expect(candidateScore(broken[0])).toBeGreaterThanOrEqual(0)
    expect(candidateScore(broken[0])).toBeLessThanOrEqual(1)
  })

  it('预算为 0 时仍保留 mandatory，并显式标记预算不可行', () => {
    const candidates = [
      makeCandidate('protocol:1', 'protocol', { estimatedTokens: 50, mandatory: true }),
      makeCandidate('history:1', 'history', { estimatedTokens: 50 }),
    ]
    const result = allocateContextCandidates(candidates, { budgetTokens: 0 })
    expect(result.selectedIds).toEqual(['protocol:1'])
    expect(result.mandatoryOverBudget).toBe(true)
    expect(result.overBudget).toBe(true)
    expect(result.effectiveBudgetTokens).toBe(0)
  })

  it('reservedTokens 从预算中扣除，不改变 mandatory 语义', () => {
    const candidates = [
      makeCandidate('protocol:1', 'protocol', { estimatedTokens: 50, mandatory: true }),
      makeCandidate('history:1', 'history', { estimatedTokens: 50 }),
    ]
    const result = allocateContextCandidates(candidates, { budgetTokens: 100, reservedTokens: 60 })
    expect(result.effectiveBudgetTokens).toBe(40)
    expect(result.selectedIds).toEqual(['protocol:1'])
    expect(result.overBudget).toBe(true)
  })

  it('summarizeCandidates 与分配器对同一集合给出可对齐的分类统计', () => {
    const candidates = buildCandidates(scenarioByName('images-and-tools').candidates)
    const summary = summarizeCandidates(candidates)
    const allocation = allocateContextCandidates(candidates, { budgetTokens: 1_000_000 })
    expect(summary.count).toBe(candidates.length)
    expect(summary.tokens).toBe(candidates.reduce((sum, candidate) => sum + candidate.estimatedTokens, 0))
    for (const kind of CONTEXT_CANDIDATE_KINDS) {
      expect(allocation.byKind[kind].count).toBe(summary.byKind[kind].count)
      expect(allocation.byKind[kind].tokens).toBe(summary.byKind[kind].tokens)
    }
  })
})

describe('ContextAllocator：顺位与分类语义（§5.5）', () => {
  it('最近连续对话高于较早原始历史，高相关世界书高于低相关世界书', () => {
    const candidates = [
      makeCandidate('old-history', 'history', { relevance: 0.7, recency: 0.1, importance: 0.6, continuity: 0.9 }),
      makeCandidate('recent-history', 'history', { relevance: 0.7, recency: 0.9, importance: 0.6, continuity: 0.9 }),
      makeCandidate('low-lore', 'worldbook', { relevance: HIGH_RELEVANCE_THRESHOLD - 0.1, importance: 0.3 }),
      makeCandidate('high-lore', 'worldbook', { relevance: HIGH_RELEVANCE_THRESHOLD + 0.2, importance: 0.8 }),
    ]
    const ranked = rankCandidates(candidates).map((candidate) => candidate.id)
    expect(ranked.indexOf('recent-history')).toBeLessThan(ranked.indexOf('old-history'))
    expect(ranked.indexOf('high-lore')).toBeLessThan(ranked.indexOf('low-lore'))
  })

  it('当前群聊参与者状态属于最近对话层；他人旧回合与示例同属低价值层', () => {
    const candidates = [
      makeCandidate('participants', 'group-state', { relevance: 0.9, recency: 1, importance: 0.9, continuity: 1 }),
      makeCandidate('other-old-turn', 'history', { relevance: 0.4, recency: 0.2, importance: 0.4, continuity: 0.3 }),
      makeCandidate('example', 'example', { relevance: 0.5, recency: 1, importance: 0.6, continuity: 0.6 }),
    ]
    const tiers = new Map(candidates.map((candidate) => [candidate.id, candidateTier(candidate)]))
    expect(tiers.get('participants')!).toBeLessThan(tiers.get('other-old-turn')!)
    expect(tiers.get('other-old-turn')!).toBe(tiers.get('example')!)
  })

  it('群聊场景在紧张预算下先丢他人旧回合，保留当前参与者与本人近期回合', () => {
    const scenario = scenarioByName('group-chat-multi-character')
    const candidates = buildCandidates(scenario.candidates)
    const result = allocateContextCandidates(candidates, { budgetTokens: 2900 })
    expect(result.selectedIds).toContain('group-state:participants')
    expect(result.selectedIds).toContain('history:active-speaker:5')
    expect(result.selectedIds.filter((id) => id.startsWith('history:other-character:')).length).toBe(0)
  })

  it('1M 场景在收紧预算时先丢低价值尾部，高相关块不丢', () => {
    const scenario = scenarioByName('million-window-100-turns')
    const candidates = buildCandidates(scenario.candidates)
    const base = contextBudgetBase(scenario.contextLimit, scenario.reservedOutputTokens)
    const result = allocateContextCandidates(candidates, { budgetTokens: Math.floor(base / 20) })
    expect(result.selectedIds).toContain('worldbook:high-relevance')
    expect(result.selectedIds).not.toContain('worldbook:low-relevance')
    const oldRaw = result.selectedIds.filter((id) => id.startsWith('history:old-raw:'))
    expect(oldRaw.length).toBeLessThan(300)
  })
})

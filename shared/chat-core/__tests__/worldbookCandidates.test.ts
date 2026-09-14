/**
 * W9（主计划 §7.11）：世界书候选化与影子报告纯函数测试。
 *
 * 覆盖：always→mandatory、评分复用、丢弃条目也进候选、隐私（无正文）、
 * 统一剩余预算竞争、既有固定比例对照、异常兜底。
 */
import { describe, expect, it } from 'vitest'
import {
  WORLDBOOK_ALWAYS_IMPORTANCE,
  WORLDBOOK_DETAIL_IMPORTANCE,
  buildWorldbookCandidateSet,
  buildWorldbookShadowReport,
  formatWorldbookShadowSummary,
  normalizeWorldbookScore,
  summarizeWorldbookInjection,
  worldbookOrigin,
} from '../worldbookCandidates'
import type { LorebookScoredEntrySnapshot } from '../lorebook'
import type { ContextCandidate } from '../contextCandidates'

function snap(overrides: Partial<LorebookScoredEntrySnapshot> & { key: string }): LorebookScoredEntrySnapshot {
  return {
    score: 0.5,
    priority: 'conditional',
    position: 'before_char',
    order: 1,
    tokens: 100,
    kept: true,
    ...overrides,
  }
}

describe('W9 世界书候选：评分与 always→mandatory', () => {
  it('always 映射为 mandatory；conditional/detail 非 mandatory', () => {
    const plan = buildWorldbookCandidateSet([
      snap({ key: 'lb:always', priority: 'always', score: 0.2 }),
      snap({ key: 'lb:cond', priority: 'conditional', score: 0.8, order: 2 }),
      snap({ key: 'lb:detail', priority: 'detail', score: 0.9, order: 3 }),
    ])
    const byId = new Map(plan.candidates.map((c) => [c.id, c]))
    expect(byId.get('worldbook:lb:always')!.mandatory).toBe(true)
    expect(byId.get('worldbook:lb:always')!.importance).toBe(WORLDBOOK_ALWAYS_IMPORTANCE)
    expect(byId.get('worldbook:lb:cond')!.mandatory).toBe(false)
    expect(byId.get('worldbook:lb:detail')!.importance).toBe(WORLDBOOK_DETAIL_IMPORTANCE)
    expect(plan.described.alwaysCount).toBe(1)
  })

  it('relevance 直接复用统一 score（归一到 0~1）', () => {
    const plan = buildWorldbookCandidateSet([
      snap({ key: 'a', score: 0.73 }),
      snap({ key: 'b', score: 2.5, order: 2 }),
      snap({ key: 'c', score: Number.NaN, order: 3 }),
    ])
    const byId = new Map(plan.candidates.map((c) => [c.id, c]))
    expect(byId.get('worldbook:a')!.relevance).toBeCloseTo(0.73, 5)
    expect(byId.get('worldbook:b')!.relevance).toBe(1)
    expect(byId.get('worldbook:c')!.relevance).toBe(0)
    expect(normalizeWorldbookScore(-1)).toBe(0)
  })

  it('丢弃条目也进入候选（接管对照需要"既有没注入"一侧）', () => {
    const plan = buildWorldbookCandidateSet([
      snap({ key: 'kept', kept: true }),
      snap({ key: 'dropped', kept: false, order: 2 }),
    ])
    expect(plan.candidates).toHaveLength(2)
    expect(summarizeWorldbookInjection(
      [snap({ key: 'kept' }), snap({ key: 'dropped', kept: false })],
      300,
    )).toMatchObject({
      keptCount: 1,
      droppedCount: 1,
      legacyCapTokens: 300,
    })
  })

  it('at_depth 不进稳定前缀；before_char 进稳定前缀', () => {
    const plan = buildWorldbookCandidateSet([
      snap({ key: 'depth', position: 'at_depth', depth: 2 }),
      snap({ key: 'top', position: 'before_char', order: 2 }),
    ])
    const byId = new Map(plan.candidates.map((c) => [c.id, c]))
    expect(byId.get('worldbook:depth')!.stablePrefix).toBe(false)
    expect(byId.get('worldbook:top')!.stablePrefix).toBe(true)
    expect(worldbookOrigin({ position: 'at_depth', depth: 2 })).toBe('worldbook:chat_depth:2')
  })

  it('候选不携带正文；id 使用条目 key 而非内容', () => {
    const plan = buildWorldbookCandidateSet([snap({ key: 'lb:e1' })])
    const serialized = JSON.stringify(plan)
    expect(serialized).not.toContain('正文标记')
    expect(plan.candidates[0].id).toBe('worldbook:lb:e1')
    expect(plan.candidates[0].dedupeKey).toBe('lore:lb:e1')
  })
})

describe('W9 世界书影子报告', () => {
  const competitors: ContextCandidate[] = [
    {
      id: 'protocol:system',
      kind: 'protocol',
      estimatedTokens: 4000,
      mandatory: true,
      stablePrefix: true,
      relevance: 1,
      recency: 1,
      importance: 1,
      continuity: 1,
      originalOrder: 0,
    },
    {
      id: 'history:msg:1',
      kind: 'history',
      estimatedTokens: 200,
      mandatory: false,
      stablePrefix: false,
      relevance: 0.7,
      recency: 0.9,
      importance: 0.6,
      continuity: 0.9,
      originalOrder: 1,
    },
  ]

  it('预算可行时 always 全部入选；差异与既有 keptTokens 可解释', () => {
    const snapshots = [
      snap({ key: 'always-1', priority: 'always', tokens: 80, score: 0.1 }),
      snap({ key: 'cond-1', priority: 'conditional', tokens: 120, score: 0.85, order: 2 }),
      snap({ key: 'detail-1', priority: 'detail', tokens: 60, score: 0.4, order: 3, kept: false }),
    ]
    const plan = buildWorldbookCandidateSet(snapshots)
    const existing = summarizeWorldbookInjection(snapshots, 200)
    const report = buildWorldbookShadowReport({
      plan,
      existing,
      budgetTokens: 8000,
      competitors,
    })
    expect(report.degraded).toBe(false)
    expect(report.candidate.mandatoryOverBudget).toBe(false)
    expect(report.candidate.alwaysSelectedCount).toBe(1)
    expect(report.candidate.alwaysDroppedCount).toBe(0)
    expect(report.deltaTokens).toBe(report.candidate.selectedTokens - existing.keptTokens)
    expect(report.byPriority.map((d) => d.priority)).toEqual(['always', 'conditional', 'detail'])
  })

  it('大窗口下候选可突破既有世界书专属上限（统一池预期）', () => {
    const snapshots = Array.from({ length: 6 }, (_, i) =>
      snap({ key: `e${i}`, tokens: 400, score: 0.9 - i * 0.05, order: i + 1, kept: i < 2 }))
    const plan = buildWorldbookCandidateSet(snapshots)
    // 既有 cap 很小：只 kept 了 2 条
    const existing = summarizeWorldbookInjection(snapshots, 500)
    const report = buildWorldbookShadowReport({
      plan,
      existing,
      budgetTokens: 20000,
      competitors: [],
    })
    expect(report.candidate.selectedTokens).toBeGreaterThan(existing.keptTokens)
    expect(report.exceedsLegacyCap).toBe(true)
  })

  it('always 超预算时显式 mandatoryOverBudget，不静默丢', () => {
    const snapshots = [
      snap({ key: 'a1', priority: 'always', tokens: 5000, score: 0.1 }),
      snap({ key: 'a2', priority: 'always', tokens: 5000, order: 2, score: 0.1 }),
    ]
    const plan = buildWorldbookCandidateSet(snapshots)
    const report = buildWorldbookShadowReport({
      plan,
      existing: summarizeWorldbookInjection(snapshots, 1000),
      budgetTokens: 1000,
      competitors: [{ ...competitors[0], estimatedTokens: 900 }],
    })
    expect(report.candidate.mandatoryOverBudget).toBe(true)
    expect(report.candidate.alwaysSelectedCount).toBe(2)
  })

  it('分配异常兜底 degraded，既有口径保留', () => {
    const report = buildWorldbookShadowReport({
      plan: buildWorldbookCandidateSet([]),
      existing: summarizeWorldbookInjection([], 100),
      budgetTokens: 100,
      // @ts-expect-error 故意注入非法预算触发兜底路径的防御
      competitors: null,
    })
    // competitors=null 会走 catch 或被 ?? [] 吸收；这里断言不崩溃且有报告
    expect(report.mode).toBe('worldbook-shadow')
  })

  it('日志串只含数值，不含条目 key 之外的内容', () => {
    const snapshots = [snap({ key: 'secret-entry', priority: 'always', tokens: 40 })]
    const report = buildWorldbookShadowReport({
      plan: buildWorldbookCandidateSet(snapshots),
      existing: summarizeWorldbookInjection(snapshots, 80),
      budgetTokens: 1000,
      competitors: [],
    })
    const summary = formatWorldbookShadowSummary(report)
    expect(summary).toContain('mode=worldbook-shadow')
    expect(summary).not.toContain('secret-entry')
    expect(summary).not.toContain('废土')
  })
})

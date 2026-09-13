/**
 * W8（主计划 §7.10）：动态记忆注入的候选化与影子对照测试。
 *
 * 覆盖：时间线切块、三层候选化（含官方事实评分与 fallback）、
 * §7.10 验收（小模型安全降级 / 大模型可超过 800 / 简单话题少注入 / 失败可退原选择 / 不删除记忆）、
 * 影子报告聚合与隐私。
 */
import { describe, expect, it } from 'vitest'
import type { MemoryFact } from '../../../shared/types'
import { scoreAndRankFacts } from '../memory'
import { rankCandidates, type ContextCandidate } from '../contextCandidates'
import {
  MEMORY_TIMELINE_MAX_CHUNKS,
  buildMemoryCandidateSet,
  buildMemoryShadowReport,
  formatMemoryShadowSummary,
  selectMemoryCandidates,
  splitTimelineIntoChunks,
  type MemoryCandidateSet,
  type MemoryInjectionStats,
} from '../memoryCandidates'
import { makeFact } from './contextBuildFixtures'

// ===== fixture 构造（只关心 token 量级，不关心具体文本） =====

function timelineLines(count: number, charsPerLine = 40): string {
  return Array.from({ length: count }, (_, index) => `第 ${index} 条：${'事件描述'.repeat(charsPerLine / 4)}`).join('\n')
}

function factsFixture(count: number, overrides: (index: number) => Partial<MemoryFact> = () => ({})): MemoryFact[] {
  return Array.from({ length: count }, (_, index) => makeFact({
    id: `f${index}`,
    subject: `主体${index}`,
    predicate: '属性',
    value: `值${index}${'补'.repeat(20)}`,
    importance: 3,
    updatedAt: 1000 + index,
    ...overrides(index),
  }))
}

function makePlan(overrides: Partial<Parameters<typeof buildMemoryCandidateSet>[0]> = {}): MemoryCandidateSet {
  return buildMemoryCandidateSet({
    currentState: '当前状态：' + '正在躲避沙尘暴'.repeat(12),
    timeline: timelineLines(6),
    facts: factsFixture(4),
    semanticScores: null,
    model: 'gpt-4o-mini',
    ...overrides,
  })
}

function existingStats(capTokens: number, totalTokens: number): MemoryInjectionStats {
  return {
    capTokens,
    stateTokens: Math.floor(totalTokens * 0.3),
    factCount: 2,
    factTokens: Math.floor(totalTokens * 0.4),
    timelineChunkCount: 1,
    timelineTokens: totalTokens - Math.floor(totalTokens * 0.3) - Math.floor(totalTokens * 0.4),
    totalTokens,
    retrievalMode: 'fallback',
  }
}

function protocolCompetitors(tokens: number, id = 'protocol:mandatory'): ContextCandidate[] {
  return [{
    id,
    kind: 'protocol',
    estimatedTokens: tokens,
    mandatory: true,
    stablePrefix: true,
    relevance: 1,
    recency: 1,
    importance: 1,
    continuity: 1,
    originalOrder: 0,
  }]
}

describe('W8 时间线切块（splitTimelineIntoChunks）', () => {
  it('空输入返回空数组', () => {
    expect(splitTimelineIntoChunks('')).toEqual([])
    expect(splitTimelineIntoChunks('   \n  \n ')).toEqual([])
    expect(splitTimelineIntoChunks(null)).toEqual([])
    expect(splitTimelineIntoChunks(undefined)).toEqual([])
  })

  it('按行切块并保持顺序与原文，id 稳定且不含内容', () => {
    // 每行都超过单块目标大小 → 各成一块（不会被贪心合并）
    const lines = ['一', '二', '三'].map((prefix) => `${prefix}：${'事件描述内容'.repeat(18)}`)
    const chunks = splitTimelineIntoChunks(lines.join('\n'))
    expect(chunks.map((chunk) => chunk.id)).toEqual(['memory:timeline:0', 'memory:timeline:1', 'memory:timeline:2'])
    expect(chunks.map((chunk) => chunk.text)).toEqual(lines)
    expect(chunks.every((chunk) => chunk.tokens > 0)).toBe(true)
  })

  it('超长行按句切分，拼接后与原文一致', () => {
    const longLine = '事件发生。'.repeat(60)
    const chunks = splitTimelineIntoChunks(longLine)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(longLine)
  })

  it('相邻小块贪心合并，块数小于行数', () => {
    const lines = Array.from({ length: 30 }, (_, index) => `事件${index}：${'描述'.repeat(10)}`)
    const chunks = splitTimelineIntoChunks(lines.join('\n'))
    expect(chunks.length).toBeLessThan(lines.length)
    expect(chunks.map((chunk) => chunk.text).join('\n')).toBe(lines.join('\n'))
  })

  it('条数超过上限时把最早若干块并成一块，文本不丢', () => {
    // 每行都超过单块硬上限且无句末标点 → 每行自成一决
    const lines = Array.from({ length: MEMORY_TIMELINE_MAX_CHUNKS + 1 }, (_, index) => `${index}${'描述'.repeat(125)}`)
    const chunks = splitTimelineIntoChunks(lines.join('\n'))
    expect(chunks.length).toBe(MEMORY_TIMELINE_MAX_CHUNKS)
    expect(chunks.map((chunk) => chunk.text).join('\n')).toBe(lines.join('\n'))
  })

  it('确定性：同输入两次结果完全一致', () => {
    const timeline = timelineLines(12)
    expect(splitTimelineIntoChunks(timeline)).toEqual(splitTimelineIntoChunks(timeline))
  })
})

describe('W8 三层候选化（buildMemoryCandidateSet）', () => {
  it('当前状态 / 事实 / 时间线三层都有候选，层映射完整', () => {
    const plan = makePlan()
    const layers = Object.values(plan.layerByCandidateId)
    expect(layers).toContain('current-state')
    expect(layers).toContain('fact')
    expect(layers).toContain('timeline')
    expect(Object.keys(plan.layerByCandidateId).length).toBe(plan.candidates.length)
    const ids = plan.candidates.map((candidate) => candidate.id)
    expect(ids).toContain('memory:current-state')
    expect(ids.filter((id) => id.startsWith('memory:fact:'))).toHaveLength(4)
    expect(ids.filter((id) => id.startsWith('memory:timeline:'))).toHaveLength(plan.described.timelineChunkCount)
  })

  it('语义在场时事实相关度复用官方评分，并保持官方排序', () => {
    const facts = factsFixture(5)
    const scores = [0.1, 0.9, 0.4, 0.2, 0.7]
    const plan = buildMemoryCandidateSet({ currentState: '', timeline: '', facts, semanticScores: scores, model: 'gpt-4o-mini' })
    expect(plan.retrievalMode).toBe('semantic')
    const official = scoreAndRankFacts(facts, scores)
    const topId = `memory:fact:${(official[0].fact as MemoryFact).id}`
    const byId = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]))
    expect(byId.get(topId)!.relevance).toBe(official[0].score)
    const ranked = rankCandidates([...plan.candidates]).map((candidate) => candidate.id)
    // 官方最高分事实必须排在官方最低分事实之前
    const lastId = `memory:fact:${(official[official.length - 1].fact as MemoryFact).id}`
    expect(ranked.indexOf(topId)).toBeLessThan(ranked.indexOf(lastId))
  })

  it('语义缺失时走 importance+recency 回退口径（§7.10 第 4 条）', () => {
    const facts: MemoryFact[] = [
      makeFact({ id: 'low', importance: 1, updatedAt: 1, subject: '甲', predicate: '态', value: '低' }),
      makeFact({ id: 'high', importance: 5, updatedAt: Date.now(), subject: '乙', predicate: '态', value: '高' }),
    ]
    const plan = buildMemoryCandidateSet({ facts, semanticScores: null, model: 'gpt-4o-mini' })
    expect(plan.retrievalMode).toBe('fallback')
    const byId = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]))
    expect(byId.get('memory:fact:high')!.relevance).toBeGreaterThan(byId.get('memory:fact:low')!.relevance)
  })

  it('非 active 事实不进入候选；旧字符串事实用位置 id（不把内容写进 id）', () => {
    const facts = [
      makeFact({ id: 'inactive', status: 'inactive' }),
      '主角已经失忆',
      '目的地：绿洲城',
    ]
    const plan = buildMemoryCandidateSet({ facts, semanticScores: null, model: 'gpt-4o-mini' })
    const ids = plan.candidates.map((candidate) => candidate.id)
    expect(ids).not.toContain('memory:fact:inactive')
    expect(ids).toContain('memory:fact:legacy-1')
    expect(ids).toContain('memory:fact:legacy-2')
    for (const id of ids) {
      expect(id).not.toContain('失忆')
      expect(id).not.toContain('绿洲城')
    }
  })

  it('described 统计与实际候选自洽', () => {
    const plan = makePlan()
    const stateTokens = plan.candidates.filter((candidate) => candidate.id === 'memory:current-state')
      .reduce((sum, candidate) => sum + candidate.estimatedTokens, 0)
    const factTokens = plan.candidates.filter((candidate) => candidate.id.startsWith('memory:fact:'))
      .reduce((sum, candidate) => sum + candidate.estimatedTokens, 0)
    const timelineTokens = plan.candidates.filter((candidate) => candidate.id.startsWith('memory:timeline:'))
      .reduce((sum, candidate) => sum + candidate.estimatedTokens, 0)
    expect(plan.described.stateTokens).toBe(stateTokens)
    expect(plan.described.factTokens).toBe(factTokens)
    expect(plan.described.timelineTokens).toBe(timelineTokens)
    expect(plan.described.totalTokens).toBe(stateTokens + factTokens + timelineTokens)
  })
})

describe('W8 验收：动态分配行为（§7.10）', () => {
  it('大模型可超过 800：预算充足时记忆不再受既有 800 上限约束', () => {
    const plan = makePlan({
      currentState: '当前状态：' + '正在躲避沙尘暴'.repeat(12),
      timeline: timelineLines(10),
      facts: factsFixture(60),
    })
    expect(plan.described.totalTokens).toBeGreaterThan(800)
    const selection = selectMemoryCandidates(plan, { budgetTokens: 60000 })
    expect(selection.selectedTokens).toBeGreaterThan(800)
    expect(selection.overBudget).toBe(false)
    const report = buildMemoryShadowReport({
      plan,
      existing: existingStats(800, Math.min(760, plan.described.totalTokens)),
      budgetTokens: 60000,
    })
    expect(report.exceedsLegacyCap).toBe(true)
    expect(report.candidate.totalTokens).toBe(selection.selectedTokens)
    expect(report.deltaTokens).toBeGreaterThan(0)
  })

  it('小模型安全降级：mandatory 与近期对话先保留，记忆分级让位且不超预算', () => {
    const plan = makePlan()
    const competitors: ContextCandidate[] = [
      ...protocolCompetitors(700),
      {
        id: 'history:recent', kind: 'history', estimatedTokens: 400, mandatory: false, stablePrefix: false,
        relevance: 0.7, recency: 0.9, importance: 0.6, continuity: 0.9, originalOrder: 1,
      },
    ]
    // 预算 = 对手全部 + 当前状态 + 一半时间线：逼迫"较旧时间线块"让位
    const budget = 700 + 400 + plan.described.stateTokens + Math.ceil(plan.described.timelineTokens / 2)
    const selection = selectMemoryCandidates(plan, { budgetTokens: budget, competitors })
    expect(selection.overBudget).toBe(false)
    expect(selection.selectedTokens).toBeLessThanOrEqual(budget)
    // 对手（协议 + 近期对话）全部保留：记忆不得挤占 mandatory 与最近连续对话
    expect(selection.competitor.selectedTokens).toBe(1100)
    // 当前状态优先于时间线；时间线部分保留、部分让位（分级降级，不是全有或全无）
    expect(selection.byLayer['current-state'].selected.count).toBe(1)
    expect(selection.byLayer.timeline.selected.count).toBeGreaterThan(0)
    expect(selection.byLayer.timeline.dropped).toBeGreaterThan(0)
    expect(selection.byLayer.timeline.dropped).toBe(
      plan.described.timelineChunkCount - selection.byLayer.timeline.selected.count,
    )
  })

  it('预算极紧时记忆整体让位，但绝不超预算', () => {
    const plan = makePlan()
    const selection = selectMemoryCandidates(plan, {
      budgetTokens: 705,
      competitors: protocolCompetitors(700),
    })
    expect(selection.overBudget).toBe(false)
    expect(selection.selectedTokens).toBe(0)
    expect(selection.byLayer['current-state'].selected.count).toBe(0)
    // 让位只是"本轮不注入"，described 与候选集合不变（存储不受影响）
    expect(plan.described.totalTokens).toBeGreaterThan(0)
  })

  it('预算极紧时记忆整体让位，但绝不超预算', () => {
    const plan = makePlan()
    const selection = selectMemoryCandidates(plan, {
      budgetTokens: 720,
      competitors: protocolCompetitors(700),
    })
    expect(selection.overBudget).toBe(false)
    expect(selection.selectedTokens).toBe(0)
    expect(selection.byLayer['current-state'].selected.count).toBe(0)
    // 让位只是"本轮不注入"，described 与候选集合不变（存储不受影响）
    expect(plan.described.totalTokens).toBeGreaterThan(0)
  })

  it('简单话题可少注入：语义命中少时候选与选择都更小', () => {
    const allFacts = factsFixture(40)
    const fullPlan = buildMemoryCandidateSet({ currentState: '', timeline: '', facts: allFacts, semanticScores: null, model: 'gpt-4o-mini' })
    const hitFacts = allFacts.slice(0, 3)
    const hitPlan = buildMemoryCandidateSet({
      currentState: '', timeline: '', facts: hitFacts, semanticScores: [0.9, 0.8, 0.7], model: 'gpt-4o-mini',
    })
    expect(hitPlan.described.factCount).toBe(3)
    expect(hitPlan.described.factTokens).toBeLessThan(fullPlan.described.factTokens)
    const fullSelection = selectMemoryCandidates(fullPlan, { budgetTokens: 60000 })
    const hitSelection = selectMemoryCandidates(hitPlan, { budgetTokens: 60000 })
    expect(hitSelection.selectedTokens).toBeLessThan(fullSelection.selectedTokens)
  })

  it('失败可退原选择：报告兜底为 degraded，不抛出', () => {
    const plan = makePlan()
    const report = buildMemoryShadowReport({
      plan,
      existing: existingStats(800, 500),
      budgetTokens: 20000,
      // 故意让竞争集合在展开时抛出（模拟上游数据异常）
      competitors: { map: () => { throw new Error('boom') } } as never,
    })
    expect(report.degraded).toBe(true)
    expect(report.candidate.totalTokens).toBe(0)
    expect(report.existing.totalTokens).toBe(500)
    expect(formatMemoryShadowSummary(report)).toContain('degraded=1')
  })

  it('任何失败都不删除记忆：输入事实与候选集合在分配后保持不变', () => {
    const facts = factsFixture(8)
    const plan = buildMemoryCandidateSet({ currentState: '当前状态', timeline: timelineLines(4), facts, semanticScores: null, model: 'gpt-4o-mini' })
    const factsSnapshot = JSON.stringify(facts)
    const planSnapshot = JSON.stringify(plan)
    selectMemoryCandidates(plan, { budgetTokens: 300, competitors: protocolCompetitors(200) })
    buildMemoryShadowReport({ plan, existing: existingStats(800, 400), budgetTokens: 300 })
    expect(JSON.stringify(facts)).toBe(factsSnapshot)
    expect(JSON.stringify(plan)).toBe(planSnapshot)
  })
})

describe('W8 记忆影子报告', () => {
  const plan = makePlan({ facts: factsFixture(12), timeline: timelineLines(8) })
  const report = buildMemoryShadowReport({
    plan,
    existing: existingStats(800, 900),
    budgetTokens: 30000,
  })

  it('分层统计与总量自洽', () => {
    const sumExisting = report.byLayer.reduce((sum, diff) => sum + diff.existingTokens, 0)
    const sumCandidate = report.byLayer.reduce((sum, diff) => sum + diff.candidateTokens, 0)
    expect(sumExisting).toBe(report.existing.totalTokens)
    expect(sumCandidate).toBe(report.candidate.totalTokens)
    expect(report.deltaTokens).toBe(report.candidate.totalTokens - report.existing.totalTokens)
    expect(report.candidate.factCount).toBe(report.byLayer.find((diff) => diff.layer === 'fact')!.candidateCount)
  })

  it('候选侧无记忆专属上限；突破既有 cap 时显式标记', () => {
    expect(report.candidate).not.toHaveProperty('capTokens')
    expect(report.legacyCapTokens).toBe(800)
    expect(report.exceedsLegacyCap).toBe(report.candidate.totalTokens > 800)
  })

  it('报告与日志串不含记忆正文或事实文本', () => {
    const serialized = `${JSON.stringify(report)}\n${formatMemoryShadowSummary(report)}`
    for (const marker of ['事件描述', '正在躲避沙尘暴', '补补补', '主体0', '值0']) {
      expect(serialized).not.toContain(marker)
    }
    expect(formatMemoryShadowSummary(report)).toContain('mode=memory-shadow')
  })

  it('竞争者统计可解释记忆挤占的空间', () => {
    const withCompetitors = buildMemoryShadowReport({
      plan,
      existing: existingStats(800, 900),
      budgetTokens: 1000,
      competitors: protocolCompetitors(400),
    })
    expect(withCompetitors.competitor.describedTokens).toBe(400)
    expect(withCompetitors.competitor.selectedTokens).toBeLessThanOrEqual(400)
    expect(withCompetitors.competitor.deltaTokens).toBeLessThanOrEqual(0)
  })
})

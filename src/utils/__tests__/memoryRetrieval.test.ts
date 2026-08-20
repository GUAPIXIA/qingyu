import { describe, it, expect } from 'vitest'
import type { MemoryFact } from '../../../shared/types'
import {
  computeRecencyScore,
  scoreAndRankFacts,
  selectFactsByBudget,
  fitLayeredMemoryBudget,
  memoryFactToText,
} from '../memory'

function mockEstimate(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  return Math.ceil(cjk * 0.9 + (text.length - cjk) * 0.3)
}

function makeFact(overrides: Partial<MemoryFact> & { id: string; subject: string; predicate: string; value: string }): MemoryFact {
  return {
    status: 'active',
    importance: 3,
    confidence: 0.8,
    sourceMessageIds: [],
    updatedAt: Date.now(),
    ...overrides,
  } as MemoryFact
}

describe('computeRecencyScore', () => {
  it('最近更新为 1，30天后为 0', () => {
    const now = Date.now()
    expect(computeRecencyScore(now, now)).toBe(1)
    expect(computeRecencyScore(now - 15 * 24 * 3600 * 1000, now)).toBeCloseTo(0.5, 1)
    expect(computeRecencyScore(now - 30 * 24 * 3600 * 1000, now)).toBe(0)
    expect(computeRecencyScore(now - 60 * 24 * 3600 * 1000, now)).toBe(0)
  })
  it('无效时间返回 0.5', () => {
    expect(computeRecencyScore(undefined as unknown as number)).toBe(0.5)
    expect(computeRecencyScore(0)).toBe(0.5)
  })
})

describe('scoreAndRankFacts - 字符串事实 0.7语义+0.3新近', () => {
  it('语义高分排前', () => {
    const facts = ['事实A', '事实B', '事实C']
    const scores = [0.9, 0.2, 0.5]
    const ranked = scoreAndRankFacts(facts, scores)
    expect(ranked[0].fact).toBe('事实A')
    expect(ranked[1].fact).toBe('事实C')
    expect(ranked[2].fact).toBe('事实B')
    expect(ranked[0].score).toBeCloseTo(0.9 * 0.7 + 0.5 * 0.3, 2)
  })
  it('无语义时降级按 importance+recency', () => {
    const f1 = makeFact({ id: '1', subject: 'A', predicate: '关系', value: '朋友', importance: 5, updatedAt: Date.now() })
    const f2 = makeFact({ id: '2', subject: 'B', predicate: '关系', value: '同事', importance: 1, updatedAt: Date.now() - 20 * 24 * 3600 * 1000 })
    const ranked = scoreAndRankFacts([f2, f1], null)
    expect((ranked[0].fact as MemoryFact).id).toBe('1')
  })
})

describe('scoreAndRankFacts - 结构化 0.5+0.3+0.2', () => {
  it('综合分数正确', () => {
    const now = Date.now()
    const f = makeFact({ id: '1', subject: '林夏', predicate: '关系', value: '恋人', importance: 5, updatedAt: now })
    const ranked = scoreAndRankFacts([f], [0.8], now)
    const expected = 0.8 * 0.5 + 1 * 0.3 + 1 * 0.2
    expect(ranked[0].score).toBeCloseTo(expected, 2)
    expect(ranked[0].semantic).toBe(0.8)
    expect(ranked[0].recency).toBe(1)
  })
  it('重要性低的被排后', () => {
    const now = Date.now()
    const f1 = makeFact({ id: '1', subject: 'A', predicate: 'p', value: 'v1', importance: 1, updatedAt: now })
    const f2 = makeFact({ id: '2', subject: 'B', predicate: 'p', value: 'v2', importance: 5, updatedAt: now })
    const ranked = scoreAndRankFacts([f1, f2], [0.5, 0.5], now)
    expect((ranked[0].fact as MemoryFact).id).toBe('2')
  })
})

describe('selectFactsByBudget - 跳过超限继续', () => {
  it('单条超限跳过，后续短事实仍保留', () => {
    const facts: MemoryFact[] = [
      makeFact({ id: '1', subject: '长', predicate: '内容', value: '甲'.repeat(100), importance: 3, updatedAt: Date.now() }),
      makeFact({ id: '2', subject: '短', predicate: '内容', value: '乙', importance: 3, updatedAt: Date.now() }),
    ]
    const ranked = scoreAndRankFacts(facts, [0.9, 0.9])
    // 预算 60：放不下长事实，但放得下短事实
    const selected = selectFactsByBudget(ranked, 60, mockEstimate)
    expect(selected.length).toBe(1)
    expect(memoryFactToText(selected[0])).toContain('乙')
  })
  it('按评分降序选择', () => {
    const f1 = makeFact({ id: '1', subject: '低分', predicate: 'p', value: 'v1', importance: 1, updatedAt: Date.now() - 29 * 24 * 3600 * 1000 })
    const f2 = makeFact({ id: '2', subject: '高分', predicate: 'p', value: 'v2', importance: 5, updatedAt: Date.now() })
    const ranked = scoreAndRankFacts([f1, f2], [0.9, 0.9])
    const selected = selectFactsByBudget(ranked, 500, mockEstimate)
    expect((selected[0] as MemoryFact).id).toBe('2')
  })
})

describe('fitLayeredMemoryBudget - 检索排序与预算跳过集成', () => {
  it('事实按 importance 排序后预算跳过', () => {
    const fLow = makeFact({ id: 'low', subject: 'A', predicate: 'p', value: '甲'.repeat(100), importance: 1, updatedAt: Date.now() })
    const fHigh = makeFact({ id: 'high', subject: 'B', predicate: 'p', value: '短', importance: 5, updatedAt: Date.now() })
    // 传入顺序 low 在前，但 ranking 应让 high 优先
    const result = fitLayeredMemoryBudget('当前状态', '时间线', [fLow, fHigh], 200, mockEstimate)
    // 预算 200：state 约 30，剩余 170，事实预算 ~68，放不下 low（约91 token），但放得下 high
    expect(result.facts.map((f) => (f as MemoryFact).id)).toContain('high')
    expect(result.facts.map((f) => (f as MemoryFact).id)).not.toContain('low')
  })
  it('降级无语义时仍按 importance 排序', () => {
    const f1 = makeFact({ id: '1', subject: 'A', predicate: 'p', value: '事实1', importance: 1, updatedAt: Date.now() })
    const f2 = makeFact({ id: '2', subject: 'B', predicate: 'p', value: '事实2', importance: 5, updatedAt: Date.now() })
    const ranked = scoreAndRankFacts([f1, f2], null)
    expect((ranked[0].fact as MemoryFact).id).toBe('2')
  })
})

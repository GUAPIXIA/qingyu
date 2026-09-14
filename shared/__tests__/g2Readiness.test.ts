/**
 * G2 取证就绪纯逻辑测试（主计划 §7.13 第 1/7 条离线核对）。
 */
import { describe, expect, it } from 'vitest'
import type { GenerationObservation } from '../generationObservation'
import {
  G2_VALID_GENERATION_TARGET,
  buildG2Checklist,
  computeG2Progress,
  formatG2ProgressSummary,
  g2SegmentKey,
  g2SegmentLabel,
} from '../g2Readiness'

function obs(overrides: Partial<GenerationObservation> & { requestId: string }): GenerationObservation {
  return {
    ts: 1_700_000_000_000,
    source: 'single',
    provider: 'openai',
    model: 'deepseek-v4.1-flash',
    requestedMaxTokens: 4096,
    stream: true,
    finishReason: 'stop',
    outcome: 'completed',
    bodyVisibleChars: 120,
    completionTokens: 800,
    reasoningTokens: 200,
    durationMs: 5000,
    attempts: 1,
    diagnostics: {
      completeSentence: true,
      balancedQuotes: true,
      balancedAsterisks: true,
      closedThought: true,
    },
    ...overrides,
  }
}

function many(n: number, base: Partial<GenerationObservation> = {}): GenerationObservation[] {
  return Array.from({ length: n }, (_, i) => obs({
    requestId: `r-${base.provider ?? 'p'}-${i}`,
    ...base,
  }))
}

describe('g2 分段键', () => {
  it('缺省 gateLevel → none；明确 off/low 分开', () => {
    expect(g2SegmentKey(obs({ requestId: 'a' })).gate).toBe('none')
    expect(g2SegmentKey(obs({ requestId: 'b', gateLevel: 'off' })).gate).toBe('off')
    expect(g2SegmentKey(obs({ requestId: 'c', gateLevel: 'low' })).gate).toBe('low')
  })

  it('label 稳定', () => {
    expect(g2SegmentLabel({ pipeline: 'unified', gate: 'off' })).toBe('unified/gate:off')
  })
})

describe('computeG2Progress', () => {
  it('空样本：未通过，剩余=500', () => {
    const p = computeG2Progress([])
    expect(p.pass).toBe(false)
    expect(p.validAllSegments).toBe(0)
    expect(p.remaining).toBe(G2_VALID_GENERATION_TARGET)
    expect(p.bestSegment).toBeNull()
  })

  it('跨段加总 ≥500 但单段不足 → 不过门（第 7 条）', () => {
    const records = [
      ...many(300, { provider: 'openai', gateLevel: 'off' }),
      ...many(250, { provider: 'openai', gateLevel: 'low' }),
    ]
    const p = computeG2Progress(records)
    expect(p.validAllSegments).toBe(550)
    expect(p.pass).toBe(false)
    expect(p.segments).toHaveLength(2)
  })

  it('单段 500 有效 + 2 供应商 → 过门', () => {
    const records = [
      ...many(400, { provider: 'openai', gateLevel: 'off' }),
      ...many(100, { provider: 'deepseek', gateLevel: 'off' }),
    ]
    const p = computeG2Progress(records)
    expect(p.pass).toBe(true)
    expect(p.passableSegments[0].key).toBe('unified/gate:off')
    expect(p.passableSegments[0].providers).toEqual(['deepseek', 'openai'])
    expect(p.remaining).toBe(0)
  })

  it('单供应商即使 500 也不过门', () => {
    const records = many(500, { provider: 'openai', gateLevel: 'off' })
    const p = computeG2Progress(records)
    expect(p.bestSegment!.valid).toBe(500)
    expect(p.pass).toBe(false)
  })

  it('error / aux / 后台任务不计入有效', () => {
    const records = [
      ...many(10, { outcome: 'error' }),
      ...many(10, { source: 'aux' }),
      ...many(10, { taskType: 'direction' }),
      ...many(5, { provider: 'openai', gateLevel: 'off' }),
    ]
    const p = computeG2Progress(records)
    expect(p.bestSegment!.valid).toBe(5)
  })

  it('summary 含 pass 与进度', () => {
    const p = computeG2Progress(many(3, { provider: 'openai', gateLevel: 'off' }))
    const s = formatG2ProgressSummary(p)
    expect(s).toContain('pass=0')
    expect(s).toContain('unified/gate:off')
  })
})

describe('buildG2Checklist', () => {
  it('未达标时第 1 条 pending；g1Passed 旗标可标 pass', () => {
    const p = computeG2Progress(many(2, { provider: 'openai' }))
    const list = buildG2Checklist(p, { g1Passed: true })
    expect(list.find((i) => i.id === 'valid-500')!.status).toBe('pending')
    expect(list.find((i) => i.id === 'g1')!.status).toBe('pass')
    expect(list.find((i) => i.id === 'phase7')!.status).toBe('pending')
  })

  it('可过门时第 1/7 条 pass', () => {
    const records = [
      ...many(300, { provider: 'openai', gateLevel: 'off' }),
      ...many(200, { provider: 'anthropic', gateLevel: 'off' }),
    ]
    const list = buildG2Checklist(computeG2Progress(records), { g1Passed: true })
    expect(list.find((i) => i.id === 'valid-500')!.status).toBe('pass')
    expect(list.find((i) => i.id === 'segmented')!.status).toBe('pass')
  })
})

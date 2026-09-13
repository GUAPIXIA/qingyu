/**
 * 基线纯逻辑验收（C4）：有效生成分母口径、分组与百分位。
 * IO 与 markdown 组装在 scripts/generation-baseline.ts，不在本测试范围。
 */
import { describe, expect, it } from 'vitest'
import type { GenerationObservation } from '../generationObservation'
import {
  buildGroupStats,
  computeValidGenerations,
  groupKey,
  percentile,
  rate,
} from '../generationBaseline'

function makeObs(overrides: Partial<GenerationObservation> = {}): GenerationObservation {
  return {
    ts: 1_700_000_000_000,
    requestId: 'req-1',
    source: 'single',
    model: 'deepseek-v4',
    provider: 'openai',
    requestedMaxTokens: 4096,
    stream: true,
    finishReason: 'stop',
    outcome: 'completed',
    bodyVisibleChars: 120,
    completionTokens: 200,
    reasoningTokens: 'unknown',
    durationMs: 800,
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

describe('computeValidGenerations（G2 500 次分母）', () => {
  it('计入主对话 completed/truncated/user_cancelled', () => {
    const result = computeValidGenerations([
      makeObs({ outcome: 'completed' }),
      makeObs({ requestId: 'r2', outcome: 'truncated' }),
      makeObs({ requestId: 'r3', outcome: 'user_cancelled' }),
    ])
    expect(result.valid).toBe(3)
    expect(result.byOutcome.completed).toBe(1)
    expect(result.byOutcome.truncated).toBe(1)
    expect(result.byOutcome.user_cancelled).toBe(1)
  })

  it('排除 aux、后台任务与 error', () => {
    const result = computeValidGenerations([
      makeObs({ source: 'aux' }),
      makeObs({ requestId: 'r2', source: 'single', taskType: 'memory' }),
      makeObs({ requestId: 'r3', source: 'bridge', taskType: 'direction' }),
      makeObs({ requestId: 'r4', outcome: 'error', errorKind: 'network' }),
      makeObs({ requestId: 'r5', outcome: 'completed' }),
    ])
    expect(result.valid).toBe(1)
    expect(result.excludedAux).toBe(1)
    expect(result.excludedBackground).toBe(2)
    expect(result.excludedError).toBe(1)
  })
})

describe('分组与百分位', () => {
  it('groupKey 按 provider × model × task', () => {
    expect(groupKey(makeObs())).toBe('openai/deepseek-v4/main')
    expect(groupKey(makeObs({ taskType: 'title' }))).toBe('openai/deepseek-v4/title')
  })

  it('buildGroupStats 汇总有效数与正文分位', () => {
    const stats = buildGroupStats([
      makeObs({ bodyVisibleChars: 100 }),
      makeObs({ requestId: 'r2', bodyVisibleChars: 200 }),
      makeObs({ requestId: 'r3', bodyVisibleChars: 300, outcome: 'error' }),
    ])
    expect(stats).toHaveLength(1)
    expect(stats[0].key).toBe('openai/deepseek-v4/main')
    expect(stats[0].total).toBe(3)
    expect(stats[0].valid).toBe(2)
    expect(stats[0].p50Chars).toBe(200)
    expect(stats[0].p90Chars).toBe(300)
  })

  it('percentile 与 rate 边界', () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2)
    expect(rate(0, 0)).toBe('—')
    expect(rate(1, 4)).toBe('1/4（25.0%）')
  })
})

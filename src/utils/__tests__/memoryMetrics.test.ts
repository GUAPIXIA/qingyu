import { describe, it, expect } from 'vitest'
import { calculateMetrics, isMetricsPass } from '../memoryMetrics'

describe('memoryMetrics', () => {
  it('计算召回/冲突/漂移及均值', () => {
    const m = calculateMetrics({
      factRecall: { totalFacts: 20, recalledFacts: 18 },
      conflict: { totalFacts: 20, conflictFacts: 1 },
      drift: { totalSummaries: 10, driftedSummaries: 1 },
      tokenCosts: [100, 200],
      latenciesMs: [120, 180],
    })
    expect(m.factRecallRate).toBeCloseTo(0.9)
    expect(m.conflictRate).toBeCloseTo(0.05)
    expect(m.driftRate).toBeCloseTo(0.1)
    expect(m.avgTokenCost).toBe(150)
    expect(m.avgLatencyMs).toBe(150)
    expect(m.latencyOk).toBe(true)
    expect(isMetricsPass(m)).toBe(true)
  })

  it('零分母时返回 0 且不抛错', () => {
    const m = calculateMetrics({})
    expect(m.factRecallRate).toBe(0)
    expect(m.conflictRate).toBe(0)
    expect(m.driftRate).toBe(0)
    expect(m.avgTokenCost).toBe(0)
  })

  it('clamp 0-1 边界', () => {
    const m = calculateMetrics({
      factRecall: { totalFacts: 10, recalledFacts: 20 },
      conflict: { totalFacts: 10, conflictFacts: -5 },
    })
    expect(m.factRecallRate).toBe(1)
    expect(m.conflictRate).toBe(0)
  })

  it('延迟超标判定', () => {
    const m = calculateMetrics({ latenciesMs: [250, 300] })
    expect(m.latencyOk).toBe(false)
    expect(isMetricsPass(m)).toBe(false)
  })
})

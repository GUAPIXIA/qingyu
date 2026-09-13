/**
 * W7（主计划 §5.6）：序列化后最终输入审计骨架测试。
 *
 * 本期只交付契约与纯聚合：计数精度三档、最弱环节决定整体口径、超限只报告不裁剪、
 * 序列化视图缺失时不得宣称精确 Token。
 */
import { describe, expect, it } from 'vitest'
import { TOKEN_BUDGET_SAFETY } from '../chatConstants'
import {
  MAX_INPUT_REALLOCATIONS,
  auditSerializedInput,
  formatInputAuditSummary,
  weakestAccountingConfidence,
  type SerializedInputView,
} from '../inputAudit'

function makeView(overrides: Partial<SerializedInputView> = {}): SerializedInputView {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    serialized: true,
    parts: [
      { id: 'system', role: 'system', tokens: 1000, confidence: 'exact' },
      { id: 'm1', role: 'user', tokens: 200, confidence: 'exact' },
      { id: 'm2', role: 'assistant', tokens: 300, confidence: 'provider-reported' },
    ],
    ...overrides,
  }
}

describe('输入审计：聚合与口径', () => {
  it('合计输入 = 各片段之和，并叠加输出预留与协议安全余量', () => {
    const audit = auditSerializedInput(makeView(), { reservedOutputTokens: 1024, contextLimit: 32768 })
    expect(audit.inputTokens).toBe(1500)
    expect(audit.reservedOutputTokens).toBe(1024)
    expect(audit.protocolSafetyTokens).toBe(Math.ceil(32768 * (1 - TOKEN_BUDGET_SAFETY)))
    expect(audit.totalTokens).toBe(audit.inputTokens + audit.reservedOutputTokens + audit.protocolSafetyTokens)
    expect(audit.overBudget).toBe(false)
    expect(audit.remainingReallocations).toBe(MAX_INPUT_REALLOCATIONS)
    expect(audit.serializedViewMissing).toBe(false)
  })

  it('整体精度取最弱环节；混入估算即不得宣称精确', () => {
    expect(auditSerializedInput(makeView(), { reservedOutputTokens: 1024, contextLimit: 32768 }).accountingConfidence)
      .toBe('provider-reported')
    const estimated = makeView({
      parts: [{ id: 'system', role: 'system', tokens: 10, confidence: 'estimated' }, { id: 'm1', role: 'user', tokens: 10, confidence: 'exact' }],
    })
    expect(auditSerializedInput(estimated, { reservedOutputTokens: 1024, contextLimit: 32768 }).accountingConfidence)
      .toBe('estimated')
    expect(weakestAccountingConfidence(['exact', 'exact'])).toBe('exact')
    expect(weakestAccountingConfidence([])).toBe('exact')
  })

  it('序列化视图缺失或无片段时只按估算口径报告', () => {
    const missing = auditSerializedInput(makeView({ serialized: false }), { reservedOutputTokens: 1024, contextLimit: 32768 })
    expect(missing.serializedViewMissing).toBe(true)
    const empty = auditSerializedInput(makeView({ parts: [] }), { reservedOutputTokens: 1024, contextLimit: 32768 })
    expect(empty.inputTokens).toBe(0)
    expect(empty.accountingConfidence).toBe('estimated')
    expect(empty.byRole).toEqual([])
  })

  it('超限只报告，不裁剪：返回 overBudget 与剩余重分配额度', () => {
    const audit = auditSerializedInput(makeView({
      parts: [{ id: 'huge', role: 'system', tokens: 10000, confidence: 'exact' }],
    }), { reservedOutputTokens: 4096, contextLimit: 8192 })
    expect(audit.overBudget).toBe(true)
    expect(audit.remainingReallocations).toBe(MAX_INPUT_REALLOCATIONS)
    expect(audit.inputTokens).toBe(10000)
  })

  it('按 role 稳定分类，且非法/负数/NaN 计数按 0 处理', () => {
    const audit = auditSerializedInput(makeView({
      parts: [
        { id: 'a', role: 'user', tokens: Number.NaN, confidence: 'estimated' },
        { id: 'b', role: 'tool', tokens: -5, confidence: 'estimated' },
        { id: 'c', role: 'assistant', tokens: 30, confidence: 'exact' },
      ],
    }), { reservedOutputTokens: 0, contextLimit: 8192 })
    expect(audit.byRole.map((stat) => stat.role)).toEqual(['user', 'assistant', 'tool'])
    expect(audit.inputTokens).toBe(30)
  })

  it('协议安全余量可覆盖，默认与 TOKEN_BUDGET_SAFETY 同源', () => {
    const audit = auditSerializedInput(makeView({ parts: [] }), {
      reservedOutputTokens: 0,
      contextLimit: 1000,
      protocolSafetyRatio: 0.2,
    })
    expect(audit.protocolSafetyTokens).toBe(200)
  })

  it('日志串只含数值口径，不含片段 id 之外的内容', () => {
    const audit = auditSerializedInput(makeView(), { reservedOutputTokens: 1024, contextLimit: 32768 })
    const summary = formatInputAuditSummary(audit)
    expect(summary).toContain('accounting=provider-reported')
    expect(summary).toContain('serialized=1')
    expect(summary).not.toContain('gpt-4o-mini')
  })
})

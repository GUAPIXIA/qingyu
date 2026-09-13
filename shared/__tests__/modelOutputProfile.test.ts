import { describe, expect, it } from 'vitest'
import {
  BODY_RESERVE_MULTIPLIER,
  BODY_RESERVE_OVERHEAD_TOKENS,
  MAX_REQUEST_OUTPUT_TOKENS,
  MIN_USABLE_BODY_TOKENS,
  PROTOCOL_RESERVE_TOKENS,
  estimateTokensForVisibleChars,
  getModelOutputProfile,
  percentile90,
  resolveReasoningReserve,
  resolveRequestBudget,
} from '../modelOutputProfile'

describe('getModelOutputProfile', () => {
  it('DeepSeek V4 为共享推理模型（无统计默认 3072 / 上限 4096）', () => {
    const profile = getModelOutputProfile('deepseek/deepseek-v4.1-flash')
    expect(profile.reasoningMode).toBe('shared-unknown')
    expect(profile.defaultReasoningReserve).toBe(3072)
    expect(profile.maxReasoningReserve).toBe(4096)
  })

  it('已知推理模型与普通模型分别命中档案', () => {
    expect(getModelOutputProfile('deepseek-reasoner').reasoningMode).toBe('shared-unknown')
    expect(getModelOutputProfile('claude-4-sonnet').reasoningMode).toBe('shared-unknown')
    // haiku 无扩展思考，优先于 claude-4 命中
    expect(getModelOutputProfile('claude-4-haiku').reasoningMode).toBe('none')
    expect(getModelOutputProfile('gpt-4o').reasoningMode).toBe('none')
    expect(getModelOutputProfile('o3-mini').reasoningMode).toBe('shared-unknown')
  })
})

describe('resolveReasoningReserve', () => {
  it('none / separate 仅保留协议余量', () => {
    const none = getModelOutputProfile('gpt-4o')
    expect(resolveReasoningReserve(none)).toBe(PROTOCOL_RESERVE_TOKENS)
  })

  it('shared-known 使用近期样本 P90 × 1.2，并钳制在档案上限内', () => {
    const profile = getModelOutputProfile('deepseek/deepseek-v4.1-flash')
    // 样本 < 10 个时 P90 取最大值（保守）
    expect(resolveReasoningReserve(profile, [1000, 2000, 2500])).toBe(Math.ceil(2500 * 1.2))
    // 大样本取 P90 分位；低于协议余量时抬高到协议余量
    const samples = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100
    expect(percentile90(samples)).toBe(90)
    expect(resolveReasoningReserve(profile, samples)).toBe(
      Math.min(4096, Math.max(PROTOCOL_RESERVE_TOKENS, Math.ceil(90 * 1.2))),
    )
    // 超出档案上限时截断
    expect(resolveReasoningReserve(profile, [5000, 6000, 8000])).toBe(4096)
  })

  it('shared-known 无样本时回退默认值', () => {
    const profile = getModelOutputProfile('deepseek/deepseek-v4.1-flash')
    expect(resolveReasoningReserve(profile, [])).toBe(3072)
  })
})

describe('resolveRequestBudget', () => {
  it('正文预算、推理余量与上限分别生效', () => {
    const budget = resolveRequestBudget({ model: 'gpt-4o', hardMaxChars: 600 })
    const expectedBody = Math.ceil(600 * BODY_RESERVE_MULTIPLIER) + BODY_RESERVE_OVERHEAD_TOKENS
    expect(budget.bodyReserve).toBe(expectedBody)
    expect(budget.reasoningReserve).toBe(PROTOCOL_RESERVE_TOKENS)
    expect(budget.requestMaxTokens).toBe(Math.min(8192, MAX_REQUEST_OUTPUT_TOKENS, expectedBody + PROTOCOL_RESERVE_TOKENS))
  })

  it('DeepSeek V4 不再固定 8192：请求上限由正文预算 + 推理余量构成', () => {
    const balanced = resolveRequestBudget({ model: 'deepseek/deepseek-v4.1-flash', hardMaxChars: 600 })
    expect(balanced.requestMaxTokens).toBeLessThan(MAX_REQUEST_OUTPUT_TOKENS)
    expect(balanced.requestMaxTokens).toBe(balanced.bodyReserve + balanced.reasoningReserve)
    expect(balanced.reasoningReserve).toBeGreaterThanOrEqual(3072)
    // 篇幅变化只影响正文预算，推理余量不变（同一推理模型始终获得足够推理空间）
    const brief = resolveRequestBudget({ model: 'deepseek/deepseek-v4.1-flash', hardMaxChars: 260 })
    const detailed = resolveRequestBudget({ model: 'deepseek/deepseek-v4.1-flash', hardMaxChars: 1100 })
    expect(brief.bodyReserve).toBeLessThan(balanced.bodyReserve)
    expect(detailed.bodyReserve).toBeGreaterThan(balanced.bodyReserve)
    expect(brief.reasoningReserve).toBe(balanced.reasoningReserve)
    expect(detailed.reasoningReserve).toBe(balanced.reasoningReserve)
    expect(brief.requestMaxTokens).toBeLessThan(detailed.requestMaxTokens)
  })

  it('有近期 reasoning 样本时使用滚动统计（shared-known 行为）', () => {
    const budget = resolveRequestBudget({
      model: 'deepseek/deepseek-v4.1-flash',
      hardMaxChars: 600,
      recentReasoningTokens: [512, 768, 1024],
    })
    expect(budget.reasoningReserve).toBe(Math.ceil(1024 * 1.2))
  })

  it('用户硬上限始终生效；低于推理余量时给出风险提示而非静默放大', () => {
    const budget = resolveRequestBudget({
      model: 'deepseek/deepseek-v4.1-flash',
      hardMaxChars: 600,
      userHardCap: 1024,
    })
    expect(budget.requestMaxTokens).toBe(1024)
    expect(budget.riskNotice).toBe('user_cap_below_reasoning_reserve')
    // 更大的硬上限不触发提示
    const roomy = resolveRequestBudget({
      model: 'deepseek/deepseek-v4.1-flash',
      hardMaxChars: 600,
      userHardCap: 8192,
    })
    expect(roomy.riskNotice).toBeUndefined()
    expect(roomy.requestMaxTokens).toBeLessThanOrEqual(8192)
  })

  it('硬上限只够推理、没有最小正文空间时同样判为高风险', () => {
    const budget = resolveRequestBudget({
      model: 'deepseek/deepseek-v4.1-flash',
      hardMaxChars: 600,
      userHardCap: 3072,
    })
    expect(budget.minimumViableOutputTokens).toBe(budget.reasoningReserve + MIN_USABLE_BODY_TOKENS)
    expect(budget.riskNotice).toBe('user_cap_below_reasoning_reserve')
    expect(budget.requestMaxTokens).toBe(3072)
  })

  it('用户硬上限为 0 表示自动，不限制动态预算', () => {
    const automatic = resolveRequestBudget({
      model: 'deepseek/deepseek-v4.1-flash',
      hardMaxChars: 600,
      userHardCap: 0,
    })
    const uncapped = resolveRequestBudget({
      model: 'deepseek/deepseek-v4.1-flash',
      hardMaxChars: 600,
    })
    expect(automatic).toEqual(uncapped)
    expect(automatic.riskNotice).toBeUndefined()
  })

  it('非法 hardMaxChars 退化为仅协议/推理余量', () => {
    const budget = resolveRequestBudget({ model: 'gpt-4o', hardMaxChars: Number.NaN })
    expect(budget.bodyReserve).toBe(0)
    expect(budget.requestMaxTokens).toBe(PROTOCOL_RESERVE_TOKENS)
  })

  it('防御分支：空模型名 / 非法样本过滤', () => {
    expect(getModelOutputProfile('')).toEqual(getModelOutputProfile('未知模型'))
    // 非法 reasoning 样本被过滤后回退默认值
    expect(resolveReasoningReserve(getModelOutputProfile('deepseek-v4'), [Number.NaN, -5])).toBe(3072)
    // userHardCap 非法值（0/负数/NaN）视为未指定
    const noCap = resolveRequestBudget({ model: 'gpt-4o', hardMaxChars: 600, userHardCap: Number.NaN })
    expect(noCap.requestMaxTokens).toBe(resolveRequestBudget({ model: 'gpt-4o', hardMaxChars: 600 }).requestMaxTokens)
  })

  it('可见字符 token 估算为 1:1 向上取整', () => {
    expect(estimateTokensForVisibleChars(600)).toBe(600)
    expect(estimateTokensForVisibleChars(600.5)).toBe(601)
    expect(estimateTokensForVisibleChars(0)).toBe(0)
    expect(estimateTokensForVisibleChars(Number.NaN)).toBe(0)
  })
})

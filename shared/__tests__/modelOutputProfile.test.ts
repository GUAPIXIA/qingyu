import { describe, expect, it } from 'vitest'
import {
  BODY_RESERVE_MULTIPLIER,
  BODY_RESERVE_OVERHEAD_TOKENS,
  DEFAULT_AUTOMATIC_OUTPUT_LIMIT,
  DEFAULT_AUTOMATIC_REASONING_RESERVE,
  MIN_USABLE_BODY_TOKENS,
  enabledProfileOverride,
  estimateTokensForVisibleChars,
  getModelOutputProfile,
  percentile90,
  resolveEffectiveContextLimit,
  resolveReasoningReserve,
  resolveRequestBudget,
} from '../modelOutputProfile'

describe('getModelOutputProfile', () => {
  it('模型名只决定协议能力，不再决定输出或推理 token 数值', () => {
    const models = ['deepseek/deepseek-v4.1-flash', 'deepseek-reasoner', 'claude-4-sonnet', 'gemini-3-flash', 'o3-mini', 'gpt-4o', 'private-model']
    const numericProfiles = models.map((model) => {
      const profile = getModelOutputProfile(model)
      return {
        outputLimit: profile.outputLimit,
        reasoningMode: profile.reasoningMode,
        defaultReasoningReserve: profile.defaultReasoningReserve,
        maxReasoningReserve: profile.maxReasoningReserve,
      }
    })
    expect(new Set(numericProfiles.map((profile) => JSON.stringify(profile)))).toHaveLength(1)
    expect(numericProfiles[0]).toEqual({
      outputLimit: DEFAULT_AUTOMATIC_OUTPUT_LIMIT,
      reasoningMode: 'shared-unknown',
      defaultReasoningReserve: DEFAULT_AUTOMATIC_REASONING_RESERVE,
      maxReasoningReserve: DEFAULT_AUTOMATIC_OUTPUT_LIMIT - MIN_USABLE_BODY_TOKENS,
    })
  })

  it('门控字段仍按协议能力选择，但不会改变预算数值', () => {
    expect(getModelOutputProfile('deepseek-v4').gateKnobs[0]).toBe('thinking-disable')
    expect(getModelOutputProfile('claude-4-sonnet').gateKnobs[0]).toBe('thinking-budget')
    expect(getModelOutputProfile('private-model').gateKnobs).toEqual(['none'])
  })
})

describe('resolveReasoningReserve', () => {
  it('无样本时使用所有模型共用的自动余量', () => {
    for (const model of ['deepseek-v4', 'gpt-4o', 'private-model']) {
      expect(resolveReasoningReserve(getModelOutputProfile(model))).toBe(DEFAULT_AUTOMATIC_REASONING_RESERVE)
    }
  })

  it('有样本时使用 P90 × 1.2，不再被旧 4096 模型特判截断', () => {
    const profile = getModelOutputProfile('private-model')
    expect(resolveReasoningReserve(profile, [1000, 2000, 2500])).toBe(3000)
    expect(resolveReasoningReserve(profile, [5000, 6000, 8000])).toBe(9600)
    const ten = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    expect(percentile90(ten)).toBe(900)
    expect(resolveReasoningReserve(profile, ten)).toBe(1080)
  })

  it('全零或非法样本不作为关闭推理的证据', () => {
    const profile = getModelOutputProfile('private-model')
    expect(resolveReasoningReserve(profile, [0, 0])).toBe(DEFAULT_AUTOMATIC_REASONING_RESERVE)
    expect(resolveReasoningReserve(profile, [Number.NaN, -1])).toBe(DEFAULT_AUTOMATIC_REASONING_RESERVE)
  })
})

describe('resolveRequestBudget', () => {
  it('正文预算和统一推理余量按同一公式相加', () => {
    const budget = resolveRequestBudget({ model: 'gpt-4o', hardMaxChars: 600 })
    const body = Math.ceil(600 * BODY_RESERVE_MULTIPLIER) + BODY_RESERVE_OVERHEAD_TOKENS
    expect(budget.bodyReserve).toBe(body)
    expect(budget.reasoningReserve).toBe(DEFAULT_AUTOMATIC_REASONING_RESERVE)
    expect(budget.requestMaxTokens).toBe(body + DEFAULT_AUTOMATIC_REASONING_RESERVE)
  })

  it('相同输入不因模型名产生不同预算', () => {
    const names = ['deepseek-v4', 'gpt-4o', 'claude-4-sonnet', 'private-model']
    const budgets = names.map((model) => resolveRequestBudget({ model, hardMaxChars: 600, recentReasoningTokens: [6291] }).requestMaxTokens)
    expect(new Set(budgets)).toHaveLength(1)
    expect(budgets[0]).toBeGreaterThan(8192)
  })

  it('自动预算不再叠加旧 8192 安全阀', () => {
    const budget = resolveRequestBudget({ model: 'private-model', hardMaxChars: 2500, recentReasoningTokens: [6291] })
    expect(budget.reasoningReserve).toBe(Math.ceil(6291 * 1.2))
    expect(budget.requestMaxTokens).toBe(budget.bodyReserve + budget.reasoningReserve)
    expect(budget.requestMaxTokens).toBeGreaterThan(8192)
  })

  it('只有显式端点能力覆盖和用户硬上限会截断', () => {
    expect(enabledProfileOverride({ enabled: false, outputLimit: 512 })).toBeUndefined()
    const endpoint = resolveRequestBudget({
      model: 'private-model', hardMaxChars: 2500, recentReasoningTokens: [6291],
      profileOverride: enabledProfileOverride({ enabled: true, outputLimit: 6000 }),
    })
    const user = resolveRequestBudget({ model: 'private-model', hardMaxChars: 2500, recentReasoningTokens: [6291], userHardCap: 4096 })
    expect(endpoint.requestMaxTokens).toBe(6000)
    expect(user.requestMaxTokens).toBe(4096)
    expect(user.riskNotice).toBe('user_cap_below_reasoning_reserve')
  })

  it('可信门控使用承诺值；不可信门控仍采用样本保守值', () => {
    const samples = [3000, 3200, 3881]
    const untrusted = resolveRequestBudget({
      model: 'private-model', hardMaxChars: 600, recentReasoningTokens: samples,
      reasoningGate: { level: 'off', knob: 'none', enforced: false, gateTokens: 0, source: 'conservative' },
    })
    const trusted = resolveRequestBudget({
      model: 'private-model', hardMaxChars: 600, recentReasoningTokens: samples,
      reasoningGate: { level: 'low', knob: 'reasoning-effort', enforced: true, gateTokens: 1024, source: 'gate' },
    })
    expect(untrusted.reasoningReserve).toBe(Math.ceil(3881 * 1.2))
    expect(trusted.reasoningReserve).toBe(1024)
  })

  it('0 表示自动；低正数是严格硬上限并产生风险提示', () => {
    const automatic = resolveRequestBudget({ model: 'private-model', hardMaxChars: 600, userHardCap: 0 })
    const uncapped = resolveRequestBudget({ model: 'private-model', hardMaxChars: 600 })
    const capped = resolveRequestBudget({ model: 'private-model', hardMaxChars: 600, userHardCap: 1024 })
    expect(automatic).toEqual(uncapped)
    expect(capped.requestMaxTokens).toBe(1024)
    expect(capped.riskNotice).toBe('user_cap_below_reasoning_reserve')
  })

  it('非法正文长度退化为统一推理余量', () => {
    const budget = resolveRequestBudget({ model: 'private-model', hardMaxChars: Number.NaN })
    expect(budget.bodyReserve).toBe(0)
    expect(budget.requestMaxTokens).toBe(DEFAULT_AUTOMATIC_REASONING_RESERVE)
  })
})

describe('上下文与字符估算', () => {
  it('旧 maxContext 只能收紧，显式能力覆盖才可放大', () => {
    expect(resolveEffectiveContextLimit({ model: 'private-model', profileMaxContext: 131072 })).toBe(32768)
    expect(resolveEffectiveContextLimit({
      model: 'private-model', profileMaxContext: 8192,
      capabilityOverride: { enabled: true, contextLimit: 131072 },
    })).toBe(131072)
  })

  it('可见字符 token 估算保持 1:1 向上取整', () => {
    expect(estimateTokensForVisibleChars(600.5)).toBe(601)
    expect(estimateTokensForVisibleChars(0)).toBe(0)
    expect(estimateTokensForVisibleChars(Number.NaN)).toBe(0)
  })
})

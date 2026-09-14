import { describe, expect, it } from 'vitest'
import {
  BODY_RESERVE_MULTIPLIER,
  BODY_RESERVE_OVERHEAD_TOKENS,
  MAX_REQUEST_OUTPUT_TOKENS,
  MIN_USABLE_BODY_TOKENS,
  PROTOCOL_RESERVE_TOKENS,
  estimateTokensForVisibleChars,
  enabledProfileOverride,
  getModelOutputProfile,
  percentile90,
  resolveReasoningReserve,
  resolveEffectiveContextLimit,
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

  it('样本边界：全 0 回退档案默认余量（不塌到协议下限）；恰好 10 个样本切到分位语义', () => {
    const profile = getModelOutputProfile('deepseek/deepseek-v4.1-flash')
    // 2026-09-13 G1 取证后修订：全 0 样本对共享窗口模型不是可信证据，
    // 塌到协议下限会造成"推理吃满正文"（实测 6/6 空正文）；max_tokens 是上限不是花费。
    expect(resolveReasoningReserve(profile, [0, 0, 0])).toBe(3072)
    expect(resolveReasoningReserve(profile, [0])).toBe(3072)
    // 只要有一条非零样本就走 P90/最大值语义，不再回退
    expect(resolveReasoningReserve(profile, [0, 0, 1000])).toBe(1200)
    const ten = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    // 10 个样本起走 P90（第 9 个值），9 个样本仍取最大值（保守）
    expect(percentile90(ten)).toBe(900)
    expect(resolveReasoningReserve(profile, ten)).toBe(Math.ceil(900 * 1.2))
    expect(percentile90(ten.slice(0, 9))).toBe(900)
  })

  it('样本全部非法时回退档案默认余量，不把异常值当 0', () => {
    const profile = getModelOutputProfile('deepseek/deepseek-v4.1-flash')
    expect(resolveReasoningReserve(profile, [Number.NaN, -5, Number.POSITIVE_INFINITY])).toBe(3072)
  })
})

describe('resolveRequestBudget', () => {
  it('只有显式启用的端点能力覆盖才参与预算，且仍受 8192 安全阀约束', () => {
    expect(enabledProfileOverride({ enabled: false, outputLimit: 512 })).toBeUndefined()
    const disabled = resolveRequestBudget({
      model: 'gpt-4o',
      hardMaxChars: 600,
      profileOverride: enabledProfileOverride({ enabled: false, outputLimit: 512 }),
    })
    expect(disabled.requestMaxTokens).toBeGreaterThan(512)

    const enabled = resolveRequestBudget({
      model: 'gpt-4o',
      hardMaxChars: 600,
      profileOverride: enabledProfileOverride({ enabled: true, outputLimit: 512 }),
    })
    expect(enabled.requestMaxTokens).toBe(512)

    const enlarged = resolveRequestBudget({
      model: 'gpt-4o',
      hardMaxChars: 20000,
      profileOverride: enabledProfileOverride({ enabled: true, outputLimit: 32000 }),
    })
    expect(enlarged.requestMaxTokens).toBe(MAX_REQUEST_OUTPUT_TOKENS)
  })

  it('旧 maxContext 只能收紧，显式能力覆盖才可放大输入窗口', () => {
    expect(resolveEffectiveContextLimit({ model: 'unknown-private-model', profileMaxContext: 131072 })).toBe(32768)
    expect(resolveEffectiveContextLimit({
      model: 'unknown-private-model',
      profileMaxContext: 131072,
      capabilityOverride: { enabled: false, contextLimit: 131072 },
    })).toBe(32768)
    expect(resolveEffectiveContextLimit({
      model: 'unknown-private-model',
      profileMaxContext: 8192,
      capabilityOverride: { enabled: true, contextLimit: 131072 },
    })).toBe(131072)
  })

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

  // 2026-09-13 G1 取证后修订（主计划 §5.4）：不可信门控的推理项必须让 P90 实测样本参与，
  // 否则静态档案余量（3072）会让"实测推理 3881"的端点稳定制造"推理吃满、正文为 0"。
  it('不可信门控：推理余量取 max(承诺值, P90 保守余量)；可信门控不被样本抬高', () => {
    const samples = [3000, 3200, 3881]
    const unenforced = resolveRequestBudget({
      model: 'deepseek/deepseek-v4.1-flash',
      hardMaxChars: 600,
      recentReasoningTokens: samples,
      reasoningGate: { level: 'off', knob: 'thinking-disable', enforced: false, gateTokens: 3072, source: 'conservative' },
    })
    // P90(3881) × 1.2 = 4658 → 被档案 maxReasoningReserve(4096) 钳制（只允许收紧，不允许无限放大）
    expect(unenforced.reasoningReserve).toBe(4096)
    expect(unenforced.reasoningReserve).toBeGreaterThan(3072)
    expect(unenforced.requestMaxTokens).toBe(unenforced.bodyReserve + unenforced.reasoningReserve)

    const enforced = resolveRequestBudget({
      model: 'claude-3-7-sonnet',
      hardMaxChars: 600,
      recentReasoningTokens: samples,
      reasoningGate: { level: 'low', knob: 'thinking-budget', enforced: true, gateTokens: 1024, source: 'gate' },
    })
    // 供应商承诺可执行 → 严格用承诺值，不被样本放大
    expect(enforced.reasoningReserve).toBe(1024)
  })

  it('不可信门控 + 样本小于档案余量 → 仍取档案/P90 的较大者（不回退到承诺值）', () => {
    const budget = resolveRequestBudget({
      model: 'deepseek/deepseek-v4.1-flash',
      hardMaxChars: 600,
      recentReasoningTokens: [100, 120, 150],
      reasoningGate: { level: 'off', knob: 'thinking-disable', enforced: false, gateTokens: 3072, source: 'conservative' },
    })
    expect(budget.reasoningReserve).toBe(3072)
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

/**
 * W0 派生值证明：记忆 2500 / 压缩 600 / 尾部修复 200 三条正文保护线的结果
 * 必须由公式复算得到，不存在独立常量；改系数或改档案时本组用例先变红。
 */
describe('派生值证明：2500/600/200 保护线全部由公式产生（W0）', () => {
  const CASES = [
    { label: '记忆', hardMaxChars: 2500, bodyReserve: 3221, requestMaxTokens: 6293 },
    { label: '压缩', hardMaxChars: 600, bodyReserve: 846, requestMaxTokens: 3918 },
    { label: '尾部修复', hardMaxChars: 200, bodyReserve: 346, requestMaxTokens: 3418 },
  ] as const

  it('deepseek-v4 共享推理档案下，三条保护线可从公式逐步复算', () => {
    for (const c of CASES) {
      const budget = resolveRequestBudget({ model: 'deepseek/deepseek-v4.1-flash', hardMaxChars: c.hardMaxChars })
      const expectedBody = Math.ceil(
        estimateTokensForVisibleChars(c.hardMaxChars) * BODY_RESERVE_MULTIPLIER,
      ) + BODY_RESERVE_OVERHEAD_TOKENS
      expect(budget.bodyReserve).toBe(expectedBody)
      expect(budget.bodyReserve).toBe(c.bodyReserve)
      expect(budget.reasoningReserve).toBe(3072)
      expect(budget.requestMaxTokens).toBe(
        Math.min(budget.profile.outputLimit, MAX_REQUEST_OUTPUT_TOKENS, c.bodyReserve + 3072),
      )
      expect(budget.requestMaxTokens).toBe(c.requestMaxTokens)
    }
  })

  it('非推理模型同一保护线只叠加协议余量（不误加推理档位）', () => {
    const expectByFormula = (chars: number) =>
      Math.ceil(estimateTokensForVisibleChars(chars) * BODY_RESERVE_MULTIPLIER)
      + BODY_RESERVE_OVERHEAD_TOKENS
      + PROTOCOL_RESERVE_TOKENS
    for (const c of CASES) {
      const budget = resolveRequestBudget({ model: 'gpt-4o', hardMaxChars: c.hardMaxChars })
      expect(budget.reasoningReserve).toBe(PROTOCOL_RESERVE_TOKENS)
      expect(budget.requestMaxTokens).toBe(expectByFormula(c.hardMaxChars))
    }
    expect(expectByFormula(2500)).toBe(3413)
    expect(expectByFormula(600)).toBe(1038)
    expect(expectByFormula(200)).toBe(538)
  })

  it('保护线增大时预算单调不减，命中通用安全阀后保持 8192', () => {
    const sweep = [0, 1, 100, 199, 200, 260, 600, 1100, 2500, 4000]
    let previous = -1
    for (const chars of sweep) {
      const budget = resolveRequestBudget({ model: 'deepseek/deepseek-v4.1-flash', hardMaxChars: chars })
      expect(budget.requestMaxTokens).toBeGreaterThanOrEqual(previous)
      previous = budget.requestMaxTokens
    }
    const huge = resolveRequestBudget({ model: 'deepseek/deepseek-v4.1-flash', hardMaxChars: 20000 })
    expect(huge.bodyReserve).toBe(25096)
    expect(huge.requestMaxTokens).toBe(MAX_REQUEST_OUTPUT_TOKENS)
    expect(MAX_REQUEST_OUTPUT_TOKENS).toBe(8192)
  })

  it('边界：0/负数/NaN/Infinity 视为无正文保护线；1 字得到最小正预算', () => {
    for (const chars of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const budget = resolveRequestBudget({ model: 'gpt-4o', hardMaxChars: chars })
      expect(budget.bodyReserve).toBe(0)
      expect(budget.requestMaxTokens).toBe(PROTOCOL_RESERVE_TOKENS)
    }
    const minimal = resolveRequestBudget({ model: 'gpt-4o', hardMaxChars: 1 })
    expect(minimal.bodyReserve).toBe(98)
    expect(minimal.requestMaxTokens).toBe(98 + PROTOCOL_RESERVE_TOKENS)
  })
})

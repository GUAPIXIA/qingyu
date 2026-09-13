/**
 * 阶段8.1（主计划 W2）纯函数验收：门控解析、降档链、探测合并与预算三态。
 * 覆盖阶段 8 §七：门控可信/不可信/无门控三态、档位链、正文最小空间、
 * 用户硬上限、未知模型退化。
 */
import { describe, expect, it } from 'vitest'
import {
  GATE_PROBE_MAX_SAMPLES,
  LOW_GATE_TOKENS,
  clampGateBudgetForBody,
  levelToTokens,
  mergeGateProbe,
  nextLowerGateLevel,
  resolveReasoningGate,
  selectGateKnob,
  type GateProbe,
} from '../reasoningGate'
import {
  BODY_RESERVE_MULTIPLIER,
  BODY_RESERVE_OVERHEAD_TOKENS,
  MAX_REQUEST_OUTPUT_TOKENS,
  MIN_USABLE_BODY_TOKENS,
  PROTOCOL_RESERVE_TOKENS,
  getModelOutputProfile,
  resolveReasoningReserve,
  resolveRequestBudget,
} from '../modelOutputProfile'

const DEEPSEEK = 'deepseek/deepseek-v4.1-flash'

function probeOf(overrides: Partial<GateProbe> = {}): GateProbe {
  return { knob: 'thinking-disable', recentReasoningTokens: [], updatedAt: 1, ...overrides }
}

/** 正文保护线的公式复算（与 modelOutputProfile 派生值证明同一口径） */
function bodyReserveOf(visibleChars: number): number {
  return Math.ceil(visibleChars * BODY_RESERVE_MULTIPLIER) + BODY_RESERVE_OVERHEAD_TOKENS
}

describe('档位语义（levelToTokens / 降档链）', () => {
  it('off → 0；low → 档位值；standard/full 无可承诺值', () => {
    expect(levelToTokens('off', 'thinking-disable')).toBe(0)
    expect(levelToTokens('low', 'thinking-disable')).toBe(LOW_GATE_TOKENS)
    expect(levelToTokens('standard', 'thinking-disable')).toBeNull()
    expect(levelToTokens('full', 'thinking-disable')).toBeNull()
    // 无门控端点没有任何可承诺值（必须走保守余量）
    for (const level of ['off', 'low', 'standard', 'full'] as const) {
      expect(levelToTokens(level, 'none')).toBeNull()
      expect(levelToTokens(level, 'unknown')).toBeNull()
    }
  })

  it('降档链 full → standard → low → off → 终止', () => {
    expect(nextLowerGateLevel('full')).toBe('standard')
    expect(nextLowerGateLevel('standard')).toBe('low')
    expect(nextLowerGateLevel('low')).toBe('off')
    expect(nextLowerGateLevel('off')).toBeNull()
  })
})

describe('knob 选择（探测降级顺序）', () => {
  it('已知推理模型未探测时按档案顺序取第一个 knob', () => {
    const ds = getModelOutputProfile(DEEPSEEK)
    expect(selectGateKnob(ds, null, 'off')).toBe('thinking-disable')
    expect(selectGateKnob(getModelOutputProfile('claude-4-sonnet'), null, 'low')).toBe('thinking-budget')
    expect(selectGateKnob(getModelOutputProfile('gemini-2.5-pro'), null, 'off')).toBe('gemini-thinking-config')
    expect(selectGateKnob(getModelOutputProfile('o3-mini'), null, 'low')).toBe('reasoning-effort')
  })

  it('明确 400 拒绝过的 knob 被跳过，按顺序退到下一级', () => {
    const ds = getModelOutputProfile(DEEPSEEK)
    const rejectedDisable = probeOf({ knob: 'thinking-disable', knobAccepted: false })
    expect(selectGateKnob(ds, rejectedDisable, 'off')).toBe('reasoning-effort')
    const bothRejected = probeOf({ knob: 'reasoning-effort', knobAccepted: false })
    expect(selectGateKnob(ds, bothRejected, 'off')).toBe('thinking-disable')
    // 两个都在列表里被拒（分别探测过）时落到 none
    const allRejected = probeOf({ knob: 'reasoning-effort', knobAccepted: false })
    expect(selectGateKnob({ ...ds, gateKnobs: ['reasoning-effort'] }, allRejected, 'off')).toBe('none')
  })

  it('off 档且端点已确认静默忽略 disable → 落到 none（提前中止兜底）', () => {
    const ds = getModelOutputProfile(DEEPSEEK)
    const ignored = probeOf({ disableIgnored: true, knobAccepted: true })
    expect(selectGateKnob(ds, ignored, 'off')).toBe('none')
    // low 档不受 disableIgnored 影响（仍可下发档位参数）
    expect(selectGateKnob(ds, ignored, 'low')).toBe('thinking-disable')
  })

  it('R1/reasoner 与未知模型只有 none，不假装有门控', () => {
    expect(selectGateKnob(getModelOutputProfile('deepseek-reasoner'), probeOf(), 'off')).toBe('none')
    expect(selectGateKnob(getModelOutputProfile('未登记模型'), null, 'standard')).toBe('none')
  })
})

describe('resolveReasoningGate', () => {
  it('默认档位：主对话 standard，辅助路径 off，显式档位优先', () => {
    expect(resolveReasoningGate({ model: DEEPSEEK }).level).toBe('standard')
    expect(resolveReasoningGate({ model: DEEPSEEK, auxiliary: true }).level).toBe('off')
    expect(resolveReasoningGate({ model: DEEPSEEK, auxiliary: true, requestedLevel: 'full' }).level).toBe('full')
    // 会话熔断后的起步档（低于默认）
    expect(resolveReasoningGate({ model: DEEPSEEK, startLevel: 'low' }).level).toBe('low')
  })

  it('可信门控：探测明确接受 → enforced=true，gateTokens 即档位承诺值', () => {
    const accepted = probeOf({ knobAccepted: true })
    const off = resolveReasoningGate({ model: DEEPSEEK, enabled: true, auxiliary: true, probe: accepted })
    expect(off).toMatchObject({ level: 'off', knob: 'thinking-disable', enforced: true, gateTokens: 0, source: 'gate' })
    const low = resolveReasoningGate({ model: DEEPSEEK, enabled: true, startLevel: 'low', probe: accepted })
    expect(low).toMatchObject({ enforced: true, gateTokens: LOW_GATE_TOKENS, source: 'gate' })
  })

  it('不可信门控（未探测/未验证）：gateTokens = max(档位值, 档案保守余量)', () => {
    const unprobed = resolveReasoningGate({ model: DEEPSEEK, enabled: true, auxiliary: true })
    expect(unprobed.enforced).toBe(false)
    expect(unprobed.gateTokens).toBe(3072)
    expect(unprobed.source).toBe('conservative')

    // 已记录探测但未确认接受 disable（knobAccepted 缺省）：同样是保守余量
    const unverified = resolveReasoningGate({
      model: DEEPSEEK,
      enabled: true,
      auxiliary: true,
      probe: probeOf(),
    })
    expect(unverified.enforced).toBe(false)
    expect(unverified.gateTokens).toBe(3072)

    // 静默忽略 disable：off 档没有可执行 knob，退回保守余量
    const ignored = resolveReasoningGate({
      model: DEEPSEEK,
      enabled: true,
      auxiliary: true,
      probe: probeOf({ knobAccepted: true, disableIgnored: true }),
    })
    expect(ignored.knob).toBe('none')
    expect(ignored.enforced).toBe(false)
    expect(ignored.gateTokens).toBe(3072)
  })

  it('无门控模型：standard 档没有承诺值，退回档案/P90 余量', () => {
    const gate = resolveReasoningGate({ model: 'deepseek-reasoner', enabled: true, auxiliary: true })
    expect(gate.knob).toBe('none')
    expect(gate.enforced).toBe(false)
    expect(gate.gateTokens).toBe(2048)
    // P90 样本在场时按样本估计（W1 接线后生效）
    const withSamples = resolveReasoningGate({
      model: 'deepseek-reasoner',
      enabled: true,
      auxiliary: true,
      probe: probeOf({ recentReasoningTokens: [1000, 1200, 1500] }),
    })
    expect(withSamples.gateTokens).toBe(1800)
  })

  // 2026-09-13（W1 接线补充）：用量档案样本此前只经 probe 进入保守余量，
  // 渲染层的 withReasoningGate 既无 probe 也不传样本 → 不可信门控永远用静态档案值。
  it('用量档案样本直接参与保守余量估计，并与 probe 样本合并', () => {
    const fromUsage = resolveReasoningGate({
      model: DEEPSEEK,
      enabled: true,
      auxiliary: true,
      recentReasoningTokens: [3881, 3200, 3000],
    })
    expect(fromUsage.enforced).toBe(false)
    // P90(3881) × 1.2 = 4658 → 钳制到档案 maxReasoningReserve(4096)
    expect(fromUsage.gateTokens).toBe(4096)

    // probe 与档案样本合并后取整体 P90（合并样本的最大值主导）
    const merged = resolveReasoningGate({
      model: DEEPSEEK,
      enabled: true,
      auxiliary: true,
      probe: probeOf({ recentReasoningTokens: [500, 600, 700] }),
      recentReasoningTokens: [3881, 3200, 3000],
    })
    expect(merged.gateTokens).toBe(4096)

    // 档案样本较小时仍取档案/P90 的较大者，不被低样本拉低
    const small = resolveReasoningGate({
      model: DEEPSEEK,
      enabled: true,
      auxiliary: true,
      recentReasoningTokens: [100, 120, 150],
    })
    expect(small.gateTokens).toBe(PROTOCOL_RESERVE_TOKENS)
  })

  it('kill switch 关闭：退回现行余量路径（与 resolveReasoningReserve 同值）', () => {
    const profile = getModelOutputProfile(DEEPSEEK)
    const disabled = resolveReasoningGate({
      model: DEEPSEEK,
      enabled: false,
      auxiliary: true,
      probe: probeOf({ knobAccepted: true }),
    })
    expect(disabled.source).toBe('disabled')
    expect(disabled.enforced).toBe(false)
    expect(disabled.gateTokens).toBe(resolveReasoningReserve(profile, []))
    // 档位与 knob 仍如实解析（供观测与探测记录），只是不参与预算
    expect(disabled.level).toBe('off')
    expect(disabled.knob).toBe('thinking-disable')
  })

  it('未知模型退化：不崩溃、无可信门控、与档案默认预算一致', () => {
    const gate = resolveReasoningGate({ model: '某新聚合推理模型', enabled: true })
    expect(gate.knob).toBe('none')
    expect(gate.enforced).toBe(false)
    expect(gate.gateTokens).toBe(PROTOCOL_RESERVE_TOKENS)
  })
})

describe('探测记录合并（GateProbe）', () => {
  it('样本有界、非法值丢弃、unknown 不写成 0', () => {
    let probe: GateProbe | null = null
    for (let i = 0; i < GATE_PROBE_MAX_SAMPLES + 5; i += 1) {
      probe = mergeGateProbe(probe, { reasoningTokens: i + 1, updatedAt: i })
    }
    expect(probe!.recentReasoningTokens).toHaveLength(GATE_PROBE_MAX_SAMPLES)
    // 只保留最近 N 个
    expect(probe!.recentReasoningTokens.at(-1)).toBe(GATE_PROBE_MAX_SAMPLES + 5)

    const dirty = mergeGateProbe(probe, {
      reasoningTokens: Number.NaN,
      updatedAt: 99,
    })
    expect(dirty.recentReasoningTokens).toHaveLength(GATE_PROBE_MAX_SAMPLES)
    // 不传 reasoningTokens（unknown）时不产生样本，也不填 0
    expect(dirty.recentReasoningTokens.every((v) => v > 0)).toBe(true)
  })

  it('拒绝与静默忽略一经确认保持粘性，未被覆盖的字段沿用旧值', () => {
    const first = mergeGateProbe(null, { knob: 'thinking-disable', knobAccepted: false, updatedAt: 1 })
    const second = mergeGateProbe(first, { reasoningTokens: 500, updatedAt: 2 })
    expect(second.knobAccepted).toBe(false)
    expect(second.knob).toBe('thinking-disable')
    const ignored = mergeGateProbe(second, { disableIgnored: true, updatedAt: 3 })
    expect(ignored.disableIgnored).toBe(true)
    expect(ignored.knobAccepted).toBe(false)
    expect(ignored.updatedAt).toBe(3)
  })
})

describe('预算三态接线（resolveRequestBudget × 门控）', () => {
  const CHARS = 600
  const BODY = bodyReserveOf(CHARS)

  it('可信门控：requestMaxTokens = 正文预算 + 档位承诺值，正文空间确定非空', () => {
    const accepted = probeOf({ knobAccepted: true })
    const offGate = resolveReasoningGate({ model: DEEPSEEK, enabled: true, auxiliary: true, probe: accepted })
    const off = resolveRequestBudget({ model: DEEPSEEK, hardMaxChars: CHARS, reasoningGate: offGate })
    expect(off.bodyReserve).toBe(BODY)
    expect(off.reasoningReserve).toBe(0)
    expect(off.requestMaxTokens).toBe(BODY)
    expect(off.gate).toEqual({ level: 'off', knob: 'thinking-disable', enforced: true, source: 'gate' })

    const lowGate = resolveReasoningGate({ model: DEEPSEEK, enabled: true, startLevel: 'low', probe: accepted })
    const low = resolveRequestBudget({ model: DEEPSEEK, hardMaxChars: CHARS, reasoningGate: lowGate })
    expect(low.requestMaxTokens).toBe(BODY + LOW_GATE_TOKENS)
  })

  it('不可信门控：数值与现行余量路径一致（不放大、不缩小）', () => {
    const gate = resolveReasoningGate({ model: DEEPSEEK, enabled: true, auxiliary: true })
    const withGate = resolveRequestBudget({ model: DEEPSEEK, hardMaxChars: CHARS, reasoningGate: gate })
    const legacy = resolveRequestBudget({ model: DEEPSEEK, hardMaxChars: CHARS })
    expect(withGate.reasoningReserve).toBe(legacy.reasoningReserve)
    expect(withGate.requestMaxTokens).toBe(legacy.requestMaxTokens)
    expect(withGate.gate?.enforced).toBe(false)
  })

  it('kill switch 关闭：与不传门控逐字段一致', () => {
    const disabled = resolveReasoningGate({ model: DEEPSEEK, enabled: false, probe: probeOf({ knobAccepted: true }) })
    const withDisabledGate = resolveRequestBudget({ model: DEEPSEEK, hardMaxChars: CHARS, reasoningGate: disabled })
    const bare = resolveRequestBudget({ model: DEEPSEEK, hardMaxChars: CHARS })
    expect(withDisabledGate.reasoningReserve).toBe(bare.reasoningReserve)
    expect(withDisabledGate.requestMaxTokens).toBe(bare.requestMaxTokens)
    expect(withDisabledGate.minimumViableOutputTokens).toBe(bare.minimumViableOutputTokens)
    expect(withDisabledGate.bodyReserve).toBe(bare.bodyReserve)
  })

  it('无门控模型（knob none）：退回档案/P90 余量，正文不因此被挤掉', () => {
    const gate = resolveReasoningGate({
      model: 'deepseek-reasoner',
      enabled: true,
      probe: probeOf({ recentReasoningTokens: [2000, 3000] }),
    })
    const budget = resolveRequestBudget({ model: 'deepseek-reasoner', hardMaxChars: CHARS, reasoningGate: gate })
    expect(budget.reasoningReserve).toBe(Math.ceil(3000 * 1.2))
    expect(budget.requestMaxTokens).toBe(BODY + Math.ceil(3000 * 1.2))
    expect(budget.requestMaxTokens - budget.reasoningReserve).toBe(BODY)
  })

  it('用户硬上限仍生效，并按 gateTokens 计算最小可用空间', () => {
    const accepted = probeOf({ knobAccepted: true })
    const offGate = resolveReasoningGate({ model: DEEPSEEK, enabled: true, auxiliary: true, probe: accepted })
    // 可信 off：最小可用 = 0 + min(正文预算, 256)
    const tiny = resolveRequestBudget({
      model: DEEPSEEK,
      hardMaxChars: CHARS,
      reasoningGate: offGate,
      userHardCap: 200,
    })
    expect(tiny.minimumViableOutputTokens).toBe(MIN_USABLE_BODY_TOKENS)
    expect(tiny.riskNotice).toBe('user_cap_below_reasoning_reserve')
    expect(tiny.requestMaxTokens).toBe(200)

    const roomy = resolveRequestBudget({
      model: DEEPSEEK,
      hardMaxChars: CHARS,
      reasoningGate: offGate,
      userHardCap: 4096,
    })
    expect(roomy.riskNotice).toBeUndefined()
    expect(roomy.requestMaxTokens).toBe(BODY)
  })

  it('通用安全上限 8192 仍优先于门控承诺值', () => {
    const accepted = probeOf({ knobAccepted: true })
    const lowGate = resolveReasoningGate({
      model: DEEPSEEK,
      enabled: true,
      startLevel: 'low',
      probe: accepted,
    })
    const budget = resolveRequestBudget({ model: DEEPSEEK, hardMaxChars: 20000, reasoningGate: lowGate })
    expect(budget.requestMaxTokens).toBe(MAX_REQUEST_OUTPUT_TOKENS)
  })
})

describe('clampGateBudgetForBody（预算型 knob 的正文保护）', () => {
  it('不超过 requestMaxTokens − 正文最小空间', () => {
    expect(clampGateBudgetForBody(LOW_GATE_TOKENS, 1870)).toBe(LOW_GATE_TOKENS)
    expect(clampGateBudgetForBody(LOW_GATE_TOKENS, 1000)).toBe(1000 - MIN_USABLE_BODY_TOKENS)
    // 连最小正文空间都不够时不下发推理预算
    expect(clampGateBudgetForBody(LOW_GATE_TOKENS, 200)).toBe(0)
    expect(clampGateBudgetForBody(0, 4000)).toBe(0)
    expect(clampGateBudgetForBody(Number.NaN, 4000)).toBe(0)
    expect(clampGateBudgetForBody(LOW_GATE_TOKENS, Number.NaN)).toBe(0)
  })
})

describe('档案门控元数据不变量', () => {
  const MODELS = [
    'deepseek/deepseek-v4.1-flash',
    'deepseek-reasoner',
    'claude-4-sonnet',
    'gemini-2.5-pro',
    'o3-mini',
    'gpt-4o',
    '未知模型',
  ]

  it('每个档案都有非空 gateKnobs 且以 none 结尾，defaultGate 为合法档位', () => {
    for (const model of MODELS) {
      const profile = getModelOutputProfile(model)
      expect(profile.gateKnobs.length).toBeGreaterThan(0)
      expect(profile.gateKnobs.at(-1)).toBe('none')
      expect(['off', 'low', 'standard', 'full']).toContain(profile.defaultGate)
    }
  })
})

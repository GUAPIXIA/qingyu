/**
 * 推理门控域（阶段8 §4.1/§4.2/§4.5）——纯函数与类型，无 IO。
 *
 * 职责：
 * - 把产品档位（off/low/standard/full）解析为端点可下发的 knob（探测降级后）；
 * - 给出预算用的推理预留 `gateTokens`：可信门控 = 档位承诺值，不可信/无门控 = 保守余量；
 * - 探测记录 GateProbe 的读取语义与合并（样本有界、unknown 不填 0）；
 * - 降档链 standard → low → off（空正文恢复至多一次，熔断后从更低档起步）。
 *
 * 与 modelOutputProfile 的分工：本模块只解析"推理约束"，输出预算仍由
 * `resolveRequestBudget` 唯一计算（它消费本模块结果，不做二次推导）。
 */

import {
  MIN_USABLE_BODY_TOKENS,
  getModelOutputProfile,
  resolveReasoningReserve,
  type ModelOutputProfile,
} from './modelOutputProfile'

/** 本轮希望供应商执行的推理档位（产品语义，非各家参数名） */
export type ReasoningGateLevel = 'off' | 'low' | 'standard' | 'full'

/** 端点实际可用的门控方式；探测前为 unknown */
export type ReasoningGateKnob =
  /** DeepSeek: thinking:{type:'disabled'} */
  | 'thinking-disable'
  /** OpenAI o系/GPT-5/聚合端: reasoning_effort */
  | 'reasoning-effort'
  /** Claude thinking.budget_tokens；Qwen 兼容 thinking_budget */
  | 'thinking-budget'
  /** Gemini: generationConfig.thinkingConfig */
  | 'gemini-thinking-config'
  /** 无服务端门控：只能本地余量 + 提前中止 */
  | 'none'

/** 某 (provider+model) 的探测结果（持久化在设置存储；本模块只做纯合并） */
export interface GateProbe {
  knob: ReasoningGateKnob | 'unknown'
  /** 端点是否接受该 knob 参数（明确 400 拒绝 → false，之后不再尝试） */
  knobAccepted?: boolean
  /** 声称接受但流中仍出现 reasoning_content → off 档被静默忽略 */
  disableIgnored?: boolean
  /** 是否上报 usage.reasoning_tokens */
  reportsReasoningUsage?: boolean
  /** 近期 reasoning token 样本（有界；unknown 不入样本，绝不填 0） */
  recentReasoningTokens: number[]
  updatedAt: number
}

/** low 档的推理上限（阶段8 §4.1：建议 800–1200） */
export const LOW_GATE_TOKENS = 1024

/** 探测样本上限：每键最多保留的近期样本数（主计划 §5.3 第 4 条） */
export const GATE_PROBE_MAX_SAMPLES = 32

/** 门控取值来源：可信门控 / 保守余量 / kill switch 关闭 */
export type ReasoningGateSource = 'gate' | 'conservative' | 'disabled'

export interface ResolvedReasoningGate {
  level: ReasoningGateLevel
  knob: ReasoningGateKnob | 'unknown'
  /** gateTokens 是否由供应商强制执行（可信门控） */
  enforced: boolean
  /** 本轮推理预留（预算公式的推理项） */
  gateTokens: number
  /** 取值来源，供观测与诊断 */
  source: ReasoningGateSource
}

/**
 * 适配器消费的门控指令（阶段8 §4.3）：由主进程在发请求前解析后写入 ChatParams。
 * 适配器只做"档位+knob → 请求体字段"的机械映射，不自行决定产品策略。
 */
export interface ReasoningGateDirective {
  level: ReasoningGateLevel
  knob: ReasoningGateKnob | 'unknown'
  /**
   * 门控承诺值（预算型 knob 用：Claude budget_tokens / Qwen thinking_budget）。
   * 可信门控为档位承诺值；不可信/无门控为 max(档位值, 保守余量)。
   * 适配器下发前必须用 clampGateBudgetForBody 保证不吞正文最小空间。
   */
  tokens?: number
}

/**
 * 适配器透出的探测结论（阶段8 §4.3）：主进程据此合并 GateProbe。
 * 只有明确 400 字段拒绝才写 knobAccepted=false；网络错误/用户取消不写任何状态。
 */
export interface GateProbeSignal {
  knob: ReasoningGateKnob | 'unknown'
  /** 明确 400 字段拒绝 → false */
  knobAccepted?: boolean
  /** off 档请求仍出现推理 delta → 该端点静默忽略 disable */
  disableIgnored?: boolean
  /** 是否上报 usage.reasoning_tokens */
  reportsReasoningUsage?: boolean
}

export interface ReasoningGateResolveInput {
  model: string
  /**
   * 临时 kill switch（`Settings.reasoningGateEnabled`，默认关闭）。
   * false 时退回现行 `resolveReasoningReserve`（档案/P90）路径，探测记录照常保留。
   */
  enabled?: boolean
  /** true = 辅助/后台路径（续写、补尾、方向、记忆、标题），默认 off（阶段8 §4.1） */
  auxiliary?: boolean
  /** 会话/用户显式档位（预留产品入口，本期无 UI；优先于 startLevel 与档案默认） */
  requestedLevel?: ReasoningGateLevel
  /** 会话熔断后从更低档起步（阶段8 §4.5） */
  startLevel?: ReasoningGateLevel
  /** 该 (provider+model) 的探测记录；缺省视为未探测（不可信） */
  probe?: GateProbe | null
  /**
   * W1/§5.4：该端点的近期推理 token 样本（用量档案回读）。
   * 与 `probe.recentReasoningTokens` 合并后参与**保守余量**估计（P90×1.2）；
   * 可信门控（承诺值可执行）不受样本影响。
   */
  recentReasoningTokens?: number[]
}

/**
 * 档位 → 可承诺的推理 token 上限。
 * 返回 null 表示该档位没有可承诺值（standard/full 不干预端点默认；无门控端点无可执行约束），
 * 预算必须退回档案/P90 保守余量。
 */
export function levelToTokens(
  level: ReasoningGateLevel,
  knob: ReasoningGateKnob | 'unknown',
): number | null {
  if (knob === 'none' || knob === 'unknown') return null
  switch (level) {
    case 'off':
      return 0
    case 'low':
      return LOW_GATE_TOKENS
    case 'standard':
    case 'full':
    default:
      return null
  }
}

/** 降档链：full → standard → low → off → null（off 已是最后一级） */
export function nextLowerGateLevel(level: ReasoningGateLevel): ReasoningGateLevel | null {
  switch (level) {
    case 'full':
      return 'standard'
    case 'standard':
      return 'low'
    case 'low':
      return 'off'
    default:
      return null
  }
}

/**
 * 按档案顺序选择本轮 knob：
 * - 明确 400 拒绝过的 knob（probe.knob 命中且 knobAccepted === false）跳过；
 * - off 档且该端点已确认静默忽略 disable → 剩余 knob 也无从执行 off，落到 none（提前中止兜底）；
 * - 列表以 'none' 结尾，保证一定有返回值。
 */
export function selectGateKnob(
  profile: ModelOutputProfile,
  probe: GateProbe | null | undefined,
  level: ReasoningGateLevel,
): ReasoningGateKnob | 'unknown' {
  const knobs = profile.gateKnobs.length > 0 ? profile.gateKnobs : (['none'] as ReasoningGateKnob[])
  for (const knob of knobs) {
    if (knob === 'none') return 'none'
    if (probe?.knobAccepted === false && probe.knob === knob) continue
    if (level === 'off' && probe?.disableIgnored === true) continue
    return knob
  }
  return 'none'
}

/**
 * 解析本轮门控：档位 → knob → gateTokens。
 * 可信（供应商执行）判定要求探测明确接受过该 knob；未探测一律按不可信处理，
 * 预算退回 `max(档位值, 保守余量)`，与阶段8 §4.2 的公式一致。
 */
export function resolveReasoningGate(input: ReasoningGateResolveInput): ResolvedReasoningGate {
  const profile = getModelOutputProfile(input.model)
  // W1/§5.4：探测样本与用量档案样本合并估计保守余量（两者都是"该端点近期推理量"的证据）
  const samples = [
    ...(input.probe?.recentReasoningTokens ?? []),
    ...(input.recentReasoningTokens ?? []),
  ]
  const conservative = resolveReasoningReserve(profile, samples)
  const level = input.requestedLevel
    ?? input.startLevel
    ?? (input.auxiliary === true ? 'off' : profile.defaultGate)
  const knob = selectGateKnob(profile, input.probe, level)

  if (input.enabled === false) {
    return { level, knob, enforced: false, gateTokens: conservative, source: 'disabled' }
  }

  const levelTokens = levelToTokens(level, knob)
  const enforced = levelTokens != null && input.probe?.knobAccepted === true
  return {
    level,
    knob,
    enforced,
    gateTokens: enforced ? levelTokens : Math.max(levelTokens ?? 0, conservative),
    source: enforced ? 'gate' : 'conservative',
  }
}

/**
 * 默认档位策略（主对话）：deepseek-v4 系沿用既有"主对话关闭推理"的产品意图（off），
 * 其余模型按端点默认（standard）。辅助/后台任务由调用方传 auxiliary。
 * kill switch 关闭时返回 undefined（不介入，保持旧路径）。
 */
export function resolveDefaultGateLevel(input: {
  model: string
  enabled: boolean
  auxiliary?: boolean
}): ReasoningGateLevel | undefined {
  if (!input.enabled) return undefined
  if (input.auxiliary) return 'off'
  if (!input.model) return undefined
  return input.model.toLowerCase().includes('deepseek-v4') ? 'off' : 'standard'
}

export interface GateProbeUpdate {
  knob?: ReasoningGateKnob | 'unknown' | null
  knobAccepted?: boolean
  disableIgnored?: boolean
  reportsReasoningUsage?: boolean
  /** 本轮观测到的 reasoning token；取不到时不要传（unknown 不入样本） */
  reasoningTokens?: number
  updatedAt: number
}

/**
 * 合并一次探测更新：样本有界（GATE_PROBE_MAX_SAMPLES）、非法值丢弃、
 * 未提供的字段保持原值（false 一经确认不会被 undefined 覆盖）。
 */
export function mergeGateProbe(
  current: GateProbe | null | undefined,
  update: GateProbeUpdate,
): GateProbe {
  const base: GateProbe = current ?? { knob: 'unknown', recentReasoningTokens: [], updatedAt: 0 }
  const samples = [...base.recentReasoningTokens]
  if (
    typeof update.reasoningTokens === 'number'
    && Number.isFinite(update.reasoningTokens)
    && update.reasoningTokens >= 0
  ) {
    samples.push(update.reasoningTokens)
  }
  return {
    knob: update.knob ?? base.knob,
    knobAccepted: update.knobAccepted ?? base.knobAccepted,
    disableIgnored: update.disableIgnored ?? base.disableIgnored,
    reportsReasoningUsage: update.reportsReasoningUsage ?? base.reportsReasoningUsage,
    recentReasoningTokens: samples.slice(-GATE_PROBE_MAX_SAMPLES),
    updatedAt: update.updatedAt,
  }
}

/**
 * 预算型 knob（Claude budget_tokens、Qwen thinking_budget）的下发值：
 * 不得超过 `requestMaxTokens − 正文最小空间`，否则推理预算会吞掉正文保证（阶段8 §4.3）。
 */
export function clampGateBudgetForBody(gateTokens: number, requestMaxTokens: number): number {
  if (!Number.isFinite(gateTokens) || gateTokens <= 0) return 0
  if (!Number.isFinite(requestMaxTokens)) return 0
  const headroom = Math.floor(requestMaxTokens) - MIN_USABLE_BODY_TOKENS
  if (headroom <= 0) return 0
  return Math.min(Math.floor(gateTokens), headroom)
}

/**
 * 模型输出能力档案与请求预算（方案「对话输出弹性约束与稳定收尾」§4.4）。
 *
 * 正文预算与推理余量分别估算，再合并为请求上限：
 * - bodyReserve = ceil(正文硬保护线估算 token × 1.25) + 96
 * - reasoningReserve 按模型的推理通道类型解析
 * - requestMaxTokens = min(模型输出上限, 通用安全上限, bodyReserve + reasoningReserve, 用户硬上限)
 *
 * 不再对特定模型固定放大到 8192：篇幅由 ResponsePolicy（字符）表达，
 * 推理模型通过能力档案获得独立余量，用户在高级设置中的硬上限始终生效。
 */

export type ReasoningReserveMode =
  /** 无推理或可真正关闭推理：只保留协议余量 */
  | 'none'
  /** 推理预算独立（不占正文 max_tokens）：正文预算不混入推理 */
  | 'separate'
  /** 推理与正文共享，且有近期 reasoning token 统计：取 P90 × 1.2 */
  | 'shared-known'
  /** 推理与正文共享，无统计：使用档案默认余量 */
  | 'shared-unknown'

export interface ModelOutputProfile {
  /** 模型侧最大输出 token（请求上限的模型硬顶） */
  outputLimit: number
  reasoningMode: ReasoningReserveMode
  /** 无近期统计时的默认推理余量（仅 shared-* 模式使用） */
  defaultReasoningReserve: number
  /** 推理余量档位上限（触顶反馈逐档上调时不超过该值） */
  maxReasoningReserve: number
}

/** 协议余量：可关闭/独立推理的模型仅保留的请求开销余量（方案 §4.4 的 128–256 区间） */
export const PROTOCOL_RESERVE_TOKENS = 192
/** 通用请求输出安全上限（兜底；取代旧 DeepSeek V4 固定 8192 特判） */
export const MAX_REQUEST_OUTPUT_TOKENS = 8192
/** 正文预算安全系数与固定协议开销（方案 §4.4 公式） */
export const BODY_RESERVE_MULTIPLIER = 1.25
export const BODY_RESERVE_OVERHEAD_TOKENS = 96
/**
 * 推理共享模型即使获得完整 reasoning 余量，也必须至少留下这部分正文空间。
 * 256 token 足以承载一个短而完整的中文互动回合，同时不会把“展开”篇幅变成硬要求。
 */
export const MIN_USABLE_BODY_TOKENS = 256

const PROTOCOL_ONLY_PROFILE: ModelOutputProfile = {
  outputLimit: 8192,
  reasoningMode: 'none',
  defaultReasoningReserve: 0,
  maxReasoningReserve: 0,
}

const DEEPSEEK_V4_PROFILE: ModelOutputProfile = {
  // 部分聚合端会忽略 thinking: disabled，推理与正文共享 max_tokens；
  // 实测推理可消耗 3000+ token，无统计时默认 3072，触顶反馈最高 4096。
  outputLimit: 8192,
  reasoningMode: 'shared-unknown',
  defaultReasoningReserve: 3072,
  maxReasoningReserve: 4096,
}

const DEEPSEEK_REASONER_PROFILE: ModelOutputProfile = {
  outputLimit: 8192,
  reasoningMode: 'shared-unknown',
  defaultReasoningReserve: 2048,
  maxReasoningReserve: 4096,
}

// Claude 扩展思考（3.7/4，非 haiku）的 budget_tokens 从 max_tokens 内划扣（适配器现行实现）
const CLAUDE_THINKING_PROFILE: ModelOutputProfile = {
  outputLimit: 8192,
  reasoningMode: 'shared-unknown',
  defaultReasoningReserve: 2048,
  maxReasoningReserve: 4096,
}

// Gemini 2.5/3 动态思考在部分网关下挤占 maxOutputTokens
const GEMINI_THINKING_PROFILE: ModelOutputProfile = {
  outputLimit: 8192,
  reasoningMode: 'shared-unknown',
  defaultReasoningReserve: 1024,
  maxReasoningReserve: 2048,
}

// OpenAI o 系列与 GPT-5 的 max_completion_tokens 包含推理 token
const OPENAI_REASONING_PROFILE: ModelOutputProfile = {
  outputLimit: 8192,
  reasoningMode: 'shared-unknown',
  defaultReasoningReserve: 2048,
  maxReasoningReserve: 4096,
}

/** 档案匹配规则：match 为模型名小写子串，先命中先生效 */
const MODEL_PROFILE_RULES: Array<{ match: string[]; profile: ModelOutputProfile }> = [
  { match: ['deepseek-v4'], profile: DEEPSEEK_V4_PROFILE },
  { match: ['deepseek-reasoner', 'deepseek-r1'], profile: DEEPSEEK_REASONER_PROFILE },
  // haiku 无扩展思考，需排在 claude-4 之前
  { match: ['haiku'], profile: PROTOCOL_ONLY_PROFILE },
  { match: ['claude-3-7', 'claude-3.7', 'claude-4'], profile: CLAUDE_THINKING_PROFILE },
  { match: ['gemini-2.5', 'gemini-3'], profile: GEMINI_THINKING_PROFILE },
  { match: ['o1', 'o3', 'o4', 'gpt-5'], profile: OPENAI_REASONING_PROFILE },
]

/** 未知模型默认档案：无推理余量假设，请求预算由正文硬保护线驱动 */
export const DEFAULT_OUTPUT_PROFILE: ModelOutputProfile = PROTOCOL_ONLY_PROFILE

export function getModelOutputProfile(model: string): ModelOutputProfile {
  const lower = (model || '').toLowerCase()
  if (!lower) return DEFAULT_OUTPUT_PROFILE
  for (const rule of MODEL_PROFILE_RULES) {
    if (rule.match.some((token) => lower.includes(token))) return rule.profile
  }
  return DEFAULT_OUTPUT_PROFILE
}

/** 最近 reasoning token 样本的 P90（样本不足 10 个时取最大值，方向偏保守） */
export function percentile90(values: number[]): number {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  if (sorted.length < 10) return sorted[sorted.length - 1]
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)
  return sorted[idx]
}

/**
 * 解析推理余量：
 * - none / separate：协议余量（正文与推理互不挤占或推理可关闭）
 * - shared-*：有近期样本时取 P90 × 1.2（钳制在 [协议余量, maxReasoningReserve]），
 *   无样本回退档案默认余量（shared-known / shared-unknown 仅描述该模型的数据可得性）
 */
export function resolveReasoningReserve(
  profile: ModelOutputProfile,
  recentReasoningTokens?: number[],
): number {
  switch (profile.reasoningMode) {
    case 'none':
    case 'separate':
      return PROTOCOL_RESERVE_TOKENS
    case 'shared-known':
    case 'shared-unknown':
    default: {
      const samples = (recentReasoningTokens ?? []).filter((v) => Number.isFinite(v) && v >= 0)
      if (samples.length === 0) return profile.defaultReasoningReserve
      const estimate = Math.ceil(percentile90(samples) * 1.2)
      return Math.min(
        profile.maxReasoningReserve,
        Math.max(PROTOCOL_RESERVE_TOKENS, estimate),
      )
    }
  }
}

/**
 * 可见字符 → 正文 token 的保守估算。
 * 角色扮演正文以中文为主（约 1 token/字），按 1:1 向上取整；
 * 英文为主的正文会被高估，多出的余量由请求侧自然消化（上限只是天花板，不预消费）。
 */
export function estimateTokensForVisibleChars(visibleChars: number, _model?: string): number {
  if (!Number.isFinite(visibleChars) || visibleChars <= 0) return 0
  return Math.ceil(visibleChars)
}

export interface RequestBudgetInput {
  model: string
  /** 本轮篇幅策略的硬保护线（可见字符），来自 ResponsePolicy.hardMaxChars */
  hardMaxChars: number
  /** 用户在高级设置中明确指定的模型输出硬上限（Preset.maxTokens；空/0 = 未指定） */
  userHardCap?: number | null
  /** 该模型近期请求的 reasoning token 样本（shared-known 模式取 P90×1.2） */
  recentReasoningTokens?: number[]
}

export interface RequestBudget {
  model: string
  profile: ModelOutputProfile
  /** 正文预算（含安全系数与协议开销） */
  bodyReserve: number
  /** 推理余量 */
  reasoningReserve: number
  /** 避免“推理吃满、正文为零”所需的最低可用输出预算 */
  minimumViableOutputTokens: number
  /** 最终请求 max_tokens：上下文预留与实际请求必须共用该值 */
  requestMaxTokens: number
  /** 用户硬上限不足以同时容纳推理余量和最小正文时置位（不静默放大） */
  riskNotice?: 'user_cap_below_reasoning_reserve'
}

/** 0、空值和非法值都表示“自动”，正数才是用户明确的严格硬上限。 */
export function resolveUserHardCap(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null
}

/**
 * 面向界面的可操作风险说明；旧版跨端数据或测试替身缺少明细时安全降级。
 */
export function formatRequestBudgetRisk(budget?: RequestBudget | null): string | null {
  if (!budget) return null
  if (budget.riskNotice !== 'user_cap_below_reasoning_reserve') return null
  return `当前模型输出硬上限为 ${budget.requestMaxTokens} Token，低于该推理模型稳定输出正文所需的约 ${budget.minimumViableOutputTokens} Token。请提高硬上限，或设为 0 使用自动预算。`
}

/**
 * 计算本轮请求输出预算。
 * 上下文构建的输出预留与实际请求的 max_tokens 必须使用同一个返回值，
 * 禁止两处分别推导（方案阶段 1 验收项）。
 */
export function resolveRequestBudget(input: RequestBudgetInput): RequestBudget {
  const profile = getModelOutputProfile(input.model)
  const hardMaxChars = Number.isFinite(input.hardMaxChars) && input.hardMaxChars > 0
    ? input.hardMaxChars
    : 0
  const bodyTokens = estimateTokensForVisibleChars(hardMaxChars, input.model)
  const bodyReserve = hardMaxChars > 0
    ? Math.ceil(bodyTokens * BODY_RESERVE_MULTIPLIER) + BODY_RESERVE_OVERHEAD_TOKENS
    : 0
  const reasoningReserve = resolveReasoningReserve(profile, input.recentReasoningTokens)
  const needed = bodyReserve + reasoningReserve
  const minimumViableOutputTokens = reasoningReserve + Math.min(bodyReserve, MIN_USABLE_BODY_TOKENS)

  const cap = resolveUserHardCap(input.userHardCap)

  let requestMaxTokens = Math.min(profile.outputLimit, MAX_REQUEST_OUTPUT_TOKENS, needed)
  let riskNotice: RequestBudget['riskNotice']
  if (cap != null) {
    if (cap < minimumViableOutputTokens) riskNotice = 'user_cap_below_reasoning_reserve'
    requestMaxTokens = Math.min(requestMaxTokens, cap)
  }

  return {
    model: input.model,
    profile,
    bodyReserve,
    reasoningReserve,
    minimumViableOutputTokens,
    requestMaxTokens,
    riskNotice,
  }
}

/**
 * 阶段8（主计划 W4 §4.5）：推理挤占的空正文降档恢复判定与预算重算。
 *
 * 触发条件（正文零损失才允许恢复）：
 * - 结构化终局 `reasoning_gate_exceeded`；或
 * - `length` + 可见正文 < 20 字符 + 推理占 completion ≥ 0.9；或
 * - 无 usage 时 `length` + 正文为空。
 *
 * 不触发：已有可用正文的 length（走既有稳定边界收束）、用户停止、transport/content_filter、
 * 已恢复过一次、当前档位已是最后一级。
 */

import { countVisibleCharacters } from '../../shared/textMetrics'
import { nextLowerGateLevel, resolveReasoningGate, type ReasoningGateLevel } from '../../shared/reasoningGate'
import { resolveRequestBudget, type ModelProfileUserOverride, type RequestBudget } from '../../shared/modelOutputProfile'
import { stripAllThinking } from '../../shared/thoughtMarkup'
import type { AIFinishReason, GenerationTerminationCause } from '../../shared/types'

/** 允许整轮恢复的正文上限（可见字符）：达到即有内容损失，必须走收尾器而非重生成 */
export const GATE_RECOVERY_MAX_BODY_CHARS = 20

export interface GateRecoveryDecisionInput {
  terminationCause?: GenerationTerminationCause
  finishReason: AIFinishReason
  rawText: string
  usage?: { completionTokens?: number; reasoningTokens?: number }
  /** 本轮档位；未使用门控（kill switch 关闭）时为 undefined => 不恢复 */
  currentLevel?: ReasoningGateLevel
  /** 同一逻辑请求是否已恢复过一次 */
  recoveryUsed: boolean
}

/** 返回下一档位；null = 不恢复（保持现状交给统一收尾/错误路径） */
export function nextRecoveryLevel(input: GateRecoveryDecisionInput): ReasoningGateLevel | null {
  if (input.recoveryUsed || !input.currentLevel) return null
  const next = nextLowerGateLevel(input.currentLevel)
  if (!next) return null

  const bodyChars = countVisibleCharacters(stripAllThinking(input.rawText ?? ''))
  if (bodyChars >= GATE_RECOVERY_MAX_BODY_CHARS) return null

  if (input.terminationCause === 'reasoning_gate_exceeded') return next
  if (input.finishReason !== 'length') return null

  const completion = input.usage?.completionTokens
  const reasoning = input.usage?.reasoningTokens
  if (typeof completion === 'number' && typeof reasoning === 'number') {
    return completion > 0 && reasoning >= completion * 0.9 ? next : null
  }
  // 无 usage：只有正文完全为空才按推理挤占处理（无法定因时宁可不动）
  return bodyChars === 0 ? next : null
}

/** 降档重试的预算重算：复用同一上下文与样本，只按新档位取 gateTokens */
export function resolveGateRecoveryBudget(input: {
  model: string
  hardMaxChars: number
  userHardCap?: number | null
  recentReasoningTokens?: number[]
  profileOverride?: ModelProfileUserOverride
  level: ReasoningGateLevel
}): RequestBudget {
  const gate = resolveReasoningGate({ model: input.model, requestedLevel: input.level, enabled: true })
  return resolveRequestBudget({
    model: input.model,
    hardMaxChars: input.hardMaxChars,
    userHardCap: input.userHardCap,
    profileOverride: input.profileOverride,
    ...(input.recentReasoningTokens?.length ? { recentReasoningTokens: input.recentReasoningTokens } : {}),
    reasoningGate: gate,
  })
}

// ===================== 零输出一次恢复（G1 取证后收口） =====================

/**
 * G1 实机取证结论（[G1 报告](../../docs/报告/PC端动态上下文G1灰度取证实机评测报告-2026-09-13.md)）：
 * 1. 主进程的"零输出"（适配器零输出防御抛错）此前只以错误文本下发，渲染层一律按
 *    `transport_error` 收口 → 没有恢复机会，用户直接看到错误；
 * 2. `off` 已是降档链末级（`nextLowerGateLevel('off') === null`），即使识别出推理挤占也无档可降；
 * 3. 对照样本显示同档重发**有机会**产出正文（同一夹具首次 length+0 正文、复跑拿到正文）。
 *
 * 因此补一条与降档恢复**共用同一 attempt 位**的零输出恢复：正文为空时最多再发一次，
 * 有更低档位则降档，否则同档重试。约束：
 * - 只在正文完全为空时触发（有正文绝不整条重生成，§4.3）；
 * - 用户停止 / 审核拦截 / 传输失败 / 超时 不触发（各有既定处理）；
 * - 与降档恢复共享 `recoveryUsed`，一轮最多两次模型调用；
 * - 不按实际推理消耗扩大输出（§6.1 禁止项）。
 */
export interface EmptyOutputRecoveryInput {
  /** 主进程 `classifyFailureOutcome` 的分类（渲染层经 ai:error.errorKind 拿到） */
  errorKind?: string
  /** 本轮累计正文（含未落盘的流式片段）；非空即不恢复 */
  rawText: string
  /** 本轮档位；未使用门控时为 undefined（同档重试，不带门控指令） */
  currentLevel?: ReasoningGateLevel
  /** 同一逻辑请求是否已恢复过一次 */
  recoveryUsed: boolean
}

export interface EmptyOutputRecoveryDecision {
  /** 重试要用的档位；undefined = 沿用原档（未使用门控） */
  level?: ReasoningGateLevel
  /** 是否属于降档（写入观测 downgradeRetry；同档重试不写，避免误解为降档） */
  downgrade: boolean
}

export function resolveEmptyOutputRecovery(
  input: EmptyOutputRecoveryInput,
): EmptyOutputRecoveryDecision | null {
  if (input.recoveryUsed) return null
  // 只处理"模型确实没给正文"的两类结构化失败；其余分类保持既有收口
  if (input.errorKind !== 'empty_output' && input.errorKind !== 'reasoning_budget_exhausted') return null
  const bodyChars = countVisibleCharacters(stripAllThinking(input.rawText ?? ''))
  if (bodyChars > 0) return null
  const degraded = input.errorKind === 'reasoning_budget_exhausted' && input.currentLevel
    ? nextLowerGateLevel(input.currentLevel)
    : null
  if (degraded) return { level: degraded, downgrade: true }
  return { downgrade: false, ...(input.currentLevel ? { level: input.currentLevel } : {}) }
}

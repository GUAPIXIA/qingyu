import type { AICompletion, ChatParams } from '../../../shared/types'
import type { GateProbeSignal, ReasoningGateKnob } from '../../../shared/reasoningGate'
import { MIN_USABLE_BODY_TOKENS } from '../../../shared/modelOutputProfile'
export { createVendorThinkingStreamFilter, stripVendorThinking } from '../../../shared/thoughtMarkup'

/** 默认请求超时时间（毫秒）- 5 分钟 */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/** 默认重试次数 */
export const DEFAULT_RETRY_COUNT = 1

/** 可重试的 HTTP 状态码 */
export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

/** 预编译的可重试状态码正则（避免每次调用时重新创建） */
const RETRYABLE_REGEXES = [...RETRYABLE_STATUS].map(
  (code) => new RegExp(`(^|[^0-9])${code}([^0-9]|$)`)
)

export interface AIAdapter {
  /**
   * 阶段3契约：返回结构化完成结果（正文 + finishReason + usage）。
   * length 是完成状态不再抛错；content_filter / 无正文 / 协议错误仍抛错。
   * 网络中断的正文保留由 chatWithRetry 统一降级处理。
   */
  chat(
    params: ChatParams,
    onChunk: (text: string) => void,
    signal: AbortSignal,
    onUsage?: (usage: TokenUsageInfo) => void,
  ): Promise<AICompletion>
  listModels(baseUrl: string, apiKey: string): Promise<string[]>
  testConnection(baseUrl: string, apiKey: string): Promise<boolean>
}

/** Token 用量信息 */
export interface TokenUsageInfo {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 推理 token 计数；上游未提供时缺省（观测层记 unknown，不填 0） */
  reasoningTokens?: number
}

/** 推理 token 吃满输出额度且没有留下正文空间时给用户的可操作提示。 */
export const REASONING_BUDGET_EXHAUSTED_MESSAGE =
  '推理已占满本次输出预算，未留下正文空间。自动预算会根据实际用量调整；请重试。若持续发生，请检查当前端点是否支持关闭推理。'

/**
 * OpenAI 兼容接口的 completion_tokens 通常包含 reasoning_tokens。
 * 只在 length + 实际用量接近请求上限 + 推理占比极高时归因，
 * 避免把审核、上游空包或普通长度截断误报成推理挤占。
 */
export function isReasoningBudgetExhausted(input: {
  finishReason?: string | null
  maxTokens: number
  completionTokens?: number
  reasoningTokens?: number
}): boolean {
  const { finishReason, maxTokens, completionTokens, reasoningTokens } = input
  if (finishReason !== 'length' || maxTokens <= 0) return false
  if (completionTokens === undefined || reasoningTokens === undefined || completionTokens <= 0) return false
  return completionTokens >= maxTokens * 0.95 && reasoningTokens >= completionTokens * 0.95
}

// ===================== 阶段8：门控字段级降级表 =====================

/** 请求体里实际下发的门控字段（降级表条目） */
export interface GateFieldProbe {
  /** 字段路径（支持嵌套，如 ['generationConfig', 'thinkingConfig']） */
  path: string[]
  knob: ReasoningGateKnob
  /**
   * 400 错误文本是否明确指向该字段被拒。
   * 只做字段名/参数名的明确匹配，避免把其他 400（鉴权、模型不存在）误判为参数不支持。
   */
  isRejected: (errText: string) => boolean
}

/**
 * 字段级降级判定（阶段8 §4.3）：只有 400 且错误文本明确指向某个已下发字段时才返回它。
 * 网络错误、5xx、429、用户取消一律返回 null —— 不污染 GateProbe。
 */
export function matchRejectedGateField(input: {
  status: number
  errText: string
  probes: readonly GateFieldProbe[]
}): GateFieldProbe | null {
  if (input.status !== 400) return null
  for (const probe of input.probes) {
    if (probe.isRejected(input.errText)) return probe
  }
  return null
}

/** 按路径删除请求体字段（降级重发用；路径不存在时安全返回） */
export function deleteGateField(body: Record<string, unknown>, path: readonly string[]): void {
  if (path.length === 0) return
  let cursor: Record<string, unknown> = body
  for (let i = 0; i < path.length - 1; i += 1) {
    const next = cursor[path[i]]
    if (!next || typeof next !== 'object') return
    cursor = next as Record<string, unknown>
  }
  delete cursor[path[path.length - 1]]
}

/**
 * 把探测结论挂到抛出的错误上：失败终局（空正文 / 重发仍失败）同样要保留
 * "明确 400 拒绝 / 静默忽略 disable" 事实，供主进程合并 GateProbe。
 */
export function attachGateProbe<T extends Error>(err: T, signal?: GateProbeSignal): T {
  if (signal) (err as T & { gateProbe?: GateProbeSignal }).gateProbe = signal
  return err
}

// ===================== 阶段8：推理越线提前中止（§4.4） =====================

/**
 * 推理 token 估算（只用于"是否越线"，不参与预算计算）：
 * CJK（含假名/谚文）按 1 字符/token，其余按约 3 字符/token。
 * 早期实现统一按 /3 估算，对中文推理低估约 3 倍，会让提前中止在该触发时漏触发
 * （2026-09-13 聚合端实机复现：中文推理吃满预算、正文为空但未中止）。
 */
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g

export function estimateReasoningTokens(reasoningText: string): number {
  if (!reasoningText) return 0
  const cjk = (reasoningText.match(CJK_PATTERN) ?? []).length
  const rest = reasoningText.length - cjk
  return cjk + Math.ceil(rest / 3)
}

export interface ReasoningRunawayGuard {
  /** 累积被过滤掉的供应商推理文本（按 CJK 感知口径折算 token） */
  addReasoning(text: string): void
  /** 累积正文可见字符数（正文一旦出现即永久解除中止资格） */
  addBody(chars: number): void
  /** 标记已完成（收到 finishReason 后不再中止） */
  markFinished(): void
  /** 是否应提前中止：正文为空、未结束、推理已越过观测线 */
  shouldAbort(): boolean
  /** 本轮是否真的中止过（供适配器返回结构化终局） */
  readonly aborted: boolean
  markAborted(): void
  /**
   * 方案 A：流中发现 `disableIgnored` 后立刻停用守卫（本轮剩余推理不再触发中止）。
   * 对后续请求，主进程应在 dispatch 前读到 GateProbe 并把 `earlyAbort:false` 写入指令。
   */
  disable(): void
}

/**
 * 观测线（**2026-09-13 G1 取证后修订**）= `requestMaxTokens − MIN_USABLE_BODY_TOKENS`：
 * 只有当"继续下去连正文绝对下限都放不下"时才提前中止——即**可证明的徒劳点**。
 *
 * 为什么不再用 `max(gateTokens, requestMaxTokens × 0.85)`（阶段8 §4.4 原式）：
 * - `× 0.85` 是无依据的魔数，且在 G1 实机取证（n=82，CommandCode + deepseek-v4-pro）中
 *   被证明会误杀：3/3 次中止全部以空正文结束，而配对的对照臂在同一用例上更快地产出了正文；
 * - `gateTokens` 是**预算承诺**而不是止损线：接入 P90 余量后它可能大于本式，取 max 会让守卫
 *   在"已不可能留下正文"之后才触发，等于失效；
 * - 正文绝对下限是既有常量 `MIN_USABLE_BODY_TOKENS`（256），语义与 `resolveRequestBudget`
 *   的 `minimumViableOutputTokens` 同源，可解释、可单测。
 *
 * 触发时机的相对变化：预算 > 1707 时新式**晚于**旧式（更不容易误杀），预算更小时略早于旧式
 * （但仍是"不足 256 正文空间"的正确止损点）。阈值以**估算推理 token**（CJK 感知，偏保守）计量，
 * 而中文推理的估算普遍高于供应商上报值，因此实际触发比字面更晚。
 * `enabled=false`（门控可信或不是 off/none 场景）时守卫永不触发。
 */
export function createReasoningRunawayGuard(input: {
  enabled: boolean
  requestMaxTokens: number
}): ReasoningRunawayGuard {
  const thresholdTokens = input.requestMaxTokens > 0
    ? Math.max(1, Math.floor(input.requestMaxTokens) - MIN_USABLE_BODY_TOKENS)
    : 0
  let enabled = input.enabled
  let reasoningTokens = 0
  let bodyChars = 0
  let finished = false
  let aborted = false
  return {
    addReasoning(text) {
      if (text) reasoningTokens += estimateReasoningTokens(text)
    },
    addBody(chars) {
      if (chars > 0) bodyChars += chars
    },
    markFinished() {
      finished = true
    },
    shouldAbort() {
      if (!enabled || aborted || finished || bodyChars > 0) return false
      if (thresholdTokens <= 0) return false
      return reasoningTokens >= thresholdTokens
    },
    get aborted() {
      return aborted
    },
    markAborted() {
      aborted = true
    },
    disable() {
      enabled = false
    },
  }
}

/**
 * 方案 A（G1 修订）：是否允许本轮提前中止。
 * - 指令显式 `earlyAbort === false` → 禁止（端点已确认 disableIgnored）；
 * - off/none 且未禁止 → 允许（现行行为）；
 * - 其他档位（门控应生效）→ 禁止，空正文交给零输出恢复。
 */
export function shouldEnableRunawayGuard(gate: {
  level?: string
  knob?: string
  earlyAbort?: boolean
} | null | undefined): boolean {
  if (!gate) return false
  if (gate.earlyAbort === false) return false
  if (gate.knob === 'none' || gate.level === 'off') return true
  return false
}

/**
 * 把内部中止（推理越线）与用户 signal 合并：返回给 fetch 使用的 signal
 * 与判因函数；用户取消时 `abortedByUs()` 为 false，保持原有错误语义。
 */
export function withInternalAbort(signal?: AbortSignal): {
  signal: AbortSignal
  abort: () => void
  abortedByUs: () => boolean
  cleanup: () => void
} {
  const controller = new AbortController()
  let internal = false
  // 适配器可能被不带 signal 的调用方使用（评测脚本/工具循环）；缺省只保留内部中止能力
  if (!signal) {
    return {
      signal: controller.signal,
      abort: () => {
        internal = true
        controller.abort(new Error('reasoning_gate_exceeded'))
      },
      abortedByUs: () => internal,
      cleanup: () => { /* 无外部监听需要解除 */ },
    }
  }
  if (signal.aborted) controller.abort(signal.reason)
  const onUserAbort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', onUserAbort, { once: true })
  return {
    signal: controller.signal,
    abort: () => {
      internal = true
      controller.abort(new Error('reasoning_gate_exceeded'))
    },
    abortedByUs: () => internal,
    cleanup: () => signal.removeEventListener('abort', onUserAbort),
  }
}

// ===================== 工具函数 =====================

/**
 * 合并用户 signal 与超时 signal
 * BUG-11 修复：返回 cleanup 回调，调用方在请求正常完成时调用以清理 timer，
 * 避免高频调用时未清理的 setTimeout 堆积（原实现仅在 abort 时清理）
 */
export function withTimeout(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  // 如果用户 signal 已经 abort，直接返回
  if (signal.aborted) return { signal, cleanup: () => {} }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const onUserAbort = () => {
    clearTimeout(timer)
    controller.abort(signal.reason)
  }
  // 用户取消时同步取消
  signal.addEventListener('abort', onUserAbort, { once: true })
  // 超时后取消
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timer)
  }, { once: true })
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onUserAbort)
    },
  }
}

/** 判断错误是否可重试 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    // 网络错误、超时、5xx、429 都可重试
    if (msg.includes('timeout') || msg.includes('aborted')) return true
    if (msg.includes('network') || msg.includes('fetch failed')) return true
    if (msg.includes('econnrefused') || msg.includes('econnreset')) return true
    // NEW-L6 修复：状态码用词边界匹配，避免子串误判（如 "4000" 命中 "400"）
    for (const re of RETRYABLE_REGEXES) {
      if (re.test(msg)) return true
    }
  }
  return false
}

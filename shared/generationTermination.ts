/**
 * 统一异常终止收口（阶段7 方案 §3.2 / §4.1 / §4.3）——纯逻辑，无 IO。
 *
 * 职责：
 * - 应用层终止原因（terminationCause）与供应商 finishReason 的映射，两者互不覆盖；
 * - 终止行为矩阵的用户提示文案（错误/超时/取消提示只进 generationNotice/generationError，
 *   绝不拼入 content——TTS、复制、导出、记忆与下一轮上下文只读干净正文）；
 * - requestId + terminalState 一次性终止状态机：只有 streaming 能进入某个终止分支，
 *   进入 finalizing 后忽略迟到 chunk/done/error，保证同一 requestId 最多落盘一次。
 */

import type { AIFinishReason, GenerationTerminationCause } from './types'

/** 终止状态机的合法状态（方案 §4.3） */
export type GenerationTerminalState = 'streaming' | 'finalizing' | 'persisted' | 'cancelled' | 'failed'

/**
 * 观测口径的终止原因推导（§9.1：只记录枚举，不记录正文）。
 * 输入为观测层的结局分类（outcome/finishReason/errorKind/cancelReason），
 * 主进程与渲染层共用，保证 terminationCause 单一口径。
 */
export function observationTerminationCause(input: {
  outcome: 'completed' | 'truncated' | 'user_cancelled' | 'error'
  finishReason: AIFinishReason
  errorKind?: string
  cancelReason?: 'user' | 'timeout' | 'stop_string'
}): GenerationTerminationCause {
  if (input.outcome === 'user_cancelled' || input.errorKind === 'aborted') {
    return input.cancelReason === 'timeout' ? 'idle_timeout' : 'user_cancel'
  }
  if (input.errorKind === 'timeout') return 'idle_timeout'
  if (input.errorKind === 'network' || input.finishReason === 'network_error') return 'transport_error'
  if (input.errorKind === 'content_filter' || input.finishReason === 'content_filter') return 'provider_content_filter'
  // 阶段8（§4.7）：推理挤占是独立终局（旧文本判定路径收编为结构化原因）
  if (input.errorKind === 'reasoning_budget_exhausted') return 'reasoning_gate_exceeded'
  if (input.outcome === 'truncated' || input.errorKind === 'length_limit' || input.finishReason === 'length') return 'provider_length'
  return terminationCauseFromFinishReason(input.finishReason)
}

/** 供应商 finishReason → 应用层终止原因（正常完成事件口径） */
export function terminationCauseFromFinishReason(reason: AIFinishReason | undefined | null): GenerationTerminationCause {
  switch (reason) {
    case 'stop':
      return 'provider_stop'
    case 'length':
      return 'provider_length'
    case 'content_filter':
      return 'provider_content_filter'
    case 'tool_calls':
      return 'provider_tool_calls'
    case 'cancelled':
      return 'user_cancel'
    case 'network_error':
      // 主进程把传输失败归类为 network_error；应用层同名映射
      return 'transport_error'
    default:
      return 'unknown'
  }
}

/** 终止原因 → 传给收尾管线的有效 finishReason（收尾器按供应商口径判断） */
export function effectiveFinishReasonForCause(
  cause: GenerationTerminationCause,
  providerFinishReason: AIFinishReason,
): AIFinishReason {
  switch (cause) {
    case 'transport_error':
    case 'idle_timeout':
    case 'protocol_error':
      return 'network_error'
    case 'provider_stop':
      return 'stop'
    case 'provider_length':
      // 阶段8：提前中止是零正文的 length 类截断，收尾器按 length 处理
    case 'reasoning_gate_exceeded':
      return 'length'
    case 'provider_content_filter':
      return 'content_filter'
    case 'provider_tool_calls':
      return 'tool_calls'
    case 'user_cancel':
      return 'cancelled'
    default:
      return providerFinishReason ?? 'unknown'
  }
}

/** 终止原因 → 有可用部分正文时的用户提示（方案 §4.1 行为矩阵） */
export function terminationPromptWithContent(cause: GenerationTerminationCause): {
  field: 'generationNotice' | 'generationError'
  text: string
} | null {
  switch (cause) {
    case 'transport_error':
      return { field: 'generationError', text: '生成中断，已保留完整部分' }
    case 'idle_timeout':
      return { field: 'generationError', text: '请求超时，已保留完整部分' }
    case 'protocol_error':
      return { field: 'generationError', text: '响应格式异常，已保留完整部分' }
    case 'user_cancel':
      return { field: 'generationNotice', text: '已停止生成' }
    default:
      return null
  }
}

/** 终止原因 → 无可用正文时写入 store.error 的基础提示（附重试入口由界面层负责） */
export function terminationPromptWithoutContent(cause: GenerationTerminationCause, errorMessage?: string): string {
  if (errorMessage?.trim()) return errorMessage.trim()
  switch (cause) {
    case 'transport_error':
      return '生成中断，请重试'
    case 'idle_timeout':
      return '请求超时，请重试'
    case 'protocol_error':
      return '响应格式异常，请重试'
    case 'provider_content_filter':
      return '回复被内容审核拦截'
    case 'user_cancel':
      return '已停止生成'
    case 'reasoning_gate_exceeded':
      // 阶段8（§4.5）：降档重试仍失败后的最终兜底文案，只有重试也失败才可见
      return '该模型推理占满输出预算，请重试或更换模型'
    default:
      return '模型未返回可用内容，请重试'
  }
}

/**
 * 内容审核拦截时是否保留部分正文（方案 §4.1「按审核策略决定是否保留」）。
 * 本产品口径：审核拦截视为整条回复不可信，不保存正文，只给明确审核提示。
 */
export function contentFilterPreservesBody(): boolean {
  return false
}

/** 终止协调的一次性闸门（方案 §4.3 状态机的最小实现） */
export interface GenerationTerminationLatch {
  readonly requestId: string
  readonly state: GenerationTerminalState
  /** 抢占终止权：仅 streaming 能进入某个终止分支；迟到事件返回 false */
  claim(cause: GenerationTerminationCause): boolean
  /** 落盘完成，同一 requestId 不得再次保存 */
  markPersisted(): void
  /** 是否仍可接收流式事件（chunk 累加只在 streaming 状态进行） */
  acceptsStreamEvent(): boolean
  /** 已抢占的终止原因（诊断与观测用） */
  readonly claimedCause?: GenerationTerminationCause
}

export function createGenerationTerminationLatch(requestId: string): GenerationTerminationLatch {
  let state: GenerationTerminalState = 'streaming'
  let claimedCause: GenerationTerminationCause | undefined
  return {
    requestId,
    get state() {
      return state
    },
    get claimedCause() {
      return claimedCause
    },
    claim(cause) {
      if (state !== 'streaming') return false
      claimedCause = cause
      state = cause === 'user_cancel' ? 'cancelled' : 'finalizing'
      return true
    },
    markPersisted() {
      if (state === 'finalizing' || state === 'cancelled') state = 'persisted'
    },
    acceptsStreamEvent() {
      return state === 'streaming'
    },
  }
}

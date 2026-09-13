import type { AICompletion, ChatParams } from '../../../shared/types'
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
  '推理已占满模型输出硬上限，未留下正文空间。请提高“模型输出硬上限”，或设为 0 使用自动预算。'

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

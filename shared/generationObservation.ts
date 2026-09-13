/**
 * 生成观测核心（阶段0「基线与观测」）——纯类型与判定逻辑，无 IO。
 *
 * 职责：
 * - 定义逐请求观测记录的形状（模型、篇幅模式、正文字符、token、结束原因…）；
 * - 结束状态分类：能够区分「正文过长」「推理占满」「网络中断」「用户停止」与普通错误；
 * - 观测记录组装：对取不到 reasoning token 的上游记 'unknown'，绝不填 0。
 *
 * 持久化（JSONL 落盘与轮转）在 electron/services/generationObservation.ts；
 * 基线分析脚本 scripts/generation-baseline.ts 只依赖本模块。
 */

import type { AIFinishReason, ChatParams, ResponseLengthMode } from './types'
import type { ReasoningGateKnob, ReasoningGateLevel } from './reasoningGate'
import { endpointFingerprint } from './endpointKey'
import { countVisibleCharacters, analyzeTextClosure, tailSample, isCompleteSentence } from './textMetrics'

/** 适配器侧可透出的结束原因（cancelled/network_error 由观测层按失败上下文归类） */
export type AdapterFinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'unknown'

/** 观测口径的结束原因（与结构化完成事件同一契约） */
export type ObservationFinishReason = AIFinishReason

/** 请求结局：完成 / 触顶截断 / 用户停止 / 失败 */
export type ObservationOutcome = 'completed' | 'truncated' | 'user_cancelled' | 'error'

/** 触顶细分：正文写满（正文过长）vs 推理挤占（推理占满）vs 无法判定 */
export type ObservationTruncationKind = 'body_filled' | 'reasoning_filled' | 'unknown'

/** 失败原因细分（error 终局下的 errorKind） */
export type ObservationErrorKind =
  | 'timeout'
  | 'network'
  | 'empty_output'
  | 'reasoning_budget_exhausted'
  | 'content_filter'
  | 'length_limit'
  | 'api'
  | 'aborted'
  | 'other'

/** 请求来源：单聊 / 群聊 / 桥接端 / 辅助调用（翻译、记忆、压缩等） */
export type ObservationSource = 'single' | 'group' | 'bridge' | 'aux'

/** 随 ChatParams 透传的观测元数据（缺省视为辅助调用） */
export interface RequestObservability {
  source: 'single' | 'group' | 'bridge' | 'aux'
  generationType?: 'normal' | 'continue' | 'impersonate' | 'swipe' | 'regenerate' | 'quiet'
  /** 阶段7（§7.3）：后台结构化任务类型；独立记录，不混入主对话篇幅统计 */
  taskType?: 'memory' | 'compression' | 'title' | 'direction'
  responseLengthMode?: ResponseLengthMode
  hardMaxChars?: number
  /** S5：本轮用户文本中识别出的篇幅要求（用于核对意图误判） */
  responseIntent?: ResponseLengthMode
  /** S5：自动模式场景系数（1 = 未调整） */
  sceneFactor?: number
  characterId?: string
  sessionId?: string
  /** 阶段8（§4.7）：本轮门控档位与 knob */
  gateLevel?: ReasoningGateLevel
  gateKnob?: ReasoningGateKnob | 'unknown'
  /** 本轮请求的 knob 是否被接受（明确 400 字段拒绝 → false；网络错误不写） */
  knobAcceptedThisRequest?: boolean
  /** 是否由提前中止终止（推理越线且正文为空） */
  earlyAbort?: boolean
  /** 本次请求是否为门控降档重试（归属原生成轮） */
  downgradeRetry?: boolean
}

/** 逐请求观测记录（JSONL 一行一条；默认不含正文，只含长度与枚举分类，§9.1） */
export interface GenerationObservation {
  ts: number
  requestId: string
  source: ObservationSource
  generationType?: string
  /** 阶段7（§7.3）：后台结构化任务类型（独立于主对话口径） */
  taskType?: 'memory' | 'compression' | 'title' | 'direction'
  characterId?: string
  sessionId?: string
  provider?: string
  model: string
  /**
   * W1（主计划 §4.4/§5.3）：端点指纹（标准化地址的不可逆短哈希）。
   * 只用于按端点隔离的用量回读，绝不保存完整 URL；旧记录缺省。
   */
  endpointFingerprint?: string
  requestedMaxTokens: number
  stream: boolean
  /** 篇幅模式（阶段一起随请求透传；缺省为 undefined） */
  responseLengthMode?: ResponseLengthMode
  /** 篇幅硬保护线（可见字符） */
  hardMaxChars?: number
  /** S5：本轮识别出的用户篇幅要求（未识别时为 undefined） */
  responseIntent?: ResponseLengthMode
  /** S5：自动模式场景系数（未参与计算/默认时为 undefined） */
  sceneFactor?: number
  /** 阶段8（§4.7）：本轮门控档位与 knob */
  gateLevel?: ReasoningGateLevel
  gateKnob?: ReasoningGateKnob | 'unknown'
  /** 本轮请求的 knob 是否被接受（明确 400 字段拒绝 → false） */
  knobAcceptedThisRequest?: boolean
  /** 是否由提前中止终止（推理越线且正文为空） */
  earlyAbort?: boolean
  /** 本次请求是否为门控降档重试（归属原生成轮） */
  downgradeRetry?: boolean
  finishReason: ObservationFinishReason
  outcome: ObservationOutcome
  /**
   * 阶段7（§3.2/§9.1）：应用层终止原因（与供应商 finishReason 分离）。
   * 观测只记录枚举值，不保存正文与错误原文。
   */
  terminationCause?: import('./types').GenerationTerminationCause
  /** finishReason=length 时的细分（正文过长 / 推理占满 / 无法判定） */
  truncationKind?: ObservationTruncationKind
  errorKind?: ObservationErrorKind
  /** 正文可见字符（剥离思考块与空白后的口径） */
  bodyVisibleChars: number
  /** completion token；上游未提供时为 'unknown'，不得填 0 */
  completionTokens: number | 'unknown'
  /** reasoning token；上游未提供时为 'unknown'，不得填 0 */
  reasoningTokens: number | 'unknown'
  durationMs: number
  attempts: number
  diagnostics: {
    completeSentence: boolean
    balancedQuotes: boolean
    balancedAsterisks: boolean
    closedThought: boolean
  }
  /** 正文尾部采样（≤80 可见字符，用于人工核验分类是否正确） */
  tailSample?: string
}

/** 观测层从适配器捕获的运行态 */
export interface ObservationCapture {
  finishReason?: string
  completionTokens?: number
  reasoningTokens?: number
  attempts: number
}

const NETWORK_ERROR_PATTERN = /network|fetch failed|econnrefused|econnreset|enotfound|econnaborted|socket hang up|err_network/i
const REASONING_BUDGET_EXHAUSTED_PATTERN = /推理已占满模型输出硬上限/
const LENGTH_LIMIT_PATTERN = /长度上限|max_tokens|maximum context length|too many tokens/i
const EMPTY_OUTPUT_PATTERN = /未返回任何内容|没有返回正文|空内容/
const CONTENT_FILTER_PATTERN = /content_filter|内容审核|SAFETY|被拦截/i

/**
 * 触顶细分：推理占满 = reasoning token 占 completion 的绝大部分且正文几乎为空；
 * 正文过长 = 正文可见字符达到可观规模；上游未给 reasoning token 时判 unknown。
 * 阶段8（§4.7）：提前中止已在流级确认推理越线，优先于 token 上报判定。
 */
export function classifyTruncationKind(input: {
  bodyVisibleChars: number
  completionTokens?: number | 'unknown'
  reasoningTokens?: number | 'unknown'
  /** 阶段8：应用层因推理越线主动中止（正文为空） */
  earlyAbort?: boolean
}): ObservationTruncationKind {
  if (input.earlyAbort === true) return 'reasoning_filled'
  const completion = input.completionTokens
  if (completion === 'unknown' || completion === undefined) return 'unknown'
  const reasoning = input.reasoningTokens
  if (reasoning === 'unknown' || reasoning === undefined) {
    // 无 reasoning 计数时，仅当正文明显偏短才可疑，否则按正文写满处理
    return input.bodyVisibleChars < 40 ? 'unknown' : 'body_filled'
  }
  if (input.bodyVisibleChars < 40 && completion > 0 && reasoning >= completion * 0.8) {
    return 'reasoning_filled'
  }
  return 'body_filled'
}

/** 用户取消原因（随 cancelChat 透传；桥接端 abort 视为用户取消） */
export type CancelReason = 'user' | 'timeout' | 'stop_string'

/**
 * 失败终局分类：用户停止 / 网络（含超时）/ 触顶 / 空输出 / 审核 / 其他 API 错误。
 * 验收口径：能区分「正文过长」（truncated+body_filled）、「推理占满」
 * （truncated+reasoning_filled）、「网络中断」（error+network/timeout）、「用户停止」（user_cancelled）。
 * 渲染层空闲看门狗触发的取消（reason=timeout）按超时失败计，不算用户停止；
 * 停止字符串命中（reason=stop_string）按正常完成计（内容在规则边界收束）。
 */
export function classifyFailureOutcome(
  err: unknown,
  ctx: { signalAborted: boolean; cancelReason?: CancelReason; finishReason?: string },
): { outcome: ObservationOutcome; finishReason: ObservationFinishReason; errorKind?: ObservationErrorKind } {
  const message = err instanceof Error ? err.message : String(err ?? '')
  const errName = err instanceof Error ? err.name : ''

  if (ctx.signalAborted || errName === 'AbortError') {
    if (ctx.cancelReason === 'timeout' || (errName === 'AbortError' && !ctx.signalAborted)) {
      return { outcome: 'error', finishReason: 'unknown', errorKind: 'timeout' }
    }
    if (ctx.cancelReason === 'stop_string') {
      return { outcome: 'completed', finishReason: 'stop', errorKind: undefined }
    }
    return { outcome: 'user_cancelled', finishReason: 'cancelled', errorKind: 'aborted' }
  }
  if (ctx.finishReason === 'content_filter' || CONTENT_FILTER_PATTERN.test(message)) {
    return { outcome: 'error', finishReason: 'content_filter', errorKind: 'content_filter' }
  }
  if (REASONING_BUDGET_EXHAUSTED_PATTERN.test(message)) {
    return { outcome: 'truncated', finishReason: 'length', errorKind: 'reasoning_budget_exhausted' }
  }
  if (ctx.finishReason === 'length' || LENGTH_LIMIT_PATTERN.test(message)) {
    return { outcome: 'truncated', finishReason: 'length', errorKind: 'length_limit' }
  }
  if (EMPTY_OUTPUT_PATTERN.test(message)) {
    return { outcome: 'error', finishReason: ctx.finishReason === 'stop' ? 'stop' : 'unknown', errorKind: 'empty_output' }
  }
  if (NETWORK_ERROR_PATTERN.test(message)) {
    return { outcome: 'error', finishReason: 'network_error', errorKind: 'network' }
  }
  return { outcome: 'error', finishReason: normalizeFinishReason(ctx.finishReason), errorKind: 'api' }
}

/** 适配器原始 finish reason → 观测口径 */
export function normalizeFinishReason(raw: string | undefined | null): AdapterFinishReason {
  if (!raw) return 'unknown'
  switch (raw) {
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
    case 'STOP':
      return 'stop'
    case 'length':
    case 'max_tokens':
    case 'MAX_TOKENS':
      return 'length'
    case 'content_filter':
    case 'SAFETY':
    case 'RECITATION':
    case 'refusal':
      return 'content_filter'
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool_calls'
    default:
      return 'unknown'
  }
}

/** 从 ChatParams 提取观测元数据（缺省视为辅助调用） */
export function resolveObservability(
  params: ChatParams,
): Omit<RequestObservability, 'source'> & { source: ObservationSource } {
  const obs = params.observability
  if (!obs || !obs.source) {
    return { source: 'aux' }
  }
  return { ...obs, source: obs.source }
}

/** 组装一条观测记录 */
export function buildGenerationObservation(params: ChatParams, state: {
  startedAt: number
  finishedAt: number
  /** 适配器返回/流式累积的最终文本（失败时为已产出前缀，可能为空） */
  text: string
  outcome: ObservationOutcome
  finishReason: ObservationFinishReason
  terminationCause?: import('./types').GenerationTerminationCause
  errorKind?: ObservationErrorKind
  completionTokens?: number
  reasoningTokens?: number
  attempts: number
  /** 阶段8（§4.3）：适配器本轮的门控探测结论（400 字段拒绝 / 静默忽略 disable） */
  gateProbe?: import('./reasoningGate').GateProbeSignal
  /** 阶段8（§4.4）：适配器因推理越线主动中止（正文为空） */
  earlyAbort?: boolean
}): GenerationObservation {
  const obs = resolveObservability(params)
  // 正文口径：剥离思考块后再计可见字符 / 判完整句 / 取尾部采样
  const bodyText = state.text.replace(/<thought>[\s\S]*?<\/thought>/gi, '')
  const bodyVisibleChars = countVisibleCharacters(bodyText)
  const completionTokens = typeof state.completionTokens === 'number' && Number.isFinite(state.completionTokens)
    ? state.completionTokens
    : 'unknown'
  // 计划口径：取不到 reasoning token 的上游记 unknown，不得填 0
  const reasoningTokens = typeof state.reasoningTokens === 'number' && Number.isFinite(state.reasoningTokens)
    ? state.reasoningTokens
    : 'unknown'

  const closure = analyzeTextClosure(state.text)
  const endpointKey = endpointFingerprint(params.baseUrl)
  // 阶段8：门控事实优先取适配器探测结论，其次取请求侧声明；两者都缺省则不写字段
  const gateLevel = params.reasoningGate?.level ?? obs.gateLevel
  const gateKnob = state.gateProbe?.knob ?? params.reasoningGate?.knob ?? obs.gateKnob
  const knobAccepted = state.gateProbe?.knobAccepted ?? obs.knobAcceptedThisRequest
  const record: GenerationObservation = {
    ts: state.finishedAt,
    requestId: params.requestId,
    source: obs.source,
    generationType: obs.generationType,
    ...(obs.taskType ? { taskType: obs.taskType } : {}),
    ...(state.terminationCause ? { terminationCause: state.terminationCause } : {}),
    characterId: obs.characterId,
    sessionId: obs.sessionId,
    provider: params.provider,
    model: params.model,
    ...(endpointKey ? { endpointFingerprint: endpointKey } : {}),
    requestedMaxTokens: params.maxTokens ?? 0,
    stream: params.stream === true,
    responseLengthMode: obs.responseLengthMode,
    hardMaxChars: obs.hardMaxChars,
    responseIntent: obs.responseIntent,
    sceneFactor: obs.sceneFactor,
    ...(gateLevel ? { gateLevel } : {}),
    ...(gateKnob ? { gateKnob } : {}),
    ...(knobAccepted !== undefined ? { knobAcceptedThisRequest: knobAccepted } : {}),
    ...((state.earlyAbort ?? obs.earlyAbort) ? { earlyAbort: true } : {}),
    ...(obs.downgradeRetry ? { downgradeRetry: true } : {}),
    finishReason: state.finishReason,
    outcome: state.outcome,
    bodyVisibleChars,
    completionTokens,
    reasoningTokens,
    durationMs: Math.max(0, state.finishedAt - state.startedAt),
    attempts: Math.max(1, state.attempts),
    diagnostics: {
      completeSentence: bodyText.trim() ? isCompleteSentence(bodyText) : false,
      balancedQuotes: closure.balancedQuotes,
      balancedAsterisks: closure.balancedAsterisks,
      closedThought: closure.closedThought,
    },
    tailSample: tailSample(bodyText) || undefined,
  }
  if (state.finishReason === 'length' && (state.outcome === 'truncated' || state.outcome === 'completed')) {
    record.truncationKind = classifyTruncationKind({
      bodyVisibleChars,
      completionTokens,
      reasoningTokens,
      earlyAbort: state.earlyAbort === true || obs.earlyAbort === true,
    })
  }
  if (state.errorKind) record.errorKind = state.errorKind
  return record
}

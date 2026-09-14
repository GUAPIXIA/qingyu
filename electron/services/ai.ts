import type { IpcMain, WebContents } from 'electron'
import type { AICompletion, ChatParams, ProviderType } from '../../shared/types'
import { IPC_EVENTS } from '../../shared/ipc-channels'
import { stripAllThinking } from '../../shared/thoughtMarkup'
import { countTokens, countMessagesTokens } from './tokenizer'
import { createLogger } from './logger'
import { chatWithTools } from './toolLoop'
import { safeSend } from '../utils/safeSend'
import type { AIAdapter, TokenUsageInfo } from './adapters/types'
import { DEFAULT_TIMEOUT_MS, DEFAULT_RETRY_COUNT, isRetryableError, withTimeout } from './adapters/types'
import { openaiAdapter } from './adapters/openai'
import { claudeAdapter } from './adapters/claude'
import { geminiAdapter } from './adapters/gemini'
import { ollamaAdapter } from './adapters/ollama'
import {
  buildGenerationObservation,
  classifyFailureOutcome,
  type CancelReason,
  type ObservationErrorKind,
  type ObservationOutcome,
  type ObservationFinishReason,
} from '../../shared/generationObservation'
import { observationTerminationCause } from '../../shared/generationTermination'
import {
  resolveReasoningGate,
  type GateProbeSignal,
  type ReasoningGateDirective,
} from '../../shared/reasoningGate'
import type { UsageProfileQuery } from '../../shared/usageProfile'
import { queryGenerationDiagnostics, queryUsageProfile, recordGenerationObservation } from './generationObservation'
import { getGateProbe, recordGateProbeSignal, resetGateProbe } from './gateProbeStore'
import { enabledProfileOverride, resolveModelOutputProfile } from '../../shared/modelOutputProfile'
import type {
  LorebookKeywordEnrichmentMode,
  LorebookKeywordLocalizationEntry,
  LorebookKeywordLocalizationSuggestion,
} from '../../shared/ipc-api'

const log = createLogger('ai')
const LOREBOOK_LOCALIZATION_TIMEOUT_MS = 60 * 1000

// ===================== 适配器注册表 =====================

/**
 * 内置适配器表。
 * OpenRouter / vLLM / LM Studio / TabbyAPI 均为 OpenAI 兼容协议，复用 openaiAdapter；
 * 未来需要特化时（如 vLLM extra_body）替换为独立实现即可。
 */
const builtinAdapters: Record<ProviderType, AIAdapter> = {
  openai: openaiAdapter,
  claude: claudeAdapter,
  gemini: geminiAdapter,
  ollama: ollamaAdapter,
  openrouter: openaiAdapter,
  vllm: openaiAdapter,
  lmstudio: openaiAdapter,
  tabby: openaiAdapter,
  deepseek: openaiAdapter,
  groq: openaiAdapter,
  siliconflow: openaiAdapter,
}

/** 可注册适配器表（为阶段 4 扩展系统铺路：第三方 provider 可注册自定义适配器） */
const adapterRegistry = new Map<string, AIAdapter>()

/** 注册自定义 provider 适配器（覆盖内置同名项） */
export function registerAdapter(provider: string, adapter: AIAdapter): void {
  adapterRegistry.set(provider.toLowerCase(), adapter)
}

/** 注销自定义 provider 适配器 */
export function unregisterAdapter(provider: string): void {
  adapterRegistry.delete(provider.toLowerCase())
}

/** 获取适配器：自定义优先，内置次之，未知 provider 回退 OpenAI 兼容 */
export function getAdapter(provider: string): AIAdapter {
  const custom = adapterRegistry.get(provider.toLowerCase())
  if (custom) return custom
  return builtinAdapters[provider as ProviderType] ?? openaiAdapter
}

// ===================== IPC 注册 =====================
const activeRequests = new Map<string, AbortController>()

/**
 * 取消原因注册（阶段0观测）：区分用户手动停止 / 渲染层空闲看门狗超时 / 停止字符串命中。
 * 桥接端直接 abort 自有 controller，不经过 ai:cancel —— 视为用户取消。
 */
const cancelReasons = new Map<string, CancelReason>()

function registerCancelReason(requestId: string, reason: CancelReason): void {
  cancelReasons.set(requestId, reason)
  // 兜底清理：原因只在请求进行中有意义，超时后丢弃避免 Map 泄漏
  const timer = setTimeout(() => cancelReasons.delete(requestId), 5 * 60_000)
  timer.unref?.()
}

const HAN_CHARACTER = /\p{Script=Han}/u
const ALIAS_SPLITTER = /[,，、;；\n]+/
const ANY_LETTER = /\p{L}/u

/**
 * 从模型输出中提取并清洗触发词。模型可能包裹 Markdown 代码块或 thought 标签，
 * 因此解析层只信任请求中存在的条目 id，并拒绝过长和重复的别名。
 * localize 模式仅接受含中文字符的别名；enrich 模式允许任意语言（多语言关键词），
 * 但仍要求至少含一个字母（过滤纯数字/符号噪音）。
 */
export function parseLorebookKeywordSuggestions(
  raw: string,
  entries: LorebookKeywordLocalizationEntry[],
  mode: LorebookKeywordEnrichmentMode = 'localize',
): LorebookKeywordLocalizationSuggestion[] {
  const cleaned = stripAllThinking(String(raw ?? ''))
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('模型未返回有效的 JSON 数组')

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new Error('模型返回的触发词格式无法解析，请重试或更换模型')
  }
  if (!Array.isArray(parsed)) throw new Error('模型返回的触发词格式无效')

  const sourceById = new Map(entries.map((entry) => [entry.id, entry]))
  const result: LorebookKeywordLocalizationSuggestion[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as { id?: unknown; entryId?: unknown; aliases?: unknown }
    const entryId = typeof candidate.entryId === 'string'
      ? candidate.entryId
      : typeof candidate.id === 'string' ? candidate.id : ''
    const source = sourceById.get(entryId)
    if (!source || !Array.isArray(candidate.aliases)) continue

    const existing = new Set(source.keywords.map((keyword) => keyword.trim().toLocaleLowerCase()).filter(Boolean))
    const aliases: string[] = []
    for (const value of candidate.aliases) {
      if (typeof value !== 'string') continue
      for (const piece of value.split(ALIAS_SPLITTER)) {
        const alias = piece.trim().replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
        const normalized = alias.toLocaleLowerCase()
        if (!alias || alias.length > 24 || existing.has(normalized)) continue
        if (mode === 'localize' ? !HAN_CHARACTER.test(alias) : !ANY_LETTER.test(alias)) continue
        existing.add(normalized)
        aliases.push(alias)
        if (aliases.length >= 8) break
      }
      if (aliases.length >= 8) break
    }
    if (aliases.length > 0) result.push({ entryId, aliases })
  }
  return result
}

/**
 * 带重试的 chat 调用（阶段0观测 + 阶段3结构化完成）。
 *
 * 返回 AICompletion（正文 + finishReason + usage）：
 * - length 是完成状态，随完成结果返回；
 * - 网络中断/超时但已产出正文时，降级为 finishReason='network_error' 的完成结果
 *   （部分正文进入收尾器，不整条丢失）；完全无正文才按错误抛出。
 */
export async function chatWithRetry(
  adapter: AIAdapter,
  params: ChatParams,
  onChunk: (text: string) => void,
  signal: AbortSignal,
  retryCount = DEFAULT_RETRY_COUNT,
  onUsage?: (usage: TokenUsageInfo) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<AICompletion> {
  const startedAt = Date.now()
  // 阶段8（§4.3）：调用方给出档位（reasoningGate）时，主进程在此统一解析 knob 与承诺值——
  // 跳过已被明确 400 拒绝的 knob、用 GateProbe 样本给出预算承诺值；适配器只消费结果。
  // 缺省（kill switch 关闭 / 调用方未接线）完全不介入，保持适配器现行行为。
  const requestedGate = params.reasoningGate
  const dispatchParams: ChatParams = requestedGate
    ? { ...params, reasoningGate: resolveDispatchGateDirective(params, requestedGate) }
    : params
  const gateScope = { provider: params.provider, baseUrl: params.baseUrl, model: params.model }
  let completionGateProbe: GateProbeSignal | undefined
  let completionEarlyAbort = false
  // 阶段0观测捕获：结束原因 / usage / 累积文本（失败时保留已产出前缀，正文口径由组装层处理）
  let capturedUsage: TokenUsageInfo | undefined
  let capturedText = ''
  let attempts = 0
  const captureOnChunk = (text: string) => {
    capturedText += text
    onChunk(text)
  }
  const captureOnUsage = (usage: TokenUsageInfo) => {
    capturedUsage = usage
    onUsage?.(usage)
  }

  const writeObservation = (state: {
    outcome: ObservationOutcome
    finishReason: ObservationFinishReason
    errorKind?: ObservationErrorKind
  }): void => {
    try {
      recordGenerationObservation(buildGenerationObservation(dispatchParams, {
        startedAt,
        finishedAt: Date.now(),
        text: capturedText,
        outcome: state.outcome,
        finishReason: state.finishReason,
        // 阶段7（§3.2/§9.1）：应用层终止原因与供应商 finishReason 分开记录
        terminationCause: observationTerminationCause({
          outcome: state.outcome,
          finishReason: state.finishReason,
          errorKind: state.errorKind,
          cancelReason: cancelReasons.get(params.requestId),
        }),
        errorKind: state.errorKind,
        completionTokens: capturedUsage?.completionTokens,
        reasoningTokens: capturedUsage?.reasoningTokens,
        attempts,
        ...(completionGateProbe ? { gateProbe: completionGateProbe } : {}),
        ...(completionEarlyAbort ? { earlyAbort: true } : {}),
      }))
    } catch { /* 观测失败不影响主流程 */ }
    cancelReasons.delete(params.requestId)
  }

  /** 网络中断/超时但已有正文：降级为结构化完成，正文交给收尾器（方案 §5.1） */
  const degradeNetworkFailure = (err: unknown): AICompletion | null => {
    if (!capturedText.trim()) return null
    const classified = classifyFailureOutcome(err, {
      signalAborted: signal.aborted,
      cancelReason: cancelReasons.get(params.requestId),
    })
    if (classified.errorKind !== 'network' && classified.errorKind !== 'timeout') return null
    return {
      text: capturedText,
      finishReason: 'network_error',
      usage: capturedUsage
        ? {
            promptTokens: capturedUsage.promptTokens,
            completionTokens: capturedUsage.completionTokens,
            reasoningTokens: capturedUsage.reasoningTokens,
          }
        : undefined,
    }
  }

  // H-05 修复：流式请求不重试，因为已发送的 chunks 无法撤回，重试会导致内容重复
  const effectiveRetry = params.stream ? 0 : retryCount
  let lastError: unknown
  try {
    for (let attempt = 0; attempt <= effectiveRetry; attempt++) {
      attempts = attempt + 1
      if (signal.aborted) throw new Error('Aborted')
      try {
        // 加入超时（与用户 signal 合并）
        const { signal: timeoutSignal, cleanup } = withTimeout(signal, timeoutMs)
        let completion: AICompletion
        try {
          completion = await adapter.chat(dispatchParams, captureOnChunk, timeoutSignal, captureOnUsage)
        } catch (err) {
          // 阶段3：网络中断但已有正文 → 降级为完成结果（观测仍按 error 记录）
          const degraded = degradeNetworkFailure(err)
          if (degraded) {
            writeObservation({ outcome: 'error', finishReason: 'network_error', errorKind: 'network' })
            return degraded
          }
          throw err
        } finally {
          // BUG-11：请求正常完成/异常退出时清理超时 timer
          cleanup()
        }
        // 阶段8（§4.3）：合并本轮探测结论（400 拒绝 / 静默忽略 / 推理用量上报）
        completionGateProbe = completion.gateProbe
        if (completionGateProbe) recordGateProbeSignal(gateScope, completionGateProbe)
        completionEarlyAbort = completion.earlyAbort === true
        // 成功：length 是完成状态（正文交给收尾器判定是否完整）
        writeObservation({
          outcome: completion.finishReason === 'length' ? 'truncated' : 'completed',
          finishReason: completion.finishReason,
        })
        return completion
      } catch (err) {
        lastError = err
        // 用户主动取消不重试
        if (signal.aborted) throw err
        const errName = (err as Error)?.name
        if (errName === 'AbortError' && !signal.aborted) {
          // 是超时 abort，可重试
        }
        // 不可重试的错误直接抛出
        if (!isRetryableError(err)) throw err
        // 最后一次尝试不再等待
        if (attempt === effectiveRetry) throw err
        // 指数退避：500ms, 1000ms, 2000ms...
        const delay = 500 * Math.pow(2, attempt)
        log.warn(`请求失败，${delay}ms 后重试 (${attempt + 1}/${effectiveRetry + 1})`, {
          error: (err as Error).message,
        })
        // 修复：退避等待响应取消信号（用户取消后立即中止，不干等完整延迟）
        if (signal.aborted) throw err
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay)
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        })
        if (signal.aborted) throw err
      }
    }
    throw lastError
  } catch (err) {
    // 阶段8：适配器可把探测结论挂在错误上（空正文 / 去参重发仍失败），失败终局同样要合并
    const errProbe = (err as { gateProbe?: GateProbeSignal } | null)?.gateProbe
    if (errProbe) {
      completionGateProbe = errProbe
      recordGateProbeSignal(gateScope, errProbe)
    }
    // 失败终局：区分用户停止 / 网络（含超时）/ 触顶 / 空输出 / 审核 / API 错误
    writeObservation(classifyFailureOutcome(err, {
      signalAborted: signal.aborted,
      cancelReason: cancelReasons.get(params.requestId),
    }))
    throw err
  }
}

/**
 * 阶段8（§4.3）：把调用方给出的档位解析为本轮可下发的门控指令。
 * - knob 由档案 gateKnobs 顺序 + GateProbe 决定（被拒的 knob 不再尝试）；
 * - tokens 为预算承诺值：可信门控 = 档位值；不可信/无门控 = max(档位值, 档案/P90 保守余量)。
 */
function resolveDispatchGateDirective(
  params: ChatParams,
  requested: ReasoningGateDirective,
): ReasoningGateDirective {
  const probe = getGateProbe({ provider: params.provider, baseUrl: params.baseUrl, model: params.model })
  const resolved = resolveReasoningGate({
    model: params.model,
    probe,
    requestedLevel: requested.level,
    // 调用方已决定使用门控（其自身已校验 kill switch），主进程只做 knob/预算解析
    enabled: true,
  })
  return {
    level: resolved.level,
    knob: resolved.knob,
    tokens: resolved.gateTokens,
    // 方案 A（G1）：disableIgnored 端点默认停用提前中止
    ...(probe?.disableIgnored === true ? { earlyAbort: false } : {}),
  }
}

export function registerAIIPC(ipcMain: IpcMain): void {
  // 获取模型列表
  ipcMain.handle('ai:listModels', async (_event, provider: ProviderType, baseUrl: string, apiKey: string) => {
    try {
      return { success: true, models: await getAdapter(provider).listModels(baseUrl, apiKey) }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  // 测试连接
  ipcMain.handle('ai:testConnection', async (_event, config: { type: ProviderType; baseUrl: string; apiKey: string }) => {
    try {
      const success = await getAdapter(config.type).testConnection(config.baseUrl, config.apiKey)
      if (success) {
        const models = await getAdapter(config.type).listModels(config.baseUrl, config.apiKey)
        return { success: true, models }
      }
      return { success: false, error: '连接失败' }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  // 聊天（流式）
  ipcMain.handle('ai:chat', async (event, params: ChatParams) => {
    const webContents = event.sender as WebContents
    const controller = new AbortController()
    // 防御：同 requestId 重复发起时中止旧请求，避免旧 controller 泄漏
    activeRequests.get(params.requestId)?.abort()
    activeRequests.set(params.requestId, controller)

    log.info('AI 请求开始', {
      requestId: params.requestId,
      provider: params.provider,
      model: params.model,
      messageCount: params.messages.length,
      imageMessages: params.messages.filter((m) => m.images && m.images.length > 0).length,
    })

    try {
      // C-03 修复：有工具时使用 chatWithTools 循环，否则直接调用适配器
      let completion: AICompletion
      if (params.tools && params.tools.length > 0) {
        completion = await chatWithTools(
          params,
          (text) => {
            if (!activeRequests.has(params.requestId)) return
            safeSend(webContents, IPC_EVENTS.aiChunk, { requestId: params.requestId, text })
          },
          (toolCall) => {
            // 契约漂移清理：此前外发 ai:toolCall/ai:toolResult 事件但渲染进程无消费者。
            // 保留日志记录；UI 展示工具调用进度属新功能，接线时恢复事件外发。
            log.info('工具调用', { requestId: params.requestId, tool: toolCall.name })
          },
          () => { /* 工具结果：无 UI 消费者，不再外发 */ },
          (usage) => {
            safeSend(webContents, IPC_EVENTS.aiUsage, { requestId: params.requestId, ...usage })
          },
          controller.signal,
        )
      } else {
        const adapter = getAdapter(params.provider)
        completion = await chatWithRetry(
          adapter,
          params,
          (text) => {
            // 检查请求是否还存在（可能已被取消）
            if (!activeRequests.has(params.requestId)) return
            safeSend(webContents, IPC_EVENTS.aiChunk, { requestId: params.requestId, text })
          },
          controller.signal,
          DEFAULT_RETRY_COUNT,
          (usage) => {
            // 发送 usage 事件
            safeSend(webContents, IPC_EVENTS.aiUsage, { requestId: params.requestId, ...usage })
          },
        )
      }
      log.info('AI 请求完成', { requestId: params.requestId, provider: params.provider, model: params.model, finishReason: completion.finishReason })
      // 阶段3：ai:done 携带结构化完成元数据（finishReason + usage），length 不再走 ai:error
      safeSend(webContents, IPC_EVENTS.aiDone, {
        requestId: params.requestId,
        finishReason: completion.finishReason,
        usage: completion.usage,
        // 阶段8（§4.4/§4.7）：提前中止作为结构化元数据下发，渲染层不解析错误文本
        ...(completion.earlyAbort ? { earlyAbort: true, terminationCause: 'reasoning_gate_exceeded' as const } : {}),
      })
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError' || controller.signal.aborted) {
        log.info('AI 请求被取消', { requestId: params.requestId })
        // 被取消视为 done（前端会重置状态）
        safeSend(webContents, IPC_EVENTS.aiDone, { requestId: params.requestId, finishReason: 'cancelled' })
      } else {
        log.error('AI 请求失败', { requestId: params.requestId, provider: params.provider, model: params.model, error: err.message })
        // 阶段8/G1 收口：把失败分类透传给渲染层（零输出 vs 传输失败/审核），
        // 否则渲染层只能一律按 transport_error 收口，既无法做一次零输出恢复，提示也会归类错。
        const classified = classifyFailureOutcome(err, {
          signalAborted: controller.signal.aborted,
          cancelReason: cancelReasons.get(params.requestId),
        })
        safeSend(webContents, IPC_EVENTS.aiError, {
          requestId: params.requestId,
          error: err.message,
          ...(classified.errorKind ? { errorKind: classified.errorKind } : {}),
        })
      }
    } finally {
      // 竞态保护：仅当 Map 中仍指向当前 controller 时才删除
      // （防止同 requestId 被覆盖后，旧请求的 finally 误删新请求的 controller）
      if (activeRequests.get(params.requestId) === controller) {
        activeRequests.delete(params.requestId)
      }
    }
  })

  // 取消请求（阶段0观测：reason 区分用户停止 / 看门狗超时 / 停止字符串）
  ipcMain.handle('ai:cancel', async (_event, requestId: string, reason?: CancelReason) => {
    const controller = activeRequests.get(requestId)
    if (controller) {
      registerCancelReason(requestId, reason === 'timeout' || reason === 'stop_string' ? reason : 'user')
      controller.abort()
      activeRequests.delete(requestId)
    }
  })

  // 世界书超限条目压缩（阶段三：非流式，invoke 直接返回完整摘要文本）
  ipcMain.handle('ai:compressLorebook', async (
    _event,
    payload: {
      contents: string[]
      targetTokens: number
      provider: ProviderType
      apiKey: string
      baseUrl: string
      model: string
    },
  ) => {
    const contents = (payload?.contents ?? []).filter((c) => typeof c === 'string' && c.trim())
    if (contents.length === 0) throw new Error('参数无效：contents 为空')
    const targetTokens = Math.max(32, Math.floor(payload.targetTokens) || 32)
    const adapter = getAdapter(payload.provider)
    const params: ChatParams = {
      requestId: `lorebook-compress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messages: [
        {
          role: 'system',
          content: `你是一个世界书条目压缩器。将用户提供的多条世界书设定条目压缩为一段简洁摘要，要求：
1. 保留人名、地名、物品名、关键规则、因果关系
2. 去除重复信息和冗余描述
3. 输出尽量简短，不超过约 ${targetTokens} token
4. 用中文输出，保持客观陈述语气，只输出摘要本身`,
        },
        { role: 'user', content: contents.map((c, i) => `[条目 ${i + 1}]\n${c}`).join('\n\n') },
      ],
      provider: payload.provider,
      apiKey: payload.apiKey,
      baseUrl: payload.baseUrl,
      model: payload.model,
      temperature: 0.3,
      topP: 0.9,
      // 直接约束生成上限；渲染层还会用本地 tokenizer 二次校验，超限结果不入缓存。
      maxTokens: targetTokens,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
    }
    // 非流式请求（stream=false）可安全重试；失败抛错由渲染方降级为直接裁剪
    const completion = await chatWithRetry(adapter, params, () => {}, new AbortController().signal, DEFAULT_RETRY_COUNT)
    return completion.text
  })

  // 关键词 enrichment 管线（阶段4，方案 7.5）：聊天模型离线扩词，运行时仍走本地关键词匹配。
  // localize = 英文条目中文化（旧行为）；enrich = 通用扩词（实体/别名/同义表达/多语言）。
  ipcMain.handle('ai:localizeLorebookKeywords', async (
    _event,
    payload: {
      requestId: string
      entries: LorebookKeywordLocalizationEntry[]
      mode?: LorebookKeywordEnrichmentMode
      provider: ProviderType
      apiKey: string
      baseUrl: string
      model: string
    },
  ) => {
    const mode: LorebookKeywordEnrichmentMode = payload?.mode === 'enrich' ? 'enrich' : 'localize'
    const entries = (payload?.entries ?? [])
      .filter((entry) => entry && typeof entry.id === 'string' && entry.id.trim())
      .slice(0, 16)
      .map((entry) => {
        const keywords = Array.isArray(entry.keywords)
          ? entry.keywords.filter((keyword): keyword is string => typeof keyword === 'string').slice(0, 20)
          : []
        return {
          id: entry.id,
          keywords,
          // 有英文关键词时正文只作消歧上下文；无关键词才提供更长摘要。
          // 大型世界书可显著减少每批输入和首次等待时间。
          content: typeof entry.content === 'string'
            ? entry.content.slice(0, keywords.length > 0 ? 320 : 800)
            : '',
        }
      })
    if (entries.length === 0) throw new Error('没有可处理的世界书条目')

    const requestId = payload.requestId?.trim()
      || `lorebook-keywords-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const controller = new AbortController()
    activeRequests.get(requestId)?.abort()
    activeRequests.set(requestId, controller)

    const systemPrompt = mode === 'enrich'
      ? `你是世界书关键词扩词助手。根据每个条目的正文与现有关键词，提取可补充的触发关键词：实体名、别名、称号、同义表达和跨语言说法（中文、英文、日文等均可）。
要求：
1. 每条生成 2-5 个简短触发词，优先专有名词与自然简称
2. 避免“人”“地方”“设定”等宽泛词，避免单个汉字，避免完整句子
3. 不重复该条目已有的关键词，不改写正文
4. 条目不适合补充时 aliases 返回空数组
5. 只输出严格 JSON 数组，不要 Markdown、解释或额外文字
格式：[{"entryId":"原始 id","aliases":["关键词"]}]`
      : `你是世界书触发词本地化助手。根据每个条目的英文关键词和正文，为中文角色扮演对话生成可用于精确关键词匹配的中文别名。
要求：
1. 每条生成 2-5 个简短中文触发词，优先专有名词、常用译名、音译、意译和自然简称
2. 避免“人”“地方”“组织”等宽泛词，避免单个汉字，避免完整句子
3. 不重复原关键词，不改写或翻译正文
4. 条目不适合生成时 aliases 返回空数组
5. 只输出严格 JSON 数组，不要 Markdown、解释或额外文字
格式：[{"entryId":"原始 id","aliases":["中文词"]}]`

    const params: ChatParams = {
      requestId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(entries) },
      ],
      provider: payload.provider,
      apiKey: payload.apiKey,
      baseUrl: payload.baseUrl,
      model: payload.model,
      temperature: 0.2,
      topP: 0.9,
      maxTokens: Math.min(2048, Math.max(384, entries.length * 140)),
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
    }

    const startedAt = Date.now()
    log.info('世界书关键词扩词生成开始', {
      requestId,
      mode,
      entryCount: entries.length,
      provider: payload.provider,
      model: payload.model,
    })
    try {
      const keywordCompletion = await chatWithRetry(
        getAdapter(payload.provider),
        params,
        () => {},
        controller.signal,
        0,
        undefined,
        LOREBOOK_LOCALIZATION_TIMEOUT_MS,
      )
      const raw = keywordCompletion.text
      const suggestions = parseLorebookKeywordSuggestions(raw, entries, mode)
      // 方案 7.5：保存生成来源、模型和时间——随建议返回，由渲染层写入条目 keywordProvenance。
      const source = {
        provider: String(payload.provider ?? ''),
        model: String(payload.model ?? ''),
        generatedAt: Date.now(),
        mode,
      }
      for (const suggestion of suggestions) suggestion.source = source
      log.info('世界书关键词扩词生成完成', {
        requestId,
        mode,
        entryCount: entries.length,
        suggestionCount: suggestions.length,
        durationMs: Date.now() - startedAt,
      })
      return { suggestions }
    } catch (error) {
      const errorName = error && typeof error === 'object' && 'name' in error
        ? String((error as { name?: unknown }).name)
        : ''
      if (controller.signal.aborted) {
        // 主动取消是正常控制流：在此收口，避免全局 IPC 包装器误记为异常。
        log.info('世界书关键词扩词生成已取消', { requestId, mode })
        return { suggestions: [], cancelled: true }
      }
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (errorName === 'AbortError' || /timeout|timed out|aborted/i.test(errorMessage)) {
        throw new Error('生成请求超时（60 秒），请检查模型连接或稍后重试')
      }
      throw error
    } finally {
      if (activeRequests.get(requestId) === controller) activeRequests.delete(requestId)
    }
  })

  // Token 计数
  ipcMain.handle('ai:countTokens', async (_event, text: string, model: string) => {
    return countTokens(text, model)
  })

  ipcMain.handle('ai:countMessagesTokens', async (_event, messages: { content: string; role: string; images?: string[] }[], model: string) => {
    return countMessagesTokens(messages, model)
  })

  // W1（主计划 §7.3）：只读用量档案查询。只返回数值聚合，
  // 不含正文、完整 URL 或磁盘路径；读取失败返回 null 由调用方回退静态档案。
  ipcMain.handle('ai:getGenerationUsageProfile', async (_event, query: unknown) => {
    return queryUsageProfile(sanitizeUsageProfileQuery(query))
  })
  ipcMain.handle('ai:getGenerationDiagnostics', async (_event, raw: unknown) => {
    const query = sanitizeUsageProfileQuery(raw)
    const source = (raw ?? {}) as Record<string, unknown>
    const overrideSource = source.capabilityOverride && typeof source.capabilityOverride === 'object'
      ? source.capabilityOverride as Record<string, unknown>
      : null
    const override = enabledProfileOverride(overrideSource ? {
      enabled: overrideSource.enabled === true,
      contextLimit: typeof overrideSource.contextLimit === 'number' ? overrideSource.contextLimit : undefined,
      outputLimit: typeof overrideSource.outputLimit === 'number' ? overrideSource.outputLimit : undefined,
    } : undefined)
    const modelProfile = resolveModelOutputProfile(query.model, { userOverride: override })
    const gateProbe = getGateProbe(query)
    return {
      ...queryGenerationDiagnostics(query),
      modelProfile: {
        outputLimit: modelProfile.outputLimit,
        contextLimit: modelProfile.contextLimit,
        reasoningMode: modelProfile.reasoningMode,
        source: modelProfile.matchedBy,
        confidence: modelProfile.confidence,
      },
      gateProbe: gateProbe ? {
        knob: gateProbe.knob,
        ...(gateProbe.knobAccepted !== undefined ? { knobAccepted: gateProbe.knobAccepted } : {}),
        ...(gateProbe.disableIgnored !== undefined ? { disableIgnored: gateProbe.disableIgnored } : {}),
        ...(gateProbe.reportsReasoningUsage !== undefined ? { reportsReasoningUsage: gateProbe.reportsReasoningUsage } : {}),
        updatedAt: gateProbe.updatedAt,
      } : null,
    }
  })
  ipcMain.handle('ai:resetGenerationGateProbe', async (_event, raw: unknown) => {
    resetGateProbe(sanitizeUsageProfileQuery(raw))
  })
}

/** renderer 传入的查询参数只保留受限长度的字符串字段（其余一律丢弃） */
function sanitizeUsageProfileQuery(raw: unknown): UsageProfileQuery {
  const source = (raw ?? {}) as Record<string, unknown>
  const str = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.slice(0, max) : ''
  const optional = (value: unknown, max: number): string | undefined =>
    typeof value === 'string' && value ? value.slice(0, max) : undefined
  return {
    provider: str(source.provider, 128),
    baseUrl: str(source.baseUrl, 512),
    model: str(source.model, 256),
    taskType: optional(source.taskType, 64),
    gate: optional(source.gate, 64),
  }
}

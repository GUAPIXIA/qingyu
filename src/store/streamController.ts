import { nanoid } from 'nanoid'
import type { Character, Preset, ChatParams } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { estimateTokens } from '../utils/tokenCounter'
import { countChars } from '../utils/charCounter'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { replaceVariables } from '../utils/variables'
import { resolveEffectiveTemplate } from '../utils/chatTemplates'
import { collectStopStrings, findStopIndex } from '../utils/regex'
import { lorebookCache } from '../utils/lorebook'
import type { BudgetLoreItem } from '../utils/lorebook'
import { logError, logInfo, logWarn } from '../lib/logger'
import { safeFire } from '../lib/safeOps'
import {
  STREAM_THROTTLE_MS,
  STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_LOREBOOK_SCAN_DEPTH,
  SEMANTIC_SCAN_MAX_TOKENS,
} from './chatConstants'
import { friendlyError, semanticCacheGet, semanticCacheSet } from './chatUtils'
import { resolveVisionModel } from '../utils/visionModel'
import type { ChatState, StoreGet, StoreSet } from './chatTypes'

// ===================== 流式状态管理（模块级，避免渲染抖动） =====================

interface StreamState {
  requestId: string
  aiMessageId: string
  accumulated: string
  flushTimer: ReturnType<typeof setTimeout> | null
  unbindChunk: () => void
  unbindDone: () => void
  unbindError: () => void
  timeoutHandle: ReturnType<typeof setTimeout> | null
}

let activeStream: StreamState | null = null

/** 上下文溢出压缩：待执行的压缩任务（buildContext 标记，流式完成后消费） */
interface PendingCompression {
  characterId: string
  sessionId: string
  droppedText: string
  droppedStartTs: number
  droppedEndTs: number
}

let pendingCompression: PendingCompression | null = null

/** 供 buildContext 标记压缩任务（上下文溢出时） */
export function markPendingCompression(pc: PendingCompression): void {
  pendingCompression = pc
}

/** 将累积的流式内容 flush 到 messages 状态 */
function flushStream(set: StoreSet) {
  if (!activeStream) return
  const { aiMessageId, accumulated } = activeStream
  activeStream.flushTimer = null
  set((state: ChatState) => {
    const msgs = state.messages
    const idx = msgs.findIndex((m) => m.id === aiMessageId)
    if (idx < 0) return {}
    const newMsgs = msgs.slice()
    newMsgs[idx] = { ...newMsgs[idx], content: accumulated }
    return { messages: newMsgs }
  })
}

/** 清理当前活动流（用于切换角色/取消/超时） */
export function cleanupActiveStream() {
  if (!activeStream) return
  if (activeStream.flushTimer) {
    clearTimeout(activeStream.flushTimer)
    activeStream.flushTimer = null
  }
  if (activeStream.timeoutHandle) {
    clearTimeout(activeStream.timeoutHandle)
    activeStream.timeoutHandle = null
  }
  try {
    activeStream.unbindChunk()
    activeStream.unbindDone()
    activeStream.unbindError()
  } catch { /* ignore */ }
  activeStream = null
}

/**
 * 语义触发（向量 RAG）预取：
 * 发送消息 / 重新生成 / 续写前异步检索语义命中的世界书条目，
 * 结果缓存到 store._semanticLoreHits，供 buildContext 同步合并。
 * 任何失败静默降级为纯关键词触发（不影响主流程）。
 */
async function fetchSemanticLoreHits(get: StoreGet, set: StoreSet, character: Character): Promise<void> {
  const settings = useSettingsStore.getState().settings
  const st = settings.semanticTrigger
  const clear = () => {
    if (get()._semanticLoreHits.length > 0) set({ _semanticLoreHits: [] })
  }
  // 快速失败：未启用 / 未配置 / 无激活世界书
  if (!st?.enabled || !st.baseUrl?.trim() || !st.model?.trim()) return clear()
  const lorebookIds = get().activeLorebookIds
  if (lorebookIds.length === 0) return clear()

  // 语义扫描范围：按 token 预算自适应（上限 4000 token，下限 scanDepth 条），大上下文下判断范围更广
  const scanDepth = lorebookIds
    .map(id => lorebookCache.get(id)?.scanDepth)
    .filter((d): d is number => typeof d === 'number' && d > 0)
    .reduce((max, d) => Math.max(max, d), DEFAULT_LOREBOOK_SCAN_DEPTH)
  const activeModel = useSettingsStore.getState().getActiveProfile()?.model || settings.activeModel
  const scanText = (() => {
    const msgs = get().messages
    const picked: string[] = []
    let tokens = 0
    for (let i = msgs.length - 1; i >= 0 && picked.length < scanDepth; i--) {
      const content = msgs[i].content || ''
      if (!content) continue
      tokens += estimateTokens(content, activeModel)
      if (picked.length > 0 && tokens > SEMANTIC_SCAN_MAX_TOKENS) break
      picked.unshift(content)
    }
    return picked.join(' ')
  })()
  if (!scanText.trim()) return clear()

  // 缓存：同一轮对话扫描文本不变时复用命中（省嵌入 API 调用）
  const cacheKey = `lore|${lorebookIds.join(',')}|${scanText}|${st.model}`
  const cached = semanticCacheGet<BudgetLoreItem[]>(cacheKey)
  if (cached) {
    set({ _semanticLoreHits: cached })
    return
  }

  try {
    const hits = await window.api.embedding.semanticSearch({
      scanText,
      lorebookIds,
      config: {
        provider: st.provider,
        baseUrl: st.baseUrl,
        model: st.model,
        apiKey: st.apiKey ?? '',
      },
      threshold: st.threshold,
      maxResults: st.maxResults,
    })
    const items: BudgetLoreItem[] = (hits ?? []).map((h) => ({
      content: replaceVariables(h.content, settings.userName, character.name),
      order: h.order,
      position: h.position,
      depth: h.depth,
    }))
    set({ _semanticLoreHits: items })
    semanticCacheSet(cacheKey, items)
    if (items.length > 0) {
      logInfo('fetchSemanticLoreHits', `语义命中 ${items.length} 条世界书条目`)
    }
  } catch (e) {
    logError('fetchSemanticLoreHits', e)
    clear()
  }
}

/**
 * 记忆事实语义检索预取（P0-2）：
 * 流式前对当前对话扫描文本嵌入，与会话事实向量比对，仅缓存相关事实供注入。
 * 未启用嵌入 / 无向量 / 失败时静默回退全量注入（_semanticFactsHits 清空）。
 */
async function fetchSemanticFacts(get: StoreGet, set: StoreSet): Promise<void> {
  const settings = useSettingsStore.getState().settings
  const st = settings.semanticTrigger
  const clear = () => {
    if (get()._semanticFactsHits.length > 0) set({ _semanticFactsHits: [] })
  }
  // 快速失败：未启用嵌入 / 无配置
  if (!st?.enabled || !st.baseUrl?.trim() || !st.model?.trim()) return clear()

  const { sessions, currentSessionId } = get()
  const session = sessions.find((s) => s.id === currentSessionId)
  if (!session?.memoryEnabled || !session.memoryFacts?.length) return clear()
  const vectors = session.factsVectors
  if (!vectors || vectors.length !== session.memoryFacts.length) return clear()

  // 查询文本：最近消息（与语义扫描一致，简化取最近 20 条）
  const query = get().messages.slice(-20).map((m) => m.content).join(' ')
  if (!query.trim()) return clear()

  // 缓存：同一轮对话查询不变时复用（省嵌入 API 调用）
  const cacheKey = `facts|${session.id}|${query}|${st.model}`
  const cached = semanticCacheGet<string[]>(cacheKey)
  if (cached) {
    set({ _semanticFactsHits: cached })
    return
  }

  try {
    const hits = await window.api.embedding.searchFacts({
      query,
      facts: session.memoryFacts,
      vectors,
      config: {
        provider: st.provider,
        baseUrl: st.baseUrl,
        model: st.model,
        apiKey: st.apiKey ?? '',
      },
      threshold: st.threshold,
      maxResults: st.maxResults ?? 3,
    })
    set({ _semanticFactsHits: hits ?? [] })
    semanticCacheSet(cacheKey, hits ?? [])
  } catch {
    clear()
  }
}

/**
 * 记忆事实向量化（P0-2）：保存事实后异步嵌入并存入会话，供语义检索注入。
 */
export async function vectorizeSessionFacts(characterId: string, sessionId: string, facts: string[]): Promise<void> {
  if (!facts?.length) return
  const st = useSettingsStore.getState().settings.semanticTrigger
  if (!st?.enabled || !st.baseUrl?.trim() || !st.model?.trim()) return
  try {
    const vectors = await window.api.embedding.embedFacts({
      provider: st.provider,
      baseUrl: st.baseUrl,
      model: st.model,
      apiKey: st.apiKey ?? '',
    }, facts)
    if (vectors.length === facts.length) {
      await window.api.chat.updateSession(characterId, sessionId, { factsVectors: vectors })
    }
  } catch { /* 向量化失败不阻塞，回退全量注入 */ }
}

/**
 * 上下文溢出压缩（P0-1）：异步压缩将被裁剪的早期对话，结果存会话。
 * 不阻塞主流程：buildContext 标记 pendingCompression，流式完成后调用。
 */
async function compressDroppedHistory(
  get: StoreGet,
  set: StoreSet,
  character: Character,
  pending: PendingCompression,
): Promise<void> {
  if (!pending.sessionId || !pending.droppedText) return
  const settings = useSettingsStore.getState().settings
  const profile = useSettingsStore.getState().getActiveProfile()
  if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) return

  const requestId = `compress-${Date.now()}`
  let result = ''
  let finished = false

  const unbindChunk = window.api.ai.onChunk((data) => {
    if (data.requestId !== requestId) return
    result += data.text
  })
  const unbindDone = window.api.ai.onDone((doneId) => {
    if (doneId !== requestId) return
    cleanup()
    finished = true
    const summary = result.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
    if (summary) {
      window.api.chat.updateSession(character.id, pending.sessionId, {
        compressedSummary: summary,
        compressedRange: { startTs: pending.droppedStartTs, endTs: pending.droppedEndTs },
      }).then(async () => {
        const sessions = await window.api.chat.listSessions(character.id)
        set({ sessions })
        logInfo('compressDroppedHistory', `早期对话已压缩（${summary.length} 字，范围 ${new Date(pending.droppedStartTs).toLocaleString()} 起）`)
      }).catch((e) => logError('StreamController:compressSummary', e))
    }
  })
  const unbindError = window.api.ai.onError((data) => {
    if (data.requestId !== requestId) return
    cleanup()
    finished = true
    logWarn('compressDroppedHistory', `压缩失败：${data.error}`)
  })
  const cleanup = () => {
    unbindChunk(); unbindDone(); unbindError()
  }

  window.api.ai.chat({
    requestId,
    messages: [
      {
        role: 'system',
        content: `你是一个对话摘要助手。以下是角色扮演对话的早期内容，即将被上下文裁剪。请压缩为 3-5 句中文摘要，必须保留：人物身份与姓名、地点、目标、关键事件、未解决的问题、重要的约定。只输出摘要文本，不要任何解释。`,
      },
      { role: 'user', content: pending.droppedText.slice(0, 20000) },
    ],
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: settings.activeModel || profile.model,
    temperature: 0.3,
    topP: 0.9,
    maxTokens: 600,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stream: true,
  }).catch(() => {
    cleanup()
    if (!finished) logWarn('compressDroppedHistory', '压缩请求失败')
  })
}

/**
 * 会话标题自动生成（P1-4）：新会话达到 4 条消息后，AI 生成简短标题。
 * 仅执行一次（titleGenerated 防重复），失败静默。
 */
async function maybeAutoTitle(get: StoreGet, set: StoreSet, character: Character): Promise<void> {
  const settings = useSettingsStore.getState().settings
  if (settings.autoTitle === false) return
  const { sessions, currentSessionId, messages } = get()
  const session = sessions.find((s) => s.id === currentSessionId)
  if (!session || session.titleGenerated) return
  // 仅对默认标题的新会话生成
  if (!session.title.startsWith('新对话')) return
  const userMsgs = messages.filter((m) => m.role === 'user')
  if (userMsgs.length < 4) return

  const profile = useSettingsStore.getState().getActiveProfile()
  if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) return

  const userName = settings.userName || '用户'
  const recentText = messages.slice(-12).map((m) =>
    `${m.role === 'user' ? userName : character.name}: ${m.content}`
  ).join('\n')

  const requestId = `autotitle-${Date.now()}`
  let result = ''
  let finished = false

  const unbindChunk = window.api.ai.onChunk((data) => {
    if (data.requestId !== requestId) return
    result += data.text
  })
  const unbindDone = window.api.ai.onDone((doneId) => {
    if (doneId !== requestId) return
    cleanup()
    finished = true
    const title = result.replace(/<thought>[\s\S]*?<\/thought>/gi, '').replace(/[\n\r"「」『』]/g, '').trim().slice(0, 20)
    if (title) {
      window.api.chat.renameSession(character.id, session.id, title)
        .then(() => window.api.chat.updateSession(character.id, session.id, { titleGenerated: true }))
        .then(async () => {
          const sessions = await window.api.chat.listSessions(character.id)
          set({ sessions })
        })
        .catch((e) => logError('StreamController:renameSession', e))
    }
  })
  const unbindError = window.api.ai.onError((data) => {
    if (data.requestId !== requestId) return
    cleanup()
    finished = true
  })
  const cleanup = () => {
    unbindChunk(); unbindDone(); unbindError()
  }

  window.api.ai.chat({
    requestId,
    messages: [
      {
        role: 'system',
        content: '你是一个对话标题生成器。请为以下角色扮演对话生成一个 2-8 字的中文标题，概括对话主题或核心事件。只输出标题本身，不要引号、解释或多余内容。',
      },
      { role: 'user', content: recentText.slice(0, 3000) },
    ],
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: settings.activeModel || profile.model,
    temperature: 0.5,
    topP: 0.9,
    maxTokens: 50,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stream: true,
  }).catch(() => {
    cleanup()
    if (!finished) { /* 静默 */ }
  })
}

/**
 * 抽取的公共 AI 流式响应方法
 * - 统一处理事件注册、节流、错误、超时
 * - 调用方只需提供 aiMessageId 和 onComplete 回调
 */
export async function streamAIResponse(
  set: StoreSet,
  get: StoreGet,
  opts: {
    aiMessageId: string
    character: Character
    preset: Preset | null
    continuation?: boolean  // 续写模式：buildContext 注入续写指令并跳过 Assistant Prefix
    inputText?: string   // 用户输入文本（用于字符统计），regenerate/continue 时为空
    onComplete: (fullContent: string) => Promise<void>
    onError?: (errMsg: string) => void
  },
): Promise<void> {
  const { aiMessageId, character, preset, onComplete, onError } = opts

  const settingsStore = useSettingsStore.getState()
  const settings = settingsStore.settings
  const profile = settingsStore.getActiveProfile()
  if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
    set({ isStreaming: false, currentRequestId: null })
    onError?.('未配置 API 连接')
    return
  }

  // 如果已有进行中的流，先清理（防止状态泄漏）
  cleanupActiveStream()

  // 语义触发预取（向量 RAG）：失败静默降级为纯关键词
  await fetchSemanticLoreHits(get, set, character)
  // 记忆事实语义检索预取（P0-2）：失败回退全量注入
  await fetchSemanticFacts(get, set)

  // 停止字符串（output 正则规则）：流式命中后截断 + 提前终止，省 token
  let stopStrings: string[] = []
  try {
    const regexRules = await window.api.regex.list()
    stopStrings = collectStopStrings(regexRules)
  } catch { /* 忽略 */ }

  const contextMessages = get().buildContext(character, preset, { continuation: opts.continuation })

  // Vision：上下文含图片且配置了激活识图模型 → 本轮使用识图模型连接（未填字段回退当前 Profile）
  const vision = resolveVisionModel(contextMessages)
  const effectiveModel = vision?.model ?? (settings.activeModel || profile.model)

  const requestId = nanoid()

  set({ isStreaming: true, currentRequestId: requestId, error: null })

  const onChunk = (data: { requestId: string; text: string }) => {
    if (data.requestId !== requestId) return
    if (!activeStream || activeStream.requestId !== requestId) return
    activeStream.accumulated += data.text
    // 停止字符串：命中后截断并提前终止（主进程取消后发 ai:done，走正常收尾）
    if (stopStrings.length > 0) {
      const idx = findStopIndex(activeStream.accumulated, stopStrings)
      if (idx !== -1) {
        activeStream.accumulated = activeStream.accumulated.slice(0, idx).trimEnd()
        if (activeStream.flushTimer) {
          clearTimeout(activeStream.flushTimer)
          activeStream.flushTimer = null
        }
        flushStream(set)
        window.api.ai.cancelChat(requestId).catch(() => {})
        return
      }
    }
    // 节流：避免每个 chunk 都触发 set
    if (activeStream.flushTimer === null) {
      activeStream.flushTimer = setTimeout(() => flushStream(set), STREAM_THROTTLE_MS)
    }
    // 空闲超时续期：收到 chunk 即重置 60s 计时（卡死时更快恢复）
    if (activeStream.timeoutHandle) clearTimeout(activeStream.timeoutHandle)
    activeStream.timeoutHandle = setTimeout(() => {
      if (activeStream?.requestId === requestId) {
        window.api.ai.cancelChat(requestId).catch(() => { /* ignore */ })
        cleanupActiveStream()
        set({ isStreaming: false, currentRequestId: null, error: '请求超时' })
        onError?.('请求超时')
      }
    }, STREAM_IDLE_TIMEOUT_MS)
  }

  const unbindChunk = window.api.ai.onChunk(onChunk)

  const unbindDone = window.api.ai.onDone((doneId: string) => {
    if (doneId !== requestId) return
    // 立即 flush 残留内容
    if (activeStream?.flushTimer) {
      clearTimeout(activeStream.flushTimer)
      activeStream.flushTimer = null
    }
    if (activeStream) {
      flushStream(set)
    }
    unbindChunk()
    unbindDone()
    unbindError()
    const fullContent = activeStream?.accumulated ?? ''
    if (activeStream?.timeoutHandle) clearTimeout(activeStream.timeoutHandle)

    // 字符用量统计：精确计算输入和输出字符数（model 记录实际使用的模型，含识图模型切换）
    const model = effectiveModel
    const outputChars = countChars(fullContent).total
    const inputChars = opts.inputText ? countChars(opts.inputText).total : 0
    const totalChars = inputChars + outputChars
    const usageInfo = { inputChars, outputChars, totalChars, model, timestamp: Date.now() }
    set((state: ChatState) => ({
      messages: state.messages.map(m => m.id === aiMessageId ? { ...m, charUsage: usageInfo } : m),
    }))
    // 持久化到用量记录
    const sid = get().currentSessionId
    if (sid) {
      safeFire(() => window.api.usage.record({
        timestamp: Date.now(),
        characterId: character.id,
        sessionId: sid,
        model,
        inputChars,
        outputChars,
        totalChars,
      }), '用量记录')
    }

    activeStream = null
    set({ isStreaming: false, currentRequestId: null })
    // 异步执行完成回调
    onComplete(fullContent).catch((e) => logError('ChatStore:onComplete', e))

    // 上下文溢出压缩：本轮结束后异步压缩被裁剪的早期对话（不阻塞）
    if (pendingCompression) {
      const pc = pendingCompression
      pendingCompression = null
      compressDroppedHistory(get, set, character, pc).catch((e) => logError('ChatStore:compress', e))
    }
    // 会话标题自动生成（P1-4）：新会话第 4 条用户消息后
    maybeAutoTitle(get, set, character)
  })

  const unbindError = window.api.ai.onError((data: { requestId: string; error: string }) => {
    if (data.requestId !== requestId) return
    if (activeStream?.flushTimer) {
      clearTimeout(activeStream.flushTimer)
      activeStream.flushTimer = null
    }
    if (activeStream) {
      flushStream(set)
    }
    unbindChunk()
    unbindDone()
    unbindError()
    if (activeStream?.timeoutHandle) clearTimeout(activeStream.timeoutHandle)
    activeStream = null
    const friendly = friendlyError(data.error)
    set({ isStreaming: false, currentRequestId: null, error: friendly })
    // N26 修复：流式失败时同样执行待处理的上下文压缩（与 done 分支一致），
    // 避免 pendingCompression 残留导致裁剪历史永远不被压缩
    if (pendingCompression) {
      const pc = pendingCompression
      pendingCompression = null
      compressDroppedHistory(get, set, character, pc).catch((e) => logError('ChatStore:compress', e))
    }
    onError?.(friendly)
  })

  activeStream = {
    requestId,
    aiMessageId,
    accumulated: '',
    flushTimer: null,
    unbindChunk,
    unbindDone,
    unbindError,
    // 空闲超时：60 秒无 chunk 自动清理（每次收到 chunk 续期）
    timeoutHandle: setTimeout(() => {
      if (activeStream?.requestId === requestId) {
        window.api.ai.cancelChat(requestId).catch(() => { /* ignore */ })
        cleanupActiveStream()
        set({ isStreaming: false, currentRequestId: null, error: '请求超时' })
        onError?.('请求超时')
      }
    }, STREAM_IDLE_TIMEOUT_MS),
  }

  // 构建 instruct 模板：预设显式指定 > profile 自动推断
  const instructTemplate = resolveEffectiveTemplate(
    preset?.contextTemplate,
    profile.provider,
    settings.activeModel || profile.model,
    profile.useInstructTemplate,
  )

  const params: ChatParams = {
    requestId,
    messages: contextMessages,
    provider: vision?.provider ?? profile.provider,
    apiKey: vision?.apiKey ?? profile.apiKey,
    baseUrl: vision?.baseUrl ?? profile.baseUrl,
    model: effectiveModel,
    temperature: preset?.temperature ?? 0.8,
    topP: preset?.topP ?? 0.95,
    maxTokens: preset?.maxTokens ?? 1024,
    frequencyPenalty: preset?.frequencyPenalty ?? 0,
    presencePenalty: preset?.presencePenalty ?? 0,
    stream: settings.streamOutput,
    instructTemplate,
  }

  try {
    await window.api.ai.chat(params)
  } catch (e) {
    unbindChunk()
    unbindDone()
    unbindError()
    if (activeStream?.flushTimer) clearTimeout(activeStream.flushTimer)
    if (activeStream?.timeoutHandle) clearTimeout(activeStream.timeoutHandle)
    activeStream = null
    const errMsg = friendlyError((e as Error).message)
    set({ isStreaming: false, currentRequestId: null, error: errMsg })
    onError?.(errMsg)
  }
}

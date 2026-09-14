import { nanoid } from 'nanoid'
import type { AIFinishReason, Character, Preset, ChatParams, MemoryFactRecord, NarrativeMode, GenerationTerminationCause } from '../../shared/types'
import { finalizeGenerationTerminalResult, type GenerationTerminalOutcome } from './generatedReplyPipeline'
import {
  createGenerationTerminationLatch,
  terminationCauseFromFinishReason,
  terminationPromptWithoutContent,
  type GenerationTerminationLatch,
} from '../../shared/generationTermination'
import { mergeTailRepair, type FinalizedAssistantOutput } from '../../shared/assistantOutputFinalizer'
import { enabledProfileOverride, formatRequestBudgetRisk, resolveRequestBudget } from '../../shared/modelOutputProfile'
import { BACKGROUND_GENERATION_PROFILES, hasCompleteSummaryTail } from '../../shared/backgroundGeneration'
import { stripAllThinking } from '../../shared/thoughtMarkup'
import { useSettingsStore } from './useSettingsStore'
import { cachedReasoningSamplesFor, prefetchUsageProfile } from './usageProfileCache'
import { resolveReasoningGate, type ReasoningGateLevel } from '../../shared/reasoningGate'
import {
  claimGateBreakerNotice,
  isGateBreakerTripped,
  noteGateRecoveryFailure,
  noteGateRecoverySuccess,
  resolveChatGateLevel,
} from './reasoningGateState'
import { nextRecoveryLevel, resolveEmptyOutputRecovery, resolveGateRecoveryBudget } from './gateRecovery'
import type { AIErrorPayload } from '../../shared/ipc-api'
import type { BuiltChatContext } from './chatContext'
import { estimateTokens } from '../utils/tokenCounter'
import { countChars } from '../utils/charCounter'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { replaceVariables } from '../utils/variables'
import { resolveEffectiveTemplate } from '../utils/chatTemplates'
import { collectStopStrings, findStopIndex } from '../utils/regex'
import { trimContinuationOverlap } from '../utils/messagePostProcess'
import { lorebookCache } from '../utils/lorebook'
import type { BudgetLoreItem } from '../utils/lorebook'
import { logError, logInfo, logWarn } from '../lib/logger'
import { safeFire } from '../lib/safeOps'
import {
  STREAM_THROTTLE_MS,
  STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_LOREBOOK_SCAN_DEPTH,
  SEMANTIC_SCAN_MAX_TOKENS,
  resolveLorebookScanDepth,
} from './chatConstants'
import { buildSemanticCacheKey, friendlyError, semanticCacheGet, semanticCacheSet } from './chatUtils'
import { resolveVisionModel } from '../utils/visionModel'
import { memoryFactsToTexts } from '../utils/memory'
import type { ChatState, StoreGet, StoreSet } from './chatTypes'

// ===================== 流式状态管理（模块级，避免渲染抖动） =====================

/**
 * 阶段3：一次生成的结束元数据，随 onComplete 传给消息落盘方。
 * notice 区分"已恢复"（中性提示）与 repairFailed（失败提示，走 generationError 展示）。
 */
export interface GenerationOutcomeMeta {
  finishReason: AIFinishReason
  /** 收尾提示：trimmed_to_boundary（回退到稳定句界）/ tail_repaired（自动补尾成功）/ partial_network_output（网络中断保留） */
  notice?: 'trimmed_to_boundary' | 'tail_repaired' | 'partial_network_output'
  /** 用户手动停止 */
  stopped?: boolean
  /** 补尾失败：已保留稳定前缀，展示可重试提示 */
  repairFailed?: boolean
  /** 阶段6灰度：本轮走旧链路（调用方恢复 normalize 前缀、不标记语义分块） */
  legacy?: boolean
  /** 阶段7：应用层终止原因（与 finishReason 分离，供观测与界面分类，不改变正文） */
  terminationCause?: GenerationTerminationCause
}

/** 阶段7：异常终止收口后随错误派发给调用方的可保存部分正文（已经过统一收尾管线） */
export interface GenerationTerminalPartial {
  content: string
  noticeFields: { generationNotice?: string; generationError?: string }
  terminationCause: GenerationTerminationCause
  /** 阶段6灰度：本轮走旧链路时，落盘方不得标记语义分块 */
  legacy?: boolean
}

/** 阶段3：把收尾元数据映射为消息提示字段——"已恢复"走中性提示，失败走 generationError */
// 映射实现已抽到 shared/generationNotice.ts，供 Bridge 与渲染层共用（这里保持原导入路径兼容）
export { finalizeNoticeFields } from '../../shared/generationNotice'

/** 当前正在流式生成的消息 ID（用户手动停止时标记提示用） */
export function getActiveStreamMessageId(): string | null {
  return activeStream?.aiMessageId ?? null
}

interface StreamState {
  requestId: string
  aiMessageId: string
  accumulated: string
  flushTimer: ReturnType<typeof setTimeout> | null
  unbindChunk: () => void
  unbindDone: () => void
  unbindError: () => void
  timeoutHandle: ReturnType<typeof setTimeout> | null
  /** 阶段7：requestId + terminalState 一次性终止状态机（迟到事件幂等） */
  latch: GenerationTerminationLatch
  /** 阶段7：停止字符串命中截断（随后主进程 done 的 cancelled 不得视为用户停止） */
  stopStringsHit: boolean
}

let activeStream: StreamState | null = null

/**
 * 阶段7：用户手动停止的统一入口——抢占终止状态机并返回当前可见正文。
 * stopStreaming 据此保存"用户已经看到的正文"；claim 失败（已进入 finalizing/persisted）
 * 返回 null，调用方不得再触碰该消息；后续迟到 chunk/done/error 全部被状态机忽略。
 */
export function claimUserStop(): { requestId: string; aiMessageId: string; content: string } | null {
  const st = activeStream
  if (!st) return null
  if (!st.latch.claim('user_cancel')) return null
  const result = { requestId: st.requestId, aiMessageId: st.aiMessageId, content: st.accumulated }
  cleanupActiveStream()
  return result
}

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
    set({ _semanticLoreHits: [], _semanticLoreAvailable: false })
  }
  // 快速失败：未启用 / 未配置 / 无激活世界书
  if (!st?.enabled || !st.model?.trim() || (st.provider !== 'local' && !st.baseUrl?.trim())) return clear()
  const lorebookIds = get().activeLorebookIds
  if (lorebookIds.length === 0) return clear()

  // 语义扫描范围：按 token 预算自适应（上限 4000 token，下限 scanDepth 条），大上下文下判断范围更广
  const scanDepth = resolveLorebookScanDepth(
    lorebookIds.map(id => lorebookCache.get(id)?.scanDepth),
    DEFAULT_LOREBOOK_SCAN_DEPTH,
  )
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
  const cacheKey = buildSemanticCacheKey({
    scope: 'lore',
    corpus: [...lorebookIds].sort().join(','),
    query: scanText,
    provider: st.provider,
    baseUrl: st.baseUrl,
    model: st.model,
    threshold: st.threshold,
    maxResults: st.maxResults,
  })
  const cached = semanticCacheGet<BudgetLoreItem[]>(cacheKey)
  if (cached) {
    set({ _semanticLoreHits: cached, _semanticLoreAvailable: true })
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
      // 阶段二：保留相似度与条目定位键（统一评分 / recency 加权用）
      score: h.score,
      key: `${h.lbId}:${h.id}`,
      // 阶段三：手写摘要（预算紧张时代替全文注入）
      summary: h.summary?.trim() ? replaceVariables(h.summary, settings.userName, character.name) : undefined,
    }))
    set({ _semanticLoreHits: items, _semanticLoreAvailable: true })
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
  if (!st?.enabled || !st.model?.trim() || (st.provider !== 'local' && !st.baseUrl?.trim())) return clear()

  const { sessions, currentSessionId } = get()
  const session = sessions.find((s) => s.id === currentSessionId)
  const factTexts = memoryFactsToTexts(session?.memoryFacts)
  if (!session?.memoryEnabled || !factTexts.length) return clear()
  const vectors = session.factsVectors
  if (!vectors || vectors.length !== factTexts.length
    || session.factsVectorVersion !== session.memoryVersion) return clear()

  // 查询文本：最近消息（与语义扫描一致，简化取最近 20 条）
  const query = get().messages.slice(-20).map((m) => m.content).join(' ')
  if (!query.trim()) return clear()

  // 缓存：同一轮对话查询不变时复用（省嵌入 API 调用）
  const cacheKey = buildSemanticCacheKey({
    scope: 'facts',
    corpus: `${session.id}:${session.memoryVersion ?? 0}:${session.factsVectorVersion ?? 0}`,
    query,
    provider: st.provider,
    baseUrl: st.baseUrl,
    model: st.model,
    threshold: st.threshold,
    maxResults: st.maxResults,
  })
  const cached = semanticCacheGet<import('../../shared/ipc-api').FactSearchHit[]>(cacheKey)
  if (cached) {
    set({ _semanticFactsHits: cached })
    return
  }

  try {
    const hits = await window.api.embedding.searchFacts({
      query,
      facts: factTexts,
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
    // 阶段三：检索排序（0.5语义+0.3新近+0.2重要性）
    let rankedHits = (hits ?? []).map((hit, index) => typeof hit === 'string'
      ? { text: hit, index, score: 0 }
      : hit)
    if (rankedHits.length > 0 && session.memoryFacts) {
      try {
        const { scoreAndRankFacts, memoryFactToText } = await import('../utils/memory')
        const matched = rankedHits
          .map((hit) => ({ hit, fact: (session.memoryFacts as import('../../shared/types').MemoryFactRecord[]).find((fact) => memoryFactToText(fact) === hit.text) }))
          .filter((item): item is { hit: import('../../shared/ipc-api').FactSearchHit; fact: import('../../shared/types').MemoryFactRecord } => Boolean(item.fact))
        if (matched.length > 0) {
          const ranked = scoreAndRankFacts(matched.map((item) => item.fact), matched.map((item) => item.hit.score))
          const scoreByText = new Map(matched.map((item) => [memoryFactToText(item.fact), item.hit]))
          rankedHits = ranked.map((item) => scoreByText.get(memoryFactToText(item.fact))!).filter(Boolean)
        }
      } catch { /* 排序失败回退原始 hits */ }
    }
    set({ _semanticFactsHits: rankedHits })
    semanticCacheSet(cacheKey, rankedHits)
  } catch {
    clear()
  }
}

/**
 * 记忆事实向量化（P0-2）：保存事实后异步嵌入并存入会话，供语义检索注入。
 */
export async function vectorizeSessionFacts(
  characterId: string,
  sessionId: string,
  facts: MemoryFactRecord[],
  memoryVersion: number,
): Promise<void> {
  const factTexts = memoryFactsToTexts(facts)
  if (!factTexts.length) return
  const st = useSettingsStore.getState().settings.semanticTrigger
  if (!st?.enabled || !st.model?.trim() || (st.provider !== 'local' && !st.baseUrl?.trim())) return
  try {
    const vectors = await window.api.embedding.embedFacts({
      provider: st.provider,
      baseUrl: st.baseUrl,
      model: st.model,
      apiKey: st.apiKey ?? '',
    }, factTexts)
    if (vectors.length === factTexts.length) {
      // 即使旧请求晚到，也会携带旧版本；上下文构建器会拒绝版本不匹配的向量。
      await window.api.chat.updateSession(characterId, sessionId, {
        factsVectors: vectors,
        factsVectorVersion: memoryVersion,
      })
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
  // 阶段7（§7.3）：历史压缩按 background 'compression' 档案执行——
  // 触顶或无完整摘要边界时丢弃本次结果（原历史照常保留），不做补尾
  const compressionProfile = BACKGROUND_GENERATION_PROFILES.compression
  const unbindDone = window.api.ai.onComplete((payload) => {
    if (payload.requestId !== requestId) return
    cleanup()
    finished = true
    const summary = stripAllThinking(result)
    const truncated = payload.finishReason === 'length' || !hasCompleteSummaryTail(summary)
    if (summary && !truncated) {
      window.api.chat.updateSession(character.id, pending.sessionId, {
        compressedSummary: summary,
        compressedRange: { startTs: pending.droppedStartTs, endTs: pending.droppedEndTs },
      }).then(async () => {
        const sessions = await window.api.chat.listSessions(character.id)
        set({ sessions })
        logInfo('compressDroppedHistory', `早期对话已压缩（${summary.length} 字，范围 ${new Date(pending.droppedStartTs).toLocaleString()} 起）`)
      }).catch((e) => logError('StreamController:compressSummary', e))
    } else if (summary) {
      logWarn('compressDroppedHistory', '压缩结果结构不完整（触顶或缺少摘要边界），本次丢弃，原历史保持不变')
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
    // 后台任务档案：正文预算 + 推理余量分离估算（不再无条件请求 600/大值）
    maxTokens: resolveRequestBudget({
      model: settings.activeModel || profile.model,
      hardMaxChars: compressionProfile.expectedBodyChars,
      profileOverride: enabledProfileOverride(profile.capabilityOverride),
    }).requestMaxTokens,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stream: true,
    observability: { source: 'aux', taskType: 'compression', characterId: character.id, sessionId: pending.sessionId },
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
  // 阶段7（§7.3）：标题 = background 'title' 档案——小预算、触顶丢弃（保持旧标题）、不补尾
  const unbindDone = window.api.ai.onComplete((payload) => {
    if (payload.requestId !== requestId) return
    cleanup()
    finished = true
    if (payload.finishReason === 'length') {
      logWarn('maybeAutoTitle', '标题生成触顶（推理模型可能耗尽预算），丢弃结果并保留旧标题')
      return
    }
    const title = stripAllThinking(result).replace(/[\n\r"「」『』]/g, '').trim().slice(0, 20)
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
    observability: { source: 'aux', taskType: 'title', characterId: character.id, sessionId: session.id },
  }).catch(() => {
    cleanup()
    if (!finished) { /* 静默 */ }
  })
}

/**
 * 阶段7（§8.1）：补尾取消与降级治理。
 * - 补尾期间用户点击停止 → abortActiveTailRepair 立即取消补尾并保留稳定前缀；
 * - 同一模型连续补尾失败两次 → 本次会话暂时关闭自动补尾（提示重新生成，由调用方 notice 展示）。
 * 用户取消不计入失败次数（它不是模型能力问题）。
 */
let activeRepairAbort: (() => void) | null = null
export function abortActiveTailRepair(): boolean {
  if (!activeRepairAbort) return false
  activeRepairAbort()
  return true
}

const tailRepairFailures = new Map<string, number>()
const TAIL_REPAIR_FAILURE_LIMIT = 2
/** 测试与诊断用：读取某模型当前连续补尾失败次数 */
export function getTailRepairFailureCount(model: string): number {
  return tailRepairFailures.get(model) ?? 0
}
/** 测试用：重置降级计数（真实会话内自然累积，无运行时重置入口） */
export function resetTailRepairFailureCounts(): void {
  tailRepairFailures.clear()
}

/**
 * 阶段3：一次短补尾（方案 §5.3）。
 * 仅携带末段上下文与角色名，独立非流式请求；合并时复用重叠去重并复检完整性。
 * 调用方保证每轮至多一次（needs_tail_repair 分支只走一次）。
 */
export async function attemptTailRepair(input: {
  /** 收尾器输出（repairContext + 稳定前缀 + 诊断），合并与复检统一走 mergeTailRepair */
  finalized: FinalizedAssistantOutput
  character: Character
  model: string
  temperature?: number
  reasoningMode?: 'default' | 'disabled'
  sessionId?: string | null
}): Promise<string | null> {
  // 补尾限制（§8.1）：不重新发送完整世界书与长历史（只带 repairContext）；
  // 同一模型连续失败两次后本次会话不再自动补尾。
  if ((tailRepairFailures.get(input.model) ?? 0) >= TAIL_REPAIR_FAILURE_LIMIT) {
    logWarn('attemptTailRepair', `模型 ${input.model} 连续补尾失败，本次会话关闭自动补尾，请重新生成`)
    return null
  }
  const settingsStore = useSettingsStore.getState()
  const profile = settingsStore.getActiveProfile()
  if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
    return null
  }

  const requestId = `repair-${nanoid()}`
  const charName = input.character.translatedContent?.name || input.character.name
  // 补尾预算：正文 ~200 字 + 模型推理余量（方案 §5.3：160–256 Token 正文 + 推理余量）
  // W1（主计划 §7.3）：补尾与主生成共用同一分桶的近期样本（主生成已预取，命中缓存）
  const repairSamples = cachedReasoningSamplesFor({
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: input.model,
  })
  const budget = resolveRequestBudget({
    model: input.model,
    hardMaxChars: 200,
    profileOverride: enabledProfileOverride(profile.capabilityOverride),
    ...(repairSamples ? { recentReasoningTokens: repairSamples } : {}),
  })
  let repairText = ''
  let settled = false
  let userAborted = false

  return new Promise<string | null>((resolve) => {
    const cleanup = () => {
      unbindChunk()
      unbindDone()
      unbindError()
      if (activeRepairAbort === abortFn) activeRepairAbort = null
    }
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      // 降级计数（§8.1）：成功清零，失败累加；用户取消不计失败
      if (!userAborted) {
        if (value) tailRepairFailures.delete(input.model)
        else tailRepairFailures.set(input.model, (tailRepairFailures.get(input.model) ?? 0) + 1)
      }
      // 无论成功/失败/取消，都释放监听与取消句柄（避免旧补尾句柄泄漏给下一次请求）
      cleanup()
      resolve(value)
    }
    const abortFn = () => {
      userAborted = true
      finish(null)
    }
    activeRepairAbort = abortFn
    // 60s 兜底：补尾卡死按失败处理，不阻塞主流程
    const timeout = setTimeout(() => finish(null), STREAM_IDLE_TIMEOUT_MS)

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      repairText += data.text
    })
    const unbindDone = window.api.ai.onComplete((payload) => {
      if (payload.requestId !== requestId) return
      clearTimeout(timeout)
      cleanup()
      // 合并与复检统一走 shared mergeTailRepair（重叠去重 + 完整性复检 + 失败回退稳定前缀）
      const merged = mergeTailRepair({
        finalized: input.finalized,
        repairText,
        trimOverlap: trimContinuationOverlap,
        finishReason: payload.finishReason === 'length' ? 'length' : 'stop',
      })
      if (merged.notice !== 'tail_repaired' || !merged.content) {
        logWarn('attemptTailRepair', '补尾合并后仍不完整，保留稳定前缀')
        return finish(null)
      }
      finish(merged.content)
    })
    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      clearTimeout(timeout)
      cleanup()
      logWarn('attemptTailRepair', `补尾请求失败：${data.error}`)
      finish(null)
    })

    window.api.ai.chat({
      requestId,
      messages: [
        {
          role: 'system',
          content: '请只补完下面这条回复的最后一句，并在 30–100 个汉字内自然结束本轮。不要复述已有内容，不新增事件、人物、地点或第二轮对白，不写标题或说明。只输出需要接在末尾的新文字。',
        },
        { role: 'user', content: `【角色】${charName}\n【已生成的回复结尾】\n${input.finalized.repairContext}` },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: input.model,
      temperature: input.temperature ?? 0.8,
      topP: 0.95,
      maxTokens: budget.requestMaxTokens,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
      reasoningMode: input.reasoningMode,
      observability: {
        source: 'single',
        // quiet = 归属主生成任务的内部补尾请求，基线统计按辅助口径过滤
        generationType: 'quiet',
        characterId: input.character.id,
        sessionId: input.sessionId ?? undefined,
      },
    }).catch(() => {
      clearTimeout(timeout)
      cleanup()
      finish(null)
    })
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
    narrativeMode?: NarrativeMode  // 续写时继承目标消息的叙事身份
    generationType?: 'normal' | 'continue' | 'impersonate' | 'swipe' | 'regenerate' | 'quiet'
    inputText?: string   // 用户输入文本（用于字符统计），regenerate/continue 时为空
    /**
     * 阶段8（§4.5）：降档恢复专用。提供时跳过预取与上下文重建（复用同一快照），
     * 只按新档位重算预算字段；`gateRecoveryUsed` 保证同一逻辑请求最多恢复一次。
     */
    prebuilt?: BuiltChatContext
    gateLevel?: ReasoningGateLevel
    gateRecoveryUsed?: boolean
    /** 本次物理请求是否属于门控降档重试（写入观测，归属原生成轮） */
    markDowngradeRetry?: boolean
    onComplete: (fullContent: string, meta: GenerationOutcomeMeta) => Promise<void>
    /**
     * 阶段7：异常统一派发。terminal 为经过统一收尾管线的可保存部分正文
     * （含 generationNotice/generationError 字段）；缺省 = 无可用正文，
     * 调用方不得保存空 AI 消息或把错误文案写进 content。
     */
    onError?: (errMsg: string, terminal?: GenerationTerminalPartial) => void
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
  let streamRegexRules: import('../../shared/types').RegexRule[] = []
  try {
    streamRegexRules = await window.api.regex.list()
    stopStrings = collectStopStrings(streamRegexRules)
  } catch { /* 忽略 */ }

  // 阶段一「对话输出弹性约束」：上下文组装与请求预算在同一次构建中计算，
  // requestMaxTokens 同时作为上下文输出预留与请求 max_tokens，禁止二次推导。
  // 阶段8（§4.2/§4.5）：主对话档位（kill switch 默认关闭；熔断后从更低档起步）；
  // 传入预算后推理项取 gateTokens，正文空间获得可预期的保证。
  const budgetModel = settings.activeModel || profile.model
  const chatGateLevel = opts.gateLevel
    ?? resolveChatGateLevel({ settings, provider: profile.provider, baseUrl: profile.baseUrl, model: budgetModel })
  const chatGate = chatGateLevel
    ? resolveReasoningGate({ model: budgetModel, requestedLevel: chatGateLevel, enabled: true })
    : undefined
  const gateScope = { provider: profile.provider, baseUrl: profile.baseUrl, model: budgetModel }
  // W1（主计划 §7.3）：构建前异步预取该端点/模型的近期推理样本；失败静默，
  // 预算退回档案默认余量（不阻塞、不改变请求可发送性）。
  // 降档恢复（prebuilt 在场）复用同一上下文快照，不再预取与重建。
  if (!opts.prebuilt) {
    await prefetchUsageProfile({
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: budgetModel,
    })
  }
  const builtContext: BuiltChatContext = opts.prebuilt ?? get().buildContext(character, preset, {
    continuation: opts.continuation,
    narrativeMode: opts.narrativeMode,
    generationType: opts.generationType ?? (opts.continuation ? 'continue' : 'normal'),
    ...(chatGate ? { reasoningGate: chatGate } : {}),
  })
  const contextMessages = builtContext.messages

  // 明确的低硬上限在推理共享模型上会稳定制造“推理吃满、正文为零”。
  // 不发起已知高风险请求，也不靠盲目重试浪费额度；保留用户消息并给出可操作提示。
  const budgetRisk = formatRequestBudgetRisk(builtContext.requestBudget)
  if (budgetRisk) {
    logWarn('StreamController:budget', budgetRisk)
    set({ isStreaming: false, currentRequestId: null, error: budgetRisk })
    onError?.(budgetRisk)
    return
  }

  // Vision：上下文含图片且配置了激活识图模型 → 本轮使用识图模型连接（未填字段回退当前 Profile）。
  // 连接参数可被识图模型覆盖，但正文预算沿用同一 requestMaxTokens（篇幅策略不变）。
  const vision = resolveVisionModel(contextMessages)
  const effectiveModel = vision?.model ?? (settings.activeModel || profile.model)

  const requestId = nanoid()
  // 阶段7：requestId 级一次性终止状态机——只有 streaming 能进入某个终止分支；
  // 进入 finalizing 后忽略迟到 chunk/done/error，同一 requestId 最多落盘一次。
  const latch = createGenerationTerminationLatch(requestId)

  set({ isStreaming: true, currentRequestId: requestId, error: null })

  const characterDisplayName = character.translatedContent?.name || character.name

  /**
   * 阶段7：终止派发（唯一出口）。错误文案只进 store.error 与 generationError，
   * 绝不拼入 content；可保存的部分正文必须已经过 finalizeGenerationTerminalResult。
   */
  const dispatchTerminalError = (
    cause: GenerationTerminationCause,
    result: GenerationTerminalOutcome | null,
    detailMessage: string,
  ) => {
    if (activeStream?.requestId === requestId) cleanupActiveStream()
    const errText = result?.noticeFields.generationError
      ?? terminationPromptWithoutContent(cause, detailMessage)
    set({ isStreaming: false, currentRequestId: null, error: detailMessage || errText })
    // N26 修复：流式失败时同样执行待处理的上下文压缩（与 done 分支一致），
    // 避免 pendingCompression 残留导致裁剪历史永远不被压缩
    if (pendingCompression) {
      const pc = pendingCompression
      pendingCompression = null
      compressDroppedHistory(get, set, character, pc).catch((e) => logError('ChatStore:compress', e))
    }
    latch.markPersisted()
    const terminal: GenerationTerminalPartial | undefined =
      result && result.persistable && result.content
        ? {
            content: result.content,
            noticeFields: result.noticeFields,
            terminationCause: cause,
            legacy: builtContext.pipelineLegacy,
          }
        : undefined
    onError?.(errText, terminal)
  }

  /**
   * 阶段7：异常终止统一收口入口（desktop timeout、普通 ai:error、Bridge 侧复用同一协调函数）。
   * 部分正文一律先进共享最终处理管线（稳定边界收束、不补尾），再交给派发出口。
   */
  const finalizeExceptionTerminal = async (
    cause: GenerationTerminationCause,
    rawText: string,
    detailMessage: string,
  ) => {
    try {
      const result = await finalizeGenerationTerminalResult({
        terminalResult: { rawText, finishReason: 'unknown', terminationCause: cause, errorMessage: detailMessage },
        regexRules: streamRegexRules,
        characterName: characterDisplayName,
        legacy: builtContext.pipelineLegacy,
      })
      dispatchTerminalError(cause, result, detailMessage)
    } catch (e) {
      logError('StreamController:terminalFinalize', e)
      dispatchTerminalError(cause, null, detailMessage)
    }
  }

  /**
   * 阶段8（§4.5）+ G1 取证后收口：复用同一上下文快照重发一次。
   * - `level` 提供时为该档位（降档或同档零输出重试），undefined = 沿用原档（未使用门控）；
   * - 只重算档位与预算字段，历史/记忆/世界书不重新裁剪（§4.2 同一份候选快照）；
   * - 由调用侧置 `gateRecoveryUsed`，保证同一逻辑请求最多重发一次。
   */
  const runRecoveryRetry = async (decision: {
    level?: ReasoningGateLevel
    downgrade: boolean
  }): Promise<void> => {
    const samples = cachedReasoningSamplesFor({
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: budgetModel,
    })
    const nextBudget = decision.level
      ? resolveGateRecoveryBudget({
          model: budgetModel,
          hardMaxChars: builtContext.responsePolicy.hardMaxChars,
          userHardCap: preset?.maxTokens,
          profileOverride: enabledProfileOverride(profile.capabilityOverride),
          ...(samples ? { recentReasoningTokens: samples } : {}),
          level: decision.level,
        })
      : builtContext.requestBudget
    await streamAIResponse(set, get, {
      ...opts,
      prebuilt: {
        ...builtContext,
        requestBudget: nextBudget,
        requestMaxTokens: nextBudget.requestMaxTokens,
      },
      gateLevel: decision.level,
      gateRecoveryUsed: true,
      // 同档零输出重试不是降档：不写 downgradeRetry，避免观测把它记成降档
      ...(decision.downgrade ? { markDowngradeRetry: true } : {}),
      onComplete: async (content, meta) => {
        noteGateRecoverySuccess(gateScope)
        return onComplete(content, meta)
      },
      onError: (msg, terminal) => {
        // 熔断只统计"降档仍失败"；同档零输出重试失败不改变后续起步档
        if (decision.downgrade) noteGateRecoveryFailure(gateScope)
        const text = decision.downgrade && isGateBreakerTripped(gateScope) && claimGateBreakerNotice(gateScope)
          ? `${msg}
该模型已连续降档失败，后续请求将从更低思考强度开始。`
          : msg
        onError?.(text, terminal)
      },
    })
  }

  /**
   * 阶段7：空闲超时统一处理——初始计时与 chunk 续期计时都只走本函数。
   * 规则：先读取完整 accumulated 文本，再清理监听器（cleanupActiveStream 同步合并未执行的 flush）。
   */
  const fireIdleTimeout = () => {
    const st = activeStream
    if (!st || st.requestId !== requestId) return
    if (!st.latch.claim('idle_timeout')) return
    const partial = st.accumulated
    cleanupActiveStream()
    window.api.ai.cancelChat(requestId, 'timeout').catch(() => { /* ignore */ })
    void finalizeExceptionTerminal('idle_timeout', partial, '请求超时')
  }

  const onChunk = (data: { requestId: string; text: string }) => {    if (data.requestId !== requestId) return
    if (!activeStream || activeStream.requestId !== requestId) return
    // 迟到 chunk：已有终止分支抢占（finalizing/persisted/cancelled/failed）后忽略
    if (!activeStream.latch.acceptsStreamEvent()) return
    activeStream.accumulated += data.text
    // 停止字符串：命中后截断并提前终止（主进程取消后发 ai:done，按正常 stop 进统一收尾管线）
    if (stopStrings.length > 0) {
      const idx = findStopIndex(activeStream.accumulated, stopStrings)
      if (idx !== -1) {
        activeStream.accumulated = activeStream.accumulated.slice(0, idx).trimEnd()
        activeStream.stopStringsHit = true
        if (activeStream.flushTimer) {
          clearTimeout(activeStream.flushTimer)
          activeStream.flushTimer = null
        }
        flushStream(set)
        window.api.ai.cancelChat(requestId, 'stop_string').catch(() => {})
        return
      }
    }
    // 节流：避免每个 chunk 都触发 set
    if (activeStream.flushTimer === null) {
      activeStream.flushTimer = setTimeout(() => flushStream(set), STREAM_THROTTLE_MS)
    }
    // 空闲超时续期：收到 chunk 即重置 60s 计时（卡死时更快恢复）
    if (activeStream.timeoutHandle) clearTimeout(activeStream.timeoutHandle)
    activeStream.timeoutHandle = setTimeout(fireIdleTimeout, STREAM_IDLE_TIMEOUT_MS)
  }

  const unbindChunk = window.api.ai.onChunk(onChunk)

  const unbindDone = window.api.ai.onComplete((payload) => {
    const { requestId: doneId, finishReason = 'unknown' } = payload
    if (doneId !== requestId) return
    const rawContent = activeStream?.accumulated ?? ''
    const stopStringsHit = activeStream?.stopStringsHit === true
    // 阶段7：供应商 finishReason 与应用层 terminationCause 分离映射；
    // 停止字符串命中后主进程发的 cancelled 按正常 stop 收束，不是用户停止。
    // 阶段8（§4.4/§4.7）：主进程的提前中止以结构化元数据下发，不再靠错误文本推断
    const cause: GenerationTerminationCause = finishReason === 'cancelled'
      ? (stopStringsHit ? 'provider_stop' : 'user_cancel')
      : (payload.terminationCause ?? terminationCauseFromFinishReason(finishReason))
    // 迟到 done（timeout/error 分支已抢占）直接忽略，防止超时收口结果被覆盖
    if (!latch.claim(cause)) return
    // 先读取完整 accumulated 再清理监听器（未执行的 flush timer 同步合并于 cleanup 前的读取）
    cleanupActiveStream()

    // 阶段8（§4.5）：空正文 + 推理挤占 → 降一档恢复一次（复用同一上下文快照，仅重算预算）。
    // 有正文的 length / 用户停止 / 已恢复过 / 无更低档位都不触发。
    const recoveryLevel = nextRecoveryLevel({
      terminationCause: payload.terminationCause,
      finishReason,
      rawText: rawContent,
      usage: payload.usage,
      currentLevel: chatGate?.level,
      recoveryUsed: opts.gateRecoveryUsed === true || stopStringsHit,
    })

    // S1：统一收尾管线——推理清理 → output 正则 → 停止字符串 → 收尾器 → 一次短补尾。
    // 阶段6灰度：legacy 管线在管线内部原样透传（不做收尾器与补尾）。
    void (async () => {
      if (recoveryLevel) {
        // 复用同一上下文与消息：只把档位与预算字段换成降档后的值，历史不重复裁剪
        await runRecoveryRetry({ level: recoveryLevel, downgrade: true })
        return
      }
      let contentForComplete = rawContent
      const meta: GenerationOutcomeMeta = { finishReason, legacy: builtContext.pipelineLegacy, terminationCause: cause }
      if (cause === 'user_cancel') {
        // 用户手动停止：保留用户已经看到的正文，不收尾、不补尾（矩阵 §4.1）
        meta.stopped = true
        if (!contentForComplete.trim()) {
          dispatchTerminalError(cause, null, friendlyError('模型未返回任何内容，请重试或检查模型是否可用'))
          return
        }
      } else {
        const result = await finalizeGenerationTerminalResult({
          terminalResult: { rawText: rawContent, finishReason, terminationCause: cause },
          regexRules: streamRegexRules,
          characterName: characterDisplayName,
          legacy: builtContext.pipelineLegacy,
          // 补尾限制（§8.1）：协调入口只在 provider_length 且稳定正文不足时调用，每轮至多一次
          runTailRepair: settings.autoTailRepairEnabled === false ? undefined : (finalized) => attemptTailRepair({
            finalized,
            character,
            model: effectiveModel,
            temperature: preset?.temperature,
            reasoningMode: effectiveModel.toLowerCase().includes('deepseek-v4') ? 'disabled' : undefined,
            sessionId: get().currentSessionId,
          }),
        })
        if (!result.persistable || !result.content) {
          // 无正文：按真实错误处理，不创建空消息（方案 §5.1）
          dispatchTerminalError(cause, result, friendlyError('模型未返回任何内容，请重试或检查模型是否可用'))
          return
        }
        contentForComplete = result.content
        if (result.status !== 'raw') {
          if (result.notice) meta.notice = result.notice
          if (result.repairFailed) meta.repairFailed = true
        }
      }

      // 字符用量统计：精确计算输入和输出字符数（model 记录实际使用的模型，含识图模型切换）
      const model = effectiveModel
      const outputChars = countChars(contentForComplete).total
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

      set({ isStreaming: false, currentRequestId: null })
      latch.markPersisted()
      // 异步执行完成回调（携带收尾元数据）
      await onComplete(contentForComplete, meta).catch((e) => logError('ChatStore:onComplete', e))

      // 上下文溢出压缩：本轮结束后异步压缩被裁剪的早期对话（不阻塞）
      if (pendingCompression) {
        const pc = pendingCompression
        pendingCompression = null
        compressDroppedHistory(get, set, character, pc).catch((e) => logError('ChatStore:compress', e))
      }
      // 会话标题自动生成（P1-4）：新会话第 4 条用户消息后
      maybeAutoTitle(get, set, character)
    })().catch((e) => {
      logError('StreamController:doneTerminal', e)
      if (!latch.acceptsStreamEvent()) return
      dispatchTerminalError('protocol_error', null, friendlyError((e as Error)?.message ?? String(e)))
    })
  })

  const unbindError = window.api.ai.onError((data: AIErrorPayload) => {
    if (data.requestId !== requestId) return
    const friendly = friendlyError(data.error)
    // 阶段7：普通 ai:error 接入统一异常收口——先抢占终止权并读取完整 accumulated，
    // 半截正文必须经过最终处理管线后才允许保存；迟到 error（done/timeout 已收口）只复位状态。
    const raw = activeStream?.accumulated ?? ''
    // G1 取证后收口：主进程把"零输出"（适配器零输出防御）与传输失败分开分类后，
    // 空正文允许一次恢复——有更低档位则降档，否则同档重试（deepseek-v4 的 off 已是末级）。
    const emptyOutputRecovery = latch.acceptsStreamEvent()
      ? resolveEmptyOutputRecovery({
          errorKind: data.errorKind,
          rawText: raw,
          currentLevel: chatGate?.level,
          recoveryUsed: opts.gateRecoveryUsed === true || activeStream?.stopStringsHit === true,
        })
      : null
    if (emptyOutputRecovery) {
      cleanupActiveStream()
      void runRecoveryRetry(emptyOutputRecovery).catch((e) => {
        logError('StreamController:emptyOutputRetry', e)
      })
      return
    }
    if (!latch.claim('transport_error')) {
      set({ isStreaming: false, currentRequestId: null, error: friendly })
      return
    }
    cleanupActiveStream()
    void finalizeExceptionTerminal('transport_error', raw, friendly)
  })

  activeStream = {
    requestId,
    aiMessageId,
    accumulated: '',
    flushTimer: null,
    unbindChunk,
    unbindDone,
    unbindError,
    latch,
    stopStringsHit: false,
    // 空闲超时：60 秒无 chunk 自动清理（每次收到 chunk 续期）；统一走 fireIdleTimeout 收口
    timeoutHandle: setTimeout(fireIdleTimeout, STREAM_IDLE_TIMEOUT_MS),
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
    maxTokens: builtContext.requestMaxTokens,
    frequencyPenalty: preset?.frequencyPenalty ?? 0,
    presencePenalty: preset?.presencePenalty ?? 0,
    stream: settings.streamOutput,
    instructTemplate,
    // 阶段0观测元数据：随请求透传，供主进程记录篇幅模式与生成类型（不影响请求行为）
    observability: {
      source: 'single',
      generationType: opts.generationType ?? (opts.continuation ? 'continue' : 'normal'),
      responseLengthMode: builtContext.responsePolicy.mode,
      hardMaxChars: builtContext.responsePolicy.hardMaxChars,
      ...(builtContext.requestBudget ? {
        plannedBodyTokens: builtContext.requestBudget.bodyReserve,
        plannedReasoningTokens: builtContext.requestBudget.reasoningReserve,
      } : {}),
      // S5：记录意图识别与场景系数，便于核对误判
      ...(builtContext.responseIntent ? { responseIntent: builtContext.responseIntent } : {}),
      ...(builtContext.pipelineLegacy ? {} : { sceneFactor: builtContext.sceneFactor }),
      characterId: character.id,
      sessionId: get().currentSessionId ?? undefined,
      ...(opts.markDowngradeRetry ? { downgradeRetry: true } : {}),
    },
    // DeepSeek V4 的推理通道会与角色心理描写重复，并挤占最终正文预算。
    // 主对话只保留模型最终 content；若聚合端忽略关闭参数，适配器仍会丢弃 reasoning_content。
    reasoningMode: effectiveModel.toLowerCase().includes('deepseek-v4') ? 'disabled' : undefined,
    // 阶段8（§4.3）：门控指令由预算结果反推——tokens 即本轮推理预留（可信=承诺值）
    ...(builtContext.requestBudget?.gate
      ? {
          reasoningGate: {
            level: builtContext.requestBudget.gate.level,
            knob: builtContext.requestBudget.gate.knob,
            tokens: builtContext.requestBudget.reasoningReserve,
          },
        }
      : {}),
  }

  try {
    await window.api.ai.chat(params)
  } catch (e) {
    // 发送即失败（IPC/协议层）：无正文可保存，统一走终止派发（不创建空 AI 消息）
    if (latch.claim('protocol_error')) {
      dispatchTerminalError('protocol_error', null, friendlyError((e as Error).message))
    }
  }
}

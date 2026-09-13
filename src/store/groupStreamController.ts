import { nanoid } from 'nanoid'
import type { AIFinishReason, GroupChat, GroupMessage, Character, MemoryFactRecord } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'
import { lorebookCache } from '../utils/lorebook'
import type { BudgetLoreItem } from '../utils/lorebook'
import { estimateTokens } from '../utils/tokenCounter'
import { countChars } from '../utils/charCounter'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { replaceVariables } from '../utils/variables'
import { resolveEffectiveTemplate } from '../utils/chatTemplates'
import { collectStopStrings, findStopIndex } from '../utils/regex'
import { logError, logInfo, logWarn } from '../lib/logger'
import { safeSave } from '../lib/safeOps'
import { STREAM_THROTTLE_MS, SEMANTIC_SCAN_MAX_TOKENS, STREAM_IDLE_TIMEOUT_MS, DEFAULT_LOREBOOK_SCAN_DEPTH, resolveLorebookScanDepth } from './chatConstants'
import { buildSemanticCacheKey, friendlyError, semanticCacheGet, semanticCacheSet } from './chatUtils'
import { resolveVisionModel } from '../utils/visionModel'
import { memoryFactsToTexts } from '../utils/memory'
import { stripVendorThinking } from '../utils/messagePostProcess'
import type { GroupChatState, GroupStoreGet, GroupStoreSet } from './groupChatTypes'
import { resolveNarrativeMode } from '../../shared/narrativeMode'
import { stripAllThinking } from '../../shared/thoughtMarkup'
import { formatRequestBudgetRisk, resolveRequestBudget } from '../../shared/modelOutputProfile'
import { resolveGroupRequestPlan } from './groupRequestPlan'
import { BACKGROUND_GENERATION_PROFILES, hasCompleteSummaryTail } from '../../shared/backgroundGeneration'
import { attemptTailRepair, finalizeNoticeFields, type GenerationOutcomeMeta } from './streamController'
import { prefetchUsageProfile, withReasoningSamples } from './usageProfileCache'
import {
  noteGateRecoveryFailure,
  noteGateRecoverySuccess,
  withReasoningGate,
} from './reasoningGateState'
import { nextRecoveryLevel } from './gateRecovery'
import type { ReasoningGateLevel } from '../../shared/reasoningGate'
import { finalizeGenerationTerminalResult, type GenerationTerminalOutcome } from './generatedReplyPipeline'
import {
  createGenerationTerminationLatch,
  terminationCauseFromFinishReason,
  terminationPromptWithoutContent,
  type GenerationTerminationLatch,
} from '../../shared/generationTermination'
import type { GenerationTerminationCause } from '../../shared/types'

// ====================== 流式状态管理（模块级） ======================

interface ActiveStream {
  requestId: string
  msgId: string
  accumulated: string
  flushTimer: ReturnType<typeof setTimeout> | null
  unbindChunk: () => void
  unbindDone: () => void
  unbindError: () => void
  timeoutHandle: ReturnType<typeof setTimeout> | null
  /** 阶段7：requestId + terminalState 一次性终止状态机（迟到事件幂等） */
  latch: GenerationTerminationLatch
  /** 阶段7：停止字符串命中截断（随后的 cancelled done 按正常 stop 收口，不是用户停止） */
  stopStringsHit: boolean
}

let activeStream: ActiveStream | null = null

/** 读取当前活动流（stopStreaming 等需要读取） */
export function getActiveStream(): ActiveStream | null {
  return activeStream
}

/**
 * 阶段7：用户手动停止的统一入口——抢占终止状态机并返回当前可见正文。
 * claim 失败（timeout/error/done 已进入收口）返回 null，调用方不得再触碰该消息；
 * 后续迟到 chunk/done/error 全部被状态机忽略，同一 requestId 最多落盘一次。
 */
export function claimGroupUserStop(): { requestId: string; msgId: string; accumulated: string } | null {
  const st = activeStream
  if (!st) return null
  if (!st.latch.claim('user_cancel')) return null
  const result = { requestId: st.requestId, msgId: st.msgId, accumulated: st.accumulated }
  cleanupActiveStream()
  return result
}

/** 群聊上下文溢出压缩：待执行任务（buildGroupContext 标记，流式完成后消费） */
interface PendingGroupCompression {
  groupId: string
  sessionId: string
  droppedText: string
  droppedStartTs: number
  droppedEndTs: number
}

let pendingGroupCompression: PendingGroupCompression | null = null

/** 供 buildGroupContext 标记压缩任务（上下文溢出时） */
export function markPendingGroupCompression(pc: PendingGroupCompression): void {
  pendingGroupCompression = pc
}

/** 轮询定时器 handle，用于切换/删除群聊时清理 */
let pollingTimer: ReturnType<typeof setTimeout> | null = null

export function cleanupActiveStream() {
  if (!activeStream) return
  clearTimeout(activeStream.flushTimer!)
  clearTimeout(activeStream.timeoutHandle!)
  activeStream.unbindChunk()
  activeStream.unbindDone()
  activeStream.unbindError()
  activeStream = null
}

/** 清理轮询定时器 */
export function clearPollingTimer() {
  if (pollingTimer !== null) {
    clearTimeout(pollingTimer)
    pollingTimer = null
  }
}

/** 群聊回复与单聊保持一致：丢弃供应商推理，保留角色 <thought> 供气泡折叠展示。 */
export function preserveGroupReplyContent(content: string): string {
  return stripVendorThinking(content).trim()
}

/**
 * 阶段4/7：群聊回复统一收尾（与单聊共用同一条协调入口，方案 §4.2 / §7.4）。
 * 返回 null 表示无可用正文（调用方走占位/错误分支）。
 */
export async function finalizeGroupReply(input: {
  rawText: string
  finishReason: AIFinishReason
  speaker: Character
  model: string
  temperature?: number
  regexRules: import('../../shared/types').RegexRule[]
  legacy?: boolean
}): Promise<{ content: string; noticeFields: { generationNotice?: string; generationError?: string }; stopped: boolean } | null> {
  const cause = terminationCauseFromFinishReason(input.finishReason)
  // 补尾限制（§8.1）：只有 provider_length 会被协调入口调用（每轮至多一次）
  const result = await finalizeGenerationTerminalResult({
    terminalResult: { rawText: input.rawText, finishReason: input.finishReason, terminationCause: cause },
    regexRules: input.regexRules,
    characterName: input.speaker.translatedContent?.name || input.speaker.name,
    legacy: input.legacy,
    runTailRepair: (finalized) => attemptTailRepair({
      finalized,
      character: input.speaker,
      model: input.model,
      temperature: input.temperature,
    }),
  })
  if (!result.persistable || !result.content) return null

  const meta: GenerationOutcomeMeta = { finishReason: input.finishReason }
  if (result.notice) meta.notice = result.notice
  if (result.repairFailed) meta.repairFailed = true
  // 异常类提示（协调入口生成）优先；正常收尾走 finalizeNoticeFields 统一口径
  const noticeFields = Object.keys(result.noticeFields).length > 0
    ? result.noticeFields
    : (input.legacy ? {} : finalizeNoticeFields(meta))
  return { content: result.content, noticeFields, stopped: cause === 'user_cancel' }
}

/**
 * 阶段7：群聊异常统一收口（timeout / 普通 ai:error 共用，不复制保存逻辑）。
 * 规则（方案 §4.1/§4.3）：
 * - 只有 streaming 状态能抢占终止；迟到 chunk/done/error 一律忽略；
 * - 先读取完整 accumulated 文本，再清理监听器；
 * - 部分正文必须先经统一收尾管线（稳定边界收束、不补尾）才允许保存；
 * - 错误原因只写 generationError，绝不拼进 content（避免进入复制/TTS/上下文/记忆摘要）；
 * - 无可用正文时移除占位消息，不创建空 AI 消息。
 */
export async function handleGroupStreamException(input: {
  requestId: string
  msgId: string
  groupId: string
  sessionId: string
  characterId: string
  characterName: string
  narrativeMode: import('../../shared/types').NarrativeMode
  regexRules: import('../../shared/types').RegexRule[]
  round: number
  isFree: boolean
  legacy?: boolean
  latch?: GenerationTerminationLatch
  /** NEW-M12：错误后继续推进轮询链/自动记忆检查 */
  onChainContinue?: () => void
  set: GroupStoreSet
}, cause: GenerationTerminationCause, detailMessage: string): Promise<void> {
  // 抢占终止权：已被其它终止分支（或用户停止）处理过则直接忽略
  const st = activeStream
  if (st && st.requestId !== input.requestId) return
  if (input.latch && !input.latch.claim(cause)) return
  // 先取 accumulated 再清理（C-02 同款竞态保护；cleanup 同步合并未执行的 flush timer）
  const partialContent = st?.accumulated ?? ''
  cleanupActiveStream()
  if (cause === 'idle_timeout') {
    window.api.ai.cancelChat(input.requestId, 'timeout').catch((e) => logError('GroupChatStore:cancelChat', e))
  }

  const errText = terminationPromptWithoutContent(cause, detailMessage)
  try {
    const result = await finalizeGenerationTerminalResult({
      terminalResult: { rawText: partialContent, finishReason: 'unknown', terminationCause: cause, errorMessage: detailMessage },
      regexRules: input.regexRules,
      characterName: input.characterName,
      legacy: input.legacy,
    })
    dispatchGroupTerminal(input, result, errText)
  } catch (e) {
    logError('GroupChatStore:terminalFinalize', e)
    input.latch?.markPersisted()
    input.set((s: GroupChatState) => ({
      messages: s.messages.filter((m: GroupMessage) => m.id !== input.msgId),
      isStreaming: false, currentStreamingCharId: null, error: errText,
    }))
    input.onChainContinue?.()
  }
}

/** 终止派发：可保存正文 → 更新+落盘；无正文 → 移除占位（不创建空 AI 消息） */
function dispatchGroupTerminal(input: Parameters<typeof handleGroupStreamException>[0], result: GenerationTerminalOutcome, errText: string) {
  input.latch?.markPersisted()
  const messageError = result.noticeFields.generationError ?? errText
  if (result.persistable && result.content) {
    // 阶段5：中断保留的正文与正常完成一致走语义分块；legacy 不标记
    const renderMode = input.legacy ? {} : { contentRenderMode: 'blocks' as const }
    input.set((s: GroupChatState) => ({
      messages: s.messages.map((m: GroupMessage) =>
        m.id === input.msgId ? { ...m, content: result.content, ...result.noticeFields, ...renderMode } : m,
      ),
      isStreaming: false, currentStreamingCharId: null, error: messageError,
    }))
    window.api.group.saveMessage(input.groupId, input.sessionId, {
      id: input.msgId, groupId: input.groupId, characterId: input.characterId,
      content: result.content, images: [], timestamp: Date.now(), round: input.round, narrativeMode: input.narrativeMode,
      ...result.noticeFields,
      ...renderMode,
    } as GroupMessage).catch((e) => logError('GroupChatStore:saveMessage', e))
  } else {
    input.set((s: GroupChatState) => ({
      messages: s.messages.filter((m: GroupMessage) => m.id !== input.msgId),
      isStreaming: false, currentStreamingCharId: null, error: messageError,
    }))
  }
  input.onChainContinue?.()
}

/**
 * S2 兼容入口：群聊超时统一处理——委托阶段7异常收口（idle_timeout）。
 */
export async function handleGroupStreamTimeout(input: {
  requestId: string
  msgId: string
  groupId: string
  sessionId: string
  characterId: string
  characterName: string
  narrativeMode: import('../../shared/types').NarrativeMode
  regexRules: import('../../shared/types').RegexRule[]
  round: number
  isFree: boolean
  legacy?: boolean
  latch?: GenerationTerminationLatch
  set: GroupStoreSet
}): Promise<void> {
  await handleGroupStreamException(input, 'idle_timeout', '请求超时')
}

async function flushStream(set: GroupStoreSet) {
  if (!activeStream) return
  const { msgId, accumulated } = activeStream
  activeStream.flushTimer = null
  set((s: GroupChatState) => ({
    messages: s.messages.map((m: GroupMessage) =>
      m.id === msgId ? { ...m, content: accumulated } : m,
    ),
  }))
}

/**
 * 群聊语义触发（向量 RAG）预取：发言前异步检索语义命中的世界书条目。
 * 与单聊路径共用主进程 semanticSearch，失败静默降级为纯关键词触发。
 */
async function fetchGroupSemanticLoreHits(get: GroupStoreGet, set: GroupStoreSet, group: GroupChat, charName: string): Promise<void> {
  const settings = useSettingsStore.getState().settings
  const st = settings.semanticTrigger
  const clear = () => {
    set({ _semanticLoreHits: [], _semanticLoreAvailable: false })
  }
  if (!st?.enabled || !st.model?.trim() || (st.provider !== 'local' && !st.baseUrl?.trim())) return clear()

  // 群聊级 + 角色绑定世界书
  const charStore = useCharacterStore.getState()
  const allLorebookIds = new Set<string>(group.lorebookIds)
  group.memberIds.forEach((mid) => {
    const c = charStore.characters.find((ch) => ch.id === mid)
    if (c?.boundLorebookIds) c.boundLorebookIds.forEach((id) => allLorebookIds.add(id))
  })
  const lorebookIds = [...allLorebookIds]
  if (lorebookIds.length === 0) return clear()

  const scanDepth = resolveLorebookScanDepth(
    lorebookIds.map(id => lorebookCache.get(id)?.scanDepth),
    DEFAULT_LOREBOOK_SCAN_DEPTH,
  )
  // 语义扫描范围：按 token 预算自适应（上限 4000 token，下限 scanDepth 条）
  const activeModel = useSettingsStore.getState().getActiveProfile()?.model || settings.activeModel
  const scanText = (() => {
    const msgs = get().messages
    const picked: string[] = []
    let tokens = 0
    for (let i = msgs.length - 1; i >= 0 && picked.length < scanDepth; i--) {
      const m = msgs[i] as GroupMessage
      const content = m.characterId === '__user__'
        ? m.content
        : `【${charStore.characters.find((ch) => ch.id === m.characterId)?.name || '未知角色'}】${m.content}`
      if (!m.content) continue
      tokens += estimateTokens(content, activeModel)
      if (picked.length > 0 && tokens > SEMANTIC_SCAN_MAX_TOKENS) break
      picked.unshift(content)
    }
    return picked.join(' ')
  })()
  if (!scanText.trim()) return clear()

  // 缓存：同一轮对话扫描文本不变时复用命中（省嵌入 API 调用）
  const cacheKey = buildSemanticCacheKey({
    scope: 'group-lore',
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
      content: replaceVariables(h.content, settings.userName, charName || '角色'),
      order: h.order,
      position: h.position,
      depth: h.depth,
      // 阶段二：保留相似度与条目定位键（统一评分 / recency 加权用）
      score: h.score,
      key: `${h.lbId}:${h.id}`,
      // 阶段三：手写摘要（预算紧张时代代替全文注入）
      summary: h.summary?.trim() ? replaceVariables(h.summary, settings.userName, charName || '角色') : undefined,
    }))
    set({ _semanticLoreHits: items, _semanticLoreAvailable: true })
    semanticCacheSet(cacheKey, items)
    if (items.length > 0) {
      logInfo('fetchGroupSemanticLoreHits', `语义命中 ${items.length} 条世界书条目`)
    }
  } catch (e) {
    logError('fetchGroupSemanticLoreHits', e)
    clear()
  }
}

/**
 * 群聊记忆事实语义检索预取（P0-2）：失败回退全量注入。
 */
async function fetchGroupSemanticFacts(get: GroupStoreGet, set: GroupStoreSet): Promise<void> {
  const settings = useSettingsStore.getState().settings
  const st = settings.semanticTrigger
  const clear = () => {
    if (get()._semanticFactsHits.length > 0) set({ _semanticFactsHits: [] })
  }
  if (!st?.enabled || !st.model?.trim() || (st.provider !== 'local' && !st.baseUrl?.trim())) return clear()

  const { sessions, currentSessionId } = get()
  const session = sessions.find((s) => s.id === currentSessionId)
  const factTexts = memoryFactsToTexts(session?.memoryFacts)
  if (!session?.memoryEnabled || !factTexts.length) return clear()
  const vectors = session.factsVectors
  if (!vectors || vectors.length !== factTexts.length
    || session.factsVectorVersion !== session.memoryVersion) return clear()

  const query = get().messages.slice(-20).map((m) => m.content).join(' ')
  if (!query.trim()) return clear()

  // 缓存：同一轮对话查询不变时复用（省嵌入 API 调用）
  const cacheKey = buildSemanticCacheKey({
    scope: 'group-facts',
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
    const scoredHits = (hits ?? []).map((hit, index) => typeof hit === 'string'
      ? { text: hit, index, score: 0 }
      : hit)
    set({ _semanticFactsHits: scoredHits })
    semanticCacheSet(cacheKey, scoredHits)
  } catch {
    clear()
  }
}

/**
 * 群聊记忆事实向量化（P0-2）
 */
export async function vectorizeGroupSessionFacts(
  groupId: string,
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
      await window.api.group.updateSession(groupId, sessionId, {
        factsVectors: vectors,
        factsVectorVersion: memoryVersion,
      })
    }
  } catch { /* 忽略 */ }
}

/**
 * 群聊上下文溢出压缩（P0-1）：异步压缩被裁剪的早期群聊内容，存群聊会话。
 */
async function compressGroupDroppedHistory(
  get: GroupStoreGet,
  set: GroupStoreSet,
  group: GroupChat,
  pending: PendingGroupCompression,
): Promise<void> {
  if (!pending.sessionId || !pending.droppedText) return
  const settings = useSettingsStore.getState().settings
  const profile = useSettingsStore.getState().getActiveProfile()
  if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) return

  const requestId = `group-compress-${Date.now()}`
  let result = ''
  let finished = false

  const unbindChunk = window.api.ai.onChunk((data) => {
    if (data.requestId !== requestId) return
    result += data.text
  })
  // 阶段7（§7.3）：群聊历史压缩与单聊同一 background 档案（只允许任务体量参数不同）
  const compressionProfile = BACKGROUND_GENERATION_PROFILES.compression
  const unbindDone = window.api.ai.onComplete((payload) => {
    if (payload.requestId !== requestId) return
    cleanup()
    finished = true
    const summary = stripAllThinking(result)
    const truncated = payload.finishReason === 'length' || !hasCompleteSummaryTail(summary)
    if (summary && !truncated) {
      window.api.group.updateSession(group.id, pending.sessionId, {
        compressedSummary: summary,
        compressedRange: { startTs: pending.droppedStartTs, endTs: pending.droppedEndTs },
      }).then(async () => {
        const sessions = await window.api.group.listSessions(group.id)
        set({ sessions })
      }).catch((e) => logError('GroupChatStore:compressSummary', e))
    } else if (summary) {
      logWarn('compressGroupDroppedHistory', '压缩结果结构不完整，本次丢弃，原历史保持不变')
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
        content: `你是一个对话摘要助手。以下是群聊「${group.name}」的早期内容，即将被上下文裁剪。请压缩为 3-5 句中文摘要，必须保留：各角色身份与姓名、地点、目标、关键事件、未解决的问题、重要的约定。只输出摘要文本，不要任何解释。`,
      },
      { role: 'user', content: pending.droppedText.slice(0, 20000) },
    ],
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: settings.activeModel || profile.model,
    temperature: 0.3,
    topP: 0.9,
    maxTokens: resolveRequestBudget({
      model: settings.activeModel || profile.model,
      hardMaxChars: compressionProfile.expectedBodyChars,
    }).requestMaxTokens,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stream: true,
    observability: { source: 'aux', taskType: 'compression', sessionId: pending.sessionId },
  }).catch(() => {
    cleanup()
    if (!finished) logWarn('compressGroupDroppedHistory', '压缩请求失败')
  })
}

/**
 * BUG-08：校验传入的群聊/会话是否仍是当前活跃上下文
 * 流式输出与占位消息写入前调用，避免异步期间用户切换群聊后
 * 把 AI 输出/占位消息追加到错误群聊的 UI
 */
function isGroupContextCurrent(get: GroupStoreGet, group: GroupChat, sessionId: string): boolean {
  const s = get()
  return s.currentGroup?.id === group.id && s.currentSessionId === sessionId
}

export async function streamGroupAI(
  set: GroupStoreSet,
  get: GroupStoreGet,
  group: GroupChat,
  sessionId: string,
  speaker: Character,
  round: number,
  onComplete: () => void,
  /**
   * 阶段8（§4.5）：降档恢复。复用同一 msgId 与同一上下文，只按新档位重发一次；
   * 每个逻辑回合最多恢复一次（recoveryUsed），失败不重复其他角色已完成回合。
   */
  recovery?: { msgId: string; gateLevel: ReasoningGateLevel; recoveryUsed?: boolean },
) {
  const settingsStore = useSettingsStore.getState()
  const profile = settingsStore.getActiveProfile()
  if (!profile) return

  // BUG-08 修复：异步加载期间用户可能已切换群聊/会话，先校验一次
  if (!isGroupContextCurrent(get, group, sessionId)) return
  const narrativeMode = resolveNarrativeMode(get().sessions?.find((session) => session.id === sessionId)?.narrativeMode)

  // 加载预设（群聊预设优先，回退到角色绑定预设）
  let preset = null
  if (group.presetId) {
    const allPresets = await window.api.preset.list()
    preset = allPresets.find(p => p.id === group.presetId) ?? null
  } else if (speaker.boundPresetId) {
    const allPresets = await window.api.preset.list()
    preset = allPresets.find(p => p.id === speaker.boundPresetId) ?? null
  }

  // 加载正则规则
  let regexRules: import('../../shared/types').RegexRule[] = []
  try {
    regexRules = await window.api.regex.list()
  } catch { /* 忽略 */ }

  // 阶段6灰度：legacy 管线跳过收尾器与语义分块标记
  const legacyPipeline = (useSettingsStore.getState().settings.generationPipeline ?? 'unified') === 'legacy'

  // 预加载角色绑定的世界书
  if (speaker.boundLorebookIds && speaker.boundLorebookIds.length > 0) {
    await get().ensureLorebooksLoaded(speaker.boundLorebookIds)
  }

  // 语义触发预取（向量 RAG）：失败静默降级为纯关键词
  await fetchGroupSemanticLoreHits(get, set, group, speaker.name)
  // 记忆事实语义检索预取（P0-2）：失败回退全量注入
  await fetchGroupSemanticFacts(get, set)

  // W1（主计划 §7.3）：构建前异步预取该端点/模型的近期推理样本（失败静默降级）
  await prefetchUsageProfile({
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: settingsStore.settings.activeModel || profile.model,
  })
  // 阶段8（§4.2/§4.5）：本轮门控（恢复时用覆盖档位）；档位在 done 处理里用于判定降档
  const groupGate = withReasoningGate(profile, settingsStore.settings.activeModel, recovery?.gateLevel)
  const requestPlan = resolveGroupRequestPlan({
    model: settingsStore.settings.activeModel || profile.model,
    messages: get().messages,
    preset,
    pipelineLegacy: legacyPipeline,
    ...withReasoningSamples(profile, settingsStore.settings.activeModel),
    ...groupGate,
  })
  const budgetRisk = formatRequestBudgetRisk(requestPlan.requestBudget)
  if (budgetRisk) {
    logWarn('GroupChatStore:budget', budgetRisk)
    set({ isStreaming: false, currentStreamingCharId: null, error: budgetRisk })
    return
  }

  const context = get().buildGroupContext(speaker.id, preset)

  if (context.length === 0) return

  // Vision：上下文含图片且配置了激活识图模型 → 本轮使用识图模型连接（未填字段回退当前 Profile）
  const vision = resolveVisionModel(context)

  // BUG-08：占位消息写入前再次校验，避免追加到切换后的群聊 UI
  if (!isGroupContextCurrent(get, group, sessionId)) return

  const requestId = nanoid()
  // 阶段8：降档恢复复用原消息，避免留下 "(无回复)" + 新消息两条记录
  const msgId = recovery?.msgId ?? nanoid()
  // 阶段7：requestId 级一次性终止状态机（点名/轮询路径）
  const latch = createGenerationTerminationLatch(requestId)
  /** 降档恢复：复用同一 msgId 与同一上下文；成功后计入熔断清零 */
  const retryWithDowngradedGate = (level: ReasoningGateLevel) => {
    void streamGroupAI(set, get, group, sessionId, speaker, round, onComplete, {
      msgId, gateLevel: level, recoveryUsed: true,
    })
  }

  // 等待中的占位消息
  const placeholder: GroupMessage = {
    id: msgId,
    groupId: group.id,
    characterId: speaker.id,
    content: '',
    images: [],
    timestamp: Date.now(),
    round,
    narrativeMode,
    speakerKind: 'character',
    generationKind: 'assistant_reply',
  }
  if (recovery) {
    // 恢复：只恢复流状态，不追加第二条占位消息
    set((s: GroupChatState) => ({
      isStreaming: true,
      currentStreamingCharId: speaker.id,
      error: null,
    }))
  } else {
    set((s: GroupChatState) => ({
      messages: [...s.messages, placeholder],
      isStreaming: true,
      currentStreamingCharId: speaker.id,
      error: null,
    }))
  }

  // 停止字符串（output 正则规则）：流式命中后截断 + 提前终止，省 token
  const stopStrings = collectStopStrings(regexRules)

  // 绑定流式事件
  const unbindChunk = window.api.ai.onChunk((data: { requestId: string; text: string }) => {
    if (data.requestId !== requestId || !activeStream || activeStream.requestId !== requestId) return
    // 阶段7：迟到 chunk（已有终止分支抢占）忽略
    if (!activeStream.latch.acceptsStreamEvent()) return
    activeStream.accumulated += data.text
    // 停止字符串：命中后截断并提前终止（主进程取消后发 ai:done，按正常 stop 收口）
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
    if (activeStream.flushTimer === null) {
      activeStream.flushTimer = setTimeout(() => flushStream(set), STREAM_THROTTLE_MS)
    }
    // 空闲超时续期：收到 chunk 即重置 60s 计时（卡死时更快恢复）
    if (activeStream.timeoutHandle) clearTimeout(activeStream.timeoutHandle)
    activeStream.timeoutHandle = setTimeout(() => {
      void handleGroupStreamTimeout({
        requestId, msgId, groupId: group.id, sessionId,
        characterId: speaker.id,
        characterName: speaker.translatedContent?.name || speaker.name,
        narrativeMode, regexRules, round, isFree: false, legacy: legacyPipeline, latch, set,
      })
    }, STREAM_IDLE_TIMEOUT_MS)
  })

  const unbindDone = window.api.ai.onComplete((payload) => {
    const { requestId: doneId, finishReason = 'unknown' } = payload
    if (doneId !== requestId || !activeStream || activeStream.requestId !== requestId) return
    const stopStringsHit = activeStream.stopStringsHit
    // 阶段8（§4.4/§4.7）：主进程的提前中止以结构化元数据下发
    const doneCause: GenerationTerminationCause = payload.terminationCause
      ?? terminationCauseFromFinishReason(finishReason)
    // 阶段8（§4.5）：空正文 + 推理挤占 → 降一档重发一次（复用同一消息与上下文快照）。
    // 有正文的 length / 用户停止 / 已恢复过 / 无更低档位都不触发；失败不重复其他角色回合。
    const groupRecoveryLevel = nextRecoveryLevel({
      terminationCause: payload.terminationCause,
      finishReason,
      rawText: activeStream.accumulated,
      usage: payload.usage,
      currentLevel: groupGate.reasoningGate?.level,
      recoveryUsed: recovery?.recoveryUsed === true || stopStringsHit,
    })
    if (groupRecoveryLevel && latch.claim('reasoning_gate_exceeded')) {
      cleanupActiveStream()
      retryWithDowngradedGate(groupRecoveryLevel)
      return
    }
    if (recovery?.recoveryUsed) {
      const groupGateScope = {
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        model: settingsStore.settings.activeModel || profile.model,
        task: 'group',
      }
      if (doneCause === 'reasoning_gate_exceeded') {
        // 恢复后再次挤占：记录熔断事实（本回合结束，不影响其他角色已完成回合）
        noteGateRecoveryFailure(groupGateScope)
      } else {
        // 恢复成功：清零连续失败计数（熔断只按"连续"计数）
        noteGateRecoverySuccess(groupGateScope)
      }
    }
    if (!latch.claim(stopStringsHit && doneCause === 'user_cancel' ? 'provider_stop' : doneCause)) return

    if (activeStream.flushTimer !== null) {
      clearTimeout(activeStream.flushTimer)
      activeStream.flushTimer = null
    }

    const finalContent = activeStream.accumulated

    cleanupActiveStream()

    // 阶段4：统一收尾（preserve → 正则 → finalizer → 至多一次补尾），与单聊同一策略
    void (async () => {
      // S1：preserve/正则/停止字符串由统一收尾管线承担

      const finalizedReply = await finalizeGroupReply({
        rawText: finalContent,
        // 停止字符串命中后的 cancelled 按正常 stop 收尾，不标"已停止生成"
        finishReason: stopStringsHit && finishReason === 'cancelled' ? 'stop' : finishReason,
        speaker,
        model: profile.model,
        regexRules,
        legacy: legacyPipeline,
      })
      // 无可用正文：维持 (无回复) 占位
      const processed = finalizedReply?.content || '(无回复)'
      const noticeFields = finalizedReply?.noticeFields ?? {}
      const renderMode = finalizedReply && !legacyPipeline ? { contentRenderMode: 'blocks' as const } : {}

      // 更新消息
      set((s: GroupChatState) => ({
        messages: s.messages.map((m: GroupMessage) =>
          m.id === msgId
            ? { ...m, content: processed, ...noticeFields, ...renderMode }
            : m,
        ),
        isStreaming: false,
        currentStreamingCharId: null,
      }))

      // 持久化（阶段7：同一 requestId 最多落盘一次——done 分支独占终止权后即标记）
      latch.markPersisted()
      safeSave(() => window.api.group.saveMessage(group.id, sessionId, {
        id: msgId,
        groupId: group.id,
        characterId: speaker.id,
        content: processed,
        images: [],
        timestamp: Date.now(),
        round,
        narrativeMode,
        ...noticeFields,
        ...renderMode,
      } as GroupMessage), '消息保存')

      // 字符用量统计
      const model = useSettingsStore.getState().settings.activeModel || profile.model
      const outputChars = countChars(processed || '').total
      const usageInfo = { inputChars: 0, outputChars, totalChars: outputChars, model, timestamp: Date.now() }
      set((s: GroupChatState) => ({
        messages: s.messages.map((m: GroupMessage) => m.id === msgId ? { ...m, charUsage: usageInfo } : m),
      }))
      const sid = get().currentSessionId
      if (sid) {
        window.api.usage.record({
          timestamp: Date.now(), characterId: speaker.id, sessionId: sid, model,
          inputChars: 0, outputChars, totalChars: outputChars,
        }).catch((e) => logError('GroupChatStore:recordUsage', e))
      }

      // 上下文溢出压缩：本轮结束后异步执行
      if (pendingGroupCompression) {
        const pc = pendingGroupCompression
        pendingGroupCompression = null
        compressGroupDroppedHistory(get, set, group, pc).catch((e) => logError('GroupChatStore:compress', e))
      }

      onComplete()
    })()
  })

  const unbindError = window.api.ai.onError((data: { requestId: string; error: string }) => {
    if (data.requestId !== requestId) return
    const friendlyMsg = friendlyError(data.error)
    // NEW-M12 修复：错误时也继续推进 polling 轮询链/自动记忆检查
    // 阶段7：点名/轮询普通 ai:error 接入统一异常收口（半截正文先收尾再保存）
    void handleGroupStreamException({
      requestId, msgId, groupId: group.id, sessionId,
      characterId: speaker.id,
      characterName: speaker.translatedContent?.name || speaker.name,
      narrativeMode, regexRules, round, isFree: false, legacy: legacyPipeline, latch,
      onChainContinue: onComplete,
      set,
    }, 'transport_error', friendlyMsg)
  })

  activeStream = {
    requestId,
    msgId,
    accumulated: '',
    flushTimer: null,
    unbindChunk,
    unbindDone,
    unbindError,
    latch,
    stopStringsHit: false,
    timeoutHandle: setTimeout(() => {
      void handleGroupStreamTimeout({
        requestId, msgId, groupId: group.id, sessionId,
        characterId: speaker.id,
        characterName: speaker.translatedContent?.name || speaker.name,
        narrativeMode, regexRules, round, isFree: false, legacy: legacyPipeline, latch, set,
      })
    }, STREAM_IDLE_TIMEOUT_MS),
  }

  // 发起 AI 请求（点名 / 轮询共用此路径）
  try {
    const instructTemplate = resolveEffectiveTemplate(
      preset?.contextTemplate,
      profile.provider,
      profile.model,
      profile.useInstructTemplate,
    )
    await window.api.ai.chat({
      requestId,
      messages: context,
      model: vision?.model ?? profile.model,
      provider: vision?.provider ?? profile.provider,
      apiKey: vision?.apiKey ?? profile.apiKey,
      baseUrl: vision?.baseUrl ?? profile.baseUrl,
      temperature: preset?.temperature ?? 0.8,
      topP: preset?.topP ?? 0.95,
      maxTokens: requestPlan.requestMaxTokens,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: true,
      instructTemplate,
      // 阶段8（§4.3）：门控指令由预算结果反推（tokens 即本轮推理预留），与单聊同口径
      ...(requestPlan.requestBudget?.gate
        ? {
            reasoningGate: {
              level: requestPlan.requestBudget.gate.level,
              knob: requestPlan.requestBudget.gate.knob,
              tokens: requestPlan.requestBudget.reasoningReserve,
            },
          }
        : {}),
      // 阶段0观测元数据：群聊预算统一（阶段四）前先记录来源
      observability: {
        source: 'group',
        sessionId,
        responseLengthMode: requestPlan.responsePolicy.mode,
        hardMaxChars: requestPlan.responsePolicy.hardMaxChars,
        responseIntent: requestPlan.responseIntent ?? undefined,
        sceneFactor: requestPlan.sceneFactor,
      },
    })
  } catch (err) {
    // 阶段7：发送即失败 → 统一收口（无正文时移除占位消息，不留下空 AI 消息）
    void handleGroupStreamException({
      requestId, msgId, groupId: group.id, sessionId,
      characterId: speaker.id,
      characterName: speaker.translatedContent?.name || speaker.name,
      narrativeMode, regexRules, round, isFree: false, legacy: legacyPipeline, latch, set,
    }, 'protocol_error', friendlyError(err instanceof Error ? err.message : '请求失败'))
  }
}

/** 解析 free 模式 AI 回复，拆分为多条角色消息 */
export async function streamGroupAIFree(
  set: GroupStoreSet,
  get: GroupStoreGet,
  group: GroupChat,
  sessionId: string,
  round: number,
  /** 阶段8（§4.5）：与点名/轮询同一恢复语义（自由发言无固定角色） */
  recovery?: { msgId: string; gateLevel: ReasoningGateLevel; recoveryUsed?: boolean },
) {
  const settingsStore = useSettingsStore.getState()
  const profile = settingsStore.getActiveProfile()
  if (!profile) return
  // 阶段6灰度：legacy 管线跳过收尾器与语义分块标记
  const legacyPipelineFree = (settingsStore.settings.generationPipeline ?? 'unified') === 'legacy'

  // BUG-08 修复：异步加载期间用户可能已切换群聊/会话，先校验一次
  if (!isGroupContextCurrent(get, group, sessionId)) return
  const narrativeMode = resolveNarrativeMode(get().sessions?.find((session) => session.id === sessionId)?.narrativeMode)

  // 加载预设
  let preset = null
  if (group.presetId) {
    const allPresets = await window.api.preset.list()
    preset = allPresets.find(p => p.id === group.presetId) ?? null
  }

  // 加载正则规则
  let regexRules: import('../../shared/types').RegexRule[] = []
  try {
    regexRules = await window.api.regex.list()
  } catch { /* 忽略 */ }

  // 预加载所有成员绑定的世界书
  const charStore = useCharacterStore.getState()
  const allBoundLbIds = group.memberIds
    .map(id => charStore.characters.find(c => c.id === id)?.boundLorebookIds)
    .filter(Boolean)
    .flat() as string[]
  if (allBoundLbIds.length > 0) {
    await get().ensureLorebooksLoaded([...new Set(allBoundLbIds)])
  }

  // 语义触发预取（向量 RAG）：失败静默降级为纯关键词
  await fetchGroupSemanticLoreHits(get, set, group, '')
  // 记忆事实语义检索预取（P0-2）
  await fetchGroupSemanticFacts(get, set)

  // W1（主计划 §7.3）：与点名路径同一分桶的近期推理样本
  await prefetchUsageProfile({
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: settingsStore.settings.activeModel || profile.model,
  })
  // 阶段8（§4.2/§4.5）：本轮门控（恢复时用覆盖档位）；档位在 done 处理里用于判定降档
  const groupGate = withReasoningGate(profile, settingsStore.settings.activeModel, recovery?.gateLevel)
  const requestPlan = resolveGroupRequestPlan({
    model: settingsStore.settings.activeModel || profile.model,
    messages: get().messages,
    preset,
    pipelineLegacy: legacyPipelineFree,
    ...withReasoningSamples(profile, settingsStore.settings.activeModel),
    ...groupGate,
  })
  const budgetRisk = formatRequestBudgetRisk(requestPlan.requestBudget)
  if (budgetRisk) {
    logWarn('GroupChatStore:budget', budgetRisk)
    set({ isStreaming: false, currentStreamingCharId: null, error: budgetRisk })
    return
  }

  const context = get().buildGroupContext(undefined, preset)

  if (context.length === 0) return

  // Vision：上下文含图片且配置了激活识图模型 → 本轮使用识图模型连接（未填字段回退当前 Profile）
  const vision = resolveVisionModel(context)

  // BUG-08：占位消息写入前再次校验，避免追加到切换后的群聊 UI
  if (!isGroupContextCurrent(get, group, sessionId)) return

  const requestId = nanoid()
  // 阶段8：降档恢复复用原消息，避免留下 "(无回复)" + 新消息两条记录
  const msgId = recovery?.msgId ?? nanoid()
  // 阶段7：requestId 级一次性终止状态机（自由发言路径）
  const latch = createGenerationTerminationLatch(requestId)
  /** 降档恢复：复用同一 msgId 与同一上下文（自由发言无固定角色） */
  const retryWithDowngradedGate = (level: ReasoningGateLevel) => {
    void streamGroupAIFree(set, get, group, sessionId, round, {
      msgId, gateLevel: level, recoveryUsed: true,
    })
  }
  // 全局叙事的自由发言保留为单条实际成员回应，避免【判定】/【可选行动】被角色分段器误识别。
  const freeMessageCharacterId = narrativeMode === 'omniscient'
    ? (group.memberIds[0] ?? '__narrator__')
    : '__free__'

  const placeholder: GroupMessage = {
    id: msgId,
    groupId: group.id,
    characterId: freeMessageCharacterId,
    content: '',
    images: [],
    timestamp: Date.now(),
    round,
    narrativeMode,
    speakerKind: 'character',
    generationKind: 'assistant_reply',
  }
  if (recovery) {
    set((s: GroupChatState) => ({
      isStreaming: true,
      currentStreamingCharId: freeMessageCharacterId,
      error: null,
    }))
  } else {
    set((s: GroupChatState) => ({
      messages: [...s.messages, placeholder],
      isStreaming: true,
      currentStreamingCharId: freeMessageCharacterId,
      error: null,
    }))
  }

  // 停止字符串（output 正则规则）：流式命中后截断 + 提前终止，省 token
  const stopStrings = collectStopStrings(regexRules)

  const unbindChunk = window.api.ai.onChunk((data: { requestId: string; text: string }) => {
    if (data.requestId !== requestId || !activeStream || activeStream.requestId !== requestId) return
    // 阶段7：迟到 chunk（已有终止分支抢占）忽略
    if (!activeStream.latch.acceptsStreamEvent()) return
    activeStream.accumulated += data.text
    // 停止字符串：命中后截断并提前终止（主进程取消后发 ai:done，按正常 stop 收口）
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
    if (activeStream.flushTimer === null) {
      activeStream.flushTimer = setTimeout(() => flushStream(set), STREAM_THROTTLE_MS)
    }
    // 空闲超时续期：收到 chunk 即重置 60s 计时（S2：统一走 handleGroupStreamTimeout）
    if (activeStream.timeoutHandle) clearTimeout(activeStream.timeoutHandle)
    activeStream.timeoutHandle = setTimeout(() => {
      void handleGroupStreamTimeout({
        requestId, msgId, groupId: group.id, sessionId,
        characterId: freeMessageCharacterId,
        characterName: group.name,
        narrativeMode, regexRules, round, isFree: true, legacy: legacyPipelineFree, latch, set,
      })
    }, STREAM_IDLE_TIMEOUT_MS)
  })

  const unbindDone = window.api.ai.onComplete((payload) => {
    const { requestId: doneId, finishReason = 'unknown' } = payload
    if (doneId !== requestId || !activeStream || activeStream.requestId !== requestId) return
    const stopStringsHit = activeStream.stopStringsHit
    // 阶段8（§4.4/§4.7）：主进程的提前中止以结构化元数据下发
    const doneCause: GenerationTerminationCause = payload.terminationCause
      ?? terminationCauseFromFinishReason(finishReason)
    // 阶段8（§4.5）：空正文 + 推理挤占 → 降一档重发一次（复用同一消息与上下文快照）。
    // 有正文的 length / 用户停止 / 已恢复过 / 无更低档位都不触发；失败不重复其他角色回合。
    const groupRecoveryLevel = nextRecoveryLevel({
      terminationCause: payload.terminationCause,
      finishReason,
      rawText: activeStream.accumulated,
      usage: payload.usage,
      currentLevel: groupGate.reasoningGate?.level,
      recoveryUsed: recovery?.recoveryUsed === true || stopStringsHit,
    })
    if (groupRecoveryLevel && latch.claim('reasoning_gate_exceeded')) {
      cleanupActiveStream()
      retryWithDowngradedGate(groupRecoveryLevel)
      return
    }
    if (recovery?.recoveryUsed && doneCause === 'reasoning_gate_exceeded') {
      // 恢复后再次挤占：记录熔断事实（本回合结束，不影响其他角色已完成回合）
      noteGateRecoveryFailure({
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        model: settingsStore.settings.activeModel || profile.model,
        task: 'group',
      })
    }
    if (!latch.claim(stopStringsHit && doneCause === 'user_cancel' ? 'provider_stop' : doneCause)) return

    if (activeStream.flushTimer !== null) {
      clearTimeout(activeStream.flushTimer)
      activeStream.flushTimer = null
    }

    const finalContent = activeStream.accumulated
    cleanupActiveStream()

    // S1：统一收尾管线（推理清理 → 正则 → 收尾器 → 至多一次补尾），随后拆分多角色消息
    void (async () => {
      // free 模式无单一发言角色：以群名作为补尾/收尾的角色上下文
      const freeSpeaker = {
        id: freeMessageCharacterId,
        name: group.name,
        translatedContent: undefined,
      } as Character
      const finalizedReply = await finalizeGroupReply({
        rawText: finalContent,
        // 停止字符串命中后的 cancelled 按正常 stop 收尾，不标"已停止生成"
        finishReason: stopStringsHit && finishReason === 'cancelled' ? 'stop' : finishReason,
        speaker: freeSpeaker,
        model: profile.model,
        regexRules,
        legacy: legacyPipelineFree,
      })
      latch.markPersisted()
      const processed = finalizedReply?.content || '(无回复)'
      const extras = finalizedReply && !legacyPipelineFree
        ? { noticeFields: finalizedReply.noticeFields, renderMode: { contentRenderMode: 'blocks' as const } }
        : undefined
      splitAndSaveMessages(set, get, group, sessionId, processed, round, msgId, extras)

      // 字符用量统计
      const model = useSettingsStore.getState().settings.activeModel || profile.model
      const outputChars = countChars(processed || '').total
      const sid = get().currentSessionId
      if (sid) {
        window.api.usage.record({
          timestamp: Date.now(), characterId: '__free__', sessionId: sid, model,
          inputChars: 0, outputChars, totalChars: outputChars,
        }).catch((e) => logError('GroupChatStore:recordUsage', e))
      }

      // 上下文溢出压缩：本轮结束后异步执行
      if (pendingGroupCompression) {
        const pc = pendingGroupCompression
        pendingGroupCompression = null
        compressGroupDroppedHistory(get, set, group, pc).catch((e) => logError('GroupChatStore:compress', e))
      }
    })()
  })

  const unbindError = window.api.ai.onError((data: { requestId: string; error: string }) => {
    if (data.requestId !== requestId) return
    clearPollingTimer()
    const friendlyMsg = friendlyError(data.error)
    // 阶段7：自由发言普通 ai:error 接入统一异常收口（半截正文先收尾再保存；
    // 无稳定正文则移除占位，不保存错误文案）
    void handleGroupStreamException({
      requestId, msgId, groupId: group.id, sessionId,
      characterId: freeMessageCharacterId,
      characterName: group.name,
      narrativeMode, regexRules, round, isFree: true, legacy: legacyPipelineFree, latch, set,
    }, 'transport_error', friendlyMsg)
  })

  activeStream = {
    requestId, msgId, accumulated: '', flushTimer: null,
    unbindChunk, unbindDone, unbindError,
    latch, stopStringsHit: false,
    timeoutHandle: setTimeout(() => {
      void handleGroupStreamTimeout({
        requestId, msgId, groupId: group.id, sessionId,
        characterId: freeMessageCharacterId,
        characterName: group.name,
        narrativeMode, regexRules, round, isFree: true, legacy: legacyPipelineFree, latch, set,
      })
    }, STREAM_IDLE_TIMEOUT_MS),
  }

  try {
    const instructTemplate = resolveEffectiveTemplate(
      preset?.contextTemplate,
      profile.provider,
      profile.model,
      profile.useInstructTemplate,
    )
    await window.api.ai.chat({
      requestId,
      messages: context,
      model: vision?.model ?? profile.model,
      provider: vision?.provider ?? profile.provider,
      apiKey: vision?.apiKey ?? profile.apiKey,
      baseUrl: vision?.baseUrl ?? profile.baseUrl,
      temperature: preset?.temperature ?? 0.8,
      topP: preset?.topP ?? 0.95,
      maxTokens: requestPlan.requestMaxTokens,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: true,
      instructTemplate,
      // 阶段8（§4.3）：门控指令由预算结果反推（tokens 即本轮推理预留），与单聊同口径
      ...(requestPlan.requestBudget?.gate
        ? {
            reasoningGate: {
              level: requestPlan.requestBudget.gate.level,
              knob: requestPlan.requestBudget.gate.knob,
              tokens: requestPlan.requestBudget.reasoningReserve,
            },
          }
        : {}),
      // 阶段0观测元数据：群聊预算统一（阶段四）前先记录来源（free 模式无固定角色）
      observability: {
        source: 'group',
        sessionId,
        responseLengthMode: requestPlan.responsePolicy.mode,
        hardMaxChars: requestPlan.responsePolicy.hardMaxChars,
        responseIntent: requestPlan.responseIntent ?? undefined,
        sceneFactor: requestPlan.sceneFactor,
      },
    })
  } catch (err) {
    // 阶段7：发送即失败 → 统一收口（无正文时移除占位消息，不留下空 AI 消息）
    void handleGroupStreamException({
      requestId, msgId, groupId: group.id, sessionId,
      characterId: freeMessageCharacterId,
      characterName: group.name,
      narrativeMode, regexRules, round, isFree: true, legacy: legacyPipelineFree, latch, set,
    }, 'protocol_error', friendlyError(err instanceof Error ? err.message : '请求失败'))
  }
}

/** 解析 free 模式 AI 回复，拆分为多条角色消息 */
export async function splitAndSaveMessages(
  set: GroupStoreSet,
  get: GroupStoreGet,
  group: GroupChat,
  sessionId: string,
  content: string,
  round: number,
  placeholderId: string,
  extras?: { noticeFields?: { generationNotice?: string; generationError?: string }; renderMode?: { contentRenderMode: 'blocks' } },
) {
  const narrativeMode = resolveNarrativeMode(get().sessions?.find((session) => session.id === sessionId)?.narrativeMode)
  const charStore = useCharacterStore.getState()
  const members = group.memberIds
    .map(id => charStore.characters.find(c => c.id === id))
    .filter(Boolean) as Character[]

  if (narrativeMode === 'omniscient') {
    const focusCharacterId = members[0]?.id ?? '__narrator__'
    const narratorMessage: GroupMessage = {
      id: placeholderId,
      groupId: group.id,
      characterId: focusCharacterId,
      content: content || '(无回复)',
      images: [],
      timestamp: Date.now(),
      round,
      narrativeMode,
      speakerKind: 'character',
      generationKind: 'assistant_reply',
      ...(extras?.renderMode ?? {}),
      ...(extras?.noticeFields ?? {}),
    }
    await window.api.group.saveMessage(group.id, sessionId, narratorMessage)
    set((state: GroupChatState) => ({
      messages: state.messages.map((message: GroupMessage) => message.id === placeholderId ? narratorMessage : message),
      isStreaming: false,
      currentStreamingCharId: null,
    }))
    return
  }

  // 按 【角色名】 拆分
  const pattern = /【(.+?)】/g
  const segments: { name: string; content: string }[] = []
  let lastIdx = 0
  let preamble = ''
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    const textBefore = content.slice(lastIdx, match.index).trim()
    if (segments.length === 0) {
      // H-14 修复：首个【】前的旁白文本先暂存，结束时并入首段内容
      // （此前 push 后被后续迭代的 prev.content 覆盖，旁白被静默丢弃）
      preamble = textBefore
      segments.push({ name: match[1], content: '' })
    } else {
      const prev = segments[segments.length - 1]
      prev.content = textBefore
      segments.push({ name: match[1], content: '' })
    }
    lastIdx = match.index + match[0].length
  }

  // 最后一段
  if (segments.length > 0) {
    segments[segments.length - 1].content = content.slice(lastIdx).trim()
    // 首段内容前并入旁白（若有），保证不被覆盖
    if (preamble) {
      segments[0].content = [preamble, segments[0].content].filter(Boolean).join('\n\n')
    }
  }

  if (segments.length === 0) {
    // 没有匹配到任何角色标记 → 将占位消息改为第一个成员的消息，避免渲染为不可见
    const fallbackChar = members[0]
    const fallbackCharId = fallbackChar?.id || '__free__'
    set((s: GroupChatState) => ({
      messages: s.messages.map((m: GroupMessage) =>
        m.id === placeholderId
          ? { ...m, characterId: fallbackCharId, content: content || '(无回复)', ...(extras?.renderMode ?? {}), ...(extras?.noticeFields ?? {}) }
          : m,
      ),
      isStreaming: false, currentStreamingCharId: null,
    }))
    // 持久化更新后的占位消息
    if (fallbackChar) {
      window.api.group.saveMessage(group.id, sessionId, {
        id: placeholderId,
        groupId: group.id,
        characterId: fallbackChar.id,
        content: content || '(无回复)',
        images: [],
        timestamp: Date.now(),
        round,
        narrativeMode,
        speakerKind: 'character',
        generationKind: 'assistant_reply',
        ...(extras?.renderMode ?? {}),
        ...(extras?.noticeFields ?? {}),
      }).catch((e) => logError('GroupChatStore:saveMessage', e))
    }
    return
  }

  // 移除占位消息，替换为拆分的角色消息
  const newMessages: GroupMessage[] = []
  for (const seg of segments) {
    // 大小写不敏感 + 去除空格 进行角色名匹配
    const segName = seg.name.toLowerCase().trim()
    const char = members.find(c => c.name.toLowerCase().trim() === segName)
    if (!char || !seg.content) {
      // 未识别的角色：将内容追加到第一个成员的回复中
      if (seg.content && members.length > 0) {
        const fallbackSeg = newMessages.length > 0
          ? newMessages[newMessages.length - 1]
          : null
        if (fallbackSeg && fallbackSeg.characterId === members[0].id) {
          fallbackSeg.content += '\n\n⚠️ 未识别角色「' + seg.name + '」: ' + seg.content
        } else {
          const msgId = nanoid()
          const gm: GroupMessage = {
            id: msgId,
            groupId: group.id,
            characterId: members[0].id,
            content: '⚠️ 未识别角色「' + seg.name + '」: ' + seg.content,
            images: [],
            timestamp: Date.now(),
            round,
            narrativeMode,
            speakerKind: 'character',
            generationKind: 'assistant_reply',
          }
          newMessages.push(gm)
        }
      }
      continue
    }
    const msgId = nanoid()
    const gm: GroupMessage = {
      id: msgId,
      groupId: group.id,
      characterId: char.id,
      content: seg.content,
      images: [],
      timestamp: Date.now(),
      round,
      narrativeMode,
      speakerKind: 'character',
      generationKind: 'assistant_reply',
    }
    newMessages.push(gm)
  }

  // 阶段5：拆分出的新消息均为语义分块渲染；收尾提示附加在最后一条上
  if (extras?.renderMode) {
    for (const m of newMessages) m.contentRenderMode = extras.renderMode.contentRenderMode
  }
  if (extras?.noticeFields && newMessages.length > 0) {
    Object.assign(newMessages[newMessages.length - 1], extras.noticeFields)
  }

  // 持久化（优化：多条消息合并为一次批量保存，减少 IPC 往返与文件全量重写）
  if (newMessages.length === 1) {
    await window.api.group.saveMessage(group.id, sessionId, newMessages[0])
  } else if (newMessages.length > 1) {
    await window.api.group.saveMessagesBatch(group.id, sessionId, newMessages)
  }

  set((s: GroupChatState) => ({
    messages: s.messages
      .filter((m: GroupMessage) => m.id !== placeholderId)
      .concat(newMessages)
      .sort((a: GroupMessage, b: GroupMessage) => a.timestamp - b.timestamp),
    isStreaming: false,
    currentStreamingCharId: null,
  }))
}

/** 检查是否需要自动触发记忆摘要 */
export function checkAutoMemory(get: GroupStoreGet) {
  const state = get()
  const session = state.sessions?.find((s) => s.id === state.currentSessionId)
  if (!session?.memoryEnabled || session.memoryMode !== 'auto') return
  const interval = session.autoMemoryInterval || 10
  // 按已处理的消息游标统计，编辑或设备时钟变化不会误判。
  const cursor = session.memoryLastMessageId
  const cursorIndex = cursor ? state.messages.findIndex((message) => message.id === cursor) : -1
  const unsummarizedCount = cursorIndex >= 0 ? state.messages.length - cursorIndex - 1 : state.messages.length
  if (unsummarizedCount >= interval) {
    state.triggerMemorySummary()
  }
}

/** 检查 polling 模式下是否需要继续下一轮 */
/**
 * 轮询续接检查。
 * @returns 已排定下一轮接力返回 true；已到轮数上限、无下一发言者或越界返回 false（轮到用户）。
 */
export async function checkPollingContinue(set: GroupStoreSet, get: GroupStoreGet, _group: GroupChat): Promise<boolean> {
  const state = get()
  // 使用最新的 currentGroup，避免闭包中过期引用
  const group = state.currentGroup
  if (!group) return false

  const pollingMsgs = state.messages.filter((m) => m.characterId !== '__user__' && m.characterId !== '__free__')
  const rounds = new Set(pollingMsgs.map((m) => m.round))
  if (rounds.size >= group.maxRounds) return false

  // 找下一个发言者
  const lastCharMsg = [...state.messages].reverse().find((m) => m.characterId !== '__user__' && m.characterId !== '__free__')
  if (!lastCharMsg) return false

  const currentIdx = group.memberIds.indexOf(lastCharMsg.characterId)
  if (currentIdx < 0) return false
  const nextIdx = (currentIdx + 1) % group.memberIds.length
  const nextCharId = group.memberIds[nextIdx]

  // 更新 currentSpeakerIndex（纯运行时 UI 状态：成员栏高亮"当前说话者"）
  // 优化：不再每轮全量持久化群组文件（此前每 2s 一次整文件写入）；
  // 群组文件只在创建/编辑时保存，重启后该索引回落到上次持久化值，轮询下一轮自动纠正
  const updatedGroup = { ...group, currentSpeakerIndex: nextIdx }
  set({ currentGroup: updatedGroup })

  // H-02 修复：保存定时器 handle，以便切换/删除群聊时清理
  clearPollingTimer()
  const scheduleNextPoll = () => {
    clearPollingTimer()
    pollingTimer = setTimeout(() => {
      const currentState = get()
      if (currentState.isStreaming) {
        // M-25 修复：流式中本轮跳过，但必须继续调度下一轮——
        // 此前直接 return 导致自动轮询链永久中断，无恢复机制
        scheduleNextPoll()
        return
      }
      // 定时器触发时再次检查群组是否仍为当前群组
      const curGroup = currentState.currentGroup
      if (!curGroup || curGroup.id !== group.id) return
      currentState.sendPollingRound(nextCharId)
    }, Math.max(500, group.speakerInterval || 2000))
  }
  scheduleNextPoll()
  return true
}

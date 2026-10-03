import { startHistoryCompression, type HistoryCompression } from './sessionFeatureTasks'
import { prepareGroupSpatialGeneration, registerGroupSpatialMessages, finishGroupSpatialBurst } from './groupSpatialSync'
import { nanoid } from 'nanoid'
import type { AIFinishReason, GroupChat, GroupMessage, Character, MemoryFactRecord } from '../../shared/types'
import { useSettingsStore, type ActiveProfile } from './useSettingsStore'
import { snapshotChatConfiguration, type ChatConfigurationSnapshot } from '../../shared/chatConnection'
import { useCharacterStore } from './useCharacterStore'
import { lorebookCache } from '../features/lorebook/lorebookCache'
import type { BudgetLoreItem } from '../../shared/chat-core/lorebook'
import { estimateTokens } from '../../shared/chat-core/tokenCounter'
import { countChars } from '../utils/charCounter'
import { replaceVariables } from '../../shared/chat-core/variables'
import { resolveEffectiveTemplate } from '../../shared/chat-core/chatTemplates'
import { collectStopStrings, findStopIndex } from '../../shared/chat-core/regex'
import { logError, logInfo, logWarn } from '../lib/logger'
import { safeSave } from '../lib/safeOps'
import { STREAM_THROTTLE_MS, SEMANTIC_SCAN_MAX_TOKENS, STREAM_IDLE_TIMEOUT_MS, DEFAULT_LOREBOOK_SCAN_DEPTH, resolveLorebookScanDepth } from '../../shared/chat-core/chatConstants'
import { buildLorebookRevisionCorpus, buildSemanticCacheKey, friendlyError, semanticCacheGet, semanticCacheSet } from './chatUtils'
import { resolveVisionModel } from '../utils/visionModel'
import { memoryFactsToTexts } from '../../shared/chat-core/memory'
import { stripVendorThinking } from '../../shared/chat-core/messagePostProcess'
import type { GroupChatState, GroupStoreGet, GroupStoreSet } from './groupChatTypes'
import { pushToast } from './useToastStore'
import { resolveNarrativeMode } from '../../shared/narrativeMode'
import { enabledProfileOverride, formatRequestBudgetRisk } from '../../shared/modelOutputProfile'
import { resolveGroupRequestPlan } from './groupRequestPlan'
// 阶段 6 S6-01：轮询续排/自动记忆/自由拆分的跨端共享纯逻辑（fixture oracle 即此实现）
import { planGroupPollingContinue, resolvePollingIntervalMs, planAutoMemoryTrigger } from '../../shared/chat-core/groupScheduling'
import { splitFreeReply } from '../../shared/chat-core/groupFreeSplit'
import { attemptTailRepair, finalizeNoticeFields, type GenerationOutcomeMeta } from './streamController'
import { prefetchUsageProfile, withReasoningSamples } from './usageProfileCache'
import {
  noteGateRecoveryFailure,
  noteGateRecoverySuccess,
  withReasoningGate,
} from './reasoningGateState'
import { nextRecoveryLevel } from './gateRecovery'
import type { ReasoningGateLevel } from '../../shared/reasoningGate'
import { finalizeGenerationTerminalResult, type GenerationTerminalOutcome } from '../../shared/chat-core/generatedReplyPipeline'
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
  /** S8：abandon 保留半截正文时需要的落盘上下文 */
  characterId: string
  isFree: boolean
  offstageCharacterIds?: string[]
  groupId: string
  sessionId: string
  round: number
  narrativeMode: import('../../shared/types').NarrativeMode
  /** 重生成专用：终态落盘完成后再替换旧消息；失败/停止时恢复原文。 */
  regenerationObserver?: GroupRegenerationObserver
}

export interface GroupRegenerationObserver {
  onTerminal: (success: boolean, generatedMessages?: readonly GroupMessage[]) => boolean | Promise<boolean>
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
export function claimGroupUserStop(): { requestId: string; msgId: string; accumulated: string; isFree: boolean; offstageCharacterIds?: string[]; regenerationObserver?: GroupRegenerationObserver } | null {
  const st = activeStream
  if (!st) return null
  if (!st.latch.claim('user_cancel')) return null
  const result = { requestId: st.requestId, msgId: st.msgId, accumulated: st.accumulated, isFree: st.isFree, offstageCharacterIds: st.offstageCharacterIds, regenerationObserver: st.regenerationObserver }
  cleanupActiveStream()
  return result
}

/** 群聊上下文溢出压缩：待执行任务（buildGroupContext 标记，流式完成后消费） */
interface PendingGroupCompression extends HistoryCompression {
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
 * S8：切换/删除群聊或会话时的统一停止收尾（store 层入口专用）。
 * claim latch → preserveGroupReplyContent → cancelChat → cleanup。
 * preserve=true 时返回已清理正文供调用方落盘，并 toast「已保留未完成回复并停止生成」。
 * 控制器内部终态收尾仍可直接 cleanupActiveStream()。
 */
export function abandonActiveStream(options: { preserve: boolean }): {
  requestId: string
  msgId: string
  preserved: string
  characterId: string
  isFree: boolean
  offstageCharacterIds?: string[]
  round: number
  narrativeMode: import('../../shared/types').NarrativeMode
  groupId: string
  sessionId: string
  regenerationObserver?: GroupRegenerationObserver
} | null {
  const st = activeStream
  if (!st) return null
  if (!st.latch.claim('user_cancel')) return null
  // 重生成被切换/删除打断时必须恢复旧消息，不能把半截新回复另行落盘。
  const preserved = options.preserve && !st.regenerationObserver ? preserveGroupReplyContent(st.accumulated) : ''
  const result = {
    requestId: st.requestId,
    msgId: st.msgId,
    preserved,
    characterId: st.characterId,
    isFree: st.isFree,
    offstageCharacterIds: st.offstageCharacterIds,
    round: st.round,
    narrativeMode: st.narrativeMode,
    groupId: st.groupId,
    sessionId: st.sessionId,
    regenerationObserver: st.regenerationObserver,
  }
  window.api.ai.cancelChat(result.requestId, 'user').catch((e) => logError('GroupChatStore:cancelChat', e))
  cleanupActiveStream()
  if (st.regenerationObserver) void st.regenerationObserver.onTerminal(false)
  if (options.preserve) {
    pushToast({ variant: 'info', title: '已保留未完成回复并停止生成' })
  }
  return result
}

/** S7：拆分前 msgId/内容 hash 判重——同一半截正文只允许落盘/拆分一次 */
const freeSplitSeenKeys = new Set<string>()

/** 简单 djb2 指纹：仅用于同会话内防重复拆分，不作安全哈希 */
function contentFingerprint(msgId: string, content: string): string {
  let h = 5381
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0
  }
  return `${msgId}:${(h >>> 0).toString(16)}`
}

/** 测试用：清空判重集合 */
export function resetFreeSplitDedupe(): void {
  freeSplitSeenKeys.clear()
}

/** S7：拆分前按 msgId/内容 hash 判重；首次返回 true 并记账 */
export function claimFreeSplitOnce(msgId: string, content: string): boolean {
  const key = contentFingerprint(msgId, content)
  if (freeSplitSeenKeys.has(key)) return false
  freeSplitSeenKeys.add(key)
  return true
}

/**
 * S7：异常/停止/放弃时的半截正文落盘。
 * free（`__free__`）强制走 splitAndSaveMessages 或回落首成员，禁止持久化不可渲染的 `__free__` 正文。
 * 拆分前按 msgId/内容 hash 判重。
 */
export async function persistPartialGroupReply(input: {
  set: GroupStoreSet
  get: GroupStoreGet
  group: GroupChat
  sessionId: string
  msgId: string
  content: string
  round: number
  characterId: string
  isFree: boolean
  offstageCharacterIds?: string[]
  narrativeMode: import('../../shared/types').NarrativeMode
  noticeFields?: { generationNotice?: string; generationError?: string }
}): Promise<void> {
  const clean = input.content
  if (!clean) return
  if (!claimFreeSplitOnce(input.msgId, clean)) return

  const isFreeBody = input.isFree || input.characterId === '__free__'
  if (isFreeBody) {
    await splitAndSaveMessages(input.set, input.get, input.group, input.sessionId, clean, input.round, input.msgId, {
      noticeFields: input.noticeFields,
      renderMode: { contentRenderMode: 'blocks' },
      offstageCharacterIds: input.offstageCharacterIds,
    })
    return
  }

  const renderMode = { contentRenderMode: 'blocks' as const }
  input.set((s: GroupChatState) => ({
    messages: s.messages.map((m: GroupMessage) =>
      m.id === input.msgId
        ? { ...m, content: clean, ...input.noticeFields, ...renderMode }
        : m,
    ),
    isStreaming: false,
    currentStreamingCharId: null,
  }))
  await window.api.group.saveMessage(input.group.id, input.sessionId, {
    id: input.msgId,
    groupId: input.group.id,
    characterId: input.characterId,
    content: clean,
    images: [],
    timestamp: Date.now(),
    round: input.round,
    narrativeMode: input.narrativeMode,
    ...input.noticeFields,
    ...renderMode,
  } as GroupMessage)
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
  profile?: ActiveProfile
  autoTailRepairEnabled?: boolean
}): Promise<{ content: string; noticeFields: { generationNotice?: string; generationError?: string }; stopped: boolean } | null> {
  const cause = terminationCauseFromFinishReason(input.finishReason)
  // 补尾限制（§8.1）：只有 provider_length 会被协调入口调用（每轮至多一次）
  const result = await finalizeGenerationTerminalResult({
    terminalResult: { rawText: input.rawText, finishReason: input.finishReason, terminationCause: cause },
    regexRules: input.regexRules,
    characterName: input.speaker.translatedContent?.name || input.speaker.name,
    runTailRepair: (input.autoTailRepairEnabled ?? useSettingsStore.getState().settings.autoTailRepairEnabled) === false ? undefined : (finalized) => attemptTailRepair({
      finalized,
      character: input.speaker,
      model: input.model,
      temperature: input.temperature,
      profile: input.profile,
    }),
  })
  if (!result.persistable || !result.content) return null

  const meta: GenerationOutcomeMeta = { finishReason: input.finishReason }
  if (result.notice) meta.notice = result.notice
  if (result.repairFailed) meta.repairFailed = true
  // 异常类提示（协调入口生成）优先；正常收尾走 finalizeNoticeFields 统一口径
  const noticeFields = Object.keys(result.noticeFields).length > 0
    ? result.noticeFields
    : finalizeNoticeFields(meta)
  return { content: result.content, noticeFields, stopped: cause === 'user_cancel' }
}

/**
 * UEX-P0-01：无正文终止失败（占位被移除、无存活气泡承载 generationError）时补全局 Toast，
 * 与 useGroupChatStore 的 setGroupError 模式对齐（store error 无 UI 直接订阅，不能静默）。
 */
function toastGroupGenerationFailure(detail: string): void {
  pushToast({ variant: 'error', title: '群聊生成失败', description: detail, requestId: 'group-generate-fail' })
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
  offstageCharacterIds?: string[]
  latch?: GenerationTerminationLatch
  /** NEW-M12：错误后继续推进轮询链/自动记忆检查 */
  onChainContinue?: () => void
  /** S7：free 半截正文拆分落盘需要 group/get */
  group?: GroupChat
  get?: GroupStoreGet
  set: GroupStoreSet
  regenerationObserver?: GroupRegenerationObserver
}, cause: GenerationTerminationCause, detailMessage: string): Promise<void> {
  // 抢占终止权：已被其它终止分支（或用户停止）处理过则直接忽略
  const st = activeStream
  if (st && st.requestId !== input.requestId) return
  if (input.latch && !input.latch.claim(cause)) return
  // 先取 accumulated 再清理（C-02 同款竞态保护；cleanup 同步合并未执行的 flush timer）
  const partialContent = st?.accumulated ?? ''
  input.offstageCharacterIds ??= st?.offstageCharacterIds
  cleanupActiveStream()
  if (cause === 'idle_timeout') {
    window.api.ai.cancelChat(input.requestId, 'timeout').catch((e) => logError('GroupChatStore:cancelChat', e))
  }

  const errText = terminationPromptWithoutContent(cause, detailMessage)
  if (input.regenerationObserver) {
    // 重生成失败不保留半截新回复：旧消息尚在持久层，直接撤回占位并恢复原文。
    input.set((s: GroupChatState) => ({
      messages: s.messages.filter((m: GroupMessage) => m.id !== input.msgId),
      isStreaming: false,
      currentStreamingCharId: null,
      error: errText,
    }))
    await input.regenerationObserver.onTerminal(false, [])
    return
  }
  try {
    const result = await finalizeGenerationTerminalResult({
      terminalResult: { rawText: partialContent, finishReason: 'unknown', terminationCause: cause, errorMessage: detailMessage },
      regexRules: input.regexRules,
      characterName: input.characterName,
    })
    await dispatchGroupTerminal(input, result, errText)
    if ((!input.onChainContinue || input.group?.chatMode !== 'polling' || !input.group?.autoMode) && input.group) await finishGroupSpatialBurst(input.group.id, input.sessionId)
    input.onChainContinue?.()
  } catch (e) {
    logError('GroupChatStore:terminalFinalize', e)
    input.latch?.markPersisted()
    input.set((s: GroupChatState) => ({
      messages: s.messages.filter((m: GroupMessage) => m.id !== input.msgId),
      isStreaming: false, currentStreamingCharId: null, error: errText,
    }))
    // UEX-P0-01：占位被移除、无存活气泡展示错误 → 补全局 Toast
    toastGroupGenerationFailure(errText)
    if ((!input.onChainContinue || input.group?.chatMode !== 'polling' || !input.group?.autoMode) && input.group) await finishGroupSpatialBurst(input.group.id, input.sessionId)
    input.onChainContinue?.()
  }
}

/** 终止派发：可保存正文 → 更新+落盘；无正文 → 移除占位（不创建空 AI 消息） */
async function dispatchGroupTerminal(input: Parameters<typeof handleGroupStreamException>[0], result: GenerationTerminalOutcome, errText: string) {
  input.latch?.markPersisted()
  const messageError = result.noticeFields.generationError ?? errText
  if (result.persistable && result.content) {
    // S7：free 半截正文禁止挂 __free__ 落盘——强制 splitAndSaveMessages 或回落首成员
    if (input.isFree || input.characterId === '__free__') {
      const group = input.group
      const get = input.get
      if (group && get) {
        await persistPartialGroupReply({
          set: input.set,
          get,
          group,
          sessionId: input.sessionId,
          msgId: input.msgId,
          content: result.content,
          round: input.round,
          characterId: input.characterId,
          isFree: true,
          offstageCharacterIds: input.offstageCharacterIds,
          narrativeMode: input.narrativeMode,
          noticeFields: result.noticeFields,
        })
        return
      }
      // 缺 group/get 时回落首成员；仍无成员则移除占位，绝不持久化 __free__
      const members = useCharacterStore.getState().characters.filter((c) =>
        (input.group?.memberIds ?? []).includes(c.id),
      )
      const fallbackId = members[0]?.id
      if (!fallbackId) {
        input.set((s: GroupChatState) => ({
          messages: s.messages.filter((m: GroupMessage) => m.id !== input.msgId),
          isStreaming: false, currentStreamingCharId: null, error: messageError,
        }))
        // UEX-P0-01：无成员可回落且占位被移除 → 补全局 Toast
        toastGroupGenerationFailure(messageError)
        return
      }
      input.characterId = fallbackId
      input.isFree = false
    }
    // 中断保留的正文与正常完成一致走语义分块。
    const renderMode = { contentRenderMode: 'blocks' as const }
    input.set((s: GroupChatState) => ({
      messages: s.messages.map((m: GroupMessage) =>
        m.id === input.msgId ? { ...m, content: result.content, ...result.noticeFields, ...renderMode } : m,
      ),
      isStreaming: false, currentStreamingCharId: null, error: messageError,
    }))
    await window.api.group.saveMessage(input.groupId, input.sessionId, {
      id: input.msgId, groupId: input.groupId, characterId: input.characterId,
      content: result.content, images: [], timestamp: input.get?.().messages.find((m: GroupMessage) => m.id === input.msgId && m.groupId === input.groupId)?.timestamp ?? Date.now(), round: input.round, narrativeMode: input.narrativeMode,
      ...result.noticeFields,
      ...renderMode,
    } as GroupMessage)
  } else {
    input.set((s: GroupChatState) => ({
      messages: s.messages.filter((m: GroupMessage) => m.id !== input.msgId),
      isStreaming: false, currentStreamingCharId: null, error: messageError,
    }))
    // UEX-P0-01：无正文终止失败、占位被移除 → 补全局 Toast
    toastGroupGenerationFailure(messageError)
  }
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
  latch?: GenerationTerminationLatch
  group?: GroupChat
  get?: GroupStoreGet
  set: GroupStoreSet
  regenerationObserver?: GroupRegenerationObserver
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
    corpus: buildLorebookRevisionCorpus(lorebookIds, (id) => lorebookCache.get(id)?.runtime?.revision),
    query: scanText,
    provider: st.provider,
    baseUrl: st.baseUrl,
    model: st.model,
    threshold: st.thresholdMode === 'manual' ? st.threshold : undefined,
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
      threshold: st.thresholdMode === 'manual' ? st.threshold : undefined,
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
    threshold: st.thresholdMode === 'manual' ? st.threshold : undefined,
    maxResults: st.maxResults,
  })
  const cached = semanticCacheGet<import('../../shared/domain/semanticFacts').FactSearchHit[]>(cacheKey)
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
      threshold: st.thresholdMode === 'manual' ? st.threshold : undefined,
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
async function compressGroupDroppedHistory(get: GroupStoreGet, set: GroupStoreSet, group: GroupChat, pending: PendingGroupCompression): Promise<void> {
  return startHistoryCompression({ owner: { kind: 'group', groupId: pending.groupId, sessionId: pending.sessionId }, pending,
    session: get().sessions.find(s => s.id === pending.sessionId), messages: get().messages, group,
    apply: patch => {
      if (get().currentGroup?.id !== pending.groupId || get().currentSessionId !== pending.sessionId) return
      set(s => ({ sessions: s.sessions.map(session => session.id === pending.sessionId ? { ...session, ...patch } : session) }))
    },
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

interface GroupRecovery {
  msgId: string
  gateLevel: ReasoningGateLevel
  recoveryUsed?: boolean
  configuration?: ChatConfigurationSnapshot
  context?: { role: 'system' | 'user' | 'assistant'; content: string }[]
  visionSnapshot?: import('../utils/visionModel').ResolvedVisionModel | null
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
  recovery?: GroupRecovery,
  regenerationObserver?: GroupRegenerationObserver,
): Promise<boolean> {
  /** S11：started = 成功挂上 activeStream 或发出 ai.chat */
  let started = false
  /** S11：early-return 统一复位 isStreaming/currentStreamingCharId（budgetRisk 为范例） */
  const failEarly = (err?: string): false => {
    set({
      isStreaming: false,
      currentStreamingCharId: null,
      ...(err ? { error: err } : {}),
    })
    void regenerationObserver?.onTerminal(false)
    void finishGroupSpatialBurst(group.id, sessionId)
    return false
  }
  try {
    const settingsStore = useSettingsStore.getState()
    const configuration = recovery?.configuration ?? snapshotChatConfiguration(settingsStore.settings)
    const { settings, profile } = configuration
    if (!profile) return failEarly()

    // BUG-08 修复：异步加载期间用户可能已切换群聊/会话，先校验一次
    if (!isGroupContextCurrent(get, group, sessionId)) return failEarly()
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


    // 预加载角色绑定的世界书
    if (speaker.boundLorebookIds && speaker.boundLorebookIds.length > 0) {
      await get().ensureLorebooksLoaded(speaker.boundLorebookIds)
    }

    // 世界书、记忆事实与用量画像互不依赖，并行预取，缩短首 token 前等待。
    await Promise.all([
      fetchGroupSemanticLoreHits(get, set, group, speaker.name),
      fetchGroupSemanticFacts(get, set),
      prefetchUsageProfile({
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        model: profile.model,
      }),
    ])
    // 阶段8（§4.2/§4.5）：本轮门控（恢复时用覆盖档位）；档位在 done 处理里用于判定降档
    const groupGate = withReasoningGate(profile, profile.model, recovery?.gateLevel)
    const requestPlan = resolveGroupRequestPlan({
      model: profile.model,
      messages: get().messages,
      preset,
      defaultResponseLength: settings.defaultResponseLength,
      profileOverride: enabledProfileOverride(profile.capabilityOverride),
      ...withReasoningSamples(profile, profile.model),
      ...groupGate,
    })
    const budgetRisk = formatRequestBudgetRisk(requestPlan.requestBudget)
    if (budgetRisk) {
      logWarn('GroupChatStore:budget', budgetRisk)
      return failEarly(budgetRisk)
    }

    const spatialContext = get().sessions.find(session => session.id === sessionId)?.spatialBoardEnabled !== true ? null : await window.api.spatial.readGroupContext(group.id, sessionId, speaker.id)
    if (!isGroupContextCurrent(get, group, sessionId)) return failEarly()
    if (narrativeMode === 'immersive' && spatialContext?.characterOffstage) { set({ isStreaming: false, currentStreamingCharId: null }); onComplete(); return false }
    const context = recovery?.context ?? get().buildGroupContext(speaker.id, preset, { spatialContext, configuration })

    if (context.length === 0) return failEarly()

    // Vision：上下文含图片且配置了激活识图模型 → 本轮使用识图模型连接（未填字段回退当前 Profile）
    const vision = recovery?.visionSnapshot === undefined ? resolveVisionModel(context) : recovery.visionSnapshot

    // BUG-08：占位消息写入前再次校验，避免追加到切换后的群聊 UI
    if (!isGroupContextCurrent(get, group, sessionId)) return failEarly()

    const requestId = nanoid()
    const spatialBurst = await prepareGroupSpatialGeneration(group, sessionId, requestId, spatialContext?.version, speaker.id, !!regenerationObserver)
    if (!isGroupContextCurrent(get, group, sessionId)) { await finishGroupSpatialBurst(group.id, sessionId); return failEarly() }
    // 阶段8：降档恢复复用原消息，避免留下 "(无回复)" + 新消息两条记录
    const msgId = recovery?.msgId ?? nanoid()
    // 阶段7：requestId 级一次性终止状态机（点名/轮询路径）
    const latch = createGenerationTerminationLatch(requestId)
    /** 降档恢复：复用同一 msgId 与同一上下文；成功后计入熔断清零 */
    const retryWithDowngradedGate = (level: ReasoningGateLevel) => {
      void streamGroupAI(set, get, group, sessionId, speaker, round, onComplete, {
        msgId, gateLevel: level, recoveryUsed: true, configuration, context, visionSnapshot: vision,
      }, regenerationObserver)
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
      set((_s: GroupChatState) => ({
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
          narrativeMode, regexRules, round, isFree: false, latch,
          group, get, set,
          regenerationObserver,
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
          model: profile.model,
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
          model: vision?.model ?? profile.model,
          profile: { ...profile, ...(vision ?? {}) },
          autoTailRepairEnabled: settings.autoTailRepairEnabled !== false,
          regexRules,
        })
        // 无可用正文：维持 (无回复) 占位
        const processed = finalizedReply?.content || '(无回复)'
        const noticeFields = finalizedReply?.noticeFields ?? {}
        const renderMode = finalizedReply ? { contentRenderMode: 'blocks' as const } : {}

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
        const completedMessage: GroupMessage = {
          id: msgId,
          groupId: group.id,
          characterId: speaker.id,
          content: processed,
          images: [],
          timestamp: get().messages.find(m => m.id === msgId && m.groupId === group.id)?.timestamp ?? Date.now(),
          round,
          narrativeMode,
          speakerKind: 'character',
          generationKind: 'assistant_reply',
          ...(spatialBurst ? { spatialGroupGenerationId: requestId } : {}),
          ...noticeFields,
          ...renderMode,
        }
        const saved = await safeSave(
          () => window.api.group.saveMessage(group.id, sessionId, completedMessage),
          '消息保存',
        )

        if (saved && isGroupContextCurrent(get, group, sessionId)) set(s => ({
          messages: s.messages.map(m => m.id === msgId ? { ...m, timestamp: completedMessage.timestamp,
            spatialGroupGenerationId: completedMessage.spatialGroupGenerationId } : m),
        }))

        // 字符用量统计
        const model = vision?.model ?? profile.model
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

        const replacementCommitted = regenerationObserver
          ? await regenerationObserver.onTerminal(saved, saved ? [completedMessage] : [])
          : true
        if (saved && replacementCommitted && finalizedReply && (stopStringsHit ? 'stop' : finishReason) === 'stop' && !noticeFields.generationError && !noticeFields.generationNotice) await registerGroupSpatialMessages(group.id, sessionId, requestId, spatialBurst, [completedMessage])
        if (group.chatMode !== 'polling' || !group.autoMode) await finishGroupSpatialBurst(group.id, sessionId)
        if (replacementCommitted) onComplete()
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
        narrativeMode, regexRules, round, isFree: false, latch,
          onChainContinue: onComplete,
          group, get, set,
          regenerationObserver,
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
      characterId: speaker.id,
      isFree: false,
      groupId: group.id,
      sessionId,
      round,
      narrativeMode,
      regenerationObserver,
      timeoutHandle: setTimeout(() => {
        void handleGroupStreamTimeout({
          requestId, msgId, groupId: group.id, sessionId,
          characterId: speaker.id,
          characterName: speaker.translatedContent?.name || speaker.name,
          narrativeMode, regexRules, round, isFree: false, latch,
          group, get, set,
          regenerationObserver,
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
          ...(requestPlan.requestBudget ? {
            plannedBodyTokens: requestPlan.requestBudget.bodyReserve,
            plannedReasoningTokens: requestPlan.requestBudget.reasoningReserve,
          } : {}),
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
        narrativeMode, regexRules, round, isFree: false, latch,
        group, get, set,
        regenerationObserver,
      }, 'protocol_error', friendlyError(err instanceof Error ? err.message : '请求失败'))
    }
    // activeStream 已挂上（或发送即失败由异常收口接管）
    started = true
    return true
  } catch (err) {
    // S11：挂流前意外异常也要复位，避免输入区卡死
    if (!started) {
      return failEarly(friendlyError(err instanceof Error ? err.message : '请求失败'))
    }
    return true
  } finally {
    // S11：未成功启动（early-return/挂流前异常）一律复位流式标记
    if (!started) {
      set((s: GroupChatState) => (
        s.isStreaming || s.currentStreamingCharId
          ? { isStreaming: false, currentStreamingCharId: null }
          : {}
      ))
    }
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
  recovery?: GroupRecovery,
  regenerationObserver?: GroupRegenerationObserver,
): Promise<boolean> {
  /** S11：started = 成功挂上 activeStream 或发出 ai.chat */
  let started = false
  /** S11：early-return 统一复位 isStreaming/currentStreamingCharId */
  const failEarly = (err?: string): false => {
    set({
      isStreaming: false,
      currentStreamingCharId: null,
      ...(err ? { error: err } : {}),
    })
    void regenerationObserver?.onTerminal(false)
    void finishGroupSpatialBurst(group.id, sessionId)
    return false
  }
  try {
    const settingsStore = useSettingsStore.getState()
    const configuration = recovery?.configuration ?? snapshotChatConfiguration(settingsStore.settings)
    const { settings, profile } = configuration
    if (!profile) return failEarly()

    // BUG-08 修复：异步加载期间用户可能已切换群聊/会话，先校验一次
    if (!isGroupContextCurrent(get, group, sessionId)) return failEarly()
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

    await Promise.all([
      fetchGroupSemanticLoreHits(get, set, group, ''),
      fetchGroupSemanticFacts(get, set),
      prefetchUsageProfile({
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        model: profile.model,
      }),
    ])
    // 阶段8（§4.2/§4.5）：本轮门控（恢复时用覆盖档位）；档位在 done 处理里用于判定降档
    const groupGate = withReasoningGate(profile, profile.model, recovery?.gateLevel)
    const requestPlan = resolveGroupRequestPlan({
      model: profile.model,
      messages: get().messages,
      preset,
      defaultResponseLength: settings.defaultResponseLength,
      profileOverride: enabledProfileOverride(profile.capabilityOverride),
      ...withReasoningSamples(profile, profile.model),
      ...groupGate,
    })
    const budgetRisk = formatRequestBudgetRisk(requestPlan.requestBudget)
    if (budgetRisk) {
      logWarn('GroupChatStore:budget', budgetRisk)
      return failEarly(budgetRisk)
    }

    const spatialContext = get().sessions.find(session => session.id === sessionId)?.spatialBoardEnabled !== true ? null : await window.api.spatial.readGroupContext(group.id, sessionId)
    if (!isGroupContextCurrent(get, group, sessionId)) return failEarly()
    const offstageCharacterIds = narrativeMode === 'immersive' ? spatialContext?.offstageCharacterIds : undefined
    if (offstageCharacterIds && group.memberIds.every(id => offstageCharacterIds.includes(id))) return failEarly('当前群成员在画板中均明确不参与对话')
    const context = recovery?.context ?? get().buildGroupContext(undefined, preset, { spatialContext, configuration })

    if (context.length === 0) return failEarly()

    // Vision：上下文含图片且配置了激活识图模型 → 本轮使用识图模型连接（未填字段回退当前 Profile）
    const vision = recovery?.visionSnapshot === undefined ? resolveVisionModel(context) : recovery.visionSnapshot

    // BUG-08：占位消息写入前再次校验，避免追加到切换后的群聊 UI
    if (!isGroupContextCurrent(get, group, sessionId)) return failEarly()

    const requestId = nanoid()
    const spatialBurst = await prepareGroupSpatialGeneration(group, sessionId, requestId, spatialContext?.version, undefined, !!regenerationObserver)
    if (!isGroupContextCurrent(get, group, sessionId)) { await finishGroupSpatialBurst(group.id, sessionId); return failEarly() }
    // 阶段8：降档恢复复用原消息，避免留下 "(无回复)" + 新消息两条记录
    const msgId = recovery?.msgId ?? nanoid()
    // 阶段7：requestId 级一次性终止状态机（自由发言路径）
    const latch = createGenerationTerminationLatch(requestId)
    /** 降档恢复：复用同一 msgId 与同一上下文（自由发言无固定角色） */
    const retryWithDowngradedGate = (level: ReasoningGateLevel) => {
      void streamGroupAIFree(set, get, group, sessionId, round, {
        msgId, gateLevel: level, recoveryUsed: true, configuration, context, visionSnapshot: vision,
      }, regenerationObserver)
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
      set((_s: GroupChatState) => ({
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
          narrativeMode, regexRules, round, isFree: true, latch,
          group, get, set,
          regenerationObserver,
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
          model: profile.model,
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
          model: vision?.model ?? profile.model,
          profile: { ...profile, ...(vision ?? {}) },
          autoTailRepairEnabled: settings.autoTailRepairEnabled !== false,
          regexRules,
        })
        latch.markPersisted()
        const processed = finalizedReply?.content || '(无回复)'
        const extras = finalizedReply
          ? { noticeFields: finalizedReply.noticeFields, renderMode: { contentRenderMode: 'blocks' as const } }
          : undefined
        let savedMessages: GroupMessage[] = []
        try {
          savedMessages = await splitAndSaveMessages(set, get, group, sessionId, processed, round, msgId, { ...extras, offstageCharacterIds, spatialGroupGenerationId: spatialBurst ? requestId : undefined })
        } catch (error) {
          logError('GroupChatStore:saveRegeneratedFreeMessage', error)
          set((state: GroupChatState) => ({
            messages: state.messages.filter((message: GroupMessage) => message.id !== msgId),
            isStreaming: false,
            currentStreamingCharId: null,
          }))
        }
        const replacementCommitted = await regenerationObserver?.onTerminal(savedMessages.length > 0, savedMessages)
        if (replacementCommitted !== false && finalizedReply && (stopStringsHit ? 'stop' : finishReason) === 'stop' && !finalizedReply.noticeFields.generationError && !finalizedReply.noticeFields.generationNotice) await registerGroupSpatialMessages(group.id, sessionId, requestId, spatialBurst, savedMessages)
        await finishGroupSpatialBurst(group.id, sessionId)

        // 字符用量统计
        const model = vision?.model ?? profile.model
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
        narrativeMode, regexRules, round, isFree: true, latch,
        group, get, set,
        regenerationObserver,
      }, 'transport_error', friendlyMsg)
    })

    activeStream = {
      requestId, msgId, accumulated: '', flushTimer: null,
      unbindChunk, unbindDone, unbindError,
      latch, stopStringsHit: false,
      characterId: freeMessageCharacterId,
      isFree: true,
      offstageCharacterIds,
      groupId: group.id,
      sessionId,
      round,
      narrativeMode,
      regenerationObserver,
      timeoutHandle: setTimeout(() => {
        void handleGroupStreamTimeout({
          requestId, msgId, groupId: group.id, sessionId,
          characterId: freeMessageCharacterId,
          characterName: group.name,
          narrativeMode, regexRules, round, isFree: true, latch,
          group, get, set,
          regenerationObserver,
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
          ...(requestPlan.requestBudget ? {
            plannedBodyTokens: requestPlan.requestBudget.bodyReserve,
            plannedReasoningTokens: requestPlan.requestBudget.reasoningReserve,
          } : {}),
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
        narrativeMode, regexRules, round, isFree: true, latch,
        group, get, set,
        regenerationObserver,
      }, 'protocol_error', friendlyError(err instanceof Error ? err.message : '请求失败'))
    }
    started = true
    return true
  } catch (err) {
    if (!started) {
      return failEarly(friendlyError(err instanceof Error ? err.message : '请求失败'))
    }
    return true
  } finally {
    if (!started) {
      set((s: GroupChatState) => (
        s.isStreaming || s.currentStreamingCharId
          ? { isStreaming: false, currentStreamingCharId: null }
          : {}
      ))
    }
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
  extras?: { noticeFields?: { generationNotice?: string; generationError?: string }; renderMode?: { contentRenderMode: 'blocks' }; offstageCharacterIds?: string[]; spatialGroupGenerationId?: string },
): Promise<GroupMessage[]> {
  const narrativeMode = resolveNarrativeMode(get().sessions?.find((session) => session.id === sessionId)?.narrativeMode)
  const offstageCharacterIds = narrativeMode === 'immersive' ? extras?.offstageCharacterIds : undefined
  const charStore = useCharacterStore.getState()
  const members = group.memberIds
    .map(id => charStore.characters.find(c => c.id === id))
    .filter(Boolean) as Character[]

  if (offstageCharacterIds && group.memberIds.every(id => offstageCharacterIds!.includes(id))) {
    set(state => ({ messages: state.messages.filter(message => message.id !== placeholderId), isStreaming: false, currentStreamingCharId: null }))
    return []
  }

  // 拆分与归属：shared/chat-core/groupFreeSplit.ts 跨端一致（omniscient 不拆分、
  // 旁白并入首段、未识别角色旁注归属首成员、无标记回落首成员）
  const split = splitFreeReply({ content, members, narrativeMode })

  if (split.kind === 'narrator') {
    const narratorMessage: GroupMessage = {
      id: placeholderId,
      groupId: group.id,
      characterId: members.find(member => !offstageCharacterIds?.includes(member.id))?.id ?? split.messages[0].characterId,
      content: split.messages[0].content,
      images: [],
      timestamp: Date.now(),
      round,
      narrativeMode,
      speakerKind: 'character',
      ...(extras?.spatialGroupGenerationId ? { spatialGroupGenerationId: extras.spatialGroupGenerationId } : {}),
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
    return [narratorMessage]
  }

  if (split.kind === 'fallback') {
    // 没有匹配到任何角色标记 → 将占位消息改为第一个成员的消息，避免渲染为不可见
    const fallbackChar = members.find(member => !offstageCharacterIds?.includes(member.id))
    // S7：禁止持久化不可渲染的 __free__ 正文——无成员时移除占位，不落盘
    if (!fallbackChar) {
      set((s: GroupChatState) => ({
        messages: s.messages.filter((m: GroupMessage) => m.id !== placeholderId),
        isStreaming: false, currentStreamingCharId: null,
      }))
      return []
    }
    set((s: GroupChatState) => ({
      messages: s.messages.map((m: GroupMessage) =>
        m.id === placeholderId
          ? { ...m, characterId: fallbackChar.id, content: split.messages[0].content, ...(extras?.renderMode ?? {}), ...(extras?.noticeFields ?? {}) }
          : m,
      ),
      isStreaming: false, currentStreamingCharId: null,
    }))
    // 持久化更新后的占位消息（归属首成员，绝不落盘 __free__）
    const fallbackMessage: GroupMessage = {
      id: placeholderId,
      groupId: group.id,
      characterId: fallbackChar.id,
      content: split.messages[0].content,
      images: [],
      timestamp: Date.now(),
      round,
      narrativeMode,
      speakerKind: 'character',
      ...(extras?.spatialGroupGenerationId ? { spatialGroupGenerationId: extras.spatialGroupGenerationId } : {}),
      generationKind: 'assistant_reply',
      ...(extras?.renderMode ?? {}),
      ...(extras?.noticeFields ?? {}),
    }
    await window.api.group.saveMessage(group.id, sessionId, fallbackMessage)
    return [fallbackMessage]
  }

  // 移除占位消息，替换为拆分的角色消息（过滤任何 __free__，禁止不可渲染正文落盘）
  const newMessages: GroupMessage[] = split.messages
    .filter((segment) => segment.characterId !== '__free__' && !offstageCharacterIds?.includes(segment.characterId) && !!segment.content?.trim())
    .map((segment) => ({
      id: nanoid(),
      groupId: group.id,
      characterId: segment.characterId,
      content: segment.content,
      images: [],
      timestamp: Date.now(),
      round,
      narrativeMode,
      speakerKind: 'character',
      ...(extras?.spatialGroupGenerationId ? { spatialGroupGenerationId: extras.spatialGroupGenerationId } : {}),
      generationKind: 'assistant_reply',
    }))

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
  return newMessages
}

/** 检查是否需要自动触发记忆摘要 */
export function checkAutoMemory(get: GroupStoreGet) {
  const state = get()
  const session = state.sessions?.find((s) => s.id === state.currentSessionId)
  // 触发判定：shared/chat-core/groupScheduling.ts 跨端一致（按已处理游标统计，编辑或时钟变化不误判）
  const shouldTrigger = planAutoMemoryTrigger({
    memoryEnabled: session?.memoryEnabled,
    memoryMode: session?.memoryMode,
    autoMemoryInterval: session?.autoMemoryInterval,
    memoryLastMessageId: session?.memoryLastMessageId ?? null,
    messageIds: state.messages.map((message) => message.id),
  })
  if (shouldTrigger) {
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
  if (group.id !== _group.id) return false
  const scopeSessionId = state.currentSessionId
  const spatial = state.sessions.find(session => session.id === scopeSessionId)?.spatialBoardEnabled === true && scopeSessionId ? await window.api.spatial.readGroupContext(group.id, scopeSessionId) : null
  if (get().currentGroup?.id !== group.id || get().currentSessionId !== scopeSessionId) return false
  const eligibleMemberIds = spatial?.narrativeMode === 'omniscient' ? group.memberIds : group.memberIds.filter(id => !spatial?.offstageCharacterIds.includes(id))

  // 续排计划：shared/chat-core/groupScheduling.ts 跨端一致
  // （D2 已拍板：轮数按每次接力（burst）计——自最近一条用户消息以来的 AI 轮次，跨用户消息重置）
  const plan = planGroupPollingContinue({
    messages: state.messages.map((m) => ({ characterId: m.characterId, round: m.round })),
    memberIds: eligibleMemberIds,
    maxRounds: group.maxRounds,
  })
  if (!plan.continue) return false
  const nextCharId = plan.nextCharId

  // 更新 currentSpeakerIndex（纯运行时 UI 状态：成员栏高亮"当前说话者"）
  // 优化：不再每轮全量持久化群组文件（此前每 2s 一次整文件写入）；
  // 群组文件只在创建/编辑时保存，重启后该索引回落到上次持久化值，轮询下一轮自动纠正
  const updatedGroup = { ...group, currentSpeakerIndex: group.memberIds.indexOf(nextCharId) }
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
    }, resolvePollingIntervalMs(group.speakerInterval))
  }
  scheduleNextPoll()
  return true
}

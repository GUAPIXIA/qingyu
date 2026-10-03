import { startHistoryCompression, type HistoryCompression } from '../../store/sessionFeatureTasks'
import { prepareGroupSpatialGeneration, registerGroupSpatialMessages, finishGroupSpatialBurst } from '../../store/groupSpatialSync'
import { nanoid } from 'nanoid'
import type { GroupChat, GroupMessage, Character, MemoryFactRecord } from '../../../shared/types'
import { useSettingsStore } from '../../store/useSettingsStore'
import { snapshotChatConfiguration, type ChatConfigurationSnapshot } from '../../../shared/chatConnection'
import { useCharacterStore } from '../../store/useCharacterStore'
import { lorebookCache } from '../lorebook/lorebookCache'
import type { BudgetLoreItem } from '../../../shared/chat-core/lorebook'
import { estimateTokens } from '../../../shared/chat-core/tokenCounter'
import { countChars } from '../../utils/charCounter'
import { replaceVariables } from '../../../shared/chat-core/variables'
import { resolveEffectiveTemplate } from '../../../shared/chat-core/chatTemplates'
import { collectStopStrings, findStopIndex } from '../../../shared/chat-core/regex'
import { logError, logInfo, logWarn } from '../../lib/logger'
import { safeSave } from '../../lib/safeOps'
import { STREAM_THROTTLE_MS, SEMANTIC_SCAN_MAX_TOKENS, STREAM_IDLE_TIMEOUT_MS, DEFAULT_LOREBOOK_SCAN_DEPTH, resolveLorebookScanDepth } from '../../../shared/chat-core/chatConstants'
import { buildLorebookRevisionCorpus, buildSemanticCacheKey, friendlyError, semanticCacheGet, semanticCacheSet } from '../../store/chatUtils'
import { resolveVisionModel } from '../../utils/visionModel'
import { memoryFactsToTexts } from '../../../shared/chat-core/memory'
import type { GroupChatState, GroupStoreGet, GroupStoreSet } from '../../store/groupChatTypes'
import { resolveNarrativeMode } from '../../../shared/narrativeMode'
import { enabledProfileOverride, formatRequestBudgetRisk } from '../../../shared/modelOutputProfile'
import { resolveGroupRequestPlan } from '../../store/groupRequestPlan'
import { prefetchUsageProfile, withReasoningSamples } from '../../store/usageProfileCache'
import {
  noteGateRecoveryFailure,
  noteGateRecoverySuccess,
  withReasoningGate,
} from '../../store/reasoningGateState'
import { nextRecoveryLevel } from '../../store/gateRecovery'
import type { ReasoningGateLevel } from '../../../shared/reasoningGate'
import {
  createGenerationTerminationLatch,
  terminationCauseFromFinishReason,
} from '../../../shared/generationTermination'
import type { GenerationTerminationCause } from '../../../shared/types'
import { attachActiveStream, cleanupActiveStream, flushActiveStream, getActiveStream, type GroupRegenerationObserver } from './streamSession'
import { finalizeGroupReply, handleGroupStreamException, handleGroupStreamTimeout, splitAndSaveMessages } from './messageFinalizer'
import { clearPollingTimer } from './modeScheduler'

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
  const cached = semanticCacheGet<import('../../../shared/domain/semanticFacts').FactSearchHit[]>(cacheKey)
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
  visionSnapshot?: import('../../utils/visionModel').ResolvedVisionModel | null
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
    let regexRules: import('../../../shared/types').RegexRule[] = []
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
      const activeStream = getActiveStream()
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
          flushActiveStream(set)
          window.api.ai.cancelChat(requestId, 'stop_string').catch(() => {})
          return
        }
      }
      if (activeStream.flushTimer === null) {
        activeStream.flushTimer = setTimeout(() => flushActiveStream(set), STREAM_THROTTLE_MS)
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
      const activeStream = getActiveStream()
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

    attachActiveStream({
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
    })

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
    let regexRules: import('../../../shared/types').RegexRule[] = []
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
      const activeStream = getActiveStream()
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
          flushActiveStream(set)
          window.api.ai.cancelChat(requestId, 'stop_string').catch(() => {})
          return
        }
      }
      if (activeStream.flushTimer === null) {
        activeStream.flushTimer = setTimeout(() => flushActiveStream(set), STREAM_THROTTLE_MS)
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
      const activeStream = getActiveStream()
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

    attachActiveStream({
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
    })

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


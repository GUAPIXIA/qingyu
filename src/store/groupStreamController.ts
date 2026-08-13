import { nanoid } from 'nanoid'
import type { GroupChat, GroupMessage, Character } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'
import { lorebookCache } from '../utils/lorebook'
import type { BudgetLoreItem } from '../utils/lorebook'
import { estimateTokens } from '../utils/tokenCounter'
import { countChars } from '../utils/charCounter'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { replaceVariables } from '../utils/variables'
import { resolveEffectiveTemplate } from '../utils/chatTemplates'
import { applyOutputRegexRules, truncateAtStop, collectStopStrings, findStopIndex } from '../utils/regex'
import { logError, logInfo, logWarn } from '../lib/logger'
import { STREAM_THROTTLE_MS, SEMANTIC_SCAN_MAX_TOKENS, STREAM_IDLE_TIMEOUT_MS } from './chatConstants'
import { friendlyError, semanticCacheGet, semanticCacheSet } from './chatUtils'
import { resolveVisionModel } from '../utils/visionModel'
import type { GroupChatState, GroupStoreGet, GroupStoreSet } from './groupChatTypes'

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
}

let activeStream: ActiveStream | null = null

/** 读取当前活动流（stopStreaming 等需要读取） */
export function getActiveStream(): ActiveStream | null {
  return activeStream
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

/** 对文本应用 output 正则规则（两阶段：text + markdown，与单聊一致——增量共享 applyOutputRegexRules） */

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
    if (get()._semanticLoreHits.length > 0) set({ _semanticLoreHits: [] })
  }
  if (!st?.enabled || !st.baseUrl?.trim() || !st.model?.trim()) return clear()

  // 群聊级 + 角色绑定世界书
  const charStore = useCharacterStore.getState()
  const allLorebookIds = new Set<string>(group.lorebookIds)
  group.memberIds.forEach((mid) => {
    const c = charStore.characters.find((ch) => ch.id === mid)
    if (c?.boundLorebookIds) c.boundLorebookIds.forEach((id) => allLorebookIds.add(id))
  })
  const lorebookIds = [...allLorebookIds]
  if (lorebookIds.length === 0) return clear()

  const scanDepth = lorebookIds
    .map(id => lorebookCache.get(id)?.scanDepth)
    .filter((d): d is number => typeof d === 'number' && d > 0)
    .reduce((max, d) => Math.max(max, d), 10)
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
  const cacheKey = `glore|${lorebookIds.join(',')}|${scanText}|${st.model}`
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
      content: replaceVariables(h.content, settings.userName, charName || '角色'),
      order: h.order,
      position: h.position,
      depth: h.depth,
    }))
    set({ _semanticLoreHits: items })
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
  if (!st?.enabled || !st.baseUrl?.trim() || !st.model?.trim()) return clear()

  const { sessions, currentSessionId } = get()
  const session = sessions.find((s) => s.id === currentSessionId)
  if (!session?.memoryEnabled || !session.memoryFacts?.length) return clear()
  const vectors = session.factsVectors
  if (!vectors || vectors.length !== session.memoryFacts.length) return clear()

  const query = get().messages.slice(-20).map((m) => m.content).join(' ')
  if (!query.trim()) return clear()

  // 缓存：同一轮对话查询不变时复用（省嵌入 API 调用）
  const cacheKey = `gfacts|${session.id}|${query}|${st.model}`
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
 * 群聊记忆事实向量化（P0-2）
 */
export async function vectorizeGroupSessionFacts(groupId: string, sessionId: string, facts: string[]): Promise<void> {
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
      await window.api.group.updateSession(groupId, sessionId, { factsVectors: vectors })
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
  const unbindDone = window.api.ai.onDone((doneId) => {
    if (doneId !== requestId) return
    cleanup()
    finished = true
    const summary = result.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
    if (summary) {
      window.api.group.updateSession(group.id, pending.sessionId, {
        compressedSummary: summary,
        compressedRange: { startTs: pending.droppedStartTs, endTs: pending.droppedEndTs },
      }).then(async () => {
        const sessions = await window.api.group.listSessions(group.id)
        set({ sessions })
      }).catch(() => { /* 忽略 */ })
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
    maxTokens: 600,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stream: true,
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
) {
  const settingsStore = useSettingsStore.getState()
  const profile = settingsStore.getActiveProfile()
  if (!profile) return

  // BUG-08 修复：异步加载期间用户可能已切换群聊/会话，先校验一次
  if (!isGroupContextCurrent(get, group, sessionId)) return

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

  // 语义触发预取（向量 RAG）：失败静默降级为纯关键词
  await fetchGroupSemanticLoreHits(get, set, group, speaker.name)
  // 记忆事实语义检索预取（P0-2）：失败回退全量注入
  await fetchGroupSemanticFacts(get, set)

  const context = get().buildGroupContext(speaker.id, preset)

  if (context.length === 0) return

  // Vision：上下文含图片且配置了激活识图模型 → 本轮使用识图模型连接（未填字段回退当前 Profile）
  const vision = resolveVisionModel(context)

  // BUG-08：占位消息写入前再次校验，避免追加到切换后的群聊 UI
  if (!isGroupContextCurrent(get, group, sessionId)) return

  const requestId = nanoid()
  const msgId = nanoid()

  // 等待中的占位消息
  const placeholder: GroupMessage = {
    id: msgId,
    groupId: group.id,
    characterId: speaker.id,
    content: '',
    images: [],
    timestamp: Date.now(),
    round,
  }
  set((s: GroupChatState) => ({
    messages: [...s.messages, placeholder],
    isStreaming: true,
    currentStreamingCharId: speaker.id,
    error: null,
  }))

  // 停止字符串（output 正则规则）：流式命中后截断 + 提前终止，省 token
  const stopStrings = collectStopStrings(regexRules)

  // 绑定流式事件
  const unbindChunk = window.api.ai.onChunk((data: { requestId: string; text: string }) => {
    if (data.requestId !== requestId || !activeStream || activeStream.requestId !== requestId) return
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
    if (activeStream.flushTimer === null) {
      activeStream.flushTimer = setTimeout(() => flushStream(set), STREAM_THROTTLE_MS)
    }
    // 空闲超时续期：收到 chunk 即重置 60s 计时（卡死时更快恢复）
    if (activeStream.timeoutHandle) clearTimeout(activeStream.timeoutHandle)
    activeStream.timeoutHandle = setTimeout(() => {
      const partialContent = activeStream?.accumulated ?? ''
      cleanupActiveStream()
      window.api.ai.cancelChat(requestId).catch((e) => logError('GroupChatStore:cancelChat', e))
      const clean = partialContent.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
      if (clean) {
        set((s: GroupChatState) => ({
          messages: s.messages.map((m: GroupMessage) =>
            m.id === msgId ? { ...m, content: clean + '\n\n⚠️ 请求超时' } : m,
          ),
          isStreaming: false, currentStreamingCharId: null, error: '请求超时',
        }))
        window.api.group.saveMessage(group.id, sessionId, {
          id: msgId, groupId: group.id, characterId: speaker.id,
          content: clean + '\n\n⚠️ 请求超时', images: [], timestamp: Date.now(), round,
        }).catch((e) => logError('GroupChatStore:saveMessage', e))
      } else {
        set((s: GroupChatState) => ({
          messages: s.messages.filter((m: GroupMessage) => m.id !== msgId),
          isStreaming: false, currentStreamingCharId: null, error: '请求超时',
        }))
      }
    }, STREAM_IDLE_TIMEOUT_MS)
  })

  const unbindDone = window.api.ai.onDone((doneId: string) => {
    if (doneId !== requestId || !activeStream || activeStream.requestId !== requestId) return

    if (activeStream.flushTimer !== null) {
      clearTimeout(activeStream.flushTimer)
      activeStream.flushTimer = null
    }

    const finalContent = activeStream.accumulated

    cleanupActiveStream()

    // 剥离 thought
    const clean = finalContent.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()

    // 应用正则规则 + 停止字符串截断
    const processed = regexRules.length > 0
      ? truncateAtStop(applyOutputRegexRules(clean, regexRules), collectStopStrings(regexRules)).text
      : clean

    // 更新消息
    set((s: GroupChatState) => ({
      messages: s.messages.map((m: GroupMessage) =>
        m.id === msgId ? { ...m, content: processed || '(无回复)' } : m,
      ),
      isStreaming: false,
      currentStreamingCharId: null,
    }))

    // 持久化
    window.api.group.saveMessage(group.id, sessionId, {
      id: msgId,
      groupId: group.id,
      characterId: speaker.id,
      content: processed || '(无回复)',
      images: [],
      timestamp: Date.now(),
      round,
    })

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
  })

  const unbindError = window.api.ai.onError((data: { requestId: string; error: string }) => {
    if (data.requestId !== requestId || !activeStream || activeStream.requestId !== requestId) return

    // 审查报告 P2：truthy 检查替代 `!== null`——activeStream 为 null 时
    // `activeStream?.flushTimer !== null` 为 true 会进入分支并在 clearTimeout 处抛 TypeError
    if (activeStream.flushTimer) {
      clearTimeout(activeStream.flushTimer)
      activeStream.flushTimer = null
    }
    // C-02 修复：先保存 accumulated 再 cleanup，否则 activeStream 已被置 null
    const accumulated = activeStream?.accumulated ?? ''
    cleanupActiveStream()

    const friendlyMsg = friendlyError(data.error)
    const errContent = accumulated
      ? accumulated + '\n\n⚠️ ' + friendlyMsg
      : '⚠️ ' + friendlyMsg

    set((s: GroupChatState) => ({
      messages: s.messages.map((m: GroupMessage) =>
        m.id === msgId ? { ...m, content: errContent } : m,
      ),
      isStreaming: false,
      currentStreamingCharId: null,
      error: data.error,
    }))

    window.api.group.saveMessage(group.id, sessionId, {
      id: msgId,
      groupId: group.id,
      characterId: speaker.id,
      content: errContent,
      images: [],
      timestamp: Date.now(),
      round,
    })

    // NEW-M12 修复：错误时也调用 onComplete，保证 polling 轮询链/自动记忆检查继续推进
    onComplete()
  })

  activeStream = {
    requestId,
    msgId,
    accumulated: '',
    flushTimer: null,
    unbindChunk,
    unbindDone,
    unbindError,
    timeoutHandle: setTimeout(() => {
      const partialContent = activeStream?.accumulated ?? ''
      cleanupActiveStream()
      window.api.ai.cancelChat(requestId).catch((e) => logError('GroupChatStore:cancelChat', e))
      const clean = partialContent.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
      if (clean) {
        // 有部分内容，保留并标记超时
        set((s: GroupChatState) => ({
          messages: s.messages.map((m: GroupMessage) =>
            m.id === msgId ? { ...m, content: clean + '\n\n⚠️ 请求超时' } : m,
          ),
          isStreaming: false, currentStreamingCharId: null, error: '请求超时',
        }))
        window.api.group.saveMessage(group.id, sessionId, {
          id: msgId, groupId: group.id, characterId: speaker.id,
          content: clean + '\n\n⚠️ 请求超时', images: [], timestamp: Date.now(), round,
        }).catch((e) => logError('GroupChatStore:saveMessage', e))
      } else {
        // 无内容，移除占位消息
        set((s: GroupChatState) => ({
          messages: s.messages.filter((m: GroupMessage) => m.id !== msgId),
          isStreaming: false, currentStreamingCharId: null, error: '请求超时',
        }))
      }
    }, STREAM_IDLE_TIMEOUT_MS),
  }

  // 发起 AI 请求
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
      maxTokens: preset?.maxTokens ?? 1024,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: true,
      instructTemplate,
    })
  } catch (err) {
    cleanupActiveStream()
    set({
      isStreaming: false,
      currentStreamingCharId: null,
      error: err instanceof Error ? err.message : '请求失败',
    })
  }
}

export async function streamGroupAIFree(
  set: GroupStoreSet,
  get: GroupStoreGet,
  group: GroupChat,
  sessionId: string,
  round: number,
) {
  const settingsStore = useSettingsStore.getState()
  const profile = settingsStore.getActiveProfile()
  if (!profile) return

  // BUG-08 修复：异步加载期间用户可能已切换群聊/会话，先校验一次
  if (!isGroupContextCurrent(get, group, sessionId)) return

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

  const context = get().buildGroupContext(undefined, preset)

  if (context.length === 0) return

  // Vision：上下文含图片且配置了激活识图模型 → 本轮使用识图模型连接（未填字段回退当前 Profile）
  const vision = resolveVisionModel(context)

  // BUG-08：占位消息写入前再次校验，避免追加到切换后的群聊 UI
  if (!isGroupContextCurrent(get, group, sessionId)) return

  const requestId = nanoid()
  const msgId = nanoid()

  const placeholder: GroupMessage = {
    id: msgId,
    groupId: group.id,
    characterId: '__free__',
    content: '',
    images: [],
    timestamp: Date.now(),
    round,
  }
  set((s: GroupChatState) => ({
    messages: [...s.messages, placeholder],
    isStreaming: true,
    currentStreamingCharId: '__free__',
    error: null,
  }))

  // 停止字符串（output 正则规则）：流式命中后截断 + 提前终止，省 token
  const stopStrings = collectStopStrings(regexRules)

  const unbindChunk = window.api.ai.onChunk((data: { requestId: string; text: string }) => {
    if (data.requestId !== requestId || !activeStream || activeStream.requestId !== requestId) return
    activeStream.accumulated += data.text
    // 停止字符串：命中后截断并提前终止
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
    if (activeStream.flushTimer === null) {
      activeStream.flushTimer = setTimeout(() => flushStream(set), STREAM_THROTTLE_MS)
    }
    // 空闲超时续期：收到 chunk 即重置 60s 计时（卡死时更快恢复）
    if (activeStream.timeoutHandle) clearTimeout(activeStream.timeoutHandle)
    activeStream.timeoutHandle = setTimeout(() => {
      const partialContent = activeStream?.accumulated ?? ''
      cleanupActiveStream()
      window.api.ai.cancelChat(requestId).catch((e) => logError('GroupChatStore:cancelChat', e))
      const clean = partialContent.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
      if (clean) {
        set((s: GroupChatState) => ({
          messages: s.messages.map((m: GroupMessage) =>
            m.id === msgId ? { ...m, content: clean + '\n\n⚠️ 请求超时' } : m,
          ),
          isStreaming: false, currentStreamingCharId: null, error: '请求超时',
        }))
        window.api.group.saveMessage(group.id, sessionId, {
          id: msgId, groupId: group.id, characterId: '__free__',
          content: clean + '\n\n⚠️ 请求超时', images: [], timestamp: Date.now(), round,
        }).catch((e) => logError('GroupChatStore:saveMessage', e))
      } else {
        set((s: GroupChatState) => ({
          messages: s.messages.filter((m: GroupMessage) => m.id !== msgId),
          isStreaming: false, currentStreamingCharId: null, error: '请求超时',
        }))
      }
    }, STREAM_IDLE_TIMEOUT_MS)
  })

  const unbindDone = window.api.ai.onDone((doneId: string) => {
    if (doneId !== requestId || !activeStream || activeStream.requestId !== requestId) return

    if (activeStream.flushTimer !== null) {
      clearTimeout(activeStream.flushTimer)
      activeStream.flushTimer = null
    }

    const finalContent = activeStream.accumulated
    cleanupActiveStream()

    const clean = finalContent.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
    // 应用正则规则 + 停止字符串截断
    const processed = regexRules.length > 0
      ? truncateAtStop(applyOutputRegexRules(clean, regexRules), collectStopStrings(regexRules)).text
      : clean
    splitAndSaveMessages(set, get, group, sessionId, processed, round, msgId)

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
  })

  const unbindError = window.api.ai.onError((data: { requestId: string; error: string }) => {
    if (data.requestId !== requestId) return
    clearPollingTimer()
    cleanupActiveStream()
    const friendlyMsg = friendlyError(data.error)
    const errContent = '⚠️ ' + friendlyMsg
    set((s: GroupChatState) => ({
      messages: s.messages.map((m: GroupMessage) => m.id === msgId ? { ...m, content: errContent } : m),
      isStreaming: false, currentStreamingCharId: null, error: data.error,
    }))
    // 持久化错误消息
    window.api.group.saveMessage(group.id, sessionId, {
      id: msgId, groupId: group.id, characterId: '__free__',
      content: errContent, images: [], timestamp: Date.now(), round,
    }).catch((e) => logError('GroupChatStore:saveMessage', e))
  })

  activeStream = {
    requestId, msgId, accumulated: '', flushTimer: null,
    unbindChunk, unbindDone, unbindError,
    timeoutHandle: setTimeout(() => {
      const partialContent = activeStream?.accumulated ?? ''
      cleanupActiveStream()
      window.api.ai.cancelChat(requestId).catch((e) => logError('GroupChatStore:cancelChat', e))
      const clean = partialContent.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
      if (clean) {
        set((s: GroupChatState) => ({
          messages: s.messages.map((m: GroupMessage) =>
            m.id === msgId ? { ...m, content: clean + '\n\n⚠️ 请求超时' } : m,
          ),
          isStreaming: false, currentStreamingCharId: null, error: '请求超时',
        }))
        window.api.group.saveMessage(group.id, sessionId, {
          id: msgId, groupId: group.id, characterId: '__free__',
          content: clean + '\n\n⚠️ 请求超时', images: [], timestamp: Date.now(), round,
        }).catch((e) => logError('GroupChatStore:saveMessage', e))
      } else {
        set((s: GroupChatState) => ({
          messages: s.messages.filter((m: GroupMessage) => m.id !== msgId),
          isStreaming: false, currentStreamingCharId: null, error: '请求超时',
        }))
      }
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
      maxTokens: preset?.maxTokens ?? 1024,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: true,
      instructTemplate,
    })
  } catch (err) {
    cleanupActiveStream()
    set({
      isStreaming: false, currentStreamingCharId: null,
      error: err instanceof Error ? err.message : '请求失败',
    })
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
) {
  const charStore = useCharacterStore.getState()
  const members = group.memberIds
    .map(id => charStore.characters.find(c => c.id === id))
    .filter(Boolean) as Character[]

  // 按 【角色名】 拆分
  const pattern = /【(.+?)】/g
  const segments: { name: string; content: string }[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    if (lastIdx > 0 || segments.length > 0) {
      const prev = segments[segments.length - 1]
      if (prev) {
        prev.content = content.slice(lastIdx, match.index).trim()
      }
    } else if (match.index > 0) {
      // 首个【】标记前有 preamble 文本，保存到首段内容中
      const preamble = content.slice(0, match.index).trim()
      if (preamble) {
        segments.push({ name: match[1], content: '' })
        segments[segments.length - 1].content = preamble
        lastIdx = match.index + match[0].length
        continue
      }
    }
    segments.push({ name: match[1], content: '' })
    lastIdx = match.index + match[0].length
  }

  // 最后一段
  if (segments.length > 0) {
    segments[segments.length - 1].content = content.slice(lastIdx).trim()
  }

  if (segments.length === 0) {
    // 没有匹配到任何角色标记 → 将占位消息改为第一个成员的消息，避免渲染为不可见
    const fallbackChar = members[0]
    const fallbackCharId = fallbackChar?.id || '__free__'
    set((s: GroupChatState) => ({
      messages: s.messages.map((m: GroupMessage) =>
        m.id === placeholderId
          ? { ...m, characterId: fallbackCharId, content: content || '(无回复)' }
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
    }
    newMessages.push(gm)
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
  // 统计自上次摘要以来的新消息数
  const lastUpdate = session.memoryUpdatedAt || 0
  const newMsgs = state.messages.filter((m) => m.timestamp > lastUpdate)
  if (newMsgs.length >= interval) {
    state.triggerMemorySummary()
  }
}

/** 检查 polling 模式下是否需要继续下一轮 */
export async function checkPollingContinue(set: GroupStoreSet, get: GroupStoreGet, _group: GroupChat) {
  const state = get()
  // 使用最新的 currentGroup，避免闭包中过期引用
  const group = state.currentGroup
  if (!group) return

  const pollingMsgs = state.messages.filter((m) => m.characterId !== '__user__' && m.characterId !== '__free__')
  const rounds = new Set(pollingMsgs.map((m) => m.round))
  if (rounds.size >= group.maxRounds) return

  // 找下一个发言者
  const lastCharMsg = [...state.messages].reverse().find((m) => m.characterId !== '__user__' && m.characterId !== '__free__')
  if (!lastCharMsg) return

  const currentIdx = group.memberIds.indexOf(lastCharMsg.characterId)
  if (currentIdx < 0) return
  const nextIdx = (currentIdx + 1) % group.memberIds.length
  const nextCharId = group.memberIds[nextIdx]

  // 更新 currentSpeakerIndex（纯运行时 UI 状态：成员栏高亮"当前说话者"）
  // 优化：不再每轮全量持久化群组文件（此前每 2s 一次整文件写入）；
  // 群组文件只在创建/编辑时保存，重启后该索引回落到上次持久化值，轮询下一轮自动纠正
  const updatedGroup = { ...group, currentSpeakerIndex: nextIdx }
  set({ currentGroup: updatedGroup })

  // H-02 修复：保存定时器 handle，以便切换/删除群聊时清理
  clearPollingTimer()
  pollingTimer = setTimeout(() => {
    const currentState = get()
    if (currentState.isStreaming) return
    // 定时器触发时再次检查群组是否仍为当前群组
    const curGroup = currentState.currentGroup
    if (!curGroup || curGroup.id !== group.id) return
    currentState.sendPollingRound(nextCharId)
  }, Math.max(500, group.speakerInterval || 2000))
}

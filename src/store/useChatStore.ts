import { cancelFeatureTasks } from './featureTasks'
import { create, type StateCreator } from 'zustand'
import type { Message, SessionPreview, Preset, Lorebook } from '../../shared/types'
import { nanoid } from 'nanoid'
import { useSettingsStore } from './useSettingsStore'
import { usePersonaStore } from './usePersonaStore'
import { useCharacterStore } from './useCharacterStore'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { replaceVariables } from '../../shared/chat-core/variables'
import { applyRegexRules, applyOutputRegexRules } from '../../shared/chat-core/regex'
import { getEffectiveLorebookIds } from '../../shared/chat-core/lorebook'
import { lorebookCache } from '../features/lorebook/lorebookCache'
import { logError } from '../lib/logger'
import { flushSpatialBoard } from '../lib/spatialFlush'
import {
  syncPersonaToSettings, applyDefaultMemory,
  invalidateDerivedMemory, nextLoadRequestId, currentLoadRequestId,
} from './chatUtils'
import { streamAIResponse, cleanupActiveStream, finalizeNoticeFields, claimUserStop, abortActiveTailRepair, maybeAutoTitle } from './streamController'
import { pushToast } from './useToastStore'

/** S5：V2 生成句柄（taskId + 订阅/轮询清理），stopStreaming 按 engine 分流 */
let activeV2Handle: {
  taskId: string
  unsub?: () => void
  clearPoll?: () => void
} | null = null

/**
 * UEX-P0-04：V2 停止后的占位落盘收口（防磁盘重复条目）。
 * V2 占位仅落屏、由 Orchestrator 幂等落盘；但「停止」与「任务恰好完成并提交」存在竞态
 * （轮询最长 1s 延迟内点停止），此时再 saveMessage 占位会与 Orchestrator 提交的消息重复。
 * - 已提交（终态快照带 assistantMessageId）→ 不再落盘占位，UI 占位并入已落盘 id（后续编辑不产生第二条）；
 * - 未提交（取消中断、Orchestrator 不落盘）→ 渲染层兜底保存已见正文，保证停止不丢内容。
 */
async function persistV2StoppedMessage(
  stopped: Message,
  taskId: string,
  canceling: Promise<{ assistantMessageId?: string } | null>,
): Promise<void> {
  let committedId: string | undefined
  try {
    const cancelSnap = await canceling
    committedId = cancelSnap?.assistantMessageId
    if (!committedId) {
      // 取消与提交的收口顺序不保证，再查一次任务快照兜底
      committedId = (await window.api.chatTask?.get?.(taskId))?.assistantMessageId ?? undefined
    }
  } catch { /* 查询失败不阻塞兜底落盘 */ }
  if (committedId) {
    const persistedId = committedId
    useChatStore.setState((s) => ({
      messages: s.messages.map((m) => (m.id === stopped.id ? { ...stopped, id: persistedId } : m)),
    }))
    return
  }
  await window.api.chat.saveMessage(stopped).catch(() => { /* ignore */ })
}

/**
 * UEX-P1-35：删除会话后选中邻近会话（下一项优先，其次上一项），不再跳回首项。
 * before = 删除前列表（定位被删会话位置），after = 删除后列表（校验候选仍存在）。
 */
function pickAdjacentSessionId(before: SessionPreview[], removedId: string, after: SessionPreview[]): string | null {
  const idx = before.findIndex((s) => s.id === removedId)
  // 被删会话不在旧列表（如已被其他操作删除）时无位置信息，回退首项
  if (idx < 0) return after[0]?.id ?? null
  for (const id of [before[idx + 1]?.id, before[idx - 1]?.id]) {
    if (id && after.some((s) => s.id === id)) return id
  }
  return after[0]?.id ?? null
}

/**
 * UEX-P1-35：删除前记录目标会话在旧列表的位置（或 sessionId）。
 * N13 竞态分支里被删会话已被其他操作删除、内存旧列表已无位置信息，
 * 靠这份删除前快照对新列表取邻近（下一项优先、否则上一项）；确实无法定位才回退首项。
 */
let preDeleteSessionAnchor: { id: string; before: SessionPreview[] } | null = null
import { translateSingleMessage } from './messageTranslation'
import { buildChatContext, buildChatContextReport } from './chatContext'
import { maybeRunAutoMemorySummary, runMemorySummary } from './memoryManager'
import { regenerateChatMessage, continueChatMessage, swipeChatMessage } from './chatGeneration'
import { sessionEventReporter } from './sessionEventReporter'
import type { ChatState } from '../features/chat/chatStoreTypes'
import { resolveNarrativeMode } from '../../shared/narrativeMode'
import { resolveDialogueDirectionsEnabled } from '../../shared/dialogueDirections'
import {
  generateSingleDialogueDirections,
  refreshSingleDialogueDirections,
  clearSessionDialogueDirections,
} from './dialogueDirectionRunner'
import { resolveMessageSpeakerKind } from '../../shared/messageIdentity'

export type { ChatState }

/**
 * UEX-P1-34：消息加载态（切会话/切角色「清空 → 异步加载」空窗期专用，仅本 store 与 ChatPage 消费）。
 * 以可选扩展字段挂在本 store，不改共享 ChatState 类型，避免跨端/跨模块扩散。
 */
export type ChatStoreState = ChatState & { messagesLoading?: boolean }

const createChatStoreState: StateCreator<ChatStoreState> = (set, get) => ({
  messages: [],
  sessions: [],
  currentSessionId: null,
  isStreaming: false,
  currentRequestId: null,
  error: null,
  messagesLoading: false,
  pendingImageGenerations: {},
  summarizingMemoryKey: null,
  memorySummaryError: null,
  activePresetId: null,
  activeLorebookIds: [],
  _semanticLoreHits: [],
  _semanticLoreAvailable: undefined,
  _semanticFactsHits: [],
  lastContextUsage: null,
  lastLorebookDiagnostics: null,
  lastLorebookDiagnosticsSessionId: null,
  translatingMessages: {},
  showTranslationIds: new Set(),
  editingMessageId: null,

  loadSessions: async (characterId) => {
    const personaStore = usePersonaStore.getState()
    if (!personaStore.loaded) await personaStore.loadPersonas()
    const sessions = await window.api.chat.listSessions(characterId)
    // 恢复上次打开的会话：直接从磁盘读取，避免与 loadSettings 竞态
    let savedSessionId = useSettingsStore.getState().settings.activeSessionId
    if (!savedSessionId) {
      const freshSettings = await window.api.settings.get()
      savedSessionId = freshSettings.activeSessionId ?? null
    }
    const savedSessionExists = savedSessionId && sessions.some(s => s.id === savedSessionId)
    const currentId = savedSessionExists ? savedSessionId : (sessions[0]?.id ?? null)
    set({ sessions, currentSessionId: currentId })
    // 持久化当前会话 ID，确保重启后能恢复上次的会话
    if (currentId && currentId !== savedSessionId) {
      useSettingsStore.getState().updateSettings({ activeSessionId: currentId })
    }
    // 当前会话身份是唯一来源；null 必须清空，undefined 才回退默认身份。
    if (currentId) syncPersonaToSettings(sessions.find(s => s.id === currentId)?.personaId)
  },

  createSession: async (characterId, title) => {
    const pending = flushSpatialBoard()
    if (pending) await pending
    const charStore = useCharacterStore.getState()
    const char = charStore.characters.find(c => c.id === characterId)
    const initLorebookIds = getEffectiveLorebookIds(char)
    const session = await window.api.chat.createSession(characterId, title, undefined, initLorebookIds)
    // 继承角色的默认长记忆配置
    await applyDefaultMemory(char, session.id)
    // 刷新会话列表
    const sessions = await window.api.chat.listSessions(characterId)
    set({ sessions, currentSessionId: session.id, messages: [], activeLorebookIds: initLorebookIds })
    // 持久化当前会话 ID
    useSettingsStore.getState().updateSettings({ activeSessionId: session.id })
    // 新会话已绑定默认身份（后端继承 defaultPersonaId），同步到 settings 使顶栏与消息发送立即生效
    syncPersonaToSettings(session.personaId)
    return session
  },

  /** 统一入口：创建新会话并可选地插入开场白（P-7：插入逻辑复用 insertGreetingMessage） */
  createSessionWithGreeting: async (character, greeting) => {
    const pending = flushSpatialBoard()
    if (pending) await pending
    const initLorebookIds = getEffectiveLorebookIds(character)
    const session = await window.api.chat.createSession(character.id, undefined, undefined, initLorebookIds)
    // 继承角色的默认长记忆配置
    await applyDefaultMemory(character, session.id)
    const sessions = await window.api.chat.listSessions(character.id)
    set({ sessions, currentSessionId: session.id, messages: [], activeLorebookIds: initLorebookIds })
    // 持久化当前会话 ID
    useSettingsStore.getState().updateSettings({ activeSessionId: session.id })
    // 新会话已绑定默认身份（后端继承 defaultPersonaId），同步到 settings 使顶栏与消息发送立即生效
    syncPersonaToSettings(session.personaId)

    const g = greeting ?? character.translatedContent?.firstMessage ?? character.firstMessage
    if (g) {
      await get().insertGreetingMessage(character, g)
    }
    return session
  },

  updateSessionField: async (characterId, sessionId, field, value) => {
    const previousMode = get().sessions.find((sess) => sess.id === sessionId)?.narrativeMode
    await window.api.chat.updateSession(characterId, sessionId, { [field]: value })
    set((s) => ({
      sessions: s.sessions.map(sess =>
        sess.id === sessionId ? { ...sess, [field]: value } as SessionPreview : sess
      ),
    }))
    // 叙事模式改变：方向是“下一步”的前瞻建议，需按新模式刷新（仅最新一条且已有方向时）
    if (field === 'narrativeMode'
      && resolveNarrativeMode(previousMode) !== resolveNarrativeMode(value)) {
      const character = useCharacterStore.getState().characters.find((item) => item.id === characterId)
      if (character) void refreshSingleDialogueDirections(set, get, { character })
    }
  },

  /** P-7 修复：本地 patch 会话元数据，避免高频全量 listSessions
   *  （listSessions 在主进程要逐会话扫描消息文件统计行数） */
  patchLocalSession: (sessionId, patch) => {
    set((s) => ({
      sessions: s.sessions.map(sess =>
        sess.id === sessionId ? { ...sess, ...patch } as SessionPreview : sess
      ),
    }))
  },

  /** P-7 修复：向当前会话插入开场白消息（变量替换 + 保存 + 本地元数据 patch） */
  insertGreetingMessage: async (character, greeting) => {
    const sid = get().currentSessionId
    if (!sid || !greeting) return
    const settings = useSettingsStore.getState().settings
    const processed = replaceVariables(greeting, settings.userName, character.name)
    const firstMsg: Message = {
      id: nanoid(),
      sessionId: sid,
      characterId: character.id,
      role: 'assistant',
      content: processed,
      images: [],
      isEditing: false,
      timestamp: Date.now(),
      narrativeMode: resolveNarrativeMode(get().sessions.find((session) => session.id === sid)?.narrativeMode),
      speakerKind: 'character',
      generationKind: 'assistant_reply',
      // 作者开场白可含完整 Markdown（列表/代码块等），显式走兼容路径
      contentRenderMode: 'markdown',
    }
    await window.api.chat.saveMessage(firstMsg)
    set((s) => ({ messages: [...s.messages, firstMsg] }))
    get().patchLocalSession(sid, {
      messageCount: get().messages.length,
      lastMessage: processed.slice(0, 50),
      updatedAt: Date.now(),
    })
  },

  /** P-7 修复：加载当前激活的 preset 与世界书（regenerate/continue/快捷回复共用，消除三处重复） */
  getActiveChatConfig: async () => {
    const { activePresetId, activeLorebookIds } = get()
    let preset: Preset | null = null
    if (activePresetId) {
      const presets = await window.api.preset.list()
      preset = presets.find(p => p.id === activePresetId) ?? null
    }
    let lorebooks: Lorebook[] = []
    if (activeLorebookIds.length > 0) {
      lorebooks = (await lorebookCache.refresh(activeLorebookIds)).filter(lb => lb.enabled)
    } else {
      lorebookCache.clear()
    }
    return { preset, lorebooks }
  },

  /** 从当前会话同步世界书选择，不触发持久化 */
  syncLorebooksFromCurrentSession: (character) => {
    const { sessions, currentSessionId } = get()
    const session = sessions.find(s => s.id === currentSessionId)
    // 会话有 lorebookIds 则用，否则回退到角色的 boundLorebookIds（向后兼容旧会话）
    const ids = session?.lorebookIds ?? getEffectiveLorebookIds(character)
    set({ activeLorebookIds: ids })
  },

  switchSession: async (sessionId, character) => {
    const pending = flushSpatialBoard()
    if (pending) { try { await pending } catch { return } }
    // 切换会话时取消正在进行的流式请求
    if (get().isStreaming) {
      get().stopStreaming()
    }
    set({ currentSessionId: sessionId, editingMessageId: null })
    // 持久化当前会话 ID
    useSettingsStore.getState().updateSettings({ activeSessionId: sessionId })
    // 重新加载消息
    const currentLoadId = nextLoadRequestId()
    // UEX-P1-34：清空与异步加载之间有空窗期——置加载态，页面渲染加载占位而不是「开始新的对话」假空态
    set({ messages: [], messagesLoading: true })
    let messages: Message[] = []
    try {
      messages = await window.api.chat.listMessages(character.id, sessionId)
    } catch (e) {
      // UEX-P1-34：加载失败也要退出加载态（回空态），避免骨架屏悬挂
      logError('ChatStore:switchSession', e)
    }
    if (currentLoadId !== currentLoadRequestId()) return
    set({ messages, messagesLoading: false })
    // 同步世界书：从会话恢复（或回退到角色绑定）
    get().syncLorebooksFromCurrentSession(character)
    // 同步 persona 到 settings（仅供界面与旧链路；上下文会再次按会话权威解析）
    const session = get().sessions.find(s => s.id === sessionId)
    syncPersonaToSettings(session?.personaId)
  },

  deleteCurrentSession: async (characterId) => {
    const pending = flushSpatialBoard()
    if (pending) { try { await pending } catch { return } }
    const { currentSessionId, sessions } = get()
    if (!currentSessionId) return
    // M-19 修复：删除当前会话前取消进行中的流式（对齐 deleteSession）——
    // 否则 onComplete 仍执行：AI 回复写入已删除会话（磁盘重建文件）、用量按新会话记账
    if (get().isStreaming) {
      get().stopStreaming()
    }
    // UEX-P1-35：删除前记录目标会话在旧列表的位置（或 sessionId），N13 竞态分支据此取邻近
    const removedIndex = sessions.findIndex(s => s.id === currentSessionId)
    if (removedIndex >= 0) preDeleteSessionAnchor = { id: currentSessionId, before: sessions }
    // N13 修复：会话不存在（已被其他操作删除）时跳过删除，仅刷新列表
    if (removedIndex < 0) {
      const newSessions = await window.api.chat.listSessions(characterId)
      // UEX-P1-35：被删会话已不在旧列表时，用删除前记录的位置（或 sessionId）对新列表取邻近
      //（下一项优先、否则上一项）；确实无法定位（无删除前记录）才回退首项
      const anchor = preDeleteSessionAnchor
      const before = anchor && anchor.id === currentSessionId ? anchor.before : sessions
      set({ sessions: newSessions, currentSessionId: pickAdjacentSessionId(before, currentSessionId, newSessions) })
      return
    }
    cancelFeatureTasks({ kind: 'single', characterId, sessionId: currentSessionId })
    await window.api.chat.deleteSession(characterId, currentSessionId)
    // 刷新
    const newSessions = await window.api.chat.listSessions(characterId)
    // UEX-P1-35：跳被删会话的邻近项（下一项优先，其次上一项），不再跳回首项
    const newSessionId = pickAdjacentSessionId(sessions, currentSessionId, newSessions)
    let newMessages: Message[] = []
    if (newSessionId) {
      newMessages = await window.api.chat.listMessages(characterId, newSessionId)
    }
    // 先 await 完成后再 set（修复 set 内部 await 反模式）
    set({ sessions: newSessions, currentSessionId: newSessionId, messages: newMessages })
    // 持久化新的当前会话 ID
    useSettingsStore.getState().updateSettings({ activeSessionId: newSessionId })
  },

  /** 删除指定会话（不再绕过 store） */
  deleteSession: async (characterId, sessionId) => {
    if (sessionId === get().currentSessionId) {
      const pending = flushSpatialBoard()
      if (pending) { try { await pending } catch { return } }
    }
    // UEX-P1-35：删除前记住列表位置，删除后跳邻近会话用
    const prevSessions = get().sessions
    // UEX-P1-35：删除前记录目标会话在旧列表的位置（或 sessionId），
    // 供 deleteCurrentSession N13 竞态分支（旧列表已无其位置）取邻近
    preDeleteSessionAnchor = { id: sessionId, before: prevSessions }
    // 取消进行中的流式
    if (get().isStreaming) {
      get().stopStreaming()
    }
    cancelFeatureTasks({ kind: 'single', characterId, sessionId })
    await window.api.chat.deleteSession(characterId, sessionId)
    const newSessions = await window.api.chat.listSessions(characterId)
    const { currentSessionId } = get()
    if (currentSessionId === sessionId) {
      // UEX-P1-35：跳被删会话的邻近项（下一项优先，其次上一项），不再跳回首项
      const newSid = pickAdjacentSessionId(prevSessions, sessionId, newSessions)
      let newMessages: Message[] = []
      if (newSid) {
        newMessages = await window.api.chat.listMessages(characterId, newSid)
      }
      set({ sessions: newSessions, currentSessionId: newSid, messages: newMessages })
      // 持久化新的当前会话 ID
      useSettingsStore.getState().updateSettings({ activeSessionId: newSid })
    } else {
      set({ sessions: newSessions })
    }
  },

  renameSession: async (characterId, sessionId, title) => {
    await window.api.chat.renameSession(characterId, sessionId, title)
    // P-7：本地 patch，不再全量 listSessions
    get().patchLocalSession(sessionId, { title, updatedAt: Date.now() })
  },

  toggleMemory: async (characterId, sessionId, enabled) => {
    await window.api.chat.toggleMemory(characterId, sessionId, enabled)
    // P-7：本地 patch，不再全量 listSessions
    get().patchLocalSession(sessionId, { memoryEnabled: enabled, updatedAt: Date.now() })
  },

  setMemoryMode: async (characterId, sessionId, mode, interval) => {
    await window.api.chat.setMemoryMode(characterId, sessionId, mode, interval)
    // P-7：本地 patch，不再全量 listSessions
    get().patchLocalSession(sessionId, {
      memoryMode: mode,
      ...(interval !== undefined ? { autoMemoryInterval: interval } : {}),
      updatedAt: Date.now(),
    })
  },

  updateMemoryFacts: async (characterId, sessionId, facts) => {
    const session = get().sessions.find((item) => item.id === sessionId)
    const patch = {
      memoryFacts: facts,
      memoryUpdatedAt: Date.now(),
      memoryVersion: (session?.memoryVersion ?? 0) + 1,
      factsVectors: [],
      factsVectorVersion: -1,
    }
    const commit = await window.api.chat.updateSessionIfMemoryVersion(characterId, sessionId, session?.memoryVersion ?? 0, patch)
    if (!commit.applied) {
      const sessions = await window.api.chat.listSessions(characterId)
      set({ sessions })
      throw new Error('长记忆已发生变化，请重新编辑后再保存。')
    }
    get().patchLocalSession(sessionId, { ...patch, updatedAt: Date.now() })
    set({ _semanticFactsHits: [] })
  },

  triggerMemorySummary: async (character) => {
    return runMemorySummary(get, set, character)
  },

  getStats: async (characterId, sessionId) => {
    return window.api.chat.getStats(characterId, sessionId)
  },

  loadMessages: async (character) => {
    // 竞态条件防护
    const currentLoadId = nextLoadRequestId()
    // 角色/会话切换：清空语义命中缓存，避免残留旧命中
    // UEX-P1-34：清空-加载空窗期置加载态，避免闪现「开始新的对话」假空态
    set({ messages: [], editingMessageId: null, _semanticLoreHits: [], _semanticLoreAvailable: undefined, messagesLoading: true }) // 先清空，避免显示旧角色消息

    try {
      // 先加载会话列表
      let sessionId = get().currentSessionId
      if (!sessionId) {
        const sessions = await window.api.chat.listSessions(character.id)
        // 恢复上次打开的会话：直接从磁盘读取
        let savedSessionId = useSettingsStore.getState().settings.activeSessionId
        if (!savedSessionId) {
          const freshSettings = await window.api.settings.get()
          savedSessionId = freshSettings.activeSessionId ?? null
        }
        const savedSessionExists = savedSessionId && sessions.some(s => s.id === savedSessionId)
        sessionId = savedSessionExists ? savedSessionId : (sessions[0]?.id ?? null)
        set({ sessions, currentSessionId: sessionId })
        // 持久化当前会话 ID，确保重启后能恢复
        if (sessionId && sessionId !== savedSessionId) {
          useSettingsStore.getState().updateSettings({ activeSessionId: sessionId })
        }
      }

      if (!sessionId) {
        set({ messages: [] })
        return
      }

      // 同步世界书：从当前会话恢复（或回退到角色绑定）
      get().syncLorebooksFromCurrentSession(character)

      const messages = await window.api.chat.listMessages(character.id, sessionId)

      // 如果期间又发起了新的加载请求，放弃本次结果
      if (currentLoadId !== currentLoadRequestId()) return

      if (messages.length === 0 && character.firstMessage) {
        // 有备选开场白时，交给 ChatPage 的选择面板处理，不自动插入
        const hasAltGreetings = character.alternateGreetings && character.alternateGreetings.length > 0
        if (hasAltGreetings) {
          set({ messages: [] })
        } else {
          // 没有备选开场白 -> 变量替换后自动插入并保存（优先译文，原文未覆盖时用原文）
          const settings = useSettingsStore.getState().settings
          const processedFirstMsg = replaceVariables(character.translatedContent?.firstMessage ?? character.firstMessage, settings.userName, character.name)
          const firstMsg: Message = {
            id: nanoid(),
            sessionId: sessionId,
            characterId: character.id,
            role: 'assistant',
            content: processedFirstMsg,
            images: [],
            isEditing: false,
            timestamp: Date.now(),
            narrativeMode: resolveNarrativeMode(get().sessions.find((session) => session.id === sessionId)?.narrativeMode),
            speakerKind: 'character',
            generationKind: 'assistant_reply',
            // 作者开场白可含完整 Markdown，显式走兼容路径
            contentRenderMode: 'markdown',
          }
          await window.api.chat.saveMessage(firstMsg)
          // N25 修复：若加载期间用户已发送消息（messages 非空），不覆盖用户消息
          set((state) => ({ messages: state.messages.length === 0 ? [firstMsg] : state.messages }))
        }
      } else {
        set({ messages })
      }
    } finally {
      // UEX-P1-34：完成/失败都退出加载态；陈旧请求不碰（由最新一次加载接管）
      if (currentLoadId === currentLoadRequestId()) set({ messagesLoading: false })
    }
  },

  clearMessages: () => {
    set({ messages: [], editingMessageId: null })
  },

  addStandaloneMessage: async (content, images, character, role = 'assistant', sessionId) => {
    const targetSid = sessionId ?? get().currentSessionId
    if (!targetSid) return

    // 用户以独立消息形式发言（如不触发 AI 的快捷回复）：上一轮方向同样作废
    if (role === 'user' && get().currentSessionId === targetSid) {
      void clearSessionDialogueDirections(set, get, targetSid)
    }

    const narrativeMode = resolveNarrativeMode(get().sessions.find((session) => session.id === targetSid)?.narrativeMode)
    const msg: Message = {
      id: nanoid(),
      sessionId: targetSid,
      characterId: character.id,
      role,
      content,
      images,
      isEditing: false,
      timestamp: Date.now(),
      ...(role !== 'system' ? { narrativeMode } : {}),
      speakerKind: resolveMessageSpeakerKind({ role, characterId: character.id, narrativeMode }),
      generationKind: role === 'assistant' ? 'assistant_reply' : 'manual',
    }
    // 后台生图期间用户可能切换角色或会话：消息始终落盘到发起会话，
    // 只有目标仍在当前视图时才追加到可见消息数组。
    const visibleCharacterId = useCharacterStore.getState().currentCharacter?.id
    if (get().currentSessionId === targetSid && (!visibleCharacterId || visibleCharacterId === character.id)) {
      set((state) => ({ messages: [...state.messages, msg] }))
    }
    await window.api.chat.saveMessage(msg)
  },

  beginImageGeneration: (characterId, sessionId, stage) => {
    const state = get()
    const duplicate = Object.values(state.pendingImageGenerations).some(
      (job) => job.characterId === characterId && job.sessionId === sessionId,
    )
    if (duplicate) return null
    const job = { id: nanoid(), characterId, sessionId, stage, startedAt: Date.now() }
    set((current) => ({
      pendingImageGenerations: { ...current.pendingImageGenerations, [job.id]: job },
    }))
    return job
  },

  updateImageGeneration: (id, stage) => {
    set((state) => {
      const current = state.pendingImageGenerations[id]
      if (!current) return state
      return {
        pendingImageGenerations: {
          ...state.pendingImageGenerations,
          [id]: { ...current, stage },
        },
      }
    })
  },

  finishImageGeneration: (id) => {
    set((state) => {
      if (!state.pendingImageGenerations[id]) return state
      const next = { ...state.pendingImageGenerations }
      delete next[id]
      return { pendingImageGenerations: next }
    })
  },

  sendMessage: async (content, images, character, preset, _lorebooks, replyToId, generationKind = 'manual') => {
    const spatialSid = get().currentSessionId
    let spatialRead: import('../../shared/spatial').SpatialContext | null | undefined
    if (spatialSid) {
      try {
        await flushSpatialBoard()
        const spatial = await window.api.spatial.readContext(character.id, spatialSid)
        spatialRead = spatial
        if (get().currentSessionId !== spatialSid) throw new Error('会话已切换，消息未发送')
        if (spatial?.characterOffstage && resolveNarrativeMode(get().sessions.find(session => session.id === spatialSid)?.narrativeMode) === 'immersive') throw new Error('当前角色位于“不参与对话”区域，请先调整位置或关闭对话读取位置')
        if (spatial) {
          const { syncBuildData } = await import('../context/rendererContextProvider')
          const { buildContextMessagesFromData } = await import('../../shared/chat-core/contextBuilder')
          const data = syncBuildData(character, preset)
          data.spatialContext = spatial
          data.chat = { ...data.chat, messages: [...data.chat.messages, { id: 'spatial-send-preflight', sessionId: spatialSid, characterId: character.id, role: 'user', content, images, isEditing: false, timestamp: Date.now() }] }
          buildContextMessagesFromData(data, { lorebookDiagnosticsMode: 'preview' })
          if (get().currentSessionId !== spatialSid) throw new Error('会话已切换，消息未发送')
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        set({ error: message })
        pushToast({ variant: 'error', title: '消息未发送', description: message, requestId: 'chat-error' })
        return false
      }
    }
    // V12-11: flag 隔离，新链路走 Orchestrator（带流式占位）
    try {
      const { useChatTaskStore } = await import('./chatTaskStore')
      if (useChatTaskStore.getState().chatEngineV2 && (window as unknown as { api?: { chatTask?: unknown } }).api?.chatTask) {
        const curSid = get().currentSessionId
        if (curSid) {
          // 用户已发送：上一轮的方向作废，与用户消息同帧移除
          void clearSessionDialogueDirections(set, get, curSid)
          const narrativeMode = resolveNarrativeMode(get().sessions.find((session) => session.id === curSid)?.narrativeMode)
          // 乐观消息仅落屏，不落盘（由 Orchestrator 按 requestId 幂等落盘，避免双写）
          const userMsgId = nanoid()
          const userMsg = { id: userMsgId, sessionId: curSid, characterId: character.id, role: 'user' as const, content, images: images ?? [], isEditing: false, timestamp: Date.now(), replyToId: replyToId ?? undefined, narrativeMode, speakerKind: resolveMessageSpeakerKind({ role: 'user', narrativeMode }), generationKind }
          set((s) => ({ messages: [...s.messages, userMsg] }))
          // 创建 AI 占位（流式期间也走语义分块样式）
          const aiMsgId = nanoid()
          const aiPlaceholder = { id: aiMsgId, sessionId: curSid, characterId: character.id, role: 'assistant' as const, content: '', images: [], isEditing: false, timestamp: Date.now(), narrativeMode, speakerKind: 'character' as const, generationKind: 'assistant_reply' as const, contentRenderMode: 'blocks' as const }
          set((s) => ({ messages: [...s.messages, aiPlaceholder], isStreaming: true }))
          // 提交任务并订阅流式事件
          const { submitChatTask, subscribeTaskEvents } = await import('./chatTaskStore')
          const task = await submitChatTask(curSid, content, character.id, generationKind)
          // 关联占位与任务，便于后续更新
          const unsub = subscribeTaskEvents(task.taskId, (delta) => {
            set((s) => {
              const idx = s.messages.findIndex((m) => m.id === aiMsgId)
              if (idx < 0) return {}
              const next = s.messages.slice()
              next[idx] = { ...next[idx], content: (next[idx].content ?? '') + delta }
              return { messages: next }
            })
          })
          // 轮询终态（简化：1s 后拉一次，实际靠 chatTask:event 推送）
          let pollTimer: ReturnType<typeof setInterval> | null = null
          activeV2Handle = {
            taskId: task.taskId,
            unsub,
            clearPoll: () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } },
          }
          pollTimer = setInterval(async () => {
            if (!activeV2Handle || activeV2Handle.taskId !== task.taskId) return
            try {
              const snap = await (window as unknown as { api: { chatTask: { get: (id: string) => Promise<import('../../shared/chat-core/events').TaskSnapshot> } } }).api.chatTask.get(task.taskId)
              if (snap.state === 'completed' || snap.state === 'failed' || snap.state === 'cancelled' || snap.state === 'interrupted') {
                clearInterval(pollTimer!)
                unsub()
                activeV2Handle = null
                set({
                  isStreaming: false,
                  ...(snap.state === 'failed' || snap.state === 'interrupted'
                    ? { error: snap.error?.message || '生成失败，请重试' }
                    : {}),
                })
                // 终态后重载消息文件（S6：仅仍停留在该会话才写 UI，避免切会话串台）
                const msgs = await window.api.chat.listMessages(character.id, curSid)
                // UEX-P0-05：S6 会话守卫 + 角色/视图一致性双守卫（对齐 addStandaloneMessage 的 visibleCharacterId 模式）：
                // 磁盘由 Orchestrator 幂等落盘，这里只决定是否写 UI——会话或角色已切走则只落盘不写 UI
                const visibleCharacterId = useCharacterStore.getState().currentCharacter?.id
                const stillInView = get().currentSessionId === curSid
                  && (!visibleCharacterId || visibleCharacterId === character.id)
                if (stillInView) {
                  set({ messages: msgs as unknown as typeof get extends () => infer T ? T extends { messages: infer M } ? M : never : never })
                }
                // V2 链路自动长记忆：对齐旧链路 sendMessage 完成后的挂接；仅在生成成功时检查
                // 间隔阈值，消息已按落盘内容重载，游标统计基于持久化 id。
                if (snap.state === 'completed' && stillInView) {
                  // 新版主聊天完成后与旧链路一致触发自动标题；
                  // 标题请求只追加当前预设的 jailbreak，不注入预设其他正文。
                  void maybeAutoTitle(get, set, character, preset)
                  // “下一步方向”：落盘后按持久化 id 取最后一条有效 AI 回复生成，失败静默降级。
                  const session = get().sessions.find((item) => item.id === curSid)
                  if (resolveDialogueDirectionsEnabled(session)) {
                    const lastReply = [...get().messages].reverse().find(
                      (message) => message.role === 'assistant' && !!message.content?.trim(),
                    )
                    if (lastReply) {
                      void generateSingleDialogueDirections(set, get, { messageId: lastReply.id, character })
                    }
                  }
                  maybeRunAutoMemorySummary(get, set, character).catch((e) => logError('ChatStore:memorySummary', e))
                }
              }
            } catch { /* ignore */ }
          }, 1000)
          return true
        }
      }
    } catch { /* fallback to legacy path */ }
    // 流式中拒绝：现在给一个错误提示而不是静默忽略
    if (get().isStreaming) {
      set({ error: '正在生成回复中，请稍候或点击停止' })
      pushToast({ variant: 'warning', title: '正在生成回复中，请稍候或点击停止', requestId: 'chat-error' })
      return false
    }

    const settingsStore = useSettingsStore.getState()
    const profile = settingsStore.getActiveProfile()

    if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
      set({ error: '请先在设置中配置 API 连接' })
      pushToast({ variant: 'error', title: '请先在设置中配置 API 连接', description: '打开「模型 → 对话 API」完成配置', requestId: 'chat-error' })
      return false
    }

    // 确保 currentSessionId 有效（不再用 'default' 兜底）
    let currentSid = get().currentSessionId
    if (!currentSid) {
      // 自动创建一个会话
      const session = await window.api.chat.createSession(character.id)
      const sessions = await window.api.chat.listSessions(character.id)
      set({ sessions, currentSessionId: session.id })
      currentSid = session.id
    }

    // 用户已发送：上一轮的方向作废，与用户消息同帧移除
    void clearSessionDialogueDirections(set, get, currentSid)

    // 加载正则规则并对输入应用
    let processedContent = content
    try {
      const regexRules = await window.api.regex.list()
      if (regexRules.length > 0) {
        processedContent = get().applyRegex(content, 'input', regexRules)
      }
    } catch { /* 忽略正则加载失败 */ }

    // BUG-08 单聊版修复：await 期间用户可能已切换会话，
    // 中止发送避免用户消息被追加到错误会话的 UI（磁盘仍按捕获的 currentSid 保存）
    if (get().currentSessionId !== currentSid) {
      set({ error: '会话已切换，消息未发送' })
      pushToast({ variant: 'warning', title: '会话已切换，消息未发送', requestId: 'chat-error' })
      return false
    }

    // 添加用户消息
    const userMessage: Message = {
      id: nanoid(),
      sessionId: currentSid,
      characterId: character.id,
      role: 'user',
      content: processedContent,
      images,
      isEditing: false,
      timestamp: Date.now(),
      replyToId: replyToId ?? undefined,
      narrativeMode: resolveNarrativeMode(get().sessions.find((session) => session.id === currentSid)?.narrativeMode),
      speakerKind: resolveMessageSpeakerKind({
        role: 'user',
        narrativeMode: resolveNarrativeMode(get().sessions.find((session) => session.id === currentSid)?.narrativeMode),
      }),
      generationKind,
    }
    set((state) => ({ messages: [...state.messages, userMessage], error: null }))
    await window.api.chat.saveMessage(userMessage)

    // 保存期间可能又切换了会话：从当前 UI 移除占位消息并中止 AI 回复
    // （消息已保存到发起时会话，切回后可见，不丢数据）
    if (get().currentSessionId !== currentSid) {
      set((state) => ({ messages: state.messages.filter((m) => m.id !== userMessage.id) }))
      set({ error: '会话已切换，未触发 AI 回复' })
      pushToast({ variant: 'warning', title: '会话已切换，未触发 AI 回复', requestId: 'chat-error' })
      return true // 用户消息已入列，仅 AI 未触发
    }

    // 构建 AI 消息占位（创建时即标记语义分块：流式期间与完成后样式一致）
    const aiMessageId = nanoid()
    const aiMessage: Message = {
      id: aiMessageId,
      sessionId: currentSid, // 修复：使用 currentSid 而非 character.id
      characterId: character.id,
      role: 'assistant',
      content: '',
      images: [],
      isEditing: false,
      timestamp: Date.now(),
      narrativeMode: resolveNarrativeMode(get().sessions.find((session) => session.id === currentSid)?.narrativeMode),
      speakerKind: 'character',
      generationKind: 'assistant_reply',
      contentRenderMode: 'blocks',
    }
    set((state) => ({
      messages: [...state.messages, aiMessage],
      isStreaming: true,
    }))

    // 调用公共流式方法
    await streamAIResponse(set, get, {
      aiMessageId,
      character,
      preset,
      inputText: processedContent,
      ...(spatialSid === currentSid ? { spatialContext: spatialRead } : {}),
      onComplete: async (fullContent, meta) => {
        // M-18 修复：空回复/手动中止——移除占位消息，避免 UI 残留空气泡且不落盘
        if (!fullContent) {
          set((state) => ({ messages: state.messages.filter((m) => m.id !== aiMessageId) }))
          return
        }

        // S1：output 正则与停止字符串已由统一收尾管线执行（每条消息仅一次），
        // 此处不再重复应用。
        const finalContent = fullContent
        // 更新 UI 中的消息内容
        const currentMsg = get().messages.find(m => m.id === aiMessageId) ?? aiMessage
        const finalMsg: Message = {
          ...currentMsg,
          content: finalContent,
          // 阶段3：收尾状态——"已恢复"走中性提示（generationNotice），失败走 generationError
          ...finalizeNoticeFields(meta),
          spatialGenerationId: meta.spatialGenerationId,
          contentRenderMode: 'blocks' as const,
        }
        set((s) => ({
          messages: s.messages.map((m) => (m.id === aiMessageId ? finalMsg : m)),
        }))
        await window.api.chat.saveMessage(finalMsg)

        // “下一步方向”：主回复落盘后异步生成，失败静默降级，不影响正文。
        const session = get().sessions.find((item) => item.id === finalMsg.sessionId)
        if (resolveDialogueDirectionsEnabled(session)) {
          void generateSingleDialogueDirections(set, get, { messageId: aiMessageId, character })
        }

        // 自动长记忆：成功提交后才推进消息游标；失败会保留重试机会。
        maybeRunAutoMemorySummary(get, set, character).catch((e) => logError('ChatStore:memorySummary', e))
      },
      onError: (errMsg, terminal) => {
        // 阶段7：错误文案绝不写进正文（旧「⚠️ 错误」落盘行为移除）。
        // terminal.content = 经过统一收尾管线的稳定正文（方案 §4.1 矩阵）；
        // 无可用正文时不保存 AI 消息，只保留 store.error 与重试入口。
        const state = get()
        const aiMsg = state.messages.find((m) => m.id === aiMessageId)
        if (!aiMsg) return
        const updatedMsg: Message | null = terminal?.content
          ? {
              ...aiMsg,
              content: terminal.content,
              // 提示字段由统一协调入口生成（generationError 与正文分离）
              ...(terminal.noticeFields.generationError ? { generationError: terminal.noticeFields.generationError } : {}),
              ...(terminal.noticeFields.generationNotice ? { generationNotice: terminal.noticeFields.generationNotice } : {}),
              contentRenderMode: 'blocks' as const,
            }
          : null
        if (!updatedMsg) {
          set((s) => ({ messages: s.messages.filter((m) => m.id !== aiMessageId) }))
          return
        }
        window.api.chat.saveMessage(updatedMsg).catch((e) => logError('ChatStore:saveMessage', e))
        set((s) => ({
          messages: s.messages.map((m) => (m.id === aiMessageId ? updatedMsg : m)),
        }))
      },
    })
    return true
  },

  stopStreaming: () => {
    // S5：V2 任务取消（chatTask.cancel + 清理 poll/unsub，禁止再走 ai.cancelChat）
    if (activeV2Handle) {
      const handle = activeV2Handle
      activeV2Handle = null
      try { handle.unsub?.() } catch { /* ignore */ }
      try { handle.clearPoll?.() } catch { /* ignore */ }
      const canceling = window.api.chatTask?.cancel?.(handle.taskId).catch(() => null) ?? Promise.resolve(null)
      set({ isStreaming: false, currentRequestId: null })
      // 保留已见正文 + 中性提示
      const msgs = get().messages
      const lastAi = [...msgs].reverse().find((m) => m.role === 'assistant')
      if (lastAi && lastAi.content) {
        const stopped: Message = {
          ...lastAi,
          generationNotice: '已停止生成',
          contentRenderMode: 'blocks' as const,
        }
        set((s) => ({ messages: s.messages.map((m) => (m.id === lastAi.id ? stopped : m)) }))
        // UEX-P0-04：V2 占位按「仅落屏、由 Orchestrator 幂等落盘」设计，停止与任务完成存在竞态，
        // 直接 saveMessage 可能与 Orchestrator 已提交的消息在磁盘重复——落盘交给幂等收口判定
        void persistV2StoppedMessage(stopped, handle.taskId, canceling)
      }
      return
    }
    // 阶段7：用户手动停止经终止状态机抢占（claimUserStop），
    // 同一 requestId 的迟到 chunk/done/error 全部被忽略，不会二次落盘。
    const stoppedStream = claimUserStop()
    if (stoppedStream) {
      window.api.ai.cancelChat(stoppedStream.requestId, 'user').catch(() => { /* ignore */ })
      // 保留用户已经看到的正文并标记中性提示（矩阵 §4.1；accumulated 比节流后的 UI 更完整）
      const msg = get().messages.find((m) => m.id === stoppedStream.aiMessageId)
      const content = stoppedStream.content.trim() || (msg?.content ?? '')
      if (msg && content) {
        const stopped: Message = {
          ...msg,
          content,
          generationNotice: '已停止生成',
          contentRenderMode: 'blocks' as const,
        }
        set((s) => ({ messages: s.messages.map((m) => (m.id === stoppedStream.aiMessageId ? stopped : m)) }))
        window.api.chat.saveMessage(stopped).catch(() => { /* ignore */ })
      }
    } else {
      // 收尾管线补尾期间停止：立即取消补尾并保留稳定前缀（§8.1）
      if (!abortActiveTailRepair()) {
        const requestId = get().currentRequestId
        if (requestId) window.api.ai.cancelChat(requestId, 'user').catch(() => { /* ignore */ })
      }
    }
    // 兜底重置状态（防止 cancelChat IPC 失败导致卡住）
    cleanupActiveStream()
    if (get().isStreaming) {
      set({ isStreaming: false, currentRequestId: null })
    }
  },

    regenerateMessage: (messageId, character, preset, _lorebooks) =>
      regenerateChatMessage(set, get, messageId, character, preset, _lorebooks),

  /** 继续续写：让 AI 从截断处继续生成，创建新消息气泡 */
    continueMessage: (messageId, character, preset, _lorebooks) =>
      continueChatMessage(set, get, messageId, character, preset, _lorebooks),

  /** 切换当前消息的候选回复 */
    swipeMessage: (messageId, direction, _character) =>
      swipeChatMessage(set, get, messageId, direction, _character),

  updateMessageImages: async (messageId, images) => {
    const state = get()
    const msg = state.messages.find((m) => m.id === messageId)
    if (!msg) return
    const updatedMsg = { ...msg, images }
    set((s) => ({
      messages: s.messages.map((m) => (m.id === messageId ? updatedMsg : m)),
    }))
    await window.api.chat.saveMessage(updatedMsg)
  },

  editMessage: async (messageId, newContent, character) => {
    const state = get()
    const msg = state.messages.find((m) => m.id === messageId)
    if (!msg) return
    const sid = msg.sessionId || state.currentSessionId

    // Start invalidation now so it captures the editing session, but do not let its
    // IPC round-trip block the visible edit or the message save.
    const invalidation = invalidateDerivedMemory(get, character, messageId)

    // 正文被编辑：旧方向不再对应当前内容，立即失效并取消在途请求
    const featureMessage = get().messages.find(m => m.id === messageId)
    if (featureMessage) cancelFeatureTasks({ kind: 'single', characterId: featureMessage.characterId, sessionId: featureMessage.sessionId }, [messageId])
    const updatedMsg: typeof msg = { ...msg, content: newContent, translation: null, translationLanguage: undefined, translationSource: undefined }
    delete (updatedMsg as Message).dialogueDirections
    delete (updatedMsg as Message).dialogueDirectionsGeneratedAt
    // 先更新本地状态
    set((s) => ({
      messages: s.messages.map((m) => (m.id === messageId ? updatedMsg : m)),
      translatingMessages: Object.fromEntries(Object.entries(s.translatingMessages).filter(([id]) => id !== messageId)),
      showTranslationIds: new Set([...s.showTranslationIds].filter(id => id !== messageId)),
    }))
    // 再保存到文件（updateMessage 会更新而非追加）
    await window.api.chat.saveMessage(updatedMsg)
    // P-7：本地 patch 会话元数据（不再全量 listSessions）
    if (sid) {
      const msgs = get().messages
      const isLast = msgs.length > 0 && msgs[msgs.length - 1].id === messageId
      get().patchLocalSession(sid, {
        messageCount: msgs.length,
        ...(isLast ? { lastMessage: newContent.slice(0, 50) } : {}),
        updatedAt: Date.now(),
      })
    }
    const invalidated = await invalidation
    if (invalidated) get().patchLocalSession(invalidated.sessionId, invalidated.patch)
  },

  deleteMessage: async (messageId, character) => {
    // NEW-1 修复：await 前捕获 sessionId——invalidateCompression 执行期间
    // 用户可能已切换会话，避免删除操作作用于错误会话
    const sessionId = get().currentSessionId ?? undefined
    // 消息被删除：取消该消息在途的方向请求
    const featureMessage = get().messages.find(m => m.id === messageId)
    if (featureMessage) cancelFeatureTasks({ kind: 'single', characterId: featureMessage.characterId, sessionId: featureMessage.sessionId }, [messageId])
    // 阶段五检查点：仅当删除发生在游标前才失效
    const invalidated = await invalidateDerivedMemory(get, character, messageId)
    if (invalidated) get().patchLocalSession(invalidated.sessionId, invalidated.patch)
    await window.api.chat.deleteMessage(messageId, character.id, sessionId)
    set((state) => ({ messages: state.messages.filter((m) => m.id !== messageId) }))
    // P-7：本地 patch 会话元数据（不再全量 listSessions）
    const sid = get().currentSessionId
    if (sid) {
      const msgs = get().messages
      get().patchLocalSession(sid, {
        messageCount: msgs.length,
        lastMessage: msgs.length > 0 ? msgs[msgs.length - 1].content.slice(0, 50) : '',
        updatedAt: Date.now(),
      })
    }
  },

  clearChat: async (characterId) => {
    const sessionId = get().currentSessionId
    if (sessionId) cancelFeatureTasks({ kind: 'single', characterId, sessionId })
    await window.api.chat.clearChat(characterId, sessionId ?? undefined)
    set({ messages: [] })
    // P-7：本地 patch 会话元数据（不再全量 listSessions）
    if (sessionId) {
      get().patchLocalSession(sessionId, {
        messageCount: 0,
        lastMessage: '',
        memory: '',
        memoryFacts: [],
        memoryFactHistory: [],
        memoryFactParseFailureCount: 0,
        memoryFactRetryAfterVersion: 0,
        factsVectors: [],
        memoryUpdatedAt: 0,
        memoryLastMessageId: null,
        memoryVersion: 0,
        factsVectorVersion: 0,
        compressedSummary: null,
        compressedRange: null,
        updatedAt: Date.now(),
      })
    }
  },

  /** 启动 AI 翻译 - 全局状态管理，页面切换不中断 */
  translateMessage: (messageId, content) => translateSingleMessage(set, get, messageId, content),

  /** 切换翻译显示/隐藏 */
  toggleTranslation: (messageId) => {
    const { showTranslationIds } = get()
    const next = new Set(showTranslationIds)
    if (next.has(messageId)) {
      next.delete(messageId)
    } else {
      next.add(messageId)
    }
    set({ showTranslationIds: next })
  },

  setActivePreset: (id, characterId) => {
    set({ activePresetId: id })
    // B-05 修复：保存预设绑定到角色
    if (characterId) {
      const charStore = useCharacterStore.getState()
      const char = charStore.characters.find(c => c.id === characterId)
      if (char && char.boundPresetId !== id) {
        charStore.saveCharacter({ ...char, boundPresetId: id }).catch((e) => logError('ChatStore:saveCharacter', e))
      }
    }
  },
  setActiveLorebooks: (ids, characterId) => {
    set({ activeLorebookIds: ids })
    if (characterId) {
      // 仅持久化到当前会话（不同会话可拥有不同的世界书选择）
      const { currentSessionId } = get()
      if (currentSessionId) {
        get().updateSessionField(characterId, currentSessionId, 'lorebookIds', ids)
      }
      // 注意：不再自动回写角色绑定，角色默认绑定通过 saveLorebookBinding 或角色编辑器保存
    }
  },

  saveLorebookBinding: async (characterId, ids) => {
    const charStore = useCharacterStore.getState()
    const char = charStore.characters.find(c => c.id === characterId)
    if (char) {
      await charStore.saveCharacter({ ...char, boundLorebookIds: ids })
    }
  },

  applyRegex: (text, scope, rules) => {
    if (!text || rules.length === 0) return text
    // 增量共享：output 两阶段(text+markdown)收敛到 applyOutputRegexRules
    if (scope === 'output') {
      return applyOutputRegexRules(text, rules)
    }
    // input 仅 text 阶段
    return applyRegexRules(text, rules, 'input', 'text').text
  },

  buildContext: (character, preset, opts) => {
    return buildChatContext(get, set, character, preset, opts)
  },
  buildContextReport: (character, preset, opts) => {
    return buildChatContextReport(character, preset, opts)
  },
})

// UEX-P1-34：messagesLoading 仅在本 store 扩展（sessionEventReporter 仍按 ChatState 签名包装，此处收窄断言）
export const useChatStore = create<ChatStoreState>()(
  sessionEventReporter(createChatStoreState as unknown as StateCreator<ChatState>) as unknown as StateCreator<ChatStoreState>,
)

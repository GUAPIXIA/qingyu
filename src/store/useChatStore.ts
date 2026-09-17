import { create } from 'zustand'
import type { Message, SessionPreview, Preset, Lorebook } from '../../shared/types'
import { nanoid } from 'nanoid'
import { useSettingsStore } from './useSettingsStore'
import { usePersonaStore } from './usePersonaStore'
import { useCharacterStore } from './useCharacterStore'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { replaceVariables } from '../utils/variables'
import { applyRegexRules, applyOutputRegexRules } from '../utils/regex'
import { getEffectiveLorebookIds, lorebookCache } from '../utils/lorebook'
import { logError } from '../lib/logger'
import { resolveRendererGenerationTaskBudget } from './generationTaskBudget'
import {
  friendlyError, syncPersonaToSettings, applyDefaultMemory,
  invalidateDerivedMemory, nextLoadRequestId, currentLoadRequestId,
} from './chatUtils'
import { streamAIResponse, cleanupActiveStream, finalizeNoticeFields, claimUserStop, abortActiveTailRepair } from './streamController'
import { createChunkAccumulator } from './chunkAccumulator'
import { buildChatContext, buildChatContextReport } from './chatContext'
import { maybeRunAutoMemorySummary, runMemorySummary } from './memoryManager'
import { regenerateChatMessage, continueChatMessage, swipeChatMessage } from './chatGeneration'
import { sessionEventReporter } from './sessionEventReporter'
import type { ChatState } from './chatTypes'
import { resolveNarrativeMode } from '../../shared/narrativeMode'
import { resolveDialogueDirectionsEnabled } from '../../shared/dialogueDirections'
import { stripAllThinking } from '../../shared/thoughtMarkup'
import { buildMessageTranslationSystemPrompt } from '../../shared/translationPrompt'
import {
  generateSingleDialogueDirections,
  cancelDialogueDirectionRequests,
  refreshSingleDialogueDirections,
  clearSessionDialogueDirections,
} from './dialogueDirectionRunner'
import { resolveMessageSpeakerKind } from '../../shared/messageIdentity'

export type { ChatState }
export const useChatStore = create<ChatState>()(sessionEventReporter((set, get) => ({
  messages: [],
  sessions: [],
  currentSessionId: null,
  isStreaming: false,
  currentRequestId: null,
  error: null,
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
    // 同步 persona 到 settings
    if (currentId) {
      const session = sessions.find(s => s.id === currentId)
      const personaId = session?.personaId
      const persona = personaId ? usePersonaStore.getState().getPersona(personaId) : undefined
      const settingsStore = useSettingsStore.getState()
      if (persona) {
        settingsStore.updateSettings({
          activePersonaId: persona.id,
          userName: persona.name,
          userDescription: persona.description,
          userPersona: persona.persona,
        })
      }
    }
  },

  createSession: async (characterId, title) => {
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
    // 切换会话时取消正在进行的流式请求
    if (get().isStreaming) {
      get().stopStreaming()
    }
    // 会话切换：取消尚未完成的方向请求，避免结果写入其他会话的消息
    cancelDialogueDirectionRequests()
    set({ currentSessionId: sessionId, editingMessageId: null })
    // 持久化当前会话 ID
    useSettingsStore.getState().updateSettings({ activeSessionId: sessionId })
    // 重新加载消息
    const currentLoadId = nextLoadRequestId()
    set({ messages: [] })
    const messages = await window.api.chat.listMessages(character.id, sessionId)
    if (currentLoadId !== currentLoadRequestId()) return
    set({ messages })
    // 同步世界书：从会话恢复（或回退到角色绑定）
    get().syncLorebooksFromCurrentSession(character)
    // 同步 persona 到 settings
    const session = get().sessions.find(s => s.id === sessionId)
    const personaId = session?.personaId
    const persona = personaId ? usePersonaStore.getState().getPersona(personaId) : undefined
    const settingsStore = useSettingsStore.getState()
    if (persona) {
      settingsStore.updateSettings({
        activePersonaId: persona.id,
        userName: persona.name,
        userDescription: persona.description,
        userPersona: persona.persona,
      })
    } else {
      // 恢复默认 persona
      const defaultPersonaId = settingsStore.settings.defaultPersonaId
      const defaultPersona = defaultPersonaId ? usePersonaStore.getState().getPersona(defaultPersonaId) : undefined
      if (defaultPersona) {
        settingsStore.updateSettings({
          activePersonaId: defaultPersona.id,
          userName: defaultPersona.name,
          userDescription: defaultPersona.description,
          userPersona: defaultPersona.persona,
        })
      } else {
        settingsStore.updateSettings({
          activePersonaId: null,
          userName: '用户',
          userDescription: '',
          userPersona: '',
        })
      }
    }
  },

  deleteCurrentSession: async (characterId) => {
    const { currentSessionId, sessions } = get()
    if (!currentSessionId) return
    // M-19 修复：删除当前会话前取消进行中的流式（对齐 deleteSession）——
    // 否则 onComplete 仍执行：AI 回复写入已删除会话（磁盘重建文件）、用量按新会话记账
    if (get().isStreaming) {
      get().stopStreaming()
    }
    // N13 修复：会话不存在（已被其他操作删除）时跳过删除，仅刷新列表
    if (!sessions.some(s => s.id === currentSessionId)) {
      const newSessions = await window.api.chat.listSessions(characterId)
      set({ sessions: newSessions, currentSessionId: newSessions[0]?.id ?? null })
      return
    }
    await window.api.chat.deleteSession(characterId, currentSessionId)
    // 刷新
    const newSessions = await window.api.chat.listSessions(characterId)
    const newSessionId = newSessions[0]?.id ?? null
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
    // 取消进行中的流式
    if (get().isStreaming) {
      get().stopStreaming()
    }
    await window.api.chat.deleteSession(characterId, sessionId)
    const newSessions = await window.api.chat.listSessions(characterId)
    const { currentSessionId } = get()
    if (currentSessionId === sessionId) {
      const newSid = newSessions[0]?.id ?? null
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
    set({ messages: [], editingMessageId: null, _semanticLoreHits: [], _semanticLoreAvailable: undefined }) // 先清空，避免显示旧角色消息

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
          const poll = setInterval(async () => {
            try {
              const snap = await (window as unknown as { api: { chatTask: { get: (id: string) => Promise<import('../../shared/chat-core/events').TaskSnapshot> } } }).api.chatTask.get(task.taskId)
              if (snap.state === 'completed' || snap.state === 'failed' || snap.state === 'cancelled') {
                clearInterval(poll)
                unsub()
                set({ isStreaming: false })
                // 终态后重载消息文件，确保与落盘一致
                const msgs = await window.api.chat.listMessages(character.id, curSid)
                set({ messages: msgs as unknown as typeof get extends () => infer T ? T extends { messages: infer M } ? M : never : never })
                // V2 链路自动长记忆：对齐旧链路 sendMessage 完成后的挂接；仅在生成成功时检查
                // 间隔阈值，消息已按落盘内容重载，游标统计基于持久化 id。
                if (snap.state === 'completed' && get().currentSessionId === curSid) {
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
          setTimeout(() => { clearInterval(poll); unsub() }, 120000)
          return
        }
      }
    } catch { /* fallback to legacy path */ }
    // 流式中拒绝：现在给一个错误提示而不是静默忽略
    if (get().isStreaming) {
      set({ error: '正在生成回复中，请稍候或点击停止' })
      return
    }

    const settingsStore = useSettingsStore.getState()
    const profile = settingsStore.getActiveProfile()

    if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
      set({ error: '请先在设置中配置 API 连接' })
      return
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
      return
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
      return
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
          contentRenderMode: 'blocks' as const,
        }
        set((s) => ({
          messages: s.messages.map((m) => (m.id === aiMessageId ? finalMsg : m)),
        }))
        window.api.chat.saveMessage(finalMsg).catch((e) => logError('ChatStore:saveMessage', e))

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
  },

  stopStreaming: () => {
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
    cancelDialogueDirectionRequests([messageId])
    const updatedMsg: typeof msg = { ...msg, content: newContent }
    delete (updatedMsg as Message).dialogueDirections
    delete (updatedMsg as Message).dialogueDirectionsGeneratedAt
    // 先更新本地状态
    set((s) => ({
      messages: s.messages.map((m) => (m.id === messageId ? updatedMsg : m)),
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
    cancelDialogueDirectionRequests([messageId])
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
  translateMessage: async (messageId, content) => {
    if (!content) return

    const existing = get().translatingMessages[messageId]
    // 如果已有翻译结果，切换回原文
    if (existing && existing.status === 'done') {
      get().toggleTranslation(messageId)
      return
    }
    // 如果正在翻译中，不重复发起
    if (existing?.status === 'translating') return

    // 初始化翻译状态
    set((state) => ({
      translatingMessages: { ...state.translatingMessages, [messageId]: { status: 'translating' as const, content: '' } },
    }))

    const requestId = `translate-${messageId}-${Date.now()}`
    // P-8 修复：chunk 累积器统一管理节流 flush + 空闲超时（30s 无 chunk 即中止），
    // 替代此前手写的 timer 三件套
    const acc = createChunkAccumulator({
      onFlush: (accText) => {
        set((state) => ({
          translatingMessages: { ...state.translatingMessages, [messageId]: { status: 'translating' as const, content: accText } },
        }))
      },
      onIdleTimeout: () => {
        unbindChunk(); unbindDone(); unbindError()
        window.api.ai.cancelChat(requestId, 'timeout').catch(() => {})
        set((state) => ({
          translatingMessages: { ...state.translatingMessages, [messageId]: { status: 'error' as const, content: '', errorMsg: '翻译超时（30 秒无响应）' } },
        }))
      },
    })

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      acc.append(data.text)
    })

    const unbindDone = window.api.ai.onComplete((payload) => {
      if (payload.requestId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()

      // 先准备好 updated 对象（不在 set 回调中执行副作用）
      const finalResult = stripAllThinking(acc.flushNow())
      // R4 修复：模型返回空结果（如推理模型思考内容耗尽 maxTokens 导致正文为空）时，
      // 不落库空译文、不自动切显示，改为错误提示，避免 UI 静默回退原文且下次仍重复翻译
      if (!finalResult) {
        set((state) => ({
          translatingMessages: { ...state.translatingMessages, [messageId]: { status: 'error' as const, content: '', errorMsg: '翻译结果为空，请重试或更换模型' } },
        }))
        return
      }
      set((state) => {
        const updated = { ...state.translatingMessages, [messageId]: { status: 'done' as const, content: finalResult } }
        const msgs = state.messages.map(m => m.id === messageId ? { ...m, translation: finalResult } : m)
        // 翻译完成后自动显示译文：不依赖发起时的一次性 toggle（可能被重复点击抵消）
        const nextShow = new Set(state.showTranslationIds)
        nextShow.add(messageId)
        return { translatingMessages: updated, messages: msgs, showTranslationIds: nextShow }
      })
      // 在 set 之外执行 IPC 副作用（修复反模式）
      const msg = get().messages.find(m => m.id === messageId)
      if (msg) {
        window.api.chat.saveMessage(msg).catch((err) => {
          logError('ChatStore:translate', err)
        })
      }
    })

    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      acc.dispose()
      unbindChunk(); unbindDone(); unbindError()
      set((state) => ({
        translatingMessages: { ...state.translatingMessages, [messageId]: { status: 'error' as const, content: '', errorMsg: friendlyError(data.error) } },
      }))
    })

    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile) {
      acc.dispose()
      unbindChunk(); unbindDone(); unbindError()
      set((state) => ({
        translatingMessages: { ...state.translatingMessages, [messageId]: { status: 'error' as const, content: '', errorMsg: '未配置 API 连接' } },
      }))
      return
    }
    const settings = useSettingsStore.getState().settings
    const targetLang = settings.translationTargetLang || '中文'
    const model = settings.activeModel || profile.model
    const translationPlan = await resolveRendererGenerationTaskBudget({
      profile,
      model,
      task: 'translation',
      inputChars: content.length,
      usageTaskType: 'translation',
    })
    window.api.ai.chat({
      requestId,
      messages: [
        { role: 'system', content: buildMessageTranslationSystemPrompt(targetLang) },
        { role: 'user', content },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: translationPlan.requestMaxTokens,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
      observability: { source: 'aux', taskType: 'translation' },
      adaptiveOutputBudget: translationPlan.adaptiveOutputBudget,
      // 翻译只需要最终文本。关闭推理可避免模型把输出额度耗在 reasoning 中，
      // reasoning 被界面剥离后留下“翻译结果为空”。
      reasoningGate: translationPlan.reasoningGate,
    }).catch(() => {
      acc.dispose()
      unbindChunk(); unbindDone(); unbindError()
      set((state) => ({
        translatingMessages: { ...state.translatingMessages, [messageId]: { status: 'error' as const, content: '', errorMsg: '翻译请求失败' } },
      }))
    })
  },

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
})))

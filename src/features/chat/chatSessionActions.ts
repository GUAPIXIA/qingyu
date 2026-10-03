/**
 * 单聊会话动作实现（结构阶段 4B）。
 *
 * 覆盖：会话列表/生命周期、记忆开关与摘要、世界书激活、消息加载与清空、会话级元数据 patch。
 * 页面消费仍走 `src/store/useChatStore.ts` 的稳定状态入口（该文件组合注入本模块），
 * 动作签名见 `chatStoreTypes.ts` 的 `ChatState`。
 */
import { nanoid } from 'nanoid'
import type { Lorebook, Message, Preset, SessionPreview } from '../../../shared/types'
import { replaceVariables } from '../../../shared/chat-core/variables'
import { getEffectiveLorebookIds } from '../../../shared/chat-core/lorebook'
import { resolveNarrativeMode } from '../../../shared/narrativeMode'
import { useCharacterStore } from '../../store/useCharacterStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { cancelFeatureTasks } from '../../store/featureTasks'
import {
  applyDefaultMemory, currentLoadRequestId, nextLoadRequestId, syncPersonaToSettings,
} from '../../store/chatUtils'
import { refreshSingleDialogueDirections } from '../../store/dialogueDirectionRunner'
import { runMemorySummary } from '../../store/memoryManager'
import { logError } from '../../lib/logger'
import { flushSpatialBoard } from '../../lib/spatialFlush'
import { lorebookCache } from '../lorebook/lorebookCache'
import type { ChatStoreGet, ChatStoreSet, ChatStoreState } from './chatStoreTypes'

export type ChatSessionActions = Pick<ChatStoreState,
  | 'loadSessions' | 'createSession' | 'createSessionWithGreeting' | 'updateSessionField'
  | 'patchLocalSession' | 'insertGreetingMessage' | 'getActiveChatConfig'
  | 'syncLorebooksFromCurrentSession' | 'switchSession' | 'deleteCurrentSession' | 'deleteSession'
  | 'renameSession' | 'toggleMemory' | 'setMemoryMode' | 'updateMemoryFacts'
  | 'triggerMemorySummary' | 'getStats' | 'loadMessages' | 'clearMessages' | 'clearChat'
  | 'setActivePreset' | 'setActiveLorebooks' | 'saveLorebookBinding'>

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

export function createChatSessionActions(set: ChatStoreSet, get: ChatStoreGet): ChatSessionActions {
  return {
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
  }
}
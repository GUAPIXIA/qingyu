import { create } from 'zustand'
import type { Message, SessionPreview } from '../../shared/types'
import { nanoid } from 'nanoid'
import { useSettingsStore } from './useSettingsStore'
import { usePersonaStore } from './usePersonaStore'
import { useCharacterStore } from './useCharacterStore'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { replaceVariables } from '../utils/variables'
import { stripThought, normalizeThoughtTags, trimContinuationOverlap } from '../utils/messagePostProcess'
import { applyRegexRules, truncateAtStop, collectStopStrings } from '../utils/regex'
import { getEffectiveLorebookIds } from '../utils/lorebook'
import { logError } from '../lib/logger'
import {
  friendlyError, syncPersonaToSettings, applyDefaultMemory,
  invalidateCompression, nextLoadRequestId, currentLoadRequestId,
} from './chatUtils'
import { streamAIResponse, cleanupActiveStream } from './streamController'
import { buildChatContext } from './chatContext'
import { runMemorySummary } from './memoryManager'
import { regenerateChatMessage, continueChatMessage, swipeChatMessage } from './chatGeneration'
import type { ChatState } from './chatTypes'

export type { ChatState }
export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  sessions: [],
  currentSessionId: null,
  isStreaming: false,
  currentRequestId: null,
  streamingContent: '',
  error: null,
  activePresetId: null,
  activeLorebookIds: [],
  _semanticLoreHits: [],
  _semanticFactsHits: [],
  lastContextUsage: null,
  translatingMessages: {},
  showTranslationIds: new Set(),

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

  /** 统一入口：创建新会话并可选地插入开场白 */
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
      const settings = useSettingsStore.getState().settings
      const processed = replaceVariables(g, settings.userName, character.name)
      const firstMsg: Message = {
        id: nanoid(),
        sessionId: session.id,
        characterId: character.id,
        role: 'assistant',
        content: processed,
        images: [],
        isEditing: false,
        timestamp: Date.now(),
      }
      await window.api.chat.saveMessage(firstMsg)
      set(() => ({ messages: [firstMsg] }))
    }
    return session
  },

  updateSessionField: async (characterId, sessionId, field, value) => {
    await window.api.chat.updateSession(characterId, sessionId, { [field]: value })
    set((s) => ({
      sessions: s.sessions.map(sess =>
        sess.id === sessionId ? { ...sess, [field]: value } as SessionPreview : sess
      ),
    }))
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
    set({ currentSessionId: sessionId })
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
    const sessions = await window.api.chat.listSessions(characterId)
    set({ sessions })
  },

  toggleMemory: async (characterId, sessionId, enabled) => {
    await window.api.chat.toggleMemory(characterId, sessionId, enabled)
    const sessions = await window.api.chat.listSessions(characterId)
    set({ sessions })
  },

  setMemoryMode: async (characterId, sessionId, mode, interval) => {
    await window.api.chat.setMemoryMode(characterId, sessionId, mode, interval)
    const sessions = await window.api.chat.listSessions(characterId)
    set({ sessions })
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
    set({ messages: [], _semanticLoreHits: [] }) // 先清空，避免显示旧角色消息

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
    set({ messages: [] })
  },

  addStandaloneMessage: async (content, images, character, role = 'assistant') => {
    const currentSid = get().currentSessionId
    if (!currentSid) return

    const msg: Message = {
      id: nanoid(),
      sessionId: currentSid,
      characterId: character.id,
      role,
      content,
      images,
      isEditing: false,
      timestamp: Date.now(),
    }
    set((state) => ({ messages: [...state.messages, msg] }))
    await window.api.chat.saveMessage(msg)
  },

  sendMessage: async (content, images, character, preset, _lorebooks, replyToId) => {
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

    // 构建 AI 消息占位
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
    }
    set((state) => ({
      messages: [...state.messages, aiMessage],
      isStreaming: true,
      streamingContent: '',
    }))

    // 调用公共流式方法
    await streamAIResponse(set, get, {
      aiMessageId,
      character,
      preset,
      inputText: processedContent,
      onComplete: async (fullContent) => {
        if (!fullContent) return

        // 对 AI 输出应用正则规则
        let finalContent = fullContent
        try {
          const regexRules = await window.api.regex.list()
          if (regexRules.length > 0) {
            finalContent = get().applyRegex(fullContent, 'output', regexRules)
            // 停止字符串：output 命中后终止生成并截断
            finalContent = truncateAtStop(finalContent, collectStopStrings(regexRules)).text
          }
        } catch { /* 忽略 */ }

        // 更新 UI 中的消息内容
        const currentMsg = get().messages.find(m => m.id === aiMessageId) ?? aiMessage
        const finalMsg: Message = {
          ...currentMsg,
          content: finalContent,
        }
        set((s) => ({
          messages: s.messages.map((m) => (m.id === aiMessageId ? finalMsg : m)),
        }))
        window.api.chat.saveMessage(finalMsg).catch((e) => logError('ChatStore:saveMessage', e))

        // 自动长记忆检查：基于上次总结后的新消息数判断
        const { sessions: curSessions, currentSessionId: curSid } = get()
        const curSession = curSessions.find(s => s.id === curSid)
        if (curSession?.memoryEnabled && curSession.memoryMode === 'auto') {
          const allMsgs = get().messages.filter(m => m.content)
          // 统计上次总结后的新消息数
          const lastSummaryTime = curSession.memoryUpdatedAt || 0
          const newMsgCount = lastSummaryTime > 0
            ? allMsgs.filter(m => m.timestamp > lastSummaryTime).length
            : allMsgs.length
          const interval = curSession.autoMemoryInterval || 10
          if (newMsgCount >= interval) {
            get().triggerMemorySummary(character).catch((e) => logError('ChatStore:memorySummary', e))
          }
        }

        // AI 自动生图：解析 [image: prompt] 标记
        const autoImgEnabled = useSettingsStore.getState().settings.imageGenAutoEnabled
        if (autoImgEnabled) {
          const imageRegex = /\[image:\s*([^\]]+)\]/gi
          const imagePrompts: string[] = []
          let imgMatch
          while ((imgMatch = imageRegex.exec(finalContent)) !== null) {
            imagePrompts.push(imgMatch[1].trim())
          }
          if (imagePrompts.length > 0) {
            const generatedImages: string[] = []
            for (const p of imagePrompts) {
              try {
                const result = await window.api.imageGen.generate(p)
                if (result.success && result.images) {
                  generatedImages.push(...result.images)
                }
              } catch { /* 忽略单张失败 */ }
            }
            if (generatedImages.length > 0) {
              set((s) => ({
                messages: s.messages.map((m) =>
                  m.id === aiMessageId
                    ? { ...m, images: [...m.images, ...generatedImages] }
                    : m
                ),
              }))
              const updatedMsg = get().messages.find((m) => m.id === aiMessageId)
              if (updatedMsg) await window.api.chat.saveMessage(updatedMsg)
            }
          }
        }
      },
      onError: (errMsg) => {
        // 错误时把错误信息写入占位消息（如果内容为空）
        const state = get()
        const aiMsg = state.messages.find((m) => m.id === aiMessageId)
        if (aiMsg && !aiMsg.content) {
          const updatedMsg: Message = { ...aiMsg, content: `⚠️ ${errMsg}` }
          window.api.chat.saveMessage(updatedMsg).catch((e) => logError('ChatStore:saveMessage', e))
          set((s) => ({
            messages: s.messages.map((m) => (m.id === aiMessageId ? updatedMsg : m)),
          }))
        }
      },
    })
  },

  stopStreaming: () => {
    const requestId = get().currentRequestId
    if (requestId) {
      window.api.ai.cancelChat(requestId).catch(() => { /* ignore */ })
    }
    // 兜底重置状态（防止 cancelChat IPC 失败导致卡住）
    cleanupActiveStream()
    if (get().isStreaming) {
      set({ isStreaming: false, currentRequestId: null, streamingContent: '' })
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
    // 编辑历史后上下文压缩缓存失效
    await invalidateCompression(get, character)
    const state = get()
    const msg = state.messages.find((m) => m.id === messageId)
    if (!msg) return

    const updatedMsg = { ...msg, content: newContent }
    // 先更新本地状态
    set((s) => ({
      messages: s.messages.map((m) => (m.id === messageId ? updatedMsg : m)),
    }))
    // 再保存到文件（updateMessage 会更新而非追加）
    await window.api.chat.saveMessage(updatedMsg)
    // 更新 session 元数据（updatedAt / lastMessage / messageCount）
    // 通过 listSessions 重新拉取，让后端做增量更新
    try {
      const sessions = await window.api.chat.listSessions(character.id)
      set({ sessions })
    } catch { /* ignore */ }
  },

  deleteMessage: async (messageId, character) => {
    // NEW-1 修复：await 前捕获 sessionId——invalidateCompression 执行期间
    // 用户可能已切换会话，避免删除操作作用于错误会话
    const sessionId = get().currentSessionId ?? undefined
    // 删除历史后上下文压缩缓存失效
    await invalidateCompression(get, character)
    await window.api.chat.deleteMessage(messageId, character.id, sessionId)
    set((state) => ({ messages: state.messages.filter((m) => m.id !== messageId) }))
    // 同步更新 session 元数据
    try {
      const sessions = await window.api.chat.listSessions(character.id)
      set({ sessions })
    } catch { /* ignore */ }
  },

  clearChat: async (characterId) => {
    const sessionId = get().currentSessionId
    // 清空历史后上下文压缩缓存失效
    if (sessionId) {
      const cur = get().sessions.find((s) => s.id === sessionId)
      if (cur?.compressedSummary) {
        await window.api.chat.updateSession(characterId, sessionId, {
          compressedSummary: null,
          compressedRange: null,
        }).catch(() => { /* 忽略 */ })
      }
    }
    await window.api.chat.clearChat(characterId, sessionId ?? undefined)
    set({ messages: [] })
    // 同步 session 元数据
    try {
      const sessions = await window.api.chat.listSessions(characterId)
      set({ sessions })
    } catch { /* ignore */ }
  },

  /** 启动 AI 翻译 - 全局状态管理，页面切换不中断 */
  translateMessage: (messageId, content) => {
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
    let result = ''
    // P-4 修复：翻译 onChunk 节流，50ms flush 一次，避免高频 re-render
    let translateFlushTimer: ReturnType<typeof setTimeout> | null = null
    // R3 修复：空闲超时（30s 无 chunk 即中止），流中断后翻译不再永不结束
    let translateIdleTimer: ReturnType<typeof setTimeout> | null = null
    const TRANSLATE_IDLE_TIMEOUT_MS = 30000
    const clearTranslateTimers = () => {
      if (translateFlushTimer) { clearTimeout(translateFlushTimer); translateFlushTimer = null }
      if (translateIdleTimer) { clearTimeout(translateIdleTimer); translateIdleTimer = null }
    }

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
      // R3：每次收到 chunk 重置空闲计时
      if (translateIdleTimer) { clearTimeout(translateIdleTimer) }
      translateIdleTimer = setTimeout(() => {
        translateIdleTimer = null
        clearTranslateTimers()
        unbindChunk(); unbindDone(); unbindError()
        window.api.ai.cancelChat(requestId).catch(() => {})
        set((state) => ({
          translatingMessages: { ...state.translatingMessages, [messageId]: { status: 'error' as const, content: '', errorMsg: '翻译超时（30 秒无响应）' } },
        }))
      }, TRANSLATE_IDLE_TIMEOUT_MS)
      if (translateFlushTimer === null) {
        translateFlushTimer = setTimeout(() => {
          translateFlushTimer = null
          set((state) => ({
            translatingMessages: { ...state.translatingMessages, [messageId]: { status: 'translating' as const, content: result } },
          }))
        }, 50)
      }
    })

    const unbindDone = window.api.ai.onDone((doneId) => {
      if (doneId !== requestId) return
      clearTranslateTimers()
      unbindChunk(); unbindDone(); unbindError()

      // 先准备好 updated 对象（不在 set 回调中执行副作用）
      const finalResult = result.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
      set((state) => {
        const updated = { ...state.translatingMessages, [messageId]: { status: 'done' as const, content: finalResult } }
        const msgs = state.messages.map(m => m.id === messageId ? { ...m, translation: finalResult } : m)
        return { translatingMessages: updated, messages: msgs }
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
      clearTranslateTimers()
      unbindChunk(); unbindDone(); unbindError()
      set((state) => ({
        translatingMessages: { ...state.translatingMessages, [messageId]: { status: 'error' as const, content: '', errorMsg: friendlyError(data.error) } },
      }))
    })

    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile) {
      clearTranslateTimers()
      unbindChunk(); unbindDone(); unbindError()
      set((state) => ({
        translatingMessages: { ...state.translatingMessages, [messageId]: { status: 'error' as const, content: '', errorMsg: '未配置 API 连接' } },
      }))
      return
    }
    const settings = useSettingsStore.getState().settings
    const targetLang = settings.translationTargetLang || '中文'
    window.api.ai.chat({
      requestId,
      messages: [
        { role: 'system', content: `你是一个翻译助手。请将以下文本翻译成${targetLang}。只输出翻译结果，不要添加任何解释或额外内容。保留原文中的 Markdown 格式、HTML 标签和特殊符号不变。` },
        { role: 'user', content },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: settings.activeModel || profile.model,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 2048,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
    }).catch(() => {
      clearTranslateTimers()
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
    // input 仅 text 阶段；output 先 text 后 markdown（渲染前文本）链式应用
    let result = applyRegexRules(text, rules, scope, 'text').text
    if (scope === 'output') {
      result = applyRegexRules(result, rules, 'output', 'markdown').text
    }
    return result
  },

  buildContext: (character, preset, opts) => {
    return buildChatContext(get, set, character, preset, opts)
  },
}))

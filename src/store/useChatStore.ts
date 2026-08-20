import { create } from 'zustand'
import type { Message, SessionPreview, Preset, Lorebook } from '../../shared/types'
import { nanoid } from 'nanoid'
import { useSettingsStore } from './useSettingsStore'
import { usePersonaStore } from './usePersonaStore'
import { useCharacterStore } from './useCharacterStore'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { replaceVariables } from '../utils/variables'
import { applyRegexRules, applyOutputRegexRules, truncateAtStop, collectStopStrings } from '../utils/regex'
import { getEffectiveLorebookIds, lorebookCache } from '../utils/lorebook'
import { logError } from '../lib/logger'
import { translationMaxTokens } from './chatConstants'
import {
  friendlyError, syncPersonaToSettings, applyDefaultMemory,
  invalidateDerivedMemory, nextLoadRequestId, currentLoadRequestId,
} from './chatUtils'
import { streamAIResponse, cleanupActiveStream } from './streamController'
import { createChunkAccumulator } from './chunkAccumulator'
import { buildChatContext } from './chatContext'
import { maybeRunAutoMemorySummary, runMemorySummary } from './memoryManager'
import { regenerateChatMessage, continueChatMessage, swipeChatMessage } from './chatGeneration'
import { sessionEventReporter } from './sessionEventReporter'
import type { ChatState } from './chatTypes'

export type { ChatState }
export const useChatStore = create<ChatState>()(sessionEventReporter((set, get) => ({
  messages: [],
  sessions: [],
  currentSessionId: null,
  isStreaming: false,
  currentRequestId: null,
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
    await window.api.chat.updateSession(characterId, sessionId, { [field]: value })
    set((s) => ({
      sessions: s.sessions.map(sess =>
        sess.id === sessionId ? { ...sess, [field]: value } as SessionPreview : sess
      ),
    }))
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
    // V12-11: flag 隔离，新链路走 Orchestrator（带流式占位）
    try {
      const { useChatTaskStore } = await import('./chatTaskStore')
      if (useChatTaskStore.getState().chatEngineV2 && (window as unknown as { api?: { chatTask?: unknown } }).api?.chatTask) {
        const curSid = get().currentSessionId
        if (curSid) {
          // 乐观消息仅落屏，不落盘（由 Orchestrator 按 requestId 幂等落盘，避免双写）
          const userMsgId = nanoid()
          const userMsg = { id: userMsgId, sessionId: curSid, characterId: character.id, role: 'user' as const, content, images: images ?? [], isEditing: false, timestamp: Date.now(), replyToId: replyToId ?? undefined }
          set((s) => ({ messages: [...s.messages, userMsg] }))
          // 创建 AI 占位
          const aiMsgId = nanoid()
          const aiPlaceholder = { id: aiMsgId, sessionId: curSid, characterId: character.id, role: 'assistant' as const, content: '', images: [], isEditing: false, timestamp: Date.now() }
          set((s) => ({ messages: [...s.messages, aiPlaceholder], isStreaming: true }))
          // 提交任务并订阅流式事件
          const { submitChatTask, subscribeTaskEvents } = await import('./chatTaskStore')
          const task = await submitChatTask(curSid, content, character.id)
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
    }))

    // 调用公共流式方法
    await streamAIResponse(set, get, {
      aiMessageId,
      character,
      preset,
      inputText: processedContent,
      onComplete: async (fullContent) => {
        // M-18 修复：空回复/手动中止——移除占位消息，避免 UI 残留空气泡且不落盘
        if (!fullContent) {
          set((state) => ({ messages: state.messages.filter((m) => m.id !== aiMessageId) }))
          return
        }

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

        // 自动长记忆：成功提交后才推进消息游标；失败会保留重试机会。
        maybeRunAutoMemorySummary(get, set, character).catch((e) => logError('ChatStore:memorySummary', e))

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
    // 阶段五检查点：仅当编辑发生在游标前才失效
    const invalidated = await invalidateDerivedMemory(get, character, messageId)
    if (invalidated) get().patchLocalSession(invalidated.sessionId, invalidated.patch)
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
    // P-7：本地 patch 会话元数据（不再全量 listSessions）
    const sid = get().currentSessionId
    if (sid) {
      const msgs = get().messages
      const isLast = msgs.length > 0 && msgs[msgs.length - 1].id === messageId
      get().patchLocalSession(sid, {
        messageCount: msgs.length,
        ...(isLast ? { lastMessage: newContent.slice(0, 50) } : {}),
        updatedAt: Date.now(),
      })
    }
  },

  deleteMessage: async (messageId, character) => {
    // NEW-1 修复：await 前捕获 sessionId——invalidateCompression 执行期间
    // 用户可能已切换会话，避免删除操作作用于错误会话
    const sessionId = get().currentSessionId ?? undefined
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
        window.api.ai.cancelChat(requestId).catch(() => {})
        set((state) => ({
          translatingMessages: { ...state.translatingMessages, [messageId]: { status: 'error' as const, content: '', errorMsg: '翻译超时（30 秒无响应）' } },
        }))
      },
    })

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      acc.append(data.text)
    })

    const unbindDone = window.api.ai.onDone((doneId) => {
      if (doneId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()

      // 先准备好 updated 对象（不在 set 回调中执行副作用）
      const finalResult = acc.flushNow().replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
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
      maxTokens: translationMaxTokens(content),
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
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
})))

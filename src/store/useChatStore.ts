import { create } from 'zustand'
import type { Message, Character, Preset, Lorebook, ChatParams, RegexRule, SessionPreview, ChatSession } from '../../shared/types'
import { nanoid } from 'nanoid'
import { useSettingsStore } from './useSettingsStore'
import { estimateTokens } from '../utils/tokenCounter'
import { replaceVariables } from '../utils/variables'

interface ChatState {
  messages: Message[]
  sessions: SessionPreview[]
  currentSessionId: string | null
  isStreaming: boolean
  currentRequestId: string | null
  streamingContent: string
  error: string | null
  activePresetId: string | null
  activeLorebookId: string | null
  loadSessions: (characterId: string) => Promise<void>
  createSession: (characterId: string, title?: string) => Promise<ChatSession | null>
  switchSession: (sessionId: string, character: Character) => Promise<void>
  deleteCurrentSession: (characterId: string) => Promise<void>
  renameSession: (characterId: string, sessionId: string, title: string) => Promise<void>
  toggleMemory: (characterId: string, sessionId: string, enabled: boolean) => Promise<void>
  setMemoryMode: (characterId: string, sessionId: string, mode: 'manual' | 'auto', interval?: number) => Promise<void>
  triggerMemorySummary: (character: Character) => Promise<string | null>
  getStats: (characterId: string, sessionId: string) => Promise<{
    totalMessages: number; userMessages: number; assistantMessages: number
    totalChars: number; durationStr: string
  } | null>
  loadMessages: (character: Character) => Promise<void>
  sendMessage: (content: string, images: string[], character: Character, preset: Preset | null, lorebook: Lorebook | null) => Promise<void>
  stopStreaming: () => void
  regenerateMessage: (messageId: string, character: Character, preset: Preset | null, lorebook: Lorebook | null) => Promise<void>
  editMessage: (messageId: string, newContent: string, character: Character) => Promise<void>
  deleteMessage: (messageId: string, character: Character) => Promise<void>
  clearChat: (characterId: string) => Promise<void>
  clearMessages: () => void
  setActivePreset: (id: string | null) => void
  setActiveLorebook: (id: string | null) => void
  applyRegex: (text: string, scope: 'input' | 'output', rules: RegexRule[]) => string
  buildContext: (character: Character, preset: Preset | null, lorebook: Lorebook | null, uptoIndex?: number) => { role: 'system' | 'user' | 'assistant'; content: string }[]
}

// 用于防止竞态条件的请求计数器
let loadRequestId = 0

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  sessions: [],
  currentSessionId: null,
  isStreaming: false,
  currentRequestId: null,
  streamingContent: '',
  error: null,
  activePresetId: null,
  activeLorebookId: null,

  loadSessions: async (characterId) => {
    const sessions = await window.api.chat.listSessions(characterId)
    set({ sessions, currentSessionId: sessions[0]?.id ?? null })
  },

  createSession: async (characterId, title) => {
    const session = await window.api.chat.createSession(characterId, title)
    // 刷新会话列表
    const sessions = await window.api.chat.listSessions(characterId)
    set({ sessions, currentSessionId: session.id })
    return session
  },

  switchSession: async (sessionId, character) => {
    set({ currentSessionId: sessionId })
    // 重新加载消息
    const currentLoadId = ++loadRequestId
    set({ messages: [] })
    const messages = await window.api.chat.listMessages(character.id, sessionId)
    if (currentLoadId !== loadRequestId) return
    set({ messages })
  },

  deleteCurrentSession: async (characterId) => {
    const { currentSessionId, sessions } = get()
    if (!currentSessionId) return
    await window.api.chat.deleteSession(characterId, currentSessionId)
    // 刷新
    const newSessions = await window.api.chat.listSessions(characterId)
    const newSessionId = newSessions[0]?.id ?? null
    set({ sessions: newSessions, currentSessionId: newSessionId, messages: newSessionId ? await window.api.chat.listMessages(characterId, newSessionId) : [] })
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
    const { currentSessionId, messages, sessions } = get()
    const session = sessions.find(s => s.id === currentSessionId)
    if (!currentSessionId || !session?.memoryEnabled) return null

    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile || (!profile.apiKey && profile.provider !== 'ollama')) return null

    const settings = useSettingsStore.getState().settings
    const userName = settings.userName || '用户'

    // 取最近消息进行总结（最多取最近 20 条）
    const recentMessages = messages.slice(-20)
    if (recentMessages.length < 4) return null

    const messagesText = recentMessages
      .map(m => `${m.role === 'user' ? '用户' : character.name}: ${m.content}`)
      .join('\n')

    const previousMemory = session.memory || '无'

    const requestId = `memory-summary-${Date.now()}`
    return new Promise((resolve) => {
      let result = ''
      const unbindChunk = window.api.ai.onChunk((data) => {
        if (data.requestId !== requestId) return
        result += data.text
      })
      const unbindDone = window.api.ai.onDone(async (doneId) => {
        if (doneId !== requestId) return
        unbindChunk(); unbindDone(); unbindError()
        const summary = result.trim()
        if (summary) {
          await window.api.chat.updateMemory(character.id, currentSessionId, summary)
          // 刷新 sessions
          const refreshedSessions = await window.api.chat.listSessions(character.id)
          set({ sessions: refreshedSessions })
        }
        resolve(summary || null)
      })
      const unbindError = window.api.ai.onError(() => {
        unbindChunk(); unbindDone(); unbindError()
        resolve(null)
      })

      window.api.ai.chat({
        requestId,
        messages: [
          {
            role: 'system',
            content: `你是一个角色扮演对话总结助手。请用简洁的语言总结以下${character.name}与${userName}之间的对话，包括：\n1. 发生的主要事件和情节进展\n2. 角色之间关系的演变\n3. 当前未解决的问题或悬念\n\n只输出总结内容，不要添加任何解释或评价。\n\n之前的摘要：\n${previousMemory}`,
          },
          { role: 'user', content: `新对话内容：\n${messagesText}` },
        ],
        provider: profile.provider,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model: settings.activeModel || profile.model,
        temperature: 0.3,
        topP: 0.9,
        maxTokens: 1024,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: true,
      }).catch(() => {
        unbindChunk(); unbindDone(); unbindError()
        resolve(null)
      })
    })
  },

  getStats: async (characterId, sessionId) => {
    return window.api.chat.getStats(characterId, sessionId)
  },

  loadMessages: async (character) => {
    // 竞态条件防护
    const currentLoadId = ++loadRequestId
    set({ messages: [] }) // 先清空，避免显示旧角色消息

    // 先加载会话列表
    let sessionId = get().currentSessionId
    if (!sessionId) {
      const sessions = await window.api.chat.listSessions(character.id)
      sessionId = sessions[0]?.id ?? null
      set({ sessions, currentSessionId: sessionId })
    }

    if (!sessionId) {
      set({ messages: [] })
      return
    }

    const messages = await window.api.chat.listMessages(character.id, sessionId)

    // 如果期间又发起了新的加载请求，放弃本次结果
    if (currentLoadId !== loadRequestId) return

    if (messages.length === 0 && character.firstMessage) {
      // 没有历史消息但有开场白 -> 变量替换后自动插入并保存
      const settings = useSettingsStore.getState().settings
      const processedFirstMsg = replaceVariables(character.firstMessage, settings.userName, character.name)
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
      set({ messages: [firstMsg] })
    } else {
      set({ messages })
    }
  },

  clearMessages: () => {
    set({ messages: [] })
  },

  sendMessage: async (content, images, character, preset, lorebook) => {
    if (get().isStreaming) return

    const settingsStore = useSettingsStore.getState()
    const settings = settingsStore.settings
    const profile = settingsStore.getActiveProfile()

    if (!profile || (!profile.apiKey && profile.provider !== 'ollama')) {
      set({ error: '请先在设置中配置 API 连接' })
      return
    }

    // 加载正则规则并对输入应用
    let processedContent = content
    try {
      const regexRules = await window.api.regex.list()
      if (regexRules.length > 0) {
        processedContent = get().applyRegex(content, 'input', regexRules)
      }
    } catch { /* 忽略正则加载失败 */ }

    // 添加用户消息
    const currentSid = get().currentSessionId || 'default'
    const userMessage: Message = {
      id: nanoid(),
      sessionId: currentSid,
      characterId: character.id,
      role: 'user',
      content: processedContent,
      images,
      isEditing: false,
      timestamp: Date.now(),
    }
    set((state) => ({ messages: [...state.messages, userMessage], error: null }))
    await window.api.chat.saveMessage(userMessage)

    // 构建 AI 消息占位
    const aiMessageId = nanoid()
    const aiMessage: Message = {
      id: aiMessageId,
      sessionId: currentSid,
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

    // 构建上下文
    const contextMessages = get().buildContext(character, preset, lorebook)

    const requestId = nanoid()
    set({ currentRequestId: requestId })

    // 注册事件
    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      set((state) => {
        const msgs = [...state.messages]
        const idx = msgs.findIndex((m) => m.id === aiMessageId)
        if (idx >= 0) {
          msgs[idx] = { ...msgs[idx], content: msgs[idx].content + data.text }
        }
        return { messages: msgs }
      })
    })

    const unbindDone = window.api.ai.onDone(async (doneRequestId) => {
      if (doneRequestId !== requestId) return
      unbindChunk()
      unbindDone()
      unbindError()

      // 在 set 外部执行副作用
      const state = get()
      const aiMsg = state.messages.find((m) => m.id === aiMessageId)
      if (aiMsg && aiMsg.content) {
        // 对 AI 输出应用正则规则
        let finalContent = aiMsg.content
        try {
          const regexRules = await window.api.regex.list()
          if (regexRules.length > 0) {
            finalContent = get().applyRegex(aiMsg.content, 'output', regexRules)
          }
        } catch { /* 忽略 */ }

        const finalMsg = finalContent !== aiMsg.content ? { ...aiMsg, content: finalContent } : aiMsg
        // 更新 UI 中的消息内容
        set((s) => ({
          messages: s.messages.map((m) => (m.id === aiMessageId ? finalMsg : m)),
        }))
        window.api.chat.saveMessage(finalMsg)

        // 自动长记忆检查
        const { sessions: curSessions, currentSessionId: curSid } = get()
        const curSession = curSessions.find(s => s.id === curSid)
        if (curSession?.memoryEnabled && curSession.memoryMode === 'auto') {
          const msgCount = get().messages.filter(m => m.content).length
          if (msgCount > 0 && msgCount % (curSession.autoMemoryInterval || 10) === 0) {
            get().triggerMemorySummary(character)
          }
        }
      }
      set({ isStreaming: false, currentRequestId: null, streamingContent: '' })
    })

    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      unbindChunk()
      unbindDone()
      unbindError()

      const state = get()
      const aiMsg = state.messages.find((m) => m.id === aiMessageId)
      if (aiMsg) {
        const updatedMsg = { ...aiMsg, content: aiMsg.content || `⚠️ 发生错误：${data.error}` }
        window.api.chat.saveMessage(updatedMsg)
      }
      set((state) => {
        const msgs = [...state.messages]
        const idx = msgs.findIndex((m) => m.id === aiMessageId)
        if (idx >= 0 && !msgs[idx].content) {
          msgs[idx] = { ...msgs[idx], content: `⚠️ 发生错误：${data.error}` }
        }
        return { isStreaming: false, currentRequestId: null, error: data.error, messages: msgs }
      })
    })

    // 调用 AI
    const params: ChatParams = {
      requestId,
      messages: contextMessages,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: settings.activeModel || profile.model,
      temperature: preset?.temperature ?? 0.8,
      topP: preset?.topP ?? 0.95,
      maxTokens: preset?.maxTokens ?? 1024,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: settings.streamOutput,
    }

    try {
      await window.api.ai.chat(params)
    } catch (e) {
      unbindChunk()
      unbindDone()
      unbindError()
      set({ isStreaming: false, currentRequestId: null, error: (e as Error).message })
    }
  },

  stopStreaming: () => {
    const requestId = get().currentRequestId
    if (requestId) {
      window.api.ai.cancelChat(requestId)
    }
  },

  regenerateMessage: async (messageId, character, preset, lorebook) => {
    const messages = get().messages
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return

    // 删除该消息及之后的所有消息
    const toDelete = messages.slice(idx)
    for (const msg of toDelete) {
      await window.api.chat.deleteMessage(msg.id, character.id)
    }
    set((state) => ({ messages: state.messages.slice(0, idx) }))

    // 找到最后一条用户消息来触发重新生成
    const remainingMsgs = get().messages
    const lastUserMsg = [...remainingMsgs].reverse().find((m) => m.role === 'user')

    if (!lastUserMsg) return

    // 直接生成 AI 回复（不再添加用户消息）
    const settingsStore = useSettingsStore.getState()
    const settings = settingsStore.settings
    const profile = settingsStore.getActiveProfile()
    if (!profile || (!profile.apiKey && profile.provider !== 'ollama')) return

    const aiMessageId = nanoid()
    const aiMessage: Message = {
      id: aiMessageId,
      sessionId: character.id,
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
      error: null,
    }))

    const contextMessages = get().buildContext(character, preset, lorebook)
    const requestId = nanoid()
    set({ currentRequestId: requestId })

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      set((state) => {
        const msgs = [...state.messages]
        const i = msgs.findIndex((m) => m.id === aiMessageId)
        if (i >= 0) msgs[i] = { ...msgs[i], content: msgs[i].content + data.text }
        return { messages: msgs }
      })
    })

    const unbindDone = window.api.ai.onDone((doneRequestId) => {
      if (doneRequestId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()

      const state = get()
      const aiMsg = state.messages.find((m) => m.id === aiMessageId)
      if (aiMsg && aiMsg.content) {
        window.api.chat.saveMessage(aiMsg)
      }
      set({ isStreaming: false, currentRequestId: null })
    })

    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()
      set({ isStreaming: false, currentRequestId: null, error: data.error })
    })

    const params: ChatParams = {
      requestId,
      messages: contextMessages,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: settings.activeModel || profile.model,
      temperature: preset?.temperature ?? 0.8,
      topP: preset?.topP ?? 0.95,
      maxTokens: preset?.maxTokens ?? 1024,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: settings.streamOutput,
    }
    await window.api.ai.chat(params)
  },

  editMessage: async (messageId, newContent, character) => {
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
  },

  deleteMessage: async (messageId, character) => {
    await window.api.chat.deleteMessage(messageId, character.id, get().currentSessionId ?? undefined)
    set((state) => ({ messages: state.messages.filter((m) => m.id !== messageId) }))
  },

  clearChat: async (characterId) => {
    const sessionId = get().currentSessionId
    await window.api.chat.clearChat(characterId, sessionId ?? undefined)
    set({ messages: [] })
  },

  setActivePreset: (id) => set({ activePresetId: id }),
  setActiveLorebook: (id) => set({ activeLorebookId: id }),

  applyRegex: (text, scope, rules) => {
    if (!text || rules.length === 0) return text
    let result = text
    for (const rule of rules) {
      if (!rule.enabled) continue
      if (rule.scope !== scope && rule.scope !== 'both') continue
      try {
        const regex = new RegExp(rule.pattern, 'g')
        result = result.replace(regex, rule.replacement)
      } catch {
        // 正则语法错误时跳过
      }
    }
    return result
  },

  buildContext: (character, preset, lorebook) => {
    const settings = useSettingsStore.getState().settings
    const userName = settings.userName || '用户'
    const messages = get().messages.filter((m) => m.content) // 过滤空消息
    const context: { role: 'system' | 'user' | 'assistant'; content: string }[] = []

    // System Prompt + 用户人设
    let systemContent = preset?.systemPrompt || '你是一个角色扮演助手。请根据角色设定进行沉浸式对话，保持角色性格的一致性。'
    if (preset?.jailbreak) systemContent += '\n\n' + preset.jailbreak
    // 用户人设注入
    if (settings.userDescription || settings.userPersona) {
      systemContent += '\n\n【用户人设】'
      if (settings.userDescription) systemContent += '\n描述：' + settings.userDescription
      if (settings.userPersona) systemContent += '\n性格：' + settings.userPersona
    }

    // 心理描写输出格式
    systemContent += '\n\n【输出格式要求】\n请先在 <thought>...</thought> 标签内输出角色的内心想法和心理活动，然后再输出角色的实际对话和行动。两部分必须分开。'

    // 长记忆注入
    const { sessions, currentSessionId } = get()
    const currentSession = sessions.find(s => s.id === currentSessionId)
    if (currentSession?.memoryEnabled && currentSession.memory) {
      systemContent += '\n\n【对话历史摘要】\n' + currentSession.memory
    }

    // 角色设定（变量替换）
    let charDesc = ''
    if (character.description) charDesc += replaceVariables(character.description, userName, character.name) + '\n'
    if (character.personality) charDesc += '性格：' + replaceVariables(character.personality, userName, character.name) + '\n'
    if (character.scenario) charDesc += '场景：' + replaceVariables(character.scenario, userName, character.name) + '\n'

    // 世界书注入
    if (lorebook?.enabled) {
      const recentText = messages.slice(-lorebook.scanDepth).map((m) => m.content).join(' ')
      const triggered = lorebook.entries
        .filter((e) => e.enabled)
        .filter((e) => e.keywords.some((k) => k && recentText.includes(k)))
        .sort((a, b) => a.order - b.order)

      for (const entry of triggered) {
        if (Math.random() * 100 > entry.probability) continue
        const entryContent = replaceVariables(entry.content, userName, character.name)
        if (entry.position === 'before_char') {
          charDesc = entryContent + '\n' + charDesc
        } else if (entry.position === 'after_char') {
          charDesc = charDesc + '\n' + entryContent
        } else {
          systemContent += '\n\n' + entryContent
        }
      }
    }

    if (charDesc) systemContent += '\n\n【角色设定】\n' + charDesc
    context.push({ role: 'system', content: systemContent })

    // 对话示例（变量替换）
    if (character.exampleDialog) {
      context.push({ role: 'system', content: '【对话示例】\n' + replaceVariables(character.exampleDialog, userName, character.name) })
    }

    // 历史消息（包含开场白，因为开场白现在作为真实消息存储）
    const profile = useSettingsStore.getState().getActiveProfile()
    const maxContext = profile?.maxContext || preset?.maxContext || 8192
    let usedTokens = estimateTokens(context.map((c) => c.content).join(''))
    const recentMessages: typeof messages = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const tokenCount = estimateTokens(msg.content)
      if (usedTokens + tokenCount > maxContext) break
      recentMessages.unshift(msg)
      usedTokens += tokenCount
    }

    for (const msg of recentMessages) {
      context.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      })
    }

    return context
  },
}))

import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { GroupChat, GroupMessage, GroupSession, Character, Lorebook } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'

const STREAM_THROTTLE_MS = 50
const STREAM_TIMEOUT_MS = 5 * 60 * 1000

/** 世界书缓存：供 buildGroupContext 同步查找 */
const groupLorebookCache = new Map<string, Lorebook>()

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

function cleanupActiveStream() {
  if (!activeStream) return
  clearTimeout(activeStream.flushTimer!)
  clearTimeout(activeStream.timeoutHandle!)
  activeStream.unbindChunk()
  activeStream.unbindDone()
  activeStream.unbindError()
  activeStream = null
}

interface GroupChatState {
  groupChats: GroupChat[]
  currentGroup: GroupChat | null
  sessions: GroupSession[]
  currentSessionId: string | null
  messages: GroupMessage[]
  isStreaming: boolean
  currentStreamingCharId: string | null
  streamingContent: string
  error: string | null

  loadGroups: () => Promise<void>
  setCurrentGroup: (group: GroupChat) => void
  saveGroup: (group: GroupChat) => Promise<void>
  deleteGroup: (id: string) => Promise<void>
  selectGroup: (groupId: string) => Promise<void>

  loadSessions: (groupId: string) => Promise<void>
  createSession: (groupId: string) => Promise<void>
  switchSession: (groupId: string, sessionId: string) => Promise<void>
  deleteSession: (groupId: string, sessionId: string) => Promise<void>
  renameSession: (groupId: string, sessionId: string, title: string) => Promise<void>

  loadMessages: (groupId: string, sessionId: string) => Promise<void>
  sendMessage: (content: string, images: string[], targetCharId?: string) => Promise<void>
  sendPollingRound: (charId: string) => Promise<void>
  stopStreaming: () => void
  clearChat: (groupId: string) => Promise<void>
  clearMessages: () => void
  deleteMessage: (groupId: string, sessionId: string, messageId: string) => Promise<void>
  editMessage: (groupId: string, sessionId: string, messageId: string, content: string) => Promise<void>
  regenerateMessage: (messageId: string) => Promise<void>
  translateMessage: (messageId: string) => Promise<void>

  buildGroupContext: (targetCharId?: string) => { role: 'system' | 'user' | 'assistant'; content: string }[]
  ensureLorebooksLoaded: (lorebookIds: string[]) => Promise<void>
}

export const useGroupChatStore = create<GroupChatState>((set, get) => ({
  groupChats: [],
  currentGroup: null,
  sessions: [],
  currentSessionId: null,
  messages: [],
  isStreaming: false,
  currentStreamingCharId: null,
  streamingContent: '',
  error: null,

  // ---- 群聊列表 ----

  loadGroups: async () => {
    const groups = await window.api.group.list()
    set({ groupChats: groups })
  },

  setCurrentGroup: (group) => {
    set({ currentGroup: group })
  },

  saveGroup: async (group) => {
    await window.api.group.save(group)
    const groups = await window.api.group.list()
    set({ groupChats: groups, currentGroup: group })
  },

  deleteGroup: async (id) => {
    await window.api.group.delete(id)
    const groups = await window.api.group.list()
    set({ groupChats: groups, currentGroup: null, messages: [], sessions: [], currentSessionId: null })
  },

  selectGroup: async (groupId) => {
    const groups = await window.api.group.list()
    const group = groups.find(g => g.id === groupId) ?? null
    if (!group) return
    set({ currentGroup: group })
    // 预加载世界书缓存
    if (group.lorebookIds.length > 0) {
      await get().ensureLorebooksLoaded(group.lorebookIds)
    }
    await get().loadSessions(groupId)
  },

  // ---- 会话 ----

  loadSessions: async (groupId) => {
    const sessions = await window.api.group.listSessions(groupId)
    set({ sessions, currentSessionId: sessions[0]?.id ?? null })
    if (sessions[0]) {
      await get().loadMessages(groupId, sessions[0].id)
    }
  },

  createSession: async (groupId) => {
    const session = await window.api.group.createSession(groupId)
    const sessions = await window.api.group.listSessions(groupId)
    set({ sessions, currentSessionId: session.id, messages: [] })
  },

  switchSession: async (groupId, sessionId) => {
    set({ currentSessionId: sessionId })
    await get().loadMessages(groupId, sessionId)
  },

  deleteSession: async (groupId, sessionId) => {
    await window.api.group.deleteSession(groupId, sessionId)
    const sessions = await window.api.group.listSessions(groupId)
    const newSid = sessions[0]?.id ?? null
    set({ sessions, currentSessionId: newSid, messages: [] })
    if (newSid) {
      await get().loadMessages(groupId, newSid)
    }
  },

  renameSession: async (groupId, sessionId, title) => {
    await window.api.group.renameSession(groupId, sessionId, title)
    const sessions = await window.api.group.listSessions(groupId)
    set({ sessions })
  },

  // ---- 消息 ----

  loadMessages: async (groupId, sessionId) => {
    const messages = await window.api.group.listMessages(groupId, sessionId)
    set({ messages })
  },

  clearMessages: () => {
    set({ messages: [], error: null })
  },

  clearChat: async (groupId) => {
    const { currentSessionId } = get()
    if (currentSessionId) {
      await window.api.group.clearChat(groupId, currentSessionId)
    }
    set({ messages: [] })
  },

  deleteMessage: async (groupId, sessionId, messageId) => {
    await window.api.group.deleteMessage(groupId, sessionId, messageId)
    set(s => ({
      messages: s.messages.filter(m => m.id !== messageId),
    }))
  },

  editMessage: async (groupId, sessionId, messageId, content) => {
    await window.api.group.editMessage(groupId, sessionId, messageId, content)
    set(s => ({
      messages: s.messages.map(m =>
        m.id === messageId ? { ...m, content } : m
      ),
    }))
  },

  regenerateMessage: async (messageId) => {
    const state = get()
    const { currentGroup, currentSessionId } = state
    if (!currentGroup || !currentSessionId || state.isStreaming) return

    // 找到目标消息的前一条用户消息
    const msgIdx = state.messages.findIndex(m => m.id === messageId)
    if (msgIdx < 0) return

    const targetMsg = state.messages[msgIdx]
    const charStore = useCharacterStore.getState()
    const speaker = charStore.characters.find(c => c.id === targetMsg.characterId)
    if (!speaker) return

    // 删除旧 AI 回复
    await window.api.group.deleteMessage(currentGroup.id, currentSessionId, messageId)
    set(s => ({
      messages: s.messages.filter(m => m.id !== messageId),
    }))

    // 重新生成
    await streamGroupAI(set, get, currentGroup, currentSessionId, speaker, targetMsg.round, () => {
      if (currentGroup.chatMode === 'polling' && currentGroup.autoMode) {
        checkPollingContinue(set, get, currentGroup)
      }
    })
  },

  translateMessage: async (messageId) => {
    const state = get()
    const msg = state.messages.find(m => m.id === messageId)
    if (!msg || !msg.content) return

    const settingsStore = useSettingsStore.getState()
    const profile = settingsStore.getActiveProfile()
    if (!profile) return

    // 设置加载状态
    set(s => ({
      messages: s.messages.map(m =>
        m.id === messageId ? { ...m, translation: '...' } : m
      ),
    }))

    try {
      const response = await fetch(`${profile.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${profile.apiKey}`,
        },
        body: JSON.stringify({
          model: profile.model,
          messages: [
            { role: 'system', content: '你是一个翻译助手。请将以下内容翻译成中文。只输出翻译结果，不要添加任何解释。' },
            { role: 'user', content: msg.content },
          ],
          temperature: 0.3,
          max_tokens: 2048,
        }),
      })

      if (!response.ok) {
        set(s => ({
          messages: s.messages.map(m =>
            m.id === messageId ? { ...m, translation: null } : m
          ),
        }))
        return
      }

      const data = await response.json()
      const translated = data.choices?.[0]?.message?.content?.trim() || ''

      set(s => ({
        messages: s.messages.map(m =>
          m.id === messageId ? { ...m, translation: translated || null } : m
        ),
      }))
    } catch {
      set(s => ({
        messages: s.messages.map(m =>
          m.id === messageId ? { ...m, translation: null } : m
        ),
      }))
    }
  },

  ensureLorebooksLoaded: async (lorebookIds) => {
    const allLorebooks = await window.api.lorebook.list()
    for (const lb of allLorebooks) {
      if (lorebookIds.includes(lb.id)) {
        groupLorebookCache.set(lb.id, lb)
      }
    }
  },

  // ---- 核心：发送消息 ----

  sendMessage: async (content, images, targetCharId) => {
    const state = get()
    const { currentGroup, currentSessionId } = state
    if (!currentGroup || !currentSessionId) return

    if (state.isStreaming) {
      set({ error: '正在生成回复中，请稍候或点击停止' })
      return
    }

    const settingsStore = useSettingsStore.getState()
    const profile = settingsStore.getActiveProfile()
    if (!profile || (!profile.apiKey && profile.provider !== 'ollama')) {
      set({ error: '请先在设置中配置 API 连接' })
      return
    }

    // 1. 用户消息
    const currentRound = state.messages.length > 0
      ? Math.max(...state.messages.map(m => m.round), 0) + 1
      : 1

    const userMsg: GroupMessage = {
      id: nanoid(),
      groupId: currentGroup.id,
      characterId: '__user__',
      content,
      images,
      timestamp: Date.now(),
      round: currentRound,
    }
    set(s => ({ messages: [...s.messages, userMsg], error: null }))
    await window.api.group.saveMessage(currentGroup.id, currentSessionId, userMsg)

    // 2. 根据模式获取 AI 回复
    const mode = currentGroup.chatMode
    const charStore = useCharacterStore.getState()

    if (mode === 'mention' || mode === 'polling') {
      // mention/polling: 单个角色回复
      let speakerId = targetCharId

      if (mode === 'polling' || !speakerId) {
        const speakerIdx = currentGroup.currentSpeakerIndex % currentGroup.memberIds.length
        speakerId = currentGroup.memberIds[speakerIdx]
      }

      if (!speakerId) {
        set({ error: '未指定发言角色' })
        return
      }

      const speaker = charStore.characters.find(c => c.id === speakerId)
      if (!speaker) {
        set({ error: '发言角色不存在' })
        return
      }

      await streamGroupAI(set, get, currentGroup, currentSessionId, speaker, userMsg.round, () => {
        // onComplete: polling 模式下自动下一轮
        if (currentGroup.chatMode === 'polling' && currentGroup.autoMode) {
          checkPollingContinue(set, get, currentGroup)
        }
      })
    } else {
      // free 模式：AI 一次返回多角色回复
      await streamGroupAIFree(set, get, currentGroup, currentSessionId, userMsg.round)
    }
  },

  sendPollingRound: async (charId) => {
    const state = get()
    const { currentGroup, currentSessionId } = state
    if (!currentGroup || !currentSessionId || state.isStreaming) return

    const charStore = useCharacterStore.getState()
    const speaker = charStore.characters.find(c => c.id === charId)
    if (!speaker) return

    const currentRound = state.messages.length > 0
      ? Math.max(...state.messages.map(m => m.round), 0) + 1
      : 1

    await streamGroupAI(set, get, currentGroup, currentSessionId, speaker, currentRound, () => {
      checkPollingContinue(set, get, currentGroup)
    })
  },

  stopStreaming: () => {
    cleanupActiveStream()
    window.api.ai.cancelChat(activeStream?.requestId ?? '').catch(() => {})
    set({ isStreaming: false, currentStreamingCharId: null, streamingContent: '' })
  },

  // ---- 群聊上下文构建 ----

  buildGroupContext: (targetCharId?) => {
    const state = get()
    const group = state.currentGroup
    if (!group) return []

    const charStore = useCharacterStore.getState()
    const settings = useSettingsStore.getState().settings
    const members = group.memberIds
      .map(id => charStore.characters.find(c => c.id === id))
      .filter(Boolean) as Character[]

    let systemContent = ''

    // 群聊 Overview
    systemContent += `你正在参与一个群聊「${group.name}」。本群聊中共有 ${members.length} 个角色参与对话：\n`
    members.forEach((m, i) => {
      systemContent += `${i + 1}. 【${m.name}】${m.description ? ' - ' + m.description.slice(0, 80) : ''}\n`
    })
    systemContent += `\n用户「${settings.userName || '用户'}」也在群聊中。\n`

    // 模式指令
    switch (group.chatMode) {
      case 'mention':
        systemContent += '\n【对话规则】用户通过 @角色名 指定回复对象。只有被点名的角色才需要回复。回复时请以该角色的第一人称视角发言，不要替其他角色说话。\n'
        break
      case 'polling':
        systemContent += '\n【对话规则】当前采用自动轮询模式。每次只轮到一位角色发言。请以该角色的第一人称视角回复，不要替其他角色或用户发言。\n'
        break
      case 'free':
        systemContent += '\n【对话规则】你可以让多个角色参与对话。如果多个角色需要发言，请用「【角色名】」标注每段发言的发言人。\n'
        break
    }

    // 心理描写格式
    if (settings.enableThoughtFormat !== false) {
      systemContent += '\n【输出格式】如果需要描写角色内心活动或心理,请将心理描写放在 <thought>...</thought> 标签内。\n'
    }

    // 群聊自定义 systemPrompt
    if (group.systemPrompt) {
      systemContent += '\n' + group.systemPrompt + '\n'
    }

    // 世界书注入
    let lorebookBefore = ''
    let lorebookAfter = ''
    let lorebookAtEnd = ''

    if (group.lorebookIds.length > 0) {
      const scanDepth = 10
      const recentMessages = state.messages.slice(-scanDepth)
      const recentText = recentMessages.map(m => m.content).join(' ')

      const beforeEntries: { content: string; order: number }[] = []
      const afterEntries: { content: string; order: number }[] = []
      const atEndEntries: { content: string; order: number }[] = []

      for (const lbId of group.lorebookIds) {
        const lb = groupLorebookCache.get(lbId)
        if (!lb?.enabled) continue
        const triggered = lb.entries
          .filter(e => e.enabled)
          .filter(e => e.keywords.some(k => k && recentText.includes(k)))
          .sort((a, b) => a.order - b.order)
        for (const entry of triggered) {
          if (entry.probability < 100 && Math.random() * 100 >= entry.probability) continue
          const item = { content: entry.content, order: entry.order }
          if (entry.position === 'before_char') {
            beforeEntries.push(item)
          } else if (entry.position === 'after_char') {
            afterEntries.push(item)
          } else {
            atEndEntries.push(item)
          }
        }
      }

      beforeEntries.sort((a, b) => a.order - b.order)
      afterEntries.sort((a, b) => a.order - b.order)
      atEndEntries.sort((a, b) => a.order - b.order)

      if (beforeEntries.length > 0) {
        lorebookBefore = beforeEntries.map(e => e.content).join('\n') + '\n'
      }
      if (afterEntries.length > 0) {
        lorebookAfter = afterEntries.map(e => e.content).join('\n')
      }
      if (atEndEntries.length > 0) {
        lorebookAtEnd = '\n\n' + atEndEntries.map(e => e.content).join('\n')
      }
    }

    // 完整角色设定（mention/polling 时为目标角色；free 时为所有角色）
    if (group.chatMode === 'free') {
      systemContent += '\n\n' + lorebookBefore + '以下是所有角色的完整设定：\n'
      members.forEach(m => {
        systemContent += `\n--- ${m.name} ---\n`
        if (m.description) systemContent += `描述：${m.description}\n`
        if (m.personality) systemContent += `性格：${m.personality}\n`
        if (m.scenario) systemContent += `场景：${m.scenario}\n`
      })
      if (lorebookAfter) systemContent += '\n' + lorebookAfter
    } else if (targetCharId) {
      const target = members.find(m => m.id === targetCharId)
      if (target) {
        systemContent += `\n\n${lorebookBefore}【当前发言角色：${target.name}】\n`
        if (target.description) systemContent += `描述：${target.description}\n`
        if (target.personality) systemContent += `性格：${target.personality}\n`
        if (target.scenario) systemContent += `场景：${target.scenario}\n`
        if (target.systemPrompt) systemContent += `\n${target.systemPrompt}\n`
        if (lorebookAfter) systemContent += '\n' + lorebookAfter
      }
    }

    // 用户人设
    if (settings.userDescription || settings.userPersona) {
      systemContent += '\n【用户人设】\n'
      if (settings.userDescription) systemContent += `描述：${settings.userDescription}\n`
      if (settings.userPersona) systemContent += `性格：${settings.userPersona}\n`
    }

    // 世界书 at_end 条目
    if (lorebookAtEnd) {
      systemContent += lorebookAtEnd
    }

    // 历史消息
    const history = state.messages.slice(-20)
    const historyContext: { role: 'system' | 'user' | 'assistant'; content: string }[] = []

    history.forEach(m => {
      const char = members.find(c => c.id === m.characterId)
      const speaker = m.characterId === '__user__'
        ? (settings.userName || '用户')
        : (char?.name || '未知角色')

      if (m.characterId === '__user__') {
        historyContext.push({ role: 'user', content: m.content })
      } else {
        historyContext.push({
          role: 'assistant',
          content: `【${speaker}】${m.content}`,
        })
      }
    })

    return [
      { role: 'system', content: systemContent },
      ...historyContext,
    ]
  },
}))

// ====================== 流式处理 ======================

async function flushStream(set: any) {
  if (!activeStream) return
  activeStream.flushTimer = null
  set({
    streamingContent: activeStream.accumulated,
  })
}

async function streamGroupAI(
  set: any,
  get: any,
  group: GroupChat,
  sessionId: string,
  speaker: Character,
  round: number,
  onComplete: () => void,
) {
  const settingsStore = useSettingsStore.getState()
  const profile = settingsStore.getActiveProfile()
  if (!profile) return

  // 加载预设
  let preset = null
  if (group.presetId) {
    const allPresets = await window.api.preset.list()
    preset = allPresets.find(p => p.id === group.presetId) ?? null
  }

  const context = get().buildGroupContext(speaker.id)

  // 注入预设 systemPrompt 和 jailbreak
  if (preset && context.length > 0) {
    let systemMsg = context[0].content
    if (preset.systemPrompt) {
      systemMsg += '\n\n' + preset.systemPrompt
    }
    if (preset.jailbreak) {
      systemMsg += '\n\n' + preset.jailbreak
    }
    context[0] = { ...context[0], content: systemMsg }
  }

  if (context.length === 0) return

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
  set((s: any) => ({
    messages: [...s.messages, placeholder],
    isStreaming: true,
    currentStreamingCharId: speaker.id,
    streamingContent: '',
    error: null,
  }))

  // 绑定流式事件
  const unbindChunk = window.api.ai.onChunk((data: { requestId: string; text: string }) => {
    if (data.requestId !== requestId || !activeStream || activeStream.requestId !== requestId) return
    activeStream.accumulated += data.text
    if (activeStream.flushTimer === null) {
      activeStream.flushTimer = setTimeout(() => flushStream(set), STREAM_THROTTLE_MS)
    }
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

    // 更新消息
    set((s: any) => ({
      messages: s.messages.map((m: GroupMessage) =>
        m.id === msgId ? { ...m, content: clean || '(无回复)' } : m,
      ),
      isStreaming: false,
      currentStreamingCharId: null,
      streamingContent: '',
    }))

    // 持久化
    window.api.group.saveMessage(group.id, sessionId, {
      id: msgId,
      groupId: group.id,
      characterId: speaker.id,
      content: clean || '(无回复)',
      images: [],
      timestamp: Date.now(),
      round,
    })

    onComplete()
  })

  const unbindError = window.api.ai.onError((data: { requestId: string; error: string }) => {
    if (data.requestId !== requestId) return

    if (activeStream?.flushTimer !== null) {
      clearTimeout(activeStream.flushTimer!)
    }
    cleanupActiveStream()

    const errContent = activeStream?.accumulated
      ? activeStream.accumulated + '\n\n⚠️ ' + data.error
      : '⚠️ ' + data.error

    set((s: any) => ({
      messages: s.messages.map((m: GroupMessage) =>
        m.id === msgId ? { ...m, content: errContent } : m,
      ),
      isStreaming: false,
      currentStreamingCharId: null,
      streamingContent: '',
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
      cleanupActiveStream()
      window.api.ai.cancelChat(requestId).catch(() => {})
      set({ isStreaming: false, currentStreamingCharId: null })
    }, STREAM_TIMEOUT_MS),
  }

  // 发起 AI 请求
  try {
    await window.api.ai.chat({
      requestId,
      messages: context,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
      temperature: preset?.temperature ?? profile.temperature ?? 0.8,
      topP: preset?.topP ?? 0.95,
      maxTokens: preset?.maxTokens ?? profile.maxTokens ?? 1024,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: true,
    })
  } catch (err: any) {
    cleanupActiveStream()
    set({
      isStreaming: false,
      currentStreamingCharId: null,
      streamingContent: '',
      error: err instanceof Error ? err.message : '请求失败',
    })
  }
}

async function streamGroupAIFree(
  set: any,
  get: any,
  group: GroupChat,
  sessionId: string,
  round: number,
) {
  const settingsStore = useSettingsStore.getState()
  const profile = settingsStore.getActiveProfile()
  if (!profile) return

  // 加载预设
  let preset = null
  if (group.presetId) {
    const allPresets = await window.api.preset.list()
    preset = allPresets.find(p => p.id === group.presetId) ?? null
  }

  const context = get().buildGroupContext()

  // 注入预设 systemPrompt 和 jailbreak
  if (preset && context.length > 0) {
    let systemMsg = context[0].content
    if (preset.systemPrompt) {
      systemMsg += '\n\n' + preset.systemPrompt
    }
    if (preset.jailbreak) {
      systemMsg += '\n\n' + preset.jailbreak
    }
    context[0] = { ...context[0], content: systemMsg }
  }

  if (context.length === 0) return

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
  set((s: any) => ({
    messages: [...s.messages, placeholder],
    isStreaming: true,
    currentStreamingCharId: '__free__',
    streamingContent: '',
    error: null,
  }))

  const unbindChunk = window.api.ai.onChunk((data: { requestId: string; text: string }) => {
    if (data.requestId !== requestId || !activeStream || activeStream.requestId !== requestId) return
    activeStream.accumulated += data.text
    if (activeStream.flushTimer === null) {
      activeStream.flushTimer = setTimeout(() => flushStream(set), STREAM_THROTTLE_MS)
    }
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
    splitAndSaveMessages(set, get, group, sessionId, clean, round, msgId)
  })

  const unbindError = window.api.ai.onError((data: { requestId: string; error: string }) => {
    if (data.requestId !== requestId) return
    if (activeStream?.flushTimer !== null) clearTimeout(activeStream.flushTimer!)
    cleanupActiveStream()
    set((s: any) => ({
      messages: s.messages.map((m: GroupMessage) => m.id === msgId ? { ...m, content: '⚠️ ' + data.error } : m),
      isStreaming: false, currentStreamingCharId: null, streamingContent: '', error: data.error,
    }))
  })

  activeStream = {
    requestId, msgId, accumulated: '', flushTimer: null,
    unbindChunk, unbindDone, unbindError,
    timeoutHandle: setTimeout(() => {
      cleanupActiveStream()
      window.api.ai.cancelChat(requestId).catch(() => {})
      set({ isStreaming: false, currentStreamingCharId: null })
    }, STREAM_TIMEOUT_MS),
  }

  try {
    await window.api.ai.chat({
      requestId,
      messages: context,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
      temperature: preset?.temperature ?? profile.temperature ?? 0.8,
      topP: preset?.topP ?? 0.95,
      maxTokens: preset?.maxTokens ?? profile.maxTokens ?? 1024,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: true,
    })
  } catch (err: any) {
    cleanupActiveStream()
    set({
      isStreaming: false, currentStreamingCharId: null, streamingContent: '',
      error: err instanceof Error ? err.message : '请求失败',
    })
  }
}

/** 解析 free 模式 AI 回复，拆分为多条角色消息 */
async function splitAndSaveMessages(
  set: any,
  get: any,
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
    }
    segments.push({ name: match[1], content: '' })
    lastIdx = match.index + match[0].length
  }

  // 最后一段
  if (segments.length > 0) {
    segments[segments.length - 1].content = content.slice(lastIdx).trim()
  }

  if (segments.length === 0) {
    // 没有匹配到任何角色标记，作为占位消息保留
    set((s: any) => ({
      messages: s.messages.map((m: GroupMessage) =>
        m.id === placeholderId ? { ...m, content: content || '(无回复)' } : m,
      ),
      isStreaming: false, currentStreamingCharId: null, streamingContent: '',
    }))
    return
  }

  // 移除占位消息，替换为拆分的角色消息
  const newMessages: GroupMessage[] = []
  for (const seg of segments) {
    const char = members.find(c => c.name === seg.name)
    if (!char || !seg.content) continue
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
    await window.api.group.saveMessage(group.id, sessionId, gm)
  }

  set((s: any) => ({
    messages: s.messages
      .filter((m: GroupMessage) => m.id !== placeholderId)
      .concat(newMessages)
      .sort((a: GroupMessage, b: GroupMessage) => a.timestamp - b.timestamp),
    isStreaming: false,
    currentStreamingCharId: null,
    streamingContent: '',
  }))
}

/** 检查 polling 模式下是否需要继续下一轮 */
async function checkPollingContinue(set: any, get: any, group: GroupChat) {
  const state = get()
  const pollingMsgs = state.messages.filter((m: GroupMessage) => m.characterId !== '__user__' && m.characterId !== '__free__')
  const rounds = new Set(pollingMsgs.map((m: GroupMessage) => m.round))
  if (rounds.size >= group.maxRounds) return

  // 找下一个发言者
  const lastCharMsg = [...state.messages].reverse().find((m: GroupMessage) => m.characterId !== '__user__' && m.characterId !== '__free__')
  if (!lastCharMsg) return

  const currentIdx = group.memberIds.indexOf(lastCharMsg.characterId)
  const nextIdx = (currentIdx + 1) % group.memberIds.length
  const nextCharId = group.memberIds[nextIdx]

  // 更新 currentSpeakerIndex
  const updatedGroup = { ...group, currentSpeakerIndex: nextIdx }

  // 间隔后自动下一轮
  setTimeout(() => {
    const currentState = get()
    if (currentState.isStreaming) return
    currentState.sendPollingRound(nextCharId)
  }, (group.speakerInterval || 2000))
}

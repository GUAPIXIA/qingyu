import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { GroupChat, GroupMessage, GroupSession, Character } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'
import { lorebookCache } from '../utils/lorebook'
import { estimateTokens, getDefaultMaxContext } from '../utils/tokenCounter'
import { replaceVariables } from '../utils/variables'
import { mergeConsecutiveMessages } from '../utils/messagePostProcess'
import { convertMessages } from '../utils/promptConverters'
import { getInstructTemplate } from '../utils/chatTemplates'

const STREAM_THROTTLE_MS = 50
const STREAM_TIMEOUT_MS = 5 * 60 * 1000

/** 将原始 API 错误转换为用户友好的中文提示 */
function friendlyError(error: string): string {
  if (!error) return '未知错误'
  const lower = error.toLowerCase()
  if (lower.includes('401') || lower.includes('unauthorized')) return 'API Key 无效或已过期'
  if (lower.includes('403') || lower.includes('forbidden')) return '访问被拒绝，请检查 API Key 权限'
  if (lower.includes('429') || lower.includes('rate limit')) return '请求过于频繁，请稍后再试'
  if (lower.includes('500') || lower.includes('502') || lower.includes('503')) return 'AI 服务暂时不可用，请稍后重试'
  if (lower.includes('timeout') || lower.includes('aborted')) return '请求超时，请检查网络'
  if (lower.includes('network') || lower.includes('econnrefused') || lower.includes('fetch failed')) return '网络连接失败，请检查网络或 Base URL'
  if (lower.includes('model not found')) return '模型不存在，请检查模型名'
  if (lower.includes('context length') || lower.includes('too long')) return '上下文过长，请清空部分对话'
  return error.length > 100 ? error.slice(0, 100) + '...' : error
}

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

/** 轮询定时器 handle，用于切换/删除群聊时清理 */
let pollingTimer: ReturnType<typeof setTimeout> | null = null

function cleanupActiveStream() {
  if (!activeStream) return
  clearTimeout(activeStream.flushTimer!)
  clearTimeout(activeStream.timeoutHandle!)
  activeStream.unbindChunk()
  activeStream.unbindDone()
  activeStream.unbindError()
  activeStream = null
}

/** 清理轮询定时器 */
function clearPollingTimer() {
  if (pollingTimer !== null) {
    clearTimeout(pollingTimer)
    pollingTimer = null
  }
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

  toggleMemory: (groupId: string, sessionId: string, enabled: boolean) => Promise<void>
  setMemoryMode: (groupId: string, sessionId: string, mode: 'manual' | 'auto', interval?: number) => Promise<void>
  triggerMemorySummary: () => Promise<void>
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
    clearPollingTimer()
    cleanupActiveStream()
    await window.api.group.delete(id)
    const groups = await window.api.group.list()
    set({ groupChats: groups, currentGroup: null, messages: [], sessions: [], currentSessionId: null })
  },

  selectGroup: async (groupId) => {
    clearPollingTimer()
    cleanupActiveStream()
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
      checkAutoMemory(get)
    })
  },

  translateMessage: async (messageId) => {
    const state = get()
    const msg = state.messages.find(m => m.id === messageId)
    if (!msg || !msg.content) return

    const settingsStore = useSettingsStore.getState()
    const profile = settingsStore.getActiveProfile()
    if (!profile) return

    // 如果已有翻译，切换显示/隐藏
    if (msg.translation && msg.translation !== '...') {
      set(s => ({
        messages: s.messages.map(m =>
          m.id === messageId ? { ...m, _showTranslation: !m._showTranslation } : m
        ),
      }))
      return
    }

    // 设置加载状态
    set(s => ({
      messages: s.messages.map(m =>
        m.id === messageId ? { ...m, translation: '...' } : m
      ),
    }))

    // H-08 修复：使用 IPC 而非直接 fetch，避免 API Key 暴露和 CORS 问题
    const requestId = `group-translate-${messageId}-${Date.now()}`
    let result = ''

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
    })

    const unbindDone = window.api.ai.onDone((doneId) => {
      if (doneId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()

      const finalResult = (result || '').replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim() || null
      set((s: any) => ({
        messages: s.messages.map((m: GroupMessage) =>
          m.id === messageId ? { ...m, translation: finalResult, _showTranslation: true } : m
        ),
      }))
    })

    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()

      set((s: any) => ({
        messages: s.messages.map((m: GroupMessage) =>
          m.id === messageId ? { ...m, translation: null } : m
        ),
      }))
    })

    const targetLang = useSettingsStore.getState().settings.translationTargetLang || '中文'
    window.api.ai.chat({
      requestId,
      messages: [
        { role: 'system', content: `你是一个翻译助手。请将以下内容翻译成${targetLang}。只输出翻译结果，不要添加任何解释。` },
        { role: 'user', content: msg.content },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
      temperature: 0.3,
      topP: 1,
      maxTokens: 2048,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
    }).catch(() => {
      unbindChunk(); unbindDone(); unbindError()
      set((s: any) => ({
        messages: s.messages.map((m: GroupMessage) =>
          m.id === messageId ? { ...m, translation: null } : m
        ),
      }))
    })
  },

  ensureLorebooksLoaded: async (lorebookIds) => {
    const allLorebooks = await window.api.lorebook.list()
    for (const lb of allLorebooks) {
      if (lorebookIds.includes(lb.id)) {
        lorebookCache.set(lb.id, lb)
      }
    }
  },

  // ---- 记忆管理 ----

  toggleMemory: async (groupId, sessionId, enabled) => {
    await window.api.group.toggleMemory(groupId, sessionId, enabled)
    // 刷新本地 session 状态
    const sessions = get().sessions.map(s =>
      s.id === sessionId ? { ...s, memoryEnabled: enabled } : s
    )
    set({ sessions })
  },

  setMemoryMode: async (groupId, sessionId, mode, interval?) => {
    await window.api.group.setMemoryMode(groupId, sessionId, mode, interval)
    const sessions = get().sessions.map(s =>
      s.id === sessionId ? { ...s, memoryMode: mode, ...(interval !== undefined ? { autoMemoryInterval: interval } : {}) } : s
    )
    set({ sessions })
  },

  triggerMemorySummary: async () => {
    const state = get()
    const { currentGroup, currentSessionId, messages } = state
    if (!currentGroup || !currentSessionId) return

    const settingsStore = useSettingsStore.getState()
    const profile = settingsStore.getActiveProfile()
    if (!profile) return

    const charStore = useCharacterStore.getState()
    const members = currentGroup.memberIds
      .map(id => charStore.characters.find(c => c.id === id))
      .filter(Boolean) as Character[]
    const memberNames = members.map(m => m.name).join('、')

    // 取最近消息（最多 20 条）
    const recent = messages.slice(-20)
    if (recent.length < 4) return

    const currentSession = state.sessions.find(s => s.id === currentSessionId)
    const prevMemory = currentSession?.memory || ''

    const systemPrompt = `你是一个对话摘要助手。请根据以下群聊「${currentGroup.name}」的最近对话（成员：${memberNames}），更新对话历史摘要。

要求：
1. 保留之前摘要中仍然重要的信息
2. 总结新增的主要事件、情节进展、角色间关系变化
3. 记录未解决的冲突或悬念
4. 使用简洁的中文，200字以内
${prevMemory ? '【之前的摘要】\n' + prevMemory : ''}`

    const conversationText = recent.map(m => {
      const char = members.find(c => c.id === m.characterId)
      const speaker = m.characterId === '__user__'
        ? (settingsStore.settings.userName || '用户')
        : (char?.name || '未知')
      return `${speaker}: ${m.content}`
    }).join('\n')

    try {
      const requestId = `group-memory-${Date.now()}`
      let result = ''

      const unbindChunk = window.api.ai.onChunk((data) => {
        if (data.requestId !== requestId) return
        result += data.text
      })

      const unbindDone = window.api.ai.onDone((doneId) => {
        if (doneId !== requestId) return
        unbindChunk(); unbindDone(); unbindError()
        const summary = (result || '').replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
        if (summary) {
          window.api.group.updateMemory(currentGroup.id, currentSessionId, summary)
          const sessions = get().sessions.map(s =>
            s.id === currentSessionId ? { ...s, memory: summary, memoryUpdatedAt: Date.now() } : s
          )
          set({ sessions })
        }
      })

      const unbindError = window.api.ai.onError(() => {
        unbindChunk(); unbindDone(); unbindError()
      })

      await window.api.ai.chat({
        requestId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: conversationText },
        ],
        provider: profile.provider,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model: profile.model,
        temperature: 0.3,
        topP: 1,
        maxTokens: 512,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: false,
      })
    } catch {
      // 摘要失败静默处理，不影响主流程
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
        // 自动记忆检查
        checkAutoMemory(get)
      })
    } else {
      // free 模式：AI 一次返回多角色回复
      await streamGroupAIFree(set, get, currentGroup, currentSessionId, userMsg.round)
      // 自动记忆检查
      checkAutoMemory(get)
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
      checkAutoMemory(get)
    })
  },

  stopStreaming: () => {
    const requestId = activeStream?.requestId ?? ''
    cleanupActiveStream()
    clearPollingTimer()
    if (requestId) {
      window.api.ai.cancelChat(requestId).catch(() => {})
    }
    set({ isStreaming: false, currentStreamingCharId: null, streamingContent: '' })
  },

  // ---- 群聊上下文构建 ----

  buildGroupContext: (targetCharId?) => {
    const state = get()
    const group = state.currentGroup
    if (!group) return []

    const charStore = useCharacterStore.getState()
    const settingsStore = useSettingsStore.getState()
    const settings = settingsStore.settings
    const userName = settings.userName || '用户'
    const members = group.memberIds
      .map(id => charStore.characters.find(c => c.id === id))
      .filter(Boolean) as Character[]

    // 变量替换用的 charName（mention/polling 为目标角色名，free 为空）
    const targetChar = targetCharId ? members.find(m => m.id === targetCharId) : undefined
    const charNameForVars = targetChar?.name || ''

    let systemContent = ''

    // 群聊 Overview
    systemContent += `你正在参与一个群聊「${group.name}」。本群聊中共有 ${members.length} 个角色参与对话：\n`
    members.forEach((m, i) => {
      const desc = m.description ? ' - ' + m.description.slice(0, 80) : ''
      systemContent += `${i + 1}. 【${m.name}】${desc}\n`
    })
    systemContent += `\n用户「${userName}」也在群聊中。\n`

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

    // 长期记忆注入（对话历史摘要）
    const { sessions, currentSessionId } = get()
    const currentSession = sessions.find(s => s.id === currentSessionId)
    if (currentSession?.memoryEnabled && currentSession.memory) {
      systemContent += '\n\n【群聊历史摘要】\n' + currentSession.memory
    }

    // 群聊自定义 systemPrompt（含变量替换）
    if (group.systemPrompt) {
      systemContent += '\n' + replaceVariables(group.systemPrompt, userName, charNameForVars) + '\n'
    }

    // ===== 世界书注入（递归扫描 + 正则 + 变量替换）=====
    let lorebookBefore = ''
    let lorebookAfter = ''
    let lorebookAtEnd = ''

    if (group.lorebookIds.length > 0) {
      // 可配置扫描深度
      const scanDepth = group.lorebookIds
        .map(id => lorebookCache.get(id)?.scanDepth)
        .filter((d): d is number => typeof d === 'number' && d > 0)
        .reduce((max, d) => Math.max(max, d), 10)

      let recentText = state.messages.slice(-scanDepth).map(m => m.content).join(' ')

      // 收集所有世界书条目
      const allEntries: { entry: any; lbId: string }[] = []
      for (const lbId of group.lorebookIds) {
        const lb = lorebookCache.get(lbId)
        if (!lb?.enabled) continue
        for (const entry of lb.entries) {
          if (entry.enabled) {
            allEntries.push({ entry, lbId })
          }
        }
      }

      const triggeredIds = new Set<string>()
      const beforeEntries: { content: string; order: number }[] = []
      const afterEntries: { content: string; order: number }[] = []
      const atEndEntries: { content: string; order: number }[] = []
      const MAX_RECURSIVE_DEPTH = 5

      // 预编译正则缓存 + 预分组 plain/regex 条目
      const regexCache = new Map<string, RegExp>()
      const plainKeywordEntries: typeof allEntries = []
      const regexEntries: typeof allEntries = []
      for (const item of allEntries) {
        if (item.entry.useRegex) {
          regexEntries.push(item)
        } else {
          plainKeywordEntries.push(item)
        }
      }

      for (let depth = 0; depth < MAX_RECURSIVE_DEPTH; depth++) {
        let newTriggered = false

        // 普通关键词
        const recentTextLower = recentText.toLowerCase()
        for (const { entry, lbId } of plainKeywordEntries) {
          if (!Array.isArray(entry.keywords)) continue
          const entryId = `${lbId}:${entry.id || entry.keywords.join(',')}`
          if (triggeredIds.has(entryId)) continue

          const matched = entry.keywords.some((k: string) => {
            if (!k) return false
            return recentTextLower.includes(k.toLowerCase())
          })
          if (!matched) continue

          if (entry.probability < 100 && Math.random() * 100 >= entry.probability) continue

          triggeredIds.add(entryId)
          newTriggered = true

          const entryContent = replaceVariables(entry.content, userName, charNameForVars)
          const item = { content: entryContent, order: entry.order }

          if (entry.position === 'before_char') beforeEntries.push(item)
          else if (entry.position === 'after_char') afterEntries.push(item)
          else atEndEntries.push(item)

          recentText += ' ' + entryContent
        }

        // 正则关键词
        for (const { entry, lbId } of regexEntries) {
          if (!Array.isArray(entry.keywords)) continue
          const entryId = `${lbId}:${entry.id || entry.keywords.join(',')}`
          if (triggeredIds.has(entryId)) continue

          const matched = entry.keywords.some((k: string) => {
            if (!k) return false
            const cacheKey = `${k}|${entry.regexFlags || 'i'}`
            let regex = regexCache.get(cacheKey)
            if (!regex) {
              try {
                regex = new RegExp(k, entry.regexFlags || 'i')
                regexCache.set(cacheKey, regex)
              } catch {
                return false
              }
            }
            return regex.test(recentText)
          })
          if (!matched) continue

          if (entry.probability < 100 && Math.random() * 100 >= entry.probability) continue

          triggeredIds.add(entryId)
          newTriggered = true

          const entryContent = replaceVariables(entry.content, userName, charNameForVars)
          const item = { content: entryContent, order: entry.order }

          if (entry.position === 'before_char') beforeEntries.push(item)
          else if (entry.position === 'after_char') afterEntries.push(item)
          else atEndEntries.push(item)

          recentText += ' ' + entryContent
        }

        if (!newTriggered) break
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
        if (m.description) systemContent += `描述：${replaceVariables(m.description, userName, m.name)}\n`
        if (m.personality) systemContent += `性格：${replaceVariables(m.personality, userName, m.name)}\n`
        if (m.scenario) systemContent += `场景：${replaceVariables(m.scenario, userName, m.name)}\n`
      })
      if (lorebookAfter) systemContent += '\n' + lorebookAfter
    } else if (targetCharId) {
      const target = members.find(m => m.id === targetCharId)
      if (target) {
        systemContent += `\n\n${lorebookBefore}【当前发言角色：${target.name}】\n`
        if (target.description) systemContent += `描述：${replaceVariables(target.description, userName, target.name)}\n`
        if (target.personality) systemContent += `性格：${replaceVariables(target.personality, userName, target.name)}\n`
        if (target.scenario) systemContent += `场景：${replaceVariables(target.scenario, userName, target.name)}\n`
        if (target.systemPrompt) systemContent += `\n${replaceVariables(target.systemPrompt, userName, target.name)}\n`
        if (lorebookAfter) systemContent += '\n' + lorebookAfter
      }
    }

    // 用户人设
    systemContent += '\n【用户人设】\n'
    systemContent += `用户名：${userName}\n`
    if (settings.userDescription) systemContent += `描述：${replaceVariables(settings.userDescription, userName, charNameForVars)}\n`
    if (settings.userPersona) systemContent += `性格：${replaceVariables(settings.userPersona, userName, charNameForVars)}\n`

    // 世界书 at_end 条目
    if (lorebookAtEnd) {
      systemContent += lorebookAtEnd
    }

    // ===== 历史消息（Token 预算裁剪）=====
    const profile = settingsStore.getActiveProfile()
    const model = profile?.model || settings.activeModel || 'gpt-4o-mini'
    const maxContext = profile?.maxContext || getDefaultMaxContext(model)

    let usedTokens = estimateTokens(systemContent, model)
    const recentMessages: typeof state.messages = []
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const msg = state.messages[i]
      const tokenCount = estimateTokens(msg.content || '', model)
        + (msg.images?.length ? msg.images.length * 200 : 0)
      if (usedTokens + tokenCount > maxContext) break
      recentMessages.unshift(msg)
      usedTokens += tokenCount
    }

    const context: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemContent },
    ]

    const historyContext: { role: 'system' | 'user' | 'assistant'; content: string }[] = []
    recentMessages.forEach(m => {
      const char = members.find(c => c.id === m.characterId)
      const speaker = m.characterId === '__user__'
        ? userName
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

    // Instruct 模板：appendAssistantPrefix 时追加空 assistant 消息
    const instructTemplate = profile?.useInstructTemplate
      ? getInstructTemplate(profile.provider, model)
      : undefined
    if (instructTemplate?.appendAssistantPrefix && charNameForVars) {
      historyContext.push({ role: 'assistant', content: '' })
    }

    // 后处理：合并连续消息 + 按 provider 格式转换
    let processedContext = mergeConsecutiveMessages([...context, ...historyContext])
    const provider = profile?.provider || 'openai'
    processedContext = convertMessages(provider, processedContext, {
      charName: charNameForVars || '角色',
      userName,
    })

    return processedContext
  },
}))

// ====================== 流式处理 ======================

async function flushStream(set: any) {
  if (!activeStream) return
  const { msgId, accumulated } = activeStream
  activeStream.flushTimer = null
  set((s: any) => ({
    messages: s.messages.map((m: GroupMessage) =>
      m.id === msgId ? { ...m, content: accumulated } : m,
    ),
    streamingContent: accumulated,
  }))
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
    // C-02 修复：先保存 accumulated 再 cleanup，否则 activeStream 已被置 null
    const accumulated = activeStream?.accumulated ?? ''
    cleanupActiveStream()

    const friendlyMsg = friendlyError(data.error)
    const errContent = accumulated
      ? accumulated + '\n\n⚠️ ' + friendlyMsg
      : '⚠️ ' + friendlyMsg

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
    const instructTemplate = profile.useInstructTemplate
      ? getInstructTemplate(profile.provider, profile.model)
      : undefined
    await window.api.ai.chat({
      requestId,
      messages: context,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
      temperature: preset?.temperature ?? 0.8,
      topP: preset?.topP ?? 0.95,
      maxTokens: preset?.maxTokens ?? 1024,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: true,
      instructTemplate,
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
    clearPollingTimer()
    cleanupActiveStream()
    const friendlyMsg = friendlyError(data.error)
    set((s: any) => ({
      messages: s.messages.map((m: GroupMessage) => m.id === msgId ? { ...m, content: '⚠️ ' + friendlyMsg } : m),
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
    const instructTemplate = profile.useInstructTemplate
      ? getInstructTemplate(profile.provider, profile.model)
      : undefined
    await window.api.ai.chat({
      requestId,
      messages: context,
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
      temperature: preset?.temperature ?? 0.8,
      topP: preset?.topP ?? 0.95,
      maxTokens: preset?.maxTokens ?? 1024,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: true,
      instructTemplate,
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
    // 没有匹配到任何角色标记 → 将占位消息改为第一个成员的消息，避免渲染为不可见
    const fallbackChar = members[0]
    const fallbackCharId = fallbackChar?.id || '__free__'
    set((s: any) => ({
      messages: s.messages.map((m: GroupMessage) =>
        m.id === placeholderId
          ? { ...m, characterId: fallbackCharId, content: content || '(无回复)' }
          : m,
      ),
      isStreaming: false, currentStreamingCharId: null, streamingContent: '',
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
      }).catch(() => {})
    }
    return
  }

  // 移除占位消息，替换为拆分的角色消息
  const newMessages: GroupMessage[] = []
  const savePromises: Promise<void>[] = []
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
          savePromises.push(window.api.group.saveMessage(group.id, sessionId, gm))
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
    savePromises.push(window.api.group.saveMessage(group.id, sessionId, gm))
  }

  // 并行持久化
  await Promise.all(savePromises)

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

/** 检查是否需要自动触发记忆摘要 */
function checkAutoMemory(get: any) {
  const state = get()
  const session = state.sessions?.find((s: GroupSession) => s.id === state.currentSessionId)
  if (!session?.memoryEnabled || session.memoryMode !== 'auto') return
  const interval = session.autoMemoryInterval || 10
  // 统计自上次摘要以来的新消息数
  const lastUpdate = session.memoryUpdatedAt || 0
  const newMsgs = state.messages.filter((m: GroupMessage) => m.timestamp > lastUpdate)
  if (newMsgs.length >= interval) {
    state.triggerMemorySummary()
  }
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

  // 更新 currentSpeakerIndex 并持久化
  const updatedGroup = { ...group, currentSpeakerIndex: nextIdx }
  set({ currentGroup: updatedGroup })
  window.api.group.save(updatedGroup).catch(() => {})

  // H-02 修复：保存定时器 handle，以便切换/删除群聊时清理
  clearPollingTimer()
  pollingTimer = setTimeout(() => {
    const currentState = get()
    if (currentState.isStreaming) return
    currentState.sendPollingRound(nextCharId)
  }, (group.speakerInterval || 2000))
}

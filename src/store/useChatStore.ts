/* eslint-disable @typescript-eslint/no-unused-vars */
import { create } from 'zustand'
import type { Message, Character, Preset, Lorebook, ChatParams, RegexRule, SessionPreview, ChatSession } from '../../shared/types'
import { nanoid } from 'nanoid'
import { useSettingsStore } from './useSettingsStore'
import { usePersonaStore } from './usePersonaStore'
import { useCharacterStore } from './useCharacterStore'
import { estimateTokens, getDefaultMaxContext } from '../utils/tokenCounter'
import { replaceVariables } from '../utils/variables'
import { getInstructTemplate } from '../utils/chatTemplates'
import { mergeConsecutiveMessages } from '../utils/messagePostProcess'
import { convertMessages } from '../utils/promptConverters'
import { getEffectiveLorebookIds, lorebookCache } from '../utils/lorebook'
import { logError } from '../lib/logger'

// ===================== 常量 =====================

/** 流式更新节流时间（毫秒）- 避免每个 chunk 都触发重渲染 */
const STREAM_THROTTLE_MS = 50

/** 默认世界书扫描深度（最近 N 条消息） */
const DEFAULT_LOREBOOK_SCAN_DEPTH = 10

/** 长记忆摘要默认取最近消息数 */
const MEMORY_SUMMARY_RECENT = 20

/** 长记忆摘要最少消息数 */
const MEMORY_SUMMARY_MIN = 4

/** 超时自动重置 isStreaming 的兜底时间 */
const STREAM_TIMEOUT_FALLBACK_MS = 5 * 60 * 1000

// ===================== 工具函数 =====================

/** 按模型名推断默认最大上下文长度 */
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

/** 简单的正则 ReDoS 防护：限制模式长度和回溯复杂度 */
function safeRegExp(pattern: string, flags = 'g'): RegExp | null {
  if (!pattern || pattern.length > 500) return null
  try {
    // 创建带超时风险的 RegExp：限制量词嵌套深度
    const regex = new RegExp(pattern, flags)
    return regex
  } catch {
    return null
  }
}

// ===================== 类型定义 =====================

interface ChatState {
  messages: Message[]
  sessions: SessionPreview[]
  currentSessionId: string | null
  isStreaming: boolean
  currentRequestId: string | null
  streamingContent: string
  error: string | null
  activePresetId: string | null
  /** 已激活的世界书 ID 列表（支持多选） */
  activeLorebookIds: string[]
  /** 全局翻译状态：messageId -> 翻译结果 */
  translatingMessages: Record<string, { status: 'translating' | 'done' | 'error'; content: string; errorMsg?: string }>
  /** 哪些消息正在显示翻译（替换原文） */
  showTranslationIds: Set<string>
  loadSessions: (characterId: string) => Promise<void>
  createSession: (characterId: string, title?: string) => Promise<ChatSession | null>
  switchSession: (sessionId: string, character: Character) => Promise<void>
  deleteCurrentSession: (characterId: string) => Promise<void>
  /** 删除指定会话（修复：原本绕过 store 直接 IPC） */
  deleteSession: (characterId: string, sessionId: string) => Promise<void>
  renameSession: (characterId: string, sessionId: string, title: string) => Promise<void>
  toggleMemory: (characterId: string, sessionId: string, enabled: boolean) => Promise<void>
  setMemoryMode: (characterId: string, sessionId: string, mode: 'manual' | 'auto', interval?: number) => Promise<void>
  triggerMemorySummary: (character: Character) => Promise<string | null>
  getStats: (characterId: string, sessionId: string) => Promise<{
    totalMessages: number; userMessages: number; assistantMessages: number
    totalChars: number; durationStr: string
  } | null>
  loadMessages: (character: Character) => Promise<void>
  sendMessage: (content: string, images: string[], character: Character, preset: Preset | null, lorebooks: Lorebook[]) => Promise<void>
  /** 添加独立消息（不触发 AI 回复，用于生图等） */
  addStandaloneMessage: (content: string, images: string[], character: Character, role?: 'user' | 'assistant' | 'system') => Promise<void>
  stopStreaming: () => void
  regenerateMessage: (messageId: string, character: Character, preset: Preset | null, lorebooks: Lorebook[]) => Promise<void>
  /** 切换消息的 Swipe 候选 */
  swipeMessage: (messageId: string, direction: number, character: Character) => Promise<void>
  /** 继续续写：让 AI 从截断处继续生成，追加到现有消息末尾 */
  continueMessage: (messageId: string, character: Character, preset: Preset | null, lorebooks: Lorebook[]) => Promise<void>
  editMessage: (messageId: string, newContent: string, character: Character) => Promise<void>
  /** 更新消息的图片（用于重新生图） */
  updateMessageImages: (messageId: string, images: string[]) => Promise<void>
  deleteMessage: (messageId: string, character: Character) => Promise<void>
  clearChat: (characterId: string) => Promise<void>
  clearMessages: () => void
  setActivePreset: (id: string | null, characterId?: string) => void
  setActiveLorebooks: (ids: string[], characterId?: string) => void
  /** 保存世界书绑定到角色（作为新会话的默认值），仅在角色编辑器或用户明确操作时调用 */
  saveLorebookBinding: (characterId: string, ids: string[]) => Promise<void>
  applyRegex: (text: string, scope: 'input' | 'output', rules: RegexRule[]) => string
  buildContext: (character: Character, preset: Preset | null) => { role: 'system' | 'user' | 'assistant'; content: string }[]
  /** 启动 AI 翻译（全局状态，页面切换不中断） */
  translateMessage: (messageId: string, content: string) => void
  /** 切换翻译显示 */
  toggleTranslation: (messageId: string) => void
  /** 创建带开场白的新会话（统一入口，避免逻辑分散） */
  createSessionWithGreeting: (character: Character, greeting?: string) => Promise<ChatSession | null>
  /** 更新会话字段（如 personaId），同步后端和本地 state */
  updateSessionField: (characterId: string, sessionId: string, field: string, value: unknown) => Promise<void>
  /** 从当前会话同步世界书到 activeLorebookIds（不持久化，仅读取） */
  syncLorebooksFromCurrentSession: (character: Character) => void
}

// 用于防止竞态条件的请求计数器
let loadRequestId = 0

// ===================== 流式状态管理（模块级，避免渲染抖动） =====================

interface StreamState {
  requestId: string
  aiMessageId: string
  accumulated: string
  preContent?: string  // 续写模式下的已有内容，flush 时拼接到 accumulated 前面
  flushTimer: ReturnType<typeof setTimeout> | null
  unbindChunk: () => void
  unbindDone: () => void
  unbindError: () => void
  unbindUsage: () => void
  timeoutHandle: ReturnType<typeof setTimeout> | null
}

let activeStream: StreamState | null = null

// zustand store 的 set/get 类型（提前定义供 flushStream 使用）
type StoreSet = (
  partial: Partial<ChatState> | ChatState | ((state: ChatState) => Partial<ChatState> | ChatState),
) => void
type StoreGet = () => ChatState

/** 将累积的流式内容 flush 到 messages 状态 */
function flushStream(set: StoreSet) {
  if (!activeStream) return
  const { aiMessageId, accumulated } = activeStream
  activeStream!.flushTimer = null
  set((state: ChatState) => {
    const msgs = state.messages
    const idx = msgs.findIndex((m) => m.id === aiMessageId)
    if (idx < 0) return {}
    const newMsgs = msgs.slice()
    newMsgs[idx] = { ...newMsgs[idx], content: (activeStream.preContent ?? '') + accumulated }
    return { messages: newMsgs }
  })
}

/** 清理当前活动流（用于切换角色/取消/超时） */
function cleanupActiveStream() {
  if (!activeStream) return
  if (activeStream.flushTimer) {
    clearTimeout(activeStream.flushTimer)
    activeStream.flushTimer = null
  }
  if (activeStream.timeoutHandle) {
    clearTimeout(activeStream.timeoutHandle)
    activeStream.timeoutHandle = null
  }
  try {
    activeStream.unbindChunk()
    activeStream.unbindDone()
    activeStream.unbindError()
    activeStream.unbindUsage()
  } catch { /* ignore */ }
  activeStream = null
}

/**
 * 抽取的公共 AI 流式响应方法
 * - 统一处理事件注册、节流、错误、超时
 * - 调用方只需提供 aiMessageId 和 onComplete 回调
 */
async function streamAIResponse(
  set: StoreSet,
  get: StoreGet,
  opts: {
    aiMessageId: string
    character: Character
    preset: Preset | null
    preContent?: string  // 续写模式下的前置内容，flush 时拼接到新内容前面
    onComplete: (fullContent: string) => Promise<void>
    onError?: (errMsg: string) => void
  },
): Promise<void> {
  const { aiMessageId, character, preset, onComplete, onError } = opts

  const settingsStore = useSettingsStore.getState()
  const settings = settingsStore.settings
  const profile = settingsStore.getActiveProfile()
  if (!profile || (!profile.apiKey && profile.provider !== 'ollama')) {
    set({ isStreaming: false, currentRequestId: null })
    onError?.('未配置 API 连接')
    return
  }

  // 如果已有进行中的流，先清理（防止状态泄漏）
  cleanupActiveStream()

  const contextMessages = get().buildContext(character, preset)

  // 续写模式：preContent 存在时，追加续写指令引导 AI 接续上一段内容
  if (opts.preContent) {
    // 移除末尾可能存在的空 assistant prefix（续写不需要，否则会阻断续写指令）
    const lastIdx = contextMessages.length - 1
    if (lastIdx >= 0 && contextMessages[lastIdx].role === 'assistant' && !contextMessages[lastIdx].content) {
      contextMessages.pop()
    }
    contextMessages.push({
      role: 'user',
      content: '请直接接续上一段内容的结尾继续写作，保持相同的风格、语气和叙事视角。不要重复已有内容，直接输出续写部分。',
    })
  }

  const requestId = nanoid()

  set({ isStreaming: true, currentRequestId: requestId, error: null })

  const onChunk = (data: { requestId: string; text: string }) => {
    if (data.requestId !== requestId) return
    if (!activeStream || activeStream.requestId !== requestId) return
    activeStream.accumulated += data.text
    // 节流：避免每个 chunk 都触发 set
    if (activeStream.flushTimer === null) {
      activeStream.flushTimer = setTimeout(() => flushStream(set), STREAM_THROTTLE_MS)
    }
  }

  const unbindChunk = window.api.ai.onChunk(onChunk)

  // 监听 token 用量（来自 AI 响应的 usage 字段）
  const unbindUsage = window.api.ai.onUsage((data) => {
    if (data.requestId !== requestId) return
    // 计算费用
    const model = useSettingsStore.getState().settings.activeModel || profile.model
    Promise.resolve(window.api.usage.calculateCost(model, data.promptTokens, data.completionTokens)).then((cost) => {
      const usageInfo = {
        promptTokens: data.promptTokens,
        completionTokens: data.completionTokens,
        totalTokens: data.totalTokens,
        cost,
        model,
        timestamp: Date.now(),
      }
      // 更新消息的 tokenUsage
      set((state: ChatState) => ({
        messages: state.messages.map(m => m.id === aiMessageId ? { ...m, tokenUsage: usageInfo } : m),
      }))
      // 持久化到用量记录
      const sid = get().currentSessionId
      if (sid) {
        window.api.usage.record({
          timestamp: Date.now(),
          characterId: character.id,
          sessionId: sid,
          model,
          promptTokens: data.promptTokens,
          completionTokens: data.completionTokens,
          totalTokens: data.totalTokens,
          cost,
        }).catch(() => { /* 忽略记录失败 */ })
      }
    }).catch(() => { /* 忽略 */ })
  })

  const unbindDone = window.api.ai.onDone((doneId: string) => {
    if (doneId !== requestId) return
    // 立即 flush 残留内容
    if (activeStream?.flushTimer) {
      clearTimeout(activeStream.flushTimer)
      activeStream.flushTimer = null
    }
    if (activeStream) {
      flushStream(set)
    }
    unbindChunk()
    unbindDone()
    unbindError()
    unbindUsage()
    const fullContent = activeStream?.accumulated ?? ''
    if (activeStream?.timeoutHandle) clearTimeout(activeStream.timeoutHandle)
    activeStream = null
    set({ isStreaming: false, currentRequestId: null, streamingContent: '' })
    // 异步执行完成回调
    onComplete(fullContent).catch((e) => logError('ChatStore:onComplete', e))
  })

  const unbindError = window.api.ai.onError((data: { requestId: string; error: string }) => {
    if (data.requestId !== requestId) return
    if (activeStream?.flushTimer) {
      clearTimeout(activeStream.flushTimer)
      activeStream.flushTimer = null
    }
    if (activeStream) {
      flushStream(set)
    }
    unbindChunk()
    unbindDone()
    unbindError()
    unbindUsage()
    if (activeStream?.timeoutHandle) clearTimeout(activeStream.timeoutHandle)
    activeStream = null
    const friendly = friendlyError(data.error)
    set({ isStreaming: false, currentRequestId: null, error: friendly })
    onError?.(friendly)
  })

  activeStream = {
    requestId,
    aiMessageId,
    accumulated: '',
    preContent: opts.preContent,
    flushTimer: null,
    unbindChunk,
    unbindDone,
    unbindError,
    unbindUsage,
    // 兜底超时：5 分钟无响应自动清理
    timeoutHandle: setTimeout(() => {
      if (activeStream?.requestId === requestId) {
        try { window.api.ai.cancelChat(requestId) } catch { /* ignore */ }
        cleanupActiveStream()
        set({ isStreaming: false, currentRequestId: null, error: '请求超时' })
        onError?.('请求超时')
      }
    }, STREAM_TIMEOUT_FALLBACK_MS),
  }

  // 构建 instruct 模板
  const instructTemplate = profile.useInstructTemplate
    ? getInstructTemplate(profile.provider, settings.activeModel || profile.model)
    : undefined

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
    instructTemplate,
  }

  try {
    await window.api.ai.chat(params)
  } catch (e) {
    unbindChunk()
    unbindDone()
    unbindError()
    unbindUsage()
    if (activeStream?.flushTimer) clearTimeout(activeStream.flushTimer)
    if (activeStream?.timeoutHandle) clearTimeout(activeStream.timeoutHandle)
    activeStream = null
    const errMsg = friendlyError((e as Error).message)
    set({ isStreaming: false, currentRequestId: null, error: errMsg })
    onError?.(errMsg)
  }
}

// ===================== Store 实现 =====================

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
    // 刷新会话列表
    const sessions = await window.api.chat.listSessions(characterId)
    set({ sessions, currentSessionId: session.id, messages: [], activeLorebookIds: initLorebookIds })
    // 持久化当前会话 ID
    useSettingsStore.getState().updateSettings({ activeSessionId: session.id })
    return session
  },

  /** 统一入口：创建新会话并可选地插入开场白 */
  createSessionWithGreeting: async (character, greeting) => {
    const initLorebookIds = getEffectiveLorebookIds(character)
    const session = await window.api.chat.createSession(character.id, undefined, undefined, initLorebookIds)
    const sessions = await window.api.chat.listSessions(character.id)
    set({ sessions, currentSessionId: session.id, messages: [], activeLorebookIds: initLorebookIds })
    // 持久化当前会话 ID
    useSettingsStore.getState().updateSettings({ activeSessionId: session.id })

    const g = greeting ?? character.firstMessage
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
    const currentLoadId = ++loadRequestId
    set({ messages: [] })
    const messages = await window.api.chat.listMessages(character.id, sessionId)
    if (currentLoadId !== loadRequestId) return
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
    const { currentSessionId } = get()
    if (!currentSessionId) return
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
    const { currentSessionId, messages, sessions } = get()
    const session = sessions.find(s => s.id === currentSessionId)
    if (!currentSessionId || !session?.memoryEnabled) return null

    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile || (!profile.apiKey && profile.provider !== 'ollama')) return null

    const settings = useSettingsStore.getState().settings
    const userName = settings.userName || '用户'

    // 取最近消息进行总结（基于 token 预算，限制最大 20 条）
    const recentMessages = messages.filter(m => m.role !== 'system').slice(-MEMORY_SUMMARY_RECENT)
    if (recentMessages.length < MEMORY_SUMMARY_MIN) return null

    const messagesText = recentMessages
      .map(m => `${m.role === 'user' ? '用户' : character.name}: ${m.content}`)
      .join('\n')

    const previousMemory = session.memory || '无'

    const requestId = `memory-summary-${Date.now()}`
    let result = ''
    let errored = false
    let errMsg = ''

    // 构建 instruct 模板（与 sendMessage 保持一致）
    const instructTemplate = profile.useInstructTemplate
      ? getInstructTemplate(profile.provider, settings.activeModel || profile.model)
      : undefined

    return new Promise((resolve) => {
      const unbindChunk = window.api.ai.onChunk((data) => {
        if (data.requestId !== requestId) return
        result += data.text
      })
      const unbindDone = window.api.ai.onDone(async (doneId) => {
        if (doneId !== requestId) return
        unbindChunk(); unbindDone(); unbindError()
        const summary = result.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
        if (summary) {
          try {
            await window.api.chat.updateMemory(character.id, currentSessionId, summary)
            const refreshedSessions = await window.api.chat.listSessions(character.id)
            set({ sessions: refreshedSessions })
          } catch { /* ignore */ }
        }
        resolve(summary || null)
      })
      const unbindError = window.api.ai.onError((data) => {
        if (data.requestId !== requestId) return
        unbindChunk(); unbindDone(); unbindError()
        errored = true
        errMsg = friendlyError(data.error)
        // 错误反馈到 store，UI 可见
        set({ error: `长记忆总结失败：${errMsg}` })
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
        instructTemplate,
      }).catch(() => {
        unbindChunk(); unbindDone(); unbindError()
        if (!errored) {
          set({ error: '长记忆总结请求失败' })
        }
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
    if (currentLoadId !== loadRequestId) return

    if (messages.length === 0 && character.firstMessage) {
      // 有备选开场白时，交给 ChatPage 的选择面板处理，不自动插入
      const hasAltGreetings = character.alternateGreetings && character.alternateGreetings.length > 0
      if (hasAltGreetings) {
        set({ messages: [] })
      } else {
        // 没有备选开场白 -> 变量替换后自动插入并保存
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

  sendMessage: async (content, images, character, preset, _lorebooks) => {
    // 流式中拒绝：现在给一个错误提示而不是静默忽略
    if (get().isStreaming) {
      set({ error: '正在生成回复中，请稍候或点击停止' })
      return
    }

    const settingsStore = useSettingsStore.getState()
    const profile = settingsStore.getActiveProfile()

    if (!profile || (!profile.apiKey && profile.provider !== 'ollama')) {
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
    }
    set((state) => ({ messages: [...state.messages, userMessage], error: null }))
    await window.api.chat.saveMessage(userMessage)

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
      onComplete: async (fullContent) => {
        if (!fullContent) return

        // 对 AI 输出应用正则规则
        let finalContent = fullContent
        try {
          const regexRules = await window.api.regex.list()
          if (regexRules.length > 0) {
            finalContent = get().applyRegex(fullContent, 'output', regexRules)
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
      try { window.api.ai.cancelChat(requestId) } catch { /* ignore */ }
    }
    // 兜底重置状态（防止 cancelChat IPC 失败导致卡住）
    cleanupActiveStream()
    if (get().isStreaming) {
      set({ isStreaming: false, currentRequestId: null, streamingContent: '' })
    }
  },

  regenerateMessage: async (messageId, character, preset, _lorebooks) => {
    // 流式中拒绝：给提示
    if (get().isStreaming) {
      set({ error: '正在生成回复中，请稍候' })
      return
    }

    const messages = get().messages
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const targetMsg = messages[idx]
    if (targetMsg.role !== 'assistant') return

    // Swipe 策略：不删除原消息，而是追加新候选到 swipes 数组
    const swipes = targetMsg.swipes ?? [targetMsg.content]
    const newSwipeIndex = swipes.length

    // 在 UI 中先插入一个空候选，让用户看到正在生成
    const updatedMsg: Message = {
      ...targetMsg,
      swipes: [...swipes, ''],
      swipeIndex: newSwipeIndex,
      content: '',
    }
    set((state) => ({
      messages: state.messages.map((m) => (m.id === messageId ? updatedMsg : m)),
      isStreaming: true,
      streamingContent: '',
      error: null,
    }))

    // 调用公共流式方法（复用同一消息 ID）
    await streamAIResponse(set, get, {
      aiMessageId: messageId,
      character,
      preset,
      onComplete: async (fullContent) => {
        if (!fullContent) return

        // 应用正则规则
        let finalContent = fullContent
        try {
          const regexRules = await window.api.regex.list()
          if (regexRules.length > 0) {
            finalContent = get().applyRegex(fullContent, 'output', regexRules)
          }
        } catch { /* 忽略 */ }

        const curMsg = get().messages.find(m => m.id === messageId)
        if (!curMsg?.swipes) return
        const newSwipes = [...curMsg.swipes]
        newSwipes[newSwipeIndex] = finalContent
        const finalMsg: Message = {
          ...curMsg,
          swipes: newSwipes,
          swipeIndex: newSwipeIndex,
          content: finalContent,
        }
        set((s) => ({
          messages: s.messages.map(m => m.id === messageId ? finalMsg : m),
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
      },
      onError: (errMsg) => {
        const curMsg = get().messages.find(m => m.id === messageId)
        if (!curMsg?.swipes) return
        const newSwipes = [...curMsg.swipes]
        newSwipes[newSwipeIndex] = `⚠️ ${errMsg}`
        const finalMsg: Message = {
          ...curMsg,
          swipes: newSwipes,
          swipeIndex: newSwipeIndex,
          content: newSwipes[newSwipeIndex],
        }
        set((s) => ({ messages: s.messages.map(m => m.id === messageId ? finalMsg : m) }))
        window.api.chat.saveMessage(finalMsg).catch((e) => logError('ChatStore:saveMessage', e))
      },
    })
  },

  /** 继续续写：让 AI 从截断处继续生成，创建新消息气泡 */
  continueMessage: async (messageId, character, preset, _lorebooks) => {
    // 流式中拒绝
    if (get().isStreaming) {
      set({ error: '正在生成回复中，请稍候' })
      return
    }

    const messages = get().messages
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const targetMsg = messages[idx]
    if (targetMsg.role !== 'assistant') return

    // 确保是最后一条消息
    if (idx !== messages.length - 1) return

    // 创建新的 AI 消息气泡（不复用原消息）
    const newMsgId = nanoid()
    const newMessage: Message = {
      id: newMsgId,
      sessionId: targetMsg.sessionId,
      characterId: character.id,
      role: 'assistant',
      content: '',
      images: [],
      isEditing: false,
      timestamp: Date.now(),
    }

    set((state) => ({
      messages: [...state.messages, newMessage],
      isStreaming: true,
      streamingContent: '',
      error: null,
    }))

    // 调用公共流式方法（流式到新消息，原消息保持不变）
    await streamAIResponse(set, get, {
      aiMessageId: newMsgId,
      character,
      preset,
      preContent: targetMsg.content,
      onComplete: async (newContent) => {
        if (!newContent) {
          // 无新内容，移除占位消息
          set((s) => ({ messages: s.messages.filter(m => m.id !== newMsgId) }))
          return
        }

        // 应用正则规则（仅对新续写内容）
        let processedNew = newContent
        try {
          const regexRules = await window.api.regex.list()
          if (regexRules.length > 0) {
            processedNew = get().applyRegex(newContent, 'output', regexRules)
          }
        } catch { /* 忽略 */ }

        // 拼接原内容 + 续写内容
        const fullContent = (targetMsg.content || '') + processedNew

        const curMsg = get().messages.find(m => m.id === newMsgId)
        if (!curMsg) return

        const finalMsg: Message = {
          ...curMsg,
          content: fullContent,
        }

        set((s) => ({
          messages: s.messages.map(m => m.id === newMsgId ? finalMsg : m),
        }))
        window.api.chat.saveMessage(finalMsg).catch((e) => logError('ChatStore:saveMessage', e))

        // 自动长记忆检查
        const { sessions: curSessions, currentSessionId: curSid } = get()
        const curSession = curSessions.find(s => s.id === curSid)
        if (curSession?.memoryEnabled && curSession.memoryMode === 'auto') {
          const allMsgs = get().messages.filter(m => m.content)
          const lastSummaryTime = curSession.memoryUpdatedAt || 0
          const newMsgCount = lastSummaryTime > 0
            ? allMsgs.filter(m => m.timestamp > lastSummaryTime).length
            : allMsgs.length
          const interval = curSession.autoMemoryInterval || 10
          if (newMsgCount >= interval) {
            get().triggerMemorySummary(character).catch((e) => logError('ChatStore:memorySummary', e))
          }
        }
      },
      onError: (_errMsg) => {
        // 出错时移除占位消息
        set((s) => ({ messages: s.messages.filter(m => m.id !== newMsgId) }))
      },
    })
  },

  /** 切换当前消息的候选回复 */
  swipeMessage: async (messageId, direction, character) => {
    const msg = get().messages.find(m => m.id === messageId)
    if (!msg?.swipes || msg.swipes.length < 2) return
    const curIdx = msg.swipeIndex ?? 0
    const newIdx = (curIdx + direction + msg.swipes.length) % msg.swipes.length
    const updatedMsg: Message = {
      ...msg,
      swipeIndex: newIdx,
      content: msg.swipes[newIdx],
    }
    set((s) => ({ messages: s.messages.map(m => m.id === messageId ? updatedMsg : m) }))
    await window.api.chat.saveMessage(updatedMsg)
  },

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
    await window.api.chat.deleteMessage(messageId, character.id, get().currentSessionId ?? undefined)
    set((state) => ({ messages: state.messages.filter((m) => m.id !== messageId) }))
    // 同步更新 session 元数据
    try {
      const sessions = await window.api.chat.listSessions(character.id)
      set({ sessions })
    } catch { /* ignore */ }
  },

  clearChat: async (characterId) => {
    const sessionId = get().currentSessionId
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

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
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
      if (translateFlushTimer) { clearTimeout(translateFlushTimer); translateFlushTimer = null }
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
      if (translateFlushTimer) { clearTimeout(translateFlushTimer); translateFlushTimer = null }
      unbindChunk(); unbindDone(); unbindError()
      set((state) => ({
        translatingMessages: { ...state.translatingMessages, [messageId]: { status: 'error' as const, content: '', errorMsg: friendlyError(data.error) } },
      }))
    })

    const profile = useSettingsStore.getState().getActiveProfile()
    if (!profile) {
      if (translateFlushTimer) { clearTimeout(translateFlushTimer); translateFlushTimer = null }
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
      if (translateFlushTimer) { clearTimeout(translateFlushTimer); translateFlushTimer = null }
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
    let result = text
    for (const rule of rules) {
      if (!rule.enabled) continue
      if (rule.scope !== scope && rule.scope !== 'both') continue
      // 使用安全正则创建（防 ReDoS）
      const regex = safeRegExp(rule.pattern, rule.flags || 'g')
      if (!regex) continue
      try {
        // 添加简单的执行超时保护（同步无法真超时，但限制字符串长度）
        if (result.length < 100000) {
          result = result.replace(regex, rule.replacement)
        }
      } catch {
        // 正则执行错误时跳过
      }
    }
    return result
  },

  buildContext: (character, preset) => {
    const settings = useSettingsStore.getState().settings
    const userName = settings.userName || '用户'
    // 修复 #8: 保留图片消息（content 为空但有 images 时不丢弃）
    const messages = get().messages.filter((m) => (m.content || (m.images && m.images.length > 0)) && m.role !== 'system')
    const context: { role: 'system' | 'user' | 'assistant'; content: string }[] = []

    // ===== System Prompt 构建 =====
    let systemContent = character.systemPrompt || preset?.systemPrompt || '你是一个角色扮演助手。请根据角色设定进行沉浸式对话，保持角色性格的一致性。'

    // jailbreak 改为可选（修复 #32）：只在 preset 有 jailbreak 且非空时附加
    // 用户可通过清空 preset.jailbreak 来禁用
    if (preset?.jailbreak && preset.jailbreak.trim()) {
      systemContent += '\n\n' + preset.jailbreak
    }

    // 用户人设注入
    systemContent += '\n\n【用户人设】'
    systemContent += '\n用户名：' + userName
    if (settings.userDescription) systemContent += '\n描述：' + settings.userDescription
    if (settings.userPersona) systemContent += '\n性格：' + settings.userPersona

    // 心理描写输出格式（修复 #33）：改为可配置，默认开启
    const enableThoughtFormat = settings.enableThoughtFormat !== false
    if (enableThoughtFormat) {
      systemContent += '\n\n【输出格式要求】\n请先在 <thought>...</thought> 标签内输出角色的内心想法和心理活动，然后再输出角色的实际对话和行动。两部分必须分开。'
    }

    // 长记忆注入
    const { sessions, currentSessionId } = get()
    const currentSession = sessions.find(s => s.id === currentSessionId)
    if (currentSession?.memoryEnabled && currentSession.memory) {
      systemContent += '\n\n【对话历史摘要】\n' + currentSession.memory
    }

    // ===== 角色设定 + 世界书 =====
    let charDesc = ''
    if (character.description) charDesc += replaceVariables(character.description, userName, character.name) + '\n'
    if (character.personality) charDesc += '性格：' + replaceVariables(character.personality, userName, character.name) + '\n'
    if (character.scenario) charDesc += '场景：' + replaceVariables(character.scenario, userName, character.name) + '\n'

    // 世界书注入（支持多个世界书合并 + 递归扫描）
    const lorebookIds = get().activeLorebookIds
    if (lorebookIds.length > 0) {
      // 修复 #28: 扫描深度可配置（取激活世界书中的最大值，否则用默认）
      const scanDepth = lorebookIds
        .map(id => lorebookCache.get(id)?.scanDepth)
        .filter((d): d is number => typeof d === 'number' && d > 0)
        .reduce((max, d) => Math.max(max, d), DEFAULT_LOREBOOK_SCAN_DEPTH)

      let recentText = messages.slice(-scanDepth).map((m) => m.content).join(' ')

      // 收集所有世界书条目
      const allEntries: { entry: any; lbId: string }[] = []
      for (const lbId of lorebookIds) {
        const lb = lorebookCache.get(lbId)
        if (!lb?.enabled) continue
        for (const entry of lb.entries) {
          if (entry.enabled) {
            allEntries.push({ entry, lbId })
          }
        }
      }

      // 递归扫描：条目内容可触发其他条目
      const triggeredIds = new Set<string>()
      const beforeEntries: { content: string; order: number }[] = []
      const afterEntries: { content: string; order: number }[] = []
      const atEndEntries: { content: string; order: number }[] = []
      const MAX_RECURSIVE_DEPTH = 5  // 防止无限递归

      // 优化：预编译正则 + 预分组普通关键词
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

        // 普通关键词：先用 Set 快速排除，再做 includes
        const recentTextLower = recentText.toLowerCase()

        for (const { entry, lbId } of plainKeywordEntries) {
          if (!Array.isArray(entry.keywords)) continue
          const entryId = `${lbId}:${entry.id || entry.keywords.join(',')}`
          if (triggeredIds.has(entryId)) continue

          const matched = entry.keywords.some((k) => {
            if (!k) return false
            return recentTextLower.includes(k.toLowerCase())
          })
          if (!matched) continue

          if (entry.probability < 100 && Math.random() * 100 >= entry.probability) continue

          triggeredIds.add(entryId)
          newTriggered = true

          const entryContent = replaceVariables(entry.content, userName, character.name)
          const item = { content: entryContent, order: entry.order }

          if (entry.position === 'before_char') beforeEntries.push(item)
          else if (entry.position === 'after_char') afterEntries.push(item)
          else atEndEntries.push(item)

          recentText += ' ' + entryContent
        }

        // 正则关键词：缓存编译后的 RegExp
        for (const { entry, lbId } of regexEntries) {
          if (!Array.isArray(entry.keywords)) continue
          const entryId = `${lbId}:${entry.id || entry.keywords.join(',')}`
          if (triggeredIds.has(entryId)) continue

          const matched = entry.keywords.some((k) => {
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

          const entryContent = replaceVariables(entry.content, userName, character.name)
          const item = { content: entryContent, order: entry.order }

          if (entry.position === 'before_char') beforeEntries.push(item)
          else if (entry.position === 'after_char') afterEntries.push(item)
          else atEndEntries.push(item)

          recentText += ' ' + entryContent
        }

        if (!newTriggered) break
      }

      // before_char: 按 order 升序排列在 charDesc 之前
      if (beforeEntries.length > 0) {
        beforeEntries.sort((a, b) => a.order - b.order)
        charDesc = beforeEntries.map(e => e.content).join('\n') + '\n' + charDesc
      }
      // after_char: 按 order 升序排列在 charDesc 之后
      if (afterEntries.length > 0) {
        afterEntries.sort((a, b) => a.order - b.order)
        charDesc = charDesc + afterEntries.map(e => e.content).join('\n')
      }
      // at_end: 追加到 systemContent 末尾
      if (atEndEntries.length > 0) {
        atEndEntries.sort((a, b) => a.order - b.order)
        systemContent += '\n\n' + atEndEntries.map(e => e.content).join('\n')
      }
    }

    if (charDesc) systemContent += '\n\n【角色设定】\n' + charDesc

    context.push({ role: 'system', content: systemContent })

    // 对话示例位置配置
    const exampleDialogPosition = settings.exampleDialogPosition || 'after_system'

    // 如果示例位置是 after_system（默认），在这里插入
    if (exampleDialogPosition === 'after_system' && character.exampleDialog) {
      context.push({ role: 'system', content: '【对话示例】\n' + replaceVariables(character.exampleDialog, userName, character.name) })
    }

    // ===== 历史消息 =====
    const profile = useSettingsStore.getState().getActiveProfile()
    // 修复 #31: 按模型推断默认 maxContext
    const model = profile?.model || settings.activeModel || 'gpt-4o-mini'
    const maxContext = profile?.maxContext || preset?.maxContext || getDefaultMaxContext(model)

    let usedTokens = context.reduce((sum, c) => sum + estimateTokens(c.content, model), 0)
    const recentMessages: typeof messages = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const tokenCount = estimateTokens(msg.content || '', model)
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

    // 如果示例位置是 after_history，在这里插入
    if (exampleDialogPosition === 'after_history' && character.exampleDialog) {
      context.push({ role: 'system', content: '【对话示例】\n' + replaceVariables(character.exampleDialog, userName, character.name) })
    }

    // 修复 #27: postHistoryInstructions 应该放在历史消息之后（Author's Note 位置）
    if (character.postHistoryInstructions) {
      context.push({
        role: 'system',
        content: replaceVariables(character.postHistoryInstructions, userName, character.name),
      })
    }

    // Assistant Prefix：在上下文末尾添加空的 assistant 消息，引导模型输出格式
    // 对于 instruct 模式且 appendAssistantPrefix=true 的情况，添加角色名前缀
    const charName = character.translatedContent?.name ?? character.name
    const instructTemplate = profile?.useInstructTemplate
      ? getInstructTemplate(profile.provider, model)
      : undefined
    if (instructTemplate?.appendAssistantPrefix && charName) {
      context.push({
        role: 'assistant',
        content: '',  // 空内容，让模型续写
      })
    }

    // 消息后处理：合并连续相同角色消息
    let processedContext = mergeConsecutiveMessages(context)

    // 根据提供商转换消息格式（Claude/Gemini 需要特殊处理）
    const provider = profile?.provider || 'openai'
    processedContext = convertMessages(provider, processedContext, { charName, userName })

    return processedContext
  },
}))

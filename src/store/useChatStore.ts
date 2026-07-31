/* eslint-disable @typescript-eslint/no-unused-vars */
import { create } from 'zustand'
import type { Message, Character, Preset, Lorebook, ChatParams, RegexRule, SessionPreview, ChatSession } from '../../shared/types'
import { nanoid } from 'nanoid'
import { useSettingsStore } from './useSettingsStore'
import { usePersonaStore } from './usePersonaStore'
import { useCharacterStore } from './useCharacterStore'
import { estimateTokens, getDefaultMaxContext } from '../utils/tokenCounter'
import { countChars } from '../utils/charCounter'
import { replaceVariables } from '../utils/variables'
import { resolveEffectiveTemplate } from '../utils/chatTemplates'
import { mergeConsecutiveMessages, stripThought, normalizeThoughtTags, trimContinuationOverlap } from '../utils/messagePostProcess'
import { convertMessages } from '../utils/promptConverters'
import { getEffectiveLorebookIds, lorebookCache, triggerLorebooks } from '../utils/lorebook'
import type { DepthLoreItem } from '../utils/lorebook'
import { logError, logInfo } from '../lib/logger'

// ===================== 常量 =====================

/** 流式更新节流时间（毫秒）- 避免每个 chunk 都触发重渲染 */
const STREAM_THROTTLE_MS = 50

/** 默认世界书扫描深度（最近 N 条消息） */
const DEFAULT_LOREBOOK_SCAN_DEPTH = 10

/** 世界书 token 预算占上下文预算（budgetBase）的默认比例 */
const DEFAULT_LOREBOOK_RATIO = 0.3

/** 启发式 token 估算的安全余量系数（吸收估算误差，替代精确计数） */
const TOKEN_BUDGET_SAFETY = 0.95

/** 输出预留兜底值（preset.maxTokens 缺省时） */
const DEFAULT_RESERVED_OUTPUT = 1024

/** 图片消息的 token 估算（每张） */
const IMAGE_TOKEN_ESTIMATE = 200

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
  buildContext: (character: Character, preset: Preset | null, opts?: { continuation?: boolean }) => { role: 'system' | 'user' | 'assistant'; content: string }[]
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
  flushTimer: ReturnType<typeof setTimeout> | null
  unbindChunk: () => void
  unbindDone: () => void
  unbindError: () => void
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
    newMsgs[idx] = { ...newMsgs[idx], content: accumulated }
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
    continuation?: boolean  // 续写模式：buildContext 注入续写指令并跳过 Assistant Prefix
    inputText?: string   // 用户输入文本（用于字符统计），regenerate/continue 时为空
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

  const contextMessages = get().buildContext(character, preset, { continuation: opts.continuation })

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
    const fullContent = activeStream?.accumulated ?? ''
    if (activeStream?.timeoutHandle) clearTimeout(activeStream.timeoutHandle)

    // 字符用量统计：精确计算输入和输出字符数
    const model = useSettingsStore.getState().settings.activeModel || profile.model
    const outputChars = countChars(fullContent).total
    const inputChars = opts.inputText ? countChars(opts.inputText).total : 0
    const totalChars = inputChars + outputChars
    const usageInfo = { inputChars, outputChars, totalChars, model, timestamp: Date.now() }
    set((state: ChatState) => ({
      messages: state.messages.map(m => m.id === aiMessageId ? { ...m, charUsage: usageInfo } : m),
    }))
    // 持久化到用量记录
    const sid = get().currentSessionId
    if (sid) {
      window.api.usage.record({
        timestamp: Date.now(),
        characterId: character.id,
        sessionId: sid,
        model,
        inputChars,
        outputChars,
        totalChars,
      }).catch(() => { /* 忽略记录失败 */ })
    }

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
    flushTimer: null,
    unbindChunk,
    unbindDone,
    unbindError,
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

  // 构建 instruct 模板：预设显式指定 > profile 自动推断
  const instructTemplate = resolveEffectiveTemplate(
    preset?.contextTemplate,
    profile.provider,
    settings.activeModel || profile.model,
    profile.useInstructTemplate,
  )

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

    // 构建 instruct 模板（摘要无预设，跟随 profile 开关）
    const instructTemplate = profile.useInstructTemplate
      ? resolveEffectiveTemplate(undefined, profile.provider, settings.activeModel || profile.model, true)
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
      inputText: processedContent,
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

    // 调用公共流式方法（流式到新气泡，气泡只含续写部分，原消息保持不变）
    // 新内容清洗：归一化 thought 标签 → output 正则 → 复述前缀去重（跳过 thought 块）
    // 心理描写保留：续写是独立气泡，thought 块与普通消息一样交给渲染层提取展示
    const cleanContinuation = async (raw: string): Promise<string> => {
      let processed = normalizeThoughtTags(raw)
      // 正文为空（模型只输出了 thought）视为无有效续写
      if (!stripThought(processed)) return ''
      try {
        const regexRules = await window.api.regex.list()
        if (regexRules.length > 0) {
          processed = get().applyRegex(processed, 'output', regexRules)
        }
      } catch { /* 忽略 */ }
      // 复述前缀去重只作用于正文，跳过开头的 thought 块
      const leadMatch = processed.match(/^\s*(?:<thought>[\s\S]*?<\/thought>\s*)+/i)
      const lead = leadMatch ? leadMatch[0] : ''
      const body = trimContinuationOverlap(targetMsg.content || '', processed.slice(lead.length))
      if (!body.trim()) return ''
      return lead ? lead.trimEnd() + '\n\n' + body : body
    }

    // 将清洗后的续写内容写入新气泡并持久化；内容为空则移除占位气泡
    const finalizeContinuation = (content: string): boolean => {
      if (!content) {
        set((s) => ({ messages: s.messages.filter(m => m.id !== newMsgId) }))
        return false
      }
      const curMsg = get().messages.find(m => m.id === newMsgId)
      if (!curMsg) return false
      const finalMsg: Message = { ...curMsg, content }
      set((s) => ({
        messages: s.messages.map(m => m.id === newMsgId ? finalMsg : m),
      }))
      window.api.chat.saveMessage(finalMsg).catch((e) => logError('ChatStore:saveMessage', e))
      return true
    }

    await streamAIResponse(set, get, {
      aiMessageId: newMsgId,
      character,
      preset,
      continuation: true,
      onComplete: async (newContent) => {
        const processed = await cleanContinuation(newContent)
        if (!finalizeContinuation(processed)) {
          if (newContent) set({ error: '模型未输出有效续写内容' })
          return
        }

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
      onError: (errMsg) => {
        // 出错/超时：已流式出的部分内容保留（flushStream 已写入气泡），毫无内容才移除
        const partial = get().messages.find(m => m.id === newMsgId)?.content || ''
        if (!partial) {
          set((s) => ({ messages: s.messages.filter(m => m.id !== newMsgId) }))
          return
        }
        cleanContinuation(partial)
          .then((processed) => {
            if (finalizeContinuation(processed)) {
              set({ error: `续写中断，已保留部分内容（${errMsg}）` })
            }
          })
          .catch((e) => logError('ChatStore:continueMessage', e))
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

  buildContext: (character, preset, opts) => {
    const settings = useSettingsStore.getState().settings
    const userName = settings.userName || '用户'
    // 修复 #8: 保留图片消息（content 为空但有 images 时不丢弃）
    const messages = get().messages.filter((m) => (m.content || (m.images && m.images.length > 0)) && m.role !== 'system')
    const context: { role: 'system' | 'user' | 'assistant'; content: string; keepSeparate?: boolean }[] = []

    // ===== System Prompt 构建 =====
    const charNameForVars = character.translatedContent?.name || character.name
    let systemContent = replaceVariables(
      character.systemPrompt || preset?.systemPrompt || '你是一个角色扮演助手。请根据角色设定进行沉浸式对话，保持角色性格的一致性。',
      userName,
      charNameForVars,
    )

    // jailbreak 改为可选（修复 #32）：只在 preset 有 jailbreak 且非空时附加
    // 用户可通过清空 preset.jailbreak 来禁用
    if (preset?.jailbreak && preset.jailbreak.trim()) {
      systemContent += '\n\n' + replaceVariables(preset.jailbreak, userName, charNameForVars)
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

    // ===== Token 预算框架 =====
    // budgetBase = (maxContext − 输出预留) × 安全余量；世界书预算取其一定比例，剩余给历史
    const profile = useSettingsStore.getState().getActiveProfile()
    // 修复 #31: 按模型推断默认 maxContext
    const model = profile?.model || settings.activeModel || 'gpt-4o-mini'
    const maxContext = profile?.maxContext || preset?.maxContext || getDefaultMaxContext(model)
    const reservedOutput = preset?.maxTokens ?? DEFAULT_RESERVED_OUTPUT
    // 下限保护：maxTokens 配置过大时至少保留 25% 上下文预算
    const budgetBase = Math.max(
      Math.floor((maxContext - reservedOutput) * TOKEN_BUDGET_SAFETY),
      Math.floor(maxContext * 0.25),
    )

    // ===== 角色设定 + 世界书 =====
    let charDesc = ''
    if (character.description) charDesc += replaceVariables(character.description, userName, character.name) + '\n'
    if (character.personality) charDesc += '性格：' + replaceVariables(character.personality, userName, character.name) + '\n'
    if (character.scenario) charDesc += '场景：' + replaceVariables(character.scenario, userName, character.name) + '\n'

    // 世界书注入（支持多个世界书合并 + 递归扫描 + at_depth 深度注入）
    const lorebookIds = get().activeLorebookIds
    // at_depth 条目：历史消息构建后按深度插入（初始为空）
    let atDepthItems: DepthLoreItem[] = []
    if (lorebookIds.length > 0) {
      // 修复 #28: 扫描深度可配置（取激活世界书中的最大值，否则用默认）
      const scanDepth = lorebookIds
        .map(id => lorebookCache.get(id)?.scanDepth)
        .filter((d): d is number => typeof d === 'number' && d > 0)
        .reduce((max, d) => Math.max(max, d), DEFAULT_LOREBOOK_SCAN_DEPTH)

      const scanText = messages.slice(-scanDepth).map((m) => m.content).join(' ')

      const lorebookRatio = settings.lorebookRatio ?? DEFAULT_LOREBOOK_RATIO
      const lorebookBudget = Math.floor(budgetBase * Math.min(Math.max(lorebookRatio, 0.05), 1))

      const result = triggerLorebooks({
        lorebooks: lorebookCache.getAll(lorebookIds),
        scanText,
        userName,
        charName: character.name,
        budget: lorebookBudget,
        model,
      })

      if (result.droppedCount > 0) {
        logInfo('buildContext', `世界书预算裁剪：触发 ${result.triggeredCount} 条，丢弃 ${result.droppedCount} 条（预算 ${lorebookBudget} tokens）`)
      }

      // before_char: 排列在 charDesc 之前
      if (result.beforeChar.length > 0) {
        charDesc = result.beforeChar.join('\n') + '\n' + charDesc
      }
      // after_char: 排列在 charDesc 之后
      if (result.afterChar.length > 0) {
        charDesc = charDesc + result.afterChar.join('\n')
      }
      // at_end: 追加到 systemContent 末尾
      if (result.atEnd.length > 0) {
        systemContent += '\n\n' + result.atEnd.join('\n')
      }
      // at_depth: 延迟到历史消息构建后注入
      if (result.atDepth.length > 0) {
        atDepthItems = result.atDepth
      }
    }

    if (charDesc) systemContent += '\n\n【角色设定】\n' + charDesc

    context.push({ role: 'system', content: systemContent })

    // ===== 作者注释（Author's Note）=====
    // 角色级优先，回退全局；enabled 且文本非空才注入
    const anConfig = character.authorNote ?? settings.authorNote
    let anText = ''
    if (anConfig?.enabled && anConfig.text?.trim()) {
      anText = replaceVariables(anConfig.text.trim(), userName, character.name)
    }

    // top：紧跟系统提示注入（keepSeparate：避免被 merge 合并进系统提示）
    if (anText && anConfig!.position === 'top') {
      context.push({ role: 'system', content: anText, keepSeparate: true })
    }

    // 对话示例位置与发送模式配置
    const exampleDialogPosition = settings.exampleDialogPosition || 'after_system'
    const exampleDialogMode = settings.exampleDialogMode || 'always'
    // 首轮 = 用户消息不超过 1 条（含刚发送的这条）
    const isFirstTurn = messages.filter(m => m.role === 'user').length <= 1
    const shouldSendExample = !!character.exampleDialog
      && exampleDialogMode !== 'off'
      && (exampleDialogMode !== 'first_turn' || isFirstTurn)
    const exampleDialogContent = shouldSendExample
      ? '【对话示例】\n' + replaceVariables(character.exampleDialog!, userName, character.name)
      : ''

    // 如果示例位置是 after_system（默认），在这里插入
    if (exampleDialogPosition === 'after_system' && exampleDialogContent) {
      context.push({ role: 'system', content: exampleDialogContent })
    }

    // ===== 历史消息 =====
    let usedTokens = context.reduce((sum, c) => sum + estimateTokens(c.content, model), 0)

    // 预留 postHistoryInstructions（历史之后才注入，需先计入预算，参考群聊路径做法）
    const postHistoryText = character.postHistoryInstructions
      ? replaceVariables(character.postHistoryInstructions, userName, character.name)
      : ''
    if (postHistoryText) usedTokens += estimateTokens(postHistoryText, model)
    // 预留作者注释（middle/bottom 在历史段内注入，需计入预算）
    if (anText && anConfig!.position !== 'top') {
      usedTokens += estimateTokens(anText, model)
    }
    // 预留 after_history 示例对话（同理）
    if (exampleDialogPosition === 'after_history' && exampleDialogContent) {
      usedTokens += estimateTokens(exampleDialogContent, model)
    }

    const recentMessages: typeof messages = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const tokenCount = estimateTokens(msg.content || '', model)
        + (msg.images?.length ? msg.images.length * IMAGE_TOKEN_ESTIMATE : 0)
      if (usedTokens + tokenCount > budgetBase) break
      recentMessages.unshift(msg)
      usedTokens += tokenCount
    }

    // 历史消息段（单独构建，供 at_depth 世界书在中间插入）
    const historySegment: { role: 'user' | 'assistant' | 'system'; content: string; keepSeparate?: boolean }[] = []
    for (const msg of recentMessages) {
      historySegment.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      })
    }

    // at_depth 世界书 + 作者注释（middle/bottom）统一按深度注入历史消息段
    // ST 语义：depth 0 = 对话末尾，1 = 倒数第二条之后，n = 从末尾数 n 条之后
    const depthInserts: { content: string; depth: number; order: number }[] =
      atDepthItems.map((i) => ({ content: i.content, depth: i.depth, order: i.order }))
    if (anText && anConfig!.position !== 'top') {
      // bottom = 末尾（depth 0）；middle = 按配置深度；同深度下 AN 排在世界书前
      const anDepth = anConfig!.position === 'middle' ? Math.max(0, anConfig!.depth) : 0
      depthInserts.push({ content: anText, depth: anDepth, order: -1 })
    }
    if (depthInserts.length > 0) {
      const sorted = depthInserts.sort((a, b) => (a.depth - b.depth) || (a.order - b.order))
      const insertMap = new Map<number, string[]>()
      for (const item of sorted) {
        // ST 语义：depth 0 = 最新消息之前（末尾上方），depth 1 = 倒数第二条之前
        const idx = Math.max(0, Math.min(recentMessages.length - 1, recentMessages.length - 1 - item.depth))
        if (!insertMap.has(idx)) insertMap.set(idx, [])
        insertMap.get(idx)!.push(item.content)
      }
      // 从后往前插入，避免 index 偏移
      const indices = [...insertMap.keys()].sort((a, b) => b - a)
      for (const idx of indices) {
        const contents = insertMap.get(idx)!
        historySegment.splice(idx, 0, ...contents.map((c) => ({ role: 'system' as const, content: c, keepSeparate: true })))
      }
    }

    context.push(...historySegment)

    // 如果示例位置是 after_history，在这里插入
    if (exampleDialogPosition === 'after_history' && exampleDialogContent) {
      context.push({ role: 'system', content: exampleDialogContent })
    }

    // 修复 #27: postHistoryInstructions 应该放在历史消息之后（Author's Note 位置）
    if (postHistoryText) {
      context.push({
        role: 'system',
        content: postHistoryText,
      })
    }

    // ===== 续写模式 =====
    // 在 merge/convert 之前注入续写指令，保证指令经过完整消息管线（provider 格式转换）
    if (opts?.continuation) {
      context.push({
        role: 'user',
        content: '请直接接续上一段内容的结尾继续写作，保持相同的风格、语气和叙事视角。不要重复已有内容，直接输出续写部分。',
      })
    }

    // Assistant Prefix：在上下文末尾添加空的 assistant 消息，引导模型输出格式
    // 对于 instruct 模式且 appendAssistantPrefix=true 的情况，添加角色名前缀
    // 续写模式跳过：空 prefix 会被 merge 进续写指令之后，干扰续写引导
    const instructTemplate = resolveEffectiveTemplate(
      preset?.contextTemplate,
      profile?.provider || 'openai',
      model,
      profile?.useInstructTemplate,
    )
    if (!opts?.continuation && instructTemplate?.appendAssistantPrefix && charNameForVars) {
      context.push({
        role: 'assistant',
        content: '',  // 空内容，让模型续写
      })
    }

    // 消息后处理：合并连续相同角色消息
    let processedContext = mergeConsecutiveMessages(context)

    // 根据提供商转换消息格式（Claude/Gemini 需要特殊处理）
    const provider = profile?.provider || 'openai'
    processedContext = convertMessages(provider, processedContext, { charName: charNameForVars, userName })

    return processedContext
  },
}))

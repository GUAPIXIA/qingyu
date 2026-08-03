import type { Message, Character, Preset, Lorebook, RegexRule, SessionPreview, ChatSession } from '../../shared/types'
import type { BudgetLoreItem } from '../utils/lorebook'

/** 上下文消息（buildContext 的中间产物，最终经 convertMessages 转为 provider 格式） */
export type ContextMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** 图片 data URL 数组（仅用户消息携带，供 vision 模型识别） */
  images?: string[]
  keepSeparate?: boolean
}

/** 单聊 store 的完整状态与动作接口 */
export interface ChatState {
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
  sendMessage: (content: string, images: string[], character: Character, preset: Preset | null, lorebooks: Lorebook[], replyToId?: string) => Promise<void>
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
  buildContext: (character: Character, preset: Preset | null, opts?: { continuation?: boolean }) => ContextMessage[]
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
  /** 语义触发（向量 RAG）命中条目缓存：发送消息时预取，buildContext 合并注入（不持久化） */
  _semanticLoreHits: BudgetLoreItem[]
  /** 记忆事实语义检索命中缓存：仅注入相关事实（不持久化） */
  _semanticFactsHits: string[]
  /** 上次上下文构建的用量（P1-3 预警用，不持久化） */
  lastContextUsage: { used: number; max: number } | null
}

/** zustand store 的 set/get 类型（供拆分出的模块级函数使用） */
export type StoreSet = (
  partial: Partial<ChatState> | ChatState | ((state: ChatState) => Partial<ChatState> | ChatState),
) => void
export type StoreGet = () => ChatState

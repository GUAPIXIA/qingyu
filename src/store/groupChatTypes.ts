import type { GroupChat, GroupMessage, GroupSession, Preset, MemoryFactRecord, NarrativeMode } from '../../shared/types'
import type { BudgetLoreItem, LorebookDiagnostics } from '../utils/lorebook'
import type { GroupContextBuildResult } from './groupChatContext'
import type { FactSearchHit } from '../../shared/ipc-api'

/** 群聊 store 的完整状态与动作接口 */
export interface GroupChatState {
  groupChats: GroupChat[]
  currentGroup: GroupChat | null
  sessions: GroupSession[]
  currentSessionId: string | null
  messages: GroupMessage[]
  isStreaming: boolean
  currentStreamingCharId: string | null
  error: string | null
  /** 正在执行长记忆总结的会话键（`${groupId}:${sessionId}`），无任务时为 null */
  summarizingMemoryKey: string | null
  /** 最近一次长记忆总结的失败原因（key 标记归属会话，避免跨会话串提示） */
  memorySummaryError: { key: string; message: string } | null

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
  setSessionPersona: (personaId: string | null) => Promise<void>
  setSessionNarrativeMode: (mode: NarrativeMode) => Promise<void>
  /** 更新当前群聊会话的世界状态或游戏主持设置。 */
  updateNarrativeSession: (patch: Pick<GroupSession, 'memoryCurrentState' | 'gameMasterMode'>) => Promise<void>

  loadMessages: (groupId: string, sessionId: string) => Promise<void>
  sendMessage: (content: string, images: string[], targetCharId?: string, replyToId?: string | null) => Promise<void>
  sendPollingRound: (charId: string) => Promise<void>
  /** 让指定群成员仅根据当前上下文回复一次，不启动或推进自动接力。 */
  triggerCharacterReply: (charId: string) => Promise<void>
  stopStreaming: () => void
  clearChat: (groupId: string) => Promise<void>
  clearMessages: () => void
  deleteMessage: (groupId: string, sessionId: string, messageId: string) => Promise<void>
  editMessage: (groupId: string, sessionId: string, messageId: string, content: string) => Promise<void>
  regenerateMessage: (messageId: string) => Promise<void>
  translateMessage: (messageId: string) => Promise<void>
  insertCharacterMessage: (charId: string, content: string) => Promise<void>

  buildGroupContext: (targetCharId?: string, preset?: Preset | null, opts?: {
    trackUsage?: boolean
    lorebookDiagnosticsMode?: 'live' | 'preview'
  }) => { role: 'system' | 'user' | 'assistant'; content: string }[]
  buildGroupContextReport: (targetCharId?: string, preset?: Preset | null) => GroupContextBuildResult
  ensureLorebooksLoaded: (lorebookIds: string[]) => Promise<void>
  /** 语义触发（向量 RAG）命中条目缓存：群聊发言前预取，buildGroupContext 合并注入（不持久化） */
  _semanticLoreHits: BudgetLoreItem[]
  /** 最近一次世界书向量检索是否成功；用于区分“零命中”与“服务不可用”。 */
  _semanticLoreAvailable: boolean | undefined
  /** 记忆事实语义检索命中缓存（不持久化） */
  _semanticFactsHits: Array<FactSearchHit | string>
  /** 上一轮真实发送的世界书触发轨迹（仅内存）。 */
  lastLorebookDiagnostics: LorebookDiagnostics | null
  lastLorebookDiagnosticsSessionId: string | null

  toggleMemory: (groupId: string, sessionId: string, enabled: boolean) => Promise<void>
  setMemoryMode: (groupId: string, sessionId: string, mode: 'manual' | 'auto', interval?: number) => Promise<void>
  /** 手动维护当前群聊会话的关键事实，并使旧事实向量失效 */
  updateMemoryFacts: (groupId: string, sessionId: string, facts: MemoryFactRecord[]) => Promise<void>
  triggerMemorySummary: () => Promise<void>
}

/** zustand store 的 set/get 类型（供拆分出的模块级函数使用） */
export type GroupStoreSet = (
  partial: Partial<GroupChatState> | GroupChatState | ((state: GroupChatState) => Partial<GroupChatState> | GroupChatState),
) => void
export type GroupStoreGet = () => GroupChatState

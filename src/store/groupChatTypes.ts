import type { GroupChat, GroupMessage, GroupSession, Preset, MemoryFactRecord } from '../../shared/types'
import type { BudgetLoreItem } from '../utils/lorebook'
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
  sendMessage: (content: string, images: string[], targetCharId?: string, replyToId?: string | null) => Promise<void>
  sendPollingRound: (charId: string) => Promise<void>
  stopStreaming: () => void
  clearChat: (groupId: string) => Promise<void>
  clearMessages: () => void
  deleteMessage: (groupId: string, sessionId: string, messageId: string) => Promise<void>
  editMessage: (groupId: string, sessionId: string, messageId: string, content: string) => Promise<void>
  regenerateMessage: (messageId: string) => Promise<void>
  translateMessage: (messageId: string) => Promise<void>
  insertCharacterMessage: (charId: string, content: string) => Promise<void>

  buildGroupContext: (targetCharId?: string, preset?: Preset | null) => { role: 'system' | 'user' | 'assistant'; content: string }[]
  ensureLorebooksLoaded: (lorebookIds: string[]) => Promise<void>
  /** 语义触发（向量 RAG）命中条目缓存：群聊发言前预取，buildGroupContext 合并注入（不持久化） */
  _semanticLoreHits: BudgetLoreItem[]
  /** 记忆事实语义检索命中缓存（不持久化） */
  _semanticFactsHits: Array<FactSearchHit | string>

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

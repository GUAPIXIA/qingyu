/**
 * 单聊 store 的稳定状态入口（结构阶段 4B）。
 *
 * 状态定义与动作契约见 `../features/chat/chatStoreTypes.ts`；
 * 会话/消息/生成三组动作实现分别由 `../features/chat/chat{Session,Message,Generation}Actions.ts` 组合注入。
 * 页面与既有消费者继续通过本 store 读取状态、调用动作（签名不变，行为等价）。
 */
import { create, type StateCreator } from 'zustand'
import { sessionEventReporter } from './sessionEventReporter'
import type { ChatState, ChatStoreState } from '../features/chat/chatStoreTypes'
import { createChatSessionActions } from '../features/chat/chatSessionActions'
import { createChatMessageActions } from '../features/chat/chatMessageActions'
import { createChatGenerationActions } from '../features/chat/chatGenerationActions'

export type { ChatState }
export type { ChatStoreState }

const createChatStoreState: StateCreator<ChatStoreState> = (set, get) => ({
  messages: [],
  sessions: [],
  currentSessionId: null,
  isStreaming: false,
  currentRequestId: null,
  error: null,
  messagesLoading: false,
  pendingImageGenerations: {},
  summarizingMemoryKey: null,
  memorySummaryError: null,
  activePresetId: null,
  activeLorebookIds: [],
  _semanticLoreHits: [],
  _semanticLoreAvailable: undefined,
  _semanticFactsHits: [],
  lastContextUsage: null,
  lastLorebookDiagnostics: null,
  lastLorebookDiagnosticsSessionId: null,
  translatingMessages: {},
  showTranslationIds: new Set(),
  editingMessageId: null,

  // 阶段 4B：动作实现按会话/消息/生成三组拆分到 features/chat，此处仅组合注入
  ...createChatSessionActions(set, get),
  ...createChatMessageActions(set, get),
  ...createChatGenerationActions(set, get),
})

// UEX-P1-34：messagesLoading 仅在本 store 扩展（sessionEventReporter 仍按 ChatState 签名包装，此处收窄断言）
export const useChatStore = create<ChatStoreState>()(
  sessionEventReporter(createChatStoreState as unknown as StateCreator<ChatState>) as unknown as StateCreator<ChatStoreState>,
)
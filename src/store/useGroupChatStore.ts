/**
 * 群聊 store 的稳定状态入口（结构阶段 4B）。
 *
 * 状态定义与动作契约见 `../features/group-chat/groupChatTypes.ts`；
 * 会话/消息/生成三组动作实现分别由 `../features/group-chat/group{Session,Message,Generation}Actions.ts`
 * 组合注入（流控制四模块见 4A：streamSession/requestRunner/messageFinalizer/modeScheduler）。
 * 页面与既有消费者继续通过本 store 读取状态、调用动作（签名不变，行为等价）。
 */
import { create, type StateCreator } from 'zustand'
import type { GroupChatState } from '../features/group-chat/groupChatTypes'
import { createGroupSessionActions } from '../features/group-chat/groupSessionActions'
import { createGroupMessageActions } from '../features/group-chat/groupMessageActions'
import { createGroupGenerationActions } from '../features/group-chat/groupGenerationActions'

export type { GroupChatState }

const createGroupChatStoreState: StateCreator<GroupChatState> = (set, get) => ({
  groupChats: [],
  currentGroup: null,
  sessions: [],
  currentSessionId: null,
  messages: [],
  isStreaming: false,
  currentStreamingCharId: null,
  error: null,
  summarizingMemoryKey: null,
  memorySummaryError: null,
  _semanticLoreHits: [],
  _semanticLoreAvailable: undefined,
  _semanticFactsHits: [],
  lastLorebookDiagnostics: null,
  lastLorebookDiagnosticsSessionId: null,

  // 阶段 4B：动作实现按会话/消息/生成三组拆分到 features/group-chat，此处仅组合注入
  ...createGroupSessionActions(set, get),
  ...createGroupMessageActions(set, get),
  ...createGroupGenerationActions(set, get),
})

export const useGroupChatStore = create<GroupChatState>()(createGroupChatStoreState)

/**
 * UEX-P1-12：「停剩余」语义化别名——停止后续成员接力，保留已生成内容。
 * 与 stopStreaming 完全同义（clearPollingTimer 已连带取消后续接力、半截正文按原语义落盘），
 * 仅为群调度条提供语义入口；不改动群聊收尾管线（abandonActiveStream/persistPartialGroupReply/splitAndSaveMessages）。
 */
export function stopRemainingSpeakers(): void {
  useGroupChatStore.getState().stopStreaming()
}
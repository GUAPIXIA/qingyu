/**
 * 群聊消息动作实现（结构阶段 4B）。
 *
 * 覆盖：删除/编辑消息、翻译、插入角色消息（开场白等）。
 * 页面消费仍走 `src/store/useGroupChatStore.ts` 的稳定状态入口（该文件组合注入本模块）。
 */
import { nanoid } from 'nanoid'
import type { GroupMessage } from '../../../shared/types'
import { cancelFeatureTasks } from '../../store/featureTasks'
import { invalidateGroupDerivedMemory } from '../../store/chatUtils'
import { translateGroupMessage } from '../../store/messageTranslation'
import { resolveNarrativeMode } from '../../../shared/narrativeMode'
import { nextGroupRound } from '../../../shared/chat-core/groupScheduling'
import type { GroupChatState, GroupStoreGet, GroupStoreSet } from './groupChatTypes'

export type GroupMessageActions = Pick<GroupChatState,
  | 'deleteMessage' | 'editMessage' | 'translateMessage' | 'insertCharacterMessage'>

export function createGroupMessageActions(set: GroupStoreSet, get: GroupStoreGet): GroupMessageActions {
  return {
    deleteMessage: async (groupId, sessionId, messageId) => {
      // 阶段五检查点：仅当删除在游标前才失效
      const invalidated = await invalidateGroupDerivedMemory(get as unknown as () => never, groupId, messageId)
      if (invalidated) {
        set((s) => ({ sessions: s.sessions.map(ss => ss.id === invalidated.sessionId ? { ...ss, ...invalidated.patch } : ss) as never }))
      }
      // 消息被删除：取消该消息在途的方向请求
      cancelFeatureTasks({ kind: 'group', groupId, sessionId }, [messageId])
      await window.api.group.deleteMessage(groupId, sessionId, messageId)
      set(s => ({
        messages: s.messages.filter(m => m.id !== messageId),
      }))
    },

    editMessage: async (groupId, sessionId, messageId, content) => {
      if (get().isStreaming) return
      // 阶段五检查点：仅当编辑在游标前才失效
      const invalidated = await invalidateGroupDerivedMemory(get as unknown as () => never, groupId, messageId)
      if (invalidated) {
        set((s) => ({ sessions: s.sessions.map(ss => ss.id === invalidated.sessionId ? { ...ss, ...invalidated.patch } : ss) as never }))
      }
      // 正文被编辑：旧方向不再对应当前内容，立即失效并取消在途请求
      cancelFeatureTasks({ kind: 'group', groupId, sessionId }, [messageId])
      await window.api.group.editMessage(groupId, sessionId, messageId, content)
      set(s => ({
        messages: s.messages.map(m =>
          m.id === messageId
            ? { ...m, content, translation: undefined, _showTranslation: false, dialogueDirections: undefined, dialogueDirectionsGeneratedAt: undefined }
            : m
        ),
      }))
    },

    translateMessage: (messageId) => translateGroupMessage(set, get, messageId),

    /** 插入角色消息（不触发 AI 回复，用于开场白等） */
    insertCharacterMessage: async (charId, content) => {
      const { currentGroup, currentSessionId, messages } = get()
      if (!currentGroup || !currentSessionId) return

      const currentRound = nextGroupRound(messages.map((m) => m.round))

      const msg: GroupMessage = {
        id: nanoid(),
        groupId: currentGroup.id,
        characterId: charId,
        content,
        images: [],
        timestamp: Date.now(),
        round: currentRound,
        narrativeMode: resolveNarrativeMode(get().sessions.find((session) => session.id === currentSessionId)?.narrativeMode),
        speakerKind: 'character',
        generationKind: 'assistant_reply',
        // 作者开场白可含完整 Markdown
        contentRenderMode: 'markdown',
      }
      set(s => ({ messages: [...s.messages, msg] }))
      await window.api.group.saveMessage(currentGroup.id, currentSessionId, msg)
    },
  }
}
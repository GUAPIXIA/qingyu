/**
 * 群聊消息动作实现（结构阶段 4B）。
 *
 * 覆盖：删除/编辑消息、翻译、插入角色消息（开场白等）。
 * 页面消费仍走 `src/store/useGroupChatStore.ts` 的稳定状态入口（该文件组合注入本模块）。
 */
import { nanoid } from 'nanoid'
import type { Character, GroupMessage } from '../../../shared/types'
import { cancelFeatureTasks } from '../../store/featureTasks'
import { invalidateGroupDerivedMemory } from '../../store/chatUtils'
import { translateGroupMessage } from '../../store/messageTranslation'
import { resolveNarrativeMode } from '../../../shared/narrativeMode'
import { nextGroupRound } from '../../../shared/chat-core/groupScheduling'
import { replaceVariables } from '../../../shared/chat-core/variables'
import { GROUP_NARRATOR_CHARACTER_ID } from '../../../shared/chat-core/groupContextBlocks'
import { useCharacterStore } from '../../store/useCharacterStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { resolveGroupUserContext } from './groupUserContext'
import type { GroupChatState, GroupStoreGet, GroupStoreSet } from './groupChatTypes'

export type GroupMessageActions = Pick<GroupChatState,
  | 'deleteMessage' | 'editMessage' | 'translateMessage' | 'insertCharacterMessage' | 'insertNarrationMessage'>

export function createGroupMessageActions(set: GroupStoreSet, get: GroupStoreGet): GroupMessageActions {
  /** 解析当前会话的用户上下文（与群聊上下文同口径），供插入消息的变量替换。 */
  const resolveInsertUserContext = () => {
    const state = get()
    return resolveGroupUserContext({
      settings: useSettingsStore.getState().settings,
      session: state.sessions.find((session) => session.id === state.currentSessionId),
      getPersona: usePersonaStore.getState().getPersona,
    })
  }

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

    /** 插入角色消息（不触发 AI 回复，用于开场白等；与单聊一致，落库前替换变量） */
    insertCharacterMessage: async (charId, content) => {
      const { currentGroup, currentSessionId, messages } = get()
      if (!currentGroup || !currentSessionId) return

      const user = resolveInsertUserContext()
      const speaker = useCharacterStore.getState().characters.find((character) => character.id === charId)
      const processed = replaceVariables(content, user.userName, speaker?.name ?? '')
      const currentRound = nextGroupRound(messages.map((m) => m.round))

      const msg: GroupMessage = {
        id: nanoid(),
        groupId: currentGroup.id,
        characterId: charId,
        content: processed,
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

    /**
     * 插入系统开场旁白（不触发 AI 回复，用于“系统开场”）。
     *
     * 归属：`characterId:'__narrator__'` + `speakerKind:'narrator'`，渲染层按旁白展示；
     * 不写入任何成员，也不参与自由模式拆分/回落。
     * 落库前替换 `{{user}}`（会话人设口径）与 `{{char}}`（全体成员名拼接），避免消息正文出现占位符。
     */
    insertNarrationMessage: async (content) => {
      const { currentGroup, currentSessionId, messages } = get()
      if (!currentGroup || !currentSessionId) return

      const user = resolveInsertUserContext()
      const characters = useCharacterStore.getState().characters
      const memberNames = currentGroup.memberIds
        .map((id) => characters.find((character): character is Character => character.id === id)?.name ?? '')
        .filter(Boolean)
        .join('、')
      const text = replaceVariables(content.trim(), user.userName, memberNames)
      if (!text) return

      const currentRound = nextGroupRound(messages.map((m) => m.round))
      const msg: GroupMessage = {
        id: nanoid(),
        groupId: currentGroup.id,
        characterId: GROUP_NARRATOR_CHARACTER_ID,
        content: text,
        images: [],
        timestamp: Date.now(),
        round: currentRound,
        narrativeMode: resolveNarrativeMode(get().sessions.find((session) => session.id === currentSessionId)?.narrativeMode),
        speakerKind: 'narrator',
        generationKind: 'manual',
        // 开场旁白允许完整 Markdown（与作者开场白同口径）
        contentRenderMode: 'markdown',
      }
      set(s => ({ messages: [...s.messages, msg] }))
      await window.api.group.saveMessage(currentGroup.id, currentSessionId, msg)
    },
  }
}
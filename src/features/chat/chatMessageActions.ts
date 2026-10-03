/**
 * 单聊消息动作实现（结构阶段 4B）。
 *
 * 覆盖：独立消息插入、图片更新、编辑/删除、翻译状态、生图任务状态与正则应用。
 * 页面消费仍走 `src/store/useChatStore.ts` 的稳定状态入口（该文件组合注入本模块）。
 */
import { nanoid } from 'nanoid'
import type { Message } from '../../../shared/types'
import { applyRegexRules, applyOutputRegexRules } from '../../../shared/chat-core/regex'
import { resolveMessageSpeakerKind } from '../../../shared/messageIdentity'
import { resolveNarrativeMode } from '../../../shared/narrativeMode'
import { useCharacterStore } from '../../store/useCharacterStore'
import { cancelFeatureTasks } from '../../store/featureTasks'
import { invalidateDerivedMemory } from '../../store/chatUtils'
import { clearSessionDialogueDirections } from '../../store/dialogueDirectionRunner'
import { translateSingleMessage } from '../../store/messageTranslation'
import type { ChatStoreGet, ChatStoreSet, ChatStoreState } from './chatStoreTypes'

export type ChatMessageActions = Pick<ChatStoreState,
  | 'addStandaloneMessage' | 'updateMessageImages' | 'editMessage' | 'deleteMessage'
  | 'translateMessage' | 'toggleTranslation' | 'beginImageGeneration'
  | 'updateImageGeneration' | 'finishImageGeneration' | 'applyRegex'>

export function createChatMessageActions(set: ChatStoreSet, get: ChatStoreGet): ChatMessageActions {
  return {
    addStandaloneMessage: async (content, images, character, role = 'assistant', sessionId) => {
      const targetSid = sessionId ?? get().currentSessionId
      if (!targetSid) return

      // 用户以独立消息形式发言（如不触发 AI 的快捷回复）：上一轮方向同样作废
      if (role === 'user' && get().currentSessionId === targetSid) {
        void clearSessionDialogueDirections(set, get, targetSid)
      }

      const narrativeMode = resolveNarrativeMode(get().sessions.find((session) => session.id === targetSid)?.narrativeMode)
      const msg: Message = {
        id: nanoid(),
        sessionId: targetSid,
        characterId: character.id,
        role,
        content,
        images,
        isEditing: false,
        timestamp: Date.now(),
        ...(role !== 'system' ? { narrativeMode } : {}),
        speakerKind: resolveMessageSpeakerKind({ role, characterId: character.id, narrativeMode }),
        generationKind: role === 'assistant' ? 'assistant_reply' : 'manual',
      }
      // 后台生图期间用户可能切换角色或会话：消息始终落盘到发起会话，
      // 只有目标仍在当前视图时才追加到可见消息数组。
      const visibleCharacterId = useCharacterStore.getState().currentCharacter?.id
      if (get().currentSessionId === targetSid && (!visibleCharacterId || visibleCharacterId === character.id)) {
        set((state) => ({ messages: [...state.messages, msg] }))
      }
      await window.api.chat.saveMessage(msg)
    },

    beginImageGeneration: (characterId, sessionId, stage) => {
      const state = get()
      const duplicate = Object.values(state.pendingImageGenerations).some(
        (job) => job.characterId === characterId && job.sessionId === sessionId,
      )
      if (duplicate) return null
      const job = { id: nanoid(), characterId, sessionId, stage, startedAt: Date.now() }
      set((current) => ({
        pendingImageGenerations: { ...current.pendingImageGenerations, [job.id]: job },
      }))
      return job
    },

    updateImageGeneration: (id, stage) => {
      set((state) => {
        const current = state.pendingImageGenerations[id]
        if (!current) return state
        return {
          pendingImageGenerations: {
            ...state.pendingImageGenerations,
            [id]: { ...current, stage },
          },
        }
      })
    },

    finishImageGeneration: (id) => {
      set((state) => {
        if (!state.pendingImageGenerations[id]) return state
        const next = { ...state.pendingImageGenerations }
        delete next[id]
        return { pendingImageGenerations: next }
      })
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
      const sid = msg.sessionId || state.currentSessionId

      // Start invalidation now so it captures the editing session, but do not let its
      // IPC round-trip block the visible edit or the message save.
      const invalidation = invalidateDerivedMemory(get, character, messageId)

      // 正文被编辑：旧方向不再对应当前内容，立即失效并取消在途请求
      const featureMessage = get().messages.find(m => m.id === messageId)
      if (featureMessage) cancelFeatureTasks({ kind: 'single', characterId: featureMessage.characterId, sessionId: featureMessage.sessionId }, [messageId])
      const updatedMsg: typeof msg = { ...msg, content: newContent, translation: null, translationLanguage: undefined, translationSource: undefined }
      delete (updatedMsg as Message).dialogueDirections
      delete (updatedMsg as Message).dialogueDirectionsGeneratedAt
      // 先更新本地状态
      set((s) => ({
        messages: s.messages.map((m) => (m.id === messageId ? updatedMsg : m)),
        translatingMessages: Object.fromEntries(Object.entries(s.translatingMessages).filter(([id]) => id !== messageId)),
        showTranslationIds: new Set([...s.showTranslationIds].filter(id => id !== messageId)),
      }))
      // 再保存到文件（updateMessage 会更新而非追加）
      await window.api.chat.saveMessage(updatedMsg)
      // P-7：本地 patch 会话元数据（不再全量 listSessions）
      if (sid) {
        const msgs = get().messages
        const isLast = msgs.length > 0 && msgs[msgs.length - 1].id === messageId
        get().patchLocalSession(sid, {
          messageCount: msgs.length,
          ...(isLast ? { lastMessage: newContent.slice(0, 50) } : {}),
          updatedAt: Date.now(),
        })
      }
      const invalidated = await invalidation
      if (invalidated) get().patchLocalSession(invalidated.sessionId, invalidated.patch)
    },

    deleteMessage: async (messageId, character) => {
      // NEW-1 修复：await 前捕获 sessionId——invalidateCompression 执行期间
      // 用户可能已切换会话，避免删除操作作用于错误会话
      const sessionId = get().currentSessionId ?? undefined
      // 消息被删除：取消该消息在途的方向请求
      const featureMessage = get().messages.find(m => m.id === messageId)
      if (featureMessage) cancelFeatureTasks({ kind: 'single', characterId: featureMessage.characterId, sessionId: featureMessage.sessionId }, [messageId])
      // 阶段五检查点：仅当删除发生在游标前才失效
      const invalidated = await invalidateDerivedMemory(get, character, messageId)
      if (invalidated) get().patchLocalSession(invalidated.sessionId, invalidated.patch)
      await window.api.chat.deleteMessage(messageId, character.id, sessionId)
      set((state) => ({ messages: state.messages.filter((m) => m.id !== messageId) }))
      // P-7：本地 patch 会话元数据（不再全量 listSessions）
      const sid = get().currentSessionId
      if (sid) {
        const msgs = get().messages
        get().patchLocalSession(sid, {
          messageCount: msgs.length,
          lastMessage: msgs.length > 0 ? msgs[msgs.length - 1].content.slice(0, 50) : '',
          updatedAt: Date.now(),
        })
      }
    },

    /** 启动 AI 翻译 - 全局状态管理，页面切换不中断 */
    translateMessage: (messageId, content) => translateSingleMessage(set, get, messageId, content),

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

    applyRegex: (text, scope, rules) => {
      if (!text || rules.length === 0) return text
      // 增量共享：output 两阶段(text+markdown)收敛到 applyOutputRegexRules
      if (scope === 'output') {
        return applyOutputRegexRules(text, rules)
      }
      // input 仅 text 阶段
      return applyRegexRules(text, rules, 'input', 'text').text
    },
  }
}
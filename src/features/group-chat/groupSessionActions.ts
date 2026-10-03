/**
 * 群聊会话与列表动作实现（结构阶段 4B）。
 *
 * 覆盖：群聊列表/选择/保存删除、会话生命周期与叙事配置、消息加载清空、世界书预载、记忆开关与摘要。
 * 页面消费仍走 `src/store/useGroupChatStore.ts` 的稳定状态入口（该文件组合注入本模块）。
 */
import type { GroupSession } from '../../../shared/types'
import { flushSpatialBoard } from '../../lib/spatialFlush'
import { usePersonaStore } from '../../store/usePersonaStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { pushToast } from '../../store/useToastStore'
import { cancelFeatureTasks } from '../../store/featureTasks'
import {
  applyDefaultGroupMemory, currentLoadRequestId, invalidateGroupDerivedMemory,
  nextLoadRequestId,
} from '../../store/chatUtils'
import { runGroupMemorySummary } from '../../store/groupMemoryManager'
import { refreshGroupDialogueDirections } from '../../store/dialogueDirectionRunner'
import { finishGroupSpatialBurst } from '../../store/groupSpatialSync'
import { resolveNarrativeMode } from '../../../shared/narrativeMode'
import { lorebookCache } from '../lorebook/lorebookCache'
import { abandonActiveStream, cleanupActiveStream } from './streamSession'
import { persistPartialGroupReply } from './messageFinalizer'
import { clearPollingTimer } from './modeScheduler'
import type { GroupChatState, GroupStoreGet, GroupStoreSet } from './groupChatTypes'

export type GroupSessionActions = Pick<GroupChatState,
  | 'loadGroups' | 'setCurrentGroup' | 'saveGroup' | 'deleteGroup' | 'selectGroup'
  | 'loadSessions' | 'createSession' | 'switchSession' | 'deleteSession' | 'renameSession'
  | 'setSessionPersona' | 'setSessionNarrativeMode' | 'setDialogueDirections' | 'updateNarrativeSession'
  | 'loadMessages' | 'clearMessages' | 'clearChat' | 'ensureLorebooksLoaded'
  | 'toggleMemory' | 'setMemoryMode' | 'updateMemoryFacts' | 'triggerMemorySummary'>

/** 群聊身份以会话为作用域；旧会话没有字段时才回退全局默认身份。 */
function syncGroupPersonaToSettings(session?: GroupSession): void {
  const settingsStore = useSettingsStore.getState()
  const storedPersonaId = session?.personaId
  const effectivePersonaId = storedPersonaId === undefined
    ? settingsStore.settings.defaultPersonaId
    : storedPersonaId
  const persona = effectivePersonaId
    ? usePersonaStore.getState().getPersona(effectivePersonaId)
    : undefined

  if (persona) {
    settingsStore.updateSettings({
      activePersonaId: persona.id,
      userName: persona.name,
      userDescription: persona.description,
      userPersona: persona.persona,
    })
    return
  }

  settingsStore.updateSettings({
    activePersonaId: null,
    userName: '用户',
    userDescription: '',
    userPersona: '',
  })
}

/**
 * S8：store 层切换/删除入口的统一停止收尾。
 * isStreaming 时走 abandonActiveStream({ preserve: true })（claim → preserve → cancelChat → cleanup + toast），
 * 并把半截正文落盘（free 走 splitAndSaveMessages）；禁止裸 cleanupActiveStream()。
 */
function stopStreamForLifecycle(get: () => GroupChatState, set: GroupStoreSet): void {
  clearPollingTimer()
  const spatialOwner = get()
  if (spatialOwner.currentGroup && spatialOwner.currentSessionId) void finishGroupSpatialBurst(spatialOwner.currentGroup.id, spatialOwner.currentSessionId)
  if (!get().isStreaming) {
    cleanupActiveStream()
    return
  }
  const state = get()
  const group = state.currentGroup
  const sessionId = state.currentSessionId
  const claimed = abandonActiveStream({ preserve: true })
  if (claimed && claimed.preserved && group && sessionId) {
    void persistPartialGroupReply({
      set,
      get: get as GroupStoreGet,
      group,
      sessionId,
      msgId: claimed.msgId,
      content: claimed.preserved,
      round: claimed.round,
      characterId: claimed.characterId,
      isFree: claimed.isFree,
      offstageCharacterIds: claimed.offstageCharacterIds,
      narrativeMode: claimed.narrativeMode,
      noticeFields: { generationNotice: '已停止生成' },
    })
  }
  set({ isStreaming: false, currentStreamingCharId: null })
}

export function createGroupSessionActions(set: GroupStoreSet, get: GroupStoreGet): GroupSessionActions {
  return {
    // ---- 群聊列表 ----

    loadGroups: async () => {
      const groups = await window.api.group.list()
      set({ groupChats: groups })
    },

    setCurrentGroup: (group) => {
      set({ currentGroup: group })
    },

    saveGroup: async (group) => {
      const pending = flushSpatialBoard()
      if (pending) { try { await pending } catch { return } }
      // UEX-P1-11 兜底：生成中禁止改动发言调度（对话模式/成员增删排序），UI 已禁用，此处拦截并发入口
      const prev = get().groupChats.find((item) => item.id === group.id) ?? (get().currentGroup?.id === group.id ? get().currentGroup : null)
      if (get().isStreaming && prev) {
        const membersChanged = prev.memberIds.join(',') !== group.memberIds.join(',')
        if (prev.chatMode !== group.chatMode || membersChanged || prev.currentSpeakerIndex !== group.currentSpeakerIndex) {
          pushToast({
            variant: 'warning',
            title: '生成中，暂不可修改群模式与成员',
            description: '请先停止生成，或等本轮完成后再修改。',
            requestId: 'group-save-guard',
          })
          return
        }
      }
      await window.api.group.save(group)
      const groups = await window.api.group.list()
      set({ groupChats: groups, currentGroup: group })
    },

    deleteGroup: async (id) => {
      const pending = flushSpatialBoard()
      if (pending) { try { await pending } catch { return } }
      stopStreamForLifecycle(get, set)
      await window.api.group.delete(id)
      const groups = await window.api.group.list()
      set({ groupChats: groups, currentGroup: null, messages: [], sessions: [], currentSessionId: null })
    },

    selectGroup: async (groupId) => {
      const pending = flushSpatialBoard()
      if (pending) { try { await pending } catch { return } }
      stopStreamForLifecycle(get, set)
      const groups = await window.api.group.list()
      const group = groups.find(g => g.id === groupId) ?? null
      if (!group) return
      set({ currentGroup: group })
      // 预加载世界书缓存
      if (group.lorebookIds.length > 0) {
        await get().ensureLorebooksLoaded(group.lorebookIds)
      }
      await get().loadSessions(groupId)
    },

    // ---- 会话 ----

    loadSessions: async (groupId) => {
      const sessions = await window.api.group.listSessions(groupId)
      set({ sessions, currentSessionId: sessions[0]?.id ?? null })
      if (sessions[0]) {
        syncGroupPersonaToSettings(sessions[0])
        await get().loadMessages(groupId, sessions[0].id)
      }
    },

    createSession: async (groupId) => {
      const pending = flushSpatialBoard()
      if (pending) { try { await pending } catch { return } }
      stopStreamForLifecycle(get, set)
      const session = await window.api.group.createSession(groupId)
      await applyDefaultGroupMemory(groupId, session.id)
      const sessions = await window.api.group.listSessions(groupId)
      set({ sessions, currentSessionId: session.id, messages: [], isStreaming: false, currentStreamingCharId: null })
      syncGroupPersonaToSettings(sessions.find((item) => item.id === session.id) ?? session)
    },

    switchSession: async (groupId, sessionId) => {
      const pending = flushSpatialBoard()
      if (pending) { try { await pending } catch { return } }
      stopStreamForLifecycle(get, set)
      set({ currentSessionId: sessionId, isStreaming: false, currentStreamingCharId: null })
      syncGroupPersonaToSettings(get().sessions.find((item) => item.id === sessionId))
      await get().loadMessages(groupId, sessionId)
    },

    deleteSession: async (groupId, sessionId) => {
      const pending = flushSpatialBoard()
      if (pending) { try { await pending } catch { return } }
      stopStreamForLifecycle(get, set)
      cancelFeatureTasks({ kind: 'group', groupId, sessionId })
      await window.api.group.deleteSession(groupId, sessionId)
      const sessions = await window.api.group.listSessions(groupId)
      const newSid = sessions[0]?.id ?? null
      set({ sessions, currentSessionId: newSid, messages: [], isStreaming: false, currentStreamingCharId: null })
      if (newSid) {
        syncGroupPersonaToSettings(sessions[0])
        await get().loadMessages(groupId, newSid)
      }
    },

    renameSession: async (groupId, sessionId, title) => {
      await window.api.group.renameSession(groupId, sessionId, title)
      const sessions = await window.api.group.listSessions(groupId)
      set({ sessions })
    },

    setSessionPersona: async (personaId) => {
      const pending = flushSpatialBoard()
      if (pending) { try { await pending } catch { return } }
      const { currentGroup, currentSessionId, sessions } = get()
      if (!currentGroup || !currentSessionId) return
      await window.api.group.updateSession(currentGroup.id, currentSessionId, { personaId })
      const currentSession = sessions.find((item) => item.id === currentSessionId)
      const updatedSession = currentSession
        ? { ...currentSession, personaId, updatedAt: Date.now() }
        : undefined
      set((state) => ({
        sessions: state.sessions.map((item) => item.id === currentSessionId ? updatedSession! : item),
      }))
      syncGroupPersonaToSettings(updatedSession)
    },

    setSessionNarrativeMode: async (narrativeMode) => {
      const { currentGroup, currentSessionId } = get()
      if (!currentGroup || !currentSessionId || get().isStreaming) return
      const previousMode = get().sessions.find((session) => session.id === currentSessionId)?.narrativeMode
      await window.api.group.updateSession(currentGroup.id, currentSessionId, { narrativeMode })
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === currentSessionId
          ? { ...session, narrativeMode, updatedAt: Date.now() }
          : session),
      }))
      // 叙事模式改变：方向是“下一步”的前瞻建议，需按新模式刷新（仅最新一条且已有方向时）
      if (resolveNarrativeMode(previousMode) !== resolveNarrativeMode(narrativeMode)) {
        void refreshGroupDialogueDirections(set, get)
      }
    },

    setDialogueDirections: async (enabled) => {
      const { currentGroup, currentSessionId } = get()
      if (!currentGroup || !currentSessionId) return
      await window.api.group.updateSession(currentGroup.id, currentSessionId, { dialogueDirectionsEnabled: enabled })
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === currentSessionId
          ? { ...session, dialogueDirectionsEnabled: enabled, updatedAt: Date.now() }
          : session),
      }))
    },

    updateNarrativeSession: async (patch) => {
      const { currentGroup, currentSessionId } = get()
      if (!currentGroup || !currentSessionId || get().isStreaming) return
      await window.api.group.updateSession(currentGroup.id, currentSessionId, patch)
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === currentSessionId
          ? { ...session, ...patch, updatedAt: Date.now() }
          : session),
      }))
    },

    // ---- 消息加载 ----

    loadMessages: async (groupId, sessionId) => {
      // NEW-M10 修复：竞态防护——快速切换会话时，丢弃过期请求的结果
      const currentLoadId = nextLoadRequestId()
      // 会话切换：清空当前列表，避免显示旧会话消息
      set({ messages: [], _semanticLoreHits: [], _semanticLoreAvailable: undefined, _semanticFactsHits: [] })
      const messages = await window.api.group.listMessages(groupId, sessionId)
      // 期间又发起了新的加载请求则放弃本次结果
      if (currentLoadId !== currentLoadRequestId()) return
      set({ messages, _semanticLoreHits: [], _semanticLoreAvailable: undefined, _semanticFactsHits: [] })
    },

    clearMessages: () => {
      set({ messages: [], error: null, _semanticLoreHits: [], _semanticLoreAvailable: undefined, _semanticFactsHits: [] })
    },

    clearChat: async (groupId) => {
      const pending = flushSpatialBoard()
      if (pending) { try { await pending } catch { return } }
      // 停止正在进行的流式生成和轮询（S8：isStreaming 时保留半截并 cancel）
      stopStreamForLifecycle(get, set)
      const { currentSessionId } = get()
      if (currentSessionId) {
        cancelFeatureTasks({ kind: 'group', groupId, sessionId: currentSessionId })
        await window.api.group.clearChat(groupId, currentSessionId)
        // 阶段五：clearChat 始终全量失效（changedMessageId=null）
        const invalidated = await invalidateGroupDerivedMemory(get as unknown as () => never, groupId, null)
        if (invalidated) {
          set((s) => ({ sessions: s.sessions.map(ss => ss.id === invalidated.sessionId ? { ...ss, ...invalidated.patch } : ss) as never }))
        }
      }
      set({ messages: [], isStreaming: false, currentStreamingCharId: null })
    },

    ensureLorebooksLoaded: async (lorebookIds) => {
      const allLorebooks = await window.api.lorebook.list()
      for (const lb of allLorebooks) {
        if (lorebookIds.includes(lb.id)) {
          lorebookCache.set(lb.id, lb)
        }
      }
    },

    // ---- 记忆管理 ----

    toggleMemory: async (groupId, sessionId, enabled) => {
      await window.api.group.toggleMemory(groupId, sessionId, enabled)
      // 刷新本地 session 状态
      const sessions = get().sessions.map(s =>
        s.id === sessionId ? { ...s, memoryEnabled: enabled } : s
      )
      set({ sessions })
    },

    setMemoryMode: async (groupId, sessionId, mode, interval?) => {
      await window.api.group.setMemoryMode(groupId, sessionId, mode, interval)
      const sessions = get().sessions.map(s =>
        s.id === sessionId ? { ...s, memoryMode: mode, ...(interval !== undefined ? { autoMemoryInterval: interval } : {}) } : s
      )
      set({ sessions })
    },

    updateMemoryFacts: async (groupId, sessionId, facts) => {
      const current = get().sessions.find((item) => item.id === sessionId)
      const patch = {
        memoryFacts: facts,
        memoryUpdatedAt: Date.now(),
        memoryVersion: (current?.memoryVersion ?? 0) + 1,
        factsVectors: [],
        factsVectorVersion: -1,
      }
      const commit = await window.api.group.updateSessionIfMemoryVersion(groupId, sessionId, current?.memoryVersion ?? 0, patch)
      if (!commit.applied) {
        const sessions = await window.api.group.listSessions(groupId)
        set({ sessions })
        throw new Error('群聊长记忆已发生变化，请重新编辑后再保存。')
      }
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, ...patch } : session),
        _semanticFactsHits: [],
      }))
    },

    triggerMemorySummary: async () => {
      return runGroupMemorySummary(get, set)
    },
  }
}
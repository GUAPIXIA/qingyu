import { cancelFeatureTasks } from './featureTasks'
import { translateGroupMessage } from './messageTranslation'
import { finishGroupSpatialBurst } from './groupSpatialSync'
import { flushSpatialBoard } from '../lib/spatialFlush'
import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { GroupChat, GroupMessage, GroupSession } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'
import { usePersonaStore } from './usePersonaStore'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { applyRegexRules as applyRegexRulesEngine } from '../../shared/chat-core/regex'
import { lorebookCache } from '../features/lorebook/lorebookCache'
import { appendRecentTriggeredIds, touchCompressionCache, upsertCompressionCache } from '../../shared/chat-core/lorebook'
import { compressLorebookOverflow } from './chatUtils'
import { LOREBOOK_RECENCY_WINDOW } from '../../shared/chat-core/chatConstants'
import { logError } from '../lib/logger'
import {
  applyDefaultGroupMemory,
  nextLoadRequestId,
  currentLoadRequestId,
  invalidateGroupDerivedMemory,
} from './chatUtils'
import { streamGroupAI, streamGroupAIFree } from '../features/group-chat/requestRunner'
import { checkPollingContinue, checkAutoMemory, clearPollingTimer } from '../features/group-chat/modeScheduler'
import {
  cleanupActiveStream, claimGroupUserStop, preserveGroupReplyContent,
  abandonActiveStream, getActiveStream,
} from '../features/group-chat/streamSession'
import { persistPartialGroupReply } from '../features/group-chat/messageFinalizer'
import { abortActiveTailRepair } from './streamController'
import { pushToast } from './useToastStore'

/** S2：错误写入 store 的同时推全局 Toast，避免静默失败 */
function setGroupError(set: (partial: Partial<{ error: string | null }>) => void, message: string) {
  set({ error: message })
  pushToast({ variant: 'error', title: message, requestId: 'group-error' })
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
import { buildGroupChatContext, type GroupContextBuildResult } from './groupChatContext'
import { runGroupMemorySummary } from './groupMemoryManager'
import type { GroupChatState, GroupStoreGet, GroupStoreSet } from './groupChatTypes'
import { resolveNarrativeMode } from '../../shared/narrativeMode'
import { resolveDialogueDirectionsEnabled } from '../../shared/dialogueDirections'
import {
  generateGroupDialogueDirections,
  refreshGroupDialogueDirections,
  clearGroupDialogueDirections,
} from './dialogueDirectionRunner'
// 阶段 6 S6-01：发言调度/提及/轮次的跨端共享纯逻辑（fixture oracle 即此实现）
import { nextGroupRound, detectMentionedMembers, resolveGroupSpeakerPlan, resolveGroupFreeSegment } from '../../shared/chat-core/groupScheduling'

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
 * 群聊已轮到用户时，若会话开启“下一步方向”，为最后一条有效角色回复异步补齐方向。
 * 中间轮次（自动接力仍在继续）不生成，避免每个中间回复都产生无效选项（方案 §4.4）。
 */
function maybeGenerateGroupDirections(set: GroupStoreSet, get: GroupStoreGet): void {
  const state = get()
  const { currentGroup, currentSessionId } = state
  if (!currentGroup || !currentSessionId || state.isStreaming) return
  const session = state.sessions.find((item: GroupSession) => item.id === currentSessionId)
  if (!resolveDialogueDirectionsEnabled(session)) return

  const last = [...state.messages].reverse().find(
    (message) => message.characterId !== '__user__'
      && message.characterId !== '__free__'
      && !!message.content?.trim(),
  )
  if (!last) return
  const speaker = useCharacterStore.getState().characters.find((character) => character.id === last.characterId)
  if (!speaker) return

  void generateGroupDialogueDirections(set, get, {
    messageId: last.id,
    character: speaker,
    userName: useSettingsStore.getState().settings.userName || '用户',
  })
}

/** D10：重生回滚——移除本次新消息，并按暂存顺序插回原文。 */
function restoreRegenerationMessages(
  set: GroupStoreSet,
  stashed: GroupMessage[],
  anchorIndex: number,
  generatedIds: Set<string> = new Set(),
): void {
  set((s: GroupChatState) => {
    const stashedIds = new Set(stashed.map((message) => message.id))
    const msgs = s.messages.filter((message) => !generatedIds.has(message.id) && !stashedIds.has(message.id))
    msgs.splice(Math.min(anchorIndex, msgs.length), 0, ...stashed)
    return { messages: msgs }
  })
}

/**
 * 重生成终态提交：新回复必须已完成且落盘，随后才删除旧消息。
 * 删除旧消息任一步失败时执行补偿事务：删除本次新回复、重写全部旧消息并恢复 UI，
 * 避免界面看似替换成功、重载后却出现新旧重复。
 */
async function settleRegenerationReplacement(input: {
  set: GroupStoreSet
  get: GroupStoreGet
  group: GroupChat
  sessionId: string
  baselineIds: Set<string>
  stashed: GroupMessage[]
  anchorIndex: number
  generationSucceeded: boolean
  generatedMessages?: readonly GroupMessage[]
}): Promise<boolean> {
  const { set, get, group, sessionId, baselineIds, stashed, anchorIndex } = input
  const current = get()
  const isSameContext = () => get().currentGroup?.id === group.id && get().currentSessionId === sessionId
  const visibleGenerated = isSameContext()
    ? current.messages.filter((message) => !baselineIds.has(message.id))
    : []
  const generated = [...new Map(
    [...(input.generatedMessages ?? []), ...visibleGenerated]
      .map((message) => [message.id, message]),
  ).values()]
  const generatedIds = new Set(generated.map((message) => message.id))
  const generationSucceeded = input.generationSucceeded && generated.length > 0

  if (generationSucceeded) {
    try {
      for (const message of stashed) {
        await window.api.group.deleteMessage(group.id, sessionId, message.id)
      }
      return true
    } catch (error) {
      logError('GroupChatStore:replaceRegeneratedMessages', error)
      // 补偿：新回复全部撤回；已删掉的旧回复按原 id 重写，未删的写入也是幂等更新。
      await Promise.allSettled(generated.map((message) =>
        window.api.group.deleteMessage(group.id, sessionId, message.id)))
      await Promise.allSettled(stashed.map((message) =>
        window.api.group.saveMessage(group.id, sessionId, message)))
      if (isSameContext()) restoreRegenerationMessages(set, stashed, anchorIndex, generatedIds)
      pushToast({
        variant: 'error',
        title: '重新生成替换失败，已恢复原消息',
        description: '新回复已撤回，请稍后重试。',
        requestId: 'group-regenerate-replace-fail',
      })
      return false
    }
  }

  // 生成失败、停止或切换：旧消息尚未删除，只需撤回可能落盘的半截新回复并恢复 UI。
  await Promise.allSettled(generated.map((message) =>
    window.api.group.deleteMessage(group.id, sessionId, message.id)))
  if (isSameContext()) restoreRegenerationMessages(set, stashed, anchorIndex, generatedIds)
  pushToast({ variant: 'error', title: '重新生成失败，已恢复原消息', requestId: 'group-regenerate-fail' })
  return false
}

/**
 * D10 已拍板：free 整段重生（复用 S13 防丢语义，整轮粒度）——
 * 先暂存整轮原文、UI 隐藏（不落盘删除）→ 重新发起 free 生成（整段，非单成员）→
 * 发起成功后替换整轮（删旧整轮；新整轮由收尾管线 splitAndSaveMessages 拆分插入）→
 * 失败恢复整轮原文 + toast「重新生成失败，已恢复原消息」。
 * 落盘仍遵守「不持久化 `__free__` 正文」约束（P0-07）：历史 `__free__` 占位整段重生后
 * 同样经 splitAndSaveMessages 拆分到成员/回落首成员，绝不把 free 正文挂回 `__free__`。
 */
async function regenerateFreeSegment(
  set: GroupStoreSet,
  get: GroupStoreGet,
  group: GroupChat,
  sessionId: string,
  messages: GroupMessage[],
  segmentIds: string[],
): Promise<void> {
  const idSet = new Set(segmentIds)
  // S13：整轮原文暂存（保持消息流顺序），失败时按原位置恢复
  const stashedSegment = messages.filter((m) => idSet.has(m.id))
  const anchorIndex = messages.findIndex((m) => idSet.has(m.id))
  const targetRound = stashedSegment[0]?.round ?? 0
  const baselineIds = new Set(messages.map((message) => message.id))

  // 消息被替换：取消整轮在途的方向请求
  cancelFeatureTasks({ kind: 'group', groupId: group.id, sessionId }, segmentIds)
  // 仅从 UI 隐藏（不落盘删除），成功后再删、失败则恢复
  set((s: GroupChatState) => ({ messages: s.messages.filter((m) => !idSet.has(m.id)) }))

  // NEW-3 修复：await 期间用户可能已切换群聊/会话，校验后中止重新生成
  const fresh = get()
  if (fresh.currentGroup?.id !== group.id || fresh.currentSessionId !== sessionId) {
    restoreRegenerationMessages(set, stashedSegment, anchorIndex)
    setGroupError(set, '群聊已切换，未触发重新生成')
    return
  }

  let settlement: Promise<boolean> | null = null
  const settleOnce = (generationSucceeded: boolean, generatedMessages?: readonly GroupMessage[]) => {
    settlement ??= settleRegenerationReplacement({
      set, get, group, sessionId, baselineIds, stashed: stashedSegment, anchorIndex,
      generationSucceeded, generatedMessages,
    })
    return settlement
  }

  // 重新发起 free 生成（整段，非单成员）：终态落盘后才替换旧整轮。
  let started = false
  try {
    started = await streamGroupAIFree(set, get, group, sessionId, targetRound, undefined, {
      onTerminal: settleOnce,
    })
  } catch (e) {
    logError('Group:regenerateFreeSegment', e)
  }
  if (!started) await settleOnce(false)
}

export type { GroupChatState }
export const useGroupChatStore = create<GroupChatState>((set, get) => ({
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

  // ---- 消息 ----

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

  regenerateMessage: async (messageId) => {
    const state = get()
    const { currentGroup, currentSessionId } = state
    if (!currentGroup || !currentSessionId || state.isStreaming) return

    // 找到目标消息的前一条用户消息
    const msgIdx = state.messages.findIndex(m => m.id === messageId)
    if (msgIdx < 0) return

    const targetMsg = state.messages[msgIdx]
    // D10 已拍板：用户消息仍不可重生
    if (targetMsg.characterId === '__user__') return

    // D10 已拍板：free 段消息放开重生，按「整轮 free 段」整段重生（识别依据见 resolveGroupFreeSegment）
    const freeSegmentIds = resolveGroupFreeSegment(
      state.messages.map((m) => ({ id: m.id, characterId: m.characterId, round: m.round })),
      messageId,
      currentGroup.chatMode,
    )
    if (freeSegmentIds) {
      await regenerateFreeSegment(set, get as GroupStoreGet, currentGroup, currentSessionId, state.messages, freeSegmentIds)
      return
    }

    const charStore = useCharacterStore.getState()
    const speaker = charStore.characters.find(c => c.id === targetMsg.characterId)
    if (!speaker) return

    // S13 群重生防丢：暂存原文，禁止先 deleteMessage 再 stream
    const originalMsg = targetMsg
    const baselineIds = new Set(state.messages.map((message) => message.id))

    // 消息被替换：取消该消息在途的方向请求
    cancelFeatureTasks({ kind: 'group', groupId: currentGroup.id, sessionId: currentSessionId }, [messageId])
    // 仅从 UI 隐藏（不落盘删除），成功后再删、失败则恢复
    set(s => ({
      messages: s.messages.filter(m => m.id !== messageId),
    }))

    // NEW-3 修复：await 期间用户可能已切换群聊/会话，校验后中止重新生成
    const fresh = get()
    if (fresh.currentGroup?.id !== currentGroup.id || fresh.currentSessionId !== currentSessionId) {
      set(s => {
        const msgs = [...s.messages]
        msgs.splice(Math.min(msgIdx, msgs.length), 0, originalMsg)
        return { messages: msgs }
      })
      setGroupError(set, '群聊已切换，未触发重新生成')
      return
    }

    let settlement: Promise<boolean> | null = null
    const settleOnce = (generationSucceeded: boolean, generatedMessages?: readonly GroupMessage[]) => {
      settlement ??= settleRegenerationReplacement({
        set,
        get: get as GroupStoreGet,
        group: currentGroup,
        sessionId: currentSessionId,
        baselineIds,
        stashed: [originalMsg],
        anchorIndex: msgIdx,
        generationSucceeded,
        generatedMessages,
      })
      return settlement
    }

    // 重新生成：终态落盘后再替换旧消息；失败/停止均恢复原文。
    let started = false
    try {
      started = await streamGroupAI(set, get, currentGroup, currentSessionId, speaker, targetMsg.round, async () => {
        // checkPollingContinue 是 async：必须 await 后再判断，否则 Promise 恒为真值
        const scheduled = currentGroup.chatMode === 'polling' && currentGroup.autoMode
          ? await checkPollingContinue(set, get, currentGroup)
          : false
        if (!scheduled) { await finishGroupSpatialBurst(currentGroup.id, currentSessionId); maybeGenerateGroupDirections(set, get) }
        checkAutoMemory(get)
      }, undefined, { onTerminal: settleOnce })
    } catch (e) {
      logError('Group:regenerateMessage', e)
    }
    if (!started) await settleOnce(false)
  },

  translateMessage: (messageId) => translateGroupMessage(set, get, messageId),

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

  // ---- 核心：发送消息 ----

  sendMessage: async (content, images, targetCharId, replyToId) => {
    const state = get()
    const { currentGroup, currentSessionId } = state
    if (!currentGroup || !currentSessionId) return

    // BUG-08 修复：异步操作期间用户可能切换群聊/会话，
    // 每次 await 后通过 get() 校验上下文是否仍然有效，避免消息发到过期上下文
    const isContextValid = (): boolean => {
      const s = get()
      return s.currentGroup?.id === currentGroup.id && s.currentSessionId === currentSessionId
    }

    if (state.isStreaming) {
      setGroupError(set, '正在生成回复中，请稍候或点击停止')
      return
    }

    const settingsStore = useSettingsStore.getState()
    const profile = settingsStore.getActiveProfile()
    if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
      setGroupError(set, '请先在设置中配置 API 连接')
      return
    }

    // 用户已发送：上一轮的方向作废，与用户消息同帧移除
    void clearGroupDialogueDirections(set, get, currentGroup.id, currentSessionId)

    // 1. 用户消息
    const currentRound = nextGroupRound(state.messages.map((m) => m.round))

    // 对用户输入应用正则规则（input/both，text 阶段）
    let processedContent = content
    try {
      const regexRules = await window.api.regex.list()
      if (regexRules.length > 0) {
        processedContent = applyRegexRulesEngine(content, regexRules, 'input', 'text').text
      }
    } catch { /* 忽略正则加载失败 */ }

    // BUG-08：await 期间群聊可能已切换，中止发送
    if (!isContextValid()) {
      setGroupError(set, '群聊已切换，消息未发送')
      return
    }
    // 检测 @提及的角色 ID（从群成员名中匹配；shared/chat-core/groupScheduling.ts 跨端一致）
    // D3 已拍板：正文 @ 不决定发言人——只做气泡高亮（mentionedCharacterIds），
    // 发言计划仍只吃 UI 的 targetCharId/mentionOverrideId（见下方 resolveGroupSpeakerPlan）。
    const charStore = useCharacterStore.getState()
    const mentionedCharacterIds = detectMentionedMembers(
      content,
      currentGroup.memberIds
        .map((id) => charStore.characters.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => ({ id: c.id, name: c.name })),
    )

    const narrativeMode = resolveNarrativeMode(get().sessions.find((session) => session.id === currentSessionId)?.narrativeMode)
    const userMsg: GroupMessage = {
      id: nanoid(),
      groupId: currentGroup.id,
      characterId: '__user__',
      content: processedContent,
      images,
      timestamp: Date.now(),
      round: currentRound,
      replyToId: replyToId ?? null,
      status: 'sending',
      mentionedCharacterIds: mentionedCharacterIds.length > 0 ? mentionedCharacterIds : undefined,
      narrativeMode,
      speakerKind: narrativeMode === 'omniscient' ? 'narrator' : 'persona',
      generationKind: 'manual',
    }
    set(s => ({ messages: [...s.messages, userMsg], error: null }))
    await window.api.group.saveMessage(currentGroup.id, currentSessionId, userMsg)

    // BUG-08：等待保存期间群聊可能已切换——从当前 UI 移除占位消息并中止 AI 回复
    // （已保存的用户消息仍保留在发起时的群聊数据中，切回后可见，不丢数据）
    if (!isContextValid()) {
      set((s) => ({ messages: s.messages.filter((m) => m.id !== userMsg.id) }))
      setGroupError(set, '群聊已切换，未触发 AI 回复')
      return
    }

    // 辅助函数：更新用户消息状态为 sent
    const markUserMsgSent = (msgId: string) => {
      set((s) => ({
        messages: s.messages.map((m: GroupMessage) =>
          m.id === msgId ? { ...m, status: 'sent' as const } : m,
        ),
      }))
      const updated = get().messages.find(m => m.id === msgId)
      if (updated && currentGroup && currentSessionId) {
        window.api.group.saveMessage(currentGroup.id, currentSessionId, updated).catch((e) => logError('GroupChatStore:saveMessage', e))
      }
    }

    // 2. 根据模式获取 AI 回复（发言计划：shared/chat-core/groupScheduling.ts 跨端一致）
    const plan = resolveGroupSpeakerPlan({
      chatMode: currentGroup.chatMode,
      memberIds: currentGroup.memberIds,
      currentSpeakerIndex: currentGroup.currentSpeakerIndex,
      targetCharId,
      knownCharacterIds: charStore.characters.map((c) => c.id),
    })

    if (plan.kind === 'error') {
      setGroupError(set, plan.reason === 'no_speaker' ? '未指定发言角色' : '发言角色不存在')
      markUserMsgSent(userMsg.id)
      return
    }

    if (plan.kind === 'single') {
      // mention/polling: 单个角色回复
      const speaker = charStore.characters.find(c => c.id === plan.speakerId)
      if (!speaker) {
        setGroupError(set, '发言角色不存在')
        markUserMsgSent(userMsg.id)
        return
      }

      // H-11 修复：进入流式前同步置位 isStreaming——否则置位要等 streamGroupAI 内部
      // 多次 await（含语义检索网络往返）之后，窗口期再次回车会并发第二个流
      // （覆盖模块级 activeStream，首流占位消息永久残留）。
      // S11：early-return 时 try/finally 复位 isStreaming，避免输入区卡死
      set({ isStreaming: true })
      try {
        await streamGroupAI(set, get, currentGroup, currentSessionId, speaker, userMsg.round, async () => {
          // AI 回复完成后，更新用户消息状态
          markUserMsgSent(userMsg.id)
          // onComplete: polling 模式下自动下一轮；未排定下一轮即已轮到用户
          // checkPollingContinue 是 async：必须 await 后再判断，否则 Promise 恒为真值
          const scheduled = currentGroup.chatMode === 'polling' && currentGroup.autoMode
            ? await checkPollingContinue(set, get, currentGroup)
            : false
          if (!scheduled) { await finishGroupSpatialBurst(currentGroup.id, currentSessionId); maybeGenerateGroupDirections(set, get) }
          // 自动记忆检查
          checkAutoMemory(get)
        })
      } finally {
        // S11：未挂上 activeStream 时兜底复位（内部 failEarly 已复位 early-return）
        if (!getActiveStream() && get().isStreaming) {
          set({ isStreaming: false, currentStreamingCharId: null })
        }
      }
    } else {
      // free 模式：AI 一次返回多角色回复
      // H-11 修复：同 mention/polling，进入流式前同步置位 isStreaming 防双流并发
      // S11：early-return 时 try/finally 复位 isStreaming
      set({ isStreaming: true })
      try {
        await streamGroupAIFree(set, get, currentGroup, currentSessionId, userMsg.round)
      } finally {
        if (!getActiveStream() && get().isStreaming) {
          set({ isStreaming: false, currentStreamingCharId: null })
        }
      }
      markUserMsgSent(userMsg.id)
      // free 模式一次返回多角色回复，完成后即轮到用户
      maybeGenerateGroupDirections(set, get)
      // 自动记忆检查
      checkAutoMemory(get)
    }
  },

  sendPollingRound: async (charId) => {
    const state = get()
    const { currentGroup, currentSessionId } = state
    if (!currentGroup || !currentSessionId || state.isStreaming) return

    // 验证角色属于当前群聊
    if (!currentGroup.memberIds.includes(charId)) return

    const charStore = useCharacterStore.getState()
    const speaker = charStore.characters.find(c => c.id === charId)
    if (!speaker) return

    const currentRound = nextGroupRound(state.messages.map((m) => m.round))

    // S11：与 sendMessage 一致——先置位 isStreaming，early-return 由 try/finally 复位
    set({ isStreaming: true, currentStreamingCharId: charId })
    try {
      await streamGroupAI(set, get, currentGroup, currentSessionId, speaker, currentRound, async () => {
        // checkPollingContinue 是 async：必须 await 后再判断，否则 Promise 恒为真值
        const scheduled = await checkPollingContinue(set, get, currentGroup)
        if (!scheduled) { await finishGroupSpatialBurst(currentGroup.id, currentSessionId); maybeGenerateGroupDirections(set, get) }
        checkAutoMemory(get)
      })
    } finally {
      if (!getActiveStream() && get().isStreaming) {
        set({ isStreaming: false, currentStreamingCharId: null })
      }
    }
  },

  triggerCharacterReply: async (charId) => {
    const state = get()
    const { currentGroup, currentSessionId } = state
    if (!currentGroup || !currentSessionId) {
      setGroupError(set, '请先选择一个群聊会话')
      return
    }
    if (state.isStreaming) return
    if (!currentGroup.memberIds.includes(charId)) {
      setGroupError(set, '该角色不在当前群聊中')
      return
    }

    const speaker = useCharacterStore.getState().characters.find((character) => character.id === charId)
    if (!speaker) {
      setGroupError(set, '未找到要接话的角色')
      return
    }

    const currentRound = nextGroupRound(state.messages.map((message) => message.round))

    // 即时接话是一次性的人工触发：只做记忆检查，不调用 checkPollingContinue；完成后即轮到用户。
    await streamGroupAI(set, get, currentGroup, currentSessionId, speaker, currentRound, async () => {
      await finishGroupSpatialBurst(currentGroup.id, currentSessionId)
      maybeGenerateGroupDirections(set, get)
      checkAutoMemory(get)
    })
  },

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

  stopStreaming: () => {
    // 阶段7：用户停止经终止状态机抢占（claimGroupUserStop），
    // 同一 requestId 的迟到 chunk/done/timeout 全部被忽略，不会二次落盘。
    const claimed = claimGroupUserStop()
    clearPollingTimer()
    const spatialOwner = get()
    if (spatialOwner.currentGroup && spatialOwner.currentSessionId) void finishGroupSpatialBurst(spatialOwner.currentGroup.id, spatialOwner.currentSessionId)
    if (claimed) {
      window.api.ai.cancelChat(claimed.requestId, 'user').catch((e) => logError('GroupChatStore:cancelChat', e))
    } else {
      // 收尾管线补尾期间停止：立即取消补尾并保留稳定前缀（阶段7 §8.1）
      abortActiveTailRepair()
    }
    const msgId = claimed?.msgId ?? ''
    const accumulated = claimed?.accumulated ?? ''

    // 重生成停止不是“保留半截新回复”，而是撤回本次生成并恢复旧消息。
    if (claimed?.regenerationObserver) {
      set({ isStreaming: false, currentStreamingCharId: null })
      void claimed.regenerationObserver.onTerminal(false)
      return
    }

    const { currentGroup, currentSessionId, messages } = get()
    // S2：保留用户看到的内容，停止提示走 generationNotice（不拼进正文）
    const clean = preserveGroupReplyContent(accumulated)

    if (msgId && clean && currentGroup && currentSessionId) {
      // M-22 修复：流式消息可能已被删除（deleteMessage 无 isStreaming 防护）——
      // 找不到时跳过持久化，避免 {...undefined} 展开出无 id/characterId 的损坏消息被 append 落盘
      const existing = messages.find(m => m.id === msgId)
      if (!existing) {
        set({ isStreaming: false, currentStreamingCharId: null })
        return
      }
      // S7：free 半截正文禁止挂 __free__ 落盘——走 splitAndSaveMessages 或回落首成员
      if (existing.characterId === '__free__' || claimed?.isFree) {
        set({ isStreaming: false, currentStreamingCharId: null })
        void persistPartialGroupReply({
          set,
          get: get as GroupStoreGet,
          group: currentGroup,
          sessionId: currentSessionId,
          msgId,
          content: clean,
          round: existing.round,
          characterId: existing.characterId,
          isFree: true,
          offstageCharacterIds: claimed?.offstageCharacterIds,
          narrativeMode: existing.narrativeMode ?? resolveNarrativeMode(undefined),
          noticeFields: { generationNotice: '已停止生成' },
        })
        return
      }
      // 有部分内容，持久化并保留
      const updatedMsg: GroupMessage = {
        ...existing,
        content: clean,
        generationNotice: '已停止生成',
      }
      set((s) => ({
        messages: s.messages.map((m: GroupMessage) => m.id === msgId ? updatedMsg : m),
        isStreaming: false,
        currentStreamingCharId: null,
      }))
      window.api.group.saveMessage(currentGroup.id, currentSessionId, updatedMsg).catch((e) => logError('GroupChatStore:saveMessage', e))
    } else if (msgId) {
      // 无内容，移除占位消息
      set((s) => ({
        messages: s.messages.filter((m: GroupMessage) => m.id !== msgId),
        isStreaming: false,
        currentStreamingCharId: null,
      }))
    } else {
      set({ isStreaming: false, currentStreamingCharId: null })
    }
  },

  // ---- 群聊上下文构建 ----

  buildGroupContext: (targetCharId?, preset?, opts?) => {
    const result = buildGroupChatContext(get, targetCharId, preset, {
      ...opts,
      lorebookDiagnosticsMode: opts?.trackUsage === false ? opts.lorebookDiagnosticsMode : 'live',
    })
    const group = get().currentGroup
    const sid = get().currentSessionId
    if (group && sid && opts?.trackUsage !== false) {
      set({
        lastLorebookDiagnostics: result.lorebookDiagnostics ?? null,
        lastLorebookDiagnosticsSessionId: sid,
      })
      // 阶段二B：本轮触发的世界书条目 key 追加到当前群聊会话 recency 窗口（环形缓冲 + 持久化）
      const cur = get().sessions.find(s => s.id === sid)
      const nextRecent = appendRecentTriggeredIds(cur?.recentTriggeredIds, result.lorebookTriggeredIds ?? [], LOREBOOK_RECENCY_WINDOW)
      const nextCache = touchCompressionCache(cur?.lorebookCompressionCache, result.lorebookCompressionCacheHitKeys ?? [])
      const patch = {
        recentTriggeredIds: nextRecent,
        ...(result.lorebookTimedEffects ? { lorebookTimedEffects: result.lorebookTimedEffects } : {}),
        ...(nextCache !== cur?.lorebookCompressionCache ? { lorebookCompressionCache: nextCache } : {}),
      }
      set(s => ({ sessions: s.sessions.map(ss => ss.id === sid ? { ...ss, ...patch } : ss) }))
      window.api.group.updateSession(group.id, sid, patch).catch(() => { /* 忽略 */ })
      // 阶段三：世界书超限压缩（非阻塞，失败静默降级为直接裁剪）
      if (result.lorebookCompressions?.length) {
        fireGroupLorebookCompression(get, set, group.id, sid, result.lorebookCompressions)
      }
    }
    return result.messages
  },
  buildGroupContextReport: (targetCharId?, preset?) => {
    return buildGroupChatContext(get, targetCharId, preset, {
      trackUsage: false,
      lorebookDiagnosticsMode: 'preview',
    })
  },
}))

/**
 * UEX-P1-12：「停剩余」语义化别名——停止后续成员接力，保留已生成内容。
 * 与 stopStreaming 完全同义（clearPollingTimer 已连带取消后续接力、半截正文按原语义落盘），
 * 仅为群调度条提供语义入口；不改动群聊收尾管线（abandonActiveStream/persistPartialGroupReply/splitAndSaveMessages）。
 */
export function stopRemainingSpeakers(): void {
  useGroupChatStore.getState().stopStreaming()
}

/**
 * 群聊世界书超限压缩（阶段三）：异步 AI 压缩被丢弃条目并写入会话缓存（内存 + 持久化）。
 * 下一轮同一集合再被丢弃时以缓存摘要注入；无 API 连接时静默跳过（降级为直接裁剪）。
 */
function fireGroupLorebookCompression(
  get: () => GroupChatState,
  set: (partial: Partial<GroupChatState> | ((s: GroupChatState) => Partial<GroupChatState>)) => void,
  groupId: string,
  sessionId: string,
  requests: NonNullable<GroupContextBuildResult['lorebookCompressions']>,
): void {
  const settingsStore = useSettingsStore.getState()
  const profile = settingsStore.getActiveProfile()
  // 无 API 连接（且非本地服务）时不发起压缩：条目直接裁剪
  if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) return
  Promise.all(requests.map((request) => compressLorebookOverflow(request, {
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.model,
  }, { kind: 'group', groupId, sessionId }))).then((results) => {
    const successful = results.filter((res) => !!res)
    if (successful.length === 0) return
    if (get().currentSessionId !== sessionId || get().currentGroup?.id !== groupId) return
    const cur = get().sessions.find(s => s.id === sessionId)
    let nextCache = cur?.lorebookCompressionCache
    for (const res of successful) {
      if (res) nextCache = upsertCompressionCache(nextCache, res.key, res.entry)
    }
    set(s => ({ sessions: s.sessions.map(ss => ss.id === sessionId ? { ...ss, lorebookCompressionCache: nextCache } : ss) }))
  }).catch(() => { /* 忽略 */ })
}

import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { GroupMessage } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { applyRegexRules as applyRegexRulesEngine } from '../utils/regex'
import { lorebookCache } from '../utils/lorebook'
import { STREAM_IDLE_TIMEOUT_MS, translationMaxTokens } from './chatConstants'
import { logError } from '../lib/logger'
import { nextLoadRequestId, currentLoadRequestId, invalidateGroupDerivedMemory } from './chatUtils'
import {
  streamGroupAI, streamGroupAIFree, checkPollingContinue, checkAutoMemory,
  cleanupActiveStream, clearPollingTimer, getActiveStream,
} from './groupStreamController'
import { buildGroupChatContext } from './groupChatContext'
import { runGroupMemorySummary } from './groupMemoryManager'
import type { GroupChatState } from './groupChatTypes'

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
  _semanticLoreHits: [],
  _semanticFactsHits: [],

  // ---- 群聊列表 ----

  loadGroups: async () => {
    const groups = await window.api.group.list()
    set({ groupChats: groups })
  },

  setCurrentGroup: (group) => {
    set({ currentGroup: group })
  },

  saveGroup: async (group) => {
    await window.api.group.save(group)
    const groups = await window.api.group.list()
    set({ groupChats: groups, currentGroup: group })
  },

  deleteGroup: async (id) => {
    clearPollingTimer()
    cleanupActiveStream()
    await window.api.group.delete(id)
    const groups = await window.api.group.list()
    set({ groupChats: groups, currentGroup: null, messages: [], sessions: [], currentSessionId: null })
  },

  selectGroup: async (groupId) => {
    clearPollingTimer()
    cleanupActiveStream()
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
      await get().loadMessages(groupId, sessions[0].id)
    }
  },

  createSession: async (groupId) => {
    clearPollingTimer()
    cleanupActiveStream()
    const session = await window.api.group.createSession(groupId)
    const sessions = await window.api.group.listSessions(groupId)
    set({ sessions, currentSessionId: session.id, messages: [], isStreaming: false, currentStreamingCharId: null })
  },

  switchSession: async (groupId, sessionId) => {
    clearPollingTimer()
    cleanupActiveStream()
    set({ currentSessionId: sessionId, isStreaming: false, currentStreamingCharId: null })
    await get().loadMessages(groupId, sessionId)
  },

  deleteSession: async (groupId, sessionId) => {
    clearPollingTimer()
    cleanupActiveStream()
    await window.api.group.deleteSession(groupId, sessionId)
    const sessions = await window.api.group.listSessions(groupId)
    const newSid = sessions[0]?.id ?? null
    set({ sessions, currentSessionId: newSid, messages: [], isStreaming: false, currentStreamingCharId: null })
    if (newSid) {
      await get().loadMessages(groupId, newSid)
    }
  },

  renameSession: async (groupId, sessionId, title) => {
    await window.api.group.renameSession(groupId, sessionId, title)
    const sessions = await window.api.group.listSessions(groupId)
    set({ sessions })
  },

  // ---- 消息 ----

  loadMessages: async (groupId, sessionId) => {
    // NEW-M10 修复：竞态防护——快速切换会话时，丢弃过期请求的结果
    const currentLoadId = nextLoadRequestId()
    // 会话切换：清空当前列表，避免显示旧会话消息
    set({ messages: [], _semanticLoreHits: [], _semanticFactsHits: [] })
    const messages = await window.api.group.listMessages(groupId, sessionId)
    // 期间又发起了新的加载请求则放弃本次结果
    if (currentLoadId !== currentLoadRequestId()) return
    set({ messages, _semanticLoreHits: [], _semanticFactsHits: [] })
  },

  clearMessages: () => {
    set({ messages: [], error: null, _semanticLoreHits: [], _semanticFactsHits: [] })
  },

  clearChat: async (groupId) => {
    // 停止正在进行的流式生成和轮询
    clearPollingTimer()
    cleanupActiveStream()
    const { currentSessionId } = get()
    if (currentSessionId) {
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
    await window.api.group.editMessage(groupId, sessionId, messageId, content)
    set(s => ({
      messages: s.messages.map(m =>
        m.id === messageId ? { ...m, content, translation: undefined, _showTranslation: false } : m
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
    // 不能重新生成用户消息
    if (targetMsg.characterId === '__user__' || targetMsg.characterId === '__free__') return
    const charStore = useCharacterStore.getState()
    const speaker = charStore.characters.find(c => c.id === targetMsg.characterId)
    if (!speaker) return

    // 删除旧 AI 回复
    await window.api.group.deleteMessage(currentGroup.id, currentSessionId, messageId)
    // 先从 UI 移除（无论上下文是否变化）
    set(s => ({
      messages: s.messages.filter(m => m.id !== messageId),
    }))

    // NEW-3 修复：await 期间用户可能已切换群聊/会话，校验后中止重新生成
    const fresh = get()
    if (fresh.currentGroup?.id !== currentGroup.id || fresh.currentSessionId !== currentSessionId) {
      set({ error: '群聊已切换，未触发重新生成' })
      return
    }

    // 重新生成
    await streamGroupAI(set, get, currentGroup, currentSessionId, speaker, targetMsg.round, () => {
      if (currentGroup.chatMode === 'polling' && currentGroup.autoMode) {
        checkPollingContinue(set, get, currentGroup)
      }
      checkAutoMemory(get)
    })
  },

  translateMessage: async (messageId) => {
    const state = get()
    const msg = state.messages.find(m => m.id === messageId)
    if (!msg || !msg.content) return

    const settingsStore = useSettingsStore.getState()
    const profile = settingsStore.getActiveProfile()
    if (!profile) return

    // 如果已有翻译，切换显示/隐藏
    if (msg.translation && msg.translation !== '...') {
      set(s => ({
        messages: s.messages.map(m =>
          m.id === messageId ? { ...m, _showTranslation: !m._showTranslation } : m
        ),
      }))
      return
    }
    // M-21 修复：翻译进行中（in-flight 标记 '...'）防重——重复点击不再并发两个请求互相覆盖
    if (msg.translation === '...') return

    // 设置加载状态
    set(s => ({
      messages: s.messages.map(m =>
        m.id === messageId ? { ...m, translation: '...' } : m
      ),
    }))

    // H-08 修复：使用 IPC 而非直接 fetch，避免 API Key 暴露和 CORS 问题
    const requestId = `group-translate-${messageId}-${Date.now()}`
    let result = ''

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
      armTranslateTimeout() // M-21：收到 chunk 续期空闲超时
    })

    const unbindDone = window.api.ai.onDone((doneId) => {
      if (doneId !== requestId) return
      clearTranslateTimeout()
      unbindChunk(); unbindDone(); unbindError()

      const finalResult = (result || '').replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim() || null
      // 空结果（推理模型思考内容耗尽 maxTokens 等）：不标记显示译文，避免 UI 显示原文却残留已翻译状态
      set((s) => ({
        messages: s.messages.map((m: GroupMessage) =>
          m.id === messageId ? { ...m, translation: finalResult, _showTranslation: finalResult ? true : false } : m
        ),
      }))
      // 持久化翻译结果
      const { currentGroup, currentSessionId, messages: curMsgs } = get()
      const updatedMsg = curMsgs.find(m => m.id === messageId)
      if (currentGroup && currentSessionId && updatedMsg) {
        window.api.group.saveMessage(currentGroup.id, currentSessionId, updatedMsg).catch((e) => logError('GroupChatStore:saveMessage', e))
      }
    })

    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      clearTranslateTimeout()
      unbindChunk(); unbindDone(); unbindError()

      set((s) => ({
        messages: s.messages.map((m: GroupMessage) =>
          m.id === messageId ? { ...m, translation: null } : m
        ),
      }))
    })

    // 超时保护：空闲超时自动清理（M-21 修复：收到 chunk 续期，长文本慢模型不再被一次性 60s 误杀）
    let translateTimeout: ReturnType<typeof setTimeout> | null = null
    const clearTranslateTimeout = () => {
      if (translateTimeout) { clearTimeout(translateTimeout); translateTimeout = null }
    }
    const armTranslateTimeout = () => {
      clearTranslateTimeout()
      translateTimeout = setTimeout(() => {
        unbindChunk(); unbindDone(); unbindError()
        window.api.ai.cancelChat(requestId).catch((e) => logError('GroupChatStore:cancelChat', e))
        set((s) => ({
          messages: s.messages.map((m: GroupMessage) =>
            m.id === messageId ? { ...m, translation: null } : m
          ),
        }))
      }, STREAM_IDLE_TIMEOUT_MS)
    }
    armTranslateTimeout()

    const targetLang = useSettingsStore.getState().settings.translationTargetLang || '中文'
    window.api.ai.chat({
      requestId,
      messages: [
        { role: 'system', content: `你是一个翻译助手。请将以下内容翻译成${targetLang}。只输出翻译结果，不要添加任何解释。` },
        { role: 'user', content: msg.content },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
      temperature: 0.3,
      topP: 1,
      maxTokens: translationMaxTokens(msg.content),
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
    }).catch(() => {
      clearTranslateTimeout()
      unbindChunk(); unbindDone(); unbindError()
      set((s) => ({
        messages: s.messages.map((m: GroupMessage) =>
          m.id === messageId ? { ...m, translation: null } : m
        ),
      }))
    })
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
      set({ error: '正在生成回复中，请稍候或点击停止' })
      return
    }

    const settingsStore = useSettingsStore.getState()
    const profile = settingsStore.getActiveProfile()
    if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
      set({ error: '请先在设置中配置 API 连接' })
      return
    }

    // 1. 用户消息
    const currentRound = state.messages.length > 0
      ? Math.max(...state.messages.map(m => m.round), 0) + 1
      : 1

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
      set({ error: '群聊已切换，消息未发送' })
      return
    }
    // 检测 @提及的角色 ID（从群成员名中匹配）
    const mentionedCharacterIds: string[] = []
    const charStore = useCharacterStore.getState()
    for (const memberId of currentGroup.memberIds) {
      const member = charStore.characters.find(c => c.id === memberId)
      if (member && content.includes(`@${member.name}`)) {
        mentionedCharacterIds.push(memberId)
      }
    }

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
    }
    set(s => ({ messages: [...s.messages, userMsg], error: null }))
    await window.api.group.saveMessage(currentGroup.id, currentSessionId, userMsg)

    // BUG-08：等待保存期间群聊可能已切换——从当前 UI 移除占位消息并中止 AI 回复
    // （已保存的用户消息仍保留在发起时的群聊数据中，切回后可见，不丢数据）
    if (!isContextValid()) {
      set((s) => ({ messages: s.messages.filter((m) => m.id !== userMsg.id) }))
      set({ error: '群聊已切换，未触发 AI 回复' })
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

    // 2. 根据模式获取 AI 回复
    const mode = currentGroup.chatMode

    if (mode === 'mention' || mode === 'polling') {
      // mention/polling: 单个角色回复
      let speakerId = targetCharId

      if (mode === 'polling' || !speakerId) {
        const speakerIdx = currentGroup.currentSpeakerIndex % currentGroup.memberIds.length
        speakerId = currentGroup.memberIds[speakerIdx]
      }

      if (!speakerId) {
        set({ error: '未指定发言角色' })
        markUserMsgSent(userMsg.id)
        return
      }

      const speaker = charStore.characters.find(c => c.id === speakerId)
      if (!speaker) {
        set({ error: '发言角色不存在' })
        markUserMsgSent(userMsg.id)
        return
      }

      // H-11 修复：进入流式前同步置位 isStreaming——否则置位要等 streamGroupAI 内部
      // 多次 await（含语义检索网络往返）之后，窗口期再次回车会并发第二个流
      // （覆盖模块级 activeStream，首流占位消息永久残留）。
      set({ isStreaming: true })
      await streamGroupAI(set, get, currentGroup, currentSessionId, speaker, userMsg.round, () => {
        // AI 回复完成后，更新用户消息状态
        markUserMsgSent(userMsg.id)
        // onComplete: polling 模式下自动下一轮
        if (currentGroup.chatMode === 'polling' && currentGroup.autoMode) {
          checkPollingContinue(set, get, currentGroup)
        }
        // 自动记忆检查
        checkAutoMemory(get)
      })
    } else {
      // free 模式：AI 一次返回多角色回复
      // H-11 修复：同 mention/polling，进入流式前同步置位 isStreaming 防双流并发
      set({ isStreaming: true })
      await streamGroupAIFree(set, get, currentGroup, currentSessionId, userMsg.round)
      markUserMsgSent(userMsg.id)
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

    const currentRound = state.messages.length > 0
      ? Math.max(...state.messages.map(m => m.round), 0) + 1
      : 1

    await streamGroupAI(set, get, currentGroup, currentSessionId, speaker, currentRound, () => {
      checkPollingContinue(set, get, currentGroup)
      checkAutoMemory(get)
    })
  },

  /** 插入角色消息（不触发 AI 回复，用于开场白等） */
  insertCharacterMessage: async (charId, content) => {
    const { currentGroup, currentSessionId, messages } = get()
    if (!currentGroup || !currentSessionId) return

    const currentRound = messages.length > 0
      ? Math.max(...messages.map(m => m.round), 0) + 1
      : 1

    const msg: GroupMessage = {
      id: nanoid(),
      groupId: currentGroup.id,
      characterId: charId,
      content,
      images: [],
      timestamp: Date.now(),
      round: currentRound,
    }
    set(s => ({ messages: [...s.messages, msg] }))
    await window.api.group.saveMessage(currentGroup.id, currentSessionId, msg)
  },

  stopStreaming: () => {
    const stream = getActiveStream()
    const requestId = stream?.requestId ?? ''
    const msgId = stream?.msgId ?? ''
    const accumulated = stream?.accumulated ?? ''
    cleanupActiveStream()
    clearPollingTimer()
    if (requestId) {
      window.api.ai.cancelChat(requestId).catch((e) => logError('GroupChatStore:cancelChat', e))
    }

    const { currentGroup, currentSessionId, messages } = get()
    const clean = accumulated.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()

    if (msgId && clean && currentGroup && currentSessionId) {
      // M-22 修复：流式消息可能已被删除（deleteMessage 无 isStreaming 防护）——
      // 找不到时跳过持久化，避免 {...undefined} 展开出无 id/characterId 的损坏消息被 append 落盘
      const existing = messages.find(m => m.id === msgId)
      if (!existing) {
        set({ isStreaming: false, currentStreamingCharId: null })
        return
      }
      // 有部分内容，持久化并保留
      const updatedMsg: GroupMessage = {
        ...existing,
        content: clean + '\n\n⚠️ 已停止生成',
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

  buildGroupContext: (targetCharId?, preset?) => {
    return buildGroupChatContext(get, targetCharId, preset)
  },
}))

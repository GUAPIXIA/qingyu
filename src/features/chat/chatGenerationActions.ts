/**
 * 单聊生成动作实现（结构阶段 4B）。
 *
 * 覆盖：发送消息（旧流式链路 + V2 chatTask 链路）、停止生成、重生成/续写/Swipe 委托、
 * 上下文构建入口。V2 任务句柄与停止竞态收口（UEX-P0-04）随发送动作一起归本模块。
 * 页面消费仍走 `src/store/useChatStore.ts` 的稳定状态入口（该文件组合注入本模块）。
 */
import { nanoid } from 'nanoid'
import type { Message } from '../../../shared/types'
import { resolveMessageSpeakerKind } from '../../../shared/messageIdentity'
import { resolveNarrativeMode } from '../../../shared/narrativeMode'
import { resolveDialogueDirectionsEnabled } from '../../../shared/dialogueDirections'
import { isLocalProvider, isLocalUrl } from '../../utils/defaults'
import { logError } from '../../lib/logger'
import { flushSpatialBoard } from '../../lib/spatialFlush'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { pushToast } from '../../store/useToastStore'
import {
  streamAIResponse, cleanupActiveStream, finalizeNoticeFields, claimUserStop,
  abortActiveTailRepair, maybeAutoTitle,
} from '../../store/streamController'
import { regenerateChatMessage, continueChatMessage, swipeChatMessage } from '../../store/chatGeneration'
import { buildChatContext, buildChatContextReport } from '../../store/chatContext'
import { maybeRunAutoMemorySummary } from '../../store/memoryManager'
import {
  generateSingleDialogueDirections,
  clearSessionDialogueDirections,
} from '../../store/dialogueDirectionRunner'
import type { ChatStoreGet, ChatStoreSet, ChatStoreState } from './chatStoreTypes'

export type ChatGenerationActions = Pick<ChatStoreState,
  | 'sendMessage' | 'stopStreaming' | 'regenerateMessage' | 'continueMessage'
  | 'swipeMessage' | 'buildContext' | 'buildContextReport'>

/** S5：V2 生成句柄（taskId + 订阅/轮询清理），stopStreaming 按 engine 分流 */
let activeV2Handle: {
  taskId: string
  unsub?: () => void
  clearPoll?: () => void
} | null = null

/**
 * UEX-P0-04：V2 停止后的占位落盘收口（防磁盘重复条目）。
 * V2 占位仅落屏、由 Orchestrator 幂等落盘；但「停止」与「任务恰好完成并提交」存在竞态
 * （轮询最长 1s 延迟内点停止），此时再 saveMessage 占位会与 Orchestrator 提交的消息重复。
 * - 已提交（终态快照带 assistantMessageId）→ 不再落盘占位，UI 占位并入已落盘 id（后续编辑不产生第二条）；
 * - 未提交（取消中断、Orchestrator 不落盘）→ 渲染层兜底保存已见正文，保证停止不丢内容。
 */
async function persistV2StoppedMessage(
  set: ChatStoreSet,
  stopped: Message,
  taskId: string,
  canceling: Promise<{ assistantMessageId?: string } | null>,
): Promise<void> {
  let committedId: string | undefined
  try {
    const cancelSnap = await canceling
    committedId = cancelSnap?.assistantMessageId
    if (!committedId) {
      // 取消与提交的收口顺序不保证，再查一次任务快照兜底
      committedId = (await window.api.chatTask?.get?.(taskId))?.assistantMessageId ?? undefined
    }
  } catch { /* 查询失败不阻塞兜底落盘 */ }
  if (committedId) {
    const persistedId = committedId
    set((s) => ({
      messages: s.messages.map((m) => (m.id === stopped.id ? { ...stopped, id: persistedId } : m)),
    }))
    return
  }
  await window.api.chat.saveMessage(stopped).catch(() => { /* ignore */ })
}

export function createChatGenerationActions(set: ChatStoreSet, get: ChatStoreGet): ChatGenerationActions {
  return {
    sendMessage: async (content, images, character, preset, _lorebooks, replyToId, generationKind = 'manual') => {
      const spatialSid = get().currentSessionId
      let spatialRead: import('../../../shared/spatial').SpatialContext | null | undefined
      if (spatialSid) {
        try {
          await flushSpatialBoard()
          const spatial = await window.api.spatial.readContext(character.id, spatialSid)
          spatialRead = spatial
          if (get().currentSessionId !== spatialSid) throw new Error('会话已切换，消息未发送')
          if (spatial?.characterOffstage && resolveNarrativeMode(get().sessions.find(session => session.id === spatialSid)?.narrativeMode) === 'immersive') throw new Error('当前角色位于“不参与对话”区域，请先调整位置或关闭对话读取位置')
          if (spatial) {
            const { syncBuildData } = await import('../../context/rendererContextProvider')
            const { buildContextMessagesFromData } = await import('../../../shared/chat-core/contextBuilder')
            const data = syncBuildData(character, preset)
            data.spatialContext = spatial
            data.chat = { ...data.chat, messages: [...data.chat.messages, { id: 'spatial-send-preflight', sessionId: spatialSid, characterId: character.id, role: 'user', content, images, isEditing: false, timestamp: Date.now() }] }
            buildContextMessagesFromData(data, { lorebookDiagnosticsMode: 'preview' })
            if (get().currentSessionId !== spatialSid) throw new Error('会话已切换，消息未发送')
          }
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          set({ error: message })
          pushToast({ variant: 'error', title: '消息未发送', description: message, requestId: 'chat-error' })
          return false
        }
      }
      // V12-11: flag 隔离，新链路走 Orchestrator（带流式占位）
      try {
        const { useChatTaskStore } = await import('../../store/chatTaskStore')
        if (useChatTaskStore.getState().chatEngineV2 && (window as unknown as { api?: { chatTask?: unknown } }).api?.chatTask) {
          const curSid = get().currentSessionId
          if (curSid) {
            // 用户已发送：上一轮的方向作废，与用户消息同帧移除
            void clearSessionDialogueDirections(set, get, curSid)
            const narrativeMode = resolveNarrativeMode(get().sessions.find((session) => session.id === curSid)?.narrativeMode)
            // 乐观消息仅落屏，不落盘（由 Orchestrator 按 requestId 幂等落盘，避免双写）
            const userMsgId = nanoid()
            const userMsg = { id: userMsgId, sessionId: curSid, characterId: character.id, role: 'user' as const, content, images: images ?? [], isEditing: false, timestamp: Date.now(), replyToId: replyToId ?? undefined, narrativeMode, speakerKind: resolveMessageSpeakerKind({ role: 'user', narrativeMode }), generationKind }
            set((s) => ({ messages: [...s.messages, userMsg] }))
            // 创建 AI 占位（流式期间也走语义分块样式）
            const aiMsgId = nanoid()
            const aiPlaceholder = { id: aiMsgId, sessionId: curSid, characterId: character.id, role: 'assistant' as const, content: '', images: [], isEditing: false, timestamp: Date.now(), narrativeMode, speakerKind: 'character' as const, generationKind: 'assistant_reply' as const, contentRenderMode: 'blocks' as const }
            set((s) => ({ messages: [...s.messages, aiPlaceholder], isStreaming: true }))
            // 提交任务并订阅流式事件
            const { submitChatTask, subscribeTaskEvents } = await import('../../store/chatTaskStore')
            const task = await submitChatTask(curSid, content, character.id, generationKind)
            // 关联占位与任务，便于后续更新
            const unsub = subscribeTaskEvents(task.taskId, (delta) => {
              set((s) => {
                const idx = s.messages.findIndex((m) => m.id === aiMsgId)
                if (idx < 0) return {}
                const next = s.messages.slice()
                next[idx] = { ...next[idx], content: (next[idx].content ?? '') + delta }
                return { messages: next }
              })
            })
            // 轮询终态（简化：1s 后拉一次，实际靠 chatTask:event 推送）
            let pollTimer: ReturnType<typeof setInterval> | null = null
            activeV2Handle = {
              taskId: task.taskId,
              unsub,
              clearPoll: () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } },
            }
            pollTimer = setInterval(async () => {
              if (!activeV2Handle || activeV2Handle.taskId !== task.taskId) return
              try {
                const snap = await (window as unknown as { api: { chatTask: { get: (id: string) => Promise<import('../../../shared/chat-core/events').TaskSnapshot> } } }).api.chatTask.get(task.taskId)
                if (snap.state === 'completed' || snap.state === 'failed' || snap.state === 'cancelled' || snap.state === 'interrupted') {
                  clearInterval(pollTimer!)
                  unsub()
                  activeV2Handle = null
                  set({
                    isStreaming: false,
                    ...(snap.state === 'failed' || snap.state === 'interrupted'
                      ? { error: snap.error?.message || '生成失败，请重试' }
                      : {}),
                  })
                  // 终态后重载消息文件（S6：仅仍停留在该会话才写 UI，避免切会话串台）
                  const msgs = await window.api.chat.listMessages(character.id, curSid)
                  // UEX-P0-05：S6 会话守卫 + 角色/视图一致性双守卫（对齐 addStandaloneMessage 的 visibleCharacterId 模式）：
                  // 磁盘由 Orchestrator 幂等落盘，这里只决定是否写 UI——会话或角色已切走则只落盘不写 UI
                  const visibleCharacterId = useCharacterStore.getState().currentCharacter?.id
                  const stillInView = get().currentSessionId === curSid
                    && (!visibleCharacterId || visibleCharacterId === character.id)
                  if (stillInView) {
                    set({ messages: msgs as unknown as typeof get extends () => infer T ? T extends { messages: infer M } ? M : never : never })
                  }
                  // V2 链路自动长记忆：对齐旧链路 sendMessage 完成后的挂接；仅在生成成功时检查
                  // 间隔阈值，消息已按落盘内容重载，游标统计基于持久化 id。
                  if (snap.state === 'completed' && stillInView) {
                    // 新版主聊天完成后与旧链路一致触发自动标题；
                    // 标题请求只追加当前预设的 jailbreak，不注入预设其他正文。
                    void maybeAutoTitle(get, set, character, preset)
                    // “下一步方向”：落盘后按持久化 id 取最后一条有效 AI 回复生成，失败静默降级。
                    const session = get().sessions.find((item) => item.id === curSid)
                    if (resolveDialogueDirectionsEnabled(session)) {
                      const lastReply = [...get().messages].reverse().find(
                        (message) => message.role === 'assistant' && !!message.content?.trim(),
                      )
                      if (lastReply) {
                        void generateSingleDialogueDirections(set, get, { messageId: lastReply.id, character })
                      }
                    }
                    maybeRunAutoMemorySummary(get, set, character).catch((e) => logError('ChatStore:memorySummary', e))
                  }
                }
              } catch { /* ignore */ }
            }, 1000)
            return true
          }
        }
      } catch { /* fallback to legacy path */ }
      // 流式中拒绝：现在给一个错误提示而不是静默忽略
      if (get().isStreaming) {
        set({ error: '正在生成回复中，请稍候或点击停止' })
        pushToast({ variant: 'warning', title: '正在生成回复中，请稍候或点击停止', requestId: 'chat-error' })
        return false
      }

      const settingsStore = useSettingsStore.getState()
      const profile = settingsStore.getActiveProfile()

      if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
        set({ error: '请先在设置中配置 API 连接' })
        pushToast({ variant: 'error', title: '请先在设置中配置 API 连接', description: '打开「模型 → 对话 API」完成配置', requestId: 'chat-error' })
        return false
      }

      // 确保 currentSessionId 有效（不再用 'default' 兜底）
      let currentSid = get().currentSessionId
      if (!currentSid) {
        // 自动创建一个会话
        const session = await window.api.chat.createSession(character.id)
        const sessions = await window.api.chat.listSessions(character.id)
        set({ sessions, currentSessionId: session.id })
        currentSid = session.id
      }

      // 用户已发送：上一轮的方向作废，与用户消息同帧移除
      void clearSessionDialogueDirections(set, get, currentSid)

      // 加载正则规则并对输入应用
      let processedContent = content
      try {
        const regexRules = await window.api.regex.list()
        if (regexRules.length > 0) {
          processedContent = get().applyRegex(content, 'input', regexRules)
        }
      } catch { /* 忽略正则加载失败 */ }

      // BUG-08 单聊版修复：await 期间用户可能已切换会话，
      // 中止发送避免用户消息被追加到错误会话的 UI（磁盘仍按捕获的 currentSid 保存）
      if (get().currentSessionId !== currentSid) {
        set({ error: '会话已切换，消息未发送' })
        pushToast({ variant: 'warning', title: '会话已切换，消息未发送', requestId: 'chat-error' })
        return false
      }

      // 添加用户消息
      const userMessage: Message = {
        id: nanoid(),
        sessionId: currentSid,
        characterId: character.id,
        role: 'user',
        content: processedContent,
        images,
        isEditing: false,
        timestamp: Date.now(),
        replyToId: replyToId ?? undefined,
        narrativeMode: resolveNarrativeMode(get().sessions.find((session) => session.id === currentSid)?.narrativeMode),
        speakerKind: resolveMessageSpeakerKind({
          role: 'user',
          narrativeMode: resolveNarrativeMode(get().sessions.find((session) => session.id === currentSid)?.narrativeMode),
        }),
        generationKind,
      }
      set((state) => ({ messages: [...state.messages, userMessage], error: null }))
      await window.api.chat.saveMessage(userMessage)

      // 保存期间可能又切换了会话：从当前 UI 移除占位消息并中止 AI 回复
      // （消息已保存到发起时会话，切回后可见，不丢数据）
      if (get().currentSessionId !== currentSid) {
        set((state) => ({ messages: state.messages.filter((m) => m.id !== userMessage.id) }))
        set({ error: '会话已切换，未触发 AI 回复' })
        pushToast({ variant: 'warning', title: '会话已切换，未触发 AI 回复', requestId: 'chat-error' })
        return true // 用户消息已入列，仅 AI 未触发
      }

      // 构建 AI 消息占位（创建时即标记语义分块：流式期间与完成后样式一致）
      const aiMessageId = nanoid()
      const aiMessage: Message = {
        id: aiMessageId,
        sessionId: currentSid, // 修复：使用 currentSid 而非 character.id
        characterId: character.id,
        role: 'assistant',
        content: '',
        images: [],
        isEditing: false,
        timestamp: Date.now(),
        narrativeMode: resolveNarrativeMode(get().sessions.find((session) => session.id === currentSid)?.narrativeMode),
        speakerKind: 'character',
        generationKind: 'assistant_reply',
        contentRenderMode: 'blocks',
      }
      set((state) => ({
        messages: [...state.messages, aiMessage],
        isStreaming: true,
      }))

      // 调用公共流式方法
      await streamAIResponse(set, get, {
        aiMessageId,
        character,
        preset,
        inputText: processedContent,
        ...(spatialSid === currentSid ? { spatialContext: spatialRead } : {}),
        onComplete: async (fullContent, meta) => {
          // M-18 修复：空回复/手动中止——移除占位消息，避免 UI 残留空气泡且不落盘
          if (!fullContent) {
            set((state) => ({ messages: state.messages.filter((m) => m.id !== aiMessageId) }))
            return
          }

          // S1：output 正则与停止字符串已由统一收尾管线执行（每条消息仅一次），
          // 此处不再重复应用。
          const finalContent = fullContent
          // 更新 UI 中的消息内容
          const currentMsg = get().messages.find(m => m.id === aiMessageId) ?? aiMessage
          const finalMsg: Message = {
            ...currentMsg,
            content: finalContent,
            // 阶段3：收尾状态——"已恢复"走中性提示（generationNotice），失败走 generationError
            ...finalizeNoticeFields(meta),
            spatialGenerationId: meta.spatialGenerationId,
            contentRenderMode: 'blocks' as const,
          }
          set((s) => ({
            messages: s.messages.map((m) => (m.id === aiMessageId ? finalMsg : m)),
          }))
          await window.api.chat.saveMessage(finalMsg)

          // “下一步方向”：主回复落盘后异步生成，失败静默降级，不影响正文。
          const session = get().sessions.find((item) => item.id === finalMsg.sessionId)
          if (resolveDialogueDirectionsEnabled(session)) {
            void generateSingleDialogueDirections(set, get, { messageId: aiMessageId, character })
          }

          // 自动长记忆：成功提交后才推进消息游标；失败会保留重试机会。
          maybeRunAutoMemorySummary(get, set, character).catch((e) => logError('ChatStore:memorySummary', e))
        },
        onError: (errMsg, terminal) => {
          // 阶段7：错误文案绝不写进正文（旧「⚠️ 错误」落盘行为移除）。
          // terminal.content = 经过统一收尾管线的稳定正文（方案 §4.1 矩阵）；
          // 无可用正文时不保存 AI 消息，只保留 store.error 与重试入口。
          const state = get()
          const aiMsg = state.messages.find((m) => m.id === aiMessageId)
          if (!aiMsg) return
          const updatedMsg: Message | null = terminal?.content
            ? {
                ...aiMsg,
                content: terminal.content,
                // 提示字段由统一协调入口生成（generationError 与正文分离）
                ...(terminal.noticeFields.generationError ? { generationError: terminal.noticeFields.generationError } : {}),
                ...(terminal.noticeFields.generationNotice ? { generationNotice: terminal.noticeFields.generationNotice } : {}),
                contentRenderMode: 'blocks' as const,
              }
            : null
          if (!updatedMsg) {
            set((s) => ({ messages: s.messages.filter((m) => m.id !== aiMessageId) }))
            return
          }
          window.api.chat.saveMessage(updatedMsg).catch((e) => logError('ChatStore:saveMessage', e))
          set((s) => ({
            messages: s.messages.map((m) => (m.id === aiMessageId ? updatedMsg : m)),
          }))
        },
      })
      return true
    },

    stopStreaming: () => {
      // S5：V2 任务取消（chatTask.cancel + 清理 poll/unsub，禁止再走 ai.cancelChat）
      if (activeV2Handle) {
        const handle = activeV2Handle
        activeV2Handle = null
        try { handle.unsub?.() } catch { /* ignore */ }
        try { handle.clearPoll?.() } catch { /* ignore */ }
        const canceling = window.api.chatTask?.cancel?.(handle.taskId).catch(() => null) ?? Promise.resolve(null)
        set({ isStreaming: false, currentRequestId: null })
        // 保留已见正文 + 中性提示
        const msgs = get().messages
        const lastAi = [...msgs].reverse().find((m) => m.role === 'assistant')
        if (lastAi && lastAi.content) {
          const stopped: Message = {
            ...lastAi,
            generationNotice: '已停止生成',
            contentRenderMode: 'blocks' as const,
          }
          set((s) => ({ messages: s.messages.map((m) => (m.id === lastAi.id ? stopped : m)) }))
          // UEX-P0-04：V2 占位按「仅落屏、由 Orchestrator 幂等落盘」设计，停止与任务完成存在竞态，
          // 直接 saveMessage 可能与 Orchestrator 已提交的消息在磁盘重复——落盘交给幂等收口判定
          void persistV2StoppedMessage(set, stopped, handle.taskId, canceling)
        }
        return
      }
      // 阶段7：用户手动停止经终止状态机抢占（claimUserStop），
      // 同一 requestId 的迟到 chunk/done/error 全部被忽略，不会二次落盘。
      const stoppedStream = claimUserStop()
      if (stoppedStream) {
        window.api.ai.cancelChat(stoppedStream.requestId, 'user').catch(() => { /* ignore */ })
        // 保留用户已经看到的正文并标记中性提示（矩阵 §4.1；accumulated 比节流后的 UI 更完整）
        const msg = get().messages.find((m) => m.id === stoppedStream.aiMessageId)
        const content = stoppedStream.content.trim() || (msg?.content ?? '')
        if (msg && content) {
          const stopped: Message = {
            ...msg,
            content,
            generationNotice: '已停止生成',
            contentRenderMode: 'blocks' as const,
          }
          set((s) => ({ messages: s.messages.map((m) => (m.id === stoppedStream.aiMessageId ? stopped : m)) }))
          window.api.chat.saveMessage(stopped).catch(() => { /* ignore */ })
        }
      } else {
        // 收尾管线补尾期间停止：立即取消补尾并保留稳定前缀（§8.1）
        if (!abortActiveTailRepair()) {
          const requestId = get().currentRequestId
          if (requestId) window.api.ai.cancelChat(requestId, 'user').catch(() => { /* ignore */ })
        }
      }
      // 兜底重置状态（防止 cancelChat IPC 失败导致卡住）
      cleanupActiveStream()
      if (get().isStreaming) {
        set({ isStreaming: false, currentRequestId: null })
      }
    },

    regenerateMessage: (messageId, character, preset, _lorebooks) =>
      regenerateChatMessage(set, get, messageId, character, preset, _lorebooks),

    /** 继续续写：让 AI 从截断处继续生成，创建新消息气泡 */
    continueMessage: (messageId, character, preset, _lorebooks) =>
      continueChatMessage(set, get, messageId, character, preset, _lorebooks),

    /** 切换当前消息的候选回复 */
    swipeMessage: (messageId, direction, _character) =>
      swipeChatMessage(set, get, messageId, direction, _character),

    buildContext: (character, preset, opts) => {
      return buildChatContext(get, set, character, preset, opts)
    },
    buildContextReport: (character, preset, opts) => {
      return buildChatContextReport(character, preset, opts)
    },
  }
}
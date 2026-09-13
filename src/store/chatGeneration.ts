/**
 * 单聊"生成类"方法（regenerate/continue/swipe）
 * 从 useChatStore 提取，行为不变：通过 set/get 闭包访问 store 状态与方法。
 */
import type { Character, Message, Preset } from '../../shared/types'
import { nanoid } from 'nanoid'
import {
  stripThought,
  stripVendorThinking,
  trimContinuationSeam,
  normalizeRoleplayDialoguePrefixes,
} from '../utils/messagePostProcess'
import { logError } from '../lib/logger'
import { streamAIResponse, finalizeNoticeFields } from './streamController'
import type { ChatState } from './chatTypes'
import { maybeRunAutoMemorySummary } from './memoryManager'
import { invalidateDerivedMemory } from './chatUtils'
import { resolveNarrativeMode } from '../../shared/narrativeMode'
import { resolveMessageSpeakerKind } from '../../shared/messageIdentity'
import { resolveDialogueDirectionsEnabled } from '../../shared/dialogueDirections'
import { generateSingleDialogueDirections, cancelDialogueDirectionRequests } from './dialogueDirectionRunner'

/** 从消息上移除方向字段（正文被替换时必须失效）。 */
function withoutDirections<T extends Message>(message: T): T {
  if (!message.dialogueDirections && !message.dialogueDirectionsGeneratedAt) return message
  const next = { ...message }
  delete next.dialogueDirections
  delete next.dialogueDirectionsGeneratedAt
  return next
}

/** 生成完成后按会话开关异步补齐方向（不阻塞、失败静默）。 */
function maybeGenerateDirections(set: SetFn, get: GetFn, messageId: string, character: Character): void {
  const message = get().messages.find((item) => item.id === messageId)
  if (!message) return
  const session = get().sessions.find((item) => item.id === message.sessionId)
  if (!resolveDialogueDirectionsEnabled(session)) return
  void generateSingleDialogueDirections(set, get, { messageId, character })
}

type SetFn = (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void
type GetFn = () => ChatState

/** Swipe 重生成：不删除原消息，追加新候选到 swipes 数组 */
export async function regenerateChatMessage(
  set: SetFn,
  get: GetFn,
  messageId: string,
  character: Character,
  preset: Preset | null,
  _lorebooks: unknown,
): Promise<void> {
  // 流式中拒绝：给提示
  if (get().isStreaming) {
    set({ error: '正在生成回复中，请稍候' })
    return
  }

  const messages = get().messages
  const idx = messages.findIndex((m) => m.id === messageId)
  if (idx < 0) return
  const targetMsg = messages[idx]
  if (targetMsg.role !== 'assistant') return

  // 候选回复会改写既有历史，先撤销从旧版本历史推导出的记忆。
  const invalidated = await invalidateDerivedMemory(get, character)
  if (invalidated) {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === invalidated.sessionId ? { ...session, ...invalidated.patch } : session,
      ),
    }))
  }

  // Swipe 策略：不删除原消息，而是追加新候选到 swipes 数组
  const swipes = targetMsg.swipes ?? [targetMsg.content]
  const newSwipeIndex = swipes.length

  // 正文即将被替换：旧方向失效并取消在途请求
  cancelDialogueDirectionRequests([messageId])

  // 在 UI 中先插入一个空候选，让用户看到正在生成
  const updatedMsg: Message = {
    ...withoutDirections(targetMsg),
    swipes: [...swipes, ''],
    swipeIndex: newSwipeIndex,
    content: '',
    narrativeMode: resolveNarrativeMode(
      targetMsg.narrativeMode,
      get().sessions.find((session) => session.id === targetMsg.sessionId)?.narrativeMode,
    ),
    speakerKind: resolveMessageSpeakerKind(targetMsg),
    generationKind: 'regenerate',
  }
  set((state) => ({
    messages: state.messages.map((m) => (m.id === messageId ? updatedMsg : m)),
    isStreaming: true,
    error: null,
  }))

  // 调用公共流式方法（复用同一消息 ID）
  await streamAIResponse(set, get, {
    aiMessageId: messageId,
    character,
    preset,
    generationType: 'regenerate',
    onComplete: async (fullContent, meta) => {
      // M-18 修复：空回复/手动中止——移除占位消息（regenerate 路径）
      if (!fullContent) {
        set((state) => ({ messages: state.messages.filter((m) => m.id !== messageId) }))
        return
      }

      // S1：output 正则与停止字符串已由统一收尾管线执行
      let finalContent = fullContent

      // 阶段6灰度：旧链路恢复说话人前缀补齐
      if (meta.legacy) {
        finalContent = normalizeRoleplayDialoguePrefixes(
          finalContent,
          character.translatedContent?.name || character.name,
          updatedMsg.narrativeMode ?? 'immersive',
        )
      }
      const curMsg = get().messages.find(m => m.id === messageId)
      if (!curMsg?.swipes) return
      const newSwipes = [...curMsg.swipes]
      newSwipes[newSwipeIndex] = finalContent
      const finalMsg: Message = {
        ...curMsg,
        swipes: newSwipes,
        swipeIndex: newSwipeIndex,
        content: finalContent,
        // 阶段3：新候选的收尾状态覆盖旧提示（成功生成清空上一轮失败/提示）
        ...finalizeNoticeFields(meta),
        // 阶段5：新内容使用语义分块渲染；legacy 不标记
        ...(meta.legacy ? {} : { contentRenderMode: 'blocks' as const }),
      }
      set((s) => ({
        messages: s.messages.map(m => m.id === messageId ? finalMsg : m),
      }))
      window.api.chat.saveMessage(finalMsg).catch((e) => logError('ChatStore:saveMessage', e))

      maybeGenerateDirections(set, get, messageId, character)
      maybeRunAutoMemorySummary(get, set, character).catch((e) => logError('ChatStore:memorySummary', e))
    },
    onError: (errMsg, terminal) => {
      // 阶段7：错误文案不写入候选正文（矩阵 §4.1）。
      // 有收束后的稳定正文 → 保存该正文 + generationError；
      // 无可用正文 → 撤销本轮追加的空候选（不创建空 AI 消息）。
      const curMsg = get().messages.find(m => m.id === messageId)
      if (!curMsg?.swipes) return
      if (!terminal?.content) {
        const newSwipes = curMsg.swipes.slice(0, newSwipeIndex)
        if (newSwipes.length === 0) {
          set((s) => ({ messages: s.messages.filter(m => m.id !== messageId) }))
          return
        }
        const reverted: Message = {
          ...withoutDirections(curMsg),
          swipes: newSwipes,
          swipeIndex: newSwipes.length - 1,
          content: newSwipes[newSwipes.length - 1],
        }
        set((s) => ({ messages: s.messages.map(m => m.id === messageId ? reverted : m) }))
        window.api.chat.saveMessage(reverted).catch((e) => logError('ChatStore:saveMessage', e))
        void errMsg
        return
      }
      const newSwipes = [...curMsg.swipes]
      newSwipes[newSwipeIndex] = terminal.content
      const finalMsg: Message = {
        ...curMsg,
        swipes: newSwipes,
        swipeIndex: newSwipeIndex,
        content: terminal.content,
        ...(terminal.noticeFields.generationError ? { generationError: terminal.noticeFields.generationError } : {}),
        ...(terminal.noticeFields.generationNotice ? { generationNotice: terminal.noticeFields.generationNotice } : {}),
        // 阶段5：中断保留的候选与正常完成一致走语义分块；legacy 不标记
        ...(terminal.legacy ? {} : { contentRenderMode: 'blocks' as const }),
      }
      set((s) => ({ messages: s.messages.map(m => m.id === messageId ? finalMsg : m) }))
      window.api.chat.saveMessage(finalMsg).catch((e) => logError('ChatStore:saveMessage', e))
    },
  })
}

/** 继续续写：让 AI 从截断处继续生成，创建新消息气泡 */
export async function continueChatMessage(
  set: SetFn,
  get: GetFn,
  messageId: string,
  character: Character,
  preset: Preset | null,
  _lorebooks: unknown,
): Promise<void> {
  // 流式中拒绝
  if (get().isStreaming) {
    set({ error: '正在生成回复中，请稍候' })
    return
  }

  const messages = get().messages
  const idx = messages.findIndex((m) => m.id === messageId)
  if (idx < 0) return
  const targetMsg = messages[idx]
  if (targetMsg.role !== 'assistant') return

  // 确保是最后一条消息
  if (idx !== messages.length - 1) return

  // 续写必须延续目标消息的叙事身份；仅旧消息缺少记录时才回退当前会话模式。
  const continuationNarrativeMode = resolveNarrativeMode(
    targetMsg.narrativeMode,
    get().sessions.find((session) => session.id === targetMsg.sessionId)?.narrativeMode,
  )

  // 创建新的 AI 消息气泡（不复用原消息）
  // 创建时即标记语义分块：流式期间与完成后样式一致，避免续写气泡 100% 走 Markdown 无样式
  const newMsgId = nanoid()
  const newMessage: Message = {
    id: newMsgId,
    sessionId: targetMsg.sessionId,
    characterId: character.id,
    role: 'assistant',
    content: '',
    images: [],
    isEditing: false,
    timestamp: Date.now(),
    narrativeMode: continuationNarrativeMode,
    speakerKind: resolveMessageSpeakerKind(targetMsg),
    generationKind: 'message_continue',
    contentRenderMode: 'blocks',
  }

  set((state) => ({
    messages: [...state.messages, newMessage],
    isStreaming: true,
    error: null,
  }))

  // 调用公共流式方法（流式到新气泡，气泡只含续写部分，原消息保持不变）
  // 新内容清洗：丢弃供应商推理 → output 正则 → 复述前缀去重（跳过角色 thought 块）
  // 心理描写保留：续写是独立气泡，thought 块与普通消息一样交给渲染层提取展示
  const cleanContinuation = async (raw: string): Promise<string> => {
    const processed = stripVendorThinking(raw)
    // 正文为空（模型只输出了 thought）视为无有效续写
    if (!stripThought(processed)) return ''
    // S1：output 正则与停止字符串已由统一收尾管线执行
    // S4：复述前缀去重使用续写接缝专用策略（与输入框续写、Bridge 同一入口），只作用于正文，跳过开头 thought 块
    const leadMatch = processed.match(/^\s*(?:<thought>[\s\S]*?<\/thought>\s*)+/i)
    const lead = leadMatch ? leadMatch[0] : ''
    const body = trimContinuationSeam(targetMsg.content || '', processed.slice(lead.length))
    if (!body.trim()) return ''
    return lead ? lead.trimEnd() + '\n\n' + body : body
  }

  // 将清洗后的续写内容写入新气泡并持久化；内容为空则移除占位气泡
  let continueLegacy = false
  const finalizeContinuation = (content: string): boolean => {
    if (!content) {
      set((s) => ({ messages: s.messages.filter(m => m.id !== newMsgId) }))
      return false
    }
    const curMsg = get().messages.find(m => m.id === newMsgId)
    if (!curMsg) return false
    // 阶段5：续写新内容使用语义分块渲染；legacy 不标记
    // 无论占位是否已带 blocks，完成后统一按管线结果重写，避免 legacy 误标
    const finalMsg: Message = {
      ...curMsg,
      content,
      ...(continueLegacy
        ? { contentRenderMode: undefined }
        : { contentRenderMode: 'blocks' as const }),
    }
    if (continueLegacy) delete (finalMsg as Message).contentRenderMode
    set((s) => ({
      messages: s.messages.map(m => m.id === newMsgId ? finalMsg : m),
    }))
    window.api.chat.saveMessage(finalMsg).catch((e) => logError('ChatStore:saveMessage', e))
    return true
  }

  await streamAIResponse(set, get, {
    aiMessageId: newMsgId,
    character,
    preset,
    continuation: true,
    narrativeMode: continuationNarrativeMode,
    generationType: 'continue',
    onComplete: async (newContent, meta) => {
      continueLegacy = meta.legacy === true
      const processed = await cleanContinuation(newContent)
      if (!finalizeContinuation(processed)) {
        if (newContent) set({ error: '模型未输出有效续写内容' })
        return
      }

      maybeGenerateDirections(set, get, newMsgId, character)
      maybeRunAutoMemorySummary(get, set, character).catch((e) => logError('ChatStore:memorySummary', e))
    },
    onError: (errMsg, terminal) => {
      // 阶段7：续写中断的半截正文同样必须先经过统一收尾管线（streamController 已收口），
      // 不再直接保存流式原文；无稳定正文则移除占位气泡，不创建空消息。
      continueLegacy = terminal?.legacy === true
      const partial = terminal?.content || ''
      if (!partial.trim()) {
        set((s) => ({ messages: s.messages.filter(m => m.id !== newMsgId) }))
        return
      }
      cleanContinuation(partial)
        .then((processed) => {
          if (!finalizeContinuation(processed)) return
          // generationError 与正文分离（错误文案不进复制/TTS/上下文）
          if (terminal?.noticeFields.generationError) {
            const curMsg = get().messages.find(m => m.id === newMsgId)
            if (curMsg) {
              const withError: Message = { ...curMsg, generationError: terminal.noticeFields.generationError }
              set((s) => ({ messages: s.messages.map(m => m.id === newMsgId ? withError : m) }))
              window.api.chat.saveMessage(withError).catch((e) => logError('ChatStore:saveMessage', e))
            }
          }
          set({ error: `续写中断，已保留完整部分（${errMsg}）` })
        })
        .catch((e) => logError('ChatStore:continueMessage', e))
    },
  })
}

/** 切换当前消息的候选回复（swipe） */
export async function swipeChatMessage(
  set: SetFn,
  get: GetFn,
  messageId: string,
  direction: number,
  character: Character,
): Promise<void> {
  const msg = get().messages.find(m => m.id === messageId)
  if (!msg?.swipes || msg.swipes.length < 2) return
  const curIdx = msg.swipeIndex ?? 0
  const newIdx = (curIdx + direction + msg.swipes.length) % msg.swipes.length
  // 正文切换到另一候选：旧方向失效并取消在途请求
  cancelDialogueDirectionRequests([messageId])
  const updatedMsg: Message = {
    ...withoutDirections(msg),
    swipeIndex: newIdx,
    content: msg.swipes[newIdx],
  }
  const invalidated = await invalidateDerivedMemory(get, character)
  if (invalidated) {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === invalidated.sessionId ? { ...session, ...invalidated.patch } : session,
      ),
    }))
  }
  set((s) => ({ messages: s.messages.map(m => m.id === messageId ? updatedMsg : m) }))
  await window.api.chat.saveMessage(updatedMsg)
  maybeGenerateDirections(set, get, messageId, character)
}

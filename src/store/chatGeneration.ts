/**
 * 单聊"生成类"方法（regenerate/continue/swipe）
 * 从 useChatStore 提取，行为不变：通过 set/get 闭包访问 store 状态与方法。
 */
import type { Character, Message, Preset } from '../../shared/types'
import { nanoid } from 'nanoid'
import { stripThought, normalizeThoughtTags, trimContinuationOverlap } from '../utils/messagePostProcess'
import { truncateAtStop, collectStopStrings } from '../utils/regex'
import { logError } from '../lib/logger'
import { streamAIResponse } from './streamController'
import type { ChatState } from './chatTypes'

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

  // Swipe 策略：不删除原消息，而是追加新候选到 swipes 数组
  const swipes = targetMsg.swipes ?? [targetMsg.content]
  const newSwipeIndex = swipes.length

  // 在 UI 中先插入一个空候选，让用户看到正在生成
  const updatedMsg: Message = {
    ...targetMsg,
    swipes: [...swipes, ''],
    swipeIndex: newSwipeIndex,
    content: '',
  }
  set((state) => ({
    messages: state.messages.map((m) => (m.id === messageId ? updatedMsg : m)),
    isStreaming: true,
    streamingContent: '',
    error: null,
  }))

  // 调用公共流式方法（复用同一消息 ID）
  await streamAIResponse(set, get, {
    aiMessageId: messageId,
    character,
    preset,
    onComplete: async (fullContent) => {
      if (!fullContent) return

      // 应用正则规则
      let finalContent = fullContent
      try {
        const regexRules = await window.api.regex.list()
        if (regexRules.length > 0) {
          finalContent = get().applyRegex(fullContent, 'output', regexRules)
          // 停止字符串：output 命中后终止生成并截断
          finalContent = truncateAtStop(finalContent, collectStopStrings(regexRules)).text
        }
      } catch { /* 忽略 */ }

      const curMsg = get().messages.find(m => m.id === messageId)
      if (!curMsg?.swipes) return
      const newSwipes = [...curMsg.swipes]
      newSwipes[newSwipeIndex] = finalContent
      const finalMsg: Message = {
        ...curMsg,
        swipes: newSwipes,
        swipeIndex: newSwipeIndex,
        content: finalContent,
      }
      set((s) => ({
        messages: s.messages.map(m => m.id === messageId ? finalMsg : m),
      }))
      window.api.chat.saveMessage(finalMsg).catch((e) => logError('ChatStore:saveMessage', e))

      // 自动长记忆检查：基于上次总结后的新消息数判断
      const { sessions: curSessions, currentSessionId: curSid } = get()
      const curSession = curSessions.find(s => s.id === curSid)
      if (curSession?.memoryEnabled && curSession.memoryMode === 'auto') {
        const allMsgs = get().messages.filter(m => m.content)
        // 统计上次总结后的新消息数
        const lastSummaryTime = curSession.memoryUpdatedAt || 0
        const newMsgCount = lastSummaryTime > 0
          ? allMsgs.filter(m => m.timestamp > lastSummaryTime).length
          : allMsgs.length
        const interval = curSession.autoMemoryInterval || 10
        if (newMsgCount >= interval) {
          get().triggerMemorySummary(character).catch((e) => logError('ChatStore:memorySummary', e))
        }
      }
    },
    onError: (errMsg) => {
      const curMsg = get().messages.find(m => m.id === messageId)
      if (!curMsg?.swipes) return
      const newSwipes = [...curMsg.swipes]
      newSwipes[newSwipeIndex] = `⚠️ ${errMsg}`
      const finalMsg: Message = {
        ...curMsg,
        swipes: newSwipes,
        swipeIndex: newSwipeIndex,
        content: newSwipes[newSwipeIndex],
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

  // 创建新的 AI 消息气泡（不复用原消息）
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
  }

  set((state) => ({
    messages: [...state.messages, newMessage],
    isStreaming: true,
    streamingContent: '',
    error: null,
  }))

  // 调用公共流式方法（流式到新气泡，气泡只含续写部分，原消息保持不变）
  // 新内容清洗：归一化 thought 标签 → output 正则 → 复述前缀去重（跳过 thought 块）
  // 心理描写保留：续写是独立气泡，thought 块与普通消息一样交给渲染层提取展示
  const cleanContinuation = async (raw: string): Promise<string> => {
    let processed = normalizeThoughtTags(raw)
    // 正文为空（模型只输出了 thought）视为无有效续写
    if (!stripThought(processed)) return ''
    try {
      const regexRules = await window.api.regex.list()
      if (regexRules.length > 0) {
        processed = get().applyRegex(processed, 'output', regexRules)
        // 停止字符串：output 命中后终止生成并截断
        processed = truncateAtStop(processed, collectStopStrings(regexRules)).text
      }
    } catch { /* 忽略 */ }
    // 复述前缀去重只作用于正文，跳过开头的 thought 块
    const leadMatch = processed.match(/^\s*(?:<thought>[\s\S]*?<\/thought>\s*)+/i)
    const lead = leadMatch ? leadMatch[0] : ''
    const body = trimContinuationOverlap(targetMsg.content || '', processed.slice(lead.length))
    if (!body.trim()) return ''
    return lead ? lead.trimEnd() + '\n\n' + body : body
  }

  // 将清洗后的续写内容写入新气泡并持久化；内容为空则移除占位气泡
  const finalizeContinuation = (content: string): boolean => {
    if (!content) {
      set((s) => ({ messages: s.messages.filter(m => m.id !== newMsgId) }))
      return false
    }
    const curMsg = get().messages.find(m => m.id === newMsgId)
    if (!curMsg) return false
    const finalMsg: Message = { ...curMsg, content }
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
    onComplete: async (newContent) => {
      const processed = await cleanContinuation(newContent)
      if (!finalizeContinuation(processed)) {
        if (newContent) set({ error: '模型未输出有效续写内容' })
        return
      }

      // 自动长记忆检查
      const { sessions: curSessions, currentSessionId: curSid } = get()
      const curSession = curSessions.find(s => s.id === curSid)
      if (curSession?.memoryEnabled && curSession.memoryMode === 'auto') {
        const allMsgs = get().messages.filter(m => m.content)
        const lastSummaryTime = curSession.memoryUpdatedAt || 0
        const newMsgCount = lastSummaryTime > 0
          ? allMsgs.filter(m => m.timestamp > lastSummaryTime).length
          : allMsgs.length
        const interval = curSession.autoMemoryInterval || 10
        if (newMsgCount >= interval) {
          get().triggerMemorySummary(character).catch((e) => logError('ChatStore:memorySummary', e))
        }
      }
    },
    onError: (errMsg) => {
      // 出错/超时：已流式出的部分内容保留（flushStream 已写入气泡），毫无内容才移除
      const partial = get().messages.find(m => m.id === newMsgId)?.content || ''
      if (!partial) {
        set((s) => ({ messages: s.messages.filter(m => m.id !== newMsgId) }))
        return
      }
      cleanContinuation(partial)
        .then((processed) => {
          if (finalizeContinuation(processed)) {
            set({ error: `续写中断，已保留部分内容（${errMsg}）` })
          }
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
  _character: Character,
): Promise<void> {
  const msg = get().messages.find(m => m.id === messageId)
  if (!msg?.swipes || msg.swipes.length < 2) return
  const curIdx = msg.swipeIndex ?? 0
  const newIdx = (curIdx + direction + msg.swipes.length) % msg.swipes.length
  const updatedMsg: Message = {
    ...msg,
    swipeIndex: newIdx,
    content: msg.swipes[newIdx],
  }
  set((s) => ({ messages: s.messages.map(m => m.id === messageId ? updatedMsg : m) }))
  await window.api.chat.saveMessage(updatedMsg)
}

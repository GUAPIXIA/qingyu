import { nanoid } from 'nanoid'
import type { AIFinishReason, Character, GroupChat, GroupMessage, NarrativeMode, RegexRule } from '../../../shared/types'
import type { GroupChatState, GroupStoreGet, GroupStoreSet } from './groupChatTypes'
import { useSettingsStore, type ActiveProfile } from '../../store/useSettingsStore'
import { useCharacterStore } from '../../store/useCharacterStore'
import { pushToast } from '../../store/useToastStore'
import { logError } from '../../lib/logger'
import { resolveNarrativeMode } from '../../../shared/narrativeMode'
import { splitFreeReply } from '../../../shared/chat-core/groupFreeSplit'
import { attemptTailRepair, finalizeNoticeFields, type GenerationOutcomeMeta } from '../../store/streamController'
import { finalizeGenerationTerminalResult, type GenerationTerminalOutcome } from '../../../shared/chat-core/generatedReplyPipeline'
import { terminationCauseFromFinishReason, terminationPromptWithoutContent, type GenerationTerminationLatch } from '../../../shared/generationTermination'
import type { GenerationTerminationCause } from '../../../shared/types'
import { finishGroupSpatialBurst } from '../../store/groupSpatialSync'
import { cleanupActiveStream, getActiveStream, type GroupRegenerationObserver } from './streamSession'

/** S7：拆分前 msgId/内容 hash 判重——同一半截正文只允许落盘/拆分一次 */
const freeSplitSeenKeys = new Set<string>()

/** 简单 djb2 指纹：仅用于同会话内防重复拆分，不作安全哈希 */
function contentFingerprint(msgId: string, content: string): string {
  let h = 5381
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0
  }
  return `${msgId}:${(h >>> 0).toString(16)}`
}

/** 测试用：清空判重集合 */
export function resetFreeSplitDedupe(): void {
  freeSplitSeenKeys.clear()
}

/** S7：拆分前按 msgId/内容 hash 判重；首次返回 true 并记账 */
export function claimFreeSplitOnce(msgId: string, content: string): boolean {
  const key = contentFingerprint(msgId, content)
  if (freeSplitSeenKeys.has(key)) return false
  freeSplitSeenKeys.add(key)
  return true
}

/**
 * S7：异常/停止/放弃时的半截正文落盘。
 * free（`__free__`）强制走 splitAndSaveMessages 或回落首成员，禁止持久化不可渲染的 `__free__` 正文。
 * 拆分前按 msgId/内容 hash 判重。
 */
export async function persistPartialGroupReply(input: {
  set: GroupStoreSet
  get: GroupStoreGet
  group: GroupChat
  sessionId: string
  msgId: string
  content: string
  round: number
  characterId: string
  isFree: boolean
  offstageCharacterIds?: string[]
  narrativeMode: NarrativeMode
  noticeFields?: { generationNotice?: string; generationError?: string }
}): Promise<void> {
  const clean = input.content
  if (!clean) return
  if (!claimFreeSplitOnce(input.msgId, clean)) return

  const isFreeBody = input.isFree || input.characterId === '__free__'
  if (isFreeBody) {
    await splitAndSaveMessages(input.set, input.get, input.group, input.sessionId, clean, input.round, input.msgId, {
      noticeFields: input.noticeFields,
      renderMode: { contentRenderMode: 'blocks' },
      offstageCharacterIds: input.offstageCharacterIds,
    })
    return
  }

  const renderMode = { contentRenderMode: 'blocks' as const }
  input.set((s: GroupChatState) => ({
    messages: s.messages.map((m: GroupMessage) =>
      m.id === input.msgId
        ? { ...m, content: clean, ...input.noticeFields, ...renderMode }
        : m,
    ),
    isStreaming: false,
    currentStreamingCharId: null,
  }))
  await window.api.group.saveMessage(input.group.id, input.sessionId, {
    id: input.msgId,
    groupId: input.group.id,
    characterId: input.characterId,
    content: clean,
    images: [],
    timestamp: Date.now(),
    round: input.round,
    narrativeMode: input.narrativeMode,
    ...input.noticeFields,
    ...renderMode,
  } as GroupMessage)
}

/**
 * 阶段4/7：群聊回复统一收尾（与单聊共用同一条协调入口，方案 §4.2 / §7.4）。
 * 返回 null 表示无可用正文（调用方走占位/错误分支）。
 */
export async function finalizeGroupReply(input: {
  rawText: string
  finishReason: AIFinishReason
  speaker: Character
  model: string
  temperature?: number
  regexRules: RegexRule[]
  profile?: ActiveProfile
  autoTailRepairEnabled?: boolean
}): Promise<{ content: string; noticeFields: { generationNotice?: string; generationError?: string }; stopped: boolean } | null> {
  const cause = terminationCauseFromFinishReason(input.finishReason)
  // 补尾限制（§8.1）：只有 provider_length 会被协调入口调用（每轮至多一次）
  const result = await finalizeGenerationTerminalResult({
    terminalResult: { rawText: input.rawText, finishReason: input.finishReason, terminationCause: cause },
    regexRules: input.regexRules,
    characterName: input.speaker.translatedContent?.name || input.speaker.name,
    runTailRepair: (input.autoTailRepairEnabled ?? useSettingsStore.getState().settings.autoTailRepairEnabled) === false ? undefined : (finalized) => attemptTailRepair({
      finalized,
      character: input.speaker,
      model: input.model,
      temperature: input.temperature,
      profile: input.profile,
    }),
  })
  if (!result.persistable || !result.content) return null

  const meta: GenerationOutcomeMeta = { finishReason: input.finishReason }
  if (result.notice) meta.notice = result.notice
  if (result.repairFailed) meta.repairFailed = true
  // 异常类提示（协调入口生成）优先；正常收尾走 finalizeNoticeFields 统一口径
  const noticeFields = Object.keys(result.noticeFields).length > 0
    ? result.noticeFields
    : finalizeNoticeFields(meta)
  return { content: result.content, noticeFields, stopped: cause === 'user_cancel' }
}

/**
 * UEX-P0-01：无正文终止失败（占位被移除、无存活气泡承载 generationError）时补全局 Toast，
 * 与 useGroupChatStore 的 setGroupError 模式对齐（store error 无 UI 直接订阅，不能静默）。
 */
function toastGroupGenerationFailure(detail: string): void {
  pushToast({ variant: 'error', title: '群聊生成失败', description: detail, requestId: 'group-generate-fail' })
}

/**
 * 阶段7：群聊异常统一收口（timeout / 普通 ai:error 共用，不复制保存逻辑）。
 * 规则（方案 §4.1/§4.3）：
 * - 只有 streaming 状态能抢占终止；迟到 chunk/done/error 一律忽略；
 * - 先读取完整 accumulated 文本，再清理监听器；
 * - 部分正文必须先经统一收尾管线（稳定边界收束、不补尾）才允许保存；
 * - 错误原因只写 generationError，绝不拼进 content（避免进入复制/TTS/上下文/记忆摘要）；
 * - 无可用正文时移除占位消息，不创建空 AI 消息。
 */
export async function handleGroupStreamException(input: {
  requestId: string
  msgId: string
  groupId: string
  sessionId: string
  characterId: string
  characterName: string
  narrativeMode: NarrativeMode
  regexRules: RegexRule[]
  round: number
  isFree: boolean
  offstageCharacterIds?: string[]
  latch?: GenerationTerminationLatch
  /** NEW-M12：错误后继续推进轮询链/自动记忆检查 */
  onChainContinue?: () => void
  /** S7：free 半截正文拆分落盘需要 group/get */
  group?: GroupChat
  get?: GroupStoreGet
  set: GroupStoreSet
  regenerationObserver?: GroupRegenerationObserver
}, cause: GenerationTerminationCause, detailMessage: string): Promise<void> {
  // 抢占终止权：已被其它终止分支（或用户停止）处理过则直接忽略
  const st = getActiveStream()
  if (st && st.requestId !== input.requestId) return
  if (input.latch && !input.latch.claim(cause)) return
  // 先取 accumulated 再清理（C-02 同款竞态保护；cleanup 同步合并未执行的 flush timer）
  const partialContent = st?.accumulated ?? ''
  input.offstageCharacterIds ??= st?.offstageCharacterIds
  cleanupActiveStream()
  if (cause === 'idle_timeout') {
    window.api.ai.cancelChat(input.requestId, 'timeout').catch((e) => logError('GroupChatStore:cancelChat', e))
  }

  const errText = terminationPromptWithoutContent(cause, detailMessage)
  if (input.regenerationObserver) {
    // 重生成失败不保留半截新回复：旧消息尚在持久层，直接撤回占位并恢复原文。
    input.set((s: GroupChatState) => ({
      messages: s.messages.filter((m: GroupMessage) => m.id !== input.msgId),
      isStreaming: false,
      currentStreamingCharId: null,
      error: errText,
    }))
    await input.regenerationObserver.onTerminal(false, [])
    return
  }
  try {
    const result = await finalizeGenerationTerminalResult({
      terminalResult: { rawText: partialContent, finishReason: 'unknown', terminationCause: cause, errorMessage: detailMessage },
      regexRules: input.regexRules,
      characterName: input.characterName,
    })
    await dispatchGroupTerminal(input, result, errText)
    if ((!input.onChainContinue || input.group?.chatMode !== 'polling' || !input.group?.autoMode) && input.group) await finishGroupSpatialBurst(input.group.id, input.sessionId)
    input.onChainContinue?.()
  } catch (e) {
    logError('GroupChatStore:terminalFinalize', e)
    input.latch?.markPersisted()
    input.set((s: GroupChatState) => ({
      messages: s.messages.filter((m: GroupMessage) => m.id !== input.msgId),
      isStreaming: false, currentStreamingCharId: null, error: errText,
    }))
    // UEX-P0-01：占位被移除、无存活气泡展示错误 → 补全局 Toast
    toastGroupGenerationFailure(errText)
    if ((!input.onChainContinue || input.group?.chatMode !== 'polling' || !input.group?.autoMode) && input.group) await finishGroupSpatialBurst(input.group.id, input.sessionId)
    input.onChainContinue?.()
  }
}

/** 终止派发：可保存正文 → 更新+落盘；无正文 → 移除占位（不创建空 AI 消息） */
async function dispatchGroupTerminal(input: Parameters<typeof handleGroupStreamException>[0], result: GenerationTerminalOutcome, errText: string) {
  input.latch?.markPersisted()
  const messageError = result.noticeFields.generationError ?? errText
  if (result.persistable && result.content) {
    // S7：free 半截正文禁止挂 __free__ 落盘——强制 splitAndSaveMessages 或回落首成员
    if (input.isFree || input.characterId === '__free__') {
      const group = input.group
      const get = input.get
      if (group && get) {
        await persistPartialGroupReply({
          set: input.set,
          get,
          group,
          sessionId: input.sessionId,
          msgId: input.msgId,
          content: result.content,
          round: input.round,
          characterId: input.characterId,
          isFree: true,
          offstageCharacterIds: input.offstageCharacterIds,
          narrativeMode: input.narrativeMode,
          noticeFields: result.noticeFields,
        })
        return
      }
      // 缺 group/get 时回落首成员；仍无成员则移除占位，绝不持久化 __free__
      const members = useCharacterStore.getState().characters.filter((c) =>
        (input.group?.memberIds ?? []).includes(c.id),
      )
      const fallbackId = members[0]?.id
      if (!fallbackId) {
        input.set((s: GroupChatState) => ({
          messages: s.messages.filter((m: GroupMessage) => m.id !== input.msgId),
          isStreaming: false, currentStreamingCharId: null, error: messageError,
        }))
        // UEX-P0-01：无成员可回落且占位被移除 → 补全局 Toast
        toastGroupGenerationFailure(messageError)
        return
      }
      input.characterId = fallbackId
      input.isFree = false
    }
    // 中断保留的正文与正常完成一致走语义分块。
    const renderMode = { contentRenderMode: 'blocks' as const }
    input.set((s: GroupChatState) => ({
      messages: s.messages.map((m: GroupMessage) =>
        m.id === input.msgId ? { ...m, content: result.content, ...result.noticeFields, ...renderMode } : m,
      ),
      isStreaming: false, currentStreamingCharId: null, error: messageError,
    }))
    await window.api.group.saveMessage(input.groupId, input.sessionId, {
      id: input.msgId, groupId: input.groupId, characterId: input.characterId,
      content: result.content, images: [], timestamp: input.get?.().messages.find((m: GroupMessage) => m.id === input.msgId && m.groupId === input.groupId)?.timestamp ?? Date.now(), round: input.round, narrativeMode: input.narrativeMode,
      ...result.noticeFields,
      ...renderMode,
    } as GroupMessage)
  } else {
    input.set((s: GroupChatState) => ({
      messages: s.messages.filter((m: GroupMessage) => m.id !== input.msgId),
      isStreaming: false, currentStreamingCharId: null, error: messageError,
    }))
    // UEX-P0-01：无正文终止失败、占位被移除 → 补全局 Toast
    toastGroupGenerationFailure(messageError)
  }
}

/**
 * S2 兼容入口：群聊超时统一处理——委托阶段7异常收口（idle_timeout）。
 */
export async function handleGroupStreamTimeout(input: {
  requestId: string
  msgId: string
  groupId: string
  sessionId: string
  characterId: string
  characterName: string
  narrativeMode: NarrativeMode
  regexRules: RegexRule[]
  round: number
  isFree: boolean
  latch?: GenerationTerminationLatch
  group?: GroupChat
  get?: GroupStoreGet
  set: GroupStoreSet
  regenerationObserver?: GroupRegenerationObserver
}): Promise<void> {
  await handleGroupStreamException(input, 'idle_timeout', '请求超时')
}

/** 解析 free 模式 AI 回复，拆分为多条角色消息 */
export async function splitAndSaveMessages(
  set: GroupStoreSet,
  get: GroupStoreGet,
  group: GroupChat,
  sessionId: string,
  content: string,
  round: number,
  placeholderId: string,
  extras?: { noticeFields?: { generationNotice?: string; generationError?: string }; renderMode?: { contentRenderMode: 'blocks' }; offstageCharacterIds?: string[]; spatialGroupGenerationId?: string },
): Promise<GroupMessage[]> {
  const narrativeMode = resolveNarrativeMode(get().sessions?.find((session) => session.id === sessionId)?.narrativeMode)
  const offstageCharacterIds = narrativeMode === 'immersive' ? extras?.offstageCharacterIds : undefined
  const charStore = useCharacterStore.getState()
  const members = group.memberIds
    .map(id => charStore.characters.find(c => c.id === id))
    .filter(Boolean) as Character[]

  if (offstageCharacterIds && group.memberIds.every(id => offstageCharacterIds!.includes(id))) {
    set(state => ({ messages: state.messages.filter(message => message.id !== placeholderId), isStreaming: false, currentStreamingCharId: null }))
    return []
  }

  // 拆分与归属：shared/chat-core/groupFreeSplit.ts 跨端一致（omniscient 不拆分、
  // 旁白并入首段、未识别角色旁注归属首成员、无标记回落首成员）
  const split = splitFreeReply({ content, members, narrativeMode })

  if (split.kind === 'narrator') {
    const narratorMessage: GroupMessage = {
      id: placeholderId,
      groupId: group.id,
      characterId: members.find(member => !offstageCharacterIds?.includes(member.id))?.id ?? split.messages[0].characterId,
      content: split.messages[0].content,
      images: [],
      timestamp: Date.now(),
      round,
      narrativeMode,
      speakerKind: 'character',
      ...(extras?.spatialGroupGenerationId ? { spatialGroupGenerationId: extras.spatialGroupGenerationId } : {}),
      generationKind: 'assistant_reply',
      ...(extras?.renderMode ?? {}),
      ...(extras?.noticeFields ?? {}),
    }
    await window.api.group.saveMessage(group.id, sessionId, narratorMessage)
    set((state: GroupChatState) => ({
      messages: state.messages.map((message: GroupMessage) => message.id === placeholderId ? narratorMessage : message),
      isStreaming: false,
      currentStreamingCharId: null,
    }))
    return [narratorMessage]
  }

  if (split.kind === 'fallback') {
    // 没有匹配到任何角色标记 → 将占位消息改为第一个成员的消息，避免渲染为不可见
    const fallbackChar = members.find(member => !offstageCharacterIds?.includes(member.id))
    // S7：禁止持久化不可渲染的 __free__ 正文——无成员时移除占位，不落盘
    if (!fallbackChar) {
      set((s: GroupChatState) => ({
        messages: s.messages.filter((m: GroupMessage) => m.id !== placeholderId),
        isStreaming: false, currentStreamingCharId: null,
      }))
      return []
    }
    set((s: GroupChatState) => ({
      messages: s.messages.map((m: GroupMessage) =>
        m.id === placeholderId
          ? { ...m, characterId: fallbackChar.id, content: split.messages[0].content, ...(extras?.renderMode ?? {}), ...(extras?.noticeFields ?? {}) }
          : m,
      ),
      isStreaming: false, currentStreamingCharId: null,
    }))
    // 持久化更新后的占位消息（归属首成员，绝不落盘 __free__）
    const fallbackMessage: GroupMessage = {
      id: placeholderId,
      groupId: group.id,
      characterId: fallbackChar.id,
      content: split.messages[0].content,
      images: [],
      timestamp: Date.now(),
      round,
      narrativeMode,
      speakerKind: 'character',
      ...(extras?.spatialGroupGenerationId ? { spatialGroupGenerationId: extras.spatialGroupGenerationId } : {}),
      generationKind: 'assistant_reply',
      ...(extras?.renderMode ?? {}),
      ...(extras?.noticeFields ?? {}),
    }
    await window.api.group.saveMessage(group.id, sessionId, fallbackMessage)
    return [fallbackMessage]
  }

  // 移除占位消息，替换为拆分的角色消息（过滤任何 __free__，禁止不可渲染正文落盘）
  const newMessages: GroupMessage[] = split.messages
    .filter((segment) => segment.characterId !== '__free__' && !offstageCharacterIds?.includes(segment.characterId) && !!segment.content?.trim())
    .map((segment) => ({
      id: nanoid(),
      groupId: group.id,
      characterId: segment.characterId,
      content: segment.content,
      images: [],
      timestamp: Date.now(),
      round,
      narrativeMode,
      speakerKind: 'character',
      ...(extras?.spatialGroupGenerationId ? { spatialGroupGenerationId: extras.spatialGroupGenerationId } : {}),
      generationKind: 'assistant_reply',
    }))

  // 阶段5：拆分出的新消息均为语义分块渲染；收尾提示附加在最后一条上
  if (extras?.renderMode) {
    for (const m of newMessages) m.contentRenderMode = extras.renderMode.contentRenderMode
  }
  if (extras?.noticeFields && newMessages.length > 0) {
    Object.assign(newMessages[newMessages.length - 1], extras.noticeFields)
  }

  // 持久化（优化：多条消息合并为一次批量保存，减少 IPC 往返与文件全量重写）
  if (newMessages.length === 1) {
    await window.api.group.saveMessage(group.id, sessionId, newMessages[0])
  } else if (newMessages.length > 1) {
    await window.api.group.saveMessagesBatch(group.id, sessionId, newMessages)
  }

  set((s: GroupChatState) => ({
    messages: s.messages
      .filter((m: GroupMessage) => m.id !== placeholderId)
      .concat(newMessages)
      .sort((a: GroupMessage, b: GroupMessage) => a.timestamp - b.timestamp),
    isStreaming: false,
    currentStreamingCharId: null,
  }))
  return newMessages
}
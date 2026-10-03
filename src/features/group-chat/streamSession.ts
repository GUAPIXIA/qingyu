import type { GroupMessage, NarrativeMode } from '../../../shared/types'
import type { GroupChatState, GroupStoreSet } from '../../store/groupChatTypes'
import type { GenerationTerminationLatch } from '../../../shared/generationTermination'
import { stripVendorThinking } from '../../../shared/chat-core/messagePostProcess'
import { logError } from '../../lib/logger'
import { pushToast } from '../../store/useToastStore'

// ====================== 流式状态管理（模块级） ======================

export interface ActiveStream {
  requestId: string
  msgId: string
  accumulated: string
  flushTimer: ReturnType<typeof setTimeout> | null
  unbindChunk: () => void
  unbindDone: () => void
  unbindError: () => void
  timeoutHandle: ReturnType<typeof setTimeout> | null
  /** 阶段7：requestId + terminalState 一次性终止状态机（迟到事件幂等） */
  latch: GenerationTerminationLatch
  /** 阶段7：停止字符串命中截断（随后的 cancelled done 按正常 stop 收口，不是用户停止） */
  stopStringsHit: boolean
  /** S8：abandon 保留半截正文时需要的落盘上下文 */
  characterId: string
  isFree: boolean
  offstageCharacterIds?: string[]
  groupId: string
  sessionId: string
  round: number
  narrativeMode: NarrativeMode
  /** 重生成专用：终态落盘完成后再替换旧消息；失败/停止时恢复原文。 */
  regenerationObserver?: GroupRegenerationObserver
}

export interface GroupRegenerationObserver {
  onTerminal: (success: boolean, generatedMessages?: readonly GroupMessage[]) => boolean | Promise<boolean>
}

let activeStream: ActiveStream | null = null

/** 挂载活动流（请求发起方在监听绑定完成后调用，终态收尾统一经此读写） */
export function attachActiveStream(stream: ActiveStream): void {
  activeStream = stream
}

/** 读取当前活动流（stopStreaming 等需要读取） */
export function getActiveStream(): ActiveStream | null {
  return activeStream
}

/**
 * 阶段7：用户手动停止的统一入口——抢占终止状态机并返回当前可见正文。
 * claim 失败（timeout/error/done 已进入收口）返回 null，调用方不得再触碰该消息；
 * 后续迟到 chunk/done/error 全部被状态机忽略，同一 requestId 最多落盘一次。
 */
export function claimGroupUserStop(): { requestId: string; msgId: string; accumulated: string; isFree: boolean; offstageCharacterIds?: string[]; regenerationObserver?: GroupRegenerationObserver } | null {
  const st = activeStream
  if (!st) return null
  if (!st.latch.claim('user_cancel')) return null
  const result = { requestId: st.requestId, msgId: st.msgId, accumulated: st.accumulated, isFree: st.isFree, offstageCharacterIds: st.offstageCharacterIds, regenerationObserver: st.regenerationObserver }
  cleanupActiveStream()
  return result
}

/** 终态收尾：清理刷新/超时计时器与全部监听器 */
export function cleanupActiveStream() {
  if (!activeStream) return
  clearTimeout(activeStream.flushTimer!)
  clearTimeout(activeStream.timeoutHandle!)
  activeStream.unbindChunk()
  activeStream.unbindDone()
  activeStream.unbindError()
  activeStream = null
}

/** 群聊回复与单聊保持一致：丢弃供应商推理，保留角色 <thought> 供气泡折叠展示。 */
export function preserveGroupReplyContent(content: string): string {
  return stripVendorThinking(content).trim()
}

/**
 * S8：切换/删除群聊或会话时的统一停止收尾（store 层入口专用）。
 * claim latch → preserveGroupReplyContent → cancelChat → cleanup。
 * preserve=true 时返回已清理正文供调用方落盘，并 toast「已保留未完成回复并停止生成」。
 * 控制器内部终态收尾仍可直接 cleanupActiveStream()。
 */
export function abandonActiveStream(options: { preserve: boolean }): {
  requestId: string
  msgId: string
  preserved: string
  characterId: string
  isFree: boolean
  offstageCharacterIds?: string[]
  round: number
  narrativeMode: NarrativeMode
  groupId: string
  sessionId: string
  regenerationObserver?: GroupRegenerationObserver
} | null {
  const st = activeStream
  if (!st) return null
  if (!st.latch.claim('user_cancel')) return null
  // 重生成被切换/删除打断时必须恢复旧消息，不能把半截新回复另行落盘。
  const preserved = options.preserve && !st.regenerationObserver ? preserveGroupReplyContent(st.accumulated) : ''
  const result = {
    requestId: st.requestId,
    msgId: st.msgId,
    preserved,
    characterId: st.characterId,
    isFree: st.isFree,
    offstageCharacterIds: st.offstageCharacterIds,
    round: st.round,
    narrativeMode: st.narrativeMode,
    groupId: st.groupId,
    sessionId: st.sessionId,
    regenerationObserver: st.regenerationObserver,
  }
  window.api.ai.cancelChat(result.requestId, 'user').catch((e) => logError('GroupChatStore:cancelChat', e))
  cleanupActiveStream()
  if (st.regenerationObserver) void st.regenerationObserver.onTerminal(false)
  if (options.preserve) {
    pushToast({ variant: 'info', title: '已保留未完成回复并停止生成' })
  }
  return result
}

/** 流式节流刷新：把累积正文写回占位消息（由 flushTimer 驱动） */
export function flushActiveStream(set: GroupStoreSet) {
  const st = activeStream
  if (!st) return
  const { msgId, accumulated } = st
  st.flushTimer = null
  set((s: GroupChatState) => ({
    messages: s.messages.map((m: GroupMessage) =>
      m.id === msgId ? { ...m, content: accumulated } : m,
    ),
  }))
}
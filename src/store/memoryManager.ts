import type { Character } from '../../shared/types'
import { MEMORY_SUMMARY_MIN } from './chatConstants'
import { friendlyError } from './chatUtils'
import { vectorizeSessionFacts } from './streamController'
import type { StoreGet, StoreSet } from './chatTypes'

/** 渲染层只维护交互状态；总结决策、模型调用与乐观提交统一由主进程负责。 */
const activeMemorySummaries = new Set<string>()

function skippedMessage(reason: string): string {
  if (reason === 'memory_disabled') return '长记忆未开启'
  if (reason === 'stale_version') return '长记忆已被其他操作更新，本次旧摘要未写入。请重试总结。'
  return '没有需要总结的新消息：游标之后的未总结内容不足'
}

export async function runMemorySummary(
  get: StoreGet,
  set: StoreSet,
  character: Character,
  options: { automatic?: boolean } = {},
): Promise<string | null> {
  const { currentSessionId, sessions } = get()
  const session = sessions.find((item) => item.id === currentSessionId)
  if (!currentSessionId || !session?.memoryEnabled) return null

  const summaryKey = `${character.id}:${currentSessionId}`
  if (activeMemorySummaries.has(summaryKey)) return null
  const reportFailure = (message: string) => {
    set({ error: message, memorySummaryError: { key: summaryKey, message } })
  }

  activeMemorySummaries.add(summaryKey)
  set({ summarizingMemoryKey: summaryKey, memorySummaryError: null })
  try {
    const result = await window.api.chat.summarizeMemory(
      character.id,
      currentSessionId,
      options.automatic === true,
    )
    if (result.status === 'skipped') {
      if (!options.automatic) reportFailure(skippedMessage(result.reason))
      // 主进程可能已在渲染层轮询前完成总结；此时第二次自动检查会因游标已推进而跳过，
      // 仍需刷新会话，避免界面继续展示旧记忆快照。
      if (options.automatic && get().currentSessionId === currentSessionId) {
        const refreshedSessions = await window.api.chat.listSessions(character.id)
        set({ sessions: refreshedSessions })
      }
      return null
    }

    set({ memorySummaryError: null })
    if (result.facts.length > 0) {
      vectorizeSessionFacts(character.id, currentSessionId, result.facts, result.memoryVersion)
    }
    if (get().currentSessionId === currentSessionId) {
      const refreshedSessions = await window.api.chat.listSessions(character.id)
      set({ sessions: refreshedSessions })
    }
    return result.summary || result.currentState || null
  } catch (error) {
    reportFailure(`长记忆总结失败：${friendlyError(error instanceof Error ? error.message : String(error))}`)
    return null
  } finally {
    activeMemorySummaries.delete(summaryKey)
    set((state) => state.summarizingMemoryKey === summaryKey ? { summarizingMemoryKey: null } : {})
  }
}

/**
 * 兼容仍走旧生成管线的入口。V2 对话由主进程在回复落盘后先行调度；这里再次调用时会
 * 复用主进程中的同一会话任务，不会产生第二次模型请求。
 */
export async function maybeRunAutoMemorySummary(
  get: StoreGet,
  set: StoreSet,
  character: Character,
): Promise<void> {
  const { currentSessionId, sessions, messages } = get()
  const session = sessions.find((item) => item.id === currentSessionId)
  if (!session?.memoryEnabled || session.memoryMode !== 'auto') return

  const meaningful = messages.filter((message) => message.role !== 'system' && message.content.trim())
  const cursor = session.memoryLastMessageId
  const cursorIndex = cursor ? meaningful.findIndex((message) => message.id === cursor) : -1
  const unsummarizedCount = cursorIndex >= 0 ? meaningful.length - cursorIndex - 1 : meaningful.length
  if (unsummarizedCount < (session.autoMemoryInterval || MEMORY_SUMMARY_MIN)) return

  await runMemorySummary(get, set, character, { automatic: true })
}

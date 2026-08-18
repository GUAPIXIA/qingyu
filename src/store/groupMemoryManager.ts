import type { Character, MemoryFactRecord } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'
import { applyFactProposals, applyMemoryFactChanges, formatMemoryFacts, parseMemoryResult } from '../utils/memory'
import { estimateTokens } from '../utils/tokenCounter'
import { buildMemorySummaryWindow } from '../utils/memoryWindow'
import { MEMORY_SUMMARY_MIN } from './chatConstants'
import { vectorizeGroupSessionFacts } from './groupStreamController'
import { logWarn } from '../lib/logger'
import type { GroupStoreGet, GroupStoreSet } from './groupChatTypes'

const activeGroupMemorySummaries = new Set<string>()

/**
 * 群聊长记忆摘要生成：对最近对话调用 AI 总结，更新【摘要】+【事实】。
 * 从 useGroupChatStore.triggerMemorySummary 抽出，依赖通过 set/get 注入。
 */
export async function runGroupMemorySummary(get: GroupStoreGet, set: GroupStoreSet): Promise<void> {
  const state = get()
  const { currentGroup, currentSessionId, messages } = state
  if (!currentGroup || !currentSessionId) return

  const settingsStore = useSettingsStore.getState()
  const profile = settingsStore.getActiveProfile()
  if (!profile) return

  const charStore = useCharacterStore.getState()
  const members = currentGroup.memberIds
    .map(id => charStore.characters.find(c => c.id === id))
    .filter(Boolean) as Character[]
  const memberNames = members.map(m => m.name).join('、')

  const currentSession = state.sessions.find(s => s.id === currentSessionId)
  if (!currentSession) return
  const summaryKey = `${currentGroup.id}:${currentSessionId}`
  if (activeGroupMemorySummaries.has(summaryKey)) return
  const prevMemory = currentSession?.memory || ''
  const prevFacts = currentSession?.memoryFacts ?? []
  const prevFactsText = formatMemoryFacts(prevFacts) || '无'
  const nextMemoryVersion = (currentSession.memoryVersion ?? 0) + 1
  const shouldAttemptFactProposal = nextMemoryVersion >= (currentSession.memoryFactRetryAfterVersion ?? 0)

  const formatMessage = (message: typeof messages[number]) => {
    const char = members.find(c => c.id === message.characterId)
    const speaker = message.characterId === '__user__'
      ? (settingsStore.settings.userName || '用户')
      : (char?.name || '未知')
    return `${speaker}: ${message.content}`
  }
  const summaryWindow = buildMemorySummaryWindow(
    messages.filter((message) => message.content.trim()),
    currentSession.memoryLastMessageId,
    formatMessage,
    (text) => estimateTokens(text, profile.model),
  )
  if (summaryWindow.pending.length < MEMORY_SUMMARY_MIN || summaryWindow.selected.length === 0) return

  const systemPrompt = `你是一个对话摘要助手。请根据以下群聊「${currentGroup.name}」的最近对话（成员：${memberNames}），更新当前状态、长期时间线并抽取关键事实。

输出格式（严格按此格式）：
【当前状态】
1-3 句：当前场景、地点、正在进行的目标或冲突，以及影响下一轮对话的即时关系或情绪。

【时间线】
2-4 句：已发生的重要事件、关键转折与因果。不要重复当前状态。

${shouldAttemptFactProposal ? `【事实提案】
\`\`\`json
[{"subject":"主体","predicate":"属性或关系","value":"值","changeType":"set","scope":"本群聊","importance":3,"confidence":0.9}]
\`\`\`` : '本次结构化事实更新正在退避；不要输出【事实提案】。'}

要求：
- 事实必须是持久有效的信息（人名、身份、地点、目标、约定、关系等），不要写临时情绪。
- 只输出语义事实提案，绝对不要输出事实 ID、action、patch 或完整事实列表。changeType 用 set 表示新增/更新，clear 表示失效。
- 服务端会按「主体 + 属性/关系 + scope + entityId」匹配；没有事实变更时输出空数组 []。
- 只输出上述格式内容。

【之前的当前状态】\n${currentSession.memoryCurrentState || '无'}\n\n${prevMemory ? '【之前的时间线】\n' + prevMemory + '\n\n' : ''}【之前的事实】\n${prevFactsText}\n\n事实范围默认为本群聊。`

  const conversationText = [
    summaryWindow.overlap.length > 0
      ? `【已总结内容，仅作衔接】\n${summaryWindow.overlap.map(formatMessage).join('\n')}`
      : '',
    `【待总结的新对话】\n${summaryWindow.selected.map(formatMessage).join('\n')}`,
  ].filter(Boolean).join('\n\n')
  const processedThroughMessageId = summaryWindow.processedThroughMessageId

  try {
    activeGroupMemorySummaries.add(summaryKey)
    const requestId = `group-memory-${Date.now()}`
    let result = ''

    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
    })

    const unbindDone = window.api.ai.onDone((doneId) => {
      if (doneId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()
      activeGroupMemorySummaries.delete(summaryKey)
      const parsed = parseMemoryResult(result || '')
      if (parsed.summary) {
        const hasFactsSection = result.includes('【事实】')
        const hasFactChangesSection = result.includes('【事实变更】')
        const hasFactProposalsSection = result.includes('【事实提案】')
        const hasCurrentStateSection = result.includes('【当前状态】')
        let facts: MemoryFactRecord[] = hasFactsSection ? parsed.facts : prevFacts
        let memoryFactHistory = currentSession.memoryFactHistory
        let factStateUpdates: Record<string, number> = {}
        if (shouldAttemptFactProposal && hasFactProposalsSection && parsed.factProposals) {
          const applied = applyFactProposals(currentSession.memoryFacts, currentSession.memoryFactHistory, parsed.factProposals, processedThroughMessageId ?? '')
          facts = applied.facts
          memoryFactHistory = applied.history
          factStateUpdates = { memoryFactParseFailureCount: 0, memoryFactRetryAfterVersion: 0 }
        } else if (hasFactChangesSection && parsed.factChanges) {
          const applied = applyMemoryFactChanges(
            currentSession.memoryFacts,
            currentSession.memoryFactHistory,
            parsed.factChanges,
            processedThroughMessageId ?? '',
          )
          facts = applied.facts
          memoryFactHistory = applied.history
          factStateUpdates = { memoryFactParseFailureCount: 0, memoryFactRetryAfterVersion: 0 }
        } else if (shouldAttemptFactProposal && !hasFactsSection) {
          const failureCount = (currentSession.memoryFactParseFailureCount ?? 0) + 1
          const retryAfterVersion = failureCount >= 3 ? nextMemoryVersion + 2 ** (failureCount - 2) : nextMemoryVersion
          factStateUpdates = { memoryFactParseFailureCount: failureCount, memoryFactRetryAfterVersion: retryAfterVersion }
          logWarn('group-memory', `结构化事实提案解析失败，已保留旧事实（会话 ${currentSessionId}，失败 ${failureCount} 次，重试版本 ${retryAfterVersion}）`)
        }
        window.api.group.updateSession(currentGroup.id, currentSessionId, {
          memory: parsed.summary,
          memoryCurrentState: hasCurrentStateSection ? parsed.currentState : (currentSession.memoryCurrentState ?? ''),
          memoryFacts: facts,
          ...((shouldAttemptFactProposal && hasFactProposalsSection && parsed.factProposals) || (hasFactChangesSection && parsed.factChanges) ? { memoryFactHistory } : {}),
          ...factStateUpdates,
          factsVectors: [],
          factsVectorVersion: 0,
          memoryUpdatedAt: Date.now(),
          memoryLastMessageId: processedThroughMessageId,
          memoryVersion: nextMemoryVersion,
        })
        // P0-2：事实向量化（异步）
        if (facts.length > 0) vectorizeGroupSessionFacts(currentGroup.id, currentSessionId, facts, nextMemoryVersion)
        // NEW-M11：摘要写入归属发起时群聊会话（数据正确）；仅当用户仍停留在同一群聊会话时更新 UI
        const s = get()
        if (s.currentGroup?.id === currentGroup.id && s.currentSessionId === currentSessionId) {
          const sessions = s.sessions.map(sess =>
            sess.id === currentSessionId ? {
              ...sess,
              memory: parsed.summary,
              memoryCurrentState: hasCurrentStateSection ? parsed.currentState : (currentSession.memoryCurrentState ?? ''),
              memoryFacts: facts,
              ...((shouldAttemptFactProposal && hasFactProposalsSection && parsed.factProposals) || (hasFactChangesSection && parsed.factChanges) ? { memoryFactHistory } : {}),
              ...factStateUpdates,
              factsVectors: [],
              factsVectorVersion: 0,
              memoryUpdatedAt: Date.now(),
              memoryLastMessageId: processedThroughMessageId,
              memoryVersion: nextMemoryVersion,
            } : sess
          )
          set({ sessions })
        }
      }
    })

    const unbindError = window.api.ai.onError((data: { requestId: string }) => {
      if (data.requestId !== requestId) return
      unbindChunk(); unbindDone(); unbindError()
      activeGroupMemorySummaries.delete(summaryKey)
    })

    await window.api.ai.chat({
      requestId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: conversationText },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
      temperature: 0.3,
      topP: 1,
      maxTokens: 1024,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
    })
  } catch {
    // 摘要失败静默处理，不影响主流程
    activeGroupMemorySummaries.delete(summaryKey)
  }
}

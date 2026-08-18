import type { Character, MemoryFactRecord } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { resolveEffectiveTemplate } from '../utils/chatTemplates'
import { applyFactProposals, applyMemoryFactChanges, formatMemoryFacts, parseMemoryResult } from '../utils/memory'
import { estimateTokens } from '../utils/tokenCounter'
import { buildMemorySummaryWindow } from '../utils/memoryWindow'
import { MEMORY_SUMMARY_MIN } from './chatConstants'
import { friendlyError } from './chatUtils'
import { logWarn } from '../lib/logger'
import { vectorizeSessionFacts } from './streamController'
import type { StoreGet, StoreSet } from './chatTypes'

/** 同一会话一次只允许一个总结任务，避免并发结果相互覆盖。 */
const activeMemorySummaries = new Set<string>()

/**
 * 长记忆摘要生成（手动触发 / 自动触发共用）：
 * 对最近对话调用 AI 总结，解析【摘要】+【事实】并持久化到会话。
 * 从 useChatStore.triggerMemorySummary 抽出，依赖通过 set/get 注入。
 */
export async function runMemorySummary(
  get: StoreGet,
  set: StoreSet,
  character: Character,
): Promise<string | null> {
  const { currentSessionId, messages, sessions } = get()
  const session = sessions.find(s => s.id === currentSessionId)
  if (!currentSessionId || !session?.memoryEnabled) return null

  const summaryKey = `${character.id}:${currentSessionId}`
  if (activeMemorySummaries.has(summaryKey)) return null

  const profile = useSettingsStore.getState().getActiveProfile()
  if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) return null

  const settings = useSettingsStore.getState().settings
  const userName = settings.userName || '用户'

  const meaningfulMessages = messages.filter(m => m.role !== 'system' && m.content.trim())
  const formatMessage = (message: typeof meaningfulMessages[number]) =>
    `${message.role === 'user' ? userName : character.name}: ${message.content}`
  const summaryWindow = buildMemorySummaryWindow(
    meaningfulMessages,
    session.memoryLastMessageId,
    formatMessage,
    (text) => estimateTokens(text, settings.activeModel || profile.model),
  )
  // 最少消息数只针对尚未处理的增量内容；已总结的 overlap 不应重复计数。
  if (summaryWindow.pending.length < MEMORY_SUMMARY_MIN || summaryWindow.selected.length === 0) return null
  const processedThroughMessageId = summaryWindow.processedThroughMessageId
  const nextMemoryVersion = (session.memoryVersion ?? 0) + 1

  const messagesText = [
    summaryWindow.overlap.length > 0
      ? `【已总结内容，仅作衔接】\n${summaryWindow.overlap.map(formatMessage).join('\n')}`
      : '',
    `【待总结的新对话】\n${summaryWindow.selected.map(formatMessage).join('\n')}`,
  ].filter(Boolean).join('\n\n')

  const previousMemory = session.memory || '无'
  // 之前的关键事实（供模型合并更新）
  const previousFacts = session.memoryFacts ?? []
  const previousFactsText = formatMemoryFacts(previousFacts) || '无'
  const shouldAttemptFactProposal = nextMemoryVersion >= (session.memoryFactRetryAfterVersion ?? 0)

  const requestId = `memory-summary-${Date.now()}`
  let result = ''
  let errored = false
  let errMsg = ''

  // 构建 instruct 模板（摘要无预设，跟随 profile 开关）
  const instructTemplate = profile.useInstructTemplate
    ? resolveEffectiveTemplate(undefined, profile.provider, settings.activeModel || profile.model, true)
    : undefined

  activeMemorySummaries.add(summaryKey)
  return new Promise((resolve) => {
    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      activeMemorySummaries.delete(summaryKey)
      unbindChunk(); unbindDone(); unbindError()
    }
    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
    })
    const unbindDone = window.api.ai.onDone(async (doneId) => {
      if (doneId !== requestId) return
      cleanup()
      const parsed = parseMemoryResult(result)
      if (parsed.summary) {
        try {
          // 摘要、事实、游标与版本一次写入，避免部分成功留下不一致快照。
          const hasFactsSection = result.includes('【事实】')
          const hasFactChangesSection = result.includes('【事实变更】')
          const hasFactProposalsSection = result.includes('【事实提案】')
          const hasCurrentStateSection = result.includes('【当前状态】')
          let facts: MemoryFactRecord[] = hasFactsSection ? parsed.facts : (session.memoryFacts ?? [])
          let memoryFactHistory = session.memoryFactHistory
          let factStateUpdates: Record<string, number> = {}
          if (shouldAttemptFactProposal && hasFactProposalsSection && parsed.factProposals) {
            const applied = applyFactProposals(session.memoryFacts, session.memoryFactHistory, parsed.factProposals, processedThroughMessageId ?? '')
            facts = applied.facts
            memoryFactHistory = applied.history
            factStateUpdates = { memoryFactParseFailureCount: 0, memoryFactRetryAfterVersion: 0 }
          } else if (hasFactChangesSection && parsed.factChanges) {
            const applied = applyMemoryFactChanges(
              session.memoryFacts,
              session.memoryFactHistory,
              parsed.factChanges,
              processedThroughMessageId ?? '',
            )
            facts = applied.facts
            memoryFactHistory = applied.history
            factStateUpdates = { memoryFactParseFailureCount: 0, memoryFactRetryAfterVersion: 0 }
          } else if (shouldAttemptFactProposal && !hasFactsSection) {
            const failureCount = (session.memoryFactParseFailureCount ?? 0) + 1
            const retryAfterVersion = failureCount >= 3 ? nextMemoryVersion + 2 ** (failureCount - 2) : nextMemoryVersion
            factStateUpdates = { memoryFactParseFailureCount: failureCount, memoryFactRetryAfterVersion: retryAfterVersion }
            logWarn('memory', `结构化事实提案解析失败，已保留旧事实（会话 ${currentSessionId}，失败 ${failureCount} 次，重试版本 ${retryAfterVersion}）`)
          }
          await window.api.chat.updateSession(character.id, currentSessionId, {
            memory: parsed.summary,
            memoryCurrentState: hasCurrentStateSection ? parsed.currentState : (session.memoryCurrentState ?? ''),
            memoryFacts: facts,
            ...((shouldAttemptFactProposal && hasFactProposalsSection && parsed.factProposals) || (hasFactChangesSection && parsed.factChanges) ? { memoryFactHistory } : {}),
            ...factStateUpdates,
            factsVectors: [],
            factsVectorVersion: 0,
            memoryUpdatedAt: Date.now(),
            memoryLastMessageId: processedThroughMessageId,
            memoryVersion: nextMemoryVersion,
          })
          // P0-2：事实向量化（异步，供语义检索注入）；版本不匹配时上下文会自动回退。
          if (facts.length > 0) vectorizeSessionFacts(character.id, currentSessionId, facts, nextMemoryVersion)
          // NEW-M11：摘要写入归属发起时会话（数据正确）；仅当用户仍停留在同一会话时刷新 UI，
          // 避免覆盖已切换到其他会话的列表
          if (get().currentSessionId === currentSessionId) {
            const refreshedSessions = await window.api.chat.listSessions(character.id)
            set({ sessions: refreshedSessions })
          }
        } catch { /* ignore */ }
      }
      resolve(parsed.summary || null)
    })
    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      cleanup()
      errored = true
      errMsg = friendlyError(data.error)
      // 错误反馈到 store，UI 可见
      set({ error: `长记忆总结失败：${errMsg}` })
      resolve(null)
    })

    window.api.ai.chat({
      requestId,
      messages: [
        {
          role: 'system',
          content: `你是一个角色扮演对话总结助手。请根据以下${character.name}与${userName}之间的对话，更新当前状态、长期时间线和关键事实。

输出格式（严格按此格式）：
【当前状态】
1-3 句：当前场景、时间/地点、正在进行的目标或冲突、角色即时关系或情绪。只保留会影响下一轮对话的内容。

【时间线】
2-4 句：已发生的重要事件、关键转折与因果。不要重复当前状态。

${shouldAttemptFactProposal ? `【事实提案】
\`\`\`json
[{"subject":"主体","predicate":"属性或关系","value":"值","changeType":"set","scope":"本会话","importance":3,"confidence":0.9}]
\`\`\`` : '本次结构化事实更新正在退避；不要输出【事实提案】。'}

要求：
- 事实必须是对话中确立的、对未来有参考价值的持久信息（人名、身份、地点、物品、目标、约定、关系等），不要写临时情绪或过场细节。
- 只输出语义事实提案，绝对不要输出事实 ID、action、patch 或完整事实列表。changeType 用 set 表示新增/更新，clear 表示失效。
- 服务端会按「主体 + 属性/关系 + scope + entityId」匹配；没有事实变更时输出空数组 []。
- 只输出上述格式内容，不要添加任何解释或评价。

之前的当前状态：
${session.memoryCurrentState || '无'}

之前的时间线：
${previousMemory}

之前的事实：
${previousFactsText}

事实范围默认为本会话。`,
        },
        { role: 'user', content: `新对话内容：\n${messagesText}` },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: settings.activeModel || profile.model,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 2048,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
      instructTemplate,
    }).catch(() => {
      cleanup()
      if (!errored) {
        set({ error: '长记忆总结请求失败' })
      }
      resolve(null)
    })
  })
}

/**
 * 自动总结调度：以“最后处理的消息 ID”为游标，而不是易受编辑和时钟影响的时间戳。
 * 所有生成入口共用这里的判断；runMemorySummary 内的会话锁负责抑制并发触发。
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
  // 游标消息已被编辑/删除时，从头重新建立快照，避免沿用已失效的摘要。
  const unsummarizedCount = cursorIndex >= 0 ? meaningful.length - cursorIndex - 1 : meaningful.length
  if (unsummarizedCount < (session.autoMemoryInterval || 10)) return

  await runMemorySummary(get, set, character)
}

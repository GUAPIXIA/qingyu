import { featureRangeSource, featureSessionRef, featureFingerprint, groupFeatureScope, matchesFeatureSource } from '../../shared/featureSource'
import { beginFeatureTask, finishFeatureTask, requestFeatureText } from './featureTasks'
import type { Character, MemoryFactRecord } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { useCharacterStore } from './useCharacterStore'
import { enabledProfileOverride, resolveEffectiveContextLimit } from '../../shared/modelOutputProfile'
import { cachedReasoningSamplesFor, refreshUsageProfileInBackground } from './usageProfileCache'
import { resolveGenerationTaskBudget } from '../../shared/generationTaskBudget'
import { applyFactProposals, applyMemoryFactChanges, formatMemoryFacts, parseMemoryResult } from '../../shared/chat-core/memory'
import { estimateTokens } from '../../shared/chat-core/tokenCounter'
import { buildMemorySummaryWindow, fitOversizedMemoryMessage, resolveMemorySummaryInputBudget } from '../../shared/chat-core/memoryWindow'
import { MEMORY_SUMMARY_MIN } from '../../shared/chat-core/chatConstants'
import { vectorizeGroupSessionFacts } from '../features/group-chat/requestRunner'
import { logWarn } from '../lib/logger'
import type { GroupStoreGet, GroupStoreSet } from './groupChatTypes'
import { nanoid } from 'nanoid'
import { getNarrativeMemoryGuidance, resolveNarrativeMode } from '../../shared/narrativeMode'

const activeGroupMemorySummaries = new Map<string, string>()

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
  if (!currentSession?.memoryEnabled) return
  const summaryKey = `${currentGroup.id}:${currentSessionId}`
  /** 失败统一上报：memorySummaryError 携带会话 key 供面板精确展示 */
  const reportSummaryFailure = (message: string) => {
    if (get().currentGroup?.id === currentGroup.id && get().currentSessionId === currentSessionId) set({ error: message, memorySummaryError: { key: summaryKey, message } })
  }
  const prevMemory = currentSession?.memory || ''
  const prevFacts = currentSession?.memoryFacts ?? []
  const prevFactsText = formatMemoryFacts(prevFacts) || '无'
  const baseMemoryVersion = currentSession.memoryVersion ?? 0
  const nextMemoryVersion = baseMemoryVersion + 1
  const shouldAttemptFactProposal = nextMemoryVersion >= (currentSession.memoryFactRetryAfterVersion ?? 0)
  const narrativeMemoryGuidance = getNarrativeMemoryGuidance(resolveNarrativeMode(currentSession.narrativeMode))

  const formatMessage = (message: typeof messages[number]) => {
    const char = members.find(c => c.id === message.characterId)
    const speaker = message.characterId === '__user__'
      ? (settingsStore.settings.userName || '用户')
      : (char?.name || '未知')
    return `${speaker}: ${message.content}`
  }
  const promptOverheadTokens = estimateTokens(
    `${currentGroup.name}\n${memberNames}\n${currentSession.memoryCurrentState || '无'}\n${prevMemory}\n${prevFactsText}`,
    profile.model,
  ) + 800
  // S3：与单聊同一策略——输出预算接入模型能力档案（正文约 2500 字 + 推理余量），
  // 不再固定 2048（推理端点上思考会吃光预算导致事实提案缺失）
  // W1（主计划 §7.3）：记忆任务分桶回读近期推理样本；后台路径不阻塞当前调用。
  refreshUsageProfileInBackground({
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: profile.model,
    taskType: 'memory',
  })
  const groupMemorySamples = cachedReasoningSamplesFor({
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: profile.model,
    taskType: 'memory',
  })
  const groupMemoryPlan = resolveGenerationTaskBudget({
    task: 'memory',
    model: profile.model,
    profileOverride: enabledProfileOverride(profile.capabilityOverride),
    ...(groupMemorySamples ? { recentReasoningTokens: groupMemorySamples } : {}),
  })
  const GROUP_MEMORY_OUTPUT_TOKENS = groupMemoryPlan.requestMaxTokens
  const summaryInputBudget = resolveMemorySummaryInputBudget(
    resolveEffectiveContextLimit({
      model: profile.model,
      profileMaxContext: profile.maxContext,
      capabilityOverride: profile.capabilityOverride,
    }),
    promptOverheadTokens,
    GROUP_MEMORY_OUTPUT_TOKENS,
  )
  const summaryWindow = buildMemorySummaryWindow(
    messages.filter((message) => message.content.trim()),
    currentSession.memoryLastMessageId,
    formatMessage,
    (text) => estimateTokens(text, profile.model),
    { tokenBudget: summaryInputBudget },
  )
  if (summaryWindow.pending.length < MEMORY_SUMMARY_MIN || summaryWindow.selected.length === 0) {
    reportSummaryFailure('没有需要总结的新消息：游标之后的未总结内容不足')
    return
  }

  const systemPrompt = `你是一个对话摘要助手。请根据以下群聊「${currentGroup.name}」的最近对话（成员：${memberNames}），更新当前状态、长期时间线并抽取关键事实。

输出格式（严格按此格式）：
【当前状态】
1-3 句：当前场景、地点、正在进行的目标或冲突，以及影响下一轮对话的即时关系或情绪。

【时间线】
最多 8 条按时间顺序排列的简短事件：保留仍会影响剧情、关系、承诺或任务的旧事件，并合并新事件；只有被新对话明确推翻时才改写旧事件。不要重复当前状态。

${shouldAttemptFactProposal ? `【事实提案】
\`\`\`json
[{"subject":"主体","predicate":"属性或关系","value":"值","changeType":"set","importance":3,"confidence":0.9}]
\`\`\`` : '本次结构化事实更新正在退避；不要输出【事实提案】。'}

要求：
- ${narrativeMemoryGuidance}
- 事实必须是持久有效的信息（人名、身份、地点、目标、约定、关系等），不要写临时情绪。
- 只输出语义事实提案，绝对不要输出事实 ID、action、patch 或完整事实列表。changeType 用 set 表示新增/更新，clear 表示失效。
- 服务端负责规范化群聊范围和角色身份；没有事实变更时输出空数组 []。
- 只输出上述格式内容。

【之前的当前状态】\n${currentSession.memoryCurrentState || '无'}\n\n${prevMemory ? '【之前的时间线】\n' + prevMemory + '\n\n' : ''}【之前的事实】\n${prevFactsText}\n\n事实范围由服务端确定。`

  const formatSelectedMessage = (message: typeof messages[number]) =>
    summaryWindow.selected.length === 1
      ? fitOversizedMemoryMessage(formatMessage(message), summaryInputBudget, (text) => estimateTokens(text, profile.model))
      : formatMessage(message)

  const conversationText = [
    summaryWindow.overlap.length > 0
      ? `【已总结内容，仅作衔接】\n${summaryWindow.overlap.map(formatMessage).join('\n')}`
      : '',
    `【待总结的新对话】\n${summaryWindow.selected.map(formatSelectedMessage).join('\n')}`,
  ].filter(Boolean).join('\n\n')
  const processedThroughMessageId = summaryWindow.processedThroughMessageId

  const source = featureRangeSource(messages, [...summaryWindow.overlap, ...summaryWindow.selected], featureSessionRef(currentSession, ['narrativeMode', 'personaId', 'memoryEnabled', 'memoryMode', 'memoryLastMessageId']))
  source.groupFingerprint = featureFingerprint(groupFeatureScope(currentGroup))
  const task = beginFeatureTask({ kind: 'group', groupId: currentGroup.id, sessionId: currentSessionId }, 'memory', source)
  if (!task) return
  activeGroupMemorySummaries.set(summaryKey, task.id)
  set({ summarizingMemoryKey: summaryKey, memorySummaryError: null })
  const requestId = `group-memory-${nanoid()}`
  const finish = () => {
    finishFeatureTask(task)
    if (activeGroupMemorySummaries.get(summaryKey) !== task.id) return
    activeGroupMemorySummaries.delete(summaryKey)
    set(s => s.summarizingMemoryKey === summaryKey ? { summarizingMemoryKey: null } : {})
  }
  const commitResult = async (result: string, finishReason?: string) => {
      if (task.controller.signal.aborted || (finishReason && finishReason !== 'stop' && finishReason !== 'length')) return
      const parsed = parseMemoryResult(result || '')
      if (!parsed.summary && !parsed.currentState) {
        // 与单聊一致：未解析出可写入内容（含仅思考块回复）时显式反馈，避免“总结完成却无内容”的静默失败
        logWarn('group-memory', `长记忆总结未产出可解析内容（会话 ${currentSessionId}，请求 ${requestId}，raw=${result.length} 字符，含 thought 标签=${/<\s*\/?\s*(thought|thinking)\b/i.test(result)}）`)
        reportSummaryFailure('群聊长记忆总结未产出可解析内容（模型可能只返回了思考过程或格式不符），请重试')
        finish()
        return
      }
      // S3：截断时显式区分"摘要已保存、事实未更新"
      if (finishReason === 'length' && shouldAttemptFactProposal
        && result.includes('【事实提案】') && !parsed.factProposals) {
        logWarn('group-memory', `群聊长记忆摘要已保存，但事实提案 JSON 被输出上限截断未更新（会话 ${currentSessionId}，finishReason=length）`)
      }
      if (!parsed.summary) {
        // 只有【当前状态】没有【时间线】：保留旧时间线，仍然提交状态与事实
        logWarn('group-memory', `长记忆总结缺少【时间线】，保留旧时间线仅更新当前状态/事实（会话 ${currentSessionId}）`)
      }
      try {
        const hasFactsSection = result.includes('【事实】')
        const hasFactChangesSection = result.includes('【事实变更】')
        const hasFactProposalsSection = result.includes('【事实提案】')
        const hasCurrentStateSection = result.includes('【当前状态】')
        let facts: MemoryFactRecord[] = hasFactsSection ? parsed.facts : prevFacts
        let memoryFactHistory = currentSession.memoryFactHistory
        let factStateUpdates: Record<string, number> = {}
        if (shouldAttemptFactProposal && hasFactProposalsSection && parsed.factProposals) {
          const userName = settingsStore.settings.userName || '用户'
          const scopedProposals = parsed.factProposals.map((proposal) => {
            const member = members.find((item) => item.name.trim().toLocaleLowerCase() === proposal.subject.trim().toLocaleLowerCase())
            return {
              ...proposal,
              scope: `group:${currentGroup.id}`,
              entityId: proposal.entityId
                ?? member?.id
                ?? (proposal.subject.trim().toLocaleLowerCase() === userName.trim().toLocaleLowerCase() ? '__user__' : undefined),
            }
          })
          let proposalFacts = currentSession.memoryFacts
          let proposalHistory = currentSession.memoryFactHistory
          for (const proposal of scopedProposals) {
            const evidence = [...summaryWindow.selected].reverse().find((message) => {
              const content = message.content.toLocaleLowerCase()
              return [proposal.value, proposal.subject]
                .map((value) => value.trim().toLocaleLowerCase())
                .some((value) => value.length >= 2 && content.includes(value))
            })
            const applied = applyFactProposals(proposalFacts, proposalHistory, [proposal], evidence?.id ?? processedThroughMessageId ?? '')
            proposalFacts = applied.facts
            proposalHistory = applied.history
          }
          facts = proposalFacts ?? []
          memoryFactHistory = proposalHistory
          factStateUpdates = { memoryFactParseFailureCount: 0, memoryFactRetryAfterVersion: 0 }
        } else if (hasFactChangesSection && parsed.factChanges) {
          const applied = applyMemoryFactChanges(currentSession.memoryFacts, currentSession.memoryFactHistory, parsed.factChanges, processedThroughMessageId ?? '')
          facts = applied.facts
          memoryFactHistory = applied.history
          factStateUpdates = { memoryFactParseFailureCount: 0, memoryFactRetryAfterVersion: 0 }
        } else if (shouldAttemptFactProposal && !hasFactsSection) {
          const failureCount = (currentSession.memoryFactParseFailureCount ?? 0) + 1
          const retryAfterVersion = failureCount >= 3 ? nextMemoryVersion + 2 ** (failureCount - 2) : nextMemoryVersion
          factStateUpdates = { memoryFactParseFailureCount: failureCount, memoryFactRetryAfterVersion: retryAfterVersion }
          logWarn('group-memory', `结构化事实提案解析失败，已保留旧事实（会话 ${currentSessionId}，失败 ${failureCount} 次，重试版本 ${retryAfterVersion}）`)
        }
        const memoryUpdatedAt = Date.now()
        const patch = {
          memory: parsed.summary || currentSession.memory || '',
          memoryCurrentState: hasCurrentStateSection ? parsed.currentState : (currentSession.memoryCurrentState ?? ''),
          memoryFacts: facts,
          ...((shouldAttemptFactProposal && hasFactProposalsSection && parsed.factProposals) || (hasFactChangesSection && parsed.factChanges) ? { memoryFactHistory } : {}),
          ...factStateUpdates,
          factsVectors: [],
          factsVectorVersion: 0,
          memoryUpdatedAt,
          memoryLastMessageId: processedThroughMessageId,
          memoryVersion: nextMemoryVersion,
          memorySource: source,
          memoryTaskId: task.id,
        }
        const commit = await window.api.group.updateSessionIfMemoryVersion(currentGroup.id, currentSessionId, baseMemoryVersion, patch, source)
        if (task.controller.signal.aborted) return
        if (!commit.applied) {
          reportSummaryFailure('群聊长记忆已被其他操作更新，本次旧摘要未写入。请重试总结。')
          finish()
          return
        }
        // 成功提交：清除本会话的总结失败提示
        if (get().currentGroup?.id === currentGroup.id && get().currentSessionId === currentSessionId) set({ memorySummaryError: null })
        if (facts.length > 0) vectorizeGroupSessionFacts(currentGroup.id, currentSessionId, facts, nextMemoryVersion)
        const latest = get()
        if (latest.currentGroup?.id === currentGroup.id && latest.currentSessionId === currentSessionId
          && matchesFeatureSource(source, latest.messages, latest.sessions.find(s => s.id === currentSessionId), groupFeatureScope(latest.currentGroup))) {
          set({ sessions: latest.sessions.map((session) => session.id === currentSessionId ? { ...session, ...patch } : session) })
        }
      } catch (error) {
        reportSummaryFailure(`群聊长记忆保存失败：${error instanceof Error ? error.message : String(error)}`)
      }
      finish()
  }
  try {
    const response = await requestFeatureText(task, {
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
      maxTokens: GROUP_MEMORY_OUTPUT_TOKENS,
      reasoningGate: groupMemoryPlan.reasoningGate,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
      // 阶段7（§7.2/§7.3）：与单聊同一 memory 档案；独立 taskType，不混入主对话篇幅统计
      observability: { source: 'aux', taskType: 'memory', sessionId: currentSession?.id },
    })
    await commitResult(response.text, response.completion.finishReason)
  } catch (error) {
    if (!task.controller.signal.aborted) reportSummaryFailure(`群聊长记忆总结请求失败：${error instanceof Error ? error.message : String(error)}`)
  } finally { finish() }
}

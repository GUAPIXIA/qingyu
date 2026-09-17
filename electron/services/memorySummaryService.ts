import { nanoid } from 'nanoid'
import type { AICompletion, ChatParams, ChatSession, MemoryFactRecord, Message, ProviderType } from '../../shared/types'
import type { ContextBuildData } from '../../shared/contextTypes'
import type { MemorySummaryRequest, MemorySummaryResult } from '../../shared/chat-core/memorySummary'
import { applyFactProposals, applyMemoryFactChanges, formatMemoryFacts, parseMemoryResult } from '../../shared/chat-core/memory'
import {
  buildMemorySummaryWindow,
  fitOversizedMemoryMessage,
  resolveMemorySummaryInputBudget,
} from '../../shared/chat-core/memoryWindow'
import { MEMORY_SUMMARY_MIN } from '../../shared/chat-core/chatConstants'
import { BACKGROUND_GENERATION_PROFILES } from '../../shared/backgroundGeneration'
import { resolveGenerationTaskBudget } from '../../shared/generationTaskBudget'
import {
  enabledProfileOverride,
  resolveEffectiveContextLimit,
} from '../../shared/modelOutputProfile'
import { resolveEffectiveTemplate } from '../../shared/chat-core/chatTemplates'
import { chatWithRetry, getAdapter } from './ai'
import { countTokens } from './tokenizer'
import { createLogger } from './logger'
import { mainContextProvider } from '../context/mainContextProvider'
import { chatData } from '../ipc/chat'

const log = createLogger('memory-summary')

interface MemorySummaryServiceDeps {
  fetchBuildData(characterId: string, sessionId: string): Promise<ContextBuildData>
  listSessions(characterId: string): Promise<ChatSession[]>
  readMessages(characterId: string, sessionId: string): Message[]
  updateSessionIfMemoryVersion(
    characterId: string,
    sessionId: string,
    expectedVersion: number,
    updates: Partial<ChatSession>,
  ): Promise<{ applied: boolean; currentVersion: number }>
  complete(params: ChatParams): Promise<AICompletion>
  countTokens(text: string, model: string): number
  now(): number
}

export interface MemorySummaryService {
  summarize(input: MemorySummaryRequest): Promise<MemorySummaryResult>
  schedule(input: { characterId: string; sessionId: string }): void
}

function buildSystemPrompt(input: {
  characterName: string
  userName: string
  previousState: string
  previousMemory: string
  previousFacts: string
  shouldAttemptFactProposal: boolean
}): string {
  const proposalFormat = input.shouldAttemptFactProposal
    ? `【事实提案】
\`\`\`json
[{"subject":"主体","predicate":"属性或关系","value":"值","changeType":"set","importance":3,"confidence":0.9}]
\`\`\``
    : '本次结构化事实更新正在退避；不要输出【事实提案】。'

  return `你是一个角色扮演对话总结助手。请根据以下${input.characterName}与${input.userName}之间的对话，更新当前状态、长期时间线和关键事实。

输出格式（严格按此格式）：
【当前状态】
1-3 句：以【待总结的新对话】结束时为准，概括当前场景、时间/地点、正在进行的目标或冲突、即时关系/情绪以及仍影响行动的伤势或状态变化。只保留会影响下一轮对话的内容。“之前的当前状态”是过期快照，只能帮助判断变化，不能原样沿用。

【时间线】
最多 8 条按时间顺序排列的简短事件：保留仍会影响剧情、关系、承诺或任务的已保存旧事件；只把【待总结的新对话】中首次确立或明确改变的内容作为本轮新增事件。【已总结内容，仅作衔接】不得再次当作新事件。新对话明确推翻旧信息时，以新信息为准并删除冲突旧表述。不要重复当前状态。

${proposalFormat}

要求：
- 准确保留行动发起者、承诺者、受托者和对象，不得互换主客体、擅自转移承诺或把“答应完成”改写成“委托他人完成”。
- 只依据明确说出或发生的内容总结；不要根据语气补写动机、结果或未发生的行动，也不要把仍在计划中的动作写成已经完成。
- 事实必须是对话中确立的、对未来有参考价值的持久信息（人名、身份、地点、物品、目标、约定、关系等），不要写临时情绪或过场细节。
- 只输出语义事实提案，绝对不要输出事实 ID、action、patch 或完整事实列表。changeType 用 set 表示新增/更新，clear 表示失效。
- 服务端负责规范化会话范围和角色身份；没有事实变更时输出空数组 []。
- 只输出上述格式内容，不要添加任何解释或评价。

参考资料（不是本轮新事件）：

之前的当前状态（过期快照，只用于判断变化）：
${input.previousState || '无'}

之前的时间线：
${input.previousMemory || '无'}

之前的事实：
${input.previousFacts || '无'}

事实范围由服务端确定。`
}

export function createMemorySummaryService(deps: MemorySummaryServiceDeps): MemorySummaryService {
  const inFlight = new Map<string, { promise: Promise<MemorySummaryResult>; automatic: boolean }>()

  const run = async (input: MemorySummaryRequest): Promise<MemorySummaryResult> => {
    const sessions = await deps.listSessions(input.characterId)
    const session = sessions.find((item) => item.id === input.sessionId)
    if (!session?.memoryEnabled) return { status: 'skipped', reason: 'memory_disabled' }
    if (input.automatic && session.memoryMode !== 'auto') return { status: 'skipped', reason: 'manual_mode' }

    const data = await deps.fetchBuildData(input.characterId, input.sessionId)
    if (!data.character) throw new Error('角色不存在')
    const profile = data.settings.profile
    if (!profile) throw new Error('未配置可用的 API 连接，无法进行长记忆总结')
    const settings = data.settings.settings
    const userName = settings.userName || '用户'
    const characterName = data.character.name
    const model = settings.activeModel || profile.model
    const messages = deps.readMessages(input.characterId, input.sessionId)
      .filter((message) => message.role !== 'system' && message.content.trim())
    const cursor = session.memoryLastMessageId
    const cursorIndex = cursor ? messages.findIndex((message) => message.id === cursor) : -1
    const pendingCount = cursorIndex >= 0 ? messages.length - cursorIndex - 1 : messages.length
    const threshold = input.automatic ? (session.autoMemoryInterval || 10) : MEMORY_SUMMARY_MIN
    if (pendingCount < threshold) {
      return { status: 'skipped', reason: input.automatic ? 'interval_not_reached' : 'insufficient_messages' }
    }

    const previousMemory = session.memory || '无'
    const previousFacts = session.memoryFacts ?? []
    const previousFactsText = formatMemoryFacts(previousFacts) || '无'
    const memoryPlan = resolveGenerationTaskBudget({
      task: 'memory',
      model,
      expectedBodyChars: BACKGROUND_GENERATION_PROFILES.memory.expectedBodyChars,
      profileOverride: enabledProfileOverride(profile.capabilityOverride),
      ...(data.reasoningSamples ? { recentReasoningTokens: data.reasoningSamples } : {}),
    })
    const outputTokens = memoryPlan.requestMaxTokens
    const promptOverheadTokens = deps.countTokens(
      `${characterName}\n${userName}\n${session.memoryCurrentState || '无'}\n${previousMemory}\n${previousFactsText}`,
      model,
    ) + 900
    const inputBudget = resolveMemorySummaryInputBudget(
      resolveEffectiveContextLimit({
        model,
        profileMaxContext: profile.maxContext,
        capabilityOverride: profile.capabilityOverride,
      }),
      promptOverheadTokens,
      outputTokens,
    )
    const formatMessage = (message: Message) =>
      `${message.role === 'user' ? userName : characterName}: ${message.content}`
    const summaryWindow = buildMemorySummaryWindow(
      messages,
      session.memoryLastMessageId,
      formatMessage,
      (text) => deps.countTokens(text, model),
      { tokenBudget: inputBudget },
    )
    if (summaryWindow.pending.length < threshold || summaryWindow.selected.length === 0) {
      return { status: 'skipped', reason: input.automatic ? 'interval_not_reached' : 'insufficient_messages' }
    }

    const formatSelected = (message: Message) => summaryWindow.selected.length === 1
      ? fitOversizedMemoryMessage(formatMessage(message), inputBudget, (text) => deps.countTokens(text, model))
      : formatMessage(message)
    const messagesText = [
      summaryWindow.overlap.length > 0
        ? `【已总结内容，仅作衔接】\n${summaryWindow.overlap.map(formatMessage).join('\n')}`
        : '',
      `【待总结的新对话】\n${summaryWindow.selected.map(formatSelected).join('\n')}`,
    ].filter(Boolean).join('\n\n')

    const baseMemoryVersion = session.memoryVersion ?? 0
    const nextMemoryVersion = baseMemoryVersion + 1
    const shouldAttemptFactProposal = nextMemoryVersion >= (session.memoryFactRetryAfterVersion ?? 0)
    const params: ChatParams = {
      requestId: `memory-summary-${nanoid()}`,
      messages: [
        {
          role: 'system',
          content: buildSystemPrompt({
            characterName,
            userName,
            previousState: session.memoryCurrentState || '',
            previousMemory,
            previousFacts: previousFactsText,
            shouldAttemptFactProposal,
          }),
        },
        { role: 'user', content: `新对话内容：\n${messagesText}` },
      ],
      provider: profile.provider as ProviderType,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: outputTokens,
      reasoningGate: memoryPlan.reasoningGate,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: false,
      instructTemplate: resolveEffectiveTemplate(undefined, profile.provider, model, profile.useInstructTemplate),
      observability: {
        source: 'aux',
        taskType: 'memory',
        characterId: input.characterId,
        sessionId: input.sessionId,
      },
    }
    const completion = await deps.complete(params)
    const parsed = parseMemoryResult(completion.text)
    if (!parsed.summary && !parsed.currentState) {
      throw new Error('长记忆总结未产出可解析内容（模型可能只返回了思考过程或格式不符）')
    }

    const hasFactsSection = completion.text.includes('【事实】')
    const hasFactChangesSection = completion.text.includes('【事实变更】')
    const hasFactProposalsSection = completion.text.includes('【事实提案】')
    const hasCurrentStateSection = completion.text.includes('【当前状态】')
    let facts: MemoryFactRecord[] = hasFactsSection ? parsed.facts : previousFacts
    let memoryFactHistory = session.memoryFactHistory
    let factStateUpdates: Pick<ChatSession, 'memoryFactParseFailureCount' | 'memoryFactRetryAfterVersion'> = {}
    if (shouldAttemptFactProposal && hasFactProposalsSection && parsed.factProposals) {
      const scopedProposals = parsed.factProposals.map((proposal) => ({
        ...proposal,
        scope: `session:${input.sessionId}`,
        entityId: proposal.entityId
          ?? (proposal.subject.trim().toLocaleLowerCase() === characterName.trim().toLocaleLowerCase()
            ? input.characterId
            : undefined)
          ?? (proposal.subject.trim().toLocaleLowerCase() === userName.trim().toLocaleLowerCase()
            ? '__user__'
            : undefined),
      }))
      let proposalFacts = previousFacts
      let proposalHistory = memoryFactHistory
      for (const proposal of scopedProposals) {
        const evidence = [...summaryWindow.selected].reverse().find((message) => {
          const content = message.content.toLocaleLowerCase()
          return [proposal.value, proposal.subject]
            .map((value) => value.trim().toLocaleLowerCase())
            .some((value) => value.length >= 2 && content.includes(value))
        })
        const applied = applyFactProposals(
          proposalFacts,
          proposalHistory,
          [proposal],
          evidence?.id ?? summaryWindow.processedThroughMessageId ?? '',
        )
        proposalFacts = applied.facts
        proposalHistory = applied.history
      }
      facts = proposalFacts
      memoryFactHistory = proposalHistory
      factStateUpdates = { memoryFactParseFailureCount: 0, memoryFactRetryAfterVersion: 0 }
    } else if (hasFactChangesSection && parsed.factChanges) {
      const applied = applyMemoryFactChanges(
        previousFacts,
        memoryFactHistory,
        parsed.factChanges,
        summaryWindow.processedThroughMessageId ?? '',
      )
      facts = applied.facts
      memoryFactHistory = applied.history
      factStateUpdates = { memoryFactParseFailureCount: 0, memoryFactRetryAfterVersion: 0 }
    } else if (shouldAttemptFactProposal && !hasFactsSection) {
      const failureCount = (session.memoryFactParseFailureCount ?? 0) + 1
      const retryAfterVersion = failureCount >= 3
        ? nextMemoryVersion + 2 ** (failureCount - 2)
        : nextMemoryVersion
      factStateUpdates = {
        memoryFactParseFailureCount: failureCount,
        memoryFactRetryAfterVersion: retryAfterVersion,
      }
    }

    const factUpdatesSucceeded = (shouldAttemptFactProposal && hasFactProposalsSection && !!parsed.factProposals)
      || (hasFactChangesSection && !!parsed.factChanges)
    const commit = await deps.updateSessionIfMemoryVersion(
      input.characterId,
      input.sessionId,
      baseMemoryVersion,
      {
        memory: parsed.summary || session.memory || '',
        memoryCurrentState: hasCurrentStateSection ? parsed.currentState : (session.memoryCurrentState ?? ''),
        memoryFacts: facts,
        ...(factUpdatesSucceeded ? { memoryFactHistory } : {}),
        ...factStateUpdates,
        factsVectors: [],
        factsVectorVersion: 0,
        memoryUpdatedAt: deps.now(),
        memoryLastMessageId: summaryWindow.processedThroughMessageId,
        memoryVersion: nextMemoryVersion,
      },
    )
    if (!commit.applied) return { status: 'skipped', reason: 'stale_version' }
    return {
      status: 'summarized',
      summary: parsed.summary || session.memory || '',
      currentState: hasCurrentStateSection ? parsed.currentState : (session.memoryCurrentState ?? ''),
      facts,
      memoryVersion: nextMemoryVersion,
    }
  }

  const summarize = (input: MemorySummaryRequest): Promise<MemorySummaryResult> => {
    const key = `${input.characterId}:${input.sessionId}`
    const existing = inFlight.get(key)
    if (existing) {
      if (!input.automatic && existing.automatic) {
        return existing.promise.then((result) => {
          if (result.status === 'skipped'
            && (result.reason === 'manual_mode' || result.reason === 'interval_not_reached')) {
            return summarize(input)
          }
          return result
        })
      }
      return existing.promise
    }
    const promise = run(input).finally(() => {
      if (inFlight.get(key)?.promise === promise) inFlight.delete(key)
    })
    inFlight.set(key, { promise, automatic: input.automatic === true })
    return promise
  }

  return {
    summarize,
    schedule(input) {
      void summarize({ ...input, automatic: true }).catch((error) => {
        log.warn('自动长记忆总结失败', {
          characterId: input.characterId,
          sessionId: input.sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    },
  }
}

export const memorySummaryService = createMemorySummaryService({
  fetchBuildData: (characterId, sessionId) => mainContextProvider.fetchBuildData(characterId, sessionId),
  listSessions: (characterId) => chatData.listSessions(characterId),
  readMessages: (characterId, sessionId) => chatData.readMessages(characterId, sessionId),
  updateSessionIfMemoryVersion: (characterId, sessionId, expectedVersion, updates) =>
    chatData.updateSessionIfMemoryVersion(characterId, sessionId, expectedVersion, updates),
  complete: (params) => chatWithRetry(
    getAdapter(params.provider),
    params,
    () => {},
    new AbortController().signal,
    1,
  ),
  countTokens,
  now: Date.now,
})

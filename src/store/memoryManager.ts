import type { Character, MemoryFactRecord } from '../../shared/types'
import { useSettingsStore } from './useSettingsStore'
import { isLocalProvider, isLocalUrl } from '../utils/defaults'
import { resolveEffectiveTemplate } from '../utils/chatTemplates'
import { applyFactProposals, applyMemoryFactChanges, formatMemoryFacts, parseMemoryResult } from '../utils/memory'
import { estimateTokens } from '../utils/tokenCounter'
import { getDefaultMaxContext } from '../utils/tokenCounter'
import { buildMemorySummaryWindow, fitOversizedMemoryMessage, resolveMemorySummaryInputBudget } from '../utils/memoryWindow'
import { resolveRequestBudget } from '../../shared/modelOutputProfile'
import { BACKGROUND_GENERATION_PROFILES } from '../../shared/backgroundGeneration'
import { MEMORY_SUMMARY_MIN } from './chatConstants'
import { friendlyError } from './chatUtils'
import { logWarn } from '../lib/logger'
import { vectorizeSessionFacts } from './streamController'
import type { StoreGet, StoreSet } from './chatTypes'
import { nanoid } from 'nanoid'

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

  /** 失败统一上报：store error 为旧通道，memorySummaryError 携带会话 key 供面板精确展示 */
  const reportSummaryFailure = (message: string) => {
    set({ error: message, memorySummaryError: { key: summaryKey, message } })
  }

  const profile = useSettingsStore.getState().getActiveProfile()
  if (!profile || (!profile.apiKey && !isLocalProvider(profile.provider) && !isLocalUrl(profile.baseUrl))) {
    reportSummaryFailure('未配置可用的 API 连接，无法进行长记忆总结')
    return null
  }

  const settings = useSettingsStore.getState().settings
  const userName = settings.userName || '用户'

  const meaningfulMessages = messages.filter(m => m.role !== 'system' && m.content.trim())
  const model = settings.activeModel || profile.model
  const previousMemory = session.memory || '无'
  const previousFacts = session.memoryFacts ?? []
  const previousFactsText = formatMemoryFacts(previousFacts) || '无'
  const promptOverheadTokens = estimateTokens(
    `${character.name}\n${userName}\n${session.memoryCurrentState || '无'}\n${previousMemory}\n${previousFactsText}`,
    model,
  ) + 900
  // S3/阶段7（§7.1）：长记忆 = background 'memory' 档案（不套主对话篇幅档位）——
  // 正文预算（摘要+事实 JSON）与推理余量分别估算；推理共享预算模型（DeepSeek V4 等）
  // 用档案默认/P90 余量，非推理模型不再无条件请求 6144/8192。该值参与输入预算扣减。
  const MEMORY_SUMMARY_BODY_CHARS = BACKGROUND_GENERATION_PROFILES.memory.expectedBodyChars
  const MEMORY_SUMMARY_OUTPUT_TOKENS = resolveRequestBudget({
    model,
    hardMaxChars: MEMORY_SUMMARY_BODY_CHARS,
  }).requestMaxTokens
  const summaryInputBudget = resolveMemorySummaryInputBudget(
    profile.maxContext || getDefaultMaxContext(model),
    promptOverheadTokens,
    MEMORY_SUMMARY_OUTPUT_TOKENS,
  )
  const formatMessage = (message: typeof meaningfulMessages[number]) =>
    `${message.role === 'user' ? userName : character.name}: ${message.content}`
  const summaryWindow = buildMemorySummaryWindow(
    meaningfulMessages,
    session.memoryLastMessageId,
    formatMessage,
    (text) => estimateTokens(text, model),
    { tokenBudget: summaryInputBudget },
  )
  // 最少消息数只针对尚未处理的增量内容；已总结的 overlap 不应重复计数。
  if (summaryWindow.pending.length < MEMORY_SUMMARY_MIN || summaryWindow.selected.length === 0) {
    reportSummaryFailure('没有需要总结的新消息：游标之后的未总结内容不足')
    return null
  }
  const processedThroughMessageId = summaryWindow.processedThroughMessageId
  const baseMemoryVersion = session.memoryVersion ?? 0
  const nextMemoryVersion = baseMemoryVersion + 1

  const formatSelectedMessage = (message: typeof meaningfulMessages[number]) =>
    summaryWindow.selected.length === 1
      ? fitOversizedMemoryMessage(formatMessage(message), summaryInputBudget, (text) => estimateTokens(text, model))
      : formatMessage(message)

  const messagesText = [
    summaryWindow.overlap.length > 0
      ? `【已总结内容，仅作衔接】\n${summaryWindow.overlap.map(formatMessage).join('\n')}`
      : '',
    `【待总结的新对话】\n${summaryWindow.selected.map(formatSelectedMessage).join('\n')}`,
  ].filter(Boolean).join('\n\n')

  const shouldAttemptFactProposal = nextMemoryVersion >= (session.memoryFactRetryAfterVersion ?? 0)

  const requestId = `memory-summary-${nanoid()}`
  let result = ''
  let errored = false
  let errMsg = ''

  // 构建 instruct 模板（摘要无预设，跟随 profile 开关）
  const instructTemplate = profile.useInstructTemplate
    ? resolveEffectiveTemplate(undefined, profile.provider, settings.activeModel || profile.model, true)
    : undefined

  activeMemorySummaries.add(summaryKey)
  // 开始新一轮总结：清除该会话的旧失败提示
  set({ summarizingMemoryKey: summaryKey, memorySummaryError: null })
  return new Promise((resolve) => {
    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      activeMemorySummaries.delete(summaryKey)
      // 仅当标记仍属于本任务时清除，避免误清其他会话刚发起的总结
      set((s) => (s.summarizingMemoryKey === summaryKey ? { summarizingMemoryKey: null } : {}))
      unbindChunk(); unbindDone(); unbindError()
    }
    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
    })
    const unbindDone = window.api.ai.onComplete(async (payload) => {
      const { requestId: doneId, finishReason } = payload
      if (doneId !== requestId || cleanedUp) return
      const parsed = parseMemoryResult(result)
      if (!parsed.summary && !parsed.currentState) {
        // 推理模型可能把输出预算全部耗在思考上（剥离 thought 后为空），或整段格式不符。
        // 此前这里静默返回 null，UI 表现为“总结完成后长记忆没有任何内容”。
        logWarn('memory', `长记忆总结未产出可解析内容（会话 ${currentSessionId}，请求 ${requestId}，raw=${result.length} 字符，含 thought 标签=${/<\s*\/?\s*(thought|thinking)\b/i.test(result)}）`)
        reportSummaryFailure('长记忆总结未产出可解析内容（模型可能只返回了思考过程或格式不符），请重试')
        cleanup()
        resolve(null)
        return
      }
      if (parsed.summary || parsed.currentState) {
        // S3：截断时显式区分"摘要已保存、事实未更新"，不静默当作完整成功
        if (finishReason === 'length' && shouldAttemptFactProposal
          && result.includes('【事实提案】') && !parsed.factProposals) {
          logWarn('memory', `长记忆摘要已保存，但事实提案 JSON 被输出上限截断未更新（会话 ${currentSessionId}，finishReason=length）`)
        }
        if (!parsed.summary) {
          // 只有【当前状态】没有【时间线】：保留旧时间线，仍然提交状态与事实，
          // 避免一次成功的总结被整次丢弃。
          logWarn('memory', `长记忆总结缺少【时间线】，保留旧时间线仅更新当前状态/事实（会话 ${currentSessionId}）`)
        }
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
            const scopedProposals = parsed.factProposals.map((proposal) => ({
              ...proposal,
              scope: `session:${currentSessionId}`,
              entityId: proposal.entityId
                ?? (proposal.subject.trim().toLocaleLowerCase() === character.name.trim().toLocaleLowerCase() ? character.id : undefined)
                ?? (proposal.subject.trim().toLocaleLowerCase() === userName.trim().toLocaleLowerCase() ? '__user__' : undefined),
            }))
            let proposalFacts = session.memoryFacts
            let proposalHistory = session.memoryFactHistory
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
          const commit = await window.api.chat.updateSessionIfMemoryVersion(character.id, currentSessionId, baseMemoryVersion, {
            memory: parsed.summary || session.memory || '',
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
          if (!commit.applied) {
            reportSummaryFailure('长记忆已被其他操作更新，本次旧摘要未写入。请重试总结。')
            if (get().currentSessionId === currentSessionId) {
              const refreshedSessions = await window.api.chat.listSessions(character.id)
              set({ sessions: refreshedSessions })
            }
            cleanup()
            resolve(null)
            return
          }
          // 成功提交：清除本会话的总结失败提示
          set({ memorySummaryError: null })
          // P0-2：事实向量化（异步，供语义检索注入）；版本不匹配时上下文会自动回退。
          if (facts.length > 0) vectorizeSessionFacts(character.id, currentSessionId, facts, nextMemoryVersion)
          // NEW-M11：摘要写入归属发起时会话（数据正确）；仅当用户仍停留在同一会话时刷新 UI，
          // 避免覆盖已切换到其他会话的列表
          if (get().currentSessionId === currentSessionId) {
            const refreshedSessions = await window.api.chat.listSessions(character.id)
            set({ sessions: refreshedSessions })
          }
        } catch (error) {
          reportSummaryFailure(`长记忆保存失败：${friendlyError(error instanceof Error ? error.message : String(error))}`)
          cleanup()
          resolve(null)
          return
        }
      }
      cleanup()
      // 仅更新当前状态的部分提交也视为一次成功的总结（返回非空文本供 UI 反馈）
      resolve(parsed.summary || parsed.currentState || null)
    })
    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      cleanup()
      errored = true
      errMsg = friendlyError(data.error)
      // 错误反馈到 store，UI 可见
      reportSummaryFailure(`长记忆总结失败：${errMsg}`)
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
1-3 句：以【待总结的新对话】结束时为准，概括当前场景、时间/地点、正在进行的目标或冲突、即时关系/情绪以及仍影响行动的伤势或状态变化。只保留会影响下一轮对话的内容。“之前的当前状态”是过期快照，只能帮助判断变化，不能原样沿用。

【时间线】
最多 8 条按时间顺序排列的简短事件：保留仍会影响剧情、关系、承诺或任务的已保存旧事件；只把【待总结的新对话】中首次确立或明确改变的内容作为本轮新增事件。【已总结内容，仅作衔接】不得再次当作新事件。新对话明确推翻旧信息时，以新信息为准并删除冲突旧表述。不要重复当前状态。

${shouldAttemptFactProposal ? `【事实提案】
\`\`\`json
[{"subject":"主体","predicate":"属性或关系","value":"值","changeType":"set","importance":3,"confidence":0.9}]
\`\`\`` : '本次结构化事实更新正在退避；不要输出【事实提案】。'}

要求：
- 准确保留行动发起者、承诺者、受托者和对象，不得互换主客体、擅自转移承诺或把“答应完成”改写成“委托他人完成”。
- 只依据明确说出或发生的内容总结；不要根据语气补写动机、结果或未发生的行动，也不要把仍在计划中的动作写成已经完成。
- 事实必须是对话中确立的、对未来有参考价值的持久信息（人名、身份、地点、物品、目标、约定、关系等），不要写临时情绪或过场细节。
- 只输出语义事实提案，绝对不要输出事实 ID、action、patch 或完整事实列表。changeType 用 set 表示新增/更新，clear 表示失效。
- 服务端负责规范化会话范围和角色身份；没有事实变更时输出空数组 []。
- 只输出上述格式内容，不要添加任何解释或评价。

参考资料（不是本轮新事件）：

之前的当前状态（过期快照，只用于判断变化）：
${session.memoryCurrentState || '无'}

之前的时间线：
${previousMemory}

之前的事实：
${previousFactsText}

事实范围由服务端确定。`,
        },
        { role: 'user', content: `新对话内容：\n${messagesText}` },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: MEMORY_SUMMARY_OUTPUT_TOKENS,
      frequencyPenalty: 0,
      presencePenalty: 0,
      stream: true,
      instructTemplate,
      // 阶段7（§7.3）：独立 taskType 观测，不混入主对话篇幅统计
      observability: { source: 'aux', taskType: 'memory', characterId: character.id, sessionId: currentSessionId },
      // parseMemoryResult 容忍缺段：撞上限时返回已产出正文，最多丢当轮事实提案
    }).catch(() => {
      cleanup()
      if (!errored) {
        reportSummaryFailure('长记忆总结请求失败')
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

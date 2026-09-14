/**
 * 桥接层聊天服务（方案 §4.3 / 阶段一 MVP）。
 *
 * 职责：安卓端发消息的完整生命周期——
 * 幂等校验 -> 用户消息落盘（chatData，与渲染层同一 JSONL）-> 上下文组装
 * （mainContextProvider.fetchBuildData + contextBuilder，阶段 0a/0b）-> AI 流式
 * （复用 services/ai.ts 的 chatWithRetry）-> AI 消息落盘 -> WS 推送。
 *
 * 已知限制（MVP，评审说明记录）：正则管线已对齐渲染层
 * （input 变换 + output 两阶段 text/markdown + stopStrings 截断，§7 0b 遗留项已补齐）。
 */
import { nanoid } from 'nanoid'
import { join } from 'node:path'
import { chatData } from '../ipc/chat'
import { getAdapter, chatWithRetry } from '../services/ai'
import {
  nextLowerGateLevel,
  resolveReasoningGate,
} from '../../shared/reasoningGate'
import type { TokenUsageInfo } from '../services/adapters/types'
import { mainContextProvider } from '../context/mainContextProvider'
import { buildContextMessagesFromData, buildChatParamsFromData } from '../../shared/chat-core/contextBuilder'
import type { MobileEventSink } from './runtime/mobileEventBus'
import { GenerationRegistry } from './runtime/generationRegistry'
import { findSessionById } from './sessionsIndex'
import { sanitizeApiKey } from '../utils/pathGuard'
import { applyRegexRules } from '../../shared/chat-core/regex'
import { createLogger } from '../services/logger'
import type { AICompletion, Character, ChatParams, Message, ProviderType, RegexRule } from '../../shared/types'
import { resolveNarrativeMode } from '../../shared/narrativeMode'
import { translationMaxTokens } from '../../shared/chat-core/chatConstants'
import { generateBridgeDirections } from './dialogueDirections'
import { groupData } from '../ipc/group'
import { buildMessageTranslationSystemPrompt } from '../../shared/translationPrompt'
import { readJson } from '../services/storage'
import { DIRS } from '../services/storage'
import { getDefaultSettings } from '../../shared/defaults'
import { restoreSecrets } from '../ipc/settings'
import { getCharacter } from '../services/charCard'
import type { DialogueDirection, Settings } from '../../shared/types'
import { trimContinuationOverlap } from '../../shared/chat-core/messagePostProcess'
import { mergeTailRepair, type FinalizedAssistantOutput } from '../../shared/assistantOutputFinalizer'
import { enabledProfileOverride, formatRequestBudgetRisk, resolveRequestBudget } from '../../shared/modelOutputProfile'
import { finalizeGenerationTerminalResult } from '../../shared/chat-core/generatedReplyPipeline'
import { finalizeNoticeFields } from '../../shared/generationNotice'
import { terminationCauseFromFinishReason } from '../../shared/generationTermination'

// H-10 修复：幂等缓存 TTL（覆盖安卓端断线重发窗口后清理，避免无界内存增长）
const IDEMPOTENCY_TTL_MS = 60_000

const log = createLogger('bridge-chat')

/** 会话变更通知（注入：主进程广播渲染层 + WS 转发） */
export type SessionChangedNotifier = (sessionId: string, change: string) => void

export class BridgeChatService {
  private readonly events: MobileEventSink
  private readonly notifySessionChanged: SessionChangedNotifier
  private readonly generations: GenerationRegistry
  /** 幂等键 -> 已处理的用户消息（防弱网重发双条，§4.3） */
  private readonly idempotency = new Map<string, Message>()
  /** 处理中的请求（防重复触发） */
  private readonly inFlight = new Set<string>()

  constructor(events: MobileEventSink, notifySessionChanged: SessionChangedNotifier, generations = new GenerationRegistry()) {
    this.events = events
    this.notifySessionChanged = notifySessionChanged
    this.generations = generations
  }

  /**
   * 为已落盘的 AI 消息补齐“下一步方向”（会话未开启时内部直接返回）。
   * 供 sendMessage 自动触发与安卓端“换一批”复用。
   */
  private async generateDirectionsFor(
    sessionId: string,
    messageId: string,
    characterName: string,
    characterId: string,
  ): Promise<void> {
    const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'), 'settings') ?? getDefaultSettings()
    restoreSecrets(settings)
    const profile = settings.connectionProfiles?.find((p) => p.id === settings.activeProfileId)
    if (!profile) return
    const directions = await generateBridgeDirections({
      sessionId,
      messageId,
      characterName,
      userName: settings.userName || '用户',
      profile: {
        provider: profile.provider,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model: settings.activeModel || profile.model,
        capabilityOverride: profile.capabilityOverride,
      },
    })
    if (directions.length > 0) {
      void characterId
      this.notifySessionChanged(sessionId, 'message')
    }
  }

  /** 安卓端“换一批”：重新生成指定消息的方向并落盘，返回最新方向。 */
  async regenerateDirections(sessionId: string, messageId: string): Promise<DialogueDirection[]> {
    const session = await findSessionById(sessionId)
    if (!session) throw new Error('会话不存在')
    const messages = chatData.readMessages(session.characterId, sessionId)
    const target = messages.find((m) => m.id === messageId)
    if (!target || target.role !== 'assistant') throw new Error('目标消息不存在')
    const character = getCharacter(session.characterId)
    await this.generateDirectionsFor(sessionId, messageId, character?.name ?? '', session.characterId)
    const updated = chatData.readMessages(session.characterId, sessionId).find((m) => m.id === messageId)
    return updated?.dialogueDirections ?? []
  }

  /** 清空幂等缓存（重启/内存压力时可调用） */
  resetIdempotency(): void {
    this.idempotency.clear()
  }

  /**
   * 发消息：落盘用户消息 -> 组装上下文 -> AI 流式 -> AI 消息落盘 -> 推送 done。
   * @returns 用户消息（已落盘）
   */
  async sendMessage(
    sessionId: string,
    requestId: string,
    content: string,
    replyToId?: string,
    images?: string[],
  ): Promise<Message> {
    // 幂等：同一 requestId 重复请求直接返回已处理结果
    const existing = this.idempotency.get(requestId)
    if (existing) return existing
    if (this.inFlight.has(requestId)) {
      throw new Error('请求处理中，请勿重复发送')
    }
    this.inFlight.add(requestId)

    try {
      const session = await findSessionById(sessionId)
      if (!session) throw new Error('会话不存在')
      const characterId = session.characterId
      const sessionNarrativeMode = resolveNarrativeMode(session.narrativeMode)

      const data = await mainContextProvider.fetchBuildData(characterId, sessionId)
      if (!data.character) throw new Error(`角色不存在：${characterId}`)

      // 正则管线（对齐渲染层 sendMessage 的 input 变换，§7 0b 评审遗留项）
      let processedContent = content
      if (data.regexRules.length > 0) {
        processedContent = applyRegexRules(content, data.regexRules, 'input', 'text').text
      }

      // 用户消息落盘（与渲染层 window.api.chat.saveMessage 同一 appendMessage 路径）
      const userMessage: Message = {
        id: nanoid(),
        sessionId,
        characterId,
        role: 'user',
        content: processedContent,
        images: images ?? [],
        isEditing: false,
        timestamp: Date.now(),
        replyToId: replyToId ?? undefined,
        narrativeMode: sessionNarrativeMode,
        speakerKind: sessionNarrativeMode === 'omniscient' ? 'narrator' : 'persona',
        generationKind: 'manual',
      }
      chatData.saveMessage(characterId, userMessage)
      this.idempotency.set(requestId, userMessage)
      this.notifySessionChanged(sessionId, 'message')

      // CR-2 修复：落盘后再取快照——此前用落盘前的旧快照构建上下文，
      // AI 看不到本条用户消息（对上一轮作答）。saveMessage 后重新读取消息文件。
      const freshData = await mainContextProvider.fetchBuildData(characterId, sessionId)
      const built = buildContextMessagesFromData(freshData)
      const { messages, narrativeMode } = built
      const budgetRisk = formatRequestBudgetRisk(built.requestBudget)
      if (budgetRisk) {
        log.warn(`拒绝高风险输出预算 | requestId=${requestId} | ${budgetRisk}`)
        throw new Error(budgetRisk)
      }
      const params = buildChatParamsFromData(freshData, messages, { requestMaxTokens: built.requestMaxTokens })
      params.requestId = requestId
      if (params.observability) params.observability.generationType = 'normal'

      // AI 流式（复用主进程 AI 服务，chunk 经 WS 推送）
      const controller = this.generations.create(requestId)
      const chunks: string[] = []
      const aiMessageId = nanoid()
      // 阶段6灰度：legacy 管线正文原样落盘（管线内跳过收尾器/补尾，不标记语义分块）
      const legacyPipeline = (freshData.settings.settings.generationPipeline ?? 'unified') === 'legacy'

      const onChunk = (text: string) => {
        chunks.push(text)
        this.events.publish('ai:chunk', { requestId, sessionId, delta: text })
      }
      const onUsage = (usage: TokenUsageInfo) => {
        this.events.publish('ai:usage', { requestId, sessionId, ...usage })
      }

      let fullContent: string
      let finishReason: AICompletion['finishReason'] = 'unknown'
      try {
        // 阶段3契约：chatWithRetry 返回 AICompletion（网络中断但有正文时也返回部分正文）
        let completion = await chatWithRetry(
          getAdapter(params.provider),
          params,
          onChunk,
          controller.signal,
          0, // 流式不重试（与渲染层一致：已发送的 chunks 无法撤回）
          onUsage,
        )
        // 阶段8（§4.5）：空正文 + 提前中止 → 降一档重发一次（复用同一请求快照，
        // 只按新档位重算预算）。与 PC 单聊同规则：至多一次、有正文不触发、用户停止不触发。
        const gateLevel = params.reasoningGate?.level
        const nextLevel = completion.earlyAbort && !completion.text.trim() && gateLevel
          ? nextLowerGateLevel(gateLevel)
          : null
        if (nextLevel) {
          const nextGate = resolveReasoningGate({ model: params.model, requestedLevel: nextLevel, enabled: true })
          const nextBudget = resolveRequestBudget({
            model: params.model,
            hardMaxChars: built.responsePolicy.hardMaxChars,
            userHardCap: data.preset?.maxTokens,
            profileOverride: enabledProfileOverride(data.settings.profile?.capabilityOverride),
            reasoningGate: nextGate,
          })
          completion = await chatWithRetry(
            getAdapter(params.provider),
            {
              ...params,
              requestId: `${requestId}-downgrade`,
              maxTokens: nextBudget.requestMaxTokens,
              reasoningGate: {
                level: nextLevel,
                knob: nextGate.knob,
                tokens: nextGate.gateTokens,
              },
              observability: {
                ...(params.observability ?? { source: 'bridge' }),
                source: params.observability?.source ?? 'bridge',
                downgradeRetry: true,
              },
            },
            onChunk,
            controller.signal,
            0,
            onUsage,
          )
        }
        fullContent = completion.text
        finishReason = completion.finishReason
      } catch (err) {
        if (controller.signal.aborted) {
          // 客户端停止：保留已生成部分，落盘并推送 done
          fullContent = chunks.join('')
          finishReason = 'cancelled'
        } else {
          // 阶段7：Bridge partial error 接入同一终止收口——
          // 已流出的半截正文必须先经统一最终处理管线，稳定正文才允许落盘；
          // 错误只进 generationError（矩阵 transport_error），不拼进正文。
          const errMsg = sanitizeApiKey((err as Error).message)
          const partialText = chunks.join('')
          if (partialText.trim()) {
            const result = await finalizeGenerationTerminalResult({
              terminalResult: { rawText: partialText, finishReason: 'unknown', terminationCause: 'transport_error', errorMessage: errMsg },
              regexRules: data.regexRules,
              characterName: data.character.translatedContent?.name || data.character.name,
              legacy: legacyPipeline,
            })
            if (result.persistable && result.content) {
              const partialMessage: Message = {
                id: aiMessageId,
                sessionId,
                characterId,
                role: 'assistant',
                content: result.content,
                images: [],
                isEditing: false,
                timestamp: Date.now(),
                narrativeMode,
                speakerKind: 'character',
                generationKind: 'assistant_reply',
                ...(legacyPipeline ? {} : { contentRenderMode: 'blocks' as const }),
                ...result.noticeFields,
              }
              chatData.saveMessage(characterId, partialMessage)
              // 安卓端以 ai:done 替换流式占位；generationError 字段承载中断提示
              this.events.publish('ai:done', { requestId, sessionId, message: partialMessage, finishReason: 'network_error' })
              this.notifySessionChanged(sessionId, 'message')
              log.warn('AI 生成中断（已保留稳定正文）', { error: errMsg })
              return userMessage
            }
          }
          this.events.publish('ai:error', { requestId, sessionId, message: errMsg })
          log.warn('AI 生成失败', { error: errMsg })
          throw err
        }
      } finally {
        this.generations.release(requestId)
      }

      // AI 消息落盘 + 推送 done（安卓端替换流式占位）
      // S1/阶段7：正则、停止字符串、收尾器与终止协调统一在 finalizeBridgeReply 内执行（只执行一次）
      const finalizedReply = await this.finalizeBridgeReply({
        rawText: fullContent,
        finishReason,
        character: data.character,
        params,
        regexRules: data.regexRules,
        legacy: legacyPipeline,
        autoTailRepairEnabled: data.settings.settings.autoTailRepairEnabled,
      })
      if (!finalizedReply.content) {
        // 矩阵末行：任意异常且无可用正文 → 不创建空 AI 消息，明确错误与重试入口
        const errMsg = finalizedReply.noticeFields.generationError || '模型未返回可用内容，请重试'
        this.events.publish('ai:error', { requestId, sessionId, message: errMsg })
        throw new Error(errMsg)
      }
      const aiMessage: Message = {
        id: aiMessageId,
        sessionId,
        characterId,
        role: 'assistant',
        content: finalizedReply.content,
        images: [],
        isEditing: false,
        timestamp: Date.now(),
        narrativeMode,
        speakerKind: 'character',
        generationKind: 'assistant_reply',
        // 阶段5：新内容使用语义分块渲染；legacy 不标记
        ...(legacyPipeline ? {} : { contentRenderMode: 'blocks' as const }),
        // S6：收尾提示/失败原因随消息下发（Android 与 PC 同义展示）
        ...finalizedReply.noticeFields,
      }
      chatData.saveMessage(characterId, aiMessage)
      this.events.publish('ai:done', { requestId, sessionId, message: aiMessage, finishReason: finalizedReply.finishReason })
      this.notifySessionChanged(sessionId, 'message')
      // “下一步方向”：回复落盘后异步补齐，不阻塞 done 推送；失败静默降级。
      // 仅传入连接参数，模块内部按会话开关与消息有效性自行判断。
      void this.generateDirectionsFor(sessionId, aiMessage.id, data.character.name, characterId)
      // H-10 修复：幂等缓存保留 60s 幂等窗口后清理（含 base64 图片可达数 MB/条，长期不清理无界增长）
      setTimeout(() => { this.idempotency.delete(requestId) }, IDEMPOTENCY_TTL_MS)
      return userMessage
    } finally {
      this.inFlight.delete(requestId)
    }
  }

  /**
   * Swipe 切换候选（direction=±1 循环切换；direction=0 = 重新生成追加新候选，§4.3 协议假设）。
   */
  async swipe(sessionId: string, messageId: string, direction: number): Promise<Message> {
    const session = await findSessionById(sessionId)
    if (!session) throw new Error('会话不存在')
    const characterId = session.characterId
    const messages = chatData.readMessages(characterId, sessionId)
    const target = messages.find((m) => m.id === messageId)
    if (!target || target.role !== 'assistant') throw new Error('目标消息不存在或不可切换')

    if (direction === 0) {
      // 重新生成：追加新候选（对齐 PC 侧 regenerateChatMessage：不删除原消息）
      return this.regenerate(characterId, sessionId, target)
    }

    const swipes = target.swipes ?? [target.content]
    if (swipes.length < 2) return target
    const current = target.swipeIndex ?? 0
    const next = (current + direction + swipes.length) % swipes.length
    const updated: Message = { ...target, content: swipes[next], swipeIndex: next }
    chatData.saveMessage(characterId, updated)
    this.notifySessionChanged(sessionId, 'swiped')
    return updated
  }

  /**
   * 阶段4/7：Bridge 与桌面端共用同一条终止协调入口与收尾管线（方案 §4.2/§7.4——一个 shared 入口）。
   * 顺序固定为：推理残留清理 → output 正则 → 停止字符串 → 收尾器 → 至多一次短补尾
   * （补尾只在 provider_length 且稳定正文不足时由协调入口发起）。
   * 正则只在管线内执行一次，调用方不得在管线外重复应用。
   */
  private async finalizeBridgeReply(input: {
    rawText: string
    finishReason: AICompletion['finishReason']
    character: Character
    params: ChatParams
    regexRules: RegexRule[]
    legacy: boolean
    autoTailRepairEnabled?: boolean
  }): Promise<{
    content: string
    finishReason: AICompletion['finishReason']
    noticeFields: { generationNotice?: string; generationError?: string }
  }> {
    const terminationCause = terminationCauseFromFinishReason(input.finishReason)
    const charName = input.character.translatedContent?.name || input.character.name
    const result = await finalizeGenerationTerminalResult({
      terminalResult: { rawText: input.rawText, finishReason: input.finishReason, terminationCause },
      regexRules: input.regexRules,
      characterName: charName,
      legacy: input.legacy,
      runTailRepair: input.autoTailRepairEnabled === false ? undefined : (finalized) => this.attemptBridgeTailRepair({
        finalized,
        character: input.character,
        params: input.params,
        charName,
      }),
    })
    if (!result.persistable || !result.content) {
      return { content: '', finishReason: input.finishReason, noticeFields: result.noticeFields }
    }
    // S6：收尾状态随消息落盘，Android 与 PC 展示同义提示；
    // 异常类提示（协调入口生成）优先于收尾器轻提示，两者互斥不同时出现
    const coordinatorHasPrompt = Object.keys(result.noticeFields).length > 0
    const noticeFields = coordinatorHasPrompt
      ? result.noticeFields
      : (input.legacy ? {} : finalizeNoticeFields({
          finishReason: input.finishReason,
          notice: result.notice,
          repairFailed: result.repairFailed,
        }))
    return { content: result.content, finishReason: input.finishReason, noticeFields }
  }

  /** 一次短补尾：独立非流式请求，正文预算 ~200 字 + 模型推理余量；失败返回 null 保留稳定前缀 */
  private async attemptBridgeTailRepair(input: {
    finalized: FinalizedAssistantOutput
    character: Character
    params: ChatParams
    charName: string
  }): Promise<string | null> {
    if (!input.finalized.repairContext) return null
    try {
      const budget = resolveRequestBudget({ model: input.params.model, hardMaxChars: 200 })
      const repairCompletion = await chatWithRetry(
        getAdapter(input.params.provider),
        {
          ...input.params,
          requestId: `bridge-repair-${nanoid(4)}`,
          messages: [
            {
              role: 'system',
              content: '请只补完下面这条回复的最后一句，并在 30–100 个汉字内自然结束本轮。不要复述已有内容，不新增事件、人物、地点或第二轮对白，不写标题或说明。只输出需要接在末尾的新文字。',
            },
            { role: 'user', content: `【角色】${input.charName}\n【已生成的回复结尾】\n${input.finalized.repairContext}` },
          ],
          maxTokens: budget.requestMaxTokens,
          stream: false,
          tools: undefined,
          toolChoice: undefined,
          observability: {
            source: 'bridge',
            generationType: 'quiet',
            characterId: input.character.id,
            sessionId: input.params.observability?.sessionId,
          },
        },
        () => {},
        new AbortController().signal,
        0,
      )
      // 合并与复检统一走 shared mergeTailRepair（与渲染层同一入口）
      const merged = mergeTailRepair({
        finalized: input.finalized,
        repairText: repairCompletion.text,
        trimOverlap: trimContinuationOverlap,
        finishReason: 'stop',
      })
      return merged.notice === 'tail_repaired' && merged.content ? merged.content : null
    } catch {
      // 补尾失败：保留稳定前缀（方案 §5.2 步骤 9）
      return null
    }
  }

  /** 重新生成：组装上下文 -> AI 生成 -> 追加 swipes 候选并落盘 */
  private async regenerate(characterId: string, sessionId: string, target: Message): Promise<Message> {
    const data = await mainContextProvider.fetchBuildData(characterId, sessionId)
    if (!data.character) throw new Error(`角色不存在：${characterId}`)
    const built = buildContextMessagesFromData(data)
    const { messages, narrativeMode } = built
    const budgetRisk = formatRequestBudgetRisk(built.requestBudget)
    if (budgetRisk) throw new Error(budgetRisk)
    const params = buildChatParamsFromData(data, messages, { requestMaxTokens: built.requestMaxTokens })
    const requestId = `regen-${Date.now()}-${nanoid(4)}`
    params.requestId = requestId
    if (params.observability) params.observability.generationType = 'regenerate'

    const controller = this.generations.create(requestId)
    const chunks: string[] = []
    try {
      const regenCompletion = await chatWithRetry(
        getAdapter(params.provider),
        params,
        (text) => { chunks.push(text) },
        controller.signal,
        0,
      )
      // 阶段4/S1：统一收尾管线（与桌面端同顺序）；阶段6灰度 legacy 正文原样落盘
      const legacyPipeline = (data.settings.settings.generationPipeline ?? 'unified') === 'legacy'
      const finalizedReply = await this.finalizeBridgeReply({
        rawText: regenCompletion.text,
        finishReason: regenCompletion.finishReason,
        character: data.character,
        params,
        regexRules: data.regexRules,
        legacy: legacyPipeline,
        autoTailRepairEnabled: data.settings.settings.autoTailRepairEnabled,
      })
      const finalContent = finalizedReply.content
      if (!finalContent) {
        // 矩阵末行：无可用正文不追加快照候选（不创建空 AI 内容）
        throw new Error(finalizedReply.noticeFields.generationError || '模型未返回可用内容，请重试')
      }
      const swipes = target.swipes ?? [target.content]
      const updated: Message = {
        ...target,
        swipes: [...swipes, finalContent],
        swipeIndex: swipes.length,
        content: finalContent,
        narrativeMode,
        speakerKind: 'character',
        generationKind: 'regenerate',
        // 阶段5：新内容使用语义分块渲染；legacy 不标记
        ...(legacyPipeline ? {} : { contentRenderMode: 'blocks' as const }),
        // S6：收尾提示/失败原因随候选下发（与 PC regenerate 一致）
        ...finalizedReply.noticeFields,
      }
      chatData.saveMessage(characterId, updated)
      this.notifySessionChanged(sessionId, 'message')
      return updated
    } finally {
      this.generations.release(requestId)
    }
  }

  /** 翻译：对齐渲染层 translateMessage 的 prompt 与参数 */
  async translate(sessionId: string, messageId: string): Promise<{ messageId: string; translation: string }> {
    const session = await findSessionById(sessionId)
    if (!session) throw new Error('会话不存在')
    const characterId = session.characterId
    const messages = chatData.readMessages(characterId, sessionId)
    const target = messages.find((m) => m.id === messageId)
    if (!target) throw new Error('目标消息不存在')

    const data = await mainContextProvider.fetchBuildData(characterId, sessionId)
    const profile = data.settings.profile
    const settings = data.settings.settings
    if (!profile) throw new Error('未配置 API 连接')
    const targetLang = settings.translationTargetLang || '中文'
    const provider = (profile.provider || 'openai') as ProviderType
    const model = settings.activeModel || profile.model

    const requestId = `translate-${messageId}-${Date.now()}`
    const controller = this.generations.create(requestId)
    try {
      const translationCompletion = await chatWithRetry(
        getAdapter(provider),
        {
          requestId,
          messages: [
            { role: 'system', content: buildMessageTranslationSystemPrompt(targetLang) },
            { role: 'user', content: target.content },
          ],
          provider,
          apiKey: profile.apiKey,
          baseUrl: profile.baseUrl,
          model,
          temperature: 0.3,
          topP: 0.9,
          maxTokens: translationMaxTokens(target.content, model),
          frequencyPenalty: 0,
          presencePenalty: 0,
          stream: true,
          reasoningMode: 'disabled',
        },
        () => {},
        controller.signal,
        0,
      )
      // 落盘 translation（渲染层 saveMessage 语义：同 id 覆盖）
      const translation = translationCompletion.text
      const updated: Message = { ...target, translation }
      chatData.saveMessage(characterId, updated)
      this.notifySessionChanged(sessionId, 'message')
      return { messageId, translation }
    } finally {
      this.generations.release(requestId)
    }
  }

  /**
   * 群聊消息翻译：与单聊 translate 同一实现口径（动态预算、可取消、推理隔离），
   * 落盘走 groupData（同 id 覆盖式写回，对齐群聊渲染层语义）。
   * 原 routes 内联旧实现（硬编码预算 + 不可取消）已并入此处。
   */
  async translateGroup(groupId: string, sessionId: string, messageId: string): Promise<{ messageId: string; translation: string }> {
    const messages = groupData.readMessages(groupId, sessionId)
    const target = messages.find((m) => m.id === messageId)
    if (!target) throw new Error('目标消息不存在')

    const settings = readJson<Settings>(join(DIRS.config(), 'settings.json'), 'settings') ?? getDefaultSettings()
    restoreSecrets(settings)
    const profile = settings.connectionProfiles?.find((p) => p.id === settings.activeProfileId)
    if (!profile) throw new Error('未配置 API 连接')
    const targetLang = settings.translationTargetLang || '中文'
    const provider = (profile.provider || 'openai') as ProviderType
    const model = settings.activeModel || profile.model

    const requestId = `translate-${messageId}-${Date.now()}`
    const controller = this.generations.create(requestId)
    try {
      const translationCompletion = await chatWithRetry(
        getAdapter(provider),
        {
          requestId,
          messages: [
            { role: 'system', content: buildMessageTranslationSystemPrompt(targetLang) },
            { role: 'user', content: target.content },
          ],
          provider,
          apiKey: profile.apiKey,
          baseUrl: profile.baseUrl,
          model,
          temperature: 0.3,
          topP: 0.9,
          maxTokens: translationMaxTokens(target.content, model),
          frequencyPenalty: 0,
          presencePenalty: 0,
          stream: true,
          reasoningMode: 'disabled',
        },
        () => {},
        controller.signal,
        0,
      )
      const translation = translationCompletion.text
      groupData.updateMessage(groupId, sessionId, { ...target, translation })
      return { messageId, translation }
    } finally {
      this.generations.release(requestId)
    }
  }
}

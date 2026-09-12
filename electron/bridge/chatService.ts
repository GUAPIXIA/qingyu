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
import type { TokenUsageInfo } from '../services/adapters/types'
import { mainContextProvider } from '../context/mainContextProvider'
import { buildContextMessagesFromData, buildChatParamsFromData } from '../../src/context/contextBuilder'
import type { MobileEventSink } from './runtime/mobileEventBus'
import { GenerationRegistry } from './runtime/generationRegistry'
import { findSessionById } from './sessionsIndex'
import { sanitizeApiKey } from '../utils/pathGuard'
import { applyRegexRules, applyOutputRegexRules, truncateAtStop, collectStopStrings } from '../../src/utils/regex'
import { createLogger } from '../services/logger'
import type { Message, ProviderType } from '../../shared/types'
import { resolveNarrativeMode } from '../../shared/narrativeMode'
import { translationMaxTokens } from '../../src/store/chatConstants'
import { generateBridgeDirections } from './dialogueDirections'
import { readJson } from '../services/storage'
import { DIRS } from '../services/storage'
import { getDefaultSettings } from '../../shared/defaults'
import { restoreSecrets } from '../ipc/settings'
import { getCharacter } from '../services/charCard'
import type { DialogueDirection, Settings } from '../../shared/types'

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
      const { messages, narrativeMode } = buildContextMessagesFromData(freshData)
      const params = buildChatParamsFromData(freshData, messages)
      params.requestId = requestId

      // AI 流式（复用主进程 AI 服务，chunk 经 WS 推送）
      const controller = this.generations.create(requestId)
      const chunks: string[] = []
      const aiMessageId = nanoid()

      const onChunk = (text: string) => {
        chunks.push(text)
        this.events.publish('ai:chunk', { requestId, sessionId, delta: text })
      }
      const onUsage = (usage: TokenUsageInfo) => {
        this.events.publish('ai:usage', { requestId, sessionId, ...usage })
      }

      let fullContent: string
      try {
        fullContent = await chatWithRetry(
          getAdapter(params.provider),
          params,
          onChunk,
          controller.signal,
          0, // 流式不重试（与渲染层一致：已发送的 chunks 无法撤回）
          onUsage,
        )
      } catch (err) {
        if (controller.signal.aborted) {
          // 客户端停止：保留已生成部分，落盘并推送 done
          fullContent = chunks.join('')
        } else {
          const errMsg = sanitizeApiKey((err as Error).message)
          this.events.publish('ai:error', { requestId, sessionId, message: errMsg })
          log.warn('AI 生成失败', { error: errMsg })
          throw err
        }
      } finally {
        this.generations.release(requestId)
      }

      // AI 消息落盘 + 推送 done（安卓端替换流式占位）
      // 正则管线（对齐渲染层 onComplete 的 output 变换：output 两阶段 text/markdown + 停止字符串截断）
      let finalContent = fullContent
      if (data.regexRules.length > 0) {
        finalContent = applyOutputRegexRules(fullContent, data.regexRules)
        finalContent = truncateAtStop(finalContent, collectStopStrings(data.regexRules)).text
      }
      const aiMessage: Message = {
        id: aiMessageId,
        sessionId,
        characterId,
        role: 'assistant',
        content: finalContent,
        images: [],
        isEditing: false,
        timestamp: Date.now(),
        narrativeMode,
        speakerKind: 'character',
        generationKind: 'assistant_reply',
      }
      chatData.saveMessage(characterId, aiMessage)
      this.events.publish('ai:done', { requestId, sessionId, message: aiMessage })
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

  /** 重新生成：组装上下文 -> AI 生成 -> 追加 swipes 候选并落盘 */
  private async regenerate(characterId: string, sessionId: string, target: Message): Promise<Message> {
    const data = await mainContextProvider.fetchBuildData(characterId, sessionId)
    if (!data.character) throw new Error(`角色不存在：${characterId}`)
    const { messages, narrativeMode } = buildContextMessagesFromData(data)
    const params = buildChatParamsFromData(data, messages)
    const requestId = `regen-${Date.now()}-${nanoid(4)}`
    params.requestId = requestId

    const controller = this.generations.create(requestId)
    const chunks: string[] = []
    try {
      const full = await chatWithRetry(
        getAdapter(params.provider),
        params,
        (text) => { chunks.push(text) },
        controller.signal,
        0,
      )
      const swipes = target.swipes ?? [target.content]
      const updated: Message = {
        ...target,
        swipes: [...swipes, full],
        swipeIndex: swipes.length,
        content: full,
        narrativeMode,
        speakerKind: 'character',
        generationKind: 'regenerate',
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
      const translation = await chatWithRetry(
        getAdapter(provider),
        {
          requestId,
          messages: [
            { role: 'system', content: `你是一个翻译助手。请将以下文本翻译成${targetLang}。只输出翻译结果，不要添加任何解释或额外内容。保留原文中的 Markdown 格式、HTML 标签和特殊符号不变。` },
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
      const updated: Message = { ...target, translation }
      chatData.saveMessage(characterId, updated)
      this.notifySessionChanged(sessionId, 'message')
      return { messageId, translation }
    } finally {
      this.generations.release(requestId)
    }
  }
}

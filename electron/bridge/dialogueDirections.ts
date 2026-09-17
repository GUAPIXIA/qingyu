/**
 * 桥接端“下一步方向”生成（阶段 C）。
 *
 * 与渲染层 `src/store/dialogueDirectionRunner.ts` 共用 `shared/dialogueDirections`
 * 的提示词与校验，但走主进程 AI 服务（安卓端不持有 API Key）。
 * 触发点：桥接 AI 回复落盘后（若会话开启方向），以及安卓端主动“换一批”。
 */
import { nanoid } from 'nanoid'
import { getAdapter, chatWithRetry } from '../services/ai'
import { chatData } from '../ipc/chat'
import { findSessionById } from './sessionsIndex'
import { stripThought } from '../../shared/chat-core/messagePostProcess'
import { resolveNarrativeMode } from '../../shared/narrativeMode'
import { resolveDialogueDirectionsEnabled } from '../../shared/dialogueDirections'
import { BACKGROUND_GENERATION_PROFILES } from '../../shared/backgroundGeneration'
import { enabledProfileOverride } from '../../shared/modelOutputProfile'
import { resolveGenerationTaskBudget } from '../../shared/generationTaskBudget'
import {
  DIALOGUE_DIRECTION_TEMPERATURE,
  buildDialogueDirectionSystemPrompt,
  buildDialogueDirectionUserPrompt,
  parseDialogueDirections,
} from '../../shared/dialogueDirections'
import type { ChatParams, DialogueDirection, Message } from '../../shared/types'
import { createLogger } from '../services/logger'

const log = createLogger('bridge-directions')

/** 最近对话条数（方案 §4.1）。 */
const RECENT_LIMIT = 6

/** 生成方向所需的连接参数（由调用方解析 settings 注入，避免本模块依赖凭据存储）。 */
export interface DirectionProfile {
  provider: ChatParams['provider']
  apiKey: string
  baseUrl: string
  model: string
  capabilityOverride?: { enabled: boolean; contextLimit?: number; outputLimit?: number }
}

/**
 * 为指定 AI 消息生成方向并落盘。
 * @returns 生成成功返回方向数组；失败、未开启或消息无效返回空数组（静默降级）。
 */
export async function generateBridgeDirections(opts: {
  sessionId: string
  messageId: string
  characterName: string
  userName: string
  profile: DirectionProfile
}): Promise<DialogueDirection[]> {
  const { sessionId, messageId, characterName, userName, profile } = opts
  try {
    const session = await findSessionById(sessionId)
    if (!session) return []
    if (!resolveDialogueDirectionsEnabled(session)) return []

    const messages = chatData.readMessages(session.characterId, sessionId)
    const index = messages.findIndex((message) => message.id === messageId)
    if (index < 0) return []
    const target = messages[index]
    if (target.role !== 'assistant' || !(target.content || '').trim()) return []

    const charName = characterName || '角色'
    const input = {
      userName,
      charName,
      characterDescription: '',
      narrativeMode: resolveNarrativeMode(target.narrativeMode, session.narrativeMode),
      recentMessages: messages
        .slice(Math.max(0, index - RECENT_LIMIT), index)
        .filter((message) => !!stripThought(message.content || '').trim())
        .map((message) => ({
          speaker: message.role === 'user' ? userName : charName,
          content: stripThought(message.content || '').slice(0, 400),
        })),
      latestReply: stripThought(target.content || ''),
      worldState: session.memoryCurrentState,
    }

    const systemPrompt = buildDialogueDirectionSystemPrompt(input)
    const userPrompt = buildDialogueDirectionUserPrompt(input)
    const call = async (messagesForCall: ChatParams['messages']): Promise<DialogueDirection[]> => {
      const params = buildDirectionParams(profile, messagesForCall)
      const completion = await chatWithRetry(getAdapter(params.provider), params, () => {}, new AbortController().signal, 0)
      return parseDialogueDirections(stripThought(completion.text))
    }

    let directions = await call([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ])
    if (directions.length === 0) {
      // 结构非法：重试一次，第二次仍失败放弃
      directions = await call([
        {
          role: 'system',
          content: `${systemPrompt}\n\n上一次输出结构不合法。不要分析或解释，只返回一组 <directions>...</directions> 包裹的合法 JSON 数组。`,
        },
        { role: 'user', content: userPrompt },
      ])
    }
    if (directions.length === 0) return []

    // 正文可能在这期间被重生成/Swipe 替换：重新读取确认后再落盘
    const fresh = chatData.readMessages(session.characterId, sessionId).find((m) => m.id === messageId)
    if (!fresh || !(fresh.content || '').trim() || fresh.content !== target.content) return []

    const updated: Message = {
      ...fresh,
      dialogueDirections: directions,
      dialogueDirectionsGeneratedAt: Date.now(),
    }
    chatData.saveMessage(session.characterId, updated)
    return directions
  } catch (error) {
    log.warn('方向生成失败', { error: (error as Error).message })
    return []
  }
}

function buildDirectionParams(
  profile: DirectionProfile,
  messages: ChatParams['messages'],
): ChatParams {
  // W5（主计划 §7.7）：与 PC 同口径——后台 direction 档案 + 统一预算 + off 门控，
  // 不再直连 1536（该入口此前与 PC 存在已知漂移，方案 §2.2）。
  const budget = resolveGenerationTaskBudget({
    task: 'direction',
    model: profile.model,
    expectedBodyChars: BACKGROUND_GENERATION_PROFILES.direction.expectedBodyChars,
    profileOverride: enabledProfileOverride(profile.capabilityOverride),
  })
  return {
    requestId: `directions-${Date.now()}-${nanoid(4)}`,
    messages,
    provider: profile.provider,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.model,
    temperature: DIALOGUE_DIRECTION_TEMPERATURE,
    topP: 0.9,
    maxTokens: budget.requestMaxTokens,
    frequencyPenalty: 0,
    presencePenalty: 0,
    stream: false,
    reasoningGate: budget.reasoningGate,
    // 阶段7（§7.3）：独立 taskType，与渲染层方向请求同口径
    observability: { source: 'aux', taskType: 'direction' },
  }
}

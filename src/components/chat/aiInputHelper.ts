import type { ChatParams, ProviderType, Preset, Character, Message } from '../../../shared/types'
import { stripThought } from '../../utils/messagePostProcess'

/**
 * ChatInput 的 AI 辅助逻辑（续写 / 润色）抽取模块。
 * 从 useChatInputState.ts 拆出，保持纯逻辑、可独立测试：
 * - ensureUserPerspective：剥离 AI 以角色视角回复的部分
 * - buildContinueContext：构造续写的上下文消息
 * - callAiHelper：发起一次 AI 辅助请求（依赖注入，无 React 状态）
 */

/** 转义正则特殊字符（构造角色名/用户名匹配时使用） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 后处理：确保输出是用户视角，剥离角色视角内容。
 * 若 AI 以角色名开头回复（含冒号），则提取用户发言部分；找不到用户部分则返回空串。
 */
export function ensureUserPerspective(raw: string, userName: string, charName: string): string {
  let output = raw.trim()
  const charPrefix = new RegExp(`^\\*?${escapeRegExp(charName)}\\s*[:：]\\s*`, 'i')
  if (charPrefix.test(output)) {
    const userLine = new RegExp(`(?:^|\\n)\\*?${escapeRegExp(userName)}\\s*[:：]\\s*(.*)`, 'i')
    const match = output.match(userLine)
    if (match) {
      output = match[1].trim()
    } else {
      return ''
    }
  }
  return output
}

/** 构造续写的 systemPrompt（用户视角续写助手） */
export function buildContinueSystemPrompt(userName: string, charName: string, hasInput: boolean): string {
  if (hasInput) {
    return `你是一个角色扮演对话的用户视角续写助手。你的任务是以【用户 ${userName}】的身份和口吻，续写用户未完成的消息。\n\n严格要求：\n- 只输出 ${userName} 的话语，绝对不要输出 ${charName} 的话语\n- 不要以 ${charName} 的身份说话或行动\n- 不要包含角色名前缀，直接输出对话内容\n- 保持用户一贯的语气和风格`
  }
  return `你是一个角色扮演对话的用户视角续写助手。你的任务是以【用户 ${userName}】的身份和口吻，生成一条合适的用户回复。\n\n严格要求：\n- 只输出 ${userName} 的话语，绝对不要输出 ${charName} 的话语\n- 不要以 ${charName} 的身份说话或行动\n- 不要包含角色名前缀，直接输出对话内容\n- 保持用户一贯的语气和风格`
}

/** 构造续写的上下文消息（system + 最近消息 + 续写指令） */
export function buildContinueContext(opts: {
  character: Character
  userName: string
  charName: string
  recentMessages: Message[]
  originalInput: string
  hasInput: boolean
}): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const { character, userName, charName, recentMessages, originalInput, hasInput } = opts
  const systemPrompt = buildContinueSystemPrompt(userName, charName, hasInput)
  const contextMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: `${systemPrompt}\n\n当前角色：${charName}\n角色设定：${character.description || '无'}\n场景：${character.scenario || '无'}` },
  ]
  for (const msg of recentMessages) {
    contextMessages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
    })
  }
  contextMessages.push({
    role: 'user',
    content: hasInput
      ? `请以 ${userName} 的身份续写以下未完成的消息（直接接在后面的部分）：\n${originalInput}`
      : `请以 ${userName} 的身份根据上下文生成一条回复`,
  })
  return contextMessages
}

/** callAiHelper 的依赖（由 hook 侧注入，模块内不接触 React 状态） */
export interface AiHelperCallOptions {
  systemPrompt: string
  userContent: string
  temperature?: number
  maxTokens?: number
  onChunk?: (delta: string, full: string) => void
  profile: { provider: ProviderType; apiKey: string; baseUrl: string }
  activeModel: string
  preset: Preset | null
  /** 活跃请求 ID 集合（用于组件卸载时统一取消） */
  activeRequestIds: Set<string>
}

/**
 * 发起一次 AI 辅助请求（非流式），返回 AI 生成的完整文本。
 * 注册 chunk/done/error 监听，完成后自清理。
 */
export function callAiHelper(opts: AiHelperCallOptions): Promise<string> {
  const { systemPrompt, userContent, temperature, maxTokens, onChunk, profile, activeModel, preset, activeRequestIds } = opts
  let result = ''
  const requestId = `ai-helper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  activeRequestIds.add(requestId)

  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      activeRequestIds.delete(requestId)
      unbindChunk(); unbindDone(); unbindError()
    }
    const cleanResult = () => stripThought(result)
    const unbindChunk = window.api.ai.onChunk((data) => {
      if (data.requestId !== requestId) return
      result += data.text
      onChunk?.(data.text, cleanResult())
    })
    const unbindDone = window.api.ai.onDone((doneId) => {
      if (doneId !== requestId) return
      cleanup()
      resolve(cleanResult())
    })
    const unbindError = window.api.ai.onError((data) => {
      if (data.requestId !== requestId) return
      cleanup()
      reject(new Error(data.error))
    })

    const params: ChatParams = {
      requestId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: activeModel,
      temperature: temperature ?? preset?.temperature ?? 0.5,
      topP: preset?.topP ?? 0.9,
      maxTokens: maxTokens ?? 800,
      frequencyPenalty: preset?.frequencyPenalty ?? 0,
      presencePenalty: preset?.presencePenalty ?? 0,
      stream: false,
    }

    window.api.ai.chat(params).catch((err) => {
      cleanup()
      reject(err)
    })
  })
}

/**
 * Prompt 格式转换器
 *
 * 不同 AI 提供商的消息格式要求不同：
 * - OpenAI: 标准 ChatML 格式 (system/user/assistant)
 * - Claude: system 单独处理，消息必须 user/assistant 交替
 * - Gemini: 类似 OpenAI，但有一些差异
 *
 * 参考 SillyTavern 的 prompt-converters.js 实现
 */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  [key: string]: any
}

interface PromptNames {
  charName: string
  userName: string
}

/**
 * OpenAI 格式（默认）
 * 直接使用原始消息格式，无需转换
 */
export function convertToOpenAI(messages: ChatMessage[]): ChatMessage[] {
  return messages
}

/**
 * Claude 格式转换
 *
 * Claude 的要求：
 * 1. system 消息必须放在最前面，且只能有一条
 * 2. 消息必须 user/assistant 交替出现
 * 3. 不能有连续的 user 或 assistant 消息
 * 4. 最后一条应该是 user 消息（或者使用 assistant prefill）
 *
 * @param messages 原始消息数组
 * @param names 角色名信息
 * @returns 转换后的消息数组
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function convertToClaude(messages: ChatMessage[], _names: PromptNames): ChatMessage[] {
  if (!messages || messages.length === 0) return []

  const result: ChatMessage[] = []
  let systemContent = ''

  // 第一步：收集所有 system 消息并合并
  for (const msg of messages) {
    if (msg.role === 'system') {
      if (systemContent) {
        systemContent += '\n\n'
      }
      systemContent += msg.content
    }
  }

  // 添加合并后的 system 消息
  if (systemContent) {
    result.push({ role: 'system', content: systemContent })
  }

  // 第二步：处理非 system 消息，确保交替
  let lastRole: string | null = null

  for (const msg of messages) {
    if (msg.role === 'system') continue

    if (msg.role === lastRole) {
      // 连续相同角色，合并到上一条
      const lastMsg = result[result.length - 1]
      if (lastMsg) {
        lastMsg.content += '\n\n' + msg.content
      }
    } else {
      // 不同角色，直接添加
      result.push({ ...msg })
      lastRole = msg.role
    }
  }

  // 第三步：确保最后一条是 user 消息（Claude 要求）
  if (result.length > 0 && result[result.length - 1].role === 'assistant') {
    // 如果最后是 assistant，添加一个空的 user 消息
    result.push({ role: 'user', content: '[Continue]' })
  }

  return result
}

/**
 * Gemini 格式转换
 *
 * Gemini 的要求：
 * 1. 支持 system 消息（作为 system_instruction）
 * 2. 消息格式类似 OpenAI
 * 3. 不支持连续的相同角色消息
 *
 * @param messages 原始消息数组
 * @returns 转换后的消息数组
 */
export function convertToGemini(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return []

  const result: ChatMessage[] = []
  let lastRole: string | null = null

  for (const msg of messages) {
    if (msg.role === lastRole) {
      // 连续相同角色，合并
      const lastMsg = result[result.length - 1]
      if (lastMsg) {
        lastMsg.content += '\n\n' + msg.content
      }
    } else {
      result.push({ ...msg })
      lastRole = msg.role
    }
  }

  return result
}

/**
 * 根据提供商选择合适的格式转换器
 *
 * @param provider 提供商类型
 * @param messages 原始消息数组
 * @param names 角色名信息
 * @returns 转换后的消息数组
 */
export function convertMessages(
  provider: string,
  messages: ChatMessage[],
  names: PromptNames = { charName: '', userName: '' }
): ChatMessage[] {
  const lowerProvider = provider.toLowerCase()

  if (lowerProvider.includes('claude')) {
    return convertToClaude(messages, names)
  }

  if (lowerProvider.includes('gemini')) {
    return convertToGemini(messages)
  }

  // 默认使用 OpenAI 格式
  return convertToOpenAI(messages)
}

/**
 * 添加 Assistant Prefix（续写模式）
 *
 * 在消息末尾添加空的 assistant 消息，引导模型继续生成
 *
 * @param messages 消息数组
 * @param prefix 可选的前缀文本
 * @returns 添加 prefix 后的消息数组
 */
export function addAssistantPrefix(
  messages: ChatMessage[],
  prefix?: string
): ChatMessage[] {
  if (!messages || messages.length === 0) return messages

  // 检查最后一条是否已经是 assistant
  const lastMsg = messages[messages.length - 1]
  if (lastMsg.role === 'assistant') {
    // 已经是 assistant，不需要添加
    return messages
  }

  // 添加空的 assistant 消息
  return [
    ...messages,
    { role: 'assistant', content: prefix || '' }
  ]
}

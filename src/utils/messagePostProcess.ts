/**
 * 消息后处理工具
 *
 * 解决连续相同角色消息导致的 API 格式错误问题。
 * 例如：[user: "你好"], [user: "我是小明"] → [user: "你好\n\n我是小明"]
 */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  [key: string]: any
}

/**
 * 合并连续相同角色的消息
 *
 * SillyTavern 的 MERGE 模式实现：
 * - 连续的 system 消息合并为一条
 * - 连续的 user 消息合并为一条
 * - 连续的 assistant 消息合并为一条
 * - system 消息穿插在 user/assistant 之间时，合并到前一条消息
 *
 * @param messages 原始消息数组
 * @returns 合并后的消息数组
 */
export function mergeConsecutiveMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return []

  const merged: ChatMessage[] = []

  for (const msg of messages) {
    const lastMsg = merged[merged.length - 1]

    if (!lastMsg) {
      // 第一条消息直接加入
      merged.push({ ...msg })
      continue
    }

    // 如果角色相同，合并内容
    if (lastMsg.role === msg.role) {
      lastMsg.content = `${lastMsg.content}\n\n${msg.content}`
    }
    // 如果当前是 system 且上一条是 user/assistant，合并到上一条
    // （system 穿插在对话中时，追加到前一条消息）
    else if (msg.role === 'system' && (lastMsg.role === 'user' || lastMsg.role === 'assistant')) {
      lastMsg.content = `${lastMsg.content}\n\n${msg.content}`
    }
    // 其他情况，直接加入
    else {
      merged.push({ ...msg })
    }
  }

  return merged
}

/**
 * 严格模式：保持角色交替
 *
 * SillyTavern 的 STRICT 模式实现：
 * - 强制 user/assistant 交替出现
 * - 连续相同角色消息合并
 * - system 消息使用占位符替换
 *
 * @param messages 原始消息数组
 * @param placeholder system 消息的占位符文本
 * @returns 处理后的消息数组
 */
export function strictAlternatingMessages(
  messages: ChatMessage[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _placeholder = '[System message]'
): ChatMessage[] {
  if (!messages || messages.length === 0) return []

  // 第一步：合并连续相同角色
  const result = mergeConsecutiveMessages(messages)

  // 第二步：确保 user/assistant 交替
  const final: ChatMessage[] = []

  for (const msg of result) {
    if (msg.role === 'system') {
      // system 消息保持原样
      final.push({ ...msg })
      continue
    }

    const lastMsg = final[final.length - 1]

    if (!lastMsg || lastMsg.role === msg.role) {
      // 角色相同，合并
      final.push({ ...msg })
    } else if (lastMsg.role === 'system') {
      // 上一条是 system，当前是 user/assistant，直接加入
      final.push({ ...msg })
    } else {
      // 正常交替，直接加入
      final.push({ ...msg })
    }
  }

  return final
}

/**
 * Semi 模式：允许连续 system，但 user/assistant 必须交替
 *
 * @param messages 原始消息数组
 * @returns 处理后的消息数组
 */
export function semiStrictMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return []

  const result: ChatMessage[] = []

  for (const msg of messages) {
    const lastMsg = result[result.length - 1]

    if (!lastMsg) {
      result.push({ ...msg })
      continue
    }

    // system 消息可以连续
    if (msg.role === 'system' && lastMsg.role === 'system') {
      lastMsg.content = `${lastMsg.content}\n\n${msg.content}`
    }
    // user/assistant 相同角色合并
    else if (msg.role === lastMsg.role && msg.role !== 'system') {
      lastMsg.content = `${lastMsg.content}\n\n${msg.content}`
    }
    // 其他情况直接加入
    else {
      result.push({ ...msg })
    }
  }

  return result
}

/**
 * 思考标签（<thought> / <thinking>）处理工具
 *
 * 部分 AI 模型（如 DeepSeek）使用 <thinking> 而非 <thought>，
 * 以下函数统一归一化并提取/剥离思考内容。
 */

/** 将 <thinking> 标签归一化为 <thought> */
export function normalizeThoughtTags(text: string): string {
  if (!text) return text
  return text
    .replace(/<thinking([\s>])/gi, '<thought$1')
    .replace(/<\/thinking>/gi, '</thought>')
}

/**
 * 提取所有 <thought> 块内容
 * @returns thought: 拼接的思考内容（无则为 null）; content: 剥离 thought 后的正文（为空时回退到思考内容）; isFallback: 是否触发了回退
 */
export function extractThought(text: string): { thought: string | null; content: string; isFallback: boolean } {
  if (!text) return { thought: null, content: '', isFallback: false }
  const normalized = normalizeThoughtTags(text)
  const thoughtRegex = /<thought>([\s\S]*?)<\/thought>/gi
  const thoughts: string[] = []
  let m: RegExpExecArray | null
  while ((m = thoughtRegex.exec(normalized)) !== null) {
    thoughts.push(m[1].trim())
  }
  const stripped = normalized.replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
  const thought = thoughts.length > 0 ? thoughts.join('\n\n') : null
  // 剥离后为空则回退到思考内容，避免显示"空消息"
  const isFallback = !stripped && !!thought
  const content = stripped || (thought ?? '')
  return { thought, content, isFallback }
}

/** 剥离 <thought> 块，返回剩余正文（不做空回退） */
export function stripThought(text: string): string {
  if (!text) return text
  return normalizeThoughtTags(text).replace(/<thought>[\s\S]*?<\/thought>/gi, '').trim()
}

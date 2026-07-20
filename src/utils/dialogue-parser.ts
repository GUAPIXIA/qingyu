/**
 * 对话片段解析器
 * 将角色对话消息拆分为：引用对话、动作描述、旁白叙述 三类片段
 */

export interface DialogueSegment {
  /** 片段类型 */
  type: 'dialogue' | 'action' | 'plain'
  /** 说话人名称（如有，如 Flora: "..."） */
  speaker?: string
  /** 片段文本内容 */
  content: string
}

/**
 * 解析消息文本，按格式拆分为结构化片段
 *
 * 识别规则：
 * - `*...*`          → action（动作/场景描述）
 * - `Speaker: "..."`  → dialogue（有说话人的对话）
 * - `"..."`           → dialogue（无明确说话人的对话）
 * - 其余文本           → plain（旁白/叙述）
 */
export function parseDialogue(text: string): DialogueSegment[] {
  if (!text) return []

  const segments: DialogueSegment[] = []

  // 正则：匹配 *动作* 或 "对话" 或两者组合 Name: "对话"
  // 顺序很重要：先匹配 Name: "..." 再匹配单纯的 "..."
  const pattern = /(\*[^*]+\*)|([A-Za-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+:\s*"[^"]*")|("[^"]*")/g

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    // 匹配之前的纯文本
    if (match.index > lastIndex) {
      const plainText = text.slice(lastIndex, match.index).trim()
      if (plainText) {
        segments.push({ type: 'plain', content: plainText })
      }
    }

    const fullMatch = match[0]

    if (match[1]) {
      // *动作描述*
      const inner = fullMatch.slice(1, -1).trim()
      segments.push({ type: 'action', content: inner })
    } else if (match[2]) {
      // Speaker: "对话"
      const colonIdx = fullMatch.indexOf(':')
      const speaker = fullMatch.slice(0, colonIdx).trim()
      const inner = fullMatch.slice(colonIdx + 1).trim().replace(/^"|"$/g, '')
      segments.push({ type: 'dialogue', speaker, content: inner })
    } else if (match[3]) {
      // "对话"
      const inner = fullMatch.slice(1, -1).trim()
      segments.push({ type: 'dialogue', content: inner })
    }

    lastIndex = match.index + fullMatch.length
  }

  // 末尾剩余纯文本
  if (lastIndex < text.length) {
    const remainingText = text.slice(lastIndex).trim()
    if (remainingText) {
      segments.push({ type: 'plain', content: remainingText })
    }
  }

  return segments
}

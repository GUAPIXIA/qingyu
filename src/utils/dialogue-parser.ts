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

/** 占位符标记（使用不可见字符，避免与正文冲突） */
const PH_MARKER = '\x00PH\x00'

/**
 * 解析消息文本，按格式拆分为结构化片段
 *
 * 识别规则：
 * - `*...*`          -> action（动作/场景描述）
 * - `Speaker: "..."`  -> dialogue（有说话人的对话）
 * - `"..."`           -> dialogue（无明确说话人的对话）
 * - 其余文本           -> plain（旁白/叙述）
 *
 * 注意：HTML 标签和 markdown 图片/链接会被保护，不参与正则匹配，
 * 避免其中的引号（如 src="url"）和 * 字符被误识别。
 */
export function parseDialogue(text: string): DialogueSegment[] {
  if (!text) return []

  // 预处理：用占位符保护 HTML 标签和 markdown 图片/链接
  // 避免 HTML 属性值中的引号被 "[^"]*" 误匹配为对话
  // 避免 URL 中的 * 被 \*[^*]+\* 误匹配为动作描写
  const placeholders: string[] = []
  const protect = (m: string): string => {
    placeholders.push(m)
    return `${PH_MARKER}${placeholders.length - 1}${PH_MARKER}`
  }

  const protectedText = text
    .replace(/<\/?[a-zA-Z][^>]*\/?>/g, protect)   // HTML 标签 <...>
    .replace(/!\[[^\]]*\]\([^)]*\)/g, protect)     // markdown 图片 ![alt](url)
    .replace(/\[[^\]]*\]\([^)]*\)/g, protect)      // markdown 链接 [text](url)
    .replace(/`[^`]+`/g, protect)                   // 行内代码 `code`

  /** 将占位符还原为原始内容 */
  const restore = (s: string): string =>
    s.replace(new RegExp(`${PH_MARKER}(\\d+)${PH_MARKER}`, 'g'), (_, i) => placeholders[Number(i)])

  const segments: DialogueSegment[] = []

  // 正则：匹配 *动作* 或 "对话" 或两者组合 Name: "对话"
  // 顺序很重要：先匹配 Name: "..." 再匹配单纯的 "..."
  const pattern = /(\*[^*]+\*)|([A-Za-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+:\s*"[^"]*")|("[^"]*")/g

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(protectedText)) !== null) {
    // 匹配之前的纯文本
    if (match.index > lastIndex) {
      const plainText = protectedText.slice(lastIndex, match.index).trim()
      if (plainText) {
        segments.push({ type: 'plain', content: restore(plainText) })
      }
    }

    const fullMatch = match[0]

    if (match[1]) {
      // *动作描述*
      const inner = fullMatch.slice(1, -1).trim()
      segments.push({ type: 'action', content: restore(inner) })
    } else if (match[2]) {
      // Speaker: "对话"
      const colonIdx = fullMatch.indexOf(':')
      const speaker = fullMatch.slice(0, colonIdx).trim()
      const inner = fullMatch.slice(colonIdx + 1).trim().replace(/^"|"$/g, '')
      segments.push({ type: 'dialogue', speaker: restore(speaker), content: restore(inner) })
    } else if (match[3]) {
      // "对话"
      const inner = fullMatch.slice(1, -1).trim()
      segments.push({ type: 'dialogue', content: restore(inner) })
    }

    lastIndex = match.index + fullMatch.length
  }

  // 末尾剩余纯文本
  if (lastIndex < protectedText.length) {
    const remainingText = protectedText.slice(lastIndex).trim()
    if (remainingText) {
      segments.push({ type: 'plain', content: restore(remainingText) })
    }
  }

  return segments
}

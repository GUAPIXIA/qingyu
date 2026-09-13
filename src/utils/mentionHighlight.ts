/**
 * @提及高亮纯文本分段（S7）。
 *
 * 与 Markdown 无关：Markdown 渲染（remarkMentionHighlight 的 AST 层插件）与
 * 语义块渲染（GroupChatMessage 的 blocks 路径）共用同一识别结果，
 * 避免两条渲染路径的提及规则漂移，也不需要为 blocks 路径恢复原始 HTML 注入。
 */

export interface MentionSegment {
  text: string
  /** 是否为 @角色名 片段 */
  mention: boolean
}

/** 转义正则特殊字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把纯文本按 @角色名 切分为片段（无匹配时返回单一片段）。
 * 名称按长度降序参与匹配，避免「千夏」被更短的「夏」抢先匹配。
 */
export function splitMentionSegments(text: string, names: string[]): MentionSegment[] {
  if (!text) return []
  const unique = [...new Set(names.filter((name): name is string => !!name && !!name.trim()))]
    .sort((a, b) => b.length - a.length)
  if (unique.length === 0) return [{ text, mention: false }]

  const pattern = new RegExp(`@(${unique.map(escapeRegExp).join('|')})`, 'g')
  const segments: MentionSegment[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) segments.push({ text: text.slice(last, index), mention: false })
    segments.push({ text: match[0], mention: true })
    last = index + match[0].length
  }
  if (segments.length === 0) return [{ text, mention: false }]
  if (last < text.length) segments.push({ text: text.slice(last), mention: false })
  return segments
}

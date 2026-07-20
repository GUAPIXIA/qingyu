/**
 * 斜杠命令解析器
 */

export interface ParsedCommand {
  /** 命令名（已小写化） */
  name: string
  /** 参数列表 */
  args: string[]
  /** 原始输入 */
  raw: string
}

/**
 * 解析输入为命令
 * 支持引号包裹的参数（"xxx yyy" 或 'xxx yyy'）
 * @returns ParsedCommand 或 null（非命令）
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  // 移除开头的 /
  const rest = trimmed.slice(1)
  // 按空白分割，但保留引号内的内容
  const tokens = rest.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  if (tokens.length === 0) return null
  const name = tokens[0].toLowerCase()
  const args = tokens.slice(1).map(t => t.replace(/^["']|["']$/g, ''))
  return { name, args, raw: trimmed }
}

/**
 * 检测当前光标位置是否在命令补全上下文中
 * @returns -1 不是命令; 0 命令名补全; 1+ 第 N 个参数补全
 */
export function getCompletionContext(text: string, cursorPos: number): number {
  if (!text.startsWith('/')) return -1
  const beforeCursor = text.slice(0, cursorPos)
  // 没有空格：命令名补全
  if (!beforeCursor.includes(' ')) return 0
  // 计算空格数（粗略）
  const parts = beforeCursor.split(/\s+/)
  return parts.length - 1
}

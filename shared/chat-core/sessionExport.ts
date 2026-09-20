/**
 * 阶段 4 S4-04：会话导出（Markdown / JSON）——**跨端共享的纯逻辑**。
 *
 * 为什么从 IPC handler 里抽出来：同一段对话在 PC 与 Android 上导出必须得到
 * **同一个文件**，否则「导出」在两端就是两个功能。抽到 shared 后，
 * fixture 的 oracle 就是真正被生产代码调用的这份实现，而不是测试里重抄一遍。
 *
 * 时间格式刻意作为**注入项**：`toLocaleString('zh-CN')` 的产物依赖运行时 ICU 数据，
 * 两端未必逐字节相同；把「结构」与「时间渲染」分开后，
 * 结构由 fixture 锁定，时间格式由各端自行保证并在各自测试中断言。
 */

export interface ExportMessage {
  role: string
  content: string
  timestamp: number
  images?: string[] | null
}

export interface ExportOptions {
  /** 时间渲染；缺省用 zh-CN 本地化字符串（与既有 PC 行为一致）。 */
  formatTime?: (timestamp: number) => string
}

const DEFAULT_FORMAT_TIME = (timestamp: number): string => new Date(timestamp).toLocaleString('zh-CN')

/**
 * 导出 Markdown 时转义消息内容中的特殊字符（R5/N15 修复）
 * 防止内容中的 # 标题 / *斜体* / `代码` / ![图片] 等破坏导出格式
 */
export function escapeMarkdownContent(s: string): string {
  return s
    .replace(/([\\`*_[\]{}#])/g, '\\$1')
    // 图片语法前导：第一步已将 [ 转义为 \[，此处把 !\[ 整体转义为 \!\[（防 ![ 图片注入）
    .replace(/!\\\[/g, '\\!\\[')
}

/** 角色标签（导出用）。 */
export function exportRoleLabel(role: string): string {
  if (role === 'user') return '🧑 用户'
  if (role === 'assistant') return '🎭 AI'
  return '系统'
}

/**
 * 会话 → Markdown。
 * 结构：`# 对话记录` + 每条消息的 `### 标签 · 时间` + 图片 + 转义正文 + 分隔线。
 */
export function exportSessionMarkdown(
  messages: readonly ExportMessage[],
  options: ExportOptions = {},
): string {
  const formatTime = options.formatTime ?? DEFAULT_FORMAT_TIME
  let md = `# 对话记录\n\n`
  for (const msg of messages) {
    const role = exportRoleLabel(msg.role)
    const time = formatTime(msg.timestamp)
    md += `### ${role} · ${time}\n\n`
    // 插入图片（base64 data URI，不转义以保留图片语法）
    if (msg.images && msg.images.length > 0) {
      for (const img of msg.images) {
        md += `![图片](${img})\n\n`
      }
    }
    md += `${escapeMarkdownContent(msg.content)}\n\n---\n\n`
  }
  return md
}

/**
 * 导出的 JSON 字段与**固定键序**。
 *
 * 为什么必须规范化而不是直接 `JSON.stringify(messages)`：PC 与 Android 的存储 schema 不同
 * （Android 没有 swipes/usage/translation 等列），直接序列化必然产生不同文件；
 * 而键序又会随存储实现漂移。导出是**可携带的对话记录**（人可读、可再导入），
 * 不是备份——完整备份走阶段 5 的 Backup V3 通道。
 *
 * `images` 仅在非空时输出；`id` 仅在存在时输出。
 */
const EXPORT_KEY_ORDER = ['id', 'role', 'content', 'images', 'timestamp'] as const

/** 把一条消息投影为导出的规范形状（键序固定，缺失的可选字段不输出）。 */
export function projectExportMessage(
  message: Record<string, unknown>,
  formatTime?: (timestamp: number) => string,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {}
  for (const key of EXPORT_KEY_ORDER) {
    if (key === 'images') {
      const images = message.images
      if (Array.isArray(images) && images.length > 0) projected.images = images
      continue
    }
    if (key === 'id') {
      const id = message.id
      if (typeof id === 'string' && id) projected.id = id
      continue
    }
    if (key === 'timestamp') {
      const timestamp = typeof message.timestamp === 'number' ? message.timestamp : 0
      projected.timestamp = formatTime ? formatTime(timestamp) : timestamp
      continue
    }
    const value = message[key]
    if (value !== undefined) projected[key] = value
  }
  return projected
}

/** 会话 → JSON：规范投影后的消息数组，2 空格缩进。 */
export function exportSessionJson(
  messages: readonly Record<string, unknown>[],
  options: ExportOptions = {},
): string {
  return JSON.stringify(messages.map((message) => projectExportMessage(message, options.formatTime)), null, 2)
}

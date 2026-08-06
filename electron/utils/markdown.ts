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

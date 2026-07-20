/** 简易 Token 估算（中文约 1.5 字/token，英文约 4 字符/token） */
export function estimateTokens(text: string): number {
  if (!text) return 0
  // 统计中文字符
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length
  // 非中文字符
  const otherChars = text.length - chineseChars
  return Math.ceil(chineseChars * 1.5 + otherChars / 4)
}

/** 格式化 Token 数 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}K`
  return `${Math.round(tokens / 1000)}K`
}

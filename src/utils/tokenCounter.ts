/**
 * Token 计数工具
 * 
 * - `estimateTokens`: 同步启发式估算，用于 UI 即时反馈
 * - `countTokensAccurate`: 异步精确计数（IPC → 主进程 tokenizer）
 * 
 * 安装 tiktoken 后自动切换到精确计数。
 */

/** 同步启发式估算（含按模型族的系数优化） */
export function estimateTokens(text: string, model?: string): number {
  if (!text) return 0
  const lower = model?.toLowerCase() || ''
  const chPerZhTok = lower.includes('claude') ? 0.85 : lower.includes('gemini') ? 0.9 : 0.9
  const chPerEnTok = lower.includes('claude') ? 3.6 : lower.includes('gemini') ? 3.3 : 3.4

  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) ?? []).length
  const punctuation = (text.match(/[，。！？；：""''（）【】《》、\s]/g) ?? []).length
  const englishLike = text.length - cjkChars - punctuation

  return Math.ceil(cjkChars * chPerZhTok + punctuation * 0.25 + englishLike / chPerEnTok)
}

/** 异步精确计数（走 IPC tokenizer，失败时降级到启发式） */
export async function countTokensAccurate(text: string, model: string): Promise<number> {
  try {
    if (window.api?.ai?.countTokens) {
      return await window.api.ai.countTokens(text, model)
    }
  } catch { /* IPC 失败降级 */ }
  return estimateTokens(text, model)
}

/** 格式化 Token 数 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}K`
  return `${Math.round(tokens / 1000)}K`
}

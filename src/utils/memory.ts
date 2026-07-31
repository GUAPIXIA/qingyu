/**
 * 长记忆结构化解析工具
 *
 * triggerMemorySummary 让模型输出结构化格式：
 *   【摘要】
 *   <摘要文本>
 *   【事实】
 *   1. 事实一
 *   2. 事实二
 * 本模块负责解析该输出，并做兜底（模型不按格式输出时）。
 */

export interface ParsedMemory {
  summary: string
  facts: string[]
}

/** 事实列表上限（防止无限累积） */
export const MAX_MEMORY_FACTS = 30

/**
 * 解析模型输出的结构化记忆文本。
 * - 剥离 <thought> 思考标签
 * - 【摘要】段落 → summary
 * - 【事实】段落按行解析为事实列表（自动去掉编号前缀）
 * - 兜底：未匹配到【摘要】时把全文作为摘要；未匹配到【事实】时事实为空
 */
export function parseMemoryResult(text: string): ParsedMemory {
  const cleaned = (text ?? '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim()
  if (!cleaned) return { summary: '', facts: [] }

  const summaryMatch = cleaned.match(/【摘要】([\s\S]*?)(?=【事实】|$)/)
  const factsMatch = cleaned.match(/【事实】([\s\S]*)$/)

  const summary = (summaryMatch?.[1] ?? '').trim()
  const facts = (factsMatch?.[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\s*(?:[-*]|\d{1,3}[.、．)）]|[一二三四五六七八九十]+[、.．])\s*/, '').trim())
    .filter((l) => l.length > 0)
    .slice(0, MAX_MEMORY_FACTS)

  return {
    // 兜底：没有【摘要】标记时使用全文（去掉【事实】部分）
    summary: summary || cleaned.replace(/【事实】[\s\S]*$/, '').trim(),
    facts,
  }
}

/**
 * 将事实列表格式化为注入文本。
 * 空列表返回空字符串。
 */
export function formatMemoryFacts(facts: string[] | undefined | null): string {
  if (!facts || facts.length === 0) return ''
  return facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
}

/**
 * 记忆注入预算裁剪：优先保留摘要（占预算 60%），事实按顺序填满剩余预算。
 * 摘要超限时按字符尾部截断，事实超限时整体丢弃（保持事实完整性）。
 */
export function fitMemoryBudget(
  summary: string,
  facts: string[] | undefined | null,
  budget: number,
  estimateTokens: (text: string, model?: string) => number,
  model?: string,
): { summary: string; facts: string[] } {
  const safeBudget = Math.max(50, Math.floor(budget))
  const summaryBudget = Math.max(30, Math.floor(safeBudget * 0.6))

  // 摘要：超过预算时从尾部截断（保持开头信息）
  let s = summary ?? ''
  while (s.length > 50 && estimateTokens(s, model) > summaryBudget) {
    s = s.slice(0, Math.max(50, s.length - 100))
  }

  // 事实：按顺序保留，直到填满剩余预算
  const list = facts ?? []
  let remaining = safeBudget - estimateTokens(s, model)
  const kept: string[] = []
  for (const f of list) {
    const t = estimateTokens(f, model) + 1 // +1 编号开销
    if (t > remaining) break
    kept.push(f)
    remaining -= t
  }
  return { summary: s, facts: kept }
}

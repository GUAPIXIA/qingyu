/** 长记忆单次摘要的新增对话输入预算。超长单条消息会作为唯一例外完整保留，避免游标跳过内容。 */
export const MEMORY_SUMMARY_INPUT_TOKEN_BUDGET = 6000
export const MEMORY_SUMMARY_MIN_INPUT_TOKEN_BUDGET = 128

/**
 * 为摘要请求计算真实可用输入预算：模型上下文减去系统提示、输出和安全余量，
 * 同时限制最大值，避免大上下文模型一次吞入过多历史。
 */
export function resolveMemorySummaryInputBudget(
  maxContext: number,
  systemPromptTokens: number,
  reservedOutputTokens: number,
): number {
  const context = Number.isFinite(maxContext) && maxContext > 0 ? Math.floor(maxContext) : 8192
  const prompt = Number.isFinite(systemPromptTokens) ? Math.max(0, Math.floor(systemPromptTokens)) : 0
  const output = Number.isFinite(reservedOutputTokens) ? Math.max(0, Math.floor(reservedOutputTokens)) : 0
  const safety = Math.max(128, Math.floor(context * 0.05))
  return Math.min(
    MEMORY_SUMMARY_INPUT_TOKEN_BUDGET,
    Math.max(MEMORY_SUMMARY_MIN_INPUT_TOKEN_BUDGET, context - prompt - output - safety),
  )
}

/** 单条消息超过模型可用窗口时保留首尾，并显式标记省略，避免请求永久失败。 */
export function fitOversizedMemoryMessage(
  text: string,
  tokenBudget: number,
  estimateTokens: (value: string) => number,
): string {
  if (estimateTokens(text) <= tokenBudget) return text
  const marker = '\n…【消息过长，中间内容已省略】…\n'
  let low = 0
  let high = text.length
  let best = marker
  while (low <= high) {
    const retained = Math.floor((low + high) / 2)
    const headLength = Math.ceil(retained * 0.6)
    const tailLength = retained - headLength
    const candidate = `${text.slice(0, headLength)}${marker}${tailLength > 0 ? text.slice(-tailLength) : ''}`
    if (estimateTokens(candidate) <= tokenBudget) {
      best = candidate
      low = retained + 1
    } else {
      high = retained - 1
    }
  }
  return best
}

/** 为保持语义连续性，携带的已总结消息数量。 */
export const MEMORY_SUMMARY_OVERLAP_COUNT = 2

export interface MemoryWindowMessage {
  id: string
}

export interface MemorySummaryWindowOptions {
  tokenBudget?: number
  overlapCount?: number
}

export interface MemorySummaryWindow<T> {
  /** 游标之后的全部未总结消息。 */
  pending: T[]
  /** 已总结、仅供语义衔接的最近消息。 */
  overlap: T[]
  /** 本次实际发送给摘要模型的新增消息，始终是 pending 的前缀。 */
  selected: T[]
  /** 本次可安全持久化的游标；只会推进到 selected 的末尾。 */
  processedThroughMessageId: string | null
}

/**
 * 按游标构建长记忆摘要窗口。
 *
 * 不按固定消息条数截断：新增消息从旧到新依次进入窗口，直到达到 Token 预算。
 * 为确保不会因一条超长消息而永久卡住，首条新增消息即使超过预算也会完整保留；
 * 此时只处理该消息，游标仅推进到它本身。
 */
export function buildMemorySummaryWindow<T extends MemoryWindowMessage>(
  messages: T[],
  cursorId: string | null | undefined,
  formatMessage: (message: T) => string,
  estimateTokens: (text: string) => number,
  options: MemorySummaryWindowOptions = {},
): MemorySummaryWindow<T> {
  const tokenBudget = Math.max(1, Math.floor(options.tokenBudget ?? MEMORY_SUMMARY_INPUT_TOKEN_BUDGET))
  const overlapCount = Math.max(0, Math.floor(options.overlapCount ?? MEMORY_SUMMARY_OVERLAP_COUNT))
  const cursorIndex = cursorId ? messages.findIndex((message) => message.id === cursorId) : -1
  const pending = cursorIndex >= 0 ? messages.slice(cursorIndex + 1) : messages.slice()
  const rawOverlap = cursorIndex >= 0
    ? messages.slice(Math.max(0, cursorIndex - overlapCount + 1), cursorIndex + 1)
    : []

  // 重叠上下文最多占 1/4 预算；过长的旧消息直接略过，避免它挤掉所有新增内容。
  const overlapBudget = Math.max(1, Math.floor(tokenBudget * 0.25))
  const overlap: T[] = []
  let overlapTokens = 0
  for (let index = rawOverlap.length - 1; index >= 0; index -= 1) {
    const message = rawOverlap[index]
    const tokens = Math.max(1, estimateTokens(formatMessage(message)))
    if (overlapTokens + tokens > overlapBudget) continue
    overlap.unshift(message)
    overlapTokens += tokens
  }

  const selected: T[] = []
  let usedTokens = overlapTokens
  for (const message of pending) {
    const tokens = Math.max(1, estimateTokens(formatMessage(message)))
    if (selected.length > 0 && usedTokens + tokens > tokenBudget) break
    selected.push(message)
    usedTokens += tokens
  }

  return {
    pending,
    overlap,
    selected,
    processedThroughMessageId: selected.at(-1)?.id ?? null,
  }
}

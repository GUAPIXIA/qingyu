/**
 * 上下文构建共享工具（单聊 / 群聊 buildContext 共用）
 *
 * - cropHistory:    按 token 预算从后往前裁剪历史消息，记录被裁剪范围（供上下文溢出压缩）
 * - applyDepthInserts: 按深度注入 at_depth 世界书 / 作者注释到历史消息段
 */

import { estimateTokens } from '../utils/tokenCounter'
import { IMAGE_TOKEN_ESTIMATE } from './chatConstants'

/** 参与裁剪的消息最小结构（content / images / timestamp） */
export interface CropableMessage {
  content: string
  images?: string[]
  timestamp: number
}

export interface CropResult<T> {
  /** 保留（预算内）的消息，按原顺序 */
  recent: T[]
  droppedStartTs: number
  droppedEndTs: number
  /** 被裁剪内容的估算 token 数 */
  droppedTokens: number
  /** 被裁剪的最后一个消息索引（0..i），无裁剪时为 -1 */
  droppedEndIndex: number
}

/**
 * 按 token 预算裁剪历史消息（从最新往最旧累计，超预算即裁剪更早的）。
 * usedTokens 为系统提示等已占用预算；返回保留部分与裁剪范围信息。
 */
export function cropHistory<T extends CropableMessage>(
  messages: T[],
  usedTokens: number,
  budgetBase: number,
  model: string,
): CropResult<T> {
  const recent: T[] = []
  let droppedStartTs = 0
  let droppedEndTs = 0
  let droppedTokens = 0
  let droppedEndIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const tokenCount = estimateTokens(msg.content || '', model)
      + (msg.images?.length ? msg.images.length * IMAGE_TOKEN_ESTIMATE : 0)
    if (usedTokens + tokenCount > budgetBase) {
      // 将被丢弃的早期消息（索引 0..i）
      const dropped = messages.slice(0, i + 1)
      droppedTokens = dropped.reduce((s, m) => s + estimateTokens(m.content || '', model), 0)
      droppedStartTs = dropped[0]?.timestamp ?? 0
      droppedEndTs = dropped[dropped.length - 1]?.timestamp ?? 0
      droppedEndIndex = i
      break
    }
    recent.unshift(msg)
    usedTokens += tokenCount
  }
  return { recent, droppedStartTs, droppedEndTs, droppedTokens, droppedEndIndex }
}

/** 可被深度注入的内容项 */
export interface DepthInsertItem {
  content: string
  depth: number
  order: number
}

/**
 * 按深度把内容（at_depth 世界书 + 作者注释 middle/bottom）注入历史消息段。
 * ST 语义：depth 0 = 对话末尾（最新消息之后），1 = 倒数第二条消息之后，n = 从末尾数 n 条之后。
 */
export function applyDepthInserts<T>(
  history: T[],
  inserts: DepthInsertItem[],
  newItem: (content: string) => T,
): T[] {
  if (inserts.length === 0) return history
  const result = [...history]
  const sorted = [...inserts].sort((a, b) => (a.depth - b.depth) || (a.order - b.order))
  const insertMap = new Map<number, string[]>()
  for (const item of sorted) {
    // P-8 修复（off-by-one）：depth 0 应插在最新消息之后（idx = length），
    // 此前 length-1-depth 把 depth 0 插在了最后一条消息之前，与 ST 语义/注释不符
    const idx = Math.max(0, Math.min(result.length, result.length - item.depth))
    if (!insertMap.has(idx)) insertMap.set(idx, [])
    insertMap.get(idx)!.push(item.content)
  }
  // 从后往前插入，避免 index 偏移
  const indices = [...insertMap.keys()].sort((a, b) => b - a)
  for (const idx of indices) {
    const contents = insertMap.get(idx)!
    result.splice(idx, 0, ...contents.map((c) => newItem(c)))
  }
  return result
}

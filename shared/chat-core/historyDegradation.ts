/**
 * W9（主计划 §7.11 第 4–5 条）：历史分级降级与序列化后审计接线——纯函数，无 IO。
 *
 * 历史降级顺序（影子口径，不改 `cropHistory` 生产路径）：
 * 1. 保留预算内最近对话（既有 `cropHistory` 语义）；
 * 2. 被裁剪的旧历史若已有**覆盖该时间范围的压缩摘要**，先用摘要替代原文；
 * 3. 无摘要（或摘要未覆盖）才视为原文直接删除。
 *
 * 审计接线：把 `BuildResult.messages` 映射为无正文的 `SerializedInputView`（估算口径），
 * 再跑 `auditSerializedInput`；超限只报告一次重分配额度，不在这里裁剪（§5.6）。
 */

import type { ContextMessage } from './chatTypes'
import { auditSerializedInput, type SerializedInputAudit, type SerializedInputPart } from './inputAudit'
import { estimateTokens } from './tokenCounter'
import { cropHistory, type CropableMessage, type CropResult } from './contextShared'
import { IMAGE_TOKEN_ESTIMATE } from './chatConstants'

/** 历史降级策略（W9 影子；生产仍先 crop 再决定是否注入摘要） */
export type HistoryDegradationAction =
  | 'keep-raw'
  | 'replace-with-summary'
  | 'drop-raw'

export interface HistoryDegradationItem {
  /** 稳定 id（消息 id 或 `history:summary`）；不含正文 */
  id: string
  action: HistoryDegradationAction
  tokens: number
  /** 被裁剪范围是否被既有压缩摘要覆盖 */
  coveredBySummary: boolean
}

export interface HistoryDegradationPlan {
  mode: 'history-degradation'
  budgetTokens: number
  /** 既有实现：保留的最近消息数与 token（不含被丢弃正文） */
  existing: {
    keptCount: number
    keptTokens: number
    droppedCount: number
    droppedTokens: number
    summaryInjected: boolean
    summaryTokens: number
  }
  /**
   * 候选（W9 分级降级）：
   * - covered 的旧历史 → `replace-with-summary`（整段用摘要替代，不保留原文）；
   * - 未 covered 的旧历史 → `drop-raw`；
   * - 最近保留段 → `keep-raw`。
   */
  candidate: {
    keptRawCount: number
    keptRawTokens: number
    summaryReplacedCount: number
    summaryTokens: number
    droppedRawCount: number
    droppedRawTokens: number
    /** candidate 总占用（keptRaw + summary） */
    totalTokens: number
  }
  /** candidate.totalTokens − (existing.keptTokens + existing.summaryTokens) */
  deltaTokens: number
  items: HistoryDegradationItem[]
  degraded: boolean
}

interface HistoryDegradationInput {
  messages: readonly CropableMessage[]
  /** 历史裁剪前已占用的 token（system 等，与 cropHistory 入参同源） */
  usedTokens: number
  budgetTokens: number
  model?: string
  /** 既有压缩摘要正文（空 = 无） */
  compressedSummary?: string | null
  /** 既有压缩摘要覆盖的时间范围（与 session.compressedRange 同源） */
  compressedRange?: { startTs: number; endTs: number } | null
  /**
   * 既有 `cropHistory` 结果（可复用调用方已有计算，避免二次裁剪口径漂移）。
   * 缺省时按同参重算。
   */
  crop?: Pick<CropResult<CropableMessage>, 'recent' | 'droppedTokens' | 'droppedEndIndex' | 'droppedStartTs' | 'droppedEndTs'>
}

function degradedHistoryPlan(budgetTokens: number): HistoryDegradationPlan {
  return {
    mode: 'history-degradation',
    budgetTokens: Math.max(0, Math.floor(Number.isFinite(budgetTokens) ? budgetTokens : 0)),
    existing: {
      keptCount: 0,
      keptTokens: 0,
      droppedCount: 0,
      droppedTokens: 0,
      summaryInjected: false,
      summaryTokens: 0,
    },
    candidate: {
      keptRawCount: 0,
      keptRawTokens: 0,
      summaryReplacedCount: 0,
      summaryTokens: 0,
      droppedRawCount: 0,
      droppedRawTokens: 0,
      totalTokens: 0,
    },
    deltaTokens: 0,
    items: [],
    degraded: true,
  }
}

/**
 * 历史分级降级影子计划（纯函数）。
 * 不修改 messages；只产出"摘要替代 vs 原文删除"的可解释对照。
 */
export function planHistoryDegradation(input: HistoryDegradationInput): HistoryDegradationPlan {
  try {
    const model = input.model ?? ''
    const messages = Array.isArray(input.messages) ? input.messages : []
    const budgetTokens = Math.max(0, Math.floor(Number.isFinite(input.budgetTokens) ? input.budgetTokens : 0))
    const crop = input.crop ?? cropHistory(
      [...messages],
      Math.max(0, input.usedTokens),
      budgetTokens,
      model,
    )
    const recent = crop.recent ?? []
    const keptRawTokens = recent.reduce(
      (sum, msg) => sum + estimateTokens(msg.content || '', model)
        + (msg.images?.length ? (msg.images.length * IMAGE_TOKEN_ESTIMATE) : 0),
      0,
    )
    const droppedCount = Math.max(0, messages.length - recent.length)
    const droppedTokens = Math.max(0, crop.droppedTokens || 0)

    const summaryText = (input.compressedSummary ?? '').trim()
    const summaryTokens = summaryText ? estimateTokens(summaryText, model) : 0
    const range = input.compressedRange
    // 与 contextBuilder 相同的覆盖判定：被裁剪范围落在摘要覆盖区间内
    const covered = !!summaryText
      && droppedCount > 0
      && !!range
      && crop.droppedStartTs >= range.startTs
      && crop.droppedEndTs <= range.endTs

    const items: HistoryDegradationItem[] = recent.map((msg, index) => ({
      id: `history:msg:${index}`,
      action: 'keep-raw' as const,
      tokens: estimateTokens(msg.content || '', model)
        + (msg.images?.length ? (msg.images.length * IMAGE_TOKEN_ESTIMATE) : 0),
      coveredBySummary: false,
    }))
    if (droppedCount > 0) {
      if (covered) {
        items.push({
          id: 'history:summary',
          action: 'replace-with-summary',
          tokens: summaryTokens,
          coveredBySummary: true,
        })
      } else {
        items.push({
          id: 'history:dropped-raw',
          action: 'drop-raw',
          tokens: droppedTokens,
          coveredBySummary: false,
        })
      }
    }

    const candidate = {
      keptRawCount: recent.length,
      keptRawTokens,
      summaryReplacedCount: covered ? droppedCount : 0,
      summaryTokens: covered ? summaryTokens : 0,
      droppedRawCount: covered ? 0 : droppedCount,
      droppedRawTokens: covered ? 0 : droppedTokens,
      totalTokens: keptRawTokens + (covered ? summaryTokens : 0),
    }
    // 既有口径：crop 后若覆盖则另注摘要；与候选对齐比较
    const existing = {
      keptCount: recent.length,
      keptTokens: keptRawTokens,
      droppedCount,
      droppedTokens,
      summaryInjected: covered,
      summaryTokens: covered ? summaryTokens : 0,
    }
    return {
      mode: 'history-degradation',
      budgetTokens,
      existing,
      candidate,
      deltaTokens: candidate.totalTokens - (existing.keptTokens + existing.summaryTokens),
      items,
      degraded: false,
    }
  } catch {
    return degradedHistoryPlan(input.budgetTokens)
  }
}

/** 数值化日志串（不含正文/消息内容） */
export function formatHistoryDegradationSummary(plan: HistoryDegradationPlan): string {
  return [
    'mode=history-degradation',
    `budget=${plan.budgetTokens}`,
    `existingKept=${plan.existing.keptTokens}`,
    `existingSummary=${plan.existing.summaryTokens}`,
    `candRaw=${plan.candidate.keptRawTokens}`,
    `candSummary=${plan.candidate.summaryTokens}`,
    `replace=${plan.candidate.summaryReplacedCount}`,
    `drop=${plan.candidate.droppedRawCount}`,
    `delta=${plan.deltaTokens}`,
    `degraded=${plan.degraded ? 1 : 0}`,
  ].join(' ')
}

// ===================== 序列化后输入审计接线 =====================

/**
 * 把已合并/转换后的消息映射为无正文的估算视图（`serialized: false`）。
 * 真正的供应商序列化视图仍待适配器接入；在此之前精度只能是 `estimated`。
 */
export function buildSerializedInputViewFromMessages(
  messages: readonly ContextMessage[],
  options: { provider: string; model: string },
): {
  provider: string
  model: string
  parts: SerializedInputPart[]
  serialized: false
} {
  const parts: SerializedInputPart[] = (Array.isArray(messages) ? messages : []).map((message, index) => ({
    id: `part:${index}:${message.role}`,
    role: (message.role === 'system' || message.role === 'user' || message.role === 'assistant' || message.role === 'tool')
      ? message.role
      : 'system',
    tokens: estimateTokens(message.content || '', options.model),
    confidence: 'estimated' as const,
  }))
  return {
    provider: options.provider,
    model: options.model,
    parts,
    serialized: false,
  }
}

/**
 * 序列化后输入审计接线：估算视图 → 审计。
 * 超限只报告 `overBudget` 与一次重分配额度；适配器不得在此私自截消息（§5.6）。
 */
export function auditMessagesAsSerializedInput(
  messages: readonly ContextMessage[],
  options: {
    provider: string
    model: string
    reservedOutputTokens: number
    contextLimit: number
  },
): SerializedInputAudit {
  const view = buildSerializedInputViewFromMessages(messages, {
    provider: options.provider,
    model: options.model,
  })
  return auditSerializedInput(view, {
    reservedOutputTokens: options.reservedOutputTokens,
    contextLimit: options.contextLimit,
  })
}

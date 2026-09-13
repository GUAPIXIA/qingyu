/**
 * W7（主计划 §5.6 / §7.9 第 4 条）：序列化后最终输入审计——契约骨架 + 纯聚合，无 IO。
 *
 * 为什么要"序列化后"再审计一次：候选选择用的是启发式估算器，供应商最终收到的请求体
 * 还可能经过模板、角色前缀、工具定义等转换。审计入口消费的是**适配器请求体准备逻辑产出的
 * 可计数序列化视图**，从而把"估算选择"与"实际发送"分开记录。
 *
 * 本期（W7）只交付契约与聚合：
 * - `SerializedInputView` 由适配器在 W9 接入（本期调用方返回 `serialized: false` 即为骨架态）；
 * - 计数精度只允许三档：`exact` / `provider-reported` / `estimated`，禁止把估算宣称为精确 Token；
 * - 审计超限时只允许回到 `ContextAllocator` 降级一次（`MAX_INPUT_REALLOCATIONS`），
 *   适配器不得私自截断消息（§5.6 最后一条）；
 * - 视图与审计结果只含 id / role / 计数，不含正文、提示词或 URL。
 */

import { TOKEN_BUDGET_SAFETY } from './chatConstants'

/** 计数精度口径（§5.6：本期验收不能把所有供应商都宣称为"精确 Token"） */
export type TokenAccountingConfidence = 'exact' | 'provider-reported' | 'estimated'

/** 序列化视图中的一个可计数片段（不含内容） */
export interface SerializedInputPart {
  /** 稳定 id（同一逻辑片段跨轮一致，供差异解释） */
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  tokens: number
  confidence: TokenAccountingConfidence
}

/**
 * 适配器请求体准备逻辑应能在发送前返回该视图（W9 接入）。
 * `serialized: false` 表示仍是"仅估算"骨架态——此时审计结果只记录估算值。
 */
export interface SerializedInputView {
  provider: string
  model: string
  parts: SerializedInputPart[]
  serialized: boolean
}

export interface SerializedInputAuditOptions {
  /** 与 `ChatParams.maxTokens` 同源的输出预留（§4.2 预算同源） */
  reservedOutputTokens: number
  /** 本轮模型可用上下文窗口 */
  contextLimit: number
  /** 协议安全余量比例；缺省用既有 `TOKEN_BUDGET_SAFETY` 的补数，保持单一来源 */
  protocolSafetyRatio?: number
}

export interface SerializedInputRoleStat {
  role: SerializedInputPart['role']
  parts: number
  tokens: number
}

export interface SerializedInputAudit {
  /** 输入侧合计（所有片段） */
  inputTokens: number
  reservedOutputTokens: number
  protocolSafetyTokens: number
  /** 输入 + 输出预留 + 协议余量 */
  totalTokens: number
  contextLimit: number
  /** 是否超过模型窗口 */
  overBudget: boolean
  /** 超限时是否还有一次重分配额度（§5.6：只允许一次） */
  remainingReallocations: number
  /** 本轮整体计数精度 = 最弱环节 */
  accountingConfidence: TokenAccountingConfidence
  /** 序列化视图缺失（本轮只有估算值） */
  serializedViewMissing: boolean
  byRole: SerializedInputRoleStat[]
}

/** §5.6：审计超限时只允许回到 `ContextAllocator` 降级一次 */
export const MAX_INPUT_REALLOCATIONS = 1

const ROLE_ORDER: readonly SerializedInputPart['role'][] = ['system', 'user', 'assistant', 'tool']

/** 取最弱精度：只要有一处估算，整体就不能宣称精确 */
export function weakestAccountingConfidence(
  confidences: readonly TokenAccountingConfidence[],
): TokenAccountingConfidence {
  if (confidences.some((value) => value === 'estimated')) return 'estimated'
  if (confidences.some((value) => value === 'provider-reported')) return 'provider-reported'
  return 'exact'
}

function normalizePartTokens(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.ceil(value)
}

/**
 * 序列化后输入审计（纯函数）。
 * 超限时不在这里做任何裁剪决策：只报告 `overBudget` 与剩余重分配额度，由调用方交回分配器。
 */
export function auditSerializedInput(
  view: SerializedInputView,
  options: SerializedInputAuditOptions,
): SerializedInputAudit {
  const parts = Array.isArray(view.parts) ? view.parts : []
  const reservedOutputTokens = normalizePartTokens(options.reservedOutputTokens)
  const contextLimit = normalizePartTokens(options.contextLimit)
  const safetyRatioRaw = options.protocolSafetyRatio
  const safetyRatio = typeof safetyRatioRaw === 'number' && Number.isFinite(safetyRatioRaw) && safetyRatioRaw > 0
    ? safetyRatioRaw
    : 1 - TOKEN_BUDGET_SAFETY

  let inputTokens = 0
  const confidences: TokenAccountingConfidence[] = []
  const byRoleMap = new Map<SerializedInputPart['role'], SerializedInputRoleStat>()
  for (const part of parts) {
    const tokens = normalizePartTokens(part?.tokens)
    inputTokens += tokens
    confidences.push(part?.confidence ?? 'estimated')
    const role: SerializedInputPart['role'] =
      part?.role && ROLE_ORDER.includes(part.role) ? part.role : 'system'
    const stat = byRoleMap.get(role) ?? { role, parts: 0, tokens: 0 }
    stat.parts += 1
    stat.tokens += tokens
    byRoleMap.set(role, stat)
  }

  const protocolSafetyTokens = Math.ceil(contextLimit * safetyRatio)
  const totalTokens = inputTokens + reservedOutputTokens + protocolSafetyTokens
  return {
    inputTokens,
    reservedOutputTokens,
    protocolSafetyTokens,
    totalTokens,
    contextLimit,
    overBudget: contextLimit > 0 && totalTokens > contextLimit,
    remainingReallocations: MAX_INPUT_REALLOCATIONS,
    accountingConfidence: parts.length === 0
      ? 'estimated'
      : weakestAccountingConfidence(confidences),
    serializedViewMissing: view.serialized !== true,
    byRole: [...byRoleMap.values()].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)),
  }
}

/** 数值化日志串（不含正文/提示词/URL），供观测与诊断条目复用 */
export function formatInputAuditSummary(audit: SerializedInputAudit): string {
  return [
    `input=${audit.inputTokens}`,
    `reserved=${audit.reservedOutputTokens}`,
    `safety=${audit.protocolSafetyTokens}`,
    `total=${audit.totalTokens}/${audit.contextLimit}`,
    `over=${audit.overBudget ? 1 : 0}`,
    `accounting=${audit.accountingConfidence}`,
    `serialized=${audit.serializedViewMissing ? 0 : 1}`,
  ].join(' ')
}

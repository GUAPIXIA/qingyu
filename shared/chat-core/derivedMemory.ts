/**
 * 阶段 6 S6-01：派生记忆（历史摘要/当前状态/关键事实/事实向量/压缩摘要）的
 * 失效决策——**跨端共享的纯逻辑**（单聊与群聊同一检查点语义）。
 *
 * 为什么必须共享：编辑/删除/清空消息后是否废止派生记忆，决定「保留派生数据」
 * 还是「全量失效 + memoryVersion 归零」。两端判定不一致会导致一端保留旧摘要、
 * 另一端重建，群记忆的 CAS（memoryVersion 乐观锁）也随之漂移。
 *
 * oracle 消费方：PC `src/store/chatUtils.ts` 的 `invalidateDerivedMemory` /
 * `invalidateGroupDerivedMemory`。
 *
 * 检查点语义（阶段五检查点，历史行为）：
 * - 无派生数据 → 保留；
 * - `changedMessageId` 为空（clearChat 等）→ 全量失效；
 * - 无检查点（memoryLastMessageId 空 / memoryVersion 0）→ 全量失效；
 * - 变更消息在游标**之后** → 保留派生记忆；
 * - 变更在游标之前或等于游标、游标或消息找不到 → 保守全量失效。
 *
 * variant 语义钉子：单聊（'chat'）把 `memoryFactParseFailureCount` /
 * `memoryFactRetryAfterVersion` 计入「有派生数据」；群聊（'group'）不计。
 * 这是 PC 两侧现状差异，fixture 钉死，任何一端改变都必须先改契约。
 */

export interface DerivedMemorySnapshot {
  memory?: string | null
  memoryCurrentState?: string | null
  memoryFacts?: readonly unknown[] | null
  memoryFactHistory?: readonly unknown[] | null
  factsVectors?: readonly unknown[] | null
  memoryLastMessageId?: string | null
  memoryVersion?: number | null
  compressedSummary?: string | null
  memoryFactParseFailureCount?: number | null
  memoryFactRetryAfterVersion?: number | null
}

export type DerivedMemoryDecision =
  | { action: 'keep' }
  | { action: 'invalidate'; expectedVersion: number; patch: DerivedMemoryResetPatch }

/** 全量失效写入的字段集合（两端逐字一致，含归零与置空）。 */
export interface DerivedMemoryResetPatch {
  memory: string
  memoryCurrentState: string
  memoryFacts: never[]
  memoryFactHistory: never[]
  memoryFactParseFailureCount: number
  memoryFactRetryAfterVersion: number
  factsVectors: never[]
  memoryUpdatedAt: number
  memoryLastMessageId: null
  memoryVersion: number
  factsVectorVersion: number
  compressedSummary: null
  compressedRange: null
}

export function derivedMemoryResetPatch(): DerivedMemoryResetPatch {
  return {
    memory: '',
    memoryCurrentState: '',
    memoryFacts: [],
    memoryFactHistory: [],
    memoryFactParseFailureCount: 0,
    memoryFactRetryAfterVersion: 0,
    factsVectors: [],
    memoryUpdatedAt: 0,
    memoryLastMessageId: null,
    memoryVersion: 0,
    factsVectorVersion: 0,
    compressedSummary: null,
    compressedRange: null,
  }
}

export function planDerivedMemoryInvalidation(input: {
  variant: 'chat' | 'group'
  session: DerivedMemorySnapshot
  /** 会话当前消息 id 顺序（与展示顺序一致）。 */
  messageIds: readonly string[]
  /** 被编辑/删除的消息 id；null/undefined 表示全量（clearChat）。 */
  changedMessageId?: string | null
}): DerivedMemoryDecision {
  const s = input.session
  const hasDerived = Boolean(
    s.memory
    || s.memoryCurrentState
    || (s.memoryFacts && s.memoryFacts.length > 0)
    || (s.memoryFactHistory && s.memoryFactHistory.length > 0)
    || (s.factsVectors && s.factsVectors.length > 0)
    || s.memoryLastMessageId
    || s.memoryVersion
    || (input.variant === 'chat'
      ? (s.memoryFactParseFailureCount || s.memoryFactRetryAfterVersion)
      : false)
    || s.compressedSummary,
  )
  if (!hasDerived) return { action: 'keep' }

  if (input.changedMessageId) {
    const cursor = s.memoryLastMessageId ?? null
    const version = s.memoryVersion ?? 0
    if (!cursor || version === 0) {
      // 无检查点 → 全量失效（fallthrough）
    } else {
      const cursorIndex = input.messageIds.indexOf(cursor)
      const changedIndex = input.messageIds.indexOf(input.changedMessageId)
      if (cursorIndex === -1 || changedIndex === -1) {
        // 消息或游标找不到 → 保守全量失效（fallthrough）
      } else if (changedIndex > cursorIndex) {
        // 变更在已总结范围之后，保留记忆
        return { action: 'keep' }
      }
      // 变更在游标前或等于游标 → 全量失效（fallthrough）
    }
  }

  return {
    action: 'invalidate',
    expectedVersion: s.memoryVersion ?? 0,
    patch: derivedMemoryResetPatch(),
  }
}

/**
 * 阶段 4 S4-04：消息候选（swipe）语义——**跨端共享的纯逻辑**。
 *
 * 为什么必须共享：候选语义是「同一条消息持有多个候选、当前内容与索引指向其中一个」。
 * 若一端把它实现成「新建一条消息」，同一段对话在两端就会得到不同的消息数量与顺序，
 * 而消息数量会直接进入导出、分页与上下文预算。
 *
 * 抽到 shared 后，fixture 的 oracle 就是生产代码真正调用的这份实现。
 */

export interface SwipeTarget {
  content: string
  swipes?: string[] | null
  swipeIndex?: number | null
}

export interface CandidateUpdate {
  content: string
  swipes: string[]
  swipeIndex: number
}

/**
 * 重新生成：**追加**新候选（不删除原内容），并把当前内容指向新候选。
 * 原消息 id 不变——这是「同一条消息的多个候选」，不是多条消息。
 */
export function appendRegeneratedCandidate(target: SwipeTarget, newContent: string): CandidateUpdate {
  const swipes = target.swipes ?? [target.content]
  return {
    swipes: [...swipes, newContent],
    swipeIndex: swipes.length,
    content: newContent,
  }
}

/**
 * 在已有候选之间切换。
 * - `direction === 0` 不属于本函数（那是重新生成）；
 * - 候选少于 2 个时无可切换，原样返回；
 * - 循环取模，支持任意正负方向。
 */
export function rotateSwipe(target: SwipeTarget, direction: number): CandidateUpdate {
  const swipes = target.swipes ?? [target.content]
  const current = target.swipeIndex ?? 0
  if (swipes.length < 2) {
    return { content: target.content, swipes, swipeIndex: current }
  }
  const next = (((current + direction) % swipes.length) + swipes.length) % swipes.length
  return { content: swipes[next], swipes, swipeIndex: next }
}

/** 候选视图（供界面显示「第 i / n 个」）。 */
export function candidatePosition(target: SwipeTarget): { index: number; count: number } {
  const swipes = target.swipes ?? [target.content]
  const index = target.swipeIndex ?? 0
  return { index: Math.max(0, Math.min(index, swipes.length - 1)), count: swipes.length }
}

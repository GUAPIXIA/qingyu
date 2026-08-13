/**
 * P-8：流式 chunk 累积器（节流 flush + 空闲超时）
 *
 * 背景流式任务（消息翻译等）的三件套模式统一收口：
 * - 节流：chunk 高频到达时按 throttleMs 合并 flush，避免每次 chunk 都触发 set 重渲染
 * - 空闲超时：idleTimeoutMs 内无新 chunk 视为流中断，回调 onIdleTimeout 由调用方中止请求
 * - 显式 dispose/flushNow：请求结束（done/error）时清理 timer，不再泄漏
 */
export interface ChunkAccumulator {
  /** 追加 chunk：累计文本并调度节流 flush / 重置空闲计时 */
  append: (text: string) => void
  /** 立即清理全部 timer 并返回累计文本（请求结束收尾用） */
  flushNow: () => string
  /** 清理全部 timer（放弃本次累积） */
  dispose: () => void
}

export function createChunkAccumulator(opts: {
  /** 节流 flush 回调（携带当前累计文本） */
  onFlush: (accumulated: string) => void
  /** 空闲超时回调（调用方负责中止请求与状态收尾） */
  onIdleTimeout: () => void
  throttleMs?: number
  idleTimeoutMs?: number
}): ChunkAccumulator {
  const { onFlush, onIdleTimeout, throttleMs = 80, idleTimeoutMs = 30_000 } = opts
  let accumulated = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const clearTimers = () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  return {
    append(text: string) {
      if (disposed) return
      accumulated += text
      // 每次收到 chunk 重置空闲计时
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimer = null
        clearTimers()
        onIdleTimeout()
      }, idleTimeoutMs)
      // 节流：首个 chunk 后调度一次 flush
      if (flushTimer === null) {
        flushTimer = setTimeout(() => {
          flushTimer = null
          onFlush(accumulated)
        }, throttleMs)
      }
    },
    flushNow() {
      clearTimers()
      disposed = true
      return accumulated
    },
    dispose() {
      clearTimers()
      disposed = true
      accumulated = ''
    },
  }
}

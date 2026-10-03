/** 仅在嵌入画板打开时注册；切换上下文前等待它的全部命令确认。 */
let activeFlush: (() => Promise<void>) | null = null

export function registerSpatialFlush(flush: () => Promise<void>): () => void {
  activeFlush = flush
  return () => { if (activeFlush === flush) activeFlush = null }
}

/** 没有画板时保持现有同步行为；错误由画板展示，调用方停止切换。 */
export function flushSpatialBoard(): Promise<void> | undefined {
  return activeFlush?.()
}

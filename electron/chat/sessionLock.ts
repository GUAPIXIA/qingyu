/**
 * V12-05 SessionLock：同 session 单 generation 互斥（实施方案 §14.1）
 *
 * - 单进程内存锁（Electron 主进程单线程，无需文件锁）
 * - tryAcquire 立即返回；acquire 支持公平排队（FIFO）
 * - 仅 holder 可 release，重复 release 安全
 */

type Waiter = { taskId: string; resolve: (ok: boolean) => void; timer?: ReturnType<typeof setTimeout> }

export class SessionLock {
  private holders = new Map<string, string>() // sessionId -> taskId
  private queues = new Map<string, Waiter[]>() // sessionId -> FIFO

  isLocked(sessionId: string): boolean {
    return this.holders.has(sessionId)
  }

  holderOf(sessionId: string): string | null {
    return this.holders.get(sessionId) ?? null
  }

  /** 尝试立即获取，成功返回 true，失败立即 false（返回 TASK_CONFLICT 场景） */
  tryAcquire(sessionId: string, taskId: string): boolean {
    if (!this.holders.has(sessionId)) {
      this.holders.set(sessionId, taskId)
      return true
    }
    return this.holders.get(sessionId) === taskId
  }

  /**
   * 公平排队获取（FIFO），超时返回 false。
   * 0 超时表示不等待，等价 tryAcquire。
   */
  acquire(sessionId: string, taskId: string, timeoutMs = 0): Promise<boolean> {
    if (this.tryAcquire(sessionId, taskId)) return Promise.resolve(true)
    if (timeoutMs <= 0) return Promise.resolve(false)

    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = { taskId, resolve }
      const q = this.queues.get(sessionId) ?? []
      q.push(waiter)
      this.queues.set(sessionId, q)
      waiter.timer = setTimeout(() => {
        const qq = this.queues.get(sessionId)
        if (qq) {
          const idx = qq.indexOf(waiter)
          if (idx >= 0) qq.splice(idx, 1)
        }
        resolve(false)
      }, timeoutMs)
    })
  }

  release(sessionId: string, taskId: string): boolean {
    if (this.holders.get(sessionId) !== taskId) return false
    this.holders.delete(sessionId)
    // 唤醒下一个排队者（FIFO）
    const q = this.queues.get(sessionId)
    if (q && q.length > 0) {
      const next = q.shift()!
      if (next.timer) clearTimeout(next.timer)
      this.holders.set(sessionId, next.taskId)
      next.resolve(true)
      if (q.length === 0) this.queues.delete(sessionId)
    }
    return true
  }

  /** 仅测试用：清空全部锁 */
  clear(): void {
    this.holders.clear()
    for (const q of this.queues.values()) {
      for (const w of q) {
        if (w.timer) clearTimeout(w.timer)
        w.resolve(false)
      }
    }
    this.queues.clear()
  }

  size(): number {
    return this.holders.size
  }
}

export const sessionLock = new SessionLock()

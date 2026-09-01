/** 同一时刻只执行一个异步工厂；完成/失败后均允许下一轮。 */
export class RelaySingleFlight<T> {
  private pending: Promise<T> | null = null
  run(factory: () => Promise<T>): Promise<T> {
    if (this.pending) return this.pending
    const current = factory()
    this.pending = current
    void current.finally(() => { if (this.pending === current) this.pending = null }).catch(() => {})
    return current
  }
}

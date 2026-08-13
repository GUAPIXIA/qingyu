import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createChunkAccumulator } from '../chunkAccumulator'

describe('createChunkAccumulator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('节流：多个 chunk 只触发一次 flush，携带累计文本', () => {
    const onFlush = vi.fn()
    const acc = createChunkAccumulator({ onFlush, onIdleTimeout: vi.fn(), throttleMs: 50 })
    acc.append('你')
    acc.append('好')
    acc.append('呀')
    vi.advanceTimersByTime(50)
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith('你好呀')
  })

  it('节流窗口内再次追加会调度下一次 flush', () => {
    const onFlush = vi.fn()
    const acc = createChunkAccumulator({ onFlush, onIdleTimeout: vi.fn(), throttleMs: 50 })
    acc.append('第一段')
    vi.advanceTimersByTime(50)
    acc.append('第二段')
    vi.advanceTimersByTime(50)
    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush).toHaveBeenLastCalledWith('第一段第二段')
  })

  it('空闲超时：无新 chunk 时触发 onIdleTimeout 并清理 timer', () => {
    const onIdleTimeout = vi.fn()
    const onFlush = vi.fn()
    const acc = createChunkAccumulator({ onFlush, onIdleTimeout, throttleMs: 50, idleTimeoutMs: 1000 })
    acc.append('开头')
    vi.advanceTimersByTime(1000)
    expect(onIdleTimeout).toHaveBeenCalledTimes(1)
    // 节流 flush 在 50ms 时已正常触发一次；空闲超时触发后不再有后续 flush
    expect(onFlush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(500)
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onIdleTimeout).toHaveBeenCalledTimes(1)
  })

  it('收到新 chunk 会重置空闲计时', () => {
    const onIdleTimeout = vi.fn()
    const acc = createChunkAccumulator({ onFlush: vi.fn(), onIdleTimeout, idleTimeoutMs: 1000 })
    acc.append('a')
    vi.advanceTimersByTime(800)
    acc.append('b') // 重置计时
    vi.advanceTimersByTime(800)
    expect(onIdleTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(onIdleTimeout).toHaveBeenCalledTimes(1)
  })

  it('flushNow 返回全部累计文本并清理 timer', () => {
    const onFlush = vi.fn()
    const onIdleTimeout = vi.fn()
    const acc = createChunkAccumulator({ onFlush, onIdleTimeout, throttleMs: 50, idleTimeoutMs: 1000 })
    acc.append('完整')
    acc.append('内容')
    const text = acc.flushNow()
    expect(text).toBe('完整内容')
    // flushNow 后不再有任何回调
    vi.advanceTimersByTime(5000)
    expect(onFlush).not.toHaveBeenCalled()
    expect(onIdleTimeout).not.toHaveBeenCalled()
  })

  it('dispose 后追加不再调度回调', () => {
    const onFlush = vi.fn()
    const acc = createChunkAccumulator({ onFlush, onIdleTimeout: vi.fn() })
    acc.dispose()
    acc.append('残留')
    vi.advanceTimersByTime(5000)
    expect(onFlush).not.toHaveBeenCalled()
  })
})

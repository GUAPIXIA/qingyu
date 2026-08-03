/**
 * toolLoop 工具调用超时单元测试
 */
import { describe, expect, it, vi, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-test' },
}))

import { callToolWithTimeout } from '../toolLoop'

afterEach(() => {
  vi.useRealTimers()
})

describe('callToolWithTimeout', () => {
  it('正常完成时返回结果', async () => {
    const result = await callToolWithTimeout(async () => 'ok', 1000)
    expect(result).toBe('ok')
  })

  it('工具挂起超过时限时抛出超时错误', async () => {
    vi.useFakeTimers()
    const pending = callToolWithTimeout(
      () => new Promise(() => { /* 永不 resolve */ }),
      100,
    )
    // 先 attach 断言再推进假定时器，避免 reject 在测试未消费时被判定为未处理
    const assertion = expect(pending).rejects.toThrow('工具调用超时')
    await vi.advanceTimersByTimeAsync(101)
    await assertion
  })

  it('失败时向上抛出原始错误', async () => {
    await expect(
      callToolWithTimeout(async () => { throw new Error('tool boom') }, 1000),
    ).rejects.toThrow('tool boom')
  })
})

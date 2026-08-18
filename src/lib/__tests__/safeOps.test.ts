import { describe, it, expect, vi, beforeEach } from 'vitest'
import { safeSave, safeFire } from '../safeOps'
import { logError } from '../logger'

vi.mock('../logger', () => ({
  logError: vi.fn(),
}))

describe('safeSave', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('成功时正常执行，不抛异常', async () => {
    const fn = vi.fn().mockResolvedValue(undefined)
    await safeSave(fn, '测试操作')
    expect(fn).toHaveBeenCalled()
  })

  it('失败时不抛异常（静默处理）', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('网络错误'))
    await expect(safeSave(fn, '测试操作')).resolves.toBeUndefined()
    expect(fn).toHaveBeenCalled()
  })

  it('失败时调用 logError', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('保存失败'))
    await safeSave(fn, '消息保存')
    expect(logError).toHaveBeenCalledWith('[SafeSave] 消息保存', expect.any(Error))
  })
})

describe('safeFire', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('成功时不产生副作用', () => {
    const fn = vi.fn().mockResolvedValue(undefined)
    safeFire(fn, '埋点')
    expect(fn).toHaveBeenCalled()
  })

  it('失败时不阻塞调用方，不抛异常', () => {
    const fn = vi.fn().mockRejectedValue(new Error('网络错误'))
    expect(() => safeFire(fn, '用量记录')).not.toThrow()
  })
})

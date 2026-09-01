import { describe, expect, it, vi } from 'vitest'
import { renameWithRetry } from '../localModels/manager'

function fileError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('local model task persistence', () => {
  it('Windows 瞬时占用时重试原子替换', () => {
    const rename = vi.fn()
      .mockImplementationOnce(() => { throw fileError('EPERM') })
      .mockImplementationOnce(() => { throw fileError('EBUSY') })
      .mockImplementationOnce(() => undefined)
    const wait = vi.fn()

    renameWithRetry('tasks.json.tmp', 'tasks.json', { rename, wait, maxAttempts: 4 })

    expect(rename).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenNthCalledWith(1, 15)
    expect(wait).toHaveBeenNthCalledWith(2, 30)
  })

  it('非瞬时文件错误不重试', () => {
    const rename = vi.fn(() => { throw fileError('ENOENT') })
    const wait = vi.fn()

    expect(() => renameWithRetry('missing.tmp', 'tasks.json', { rename, wait })).toThrow('ENOENT')
    expect(rename).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })
})

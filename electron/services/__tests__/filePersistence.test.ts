import { describe, expect, it, vi } from 'vitest'
import { replaceFileWithRetry } from '../filePersistence'

function fileError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('replaceFileWithRetry', () => {
  it('Windows 持续禁止 rename 时回退为覆盖复制', () => {
    const rename = vi.fn(() => { throw fileError('EPERM') })
    const copy = vi.fn()
    const wait = vi.fn()

    expect(replaceFileWithRetry('chat.jsonl.tmp', 'chat.jsonl', {
      rename,
      copy,
      wait,
      maxAttempts: 3,
    })).toBe('copied')

    expect(rename).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenNthCalledWith(1, 15)
    expect(wait).toHaveBeenNthCalledWith(2, 30)
    expect(copy).toHaveBeenCalledWith('chat.jsonl.tmp', 'chat.jsonl')
  })

  it('非占用类错误直接抛出，不覆盖目标文件', () => {
    const rename = vi.fn(() => { throw fileError('ENOENT') })
    const copy = vi.fn()
    const wait = vi.fn()

    expect(() => replaceFileWithRetry('missing.tmp', 'chat.jsonl', {
      rename,
      copy,
      wait,
    })).toThrow('ENOENT')
    expect(rename).toHaveBeenCalledTimes(1)
    expect(copy).not.toHaveBeenCalled()
    expect(wait).not.toHaveBeenCalled()
  })
})

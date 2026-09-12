import { copyFileSync, renameSync } from 'node:fs'

interface ReplaceFileOptions {
  rename?: (source: string, destination: string) => void
  copy?: (source: string, destination: string) => void
  wait?: (milliseconds: number) => void
  maxAttempts?: number
}

const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])

function waitSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/**
 * 优先用 rename 原子替换文件。Windows 上目标文件若被读取方禁止重命名，
 * 短暂重试后在调用方已有写锁的前提下回退为覆盖复制。
 */
export function replaceFileWithRetry(
  source: string,
  destination: string,
  options: ReplaceFileOptions = {},
): 'renamed' | 'copied' {
  const rename = options.rename ?? renameSync
  const copy = options.copy ?? copyFileSync
  const wait = options.wait ?? waitSynchronously
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      rename(source, destination)
      return 'renamed'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!TRANSIENT_RENAME_ERRORS.has(code ?? '')) throw error
      if (attempt < maxAttempts - 1) wait(15 * (2 ** attempt))
    }
  }

  copy(source, destination)
  return 'copied'
}

import { describe, expect, it, vi } from 'vitest'
import { createSaveCoordinator } from '../src/persistence/saveCoordinator.ts'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('save coordinator', () => {
  it('writes changes in order and reports saved only for the latest version', async () => {
    const first = deferred()
    const second = deferred()
    let snapshot = 'first'
    const writes: string[] = []
    const statuses: string[] = []
    const save = createSaveCoordinator({
      snapshot: () => snapshot,
      write: (value) => {
        writes.push(value)
        return writes.length === 1 ? first.promise : second.promise
      },
      onStatus: (status) => statuses.push(status),
    })

    save.markDirty()
    const pending = save.flush()
    expect(writes).toEqual(['first'])
    snapshot = 'second'
    save.markDirty()
    first.resolve()
    await Promise.resolve()
    expect(writes).toEqual(['first', 'second'])
    expect(statuses.at(-1)).toBe('saving')
    second.resolve()
    await pending
    expect(statuses.at(-1)).toBe('saved')
    expect(save.hasUnsavedChanges()).toBe(false)
    save.dispose()
  })

  it('keeps a failed version dirty and retries the latest snapshot', async () => {
    vi.useFakeTimers()
    try {
      let snapshot = 1
      const writes: number[] = []
      const statuses: string[] = []
      const save = createSaveCoordinator({
        snapshot: () => snapshot,
        write: async (value) => {
          writes.push(value)
          if (writes.length === 1) throw new Error('disk full')
        },
        onStatus: (status) => statuses.push(status),
      })
      save.markDirty()
      await save.flush()
      expect(save.hasUnsavedChanges()).toBe(true)
      expect(statuses.at(-1)).toBe('error')
      snapshot = 2
      save.markDirty()
      await save.flush()
      expect(writes).toEqual([1, 2])
      expect(statuses.at(-1)).toBe('saved')
      save.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

export type SaveCoordinatorStatus = 'saving' | 'saved' | 'error'

export interface SaveCoordinator {
  markDirty: () => void
  flush: () => Promise<void>
  hasUnsavedChanges: () => boolean
  dispose: () => void
}

/** Serializes writes so an older snapshot can never overwrite a newer one. */
export function createSaveCoordinator<T>({
  snapshot,
  write,
  onStatus,
  debounceMs = 250,
  retryMs = 5000,
}: {
  snapshot: () => T
  write: (value: T) => Promise<void>
  onStatus: (status: SaveCoordinatorStatus) => void
  debounceMs?: number
  retryMs?: number
}): SaveCoordinator {
  let changedVersion = 0
  let savedVersion = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let activeWrite: Promise<void> | null = null

  function clearTimers() {
    if (timer) clearTimeout(timer)
    if (retryTimer) clearTimeout(retryTimer)
    timer = null
    retryTimer = null
  }

  function flush(): Promise<void> {
    clearTimers()
    if (activeWrite) return activeWrite
    if (savedVersion === changedVersion) return Promise.resolve()

    activeWrite = (async () => {
      while (savedVersion < changedVersion) {
        const writingVersion = changedVersion
        const value = snapshot()
        try {
          await write(value)
        } catch {
          onStatus('error')
          retryTimer = setTimeout(() => { void flush() }, retryMs)
          return
        }
        savedVersion = writingVersion
        if (savedVersion === changedVersion) onStatus('saved')
      }
    })().finally(() => { activeWrite = null })
    return activeWrite
  }

  return {
    markDirty() {
      changedVersion += 1
      onStatus('saving')
      clearTimers()
      timer = setTimeout(() => { void flush() }, debounceMs)
    },
    flush,
    hasUnsavedChanges: () => savedVersion < changedVersion || activeWrite !== null,
    dispose: clearTimers,
  }
}

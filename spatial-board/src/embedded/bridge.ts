import { useSpatialStore } from '../store/spatialStore.ts'
import type { SpatialCoreState } from '@qingyu/spatial-core'
import { EmbeddedCommandQueue, type EmbeddedSnapshot, type EmbeddedResult } from './commandQueue.ts'

/** PC 提交命令并返回权威数据；独立版 IndexedDB 不参与。 */
export function startEmbeddedBoard(): Promise<void> {
  return new Promise((resolve) => {
    const send = (message: unknown) => window.parent.postMessage(message, '*')
    const trusted = (event: MessageEvent) => event.source === window.parent &&
      (window.location.protocol === 'file:' ? event.origin === 'null' || event.origin === 'file://' : event.origin === window.location.origin)
    const applyActorAvatars = (value: unknown) => {
      const entries = value && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string') : []
      useSpatialStore.setState({ actorAvatarUrls: Object.fromEntries(entries) })
    }
    const applyView = (data: { activeActorIds?: unknown; assistantEnabled?: unknown }, initial = false) => {
      if (initial || Object.prototype.hasOwnProperty.call(data, 'activeActorIds')) {
        useSpatialStore.setState({ activeActorIds: Array.isArray(data.activeActorIds)
          ? data.activeActorIds.filter((id): id is string => typeof id === 'string') : null })
        const selected = useSpatialStore.getState().selection
        const active = useSpatialStore.getState().activeActorIds
        if (selected.type === 'actor' && active && selected.id && !active.includes(selected.id)) useSpatialStore.getState().select({ type: 'none', id: null })
      }
      if (initial) useSpatialStore.setState({ assistantEnabled: data.assistantEnabled !== false })
    }
    const applyTheme = (data: { theme?: string; palette?: Record<string, unknown> }) => {
      const root = document.documentElement
      root.classList.toggle('dark', data.theme === 'dark')
      for (const [key, property] of [['accent', '--color-accent'], ['accentHover', '--color-accent-hover'], ['accentSoft', '--color-accent-soft']] as const) {
        const value = data.palette?.[key]
        if (typeof value === 'string' && CSS.supports('color', value)) root.style.setProperty(property, value)
      }
    }
    const onInit = (event: MessageEvent) => {
      if (!trusted(event) || event.data?.type !== 'qingyu:spatial:init') return
      let applying = false
      const sync = (core: SpatialCoreState, reset: boolean, initial = false) => {
        applying = true
        try { useSpatialStore.getState().syncAuthoritative(core, reset, initial) } finally { applying = false }
      }
      try {
        if (!event.data.version) throw new Error('画板连接协议已更新，请重新打开画板')
        sync(event.data as EmbeddedSnapshot, true, true)
      } catch (error) {
        send({ type: 'qingyu:spatial:error', message: error instanceof Error ? error.message : String(error) })
        return
      }
      window.removeEventListener('message', onInit)
      applyView(event.data, true)
      applyTheme(event.data)
      applyActorAvatars(event.data.actorAvatarUrls)
      const queue = new EmbeddedCommandQueue(event.data as EmbeddedSnapshot, {
        id: () => crypto.randomUUID(),
        send: (request) => send({ type: 'qingyu:spatial:commands', request }),
        sync,
        status: (pending, error) => {
          useSpatialStore.setState({ saveStatus: error ? 'error' : pending ? 'saving' : 'saved',
            ...(error ? { statusMessage: error } : {}) })
          send({ type: 'qingyu:spatial:pending', pending, error })
        },
      })
      const unsubscribe = useSpatialStore.subscribe((state, previous) => {
        if (applying || state.core === previous.core) return
        const oldLast = previous.history.undoStack.at(-1)
        const newLast = state.history.undoStack.at(-1)
        if (oldLast && state.history.redoStack.at(-1) === oldLast && state.history.undoStack.length < previous.history.undoStack.length) {
          queue.enqueue([...oldLast.inverse].reverse())
        } else if (newLast && newLast !== oldLast) {
          queue.enqueue(newLast.forward)
        } else {
          applying = true
          useSpatialStore.setState({ core: previous.core, history: previous.history, saveStatus: 'error', statusMessage: '嵌入画板只接受命令编辑' })
          applying = false
          send({ type: 'qingyu:spatial:error', message: '嵌入画板只接受命令编辑' })
        }
      })
      const onStatus = (statusEvent: MessageEvent) => {
        if (!trusted(statusEvent)) return
        const data = statusEvent.data
        if (data?.type === 'qingyu:spatial:commit-result') {
          if (data.result?.ok && data.result.snapshot) applyView(data.result.snapshot)
          queue.confirm(data.commitId, data.result as EmbeddedResult)
        }
        else if (data?.type === 'qingyu:spatial:external') { applyView(data.snapshot); queue.external(data.snapshot as EmbeddedSnapshot) }
        else if (data?.type === 'qingyu:spatial:reload') { applyView(data.snapshot); queue.reload(data.snapshot as EmbeddedSnapshot) }
        else if (data?.type === 'qingyu:spatial:retry') queue.retry()
        else if (data?.type === 'qingyu:spatial:pause') queue.pause()
        else if (data?.type === 'qingyu:spatial:theme') applyTheme(data)
        else if (data?.type === 'qingyu:spatial:avatars') applyActorAvatars(data.actorAvatarUrls)
        else if (data?.type === 'qingyu:spatial:flush') {
          void queue.flush().then(() => send({ type: 'qingyu:spatial:flushed', requestId: data.requestId }))
            .catch((error) => send({ type: 'qingyu:spatial:flush-error', requestId: data.requestId, message: error.message }))
        }
      }
      window.addEventListener('message', onStatus)
      window.addEventListener('pagehide', () => { unsubscribe(); window.removeEventListener('message', onStatus) }, { once: true })
      useSpatialStore.setState({ saveStatus: 'saved' })
      resolve()
    }
    window.addEventListener('message', onInit)
    send({ type: 'qingyu:spatial:ready' })
  })
}

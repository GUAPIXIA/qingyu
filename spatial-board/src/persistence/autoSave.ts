/** Draft persistence for the standalone board. */
import { useSpatialStore } from '../store/spatialStore.ts'
import { loadDraft, saveDraft, type DraftPayload } from './draftStore.ts'
import { createSaveCoordinator } from './saveCoordinator.ts'

let started = false

const save = createSaveCoordinator<DraftPayload>({
  snapshot: () => {
    const state = useSpatialStore.getState()
    return {
      core: state.getCore(),
      currentBoardId: state.currentBoardId,
      savedAt: Date.now(),
    }
  },
  write: saveDraft,
  onStatus: (status) => {
    const state = useSpatialStore.getState()
    useSpatialStore.setState({
      saveStatus: status,
      ...(status === 'error'
        ? { statusMessage: '保存失败：内存数据仍完整，请用「导出」保存 JSON 兜底' }
        : status === 'saved' && state.statusMessage.startsWith('保存失败')
          ? { statusMessage: '草稿已重新保存' }
          : {}),
    })
  },
})

export function startAutoSave(): void {
  if (started) return
  started = true

  useSpatialStore.subscribe((state, prev) => {
    if (state.core !== prev.core || state.currentBoardId !== prev.currentBoardId) {
      save.markDirty()
    }
  })

  window.addEventListener('blur', () => { void save.flush() })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void save.flush()
  })
  window.addEventListener('pagehide', () => { void save.flush() })
  window.addEventListener('beforeunload', (event) => {
    if (!save.hasUnsavedChanges()) return
    void save.flush()
    event.preventDefault()
    event.returnValue = ''
  })
}

export async function restoreDraft(): Promise<boolean> {
  try {
    const draft = await loadDraft()
    if (!draft) return false
    if (!draft.core?.world || !draft.core.runtime) {
      throw new Error('草稿缺少世界定义或运行状态')
    }
    // The same migration, limits and reference checks used for JSON import.
    const result = useSpatialStore.getState().importPackage({
      world: draft.core.world,
      runtime: draft.core.runtime,
    })
    if (!result.ok) throw new Error(result.message)

    const world = useSpatialStore.getState().core.world
    useSpatialStore.setState({
      currentBoardId: world.rootBoardId,
      statusMessage: '已恢复草稿',
    })
    return true
  } catch (error) {
    useSpatialStore.setState({
      saveStatus: 'error',
      statusMessage: `草稿恢复失败：${error instanceof Error ? error.message : String(error)}`,
    })
    return false
  }
}

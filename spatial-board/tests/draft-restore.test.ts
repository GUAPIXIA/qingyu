import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyRuntime, createEmptyWorld } from '@qingyu/spatial-core'
import { useSpatialStore } from '../src/store/spatialStore.ts'
import { loadDraft } from '../src/persistence/draftStore.ts'
import { restoreDraft } from '../src/persistence/autoSave.ts'

vi.mock('../src/persistence/draftStore.ts', () => ({
  loadDraft: vi.fn(),
  saveDraft: vi.fn(),
}))

beforeEach(() => {
  useSpatialStore.getState().newWorld('before restore')
  vi.mocked(loadDraft).mockReset()
})

describe('draft restoration', () => {
  it('restores the root view while retaining legacy child boards and navigation code', async () => {
    const store = useSpatialStore.getState()
    const entryId = store.createPlaceAt(100, 100)!
    const childBoardId = store.createInternalBoard(entryId)!
    const core = structuredClone(useSpatialStore.getState().core)
    vi.mocked(loadDraft).mockResolvedValue({ core, currentBoardId: childBoardId, savedAt: 1 })

    expect(await restoreDraft()).toBe(true)
    expect(useSpatialStore.getState().currentBoardId).toBe(core.world.rootBoardId)
    expect(useSpatialStore.getState().core.world.boards).toEqual(core.world.boards)
    expect(useSpatialStore.getState().core.world.nodes).toEqual(core.world.nodes)
    useSpatialStore.getState().enterChildBoard(entryId)
    expect(useSpatialStore.getState().currentBoardId).toBe(childBoardId)
  })

  it('rejects an invalid saved world without replacing the current world', async () => {
    const originalId = useSpatialStore.getState().core.world.id
    const world = createEmptyWorld('bad', 'bad', { now: 1 })
    world.rootBoardId = 'missing-board'
    vi.mocked(loadDraft).mockResolvedValue({
      core: { world, runtime: createEmptyRuntime(world.id, 'runtime', 1) },
      currentBoardId: world.rootBoardId,
      savedAt: 1,
    })

    expect(await restoreDraft()).toBe(false)
    expect(useSpatialStore.getState().core.world.id).toBe(originalId)
    expect(useSpatialStore.getState().statusMessage).toContain('草稿恢复失败')
  })

  it('rejects an unsupported saved schema version', async () => {
    const originalId = useSpatialStore.getState().core.world.id
    const world = createEmptyWorld('future', 'future', { now: 1 })
    vi.mocked(loadDraft).mockResolvedValue({
      core: {
        world: { ...world, schemaVersion: 2 } as unknown as typeof world,
        runtime: createEmptyRuntime(world.id, 'runtime', 1),
      },
      currentBoardId: world.rootBoardId,
      savedAt: 1,
    })

    expect(await restoreDraft()).toBe(false)
    expect(useSpatialStore.getState().core.world.id).toBe(originalId)
    expect(useSpatialStore.getState().statusMessage).toContain('schemaVersion=2')
  })

  it('restores a valid draft through the import checks', async () => {
    const world = createEmptyWorld('valid', 'restored', { now: 1 })
    vi.mocked(loadDraft).mockResolvedValue({
      core: { world, runtime: createEmptyRuntime(world.id, 'runtime', 1) },
      currentBoardId: world.rootBoardId,
      savedAt: 1,
    })

    expect(await restoreDraft()).toBe(true)
    expect(useSpatialStore.getState().core.world.id).toBe(world.id)
    expect(useSpatialStore.getState().currentBoardId).toBe(world.rootBoardId)
  })
})

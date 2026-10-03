import { describe, expect, it } from 'vitest'
import { applyCommandBatch, createEmptyRuntime, createWorldWithDefaults, type PlaceNode, type SpatialCoreState, validateAll } from '@qingyu/spatial-core'
import { useSpatialStore } from '../src/store/spatialStore.ts'

function fixture(): SpatialCoreState {
  const world = createWorldWithDefaults('structure_world', '场景', { now: 1 })
  return { world, runtime: createEmptyRuntime(world.id, 'structure_runtime', 1) }
}
function place(core: SpatialCoreState, id: string, parentNodeId: string | null = null): PlaceNode {
  return { id, name: id, kind: 'place', boardId: core.world.rootBoardId, parentNodeId, childBoardId: null,
    description: '', tags: [], geometry: { x: 100, y: 100 }, iconKey: 'pin', createdAt: 1, updatedAt: 1 }
}
function apply(core: SpatialCoreState, commands: Parameters<typeof applyCommandBatch>[1]['commands']) {
  return applyCommandBatch(core, { schemaVersion: 1, expectedRevision: core.runtime.revision, commands }, { now: 2, source: 'user' })
}

describe('地点只能添加一层子结构', () => {
  it('底层指令拒绝给子结构继续添加节点或内部画板', () => {
    const core = fixture()
    core.world.nodes.push(place(core, 'home'), place(core, 'child', 'home'))
    expect(apply(core, [{ type: 'create_node', payload: place(core, 'nested', 'child') }])).toMatchObject({ ok: false, code: 'invalid_parent' })
    expect(apply(core, [{ type: 'update_node', nodeId: 'child', patch: { childBoardId: 'nested_board' } }])).toMatchObject({ ok: false, code: 'invalid_parent' })
  })

  it('已有子结构的地点不能重新挂到另一个地点下', () => {
    const core = fixture()
    core.world.nodes.push(place(core, 'home'), place(core, 'child', 'home'), place(core, 'other'))
    expect(apply(core, [{ type: 'update_node', nodeId: 'home', patch: { parentNodeId: 'other' } }])).toMatchObject({ ok: false, code: 'invalid_parent' })
  })

  it('界面统一添加子结构，子结构不能继续创建', () => {
    const store = useSpatialStore.getState()
    store.newWorld('子结构测试')
    const home = useSpatialStore.getState().createPlaceAt(100, 100, '住所')!
    const first = useSpatialStore.getState().addSubPlace(home)!
    expect(useSpatialStore.getState().core.world.nodes.find(node => node.id === first)).toMatchObject({ name: '子结构 1' })
    expect(useSpatialStore.getState().addSubPlace(first)).toBeNull()
    expect(useSpatialStore.getState().createInternalBoard(first)).toBeNull()
    expect(useSpatialStore.getState().addSubPlace(home)).toBeTruthy()
  })

  it('载入旧数据移除更深层结构、内部画板和关联引用，保留直属子结构及其他数据', () => {
    const core = fixture()
    core.world.nodes.push(place(core, 'home'), place(core, 'floor', 'home'), place(core, 'room', 'floor'), place(core, 'desk', 'room'), place(core, 'other'))
    core.world.nodes.find(node => node.id === 'floor')!.childBoardId = 'floor_inside'
    core.world.boards.push({ ...core.world.boards[0], id: 'floor_inside', name: '旧内部画板', parentEntryNodeId: 'floor' })
    core.world.nodes.push({ ...place(core, 'inside'), boardId: 'floor_inside' })
    core.world.actors.push({ id: 'actor', kind: 'character', displayName: '角色', externalRef: { type: 'standalone', id: 'actor' } })
    core.runtime.placements.push({ actorId: 'actor', boardId: core.world.rootBoardId, anchor: { kind: 'node', nodeId: 'room' }, position: { x: 100, y: 100 }, semanticPosition: { containmentPath: ['home', 'floor', 'room'], precision: 'inside-only' }, revision: 0, updatedAt: 1, updatedBy: 'user' })
    core.world.distances.push({ id: 'distance', kind: 'distance', name: '', description: '', boardId: core.world.rootBoardId, sourceNodeId: 'floor', targetNodeId: 'room', measurement: { value: 1, unit: 'm', displayText: '', certainty: 'exact' }, createdAt: 1, updatedAt: 1 })
    expect(useSpatialStore.getState().importPackage(core)).toEqual({ ok: true })
    const clean = useSpatialStore.getState().core
    expect(clean.world.nodes.map(node => node.id)).toContain('floor')
    expect(clean.world.nodes.map(node => node.id)).toContain('other')
    expect(clean.world.nodes.map(node => node.id)).not.toEqual(expect.arrayContaining(['room', 'desk', 'inside']))
    expect(clean.world.nodes.find(node => node.id === 'floor')!.childBoardId).toBeNull()
    expect(clean.world.boards.map(board => board.id)).not.toContain('floor_inside')
    expect(clean.world.distances).toEqual([])
    expect(clean.runtime.placements).toEqual([])
    expect(clean.world.actors).toHaveLength(1)
    expect(validateAll(clean.world, clean.runtime).filter(issue => issue.severity === 'error')).toEqual([])
  })
})

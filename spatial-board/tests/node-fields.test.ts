import { describe, expect, it } from 'vitest'
import { applyCommandBatch, isPlacementOffstage, OFFSTAGE_REGION_TAG, type SpatialNode } from '@qingyu/spatial-core'
import { useSpatialStore } from '../src/store/spatialStore.ts'

const categories = ['regionCategory', 'placeCategory', 'categoryLabel']
const store = () => useSpatialStore.getState()

describe('移除地点和区域的分类字段', () => {
  it('新区域、地点及子结构都不再存储分类', () => {
    store().newWorld('无分类画板')
    store().createRegionAt(0, 0, 300, 300, '区域')
    const home = store().createPlaceAt(500, 100, '住所')!
    store().addSubPlace(home)
    for (const node of store().core.world.nodes) {
      for (const key of categories) expect(node).not.toHaveProperty(key)
    }
  })

  it('旧画板导入后清理分类，位置、名称、描述、层级和系统标签保持有效', () => {
    store().newWorld('旧画板')
    const offstage = store().core.world.nodes.find(node => node.tags.includes(OFFSTAGE_REGION_TAG))!
    const actor = store().createActor('角色', 'character')!
    store().placeActorAt(actor, offstage.boardId, offstage.geometry.x, offstage.geometry.y, { kind: 'node', nodeId: offstage.id })
    const old = structuredClone(store().core)
    const baseline = structuredClone(old.runtime)
    const legacy = { ...old, world: { ...old.world, nodes: old.world.nodes.map(node => ({ ...node, regionCategory: 'custom', categoryLabel: '对话状态' })) } }
    expect(store().importPackage(legacy)).toEqual({ ok: true })
    const clean = store().core
    expect(clean.runtime).toEqual(baseline)
    const node = clean.world.nodes.find(node => node.id === offstage.id)!
    for (const key of categories) expect(node).not.toHaveProperty(key)
    expect(node.name).toBe(offstage.name)
    expect(node.description).toBe(offstage.description)
    expect(node.parentNodeId).toBe(offstage.parentNodeId)
    expect(isPlacementOffstage(clean.world, clean.runtime.placements[0]!)).toBe(true)
    expect(JSON.stringify(store().exportPackage().world)).not.toContain('categoryLabel')
  })

  it('旧客户端创建载荷中的分类字段不会重新写回画板', () => {
    store().newWorld('兼容旧创建载荷')
    const core = store().core
    const payload = { id: 'legacy_place', boardId: core.world.rootBoardId, kind: 'place', name: '住所', description: '', tags: [], parentNodeId: null,
      childBoardId: null, geometry: { x: 0, y: 0 }, iconKey: 'pin', createdAt: 1, updatedAt: 1, placeCategory: 'building', categoryLabel: '建筑' } as SpatialNode
    const result = applyCommandBatch(core, { schemaVersion: 1, expectedRevision: core.runtime.revision, commands: [{ type: 'create_node', payload }] }, { now: 2, source: 'user' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    const node = result.state.world.nodes.find(node => node.id === payload.id)!
    for (const key of categories) expect(node).not.toHaveProperty(key)
  })
})

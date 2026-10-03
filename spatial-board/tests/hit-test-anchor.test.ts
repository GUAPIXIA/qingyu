import { describe, expect, it } from 'vitest'
import type { SpatialNode } from '@qingyu/spatial-core'
import { hitTestAnchor } from '../src/canvas/hitTestAnchor.ts'

const base = {
  boardId: 'board',
  description: '',
  tags: [],
  childBoardId: null,
  createdAt: 0,
  updatedAt: 0,
}

function place(id: string, parentNodeId: string | null, x: number, y: number): SpatialNode {
  return {
    ...base, id, name: id, kind: 'place', parentNodeId,
    geometry: { x, y }, iconKey: 'building',
  }
}

function region(id: string, parentNodeId: string | null, x: number, y: number, size: number): SpatialNode {
  return {
    ...base, id, name: id, kind: 'region', parentNodeId,
    geometry: { x, y, width: size, height: size }, 
  }
}

describe('actor anchor hit test', () => {
  it('prefers the deeper place in overlapping hit areas regardless of array order', () => {
    const nodes = [place('building', null, 100, 100), place('room', 'building', 110, 110)]
    const result = hitTestAnchor(nodes, [], 'board', 110, 110)
    expect(result.anchor).toEqual({ kind: 'node', nodeId: 'room' })
  })

  it('prefers the nearest place when peer hit areas overlap', () => {
    const nodes = [place('left', null, 100, 100), place('right', null, 140, 100)]
    const result = hitTestAnchor(nodes, [], 'board', 142, 110)
    expect(result.anchor).toEqual({ kind: 'node', nodeId: 'right' })
  })

  it('prefers a visible parent hit over a child padding-only hit', () => {
    const nodes = [place('parent', null, 100, 100), place('child', 'parent', 190, 100)]
    const result = hitTestAnchor(nodes, [], 'board', 154, 116)
    expect(result.anchor).toEqual({ kind: 'node', nodeId: 'parent' })
  })

  it('uses the deepest region below the actor center', () => {
    const nodes = [region('outer', null, 0, 0, 300), region('inner', 'outer', 90, 90, 90)]
    const result = hitTestAnchor(nodes, [], 'board', 110, 110)
    expect(result.anchor).toEqual({ kind: 'node', nodeId: 'inner' })
  })
})

import { describe, expect, it } from 'vitest'
import { useSpatialStore } from '../src/store/spatialStore.ts'
import { OFFSTAGE_REGION_TAG, projectCompactText } from '@qingyu/spatial-core'
import {
  BOARD_WIDTH,
  BOARD_HEIGHT,
  DOCKED_ACTOR_SIZE,
  PLACE_NODE_EXPANDED_WIDTH,
  PLACE_NODE_SIZE,
  actorPlacementsToFlow,
  applyNodeDragPreview,
  collectNodeDragContents,
  domainNodesToFlow,
} from '../src/canvas/adapter.ts'

describe('移动区域带动内部内容', () => {
  it('新世界包含未参与对话区域，区内角色保留自由坐标', () => {
    useSpatialStore.getState().newWorld('对话状态世界')
    const s = () => useSpatialStore.getState()
    const offstage = s().core.world.nodes.find(
      (node) => node.kind === 'region' && node.tags.includes(OFFSTAGE_REGION_TAG)
    )
    expect(offstage?.name).toBe('未参与对话')
    expect(offstage?.boardId).toBe(s().core.world.rootBoardId)

    const actorId = s().createActor('场外角色', 'character')!
    s().placeActorAt(actorId, s().currentBoardId, -350, 120, {
      kind: 'node',
      nodeId: offstage!.id,
    })
    const projected = actorPlacementsToFlow(
      s().core.runtime.placements,
      s().core.world.actors,
      s().core.world.nodes,
      s().currentBoardId
    ).find((node) => node.id === `actor_${actorId}`)

    expect(projected?.data.displayMode).toBe('floating')
    expect(projected?.position).toEqual({ x: -350, y: 120 })
    expect(projected?.data.offstage).toBe(true)
    expect(projectCompactText(s().core.world, s().core.runtime, { full: true })).toContain(
      '参与对话=否'
    )
  })

  it('地点角色聚合停靠，区域角色保留自由位置', () => {
    useSpatialStore.getState().newWorld('角色停靠世界')
    const s = () => useSpatialStore.getState()
    const boardId = s().currentBoardId
    const region = s().createRegionAt(100, 100, 360, 260, '区域')!
    const place = s().createPlaceAt(180, 180, '地点')!

    for (let i = 1; i <= 5; i += 1) {
      const actorId = s().createActor(`地点角色${i}`, 'character')!
      s().placeActorAt(actorId, boardId, 190 + i, 190 + i, {
        kind: 'node',
        nodeId: place,
      })
    }
    const regionActor = s().createActor('区域角色', 'character')!
    s().placeActorAt(regionActor, boardId, 260, 130, {
      kind: 'node',
      nodeId: region,
    })
    const freeActor = s().createActor('自由角色', 'character')!
    s().placeActorAt(freeActor, boardId, 620, 420, { kind: 'board' })

    const projected = actorPlacementsToFlow(
      s().core.runtime.placements,
      s().core.world.actors,
      s().core.world.nodes,
      boardId
    )
    const projectedPlace = domainNodesToFlow(
      s().core.world.nodes,
      s().core.runtime.placements,
      boardId
    ).find((node) => node.id === place)
    const collapsedPlace = domainNodesToFlow(
      s().core.world.nodes,
      s().core.runtime.placements.filter(
        (placement) => placement.anchor.nodeId !== place
      ),
      boardId
    ).find((node) => node.id === place)
    const placeActors = projected.filter(
      (node) => node.data.kind === 'actor' && node.data.dockKind === 'place'
    )
    const regionActors = projected.filter(
      (node) => node.data.kind === 'actor' && node.data.dockKind === 'region'
    )
    const free = projected.find((node) => node.id === `actor_${freeActor}`)

    expect(placeActors).toHaveLength(3)
    expect(new Set(placeActors.map((node) => node.position.y)).size).toBe(3)
    expect(placeActors[2]?.data.overflowCount).toBe(2)
    expect(projectedPlace?.style?.width).toBe(PLACE_NODE_EXPANDED_WIDTH)
    expect(collapsedPlace?.style?.width).toBe(PLACE_NODE_SIZE)
    for (const node of placeActors) {
      expect(node.position.x).toBeGreaterThanOrEqual(180 + PLACE_NODE_SIZE)
      expect(node.position.x + DOCKED_ACTOR_SIZE).toBeLessThanOrEqual(
        180 + PLACE_NODE_EXPANDED_WIDTH
      )
      expect(node.position.y).toBeGreaterThanOrEqual(180)
      expect(node.position.y + DOCKED_ACTOR_SIZE).toBeLessThanOrEqual(
        180 + PLACE_NODE_SIZE
      )
    }
    expect(regionActors).toHaveLength(1)
    expect(regionActors[0]?.data.displayMode).toBe('floating')
    expect(regionActors[0]?.position).toEqual({ x: 260, y: 130 })
    expect(free?.position).toEqual({ x: 620, y: 420 })
    expect(free?.data.displayMode).toBe('free')
  })

  it('拖动过程中按起点位移实时预览内部地点与用户', () => {
    useSpatialStore.getState().newWorld('实时跟随世界')
    const s = () => useSpatialStore.getState()

    const region = s().createRegionAt(100, 100, 300, 240, '区域')!
    const place = s().createPlaceAt(160, 150, '内部地点')!
    const outside = s().createPlaceAt(520, 420, '外部地点')!
    const actorId = s().createActor('用户', 'persona')!
    s().placeActorAt(actorId, s().currentBoardId, 190, 180, {
      kind: 'node',
      nodeId: place,
    })

    const contents = collectNodeDragContents(
      s().core.world.nodes,
      s().core.runtime.placements,
      s().currentBoardId,
      region
    )
    const flowNodes = [
      ...domainNodesToFlow(
        s().core.world.nodes,
        s().core.runtime.placements,
        s().currentBoardId
      ),
      ...actorPlacementsToFlow(
        s().core.runtime.placements,
        s().core.world.actors,
        s().core.world.nodes,
        s().currentBoardId
      ),
    ]
    const origins = new Map(
      flowNodes.map((node) => [node.id, { ...node.position }])
    )
    const preview = applyNodeDragPreview(
      flowNodes,
      region,
      new Set([
        ...contents.nodeIds,
        ...contents.actorIds.map((id) => `actor_${id}`),
      ]),
      origins,
      { x: 220, y: 180 }
    )

    expect(preview.find((node) => node.id === region)?.position).toEqual({
      x: 220,
      y: 180,
    })
    expect(preview.find((node) => node.id === place)?.position).toEqual({
      x: 280,
      y: 230,
    })
    expect(preview.find((node) => node.id === `actor_${actorId}`)?.position).toEqual({
      x: 368,
      y: 235,
    })
    expect(preview.find((node) => node.id === outside)?.position).toEqual({
      x: 520,
      y: 420,
    })
  })

  it('移动地点时实时预览并提交其中角色的相同位移', () => {
    useSpatialStore.getState().newWorld('地点实时跟随世界')
    const s = () => useSpatialStore.getState()
    const boardId = s().currentBoardId
    const place = s().createPlaceAt(200, 100, '地点')!
    const actorId = s().createActor('地点角色', 'character')!
    const outsideActorId = s().createActor('外部角色', 'character')!
    s().placeActorAt(actorId, boardId, 220, 120, {
      kind: 'node',
      nodeId: place,
    })
    s().placeActorAt(outsideActorId, boardId, 620, 420, { kind: 'board' })

    const contents = collectNodeDragContents(
      s().core.world.nodes,
      s().core.runtime.placements,
      boardId,
      place
    )
    const flowNodes = [
      ...domainNodesToFlow(
        s().core.world.nodes,
        s().core.runtime.placements,
        boardId
      ),
      ...actorPlacementsToFlow(
        s().core.runtime.placements,
        s().core.world.actors,
        s().core.world.nodes,
        boardId
      ),
    ]
    const origins = new Map(
      flowNodes.map((node) => [node.id, { ...node.position }])
    )
    const preview = applyNodeDragPreview(
      flowNodes,
      place,
      new Set(contents.actorIds.map((id) => `actor_${id}`)),
      origins,
      { x: 350, y: 220 }
    )

    expect(contents).toEqual({ nodeIds: [], actorIds: [actorId] })
    expect(preview.find((node) => node.id === place)?.position).toEqual({
      x: 350,
      y: 220,
    })
    expect(preview.find((node) => node.id === `actor_${actorId}`)?.position).toEqual({
      x: 438,
      y: 225,
    })
    expect(
      preview.find((node) => node.id === `actor_${outsideActorId}`)?.position
    ).toEqual({ x: 620, y: 420 })

    s().moveNode(place, 350, 220)
    expect(
      s().core.runtime.placements.find((item) => item.actorId === actorId)?.position
    ).toEqual({ x: 370, y: 240 })
    s().undo()
    expect(
      s().core.runtime.placements.find((item) => item.actorId === actorId)?.position
    ).toEqual({ x: 220, y: 120 })
  })

  it('子节点与区内角色跟随区域位移', () => {
    useSpatialStore.getState().newWorld('拖动世界')
    const s = () => useSpatialStore.getState()

    const region = s().createRegionAt(
      0.1 * BOARD_WIDTH,
      0.2 * BOARD_HEIGHT,
      0.4 * BOARD_WIDTH,
      0.4 * BOARD_HEIGHT,
      '区域'
    )!
    const place = s().createPlaceAt(
      0.2 * BOARD_WIDTH,
      0.3 * BOARD_HEIGHT,
      '地点'
    )!
    const actorId = s().createActor('用户', 'persona')!
    s().placeActorAt(actorId, s().currentBoardId, 0.25 * BOARD_WIDTH, 0.35 * BOARD_HEIGHT, {
      kind: 'node',
      nodeId: place,
    })

    const beforePlace = s().core.world.nodes.find((n) => n.id === place)!
    const beforeActor = s().core.runtime.placements.find(
      (p) => p.actorId === actorId
    )!

    const dx = 0.15 * BOARD_WIDTH
    const dy = 0.1 * BOARD_HEIGHT
    const r = s().core.world.nodes.find((n) => n.id === region)!
    s().moveNode(
      region,
      r.geometry.x + dx,
      r.geometry.y + dy
    )

    const afterPlace = s().core.world.nodes.find((n) => n.id === place)!
    const afterActor = s().core.runtime.placements.find(
      (p) => p.actorId === actorId
    )!

    expect(afterPlace.geometry.x).toBeCloseTo(beforePlace.geometry.x + dx, 3)
    expect(afterPlace.geometry.y).toBeCloseTo(beforePlace.geometry.y + dy, 3)
    expect(afterActor.position.x).toBeCloseTo(
      beforeActor.position.x + dx,
      3
    )
    expect(afterActor.position.y).toBeCloseTo(
      beforeActor.position.y + dy,
      3
    )

    // 一次撤销应整体回退
    s().undo()
    const undonePlace = s().core.world.nodes.find((n) => n.id === place)!
    expect(undonePlace.geometry.x).toBeCloseTo(beforePlace.geometry.x, 3)
  })

  it('父区域向上经过子区域旧位置时不会把子区域误判为父节点', () => {
    useSpatialStore.getState().newWorld('向上拖动世界')
    const s = () => useSpatialStore.getState()

    const parent = s().createRegionAt(
      0.1 * BOARD_WIDTH,
      0.3 * BOARD_HEIGHT,
      0.6 * BOARD_WIDTH,
      0.6 * BOARD_HEIGHT,
      '父区域'
    )!
    const child = s().createRegionAt(
      0.3 * BOARD_WIDTH,
      0.35 * BOARD_HEIGHT,
      0.2 * BOARD_WIDTH,
      0.2 * BOARD_HEIGHT,
      '子区域'
    )!
    s().updateNode(child, { parentNodeId: parent })
    const place = s().createPlaceAt(
      0.35 * BOARD_WIDTH,
      0.4 * BOARD_HEIGHT,
      '地点'
    )!
    const actorId = s().createActor('用户', 'persona')!
    s().placeActorAt(
      actorId,
      s().currentBoardId,
      0.38 * BOARD_WIDTH,
      0.43 * BOARD_HEIGHT,
      { kind: 'node', nodeId: place }
    )

    const beforePlace = s().core.world.nodes.find((n) => n.id === place)!
    const beforeActor = s().core.runtime.placements.find(
      (p) => p.actorId === actorId
    )!
    const dy = -0.25 * BOARD_HEIGHT

    s().moveNode(parent, 0.1 * BOARD_WIDTH, 0.05 * BOARD_HEIGHT)

    const afterParent = s().core.world.nodes.find((n) => n.id === parent)!
    const afterChild = s().core.world.nodes.find((n) => n.id === child)!
    const afterPlace = s().core.world.nodes.find((n) => n.id === place)!
    const afterActor = s().core.runtime.placements.find(
      (p) => p.actorId === actorId
    )!

    expect(afterParent.geometry.y).toBeCloseTo(0.05 * BOARD_HEIGHT, 3)
    expect(afterParent.parentNodeId).toBeNull()
    expect(afterChild.parentNodeId).toBe(parent)
    expect(afterPlace.geometry.y).toBeCloseTo(beforePlace.geometry.y + dy, 3)
    expect(afterActor.position.y).toBeCloseTo(beforeActor.position.y + dy, 3)
    expect(s().statusMessage).not.toContain('cycle_detected')
  })

  it('允许区域、地点和用户跨越初始参考视区并完整导入导出', () => {
    useSpatialStore.getState().newWorld('无限画布世界')
    const s = () => useSpatialStore.getState()

    const region = s().createRegionAt(100, 100, 300, 200, '区域')!
    const place = s().createPlaceAt(160, 150, '地点')!
    const actorId = s().createActor('用户', 'persona')!
    s().placeActorAt(actorId, s().currentBoardId, 190, 180, {
      kind: 'node',
      nodeId: place,
    })

    s().moveNode(region, -400, -300)
    expect(s().core.world.nodes.find((n) => n.id === region)?.geometry).toMatchObject({
      x: -400,
      y: -300,
      width: 300,
      height: 200,
    })
    expect(s().core.world.nodes.find((n) => n.id === place)?.geometry).toMatchObject({
      x: -340,
      y: -250,
    })
    expect(s().core.runtime.placements.find((p) => p.actorId === actorId)?.position).toEqual({
      x: -310,
      y: -220,
    })

    s().moveNode(region, 2400, 1600)
    expect(s().core.world.nodes.find((n) => n.id === region)?.geometry).toMatchObject({
      x: 2400,
      y: 1600,
    })

    const pkg = s().exportPackage()
    s().newWorld('空世界')
    expect(s().importPackage(pkg).ok).toBe(true)
    expect(s().core.world.nodes.find((n) => n.id === region)?.geometry).toMatchObject({
      x: 2400,
      y: 1600,
      width: 300,
      height: 200,
    })
    expect(s().core.runtime.placements.find((p) => p.actorId === actorId)?.position).toEqual({
      x: 2490,
      y: 1680,
    })
  })
})

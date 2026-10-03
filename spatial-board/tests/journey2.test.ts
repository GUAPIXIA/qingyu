/**
 * 关键旅程 2：在 XX 市创建用户家 → 创建内部画板 → 添加 1 楼/2 楼/卧室 → 将用户头像拖入卧室。
 * 同时验证：无图片时文本投影仍完整。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useSpatialStore } from '../src/store/spatialStore.ts'
import {
  projectCompactText,
  summarizeActorsOnAncestors,
  validateAll,
  hasErrors,
} from '@qingyu/spatial-core'
import { BOARD_WIDTH, BOARD_HEIGHT } from '../src/canvas/adapter.ts'

function reset() {
  useSpatialStore.getState().newWorld('旅程2世界')
}

describe('关键旅程 2', () => {
  beforeEach(reset)

  it('XX 市 → 用户家 → 内部画板 → 楼层/卧室 → 用户入卧室', () => {
    const s = () => useSpatialStore.getState()

    // XX 市
    const cityX = s().createRegionAt(
      0.1 * BOARD_WIDTH,
      0.15 * BOARD_HEIGHT,
      0.45 * BOARD_WIDTH,
      0.6 * BOARD_HEIGHT,
      'XX 市'
    )
    expect(cityX).toBeTruthy()

    // 用户家（落入城市内）
    const home = s().createPlaceAt(0.25 * BOARD_WIDTH, 0.35 * BOARD_HEIGHT, '用户家')
    expect(home).toBeTruthy()
    expect(s().core.world.nodes.find((n) => n.id === home)?.parentNodeId).toBe(cityX)

    // 创建内部画板并进入
    const boardHome = s().createInternalBoard(home!)
    expect(boardHome).toBeTruthy()
    expect(s().currentBoardId).toBe(boardHome)
    expect(s().core.world.boards.some((b) => b.id === boardHome)).toBe(true)
    expect(s().core.world.boards.find((b) => b.id === boardHome)?.parentEntryNodeId).toBe(home)

    // 1 楼 / 2 楼
    const floor1 = s().createRegionAt(
      0.08 * BOARD_WIDTH,
      0.12 * BOARD_HEIGHT,
      0.4 * BOARD_WIDTH,
      0.7 * BOARD_HEIGHT,
      '1 楼'
    )
    const floor2 = s().createRegionAt(
      0.55 * BOARD_WIDTH,
      0.12 * BOARD_HEIGHT,
      0.35 * BOARD_WIDTH,
      0.7 * BOARD_HEIGHT,
      '2 楼'
    )
    expect(floor1).toBeTruthy()
    expect(floor2).toBeTruthy()

    // 卧室在 1 楼内
    const bedroom = s().createPlaceAt(0.2 * BOARD_WIDTH, 0.3 * BOARD_HEIGHT, '卧室')
    expect(bedroom).toBeTruthy()
    expect(s().core.world.nodes.find((n) => n.id === bedroom)?.parentNodeId).toBe(floor1)

    // 添加用户并拖入卧室
    const userId = s().createActor('用户', 'persona')
    expect(userId).toBeTruthy()
    s().placeActorAt(
      userId!,
      boardHome!,
      0.2 * BOARD_WIDTH,
      0.3 * BOARD_HEIGHT,
      { kind: 'node', nodeId: bedroom! },
      { precision: 'inside-only', relativeDirection: 'inside', note: '用户位于卧室' }
    )

    const placement = s().core.runtime.placements.find((p) => p.actorId === userId)
    expect(placement).toBeTruthy()
    expect(placement!.anchor).toMatchObject({ kind: 'node', nodeId: bedroom })
    expect(placement!.semanticPosition.precision).toBe('inside-only')
    // 跨画板包含路径
    expect(placement!.semanticPosition.containmentPath).toEqual([
      cityX,
      home,
      floor1,
      bedroom,
    ])

    // 祖先投影：用户家与卧室上有角色
    const summary = summarizeActorsOnAncestors(s().core.world, s().core.runtime)
    const homeSummary = summary.find((x) => x.nodeId === home)
    expect(homeSummary?.actorIds).toContain(userId)
    const bedroomSummary = summary.find((x) => x.nodeId === bedroom)
    expect(bedroomSummary?.actorIds).toContain(userId)

    // 校验通过
    expect(hasErrors(validateAll(s().core.world, s().core.runtime))).toBe(false)

    // 无图片时文本投影仍完整（不依赖 avatarAssetRef）
    const text = projectCompactText(s().core.world, s().core.runtime, {
      focusNodeId: bedroom!,
    })
    expect(text).toContain('[空间状态 v1]')
    expect(text).toContain('用户家')
    expect(text).toContain('卧室')
    expect(text).toContain('用户 [')
    expect(text).toContain('精度=inside-only')
    // 不依赖任何图片字段
    expect(text).not.toContain('avatar')
  })

  it('面包屑可回退到上级画板', () => {
    const s = () => useSpatialStore.getState()
    const home = s().createPlaceAt(100, 100, '用户家')
    const boardId = s().createInternalBoard(home!)
    expect(s().currentBoardId).toBe(boardId)
    const crumbs = s().breadcrumb()
    expect(crumbs.length).toBeGreaterThanOrEqual(2)
    expect(crumbs[0].id).toBe(s().core.world.rootBoardId)
    s().goRootBoard()
    expect(s().currentBoardId).toBe(s().core.world.rootBoardId)
  })

  it('地点加号直接添加一层子结构，可自定义名称，无需内部画板', () => {
    const s = () => useSpatialStore.getState()
    const home = s().createPlaceAt(100, 100, '用户家')
    expect(home).toBeTruthy()

    const floor = s().addSubPlace(home!, '1 楼')
    const room = s().addSubPlace(home!, '卧室')
    expect(floor).toBeTruthy()
    expect(room).toBeTruthy()

    const homeNode = s().core.world.nodes.find((n) => n.id === home)
    const floorNode = s().core.world.nodes.find((n) => n.id === floor)
    const roomNode = s().core.world.nodes.find((n) => n.id === room)

    // 同画板子地点，不创建内部画板
    expect(homeNode?.childBoardId).toBeNull()
    expect(floorNode?.parentNodeId).toBe(home)
    expect(roomNode?.parentNodeId).toBe(home)
    expect(floorNode?.boardId).toBe(homeNode?.boardId)
    expect(floorNode?.name).toBe('1 楼')
    expect(roomNode?.name).toBe('卧室')

    // 包含路径可追溯
    const userId = s().createActor('用户', 'persona')
    s().placeActorAt(userId!, s().currentBoardId, roomNode!.geometry.x, roomNode!.geometry.y, {
      kind: 'node',
      nodeId: room!,
    })
    const placement = s().core.runtime.placements.find((p) => p.actorId === userId)
    expect(placement?.semanticPosition.containmentPath).toEqual([home, room])

    expect(hasErrors(validateAll(s().core.world, s().core.runtime))).toBe(false)
  })

  it('角色拖动后可撤销', () => {
    const s = () => useSpatialStore.getState()
    const a = s().createPlaceAt(80, 80, 'A')
    const b = s().createPlaceAt(400, 400, 'B')
    const userId = s().createActor('用户', 'persona')
    s().placeActorAt(userId!, s().currentBoardId, 80, 80, {
      kind: 'node',
      nodeId: a!,
    })
    s().moveActorTo(userId!, s().currentBoardId, 400, 400, {
      kind: 'node',
      nodeId: b!,
    })
    expect(
      s().core.runtime.placements[0]?.anchor
    ).toMatchObject({ nodeId: b })
    s().undo()
    expect(
      s().core.runtime.placements[0]?.anchor
    ).toMatchObject({ nodeId: a })
  })

  it('JSON 导出导入保留角色与位置', () => {
    const s = () => useSpatialStore.getState()
    const home = s().createPlaceAt(120, 120, '用户家')
    const boardHome = s().createInternalBoard(home!)
    const bedroom = s().createPlaceAt(200, 200, '卧室')
    const userId = s().createActor('用户', 'persona')
    s().placeActorAt(
      userId!,
      boardHome!,
      200,
      200,
      { kind: 'node', nodeId: bedroom! },
      { precision: 'inside-only', note: '卧室' }
    )

    const pkg = s().exportPackage()
    s().newWorld('空')
    const result = s().importPackage({
      world: pkg.world,
      runtime: pkg.runtime,
    })
    expect(result.ok).toBe(true)
    expect(s().core.world.actors.map((a) => a.displayName)).toContain('用户')
    expect(s().core.runtime.placements).toHaveLength(1)
    expect(s().core.runtime.placements[0].semanticPosition.note).toBe('卧室')
  })
})

/**
 * 可指令化门禁：
 * 1) 指令联合体 ↔ JSON Schema 必须一一对应（漏一种就红）；
 * 2) 每种指令都能通过公开入口 applyCommands 执行成功、推进 revision、写事件；
 * 3) 界面上所有会改数据的操作都必须走指令（revision 必须前进）。
 *
 * 新增一种指令时，ALL_TYPES / SAMPLES 的键不全会在编译期直接报错。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import type { SpatialCommand } from '@qingyu/spatial-core'
import {
  OFFSTAGE_REGION_NAME,
  OFFSTAGE_REGION_SIZE,
  OFFSTAGE_REGION_TAG,
  isPlacementOffstage,
} from '@qingyu/spatial-core'
import {
  PLACE_CHIP_HEIGHT,
  PLACE_NODE_SIZE,
  PLACE_CHIP_WIDTH,
  chipDockOffset,
  distanceHandlePair,
  dockedActorCountAt,
  domainNodesToFlow,
  placeChipWidth,
  placeSizeByCount,
} from '../src/canvas/adapter.ts'
import { useSpatialStore } from '../src/store/spatialStore.ts'
import { MIN_REGION_SIZE } from '../src/store/spatialStoreHelpers.ts'

const s = () => useSpatialStore.getState()

const schemaPath = fileURLToPath(
  new URL('../schemas/spatial-command-v1.schema.json', import.meta.url)
)
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
  $defs: {
    command: { oneOf: Array<{ $ref: string }> }
    [key: string]: unknown
  }
}
const schemaDef = schema.$defs as Record<
  string,
  { properties?: { type?: { const?: string } } }
>
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)

/** 指令类型全集：少写一种会在这里编译失败 */
const ALL_TYPES: Record<SpatialCommand['type'], true> = {
  update_world: true,
  create_node: true,
  update_node: true,
  delete_node: true,
  create_distance: true,
  update_distance: true,
  delete_distance: true,
  create_actor: true,
  update_actor: true,
  delete_actor: true,
  place_actor: true,
  move_actor: true,
  remove_actor_from_board: true,
}
const TYPES = Object.keys(ALL_TYPES).sort() as Array<SpatialCommand['type']>

interface Fixtures {
  boardId: string
  placeId: string
  sparePlaceId: string
  sparePlaceId2: string
  actorId: string
  distanceId: string
}

/** 每个用例一套最小世界，保证指令目标合法 */
function buildFixtures(): Fixtures {
  s().newWorld('门禁世界')
  const boardId = s().currentBoardId
  s().createRegionAt(0, 0, 200, 200, '区域')
  const placeId = s().createPlaceAt(300, 0, '地点')!
  const sparePlaceId = s().createPlaceAt(500, 0, '备用地')!
  const sparePlaceId2 = s().createPlaceAt(700, 0, '备用地2')!
  const actorId = s().createActor('角色', 'character')!
  // 角色先落在画板上，place/move/remove 才有合法目标
  s().placeActorAt(actorId, boardId, 310, 10, {
    kind: 'node',
    nodeId: placeId,
  })
  const distanceId = s().createDistanceBetween(placeId, sparePlaceId)!
  return { boardId, placeId, sparePlaceId, sparePlaceId2, actorId, distanceId }
}

function nodeOf(id: string) {
  return s().core.world.nodes.find((n) => n.id === id)!
}

/** 每种指令的最小合法样例：键必须齐全 */
const SAMPLES: Record<
  SpatialCommand['type'],
  (f: Fixtures) => SpatialCommand
> = {
  update_world: () => ({
    type: 'update_world',
    patch: { name: '改名后的世界', description: '门禁用例' },
  }),
  create_node: (f) => ({
    type: 'create_node',
    payload: { ...structuredClone(nodeOf(f.placeId)), id: 'cli_node_new' },
  }),
  update_node: (f) => ({
    type: 'update_node',
    nodeId: f.placeId,
    patch: { description: '门禁用例' },
  }),
  delete_node: (f) => ({
    type: 'delete_node',
    nodeId: f.sparePlaceId2,
    strategy: 'reject-if-not-empty',
  }),
  create_distance: (f) => ({
    type: 'create_distance',
    payload: {
      ...structuredClone(
        s().core.world.distances.find((d) => d.id === f.distanceId)!
      ),
      id: 'cli_distance_new',
      sourceNodeId: f.sparePlaceId,
      targetNodeId: f.sparePlaceId2,
    },
  }),
  update_distance: (f) => ({
    type: 'update_distance',
    relationId: f.distanceId,
    patch: { name: '改过的距离' },
  }),
  delete_distance: (f) => ({
    type: 'delete_distance',
    relationId: f.distanceId,
  }),
  create_actor: () => ({
    type: 'create_actor',
    payload: {
      ...structuredClone(s().core.world.actors[0]),
      id: 'cli_actor_new',
      displayName: '新增角色',
    },
  }),
  update_actor: (f) => ({
    type: 'update_actor',
    actorId: f.actorId,
    patch: { displayName: '改名角色' },
  }),
  delete_actor: (f) => ({
    type: 'delete_actor',
    actorId: f.actorId,
  }),
  place_actor: (f) => ({
    type: 'place_actor',
    actorId: f.actorId,
    placement: {
      boardId: f.boardId,
      anchor: { kind: 'node', nodeId: f.placeId },
      position: { x: 310, y: 10 },
    },
  }),
  move_actor: (f) => ({
    type: 'move_actor',
    actorId: f.actorId,
    to: {
      boardId: f.boardId,
      anchor: { kind: 'board' },
      position: { x: 20, y: 20 },
    },
  }),
  remove_actor_from_board: (f) => ({
    type: 'remove_actor_from_board',
    actorId: f.actorId,
  }),
}

describe('可指令化门禁', () => {
  it('JSON Schema 覆盖全部指令类型', () => {
    const schemaTypes = schema.$defs.command.oneOf
      .map((ref) => String(ref.$ref).split('/').pop() as string)
      .map((name) => schemaDef[name]?.properties?.type?.const)
      .sort()
    expect(schemaTypes).toEqual(TYPES)
  })

  it('每种指令的样例都符合 JSON Schema', () => {
    const f = buildFixtures()
    for (const type of TYPES) {
      const command = SAMPLES[type](f)
      const ok = validate({
        schemaVersion: 1,
        expectedRevision: 0,
        commands: [command],
      })
      expect(ok, `${type} 不符合 schema：${JSON.stringify(validate.errors)}`).toBe(
        true
      )
    }
  })

  it('每种指令都能通过 applyCommands 执行、推进 revision 并写事件', () => {
    for (const type of TYPES) {
      const f = buildFixtures()
      const command = SAMPLES[type](f)
      const before = s().core.runtime.revision
      const result = s().applyCommands([command], `gate:${type}`)
      expect(
        result.ok,
        `${type} 执行失败：${result.ok ? '' : result.message}`
      ).toBe(true)
      expect(s().core.runtime.revision, `${type} 未推进 revision`).toBeGreaterThan(
        before
      )
      const events = s().core.runtime.events
      expect(
        events[events.length - 1]?.commandType,
        `${type} 未写入事件`
      ).toBe(type)
    }
  })

  it('界面上的数据变更都必须走指令', () => {
    const f = buildFixtures()
    const bump = (name: string, run: () => void) => {
      const before = s().core.runtime.revision
      run()
      expect(s().core.runtime.revision, `${name} 没有走指令`).toBeGreaterThan(
        before
      )
    }

    bump('世界改名', () => s().setWorldName('界面改名'))
    let resizedRegionId = ''
    bump('创建区域', () => {
      resizedRegionId = s().createRegionAt(0, 300, 120, 120, '区域2')!
    })
    bump('拖动区域右下角调整大小', () =>
      s().moveNode(resizedRegionId, 0, 300, 360, 240)
    )
    bump('工具栏添加未参与对话区域', () => {
      s().createOffstageRegionAt(0, 520)
    })
    bump('创建地点', () => {
      s().createPlaceAt(600, 0, '地点2')
    })
    bump('添加子结构', () => {
      s().addSubPlace(f.placeId)
    })
    bump('切换为右侧纵向排列', () =>
      s().updateNode(f.placeId, { childLayout: 'column-right' })
    )
    bump('更新节点属性', () => s().updateNode(f.placeId, { description: 'x' }))
    bump('移动节点', () => s().moveNode(f.placeId, 320, 20))
    bump('创建内部画板', () => {
      s().createInternalBoard(f.placeId)
    })
    bump('更新距离', () => s().updateDistance(f.distanceId, { name: '改过的距离' }))
    bump('创建角色', () => {
      s().createActor('角色2', 'character')
    })
    bump('更新角色', () => s().updateActor(f.actorId, { displayName: '改名角色' }))
    bump('放置角色', () =>
      s().placeActorAt(f.actorId, f.boardId, 310, 10, {
        kind: 'node',
        nodeId: f.placeId,
      })
    )
    bump('移动角色', () =>
      s().moveActorTo(f.actorId, f.boardId, 20, 20, { kind: 'board' })
    )
    bump('移出画板', () => s().removeActorFromBoard(f.actorId))
    bump('删除距离', () => s().deleteDistance(f.distanceId))
    bump('删除节点', () => s().deleteNode(f.sparePlaceId, false))
    bump('删除角色', () => s().deleteActor(f.actorId))
  })

  it('世界改名可撤销', () => {
    buildFixtures()
    const before = s().core.world.name
    s().setWorldName('改名后的世界')
    expect(s().core.world.name).toBe('改名后的世界')
    s().undo()
    expect(s().core.world.name).toBe(before)
  })

  it('子结构自动纵向排布走指令（错位后重排会写回 update_node）', () => {
    const f = buildFixtures()
    const floor1 = s().addSubPlace(f.placeId)!
    const floor2 = s().addSubPlace(f.placeId)!
    // 直接改状态，模拟一份未对齐的旧草稿
    const core = s().core
    const brokenWorld = structuredClone(core.world)
    brokenWorld.nodes.find((n) => n.id === floor2)!.geometry.x += 30
    useSpatialStore.setState({ core: { ...core, world: brokenWorld } })
    const before = s().core.runtime.revision
    s().normalizeRows()
    expect(s().core.runtime.revision).toBeGreaterThan(before)
    expect(nodeOf(floor2).geometry.x).toBe(nodeOf(floor1).geometry.x)
    expect(nodeOf(floor2).geometry.y).toBeGreaterThan(nodeOf(floor1).geometry.y)
  })

  it('子结构修改名称和描述后仍不允许创建后代', () => {
    const f = buildFixtures()
    const child = s().addSubPlace(f.placeId)!
    const before = s().core.runtime.revision
    s().updateNode(child, { name: '1 楼' })
    expect(s().core.runtime.revision).toBeGreaterThan(before)
    expect(s().addSubPlace(child)).toBeNull()
    s().updateNode(child, { description: '房间' })
    expect(s().addSubPlace(child)).toBeNull()
    expect(s().core.world.nodes.filter(n => n.parentNodeId === child)).toEqual([])
  })

  it('工具栏「未参与对话」直接添加：默认尺寸 + 系统标签 + 走指令', () => {
    s().newWorld('门禁世界2')
    const boardId = s().currentBoardId
    const before = s().core.runtime.revision
    const id = s().createOffstageRegionAt(120, 60)!
    expect(id).toBeTruthy()
    expect(s().core.runtime.revision, '未走指令').toBeGreaterThan(before)

    const node = nodeOf(id)
    expect(node.kind).toBe('region')
    expect(node.name).toBe(OFFSTAGE_REGION_NAME)
    expect(node.tags).toContain(OFFSTAGE_REGION_TAG)
    expect(node.geometry.x).toBe(120)
    expect(node.geometry.y).toBe(60)
    if (node.kind === 'region') {
      expect(node.geometry.width).toBe(OFFSTAGE_REGION_SIZE.width)
      expect(node.geometry.height).toBe(OFFSTAGE_REGION_SIZE.height)
    }

    // 语义与新建世界自带的那块一致：放进去的角色视为不参与对话
    const actorId = s().createActor('用户', 'persona')!
    s().placeActorAt(actorId, boardId, 130, 70, { kind: 'node', nodeId: id })
    const placement = s().core.runtime.placements.find(
      (p) => p.actorId === actorId
    )!
    expect(isPlacementOffstage(s().core.world, placement)).toBe(true)

    // 也支持拖拽定尺寸
    const sized = s().createOffstageRegionAt(400, 60, 500, 300)!
    const sizedNode = nodeOf(sized)
    expect(sizedNode.geometry.x).toBe(400)
    if (sizedNode.kind === 'region') {
      expect(sizedNode.geometry.width).toBe(500)
      expect(sizedNode.geometry.height).toBe(300)
    }
  })

  it('工具栏工具切换（含新增「未参与对话」）有代码入口', () => {
    s().setTool('offstage')
    expect(s().tool).toBe('offstage')
    expect(s().statusMessage).toContain('未参与对话')
    s().setTool('select')
    expect(s().tool).toBe('select')
  })

  it('拖动区域右下角调整大小：走指令、左上角不动、低于下限被夹住', () => {
    s().newWorld('门禁世界3')
    const regionId = s().createRegionAt(100, 100, 200, 150, '测试区域')!
    const region = () => {
      const node = nodeOf(regionId)
      if (node.kind !== 'region') throw new Error('应为区域')
      return node
    }
    expect(region().geometry.width).toBe(200)

    const before = s().core.runtime.revision
    s().moveNode(regionId, 100, 100, 360, 260)
    expect(s().core.runtime.revision, '未走指令').toBeGreaterThan(before)
    expect(region().geometry.width).toBe(360)
    expect(region().geometry.height).toBe(260)
    // 只改右下角：左上角坐标不变
    expect(region().geometry.x).toBe(100)
    expect(region().geometry.y).toBe(100)

    // 拖到极小：按 MIN_REGION_SIZE 夹住，不产生非法几何
    s().moveNode(regionId, 100, 100, 1, 1)
    expect(region().geometry.width).toBe(MIN_REGION_SIZE)
    expect(region().geometry.height).toBe(MIN_REGION_SIZE)
  })

  it('直属子结构手动横排时贴在主地点右侧', () => {
    const f = buildFixtures()
    s().updateNode(f.placeId, { childLayout: 'row' })
    const first = s().addSubPlace(f.placeId)!
    const second = s().addSubPlace(f.placeId)!
    const a = nodeOf(first).geometry, b = nodeOf(second).geometry
    expect(b.y).toBe(a.y)
    expect(b.x).toBeGreaterThan(a.x)
    const flow = domainNodesToFlow(s().core.world.nodes, s().core.runtime.placements, s().currentBoardId)
    const width = (flow.find(n => n.id === f.placeId)!.style as { width: number }).width
    expect(a.x - nodeOf(f.placeId).geometry.x).toBe(width)
  })

  it('主地点添加多个子结构时默认贴右缘纵排，整组与地点居中', () => {
    const f = buildFixtures()
    const floor1 = s().addSubPlace(f.placeId)!
    const floor2 = s().addSubPlace(f.placeId)!

    const place = nodeOf(f.placeId)
    const a = nodeOf(floor1)
    const b = nodeOf(floor2)
    const placeWidth = placeSizeByCount(
      place,
      s().core.world.nodes,
      (id) => dockedActorCountAt(s().core.runtime.placements, id)
    ).width
    const stackHeight = PLACE_CHIP_HEIGHT * 2

    expect(place.kind).toBe('place')
    if (place.kind !== 'place') throw new Error('主地点应为地点节点')
    expect(place.childLayout).toBe('column-right')
    expect(a.geometry.x).toBe(place.geometry.x + placeWidth)
    expect(b.geometry.x).toBe(a.geometry.x)
    expect(b.geometry.y).toBe(a.geometry.y + PLACE_CHIP_HEIGHT)
    expect(a.geometry.y).toBe(
      place.geometry.y + (PLACE_NODE_SIZE - stackHeight) / 2
    )
  })

  it('拖拽直属子结构可识别横向排列，始终保持同一父地点', () => {
    const f = buildFixtures()
    const first = s().addSubPlace(f.placeId)!
    const second = s().addSubPlace(f.placeId)!
    const a = nodeOf(first)
    s().moveNode(second, a.geometry.x + PLACE_CHIP_WIDTH, a.geometry.y)
    const parent = nodeOf(f.placeId)
    expect(parent.kind).toBe('place')
    if (parent.kind !== 'place') throw Error('地点')
    expect(parent.childLayout).toBe('row')
    expect(nodeOf(second).geometry.y).toBe(nodeOf(first).geometry.y)
    expect(nodeOf(first).parentNodeId).toBe(f.placeId)
    expect(nodeOf(second).parentNodeId).toBe(f.placeId)
  })

  it('多个子结构靠近主地点右侧圆角时，主卡片自动收紧连接角', () => {
    const f = buildFixtures()
    const floor1 = s().addSubPlace(f.placeId)!
    const floor2 = s().addSubPlace(f.placeId)!

    const flows = domainNodesToFlow(
      s().core.world.nodes,
      s().core.runtime.placements,
      s().currentBoardId
    )
    const dataOf = (id: string) =>
      flows.find((n) => n.id === id)?.data as {
        dockRight?: boolean
        dockRightTop?: boolean
        dockRightBottom?: boolean
        joinLeft?: boolean
        joinTop?: boolean
      }

    expect(dataOf(f.placeId).dockRight).toBe(true)
    expect(dataOf(f.placeId).dockRightTop).toBe(true)
    expect(dataOf(f.placeId).dockRightBottom).toBe(true)
    expect(dataOf(floor1).joinLeft).toBe(true)
    expect(dataOf(floor2).joinLeft).toBe(true)
    expect(dataOf(floor2).joinTop).toBe(true)
  })

  it('单个子结构与主地点中线对齐', () => {
    const f = buildFixtures()
    const child = s().addSubPlace(f.placeId)!
    expect(nodeOf(child).geometry.y).toBe(nodeOf(f.placeId).geometry.y + (PLACE_NODE_SIZE - PLACE_CHIP_HEIGHT) / 2)
    expect(nodeOf(child).geometry.x).toBeGreaterThan(nodeOf(f.placeId).geometry.x)
  })

  it('快捷放置多个角色时会分配不同空位', () => {
    s().newWorld('角色放置')
    const a = s().createActor('用户', 'persona')!
    const b = s().createActor('林雪', 'character')!

    s().placeActorOnBoard(a)
    s().placeActorOnBoard(b)

    const placements = s().core.runtime.placements
    const pa = placements.find((item) => item.actorId === a)!.position
    const pb = placements.find((item) => item.actorId === b)!.position
    expect(pb).not.toEqual(pa)
  })

  it('距离连线会根据节点相对方向选择最近的连接边', () => {
    expect(distanceHandlePair({ x: 0, y: 0 }, { x: 300, y: 20 })).toEqual({
      sourceHandle: 'source-right',
      targetHandle: 'target-left',
    })
    expect(distanceHandlePair({ x: 20, y: 300 }, { x: 0, y: 0 })).toEqual({
      sourceHandle: 'source-top',
      targetHandle: 'target-bottom',
    })
  })

  it('横向子结构各按自身停靠槽宽度排开', () => {
    const f = buildFixtures()
    s().updateNode(f.placeId, { childLayout: 'row' })
    const room1 = s().addSubPlace(f.placeId)!
    const room2 = s().addSubPlace(f.placeId)!

    // room1 停靠一个角色 → 该条目自然宽度变大
    const actorId = s().createActor('角色2', 'character')!
    s().placeActorAt(actorId, f.boardId, 0, 0, { kind: 'node', nodeId: room1 })

    const countAt = (id: string) =>
      dockedActorCountAt(s().core.runtime.placements, id)
    const domainWidth = (id: string) =>
      placeSizeByCount(nodeOf(id), s().core.world.nodes, countAt).width
    const flowWidth = (id: string) => {
      const flows = domainNodesToFlow(
        s().core.world.nodes,
        s().core.runtime.placements,
        s().currentBoardId
      )
      return (flows.find((n) => n.id === id)!.style as { width: number }).width
    }

    expect(domainWidth(room1)).toBeGreaterThan(domainWidth(room2))
    expect(domainWidth(room2)).toBe(PLACE_CHIP_WIDTH)
    expect(flowWidth(room1)).toBe(domainWidth(room1))
    expect(flowWidth(room2)).toBe(domainWidth(room2))
    expect(nodeOf(room2).geometry.x).toBe(
      nodeOf(room1).geometry.x + domainWidth(room1)
    )

    // 外层地点卡片不参与拉齐
    const cardWidth = domainWidth(f.placeId)
    expect(domainWidth(f.placeId)).toBe(cardWidth)

    // 未拉宽时停靠头像位置与旧实现一致（91.5 起，每步 20），不引入视觉位移
    expect(chipDockOffset(placeChipWidth(1), 1, 0)).toBe(91.5)
    expect(chipDockOffset(placeChipWidth(2), 2, 1)).toBe(111.5)
    // 拉宽后头像整组贴条目右缘
    expect(chipDockOffset(placeChipWidth(1) + 40, 1, 0)).toBe(131.5)
  })

  it('视口能力有代码入口（画布未挂载时不抛错）', () => {
    expect(() => {
      s().zoomIn()
      s().zoomOut()
      s().fitView()
    }).not.toThrow()
    expect(s().getViewport()).toBeNull()
    expect(() => s().setViewport({ x: 0, y: 0, zoom: 1 })).not.toThrow()
  })

  it('新建和切换画板会发出一次自动适配视口请求', () => {
    const before = s().fitViewRequest
    s().newWorld('视口世界')
    expect(s().fitViewRequest).toBeGreaterThan(before)

    const afterNew = s().fitViewRequest
    s().enterBoard(s().currentBoardId)
    expect(s().fitViewRequest).toBeGreaterThan(afterNew)
  })
})

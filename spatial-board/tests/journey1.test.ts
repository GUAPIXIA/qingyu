/**
 * 关键旅程 1：新建世界 → 画 XX 市/YY 市 → 创建距离 → 导出 → 清空 → 导入后完全一致。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useSpatialStore } from '../src/store/spatialStore.ts'
import {
  OFFSTAGE_REGION_TAG,
  projectCompactText,
  validateWorld,
  hasErrors,
  type RegionNode,
  type SpatialWorldDocumentV1,
} from '@qingyu/spatial-core'
import { BOARD_WIDTH, BOARD_HEIGHT } from '../src/canvas/adapter.ts'

function reset() {
  useSpatialStore.getState().newWorld('旅程世界')
}

function userNodes() {
  return useSpatialStore
    .getState()
    .core.world.nodes.filter((node) => !node.tags.includes(OFFSTAGE_REGION_TAG))
}

describe('关键旅程 1', () => {
  beforeEach(reset)

  it('新建世界 → 画两市 → 距离 → 导出 → 清空 → 导入一致', () => {
    const store = useSpatialStore.getState()

    // 画 XX 市 / YY 市
    const cityX = store.createRegionAt(
      0.1 * BOARD_WIDTH,
      0.18 * BOARD_HEIGHT,
      0.4 * BOARD_WIDTH,
      0.55 * BOARD_HEIGHT,
      'XX 市'
    )
    const cityY = store.createRegionAt(
      0.58 * BOARD_WIDTH,
      0.22 * BOARD_HEIGHT,
      0.32 * BOARD_WIDTH,
      0.48 * BOARD_HEIGHT,
      'YY 市'
    )
    expect(cityX).toBeTruthy()
    expect(cityY).toBeTruthy()

    // 创建距离
    const distId = useSpatialStore
      .getState()
      .createDistanceBetween(cityX!, cityY!, {
        name: 'XX 市至 YY 市',
        value: 32,
        unit: 'km',
        displayText: '约 32 km',
        certainty: 'estimated',
      })
    expect(distId).toBeTruthy()

    // 世界校验通过
    const core = useSpatialStore.getState().core
    expect(hasErrors(validateWorld(core.world))).toBe(false)
    expect(userNodes()).toHaveLength(2)
    expect(core.world.distances).toHaveLength(1)

    // 导出
    const exported = useSpatialStore.getState().exportPackage()
    const beforeText = projectCompactText(exported.world, exported.runtime as never, {
      full: true,
    })

    // 清空
    useSpatialStore.getState().newWorld('空')
    expect(userNodes()).toHaveLength(0)

    // 导入
    const result = useSpatialStore.getState().importPackage({
      world: exported.world,
      runtime: exported.runtime,
    })
    expect(result.ok).toBe(true)

    const after = useSpatialStore.getState().core.world
    const afterText = projectCompactText(after, useSpatialStore.getState().core.runtime, {
      full: true,
    })

    // 结构一致（忽略 metadata 时间戳与 id 前缀差异 —— 导入保留原 id）
    expect(after.nodes.map((n) => n.name).sort()).toEqual(
      exported.world.nodes.map((n) => n.name).sort()
    )
    expect(after.distances).toHaveLength(1)
    expect(after.distances[0].measurement).toMatchObject({
      value: 32,
      unit: 'km',
      displayText: '约 32 km',
      certainty: 'estimated',
    })
    expect(afterText).toBe(beforeText)
  })

  it('导出 JSON 往返不丢字段', () => {
    const store = useSpatialStore.getState()
    store.createRegionAt(100, 100, 300, 200, '区域 A')
    store.createPlaceAt(180, 160, '地点 B')
    const pkg = store.exportPackage()
    const world = JSON.parse(JSON.stringify(pkg.world)) as SpatialWorldDocumentV1

    expect(world.schemaVersion).toBe(1)
    expect(world.rootBoardId).toBeTruthy()
    expect(world.boards[0].coordinateConvention.units).toBe('canvas')
    const region = world.nodes.find(
      (node): node is RegionNode =>
        node.kind === 'region' && node.name === '区域 A'
    )
    // 拖动/创建写入保留 3 位精度；面板显示另做 1 位格式化
    expect(region?.geometry.width).toBeCloseTo(300, 3)
    expect(region?.name).toBe('区域 A')
    expect(world.metadata.app).toBe('qingyu-spatial-board')
  })

  it('跨类型距离被拒绝', () => {
    const store = useSpatialStore.getState()
    const r = store.createRegionAt(50, 50, 200, 150, 'R')
    const p = store.createPlaceAt(400, 400, 'P')
    const id = store.createDistanceBetween(r!, p!)
    expect(id).toBeNull()
    expect(useSpatialStore.getState().core.world.distances).toHaveLength(0)
  })

  it('撤销/重做覆盖节点创建', () => {
    const store = useSpatialStore.getState()
    store.createRegionAt(10, 10, 100, 80, 'A')
    expect(userNodes()).toHaveLength(1)
    useSpatialStore.getState().undo()
    expect(userNodes()).toHaveLength(0)
    useSpatialStore.getState().redo()
    expect(userNodes()).toHaveLength(1)
  })

  it('世界重命名与距离属性可更新', () => {
    const store = useSpatialStore.getState()
    store.setWorldName('重命名世界')
    expect(useSpatialStore.getState().core.world.name).toBe('重命名世界')

    const a = store.createRegionAt(10, 10, 100, 80, 'A')
    const b = store.createRegionAt(200, 10, 100, 80, 'B')
    const d = store.createDistanceBetween(a!, b!)
    expect(d).toBeTruthy()
    useSpatialStore.getState().updateDistance(d!, {
      measurement: { value: 10, displayText: '10 km', unit: 'km', certainty: 'exact' },
    })
    const rel = useSpatialStore.getState().core.world.distances[0]
    expect(rel.measurement.value).toBe(10)
    expect(rel.measurement.certainty).toBe('exact')
  })
})

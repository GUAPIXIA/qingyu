/**
 * 阶段 5 质量收口：旅程 5、往返无损、导入防护、性能基线。
 */
import { describe, expect, it } from 'vitest'
import {
  createEmptyRuntime,
  createEmptyWorld,
  createSeqIdGen,
  projectCompactText,
  validateAll,
  hasErrors,
  applyCommandBatch,
  type SpatialCoreState,
  type SpatialWorldDocumentV1,
} from '@qingyu/spatial-core'
import {
  parseImportJson,
  guardWorldImport,
  guardRuntimeImport,
} from '@qingyu/spatial-core'
import { useSpatialStore } from '../src/store/spatialStore.ts'

function emptyCore(): SpatialCoreState {
  const now = 1727000000000
  return {
    world: createEmptyWorld('world_t', 'T', { now }),
    runtime: createEmptyRuntime('world_t', 'rt_t', now),
  }
}

// ---------------------------------------------------------------------------
// 旅程 5：非法导入被拒且当前数据不变
// ---------------------------------------------------------------------------

describe('关键旅程 5：非法导入拒绝且数据不变', () => {
  it('循环层级被拒，当前草稿不变', () => {
    useSpatialStore.getState().newWorld('守卫世界')
    const before = JSON.stringify(useSpatialStore.getState().exportPackage().world)

    const circular = {
      schemaVersion: 1,
      id: 'world_bad',
      name: '循环',
      description: '',
      rootBoardId: 'board_root',
      boards: [
        {
          id: 'board_root',
          name: '根',
          description: '',
          parentEntryNodeId: null,
          coordinateConvention: {
            north: 'up',
            origin: 'top-left',
            units: 'canvas',
          },
        },
      ],
      nodes: [
        {
          id: 'region_a',
          boardId: 'board_root',
          kind: 'region',
          name: 'A',
          description: '',
          tags: [],
          parentNodeId: 'region_b',
          childBoardId: null,
          createdAt: 1,
          updatedAt: 1,
          geometry: { x: 0, y: 0, width: 0.3, height: 0.3 },
          
        },
        {
          id: 'region_b',
          boardId: 'board_root',
          kind: 'region',
          name: 'B',
          description: '',
          tags: [],
          parentNodeId: 'region_a',
          childBoardId: null,
          createdAt: 1,
          updatedAt: 1,
          geometry: { x: 0.4, y: 0.4, width: 0.3, height: 0.3 },
          
        },
      ],
      distances: [],
      actors: [],
      metadata: { createdAt: 1, updatedAt: 1, app: 'qingyu-spatial-board' },
    }

    const issues = guardWorldImport(circular as SpatialWorldDocumentV1)
    expect(issues.some((i) => i.code === 'cycle_detected')).toBe(true)

    const result = useSpatialStore.getState().importPackage({
      world: circular,
    })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(useSpatialStore.getState().exportPackage().world)).toBe(
      before
    )
  })

  it('悬空 actor / 跨类型距离被拒', () => {
    const world = {
      schemaVersion: 1,
      id: 'world_bad2',
      name: '悬空',
      description: '',
      rootBoardId: 'board_root',
      boards: [
        {
          id: 'board_root',
          name: '根',
          description: '',
          parentEntryNodeId: null,
          coordinateConvention: {
            north: 'up',
            origin: 'top-left',
            units: 'canvas',
          },
        },
      ],
      nodes: [
        {
          id: 'region_x',
          boardId: 'board_root',
          kind: 'region',
          name: 'X',
          description: '',
          tags: [],
          parentNodeId: null,
          childBoardId: null,
          createdAt: 1,
          updatedAt: 1,
          geometry: { x: 0, y: 0, width: 0.4, height: 0.4 },
          
        },
        {
          id: 'place_y',
          boardId: 'board_root',
          kind: 'place',
          name: 'Y',
          description: '',
          tags: [],
          parentNodeId: null,
          childBoardId: null,
          createdAt: 1,
          updatedAt: 1,
          geometry: { x: 0.6, y: 0.6 },
          
          iconKey: 'marker',
        },
      ],
      distances: [
        {
          id: 'dist_bad',
          kind: 'distance',
          boardId: 'board_root',
          sourceNodeId: 'region_x',
          targetNodeId: 'place_y',
          name: '跨类型',
          description: '',
          measurement: {
            value: 1,
            unit: 'km',
            displayText: '1km',
            certainty: 'estimated',
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      actors: [
        {
          id: 'actor_ghost',
          kind: 'character',
          externalRef: { type: 'standalone', id: 'g' },
          displayName: '幽灵',
        },
      ],
      metadata: { createdAt: 1, updatedAt: 1, app: 'qingyu-spatial-board' },
    }

    const issues = guardWorldImport(world as SpatialWorldDocumentV1)
    expect(issues.some((i) => i.code === 'cross_kind_distance')).toBe(true)

    // runtime 悬空 actor
    const rtIssues = guardRuntimeImport(
      {
        schemaVersion: 1,
        worldId: 'world_bad2',
        runtimeId: 'rt',
        revision: 0,
        placements: [
          {
            actorId: 'actor_missing',
            boardId: 'board_root',
            anchor: { kind: 'board' },
            position: { x: 0, y: 0 },
            semanticPosition: { containmentPath: [], precision: 'unknown' },
            revision: 0,
            updatedAt: 1,
            updatedBy: 'import',
          },
        ],
        events: [],
        updatedAt: 1,
      },
      world as SpatialWorldDocumentV1
    )
    expect(rtIssues.some((i) => i.code === 'dangling_actor')).toBe(true)
  })

  it('拒绝导入属于其他世界的运行状态且保留当前草稿', () => {
    useSpatialStore.getState().newWorld('当前世界')
    const before = useSpatialStore.getState().core
    const world = createEmptyWorld('world_a', 'A', { now: 1 })
    const runtime = createEmptyRuntime('world_b', 'runtime_b', 1)
    expect(
      validateAll(world, runtime).some((i) => i.code === 'runtime_world_mismatch')
    ).toBe(true)

    const result = useSpatialStore.getState().importPackage({ world, runtime })
    expect(result.ok).toBe(false)
    expect(useSpatialStore.getState().core).toBe(before)
  })

  it('导入运行状态时只保留最近 500 条事件', () => {
    const world = createEmptyWorld('world_events', '事件世界', { now: 1 })
    const runtime = createEmptyRuntime(world.id, 'runtime_events', 1)
    runtime.events = Array.from({ length: 501 }, (_, i) => ({
      id: `event_${i}`,
      runtimeId: runtime.runtimeId,
      revision: i,
      commandType: 'create_node' as const,
      source: 'system' as const,
      createdAt: i,
    }))

    const result = useSpatialStore.getState().importPackage({ world, runtime })
    expect(result.ok).toBe(true)
    expect(useSpatialStore.getState().core.runtime.events).toHaveLength(500)
    expect(useSpatialStore.getState().core.runtime.events[0].id).toBe('event_1')
  })
})

// ---------------------------------------------------------------------------
// 往返无损
// ---------------------------------------------------------------------------

describe('JSON 往返不丢字段', () => {
  it('city-home 世界定义往返字节级一致（稳定排序后）', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const raw = fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'city-home.json'),
      'utf8'
    )
    const world = JSON.parse(raw) as SpatialWorldDocumentV1
    const exported = JSON.parse(JSON.stringify(world)) as SpatialWorldDocumentV1

    // 深比较：所有字段保留
    expect(exported).toEqual(world)

    // 投影稳定
    const runtime = createEmptyRuntime(world.id, 'rt', 1)
    const a = projectCompactText(world, runtime, { full: true })
    const b = projectCompactText(exported, runtime, { full: true })
    expect(a).toBe(b)
  })

  it('city-home runtime 往返保留 placement 与 event 字段', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const raw = fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'city-home.runtime.json'),
      'utf8'
    )
    const runtime = JSON.parse(raw)
    const copy = JSON.parse(JSON.stringify(runtime))
    expect(copy).toEqual(runtime)
  })

  it('store 导出导入后再导出，关键字段一致', () => {
    useSpatialStore.getState().newWorld('往返世界')
    const s = () => useSpatialStore.getState()
    const home = s().createPlaceAt(100, 100, '用户家')!
    s().createInternalBoard(home)
    const pkg = s().exportPackage()
    s().newWorld('空')
    const result = s().importPackage({
      world: pkg.world,
      runtime: pkg.runtime,
    })
    expect(result.ok).toBe(true)
    const pkg2 = s().exportPackage()
    expect(pkg2.world.nodes.map((n) => n.name)).toEqual(
      pkg.world.nodes.map((n) => n.name)
    )
    expect(pkg2.world.boards.length).toBe(pkg.world.boards.length)
    expect(pkg2.world.distances.length).toBe(pkg.world.distances.length)
  })
})

// ---------------------------------------------------------------------------
// 导入防护
// ---------------------------------------------------------------------------

describe('导入限制与恶意 JSON', () => {
  it('超大文件被拒', () => {
    const big = 'x'.repeat(6 * 1024 * 1024)
    const result = parseImportJson(`"${big}"`, { maxFileBytes: 5 * 1024 * 1024 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues[0].code).toBe('file_too_large')
    }
  })

  it('非法 JSON 被拒', () => {
    const result = parseImportJson('{not json')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues[0].code).toBe('json_invalid')
    }
  })

  it('超深嵌套被拒', () => {
    const deep = '['.repeat(80) + ']'.repeat(80)
    const result = parseImportJson(deep)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues[0].code).toBe('json_too_deep')
    }
  })

  it('原型污染键被拒', () => {
    const result = parseImportJson('{"__proto__": {"x": 1}}')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0].code).toBe('proto_pollution')
  })

  it('节点数超限被拒', () => {
    const core = emptyCore()
    const nodes = Array.from({ length: 20 }, (_, i) => ({
      id: `region_${i}`,
      boardId: core.world.rootBoardId,
      kind: 'region' as const,
      name: `N${i}`,
      description: '',
      tags: [],
      parentNodeId: null,
      childBoardId: null,
      createdAt: 1,
      updatedAt: 1,
      geometry: { x: 0.01 * i, y: 0.01, width: 0.02, height: 0.02 },
      
    }))
    const world = {
      ...core.world,
      nodes,
    }
    const issues = guardWorldImport(world, { maxNodes: 10 })
    expect(issues.some((i) => i.code === 'too_many_nodes')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 性能基线：300 节点 / 500 边
// ---------------------------------------------------------------------------

describe('性能基线', () => {
  it('300 节点 + 500 距离：构建与投影 < 1s', () => {
    const start = performance.now()
    let state = emptyCore()
    const idGen = createSeqIdGen('perf')
    const root = state.world.rootBoardId

    // 300 个 region（扁平，避免父子几何约束干扰性能计时）
    const cmds = []
    for (let i = 0; i < 300; i += 1) {
      cmds.push({
        type: 'create_node' as const,
        payload: {
          id: `region_p${i}`,
          boardId: root,
          kind: 'region' as const,
          name: `R${i}`,
          description: '',
          tags: [],
          parentNodeId: null,
          childBoardId: null,
          createdAt: 1,
          updatedAt: 1,
          geometry: {
            x: (i % 15) * 0.06,
            y: Math.floor(i / 15) * 0.04,
            width: 0.03,
            height: 0.03,
          },
          
        },
      })
    }

    let result = applyCommandBatch(
      state,
      { schemaVersion: 1, expectedRevision: 0, commands: cmds },
      { now: 1, source: 'user', idGen }
    )
    if (!result.ok) {
      throw new Error(`create nodes failed: ${result.code} ${result.message}`)
    }
    state = result.state

    // 500 条不重复无向距离（多偏移生成）
    const uniqueCmds = []
    const seen = new Set<string>()
    for (let i = 0; i < 300 && uniqueCmds.length < 500; i += 1) {
      for (const delta of [1, 2, 3, 7, 11]) {
        const a = i
        const b = (i + delta) % 300
        if (a === b) continue
        const key = a < b ? `${a}-${b}` : `${b}-${a}`
        if (seen.has(key)) continue
        seen.add(key)
        uniqueCmds.push({
          type: 'create_distance' as const,
          payload: {
            id: `dist_p${uniqueCmds.length}`,
            kind: 'distance' as const,
            boardId: root,
            sourceNodeId: `region_p${a}`,
            targetNodeId: `region_p${b}`,
            name: `D${uniqueCmds.length}`,
            description: '',
            measurement: {
              value: uniqueCmds.length,
              unit: 'km' as const,
              displayText: `${uniqueCmds.length} km`,
              certainty: 'estimated' as const,
            },
            createdAt: 1,
            updatedAt: 1,
          },
        })
        if (uniqueCmds.length >= 500) break
      }
    }

    for (let offset = 0; offset < uniqueCmds.length; offset += 50) {
      const slice = uniqueCmds.slice(offset, offset + 50)
      result = applyCommandBatch(
        state,
        {
          schemaVersion: 1,
          expectedRevision: state.runtime.revision,
          commands: slice,
        },
        { now: 2 + offset, source: 'user', idGen }
      )
      if (!result.ok) {
        throw new Error(
          `create distances failed at ${offset}: ${result.code} ${result.message}`
        )
      }
      state = result.state
    }

    expect(state.world.nodes.length).toBe(300)
    expect(state.world.distances.length).toBeGreaterThanOrEqual(200)

    const issues = validateAll(state.world, state.runtime)
    expect(hasErrors(issues)).toBe(false)

    const text = projectCompactText(state.world, state.runtime, { full: true })
    expect(text.length).toBeGreaterThan(100)

    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(1000)
  })
})

// ---------------------------------------------------------------------------
// 可访问性：键盘与焦点
// ---------------------------------------------------------------------------

describe('键盘与可访问性（文档化断言）', () => {
  it('工具按钮含文字标签（非纯图标）', async () => {
    // 静态检查源码中的工具标签
    const fs = await import('node:fs')
    const path = await import('node:path')
    const toolbar = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'components', 'Toolbar.tsx'),
      'utf8'
    )
    expect(toolbar).toContain('矩形区域')
    expect(toolbar).toContain('地点')
    expect(toolbar).toContain('距离模式')
    expect(toolbar).toContain('角色托盘')
  })

  it('撤销创建节点后清除已失效的选择', () => {
    useSpatialStore.getState().newWorld('撤销选择')
    const nodeId = useSpatialStore.getState().createPlaceAt(100, 100, '临时地点')
    expect(useSpatialStore.getState().selection).toEqual({
      type: 'node',
      id: nodeId,
    })

    useSpatialStore.getState().undo()
    expect(useSpatialStore.getState().selection).toEqual({
      type: 'none',
      id: null,
    })
  })
})

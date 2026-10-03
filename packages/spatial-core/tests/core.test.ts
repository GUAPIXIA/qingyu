/**
 * 领域核心单元测试：覆盖方案 §17.1 的 P0 条目。
 */
import { describe, expect, it } from 'vitest'
import type {
  DistanceRelation,
  PlaceNode,
  RegionNode,
  SpatialCommand,
} from '../src/index.ts'
import {
  applyCommand,
  applyCommandBatch,
  createEmptyRuntime,
  createEmptyWorld,
  createHistory,
  createSeqIdGen,
  canRedo,
  canUndo,
  getContainmentPath,
  projectCompactText,
  redo,
  runBatch,
  undo,
  validateAll,
  validateDistanceRelation,
  validateHierarchy,
  validateWorld,
  hasErrors,
  type SpatialCoreState,
} from '../src/index.ts'

const NOW = 1727000000000

function seq() {
  return createSeqIdGen('t')
}

function emptyState(worldId = 'world_t', runtimeId = 'rt_t'): SpatialCoreState {
  return {
    world: createEmptyWorld(worldId, '测试世界', { now: NOW }),
    runtime: createEmptyRuntime(worldId, runtimeId, NOW),
  }
}

function region(partial: Partial<RegionNode> & { id: string; boardId: string }): RegionNode {
  return {
    kind: 'region',
    name: partial.name ?? partial.id,
    description: '',
    tags: [],
    parentNodeId: null,
    childBoardId: null,
    createdAt: NOW,
    updatedAt: NOW,
    geometry: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    
    ...partial,
  }
}

function place(partial: Partial<PlaceNode> & { id: string; boardId: string }): PlaceNode {
  return {
    kind: 'place',
    name: partial.name ?? partial.id,
    description: '',
    tags: [],
    parentNodeId: null,
    childBoardId: null,
    createdAt: NOW,
    updatedAt: NOW,
    geometry: { x: 0.2, y: 0.2 },
    
    iconKey: 'marker',
    ...partial,
  }
}

function distance(
  partial: Partial<DistanceRelation> & {
    id: string
    boardId: string
    sourceNodeId: string
    targetNodeId: string
  }
): DistanceRelation {
  return {
    kind: 'distance',
    name: partial.name ?? partial.id,
    description: '',
    measurement: {
      value: 1,
      unit: 'km',
      displayText: '1 km',
      certainty: 'estimated',
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// 节点 CRUD
// ---------------------------------------------------------------------------

describe('节点创建、更新、删除', () => {
  it('创建 region 与 place', () => {
    let state = emptyState()
    const root = state.world.rootBoardId

    const r = applyCommand(
      state,
      {
        type: 'create_node',
        payload: region({ id: 'region_city', boardId: root, name: 'XX 市' }),
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    state = r.state

    const p = applyCommand(
      state,
      {
        type: 'create_node',
        payload: place({
          id: 'place_home',
          boardId: root,
          name: '用户家',
          parentNodeId: 'region_city',
        }),
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.state.world.nodes).toHaveLength(2)
    expect(hasErrors(validateWorld(p.state.world))).toBe(false)
  })

  it('更新节点名称与父级', () => {
    let state = emptyState()
    const root = state.world.rootBoardId
    let res = applyCommand(
      state,
      {
        type: 'create_node',
        payload: region({ id: 'r1', boardId: root }),
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    state = res.state

    res = applyCommand(
      state,
      {
        type: 'create_node',
        payload: region({ id: 'r2', boardId: root }),
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    state = res.state

    res = applyCommand(
      state,
      {
        type: 'update_node',
        nodeId: 'r2',
        patch: { name: '子区域', parentNodeId: 'r1' },
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const n = res.state.world.nodes.find((x) => x.id === 'r2')
    expect(n?.name).toBe('子区域')
    expect(n?.parentNodeId).toBe('r1')
  })

  it('reject-if-not-empty 拒绝删除有子节点的区域', () => {
    let state = emptyState()
    const root = state.world.rootBoardId
    for (const cmd of [
      {
        type: 'create_node' as const,
        payload: region({ id: 'parent', boardId: root }),
      },
      {
        type: 'create_node' as const,
        payload: region({
          id: 'child',
          boardId: root,
          parentNodeId: 'parent',
          geometry: { x: 0.15, y: 0.15, width: 0.2, height: 0.2 },
        }),
      },
    ]) {
      const r = applyCommand(state, cmd, { now: NOW, source: 'user', idGen: seq() })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      state = r.state
    }

    const del = applyCommand(
      state,
      { type: 'delete_node', nodeId: 'parent', strategy: 'reject-if-not-empty' },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(del.ok).toBe(false)
    if (del.ok) return
    expect(del.code).toBe('node_not_empty')
  })

  it('cascade 删除节点及其后代', () => {
    let state = emptyState()
    const root = state.world.rootBoardId
    for (const cmd of [
      {
        type: 'create_node' as const,
        payload: region({ id: 'parent', boardId: root }),
      },
      {
        type: 'create_node' as const,
        payload: region({
          id: 'child',
          boardId: root,
          parentNodeId: 'parent',
          geometry: { x: 0.15, y: 0.15, width: 0.2, height: 0.2 },
        }),
      },
    ]) {
      const r = applyCommand(state, cmd, { now: NOW, source: 'user', idGen: seq() })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      state = r.state
    }

    const del = applyCommand(
      state,
      { type: 'delete_node', nodeId: 'parent', strategy: 'cascade' },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(del.ok).toBe(true)
    if (!del.ok) return
    expect(del.state.world.nodes).toHaveLength(0)
  })

  it('cascade 同时清理后代距离与角色位置，提交后状态仍合法', () => {
    let state = emptyState()
    const root = state.world.rootBoardId
    const setup = applyCommandBatch(
      state,
      {
        schemaVersion: 1,
        expectedRevision: 0,
        commands: [
          { type: 'create_node', payload: region({ id: 'parent', boardId: root }) },
          {
            type: 'create_node',
            payload: place({
              id: 'child_a',
              boardId: root,
              parentNodeId: 'parent',
            }),
          },
          {
            type: 'create_node',
            payload: place({
              id: 'child_b',
              boardId: root,
              parentNodeId: 'parent',
              geometry: { x: 0.3, y: 0.3 },
            }),
          },
          {
            type: 'create_distance',
            payload: distance({
              id: 'child_distance',
              boardId: root,
              sourceNodeId: 'child_a',
              targetNodeId: 'child_b',
            }),
          },
          {
            type: 'create_actor',
            payload: {
              id: 'actor_child',
              kind: 'character',
              externalRef: { type: 'standalone', id: 'actor_child' },
              displayName: '子节点角色',
            },
          },
          {
            type: 'place_actor',
            actorId: 'actor_child',
            placement: {
              boardId: root,
              anchor: { kind: 'node', nodeId: 'child_a' },
              semanticPosition: { precision: 'inside-only' },
            },
          },
        ],
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(setup.ok).toBe(true)
    if (!setup.ok) return
    state = setup.state

    const del = applyCommand(
      state,
      { type: 'delete_node', nodeId: 'parent', strategy: 'cascade' },
      { now: NOW + 1, source: 'user', idGen: seq() }
    )
    expect(del.ok).toBe(true)
    if (!del.ok) return
    expect(del.state.world.nodes).toHaveLength(0)
    expect(del.state.world.distances).toHaveLength(0)
    expect(del.state.runtime.placements).toHaveLength(0)
    expect(hasErrors(validateAll(del.state.world, del.state.runtime))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 层级与循环
// ---------------------------------------------------------------------------

describe('父子包含与循环检测', () => {
  it('拒绝 region 挂在 place 下（place 可挂 place）', () => {
    let state = emptyState()
    const root = state.world.rootBoardId
    let r = applyCommand(
      state,
      { type: 'create_node', payload: place({ id: 'p1', boardId: root }) },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    state = r.state

    r = applyCommand(
      state,
      {
        type: 'create_node',
        payload: region({ id: 'r1', boardId: root, parentNodeId: 'p1' }),
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('invalid_parent')
  })

  it('update 形成循环时拒绝', () => {
    let state = emptyState()
    const root = state.world.rootBoardId
    for (const id of ['a', 'b']) {
      const r = applyCommand(
        state,
        {
          type: 'create_node',
          payload: region({
            id,
            boardId: root,
            ...(id === 'b' ? { parentNodeId: 'a' } : {}),
            ...(id === 'b'
              ? { geometry: { x: 0.15, y: 0.15, width: 0.2, height: 0.2 } }
              : {}),
          }),
        },
        { now: NOW, source: 'user', idGen: seq() }
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      state = r.state
    }

    const r = applyCommand(
      state,
      { type: 'update_node', nodeId: 'a', patch: { parentNodeId: 'b' } },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('cycle_detected')
  })

  it('包含路径跨画板可追溯', () => {
    let state = emptyState()
    const root = state.world.rootBoardId
    // 城市 > 家 > 子画板 > 楼层 > 卧室
    const cmds: SpatialCommand[] = [
      {
        type: 'create_node',
        payload: region({ id: 'region_city', boardId: root, name: 'XX 市' }),
      },
      {
        type: 'create_node',
        payload: place({
          id: 'place_home',
          boardId: root,
          name: '用户家',
          parentNodeId: 'region_city',
          childBoardId: 'board_home',
        }),
      },
      {
        type: 'create_node',
        payload: region({
          id: 'region_floor1',
          boardId: 'board_home',
          name: '1 楼',
        }),
      },
      {
        type: 'create_node',
        payload: place({
          id: 'place_bedroom',
          boardId: 'board_home',
          name: '卧室',
          parentNodeId: 'region_floor1',
        }),
      },
    ]
    for (const cmd of cmds) {
      const r = applyCommand(state, cmd, { now: NOW, source: 'user', idGen: seq() })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      state = r.state
    }

    const path = getContainmentPath(state.world, 'board_home', 'place_bedroom')
    expect(path).toEqual([
      'region_city',
      'place_home',
      'region_floor1',
      'place_bedroom',
    ])
    expect(hasErrors(validateWorld(state.world))).toBe(false)
  })

  it('子画板双向引用一致；悬空 childBoard 报错', () => {
    const world = createEmptyWorld('w', 'W', { now: NOW })
    const root = world.rootBoardId
    world.nodes.push(
      place({
        id: 'place_x',
        boardId: root,
        childBoardId: 'board_missing',
      })
    )
    const issues = validateHierarchy(world)
    expect(issues.some((i) => i.code === 'dangling_child_board')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 距离
// ---------------------------------------------------------------------------

describe('距离关系', () => {
  it('同类距离允许，跨类型拒绝', () => {
    let state = emptyState()
    const root = state.world.rootBoardId
    for (const payload of [
      region({ id: 'r1', boardId: root }),
      region({ id: 'r2', boardId: root, geometry: { x: 0.55, y: 0.55, width: 0.3, height: 0.3 } }),
      place({ id: 'p1', boardId: root }),
    ]) {
      const r = applyCommand(
        state,
        { type: 'create_node', payload },
        { now: NOW, source: 'user', idGen: seq() }
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      state = r.state
    }

    const ok = applyCommand(
      state,
      {
        type: 'create_distance',
        payload: distance({
          id: 'd1',
          boardId: root,
          sourceNodeId: 'r1',
          targetNodeId: 'r2',
        }),
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(ok.ok).toBe(true)

    const cross = applyCommand(
      state,
      {
        type: 'create_distance',
        payload: distance({
          id: 'd2',
          boardId: root,
          sourceNodeId: 'r1',
          targetNodeId: 'p1',
        }),
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(cross.ok).toBe(false)
    if (cross.ok) return
    expect(cross.code).toBe('cross_kind_distance')
  })

  it('跨画板距离拒绝', () => {
    let state = emptyState()
    const root = state.world.rootBoardId
    for (const payload of [
      place({ id: 'place_home', boardId: root, childBoardId: 'board_home' }),
      place({ id: 'place_bedroom', boardId: 'board_home' }),
    ]) {
      const r = applyCommand(
        state,
        { type: 'create_node', payload },
        { now: NOW, source: 'user', idGen: seq() }
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      state = r.state
    }

    const r = applyCommand(
      state,
      {
        type: 'create_distance',
        payload: distance({
          id: 'd_cross',
          boardId: root,
          sourceNodeId: 'place_home',
          targetNodeId: 'place_bedroom',
        }),
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('cross_board_distance')
  })

  it('无向去重：A-B 与 B-A 只保留一条', () => {
    let state = emptyState()
    const root = state.world.rootBoardId
    for (const id of ['r1', 'r2']) {
      const r = applyCommand(
        state,
        {
          type: 'create_node',
          payload: region({
            id,
            boardId: root,
            ...(id === 'r2'
              ? { geometry: { x: 0.55, y: 0.55, width: 0.3, height: 0.3 } }
              : {}),
          }),
        },
        { now: NOW, source: 'user', idGen: seq() }
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      state = r.state
    }

    let r = applyCommand(
      state,
      {
        type: 'create_distance',
        payload: distance({
          id: 'd_ab',
          boardId: root,
          sourceNodeId: 'r1',
          targetNodeId: 'r2',
        }),
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    state = r.state

    r = applyCommand(
      state,
      {
        type: 'create_distance',
        payload: distance({
          id: 'd_ba',
          boardId: root,
          sourceNodeId: 'r2',
          targetNodeId: 'r1',
        }),
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('duplicate_distance')
  })

  it('custom 单位必须有 customUnit；无数值必须有 displayText', () => {
    const world = createEmptyWorld('w', 'W', { now: NOW })
    const root = world.rootBoardId
    world.nodes.push(
      region({ id: 'r1', boardId: root }),
      region({ id: 'r2', boardId: root, geometry: { x: 0.55, y: 0.55, width: 0.3, height: 0.3 } })
    )
    const bad = distance({
      id: 'd',
      boardId: root,
      sourceNodeId: 'r1',
      targetNodeId: 'r2',
      measurement: {
        value: null,
        unit: 'custom',
        displayText: '',
        certainty: 'unknown',
      },
    })
    const issues = validateDistanceRelation(world, bad)
    expect(issues.some((i) => i.code === 'distance_custom_unit_required')).toBe(true)
    expect(issues.some((i) => i.code === 'distance_display_required')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Actor / revision / 事件
// ---------------------------------------------------------------------------

describe('角色放置、移动与 revision', () => {
  function withActor(state: SpatialCoreState): SpatialCoreState {
    state.world.actors.push({
      id: 'actor_user',
      kind: 'persona',
      externalRef: { type: 'standalone', id: 'user' },
      displayName: '用户',
    })
    return state
  }

  it('place_actor 重算 containmentPath', () => {
    let state = emptyState()
    state = withActor(state)
    const root = state.world.rootBoardId
    for (const cmd of [
      {
        type: 'create_node' as const,
        payload: region({ id: 'region_city', boardId: root, name: 'XX 市' }),
      },
      {
        type: 'create_node' as const,
        payload: place({
          id: 'place_home',
          boardId: root,
          name: '用户家',
          parentNodeId: 'region_city',
          childBoardId: 'board_home',
        }),
      },
      {
        type: 'create_node' as const,
        payload: place({ id: 'place_bedroom', boardId: 'board_home', name: '卧室' }),
      },
    ]) {
      const r = applyCommand(state, cmd, { now: NOW, source: 'user', idGen: seq() })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      state = r.state
    }

    const r = applyCommand(
      state,
      {
        type: 'place_actor',
        actorId: 'actor_user',
        placement: {
          boardId: 'board_home',
          anchor: { kind: 'node', nodeId: 'place_bedroom' },
          semanticPosition: { precision: 'inside-only', relativeDirection: 'inside' },
        },
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const p = r.state.runtime.placements[0]
    expect(p.semanticPosition.containmentPath).toEqual([
      'region_city',
      'place_home',
      'place_bedroom',
    ])
    expect(r.events).toHaveLength(1)
    expect(r.events[0].after?.actorId).toBe('actor_user')
  })

  it('move_actor 的 from 守卫不匹配时失败', () => {
    let state = emptyState()
    state = withActor(state)
    const root = state.world.rootBoardId
    for (const id of ['place_a', 'place_b']) {
      const r = applyCommand(
        state,
        { type: 'create_node', payload: place({ id, boardId: root }) },
        { now: NOW, source: 'user', idGen: seq() }
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      state = r.state
    }
    let r = applyCommand(
      state,
      {
        type: 'place_actor',
        actorId: 'actor_user',
        placement: {
          boardId: root,
          anchor: { kind: 'node', nodeId: 'place_a' },
          semanticPosition: { precision: 'exact' },
        },
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    state = r.state

    r = applyCommand(
      state,
      {
        type: 'move_actor',
        actorId: 'actor_user',
        from: { nodeId: 'place_b' },
        to: {
          boardId: root,
          anchor: { kind: 'node', nodeId: 'place_b' },
          semanticPosition: { precision: 'exact' },
        },
      },
      { now: NOW, source: 'story', idGen: seq() }
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('guard_mismatch')
  })

  it('旧 expectedRevision 的剧情命令被拒绝', () => {
    let state = emptyState()
    state = withActor(state)
    const root = state.world.rootBoardId
    let r = applyCommand(
      state,
      { type: 'create_node', payload: place({ id: 'place_a', boardId: root }) },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    state = r.state

    // 用户拖动；此前 create_node 已让 revision=1，place_actor 后为 2
    r = applyCommand(
      state,
      {
        type: 'place_actor',
        actorId: 'actor_user',
        placement: {
          boardId: root,
          anchor: { kind: 'node', nodeId: 'place_a' },
          semanticPosition: { precision: 'exact' },
        },
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    state = r.state
    expect(state.runtime.revision).toBe(2)

    // 剧情命令仍用旧的 expectedRevision
    const stale = applyCommandBatch(
      state,
      {
        schemaVersion: 1,
        expectedRevision: 0,
        commands: [
          {
            type: 'move_actor',
            actorId: 'actor_user',
            to: {
              boardId: root,
              anchor: { kind: 'board' },
              semanticPosition: { precision: 'unknown' },
            },
          },
        ],
      },
      { now: NOW + 1, source: 'story', idGen: seq() }
    )
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.code).toBe('revision_conflict')
  })

  it('一批命令中任一失败则整批不提交', () => {
    let state = emptyState()
    state = withActor(state)
    const root = state.world.rootBoardId
    const before = structuredClone(state)

    const r = applyCommandBatch(
      state,
      {
        schemaVersion: 1,
        expectedRevision: 0,
        commands: [
          { type: 'create_node', payload: place({ id: 'place_ok', boardId: root }) },
          {
            type: 'create_node',
            payload: place({ id: 'place_bad', boardId: 'board_missing' }),
          },
        ],
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.commandIndex).toBe(1)
    expect(state.world.nodes).toHaveLength(before.world.nodes.length)
  })
})

// ---------------------------------------------------------------------------
// undo / redo
// ---------------------------------------------------------------------------

describe('undo / redo', () => {
  it('逆命令恢复节点创建', () => {
    let state = emptyState()
    let history = createHistory()
    const root = state.world.rootBoardId

    const run = runBatch(
      state,
      history,
      {
        schemaVersion: 1,
        expectedRevision: 0,
        commands: [
          {
            type: 'create_node',
            payload: region({ id: 'r1', boardId: root, name: '区域' }),
          },
        ],
      },
      { now: NOW, source: 'user', idGen: seq(), label: 'create-r1' }
    )
    expect(run.batch.ok).toBe(true)
    if (!run.batch.ok) return
    state = run.batch.state
    history = run.history
    expect(state.world.nodes).toHaveLength(1)
    expect(canUndo(history)).toBe(true)

    const un = undo(state, history, { now: NOW + 1, idGen: seq() })
    expect(un.batch.ok).toBe(true)
    if (!un.batch.ok) return
    state = un.batch.state
    history = un.history
    expect(state.world.nodes).toHaveLength(0)
    expect(canRedo(history)).toBe(true)

    const re = redo(state, history, { now: NOW + 2, idGen: seq() })
    expect(re.batch.ok).toBe(true)
    if (!re.batch.ok) return
    state = re.batch.state
    expect(state.world.nodes).toHaveLength(1)
    expect(state.world.nodes[0].name).toBe('区域')
  })

  it('剧情移动可整体撤销', () => {
    let state = emptyState()
    let history = createHistory()
    state.world.actors.push({
      id: 'actor_a',
      kind: 'character',
      externalRef: { type: 'standalone', id: 'a' },
      displayName: 'A',
    })
    const root = state.world.rootBoardId

    let run = runBatch(
      state,
      history,
      {
        schemaVersion: 1,
        expectedRevision: 0,
        commands: [
          { type: 'create_node', payload: place({ id: 'p1', boardId: root }) },
          { type: 'create_node', payload: place({ id: 'p2', boardId: root, geometry: { x: 0.6, y: 0.6 } }) },
        ],
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(run.batch.ok).toBe(true)
    if (!run.batch.ok) return
    state = run.batch.state
    history = run.history

    run = runBatch(
      state,
      history,
      {
        schemaVersion: 1,
        expectedRevision: state.runtime.revision,
        commands: [
          {
            type: 'place_actor',
            actorId: 'actor_a',
            placement: {
              boardId: root,
              anchor: { kind: 'node', nodeId: 'p1' },
              semanticPosition: { precision: 'exact' },
            },
          },
        ],
      },
      { now: NOW + 1, source: 'story', idGen: seq() }
    )
    expect(run.batch.ok).toBe(true)
    if (!run.batch.ok) return
    state = run.batch.state
    history = run.history

    run = runBatch(
      state,
      history,
      {
        schemaVersion: 1,
        expectedRevision: state.runtime.revision,
        commands: [
          {
            type: 'move_actor',
            actorId: 'actor_a',
            to: {
              boardId: root,
              anchor: { kind: 'node', nodeId: 'p2' },
              semanticPosition: { precision: 'exact' },
            },
            reason: 'story_move',
          },
        ],
      },
      { now: NOW + 2, source: 'story', idGen: seq(), label: 'story-move' }
    )
    expect(run.batch.ok).toBe(true)
    if (!run.batch.ok) return
    state = run.batch.state
    history = run.history
    expect(state.runtime.placements[0].anchor).toMatchObject({
      kind: 'node',
      nodeId: 'p2',
    })

    const un = undo(state, history, { now: NOW + 3, idGen: seq() })
    expect(un.batch.ok).toBe(true)
    if (!un.batch.ok) return
    state = un.batch.state
    expect(state.runtime.placements[0].anchor).toMatchObject({
      kind: 'node',
      nodeId: 'p1',
    })
  })

  it('删除已放置角色后可整体撤销', () => {
    let state = emptyState()
    let history = createHistory()
    const root = state.world.rootBoardId
    const setup = applyCommandBatch(
      state,
      {
        schemaVersion: 1,
        expectedRevision: 0,
        commands: [
          {
            type: 'create_actor',
            payload: {
              id: 'actor_delete',
              kind: 'character',
              externalRef: { type: 'standalone', id: 'actor_delete' },
              displayName: '待删除角色',
            },
          },
          {
            type: 'place_actor',
            actorId: 'actor_delete',
            placement: {
              boardId: root,
              anchor: { kind: 'board' },
              position: { x: 0.2, y: 0.2 },
              semanticPosition: { precision: 'approximate' },
            },
          },
        ],
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(setup.ok).toBe(true)
    if (!setup.ok) return
    state = setup.state

    const del = runBatch(
      state,
      history,
      {
        schemaVersion: 1,
        expectedRevision: state.runtime.revision,
        commands: [{ type: 'delete_actor', actorId: 'actor_delete' }],
      },
      { now: NOW + 1, source: 'user', idGen: seq() }
    )
    expect(del.batch.ok).toBe(true)
    if (!del.batch.ok) return
    state = del.batch.state
    history = del.history

    const restored = undo(state, history, { now: NOW + 2, idGen: seq() })
    expect(restored.batch.ok).toBe(true)
    if (!restored.batch.ok) return
    expect(restored.batch.state.world.actors.map((a) => a.id)).toContain('actor_delete')
    expect(restored.batch.state.runtime.placements[0]).toMatchObject({
      actorId: 'actor_delete',
      boardId: root,
      anchor: { kind: 'board' },
    })
  })

  it('级联删除节点后可整体撤销距离与角色位置', () => {
    let state = emptyState()
    let history = createHistory()
    const root = state.world.rootBoardId
    const setup = applyCommandBatch(
      state,
      {
        schemaVersion: 1,
        expectedRevision: 0,
        commands: [
          { type: 'create_node', payload: region({ id: 'parent', boardId: root }) },
          {
            type: 'create_node',
            payload: place({ id: 'child_a', boardId: root, parentNodeId: 'parent' }),
          },
          {
            type: 'create_node',
            payload: place({
              id: 'child_b',
              boardId: root,
              parentNodeId: 'parent',
              geometry: { x: 0.3, y: 0.3 },
            }),
          },
          {
            type: 'create_distance',
            payload: distance({
              id: 'child_distance',
              boardId: root,
              sourceNodeId: 'child_a',
              targetNodeId: 'child_b',
            }),
          },
          {
            type: 'create_actor',
            payload: {
              id: 'actor_child',
              kind: 'character',
              externalRef: { type: 'standalone', id: 'actor_child' },
              displayName: '子节点角色',
            },
          },
          {
            type: 'place_actor',
            actorId: 'actor_child',
            placement: {
              boardId: root,
              anchor: { kind: 'node', nodeId: 'child_a' },
              semanticPosition: { precision: 'inside-only' },
            },
          },
        ],
      },
      { now: NOW, source: 'user', idGen: seq() }
    )
    expect(setup.ok).toBe(true)
    if (!setup.ok) return
    state = setup.state

    const del = runBatch(
      state,
      history,
      {
        schemaVersion: 1,
        expectedRevision: state.runtime.revision,
        commands: [{ type: 'delete_node', nodeId: 'parent', strategy: 'cascade' }],
      },
      { now: NOW + 1, source: 'user', idGen: seq() }
    )
    expect(del.batch.ok).toBe(true)
    if (!del.batch.ok) return
    state = del.batch.state
    history = del.history

    const restored = undo(state, history, { now: NOW + 2, idGen: seq() })
    expect(restored.batch.ok).toBe(true)
    if (!restored.batch.ok) return
    expect(restored.batch.state.world.nodes.map((n) => n.id)).toEqual([
      'parent',
      'child_a',
      'child_b',
    ])
    expect(restored.batch.state.world.distances.map((d) => d.id)).toEqual([
      'child_distance',
    ])
    expect(restored.batch.state.runtime.placements[0].anchor).toMatchObject({
      kind: 'node',
      nodeId: 'child_a',
    })
    expect(
      hasErrors(
        validateAll(restored.batch.state.world, restored.batch.state.runtime)
      )
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

describe('文本投影', () => {
  it('相同输入产生字节级一致输出', () => {
    const state = buildCityHomeState()
    const a = projectCompactText(state.world, state.runtime, { full: true })
    const b = projectCompactText(state.world, state.runtime, { full: true })
    expect(a).toBe(b)
  })

  it('包含关键语义字段', () => {
    const state = buildCityHomeState()
    const text = projectCompactText(state.world, state.runtime, { full: true })
    expect(text).toContain('[空间状态 v1]')
    expect(text).toContain('XX 市 [region_city_x]')
    expect(text).toContain('用户家 [place_home]')
    expect(text).toContain('拥有内部画板：用户家内部')
    expect(text).toContain('精度=inside-only')
    expect(text).toContain('约 32 km')
  })
})

function buildCityHomeState(): SpatialCoreState {
  let state = emptyState('world_city_home', 'runtime_city_home')
  state.world.name = '城市与住宅'
  state.world.actors.push(
    {
      id: 'actor_user',
      kind: 'persona',
      externalRef: { type: 'standalone', id: 'user' },
      displayName: '用户',
    },
    {
      id: 'actor_lin_xue',
      kind: 'character',
      externalRef: { type: 'standalone', id: 'lin_xue' },
      displayName: '林雪',
    }
  )
  const idGen = createSeqIdGen('e')

  const cmds: SpatialCommand[] = [
    {
      type: 'create_node',
      payload: region({
        id: 'region_city_x',
        boardId: state.world.rootBoardId,
        name: 'XX 市',
        description: '用户家所在的城市。',
        tags: ['城市'],
      }),
    },
    {
      type: 'create_node',
      payload: region({
        id: 'region_city_y',
        boardId: state.world.rootBoardId,
        name: 'YY 市',
        description: '东边的另一座城市。',
        geometry: { x: 0.58, y: 0.22, width: 0.32, height: 0.48 },
      }),
    },
    {
      type: 'create_node',
      payload: place({
        id: 'place_home',
        boardId: state.world.rootBoardId,
        name: '用户家',
        description: '两层住宅',
        parentNodeId: 'region_city_x',
        childBoardId: 'board_home',
        geometry: { x: 0.22, y: 0.32 },
      }),
    },
    {
      type: 'create_node',
      payload: place({
        id: 'place_square',
        boardId: state.world.rootBoardId,
        name: '中央广场',
        parentNodeId: 'region_city_x',
        geometry: { x: 0.38, y: 0.55 },
      }),
    },
    {
      type: 'create_node',
      payload: region({
        id: 'region_floor_1',
        boardId: 'board_home',
        name: '1 楼',
        geometry: { x: 0.08, y: 0.12, width: 0.5, height: 0.72 },
      }),
    },
    {
      type: 'create_node',
      payload: place({
        id: 'place_bedroom',
        boardId: 'board_home',
        name: '卧室',
        parentNodeId: 'region_floor_1',
        geometry: { x: 0.22, y: 0.3 },
      }),
    },
    {
      type: 'create_node',
      payload: place({
        id: 'place_toilet',
        boardId: 'board_home',
        name: '厕所',
        parentNodeId: 'region_floor_1',
        geometry: { x: 0.42, y: 0.62 },
      }),
    },
    {
      type: 'create_node',
      payload: region({
        id: 'region_floor_2',
        boardId: 'board_home',
        name: '2 楼',
        geometry: { x: 0.58, y: 0.12, width: 0.34, height: 0.72 },
      }),
    },
    {
      type: 'create_distance',
      payload: distance({
        id: 'dist_city_x_y',
        boardId: state.world.rootBoardId,
        sourceNodeId: 'region_city_x',
        targetNodeId: 'region_city_y',
        name: 'XX 市至 YY 市',
        measurement: {
          value: 32,
          unit: 'km',
          displayText: '约 32 km',
          certainty: 'estimated',
        },
        travelNotes: '驾车约 40 分钟，视天气而定。',
      }),
    },
    {
      type: 'place_actor',
      actorId: 'actor_user',
      placement: {
        boardId: 'board_home',
        anchor: { kind: 'node', nodeId: 'place_bedroom' },
        semanticPosition: {
          precision: 'inside-only',
          relativeDirection: 'inside',
          note: '用户位于卧室。',
        },
      },
    },
    {
      type: 'place_actor',
      actorId: 'actor_lin_xue',
      placement: {
        boardId: state.world.rootBoardId,
        anchor: { kind: 'node', nodeId: 'region_city_y' },
        semanticPosition: {
          precision: 'approximate',
          relativeDirection: 'inside',
          note: '林雪在 YY 市内，具体地点未知。',
        },
      },
    },
  ]

  for (const cmd of cmds) {
    const r = applyCommand(state, cmd, {
      now: NOW,
      source: 'user',
      idGen,
    })
    if (!r.ok) {
      throw new Error(`buildCityHome failed at ${cmd.type}: ${r.code}`)
    }
    state = r.state
  }
  return state
}

// ---------------------------------------------------------------------------
// golden：无 UI 通过命令构建完整世界
// ---------------------------------------------------------------------------

describe('golden：命令构建 city-home 并移动角色', () => {
  it('完整世界 + 角色移动 + 校验通过 + 投影稳定', () => {
    const state = buildCityHomeState()
    expect(state.world.nodes.length).toBeGreaterThanOrEqual(8)
    expect(state.world.distances).toHaveLength(1)
    expect(state.runtime.placements).toHaveLength(2)

    const issues = validateAll(state.world, state.runtime)
    expect(hasErrors(issues)).toBe(false)

    const text = projectCompactText(state.world, state.runtime, {
      focusNodeId: 'place_bedroom',
    })
    expect(text).toContain('用户 [actor_user]')
    expect(text).toContain('卧室')
    expect(text).toContain('林雪')

    // 再移动角色
    const moved = applyCommand(
      state,
      {
        type: 'move_actor',
        actorId: 'actor_lin_xue',
        to: {
          boardId: state.world.rootBoardId,
          anchor: { kind: 'node', nodeId: 'place_home' },
          semanticPosition: {
            precision: 'inside-only',
            relativeDirection: 'inside',
            note: '林雪来到用户家',
          },
        },
        reason: 'assistant_message_explicit_arrival',
      },
      { now: NOW + 10, source: 'story', idGen: createSeqIdGen('m') }
    )
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.state.runtime.placements.find((p) => p.actorId === 'actor_lin_xue')?.semanticPosition.containmentPath).toEqual([
      'region_city_x',
      'place_home',
    ])
  })
})

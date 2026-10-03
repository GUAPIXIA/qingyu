/**
 * 关键旅程 3/4：剧情命令模拟、revision 冲突与待确认队列。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useSpatialStore } from '../src/store/spatialStore.ts'
import { BOARD_WIDTH, BOARD_HEIGHT } from '../src/canvas/adapter.ts'

function reset() {
  const s = useSpatialStore.getState()
  s.newWorld('剧情世界')
  useSpatialStore.setState({ autoMovePolicy: 'suggest', pendingSuggestions: [] })
}

function setupWorld() {
  const s = () => useSpatialStore.getState()
  const city = s().createRegionAt(
    0.1 * BOARD_WIDTH,
    0.15 * BOARD_HEIGHT,
    0.5 * BOARD_WIDTH,
    0.6 * BOARD_HEIGHT,
    'XX 市'
  )!
  const home = s().createPlaceAt(0.25 * BOARD_WIDTH, 0.35 * BOARD_HEIGHT, '用户家')!
  const boardHome = s().createInternalBoard(home)!
  const bedroom = s().createPlaceAt(0.2 * BOARD_WIDTH, 0.3 * BOARD_HEIGHT, '卧室')!
  const userId = s().createActor('用户', 'persona')!
  s().placeActorAt(userId, boardHome, 200, 200, {
    kind: 'node',
    nodeId: bedroom,
  })
  return { city, home, boardHome, bedroom, userId }
}

describe('关键旅程 3：模拟剧情命令 → 移动 → 事件 → 撤销', () => {
  beforeEach(reset)

  it('suggest 模式进入待确认，采用后移动并可撤销', () => {
    const { boardHome, bedroom, userId } = setupWorld()
    const s = () => useSpatialStore.getState()
    const rev = s().core.runtime.revision

    const decision = s().submitStoryEnvelope({
      schemaVersion: 1,
      expectedRevision: rev,
      commands: [
        {
          type: 'move_actor',
          actorId: userId,
          to: {
            boardId: boardHome,
            anchor: { kind: 'node', nodeId: bedroom },
            semanticPosition: {
              precision: 'inside-only',
              relativeDirection: 'inside',
              note: '剧情：回到卧室',
            },
          },
          reason: 'assistant_message_explicit_arrival',
        },
      ],
      summary: '用户进入卧室',
      completed: true,
      confidence: 0.95,
    })

    // suggest 默认不直接改位置
    expect(decision.code).toBe('queued')
    expect(s().pendingSuggestions).toHaveLength(1)
    expect(s().core.runtime.placements[0].semanticPosition.note).not.toBe(
      '剧情：回到卧室'
    )

    // 采用建议
    const sugId = s().pendingSuggestions[0].id
    expect(s().acceptSuggestion(sugId)).toBe(true)
    expect(s().core.runtime.placements[0].semanticPosition.note).toBe('剧情：回到卧室')

    // 事件日志
    const events = s().core.runtime.events
    expect(events.some((e) => e.source === 'story' && e.commandType === 'move_actor')).toBe(
      true
    )

    // 撤销恢复
    s().undo()
    expect(s().core.runtime.placements[0].semanticPosition.note).not.toBe(
      '剧情：回到卧室'
    )
  })

  it('auto 模式高置信直接应用', () => {
    const { boardHome, bedroom, userId } = setupWorld()
    const s = () => useSpatialStore.getState()
    s().setAutoMovePolicy('auto')

    const decision = s().submitStoryEnvelope({
      schemaVersion: 1,
      expectedRevision: s().core.runtime.revision,
      commands: [
        {
          type: 'move_actor',
          actorId: userId,
          to: {
            boardId: boardHome,
            anchor: { kind: 'node', nodeId: bedroom },
            semanticPosition: {
              precision: 'inside-only',
              relativeDirection: 'inside',
              note: '自动抵达',
            },
          },
          reason: 'assistant_message_explicit_arrival',
        },
      ],
      summary: '用户进入卧室',
      completed: true,
      confidence: 0.95,
    })
    expect(decision.code).toBe('applied')
    expect(s().core.runtime.placements[0].semanticPosition.note).toBe('自动抵达')
  })

  it('剧情命令可把角色移动到初始参考视区之外', () => {
    const { boardHome, userId } = setupWorld()
    const s = () => useSpatialStore.getState()
    s().setAutoMovePolicy('auto')

    const decision = s().submitStoryEnvelope({
      schemaVersion: 1,
      expectedRevision: s().core.runtime.revision,
      commands: [
        {
          type: 'move_actor',
          actorId: userId,
          to: {
            boardId: boardHome,
            anchor: { kind: 'board' },
            position: { x: -320, y: 1440 },
            semanticPosition: { precision: 'approximate' },
          },
          reason: 'story_moves_beyond_initial_view',
        },
      ],
      completed: true,
      confidence: 0.99,
    })

    expect(decision.code).toBe('applied')
    expect(s().core.runtime.placements.find((p) => p.actorId === userId)?.position).toEqual({
      x: -320,
      y: 1440,
    })
  })

  it('off 模式忽略命令', () => {
    const { boardHome, bedroom, userId } = setupWorld()
    const s = () => useSpatialStore.getState()
    s().setAutoMovePolicy('off')
    const before = s().core.runtime.revision
    const decision = s().submitStoryEnvelope({
      schemaVersion: 1,
      expectedRevision: before,
      commands: [
        {
          type: 'move_actor',
          actorId: userId,
          to: {
            boardId: boardHome,
            anchor: { kind: 'node', nodeId: bedroom },
            semanticPosition: { precision: 'inside-only' },
          },
        },
      ],
    })
    expect(decision.code).toBe('policy_off')
    expect(s().core.runtime.revision).toBe(before)
  })
})

describe('关键旅程 4：旧 revision 剧情命令被拒并进入建议', () => {
  beforeEach(reset)

  it('用户先移动 → 剧情用旧 revision → 进入待确认', () => {
    const { boardHome, bedroom, userId } = setupWorld()
    const s = () => useSpatialStore.getState()

    // 剧情先记下 revision
    const staleRev = s().core.runtime.revision

    // 用户手动拖动（改变 revision）
    const other = s().createPlaceAt(500, 400, '客厅')!
    s().moveActorTo(userId, boardHome, 500, 400, {
      kind: 'node',
      nodeId: other,
    })
    expect(s().core.runtime.revision).toBeGreaterThan(staleRev)

    // 剧情命令仍用旧 revision
    const decision = s().submitStoryEnvelope({
      schemaVersion: 1,
      expectedRevision: staleRev,
      commands: [
        {
          type: 'move_actor',
          actorId: userId,
          from: { nodeId: bedroom },
          to: {
            boardId: boardHome,
            anchor: { kind: 'node', nodeId: bedroom },
            semanticPosition: {
              precision: 'inside-only',
              relativeDirection: 'inside',
              note: '延迟剧情：进卧室',
            },
          },
          reason: 'assistant_message_explicit_arrival',
        },
      ],
      summary: '用户进入卧室',
      completed: true,
      confidence: 0.95,
    })

    expect(decision.code).toBe('revision_conflict')
    expect(s().pendingSuggestions).toHaveLength(1)
    expect(s().pendingSuggestions[0].reason).toBe('revision_conflict')
    // 不覆盖用户手动拖动
    expect(s().core.runtime.placements[0].anchor).toMatchObject({ nodeId: other })

    // 用户仍可显式采用
    const sugId = s().pendingSuggestions[0].id
    expect(s().acceptSuggestion(sugId)).toBe(true)
    expect(s().core.runtime.placements[0].semanticPosition.note).toBe(
      '延迟剧情：进卧室'
    )
  })
})

describe('安全闸门：未完成语气 / 创建地图 / 冲突移动', () => {
  beforeEach(reset)

  it('未完成语气不自动执行，进入建议', () => {
    const { boardHome, bedroom, userId } = setupWorld()
    const s = () => useSpatialStore.getState()
    s().setAutoMovePolicy('auto')
    const decision = s().submitStoryEnvelope({
      schemaVersion: 1,
      expectedRevision: s().core.runtime.revision,
      completed: true,
      summary: '用户可能准备去卧室',
      commands: [
        {
          type: 'move_actor',
          actorId: userId,
          to: {
            boardId: boardHome,
            anchor: { kind: 'node', nodeId: bedroom },
            semanticPosition: { precision: 'approximate' },
          },
          reason: 'maybe_later',
        },
      ],
    })
    expect(decision.code).toBe('incomplete_action')
    expect(s().pendingSuggestions).toHaveLength(1)
  })

  it('剧情不得创建地图节点', () => {
    const s = () => useSpatialStore.getState()
    const decision = s().submitStoryEnvelope({
      schemaVersion: 1,
      expectedRevision: s().core.runtime.revision,
      commands: [
        {
          type: 'create_node',
          payload: {
            id: 'region_hack',
            boardId: s().core.world.rootBoardId,
            kind: 'region',
            name: '偷偷新建',
            description: '',
            tags: [],
            parentNodeId: null,
            childBoardId: null,
            createdAt: 1,
            updatedAt: 1,
            geometry: { x: 0, y: 0, width: 0.2, height: 0.2 },
            
          },
        },
      ],
    })
    expect(decision.code).toBe('creates_map_entities')
  })

  it('同一回复冲突移动被拒', () => {
    const { boardHome, bedroom, userId } = setupWorld()
    const s = () => useSpatialStore.getState()
    const other = s().createPlaceAt(600, 200, '客厅')!
    const decision = s().submitStoryEnvelope({
      schemaVersion: 1,
      expectedRevision: s().core.runtime.revision,
      completed: true,
      commands: [
        {
          type: 'move_actor',
          actorId: userId,
          to: {
            boardId: boardHome,
            anchor: { kind: 'node', nodeId: bedroom },
            semanticPosition: { precision: 'exact' },
          },
        },
        {
          type: 'move_actor',
          actorId: userId,
          to: {
            boardId: boardHome,
            anchor: { kind: 'node', nodeId: other },
            semanticPosition: { precision: 'exact' },
          },
        },
      ],
    })
    expect(decision.code).toBe('conflicting_moves')
  })

  it('目标不存在被拒', () => {
    const { userId } = setupWorld()
    const s = () => useSpatialStore.getState()
    const decision = s().submitStoryEnvelope({
      schemaVersion: 1,
      expectedRevision: s().core.runtime.revision,
      commands: [
        {
          type: 'move_actor',
          actorId: userId,
          to: {
            boardId: s().core.world.rootBoardId,
            anchor: { kind: 'node', nodeId: 'place_missing' },
            semanticPosition: { precision: 'exact' },
          },
        },
      ],
    })
    expect(decision.code).toBe('ambiguous_or_missing_target')
  })

  it('移出不存在的角色也按目标不存在拒绝', () => {
    const s = () => useSpatialStore.getState()
    const decision = s().submitStoryEnvelope({
      schemaVersion: 1,
      expectedRevision: s().core.runtime.revision,
      commands: [
        { type: 'remove_actor_from_board', actorId: 'actor_missing' },
      ],
    })
    expect(decision.code).toBe('ambiguous_or_missing_target')
  })

  it('畸形 move_actor 命令返回 schema_invalid 而不是抛异常', () => {
    const s = () => useSpatialStore.getState()
    let decision: ReturnType<ReturnType<typeof s>['submitStoryEnvelope']> | undefined
    expect(() => {
      decision = s().submitStoryEnvelope({
        schemaVersion: 1,
        expectedRevision: s().core.runtime.revision,
        commands: [{ type: 'move_actor' }],
      })
    }).not.toThrow()
    expect(decision?.code).toBe('schema_invalid')
  })
})

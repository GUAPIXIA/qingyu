/**
 * 命令 reducer：校验 → 原子提交 → 事件 → 逆命令。
 * 纯函数；一批命令中任一失败则整批不提交。
 */
import type {
  DistanceRelation,
  PlacementSource,
  SpatialBoard,
  SpatialEvent,
  SpatialNode,
  SpatialRuntimeStateV1,
  SpatialWorldDocumentV1,
} from './model.ts'
import { IMPORT_LIMITS } from './model.ts'
import type {
  DistanceRelationPatch,
  SpatialCommand,
  SpatialCommandBatch,
  SpatialCommandErrorCode,
  SpatialNodePatch,
  SpatialWorldPatch,
} from './commands.ts'
import {
  getBoard,
  getNode,
  getNodesOnBoard,
  isAncestor,
  collectDescendants,
  getContainmentPath,
  type ValidationIssue,
} from './hierarchy.ts'
import { undirectedPairKey, validateDistanceRelation } from './distance.ts'
import { validateSubstructures } from './substructures.ts'
import { removeNodeCategories, stripNodeCategories } from './nodeFields.ts'
import {
  buildPlacement,
  validatePlacementInput,
} from './placement.ts'

export interface SpatialCoreState {
  world: SpatialWorldDocumentV1
  runtime: SpatialRuntimeStateV1
}

export interface ApplyOptions {
  now: number
  source: PlacementSource
  messageId?: string
  idGen?: () => string
}

export interface ApplySuccess {
  ok: true
  state: SpatialCoreState
  events: SpatialEvent[]
  /** 逆命令（按撤销顺序应逆序执行的列表，已按执行顺序存放；undo 时 reverse） */
  inverse: SpatialCommand[]
}

export interface ApplyFailure {
  ok: false
  code: SpatialCommandErrorCode
  message: string
  commandIndex: number
}

export type ApplyBatchResult = ApplySuccess | ApplyFailure

function fail(
  code: SpatialCommandErrorCode,
  message: string,
  commandIndex: number
): ApplyFailure {
  return { ok: false, code, message, commandIndex }
}

function cloneState(state: SpatialCoreState): SpatialCoreState {
  return structuredClone(state)
}

function issueToFailure(
  issues: ValidationIssue[],
  commandIndex: number
): ApplyFailure | null {
  const err = issues.find((i) => i.severity === 'error')
  if (!err) return null
  return fail(err.code as SpatialCommandErrorCode, err.message, commandIndex)
}

// ---------------------------------------------------------------------------
// 单命令应用（可变 draft）
// ---------------------------------------------------------------------------

interface DraftContext {
  state: SpatialCoreState
  now: number
  source: PlacementSource
  messageId?: string
  idGen: () => string
  inverse: SpatialCommand[]
  events: SpatialEvent[]
}

function pushEvent(
  ctx: DraftContext,
  commandType: SpatialCommand['type'],
  extra: Partial<SpatialEvent> = {}
): void {
  const event: SpatialEvent = {
    id: ctx.idGen(),
    runtimeId: ctx.state.runtime.runtimeId,
    revision: ctx.state.runtime.revision + 1,
    commandType,
    source: ctx.source,
    createdAt: ctx.now,
    ...(ctx.messageId ? { messageId: ctx.messageId } : {}),
    ...extra,
  }
  ctx.events.push(event)
}

function ensureChildBoard(
  ctx: DraftContext,
  node: SpatialNode
): SpatialBoard {
  const boardId = node.childBoardId
  if (!boardId) throw new Error('ensureChildBoard called without childBoardId')
  const existing = getBoard(ctx.state.world, boardId)
  if (existing) {
    if (existing.parentEntryNodeId !== node.id) {
      throw Object.assign(new Error(`子画板 ${boardId} 已绑定其它入口节点`), {
        code: 'invalid_child_board' as SpatialCommandErrorCode,
      })
    }
    return existing
  }
  const board: SpatialBoard = {
    id: boardId,
    name: `${node.name}内部`,
    description: `${node.name} 的内部空间。`,
    parentEntryNodeId: node.id,
    coordinateConvention: {
      north: 'up',
      origin: 'top-left',
      units: 'canvas',
    },
  }
  ctx.state.world.boards.push(board)
  return board
}

function applyUpdateWorld(
  ctx: DraftContext,
  cmd: Extract<SpatialCommand, { type: 'update_world' }>
): SpatialCommandErrorCode | null {
  const patch = cmd.patch
  if (patch.name !== undefined && patch.name.trim().length === 0) {
    return 'name_empty'
  }

  const inverse: SpatialWorldPatch = {}
  if (patch.name !== undefined) inverse.name = ctx.state.world.name
  if (patch.description !== undefined) {
    inverse.description = ctx.state.world.description
  }
  if (patch.name !== undefined) ctx.state.world.name = patch.name
  if (patch.description !== undefined) {
    ctx.state.world.description = patch.description
  }
  ctx.state.world.metadata = { ...ctx.state.world.metadata, updatedAt: ctx.now }

  ctx.inverse.push({ type: 'update_world', patch: inverse })
  pushEvent(ctx, 'update_world')
  return null
}

function applyCreateNode(
  ctx: DraftContext,
  cmd: Extract<SpatialCommand, { type: 'create_node' }>
): SpatialCommandErrorCode | null {
  const payload = stripNodeCategories(structuredClone(cmd.payload))
  if (payload.name.trim().length === 0) return 'name_empty'
  if (getNode(ctx.state.world, payload.id)) return 'schema_invalid'
  if (!getBoard(ctx.state.world, payload.boardId)) return 'board_not_found'

  if (payload.parentNodeId) {
    const parent = getNode(ctx.state.world, payload.parentNodeId)
    if (!parent) return 'invalid_parent'
    // region 只能挂在 region 下；place 可挂 region 或主地点（直属子结构）。
    if (parent.kind === 'place' && payload.kind === 'region') return 'invalid_parent'
    if (parent.boardId !== payload.boardId) return 'invalid_parent'
  }

  // 无限画布仍只接受有限坐标；区域宽高必须为正。
  if (payload.kind === 'region') {
    const g = payload.geometry
    if (
      !Number.isFinite(g.x) ||
      !Number.isFinite(g.y) ||
      !Number.isFinite(g.width) ||
      !Number.isFinite(g.height) ||
      g.width <= 0 ||
      g.height <= 0
    ) {
      return 'invalid_geometry'
    }
  } else {
    const g = payload.geometry
    if (!Number.isFinite(g.x) || !Number.isFinite(g.y)) return 'invalid_geometry'
  }

  try {
    if (payload.childBoardId) ensureChildBoard(ctx, payload)
  } catch {
    return 'invalid_child_board'
  }

  ctx.state.world.nodes.push(payload)
  const inverse: SpatialCommand = {
    type: 'delete_node',
    nodeId: payload.id,
    strategy: 'cascade',
  }
  ctx.inverse.push(inverse)
  pushEvent(ctx, 'create_node')
  return null
}

function invertNodePatch(
  node: SpatialNode,
  patch: SpatialNodePatch
): SpatialNodePatch {
  const inv: SpatialNodePatch = {}
  if (patch.name !== undefined) inv.name = node.name
  if (patch.description !== undefined) inv.description = node.description
  if (patch.tags !== undefined) inv.tags = [...node.tags]
  if (patch.parentNodeId !== undefined) inv.parentNodeId = node.parentNodeId
  if (patch.childBoardId !== undefined) inv.childBoardId = node.childBoardId
  if (patch.iconKey !== undefined && node.kind === 'place') {
    inv.iconKey = node.iconKey
  }
  if (patch.childLayout !== undefined && node.kind === 'place') {
    inv.childLayout = node.childLayout ?? 'row'
  }
  if (patch.geometry !== undefined) {
    inv.geometry = {}
    const g = patch.geometry
    if (g.x !== undefined) inv.geometry.x = node.geometry.x
    if (g.y !== undefined) inv.geometry.y = node.geometry.y
    if (g.width !== undefined && node.kind === 'region') {
      inv.geometry.width = node.geometry.width
    }
    if (g.height !== undefined && node.kind === 'region') {
      inv.geometry.height = node.geometry.height
    }
  }
  return inv
}

function applyUpdateNode(
  ctx: DraftContext,
  cmd: Extract<SpatialCommand, { type: 'update_node' }>
): SpatialCommandErrorCode | null {
  const node = getNode(ctx.state.world, cmd.nodeId)
  if (!node) return 'node_not_found'
  const patch = cmd.patch
  const inversePatch = invertNodePatch(node, patch)

  if (patch.name !== undefined && patch.name.trim().length === 0) {
    return 'name_empty'
  }

  if (patch.parentNodeId !== undefined) {
    if (patch.parentNodeId === node.id) return 'cycle_detected'
    if (patch.parentNodeId !== null) {
      const parent = getNode(ctx.state.world, patch.parentNodeId)
      if (!parent || parent.boardId !== node.boardId) {
        return 'invalid_parent'
      }
      if (parent.kind === 'place' && node.kind === 'region') {
        return 'invalid_parent'
      }
      if (isAncestor(ctx.state.world, node.id, patch.parentNodeId)) {
        return 'cycle_detected'
      }
    }
  }

  if (patch.childBoardId !== undefined && patch.childBoardId !== null) {
    const existing = getBoard(ctx.state.world, patch.childBoardId)
    if (existing && existing.parentEntryNodeId !== null && existing.parentEntryNodeId !== node.id) {
      return 'invalid_child_board'
    }
  }

  if (patch.name !== undefined) node.name = patch.name
  if (patch.description !== undefined) node.description = patch.description
  if (patch.tags !== undefined) node.tags = [...patch.tags]
  if (patch.parentNodeId !== undefined) node.parentNodeId = patch.parentNodeId
  if (patch.iconKey !== undefined && node.kind === 'place') {
    node.iconKey = patch.iconKey
  }
  if (patch.childLayout !== undefined && node.kind === 'place') {
    node.childLayout = patch.childLayout
  }
  if (patch.geometry !== undefined) {
    const g = patch.geometry
    if (g.x !== undefined) node.geometry.x = g.x
    if (g.y !== undefined) node.geometry.y = g.y
    if (g.width !== undefined && node.kind === 'region') node.geometry.width = g.width
    if (g.height !== undefined && node.kind === 'region') node.geometry.height = g.height
    const ng = node.geometry
    if (!Number.isFinite(ng.x) || !Number.isFinite(ng.y)) {
      return 'invalid_geometry'
    }
    if (node.kind === 'region') {
      const rg = node.geometry
      if (
        !Number.isFinite(rg.width) ||
        !Number.isFinite(rg.height) ||
        rg.width <= 0 ||
        rg.height <= 0
      ) {
        return 'invalid_geometry'
      }
    }
  }

  if (patch.childBoardId !== undefined) {
    const prev = node.childBoardId
    if (patch.childBoardId === null) {
      // 解除绑定：仅当原画板无内容时允许，否则拒绝
      if (prev) {
        const board = getBoard(ctx.state.world, prev)
        if (board) {
          const contents = getNodesOnBoard(ctx.state.world, prev)
          if (contents.length > 0) return 'invalid_child_board'
          // 移除空画板
          ctx.state.world.boards = ctx.state.world.boards.filter((b) => b.id !== prev)
        }
      }
      node.childBoardId = null
    } else {
      node.childBoardId = patch.childBoardId
      try {
        ensureChildBoard(ctx, node)
      } catch {
        node.childBoardId = prev
        return 'invalid_child_board'
      }
    }
  }

  node.updatedAt = ctx.now
  ctx.inverse.push({ type: 'update_node', nodeId: node.id, patch: inversePatch })
  pushEvent(ctx, 'update_node')
  return null
}

function snapshotNode(node: SpatialNode): SpatialNode {
  return structuredClone(node)
}

function applyDeleteNode(
  ctx: DraftContext,
  cmd: Extract<SpatialCommand, { type: 'delete_node' }>
): SpatialCommandErrorCode | null {
  const node = getNode(ctx.state.world, cmd.nodeId)
  if (!node) return 'node_not_found'

  const descendants = collectDescendants(ctx.state.world, cmd.nodeId)
  const toDelete = new Set([cmd.nodeId, ...descendants])
  const boardsToDelete = new Set(
    ctx.state.world.boards
      .filter(
        (b) => b.parentEntryNodeId !== null && toDelete.has(b.parentEntryNodeId)
      )
      .map((b) => b.id)
  )

  // 占用检查必须覆盖整个级联子树，而不只是入口节点本身。
  const placements = ctx.state.runtime.placements.filter((p) => {
    const anchoredInSubtree =
      p.anchor.kind === 'node' &&
      p.anchor.nodeId !== undefined &&
      toDelete.has(p.anchor.nodeId)
    return anchoredInSubtree || boardsToDelete.has(p.boardId)
  })
  const relatedDistances = ctx.state.world.distances.filter(
    (d) => toDelete.has(d.sourceNodeId) || toDelete.has(d.targetNodeId)
  )
  const hasChildContent =
    descendants.length > 0 || relatedDistances.length > 0

  if (cmd.strategy === 'reject-if-not-empty') {
    if (hasChildContent || placements.length > 0) return 'node_not_empty'
  }

  // 收集删除快照（用于逆命令）
  const deletedNodes: SpatialNode[] = [snapshotNode(node)]
  for (const id of descendants) {
    const n = getNode(ctx.state.world, id)
    if (n) deletedNodes.push(snapshotNode(n))
  }
  const deletedDistances = relatedDistances.map((d) => structuredClone(d))
  const removedPlacements = placements.map((p) => structuredClone(p))

  // 删除距离
  ctx.state.world.distances = ctx.state.world.distances.filter(
    (d) => !relatedDistances.some((x) => x.id === d.id)
  )

  // 移出角色
  for (const p of placements) {
    ctx.state.runtime.placements = ctx.state.runtime.placements.filter(
      (x) => x.actorId !== p.actorId
    )
  }

  // 删除节点
  ctx.state.world.nodes = ctx.state.world.nodes.filter((n) => !toDelete.has(n.id))

  // 删除关联子画板（入口节点被删）
  ctx.state.world.boards = ctx.state.world.boards.filter(
    (b) => !boardsToDelete.has(b.id)
  )

  // 逆命令的期望执行顺序：节点（父→子）→距离→位置。
  // History.undo 会反转整个 inverse，因此这里按期望执行顺序的逆序保存。
  const restoreCommands: SpatialCommand[] = []
  // 先重建无父的，按删除顺序逆序创建更安全：从根到叶是 deletedNodes 的顺序（先自身后后代）
  // 但 create 需要父已存在，所以正序创建（自身可能引用父）；父若也被删会在同一列表更前面
  // deletedNodes[0] 是目标节点，其父可能仍在；后代的父也在列表中
  // 为安全：先创建 parentNodeId 不在删除集合中的，再创建其余
  const deletedIds = new Set(deletedNodes.map((n) => n.id))
  const firstPass = deletedNodes.filter((n) => !n.parentNodeId || !deletedIds.has(n.parentNodeId))
  const secondPass = deletedNodes.filter((n) => n.parentNodeId && deletedIds.has(n.parentNodeId))
  for (const n of [...firstPass, ...secondPass]) {
    restoreCommands.push({ type: 'create_node', payload: n })
  }
  for (const d of deletedDistances) {
    restoreCommands.push({ type: 'create_distance', payload: d })
  }
  for (const p of removedPlacements) {
    restoreCommands.push({
      type: 'place_actor',
      actorId: p.actorId,
      placement: {
        boardId: p.boardId,
        anchor: p.anchor,
        position: p.position,
        semanticPosition: {
          ...(p.semanticPosition.relativeToNodeId
            ? { relativeToNodeId: p.semanticPosition.relativeToNodeId }
            : {}),
          ...(p.semanticPosition.relativeDirection
            ? { relativeDirection: p.semanticPosition.relativeDirection }
            : {}),
          precision: p.semanticPosition.precision,
          ...(p.semanticPosition.note ? { note: p.semanticPosition.note } : {}),
        },
      },
    })
  }
  ctx.inverse.push(...restoreCommands.reverse())
  pushEvent(ctx, 'delete_node')
  return null
}

function applyCreateDistance(
  ctx: DraftContext,
  cmd: Extract<SpatialCommand, { type: 'create_distance' }>
): SpatialCommandErrorCode | null {
  const payload = structuredClone(cmd.payload)
  if (getNode(ctx.state.world, payload.id)) return 'schema_invalid'
  const issues = validateDistanceRelation(ctx.state.world, payload)
  const bad = issues.find((i) => i.severity === 'error')
  if (bad) return bad.code as SpatialCommandErrorCode

  // 无向去重
  const key = undirectedPairKey(payload.sourceNodeId, payload.targetNodeId)
  const dup = ctx.state.world.distances.find(
    (d) => undirectedPairKey(d.sourceNodeId, d.targetNodeId) === key
  )
  if (dup) return 'duplicate_distance'

  ctx.state.world.distances.push(payload)
  ctx.inverse.push({ type: 'delete_distance', relationId: payload.id })
  pushEvent(ctx, 'create_distance')
  return null
}

function invertDistancePatch(
  rel: DistanceRelation,
  patch: DistanceRelationPatch
): DistanceRelationPatch {
  const inv: DistanceRelationPatch = {}
  if (patch.name !== undefined) inv.name = rel.name
  if (patch.description !== undefined) inv.description = rel.description
  if (patch.sourceNodeId !== undefined) inv.sourceNodeId = rel.sourceNodeId
  if (patch.targetNodeId !== undefined) inv.targetNodeId = rel.targetNodeId
  if (patch.travelNotes !== undefined) {
    inv.travelNotes = rel.travelNotes ?? null
  }
  if (patch.measurement !== undefined) {
    inv.measurement = {}
    const m = patch.measurement
    if (m.value !== undefined) inv.measurement.value = rel.measurement.value
    if (m.unit !== undefined) inv.measurement.unit = rel.measurement.unit
    if (m.customUnit !== undefined) {
      inv.measurement.customUnit = rel.measurement.customUnit ?? null
    }
    if (m.displayText !== undefined) inv.measurement.displayText = rel.measurement.displayText
    if (m.certainty !== undefined) inv.measurement.certainty = rel.measurement.certainty
  }
  return inv
}

function applyUpdateDistance(
  ctx: DraftContext,
  cmd: Extract<SpatialCommand, { type: 'update_distance' }>
): SpatialCommandErrorCode | null {
  const rel = ctx.state.world.distances.find((d) => d.id === cmd.relationId)
  if (!rel) return 'distance_not_found'
  const inv = invertDistancePatch(rel, cmd.patch)
  const patch = cmd.patch

  if (patch.name !== undefined && patch.name.trim().length === 0) return 'name_empty'
  if (patch.name !== undefined) rel.name = patch.name
  if (patch.description !== undefined) rel.description = patch.description
  if (patch.travelNotes !== undefined) {
    if (patch.travelNotes === null) delete rel.travelNotes
    else rel.travelNotes = patch.travelNotes
  }
  if (patch.sourceNodeId !== undefined) rel.sourceNodeId = patch.sourceNodeId
  if (patch.targetNodeId !== undefined) rel.targetNodeId = patch.targetNodeId
  if (patch.measurement !== undefined) {
    const m = patch.measurement
    if (m.value !== undefined) rel.measurement.value = m.value
    if (m.unit !== undefined) rel.measurement.unit = m.unit
    if (m.customUnit !== undefined) {
      if (m.customUnit === null) delete rel.measurement.customUnit
      else rel.measurement.customUnit = m.customUnit
    }
    if (m.displayText !== undefined) rel.measurement.displayText = m.displayText
    if (m.certainty !== undefined) rel.measurement.certainty = m.certainty
  }

  const issues = validateDistanceRelation(ctx.state.world, rel)
  const bad = issues.find((i) => i.severity === 'error')
  if (bad) {
    // 无法在此回滚 draft，由外层整批丢弃保证原子性
    return bad.code as SpatialCommandErrorCode
  }

  rel.updatedAt = ctx.now
  ctx.inverse.push({ type: 'update_distance', relationId: rel.id, patch: inv })
  pushEvent(ctx, 'update_distance')
  return null
}

function applyDeleteDistance(
  ctx: DraftContext,
  cmd: Extract<SpatialCommand, { type: 'delete_distance' }>
): SpatialCommandErrorCode | null {
  const idx = ctx.state.world.distances.findIndex((d) => d.id === cmd.relationId)
  if (idx < 0) return 'distance_not_found'
  const rel = ctx.state.world.distances[idx]
  ctx.state.world.distances.splice(idx, 1)
  ctx.inverse.push({ type: 'create_distance', payload: structuredClone(rel) })
  pushEvent(ctx, 'delete_distance')
  return null
}

function applyCreateActor(
  ctx: DraftContext,
  cmd: Extract<SpatialCommand, { type: 'create_actor' }>
): SpatialCommandErrorCode | null {
  const payload = structuredClone(cmd.payload)
  if (payload.displayName.trim().length === 0) return 'name_empty'
  if (ctx.state.world.actors.some((a) => a.id === payload.id)) return 'schema_invalid'
  ctx.state.world.actors.push(payload)
  ctx.inverse.push({ type: 'delete_actor', actorId: payload.id })
  pushEvent(ctx, 'create_actor')
  return null
}

function applyUpdateActor(
  ctx: DraftContext,
  cmd: Extract<SpatialCommand, { type: 'update_actor' }>
): SpatialCommandErrorCode | null {
  const actor = ctx.state.world.actors.find((a) => a.id === cmd.actorId)
  if (!actor) return 'actor_not_found'
  const patch = cmd.patch
  const inverse: SpatialCommand = {
    type: 'update_actor',
    actorId: actor.id,
    patch: {},
  }
  const invPatch = inverse as Extract<SpatialCommand, { type: 'update_actor' }>

  if (patch.displayName !== undefined) {
    if (patch.displayName.trim().length === 0) return 'name_empty'
    invPatch.patch.displayName = actor.displayName
    actor.displayName = patch.displayName
  }
  if (patch.description !== undefined) {
    invPatch.patch.description = actor.description ?? null
    if (patch.description === null) delete actor.description
    else actor.description = patch.description
  }
  if (patch.avatarAssetRef !== undefined) {
    invPatch.patch.avatarAssetRef = actor.avatarAssetRef ?? null
    if (patch.avatarAssetRef === null) delete actor.avatarAssetRef
    else actor.avatarAssetRef = patch.avatarAssetRef
  }
  if (patch.kind !== undefined) {
    invPatch.patch.kind = actor.kind
    actor.kind = patch.kind
  }
  if (patch.externalRef !== undefined) {
    invPatch.patch.externalRef = structuredClone(actor.externalRef)
    actor.externalRef = structuredClone(patch.externalRef)
  }

  ctx.inverse.push(invPatch)
  pushEvent(ctx, 'update_actor')
  return null
}

function applyDeleteActor(
  ctx: DraftContext,
  cmd: Extract<SpatialCommand, { type: 'delete_actor' }>
): SpatialCommandErrorCode | null {
  const idx = ctx.state.world.actors.findIndex((a) => a.id === cmd.actorId)
  if (idx < 0) return 'actor_not_found'
  const actor = ctx.state.world.actors[idx]
  // 同步移出位置
  const before =
    ctx.state.runtime.placements.find((p) => p.actorId === cmd.actorId) ?? null
  ctx.state.runtime.placements = ctx.state.runtime.placements.filter(
    (p) => p.actorId !== cmd.actorId
  )
  ctx.state.world.actors.splice(idx, 1)

  const restoreCommands: SpatialCommand[] = [
    { type: 'create_actor', payload: structuredClone(actor) },
  ]
  if (before) {
    restoreCommands.push({
      type: 'place_actor',
      actorId: before.actorId,
      placement: {
        boardId: before.boardId,
        anchor: before.anchor,
        position: before.position,
        semanticPosition: {
          ...(before.semanticPosition.relativeToNodeId
            ? { relativeToNodeId: before.semanticPosition.relativeToNodeId }
            : {}),
          ...(before.semanticPosition.relativeDirection
            ? { relativeDirection: before.semanticPosition.relativeDirection }
            : {}),
          precision: before.semanticPosition.precision,
          ...(before.semanticPosition.note
            ? { note: before.semanticPosition.note }
            : {}),
        },
      },
    })
  }
  // History.undo 会反转 inverse；复合恢复命令需先按执行顺序的逆序保存。
  ctx.inverse.push(...restoreCommands.reverse())
  pushEvent(ctx, 'delete_actor', {
    actorId: cmd.actorId,
    before: before ? structuredClone(before) : null,
    after: null,
  })
  return null
}

function applyPlaceActor(
  ctx: DraftContext,
  cmd: Extract<SpatialCommand, { type: 'place_actor' }>
): SpatialCommandErrorCode | null {
  const actor = ctx.state.world.actors.find((a) => a.id === cmd.actorId)
  if (!actor) return 'actor_not_found'

  const issues = validatePlacementInput(ctx.state.world, cmd.placement)
  const bad = issueToFailure(issues, -1)
  if (bad) return bad.code

  const before =
    ctx.state.runtime.placements.find((p) => p.actorId === cmd.actorId) ?? null

  const after = buildPlacement(ctx.state.world, cmd.actorId, cmd.placement, {
    revision: ctx.state.runtime.revision + 1,
    updatedAt: ctx.now,
    updatedBy: ctx.source,
  })

  // replace
  ctx.state.runtime.placements = ctx.state.runtime.placements.filter(
    (p) => p.actorId !== cmd.actorId
  )
  ctx.state.runtime.placements.push(after)

  if (before) {
    ctx.inverse.push({
      type: 'move_actor',
      actorId: cmd.actorId,
      to: {
        boardId: before.boardId,
        anchor: before.anchor,
        position: before.position,
        semanticPosition: {
          ...(before.semanticPosition.relativeToNodeId
            ? { relativeToNodeId: before.semanticPosition.relativeToNodeId }
            : {}),
          ...(before.semanticPosition.relativeDirection
            ? { relativeDirection: before.semanticPosition.relativeDirection }
            : {}),
          precision: before.semanticPosition.precision,
          ...(before.semanticPosition.note
            ? { note: before.semanticPosition.note }
            : {}),
        },
      },
    })
  } else {
    ctx.inverse.push({ type: 'remove_actor_from_board', actorId: cmd.actorId })
  }

  pushEvent(ctx, 'place_actor', {
    actorId: cmd.actorId,
    before: before ? structuredClone(before) : null,
    after: structuredClone(after),
  })
  return null
}

function applyMoveActor(
  ctx: DraftContext,
  cmd: Extract<SpatialCommand, { type: 'move_actor' }>
): SpatialCommandErrorCode | null {
  const actor = ctx.state.world.actors.find((a) => a.id === cmd.actorId)
  if (!actor) return 'actor_not_found'

  const before =
    ctx.state.runtime.placements.find((p) => p.actorId === cmd.actorId) ?? null

  if (cmd.from) {
    if (cmd.from.revision !== undefined && before && before.revision !== cmd.from.revision) {
      return 'guard_mismatch'
    }
    if (cmd.from.boardId !== undefined) {
      if (!before || before.boardId !== cmd.from.boardId) return 'guard_mismatch'
    }
    if (cmd.from.nodeId !== undefined) {
      const beforeNode =
        before?.anchor.kind === 'node' ? before.anchor.nodeId : undefined
      if (beforeNode !== cmd.from.nodeId) return 'guard_mismatch'
    }
  }

  const issues = validatePlacementInput(ctx.state.world, cmd.to)
  const bad = issueToFailure(issues, -1)
  if (bad) return bad.code

  const after = buildPlacement(ctx.state.world, cmd.actorId, cmd.to, {
    revision: ctx.state.runtime.revision + 1,
    updatedAt: ctx.now,
    updatedBy: ctx.source,
  })

  ctx.state.runtime.placements = ctx.state.runtime.placements.filter(
    (p) => p.actorId !== cmd.actorId
  )
  ctx.state.runtime.placements.push(after)

  if (before) {
    ctx.inverse.push({
      type: 'move_actor',
      actorId: cmd.actorId,
      to: {
        boardId: before.boardId,
        anchor: before.anchor,
        position: before.position,
        semanticPosition: {
          ...(before.semanticPosition.relativeToNodeId
            ? { relativeToNodeId: before.semanticPosition.relativeToNodeId }
            : {}),
          ...(before.semanticPosition.relativeDirection
            ? { relativeDirection: before.semanticPosition.relativeDirection }
            : {}),
          precision: before.semanticPosition.precision,
          ...(before.semanticPosition.note
            ? { note: before.semanticPosition.note }
            : {}),
        },
      },
    })
  } else {
    ctx.inverse.push({ type: 'remove_actor_from_board', actorId: cmd.actorId })
  }

  pushEvent(ctx, 'move_actor', {
    actorId: cmd.actorId,
    before: before ? structuredClone(before) : null,
    after: structuredClone(after),
    ...(cmd.reason ? { reason: cmd.reason } : {}),
  })
  return null
}

function applyRemoveActor(
  ctx: DraftContext,
  cmd: Extract<SpatialCommand, { type: 'remove_actor_from_board' }>
): SpatialCommandErrorCode | null {
  const before =
    ctx.state.runtime.placements.find((p) => p.actorId === cmd.actorId) ?? null
  if (!before) return 'actor_not_found'

  ctx.state.runtime.placements = ctx.state.runtime.placements.filter(
    (p) => p.actorId !== cmd.actorId
  )

  ctx.inverse.push({
    type: 'place_actor',
    actorId: cmd.actorId,
    placement: {
      boardId: before.boardId,
      anchor: before.anchor,
      position: before.position,
      semanticPosition: {
        ...(before.semanticPosition.relativeToNodeId
          ? { relativeToNodeId: before.semanticPosition.relativeToNodeId }
          : {}),
        ...(before.semanticPosition.relativeDirection
          ? { relativeDirection: before.semanticPosition.relativeDirection }
          : {}),
        precision: before.semanticPosition.precision,
        ...(before.semanticPosition.note
          ? { note: before.semanticPosition.note }
          : {}),
      },
    },
  })

  pushEvent(ctx, 'remove_actor_from_board', {
    actorId: cmd.actorId,
    before: structuredClone(before),
    after: null,
  })
  return null
}

function applyOne(
  ctx: DraftContext,
  cmd: SpatialCommand
): SpatialCommandErrorCode | null {
  switch (cmd.type) {
    case 'update_world':
      return applyUpdateWorld(ctx, cmd)
    case 'create_node':
      return applyCreateNode(ctx, cmd)
    case 'update_node':
      return applyUpdateNode(ctx, cmd)
    case 'delete_node':
      return applyDeleteNode(ctx, cmd)
    case 'create_distance':
      return applyCreateDistance(ctx, cmd)
    case 'update_distance':
      return applyUpdateDistance(ctx, cmd)
    case 'delete_distance':
      return applyDeleteDistance(ctx, cmd)
    case 'create_actor':
      return applyCreateActor(ctx, cmd)
    case 'update_actor':
      return applyUpdateActor(ctx, cmd)
    case 'delete_actor':
      return applyDeleteActor(ctx, cmd)
    case 'place_actor':
      return applyPlaceActor(ctx, cmd)
    case 'move_actor':
      return applyMoveActor(ctx, cmd)
    case 'remove_actor_from_board':
      return applyRemoveActor(ctx, cmd)
    default:
      return 'schema_invalid'
  }
}

// ---------------------------------------------------------------------------
// 批量入口
// ---------------------------------------------------------------------------

export function applyCommandBatch(
  state: SpatialCoreState,
  batch: SpatialCommandBatch,
  options: ApplyOptions
): ApplyBatchResult {
  if (!batch.commands || batch.commands.length === 0) {
    return fail('batch_empty', '命令批次为空', -1)
  }

  if (batch.expectedRevision !== state.runtime.revision) {
    return fail(
      'revision_conflict',
      `expectedRevision=${batch.expectedRevision} 与当前 revision=${state.runtime.revision} 不一致`,
      -1
    )
  }

  const draft = cloneState(state)
  draft.world = removeNodeCategories(draft.world).world
  const ctx: DraftContext = {
    state: draft,
    now: options.now,
    source: options.source,
    idGen: options.idGen ?? (() => `evt_${Math.random().toString(36).slice(2, 10)}`),
    inverse: [],
    events: [],
  }
  if (options.messageId) ctx.messageId = options.messageId

  for (let i = 0; i < batch.commands.length; i += 1) {
    const code = applyOne(ctx, batch.commands[i])
    if (code) {
      return fail(code, `命令 #${i}（${batch.commands[i].type}）失败`, i)
    }
  }

  const structureIssue = validateSubstructures(draft.world)[0]
  if (structureIssue) return fail('invalid_parent', structureIssue.message, batch.commands.length - 1)

  // 上级调整改变包含路径，但角色仍停留在原地点。批次结束后按最终层级重算，
  // 避免依赖 UI 额外发送 move_actor，也不干扰同一批次中的位置版本检查。
  if (batch.commands.some(command => command.type === 'update_node' &&
    (command.patch.parentNodeId !== undefined || command.patch.childBoardId !== undefined))) {
    for (const placement of draft.runtime.placements) {
      const path = getContainmentPath(draft.world, placement.boardId,
        placement.anchor.kind === 'node' ? placement.anchor.nodeId ?? null : null)
      if (path.length === placement.semanticPosition.containmentPath.length &&
        path.every((id, index) => id === placement.semanticPosition.containmentPath[index])) continue
      placement.semanticPosition.containmentPath = path
      placement.revision = draft.runtime.revision + 1
      placement.updatedAt = options.now
      placement.updatedBy = options.source
    }
  }

  // 原子提交：revision +1，写入事件（保留最近 500 条）
  draft.runtime.revision += 1
  draft.runtime.updatedAt = options.now
  draft.world.metadata.updatedAt = options.now

  const events = [...draft.runtime.events, ...ctx.events]
  draft.runtime.events = events.slice(-IMPORT_LIMITS.maxEvents)

  return {
    ok: true,
    state: draft,
    events: ctx.events,
    inverse: ctx.inverse,
  }
}

/** 便捷：应用单条命令 */
export function applyCommand(
  state: SpatialCoreState,
  command: SpatialCommand,
  options: ApplyOptions & { expectedRevision?: number }
): ApplyBatchResult {
  return applyCommandBatch(
    state,
    {
      schemaVersion: 1,
      expectedRevision:
        options.expectedRevision ?? state.runtime.revision,
      commands: [command],
    },
    options
  )
}

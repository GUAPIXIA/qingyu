/**
 * 空间命令协议（v1）——所有变更（UI / 剧情 / 导入）都通过 SpatialCommand 进入核心。
 * 与 schemas/spatial-command-v1.schema.json 保持一致。
 */

import type {
  ActorPlacement,
  AnchorKind,
  ChildLayout,
  DistanceCertainty,
  DistanceRelation,
  DistanceUnit,
  CanvasPoint,
  PlacementPrecision,
  PlacementSource,
  RelativeDirection,
  SpatialActor,
  SpatialActorExternalRef,
  SpatialNode,
} from './model.ts'

// ---------------------------------------------------------------------------
// Patch 类型（update_* 用；只允许修改可编辑字段）
// ---------------------------------------------------------------------------

export interface CanvasRectPatch {
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface CanvasPointPatch {
  x?: number
  y?: number
}

export interface SpatialNodePatch {
  name?: string
  description?: string
  tags?: string[]
  parentNodeId?: string | null
  childBoardId?: string | null
  /** place 专用：子地点排列方向（row 横向 / column 纵向） */
  childLayout?: ChildLayout
  iconKey?: string
  geometry?: CanvasRectPatch & CanvasPointPatch
}

export interface DistanceMeasurementPatch {
  value?: number | null
  unit?: DistanceUnit
  customUnit?: string | null
  displayText?: string
  certainty?: DistanceCertainty
}

export interface DistanceRelationPatch {
  name?: string
  description?: string
  measurement?: DistanceMeasurementPatch
  travelNotes?: string | null
  sourceNodeId?: string
  targetNodeId?: string
}

/** 世界文档级可编辑字段（boards/nodes/distances/actors 各有专门指令） */
export interface SpatialWorldPatch {
  name?: string
  description?: string
}

// ---------------------------------------------------------------------------
// Actor 放置输入（命令载荷；revision / updatedAt / containmentPath 由核心写入）
// ---------------------------------------------------------------------------

export interface PlacementAnchorInput {
  kind: AnchorKind
  /** kind === 'node' 时必填 */
  nodeId?: string
}

export interface SemanticPositionInput {
  relativeToNodeId?: string
  relativeDirection?: RelativeDirection
  precision: PlacementPrecision
  note?: string
}

export interface ActorPlacementInput {
  boardId: string
  anchor: PlacementAnchorInput
  /** 可省略；核心可按锚点推导 */
  position?: CanvasPoint
  semanticPosition?: SemanticPositionInput
}

/** move_actor 的 from 守卫：用于乐观校验，不匹配则命令失败 */
export interface PlacementGuard {
  boardId?: string
  nodeId?: string
  revision?: number
}

export interface SpatialActorPatch {
  displayName?: string
  description?: string | null
  avatarAssetRef?: string | null
  kind?: 'persona' | 'character'
  externalRef?: SpatialActorExternalRef
}

// ---------------------------------------------------------------------------
// 命令联合
// ---------------------------------------------------------------------------

export type SpatialCommand =
  | { type: 'update_world'; patch: SpatialWorldPatch }
  | { type: 'create_node'; payload: SpatialNode }
  | { type: 'update_node'; nodeId: string; patch: SpatialNodePatch }
  | {
      type: 'delete_node'
      nodeId: string
      strategy: 'reject-if-not-empty' | 'cascade'
    }
  | { type: 'create_distance'; payload: DistanceRelation }
  | { type: 'update_distance'; relationId: string; patch: DistanceRelationPatch }
  | { type: 'delete_distance'; relationId: string }
  | { type: 'create_actor'; payload: SpatialActor }
  | { type: 'update_actor'; actorId: string; patch: SpatialActorPatch }
  | { type: 'delete_actor'; actorId: string }
  | { type: 'place_actor'; actorId: string; placement: ActorPlacementInput }
  | {
      type: 'move_actor'
      actorId: string
      from?: PlacementGuard
      to: ActorPlacementInput
      reason?: string
    }
  | { type: 'remove_actor_from_board'; actorId: string }

/**
 * 命令批次：所有运行时命令携带 expectedRevision。
 * 版本不一致时返回冲突，不覆盖较新的用户拖动结果。
 */
export interface SpatialCommandBatch {
  schemaVersion: 1
  expectedRevision: number
  commands: SpatialCommand[]
}

/** 命令应用结果（阶段 1 reducer 使用） */
export type SpatialCommandResult =
  | {
      ok: true
      world?: SpatialNode | DistanceRelation | null
      placement?: ActorPlacement | null
      revision: number
    }
  | {
      ok: false
      code: SpatialCommandErrorCode
      message: string
    }

export type SpatialCommandErrorCode =
  | 'revision_conflict'
  | 'actor_not_found'
  | 'board_not_found'
  | 'node_not_found'
  | 'distance_not_found'
  | 'invalid_parent'
  | 'cycle_detected'
  | 'cross_kind_distance'
  | 'cross_board_distance'
  | 'duplicate_distance'
  | 'self_distance'
  | 'node_not_empty'
  | 'invalid_geometry'
  | 'schema_invalid'
  | 'guard_mismatch'
  | 'name_empty'
  | 'invalid_child_board'
  | 'invalid_anchor'
  | 'anchor_board_mismatch'
  | 'invalid_distance_value'
  | 'distance_display_required'
  | 'distance_custom_unit_required'
  | 'batch_empty'

export type { PlacementSource }

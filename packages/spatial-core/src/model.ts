/**
 * 空间画板领域模型（v1）——纯类型契约，不依赖 React / Electron / DOM。
 * 与 schemas/spatial-world-v1.schema.json 等保持一致；修改时两边同步。
 */

// ---------------------------------------------------------------------------
// 基础枚举
// ---------------------------------------------------------------------------

export type SpatialNodeKind = 'region' | 'place'

export type DistanceUnit = 'm' | 'km' | 'au' | 'ly' | 'custom'

export type DistanceCertainty = 'exact' | 'estimated' | 'unknown'

export type ActorKind = 'persona' | 'character'

export type ActorExternalRefType = 'qingyu-persona' | 'qingyu-character' | 'standalone'

export type RelativeDirection =
  | 'north'
  | 'north-east'
  | 'east'
  | 'south-east'
  | 'south'
  | 'south-west'
  | 'west'
  | 'north-west'
  | 'center'
  | 'inside'
  | 'nearby'

export type PlacementPrecision = 'exact' | 'approximate' | 'inside-only' | 'unknown'

export type PlacementSource = 'user' | 'story' | 'import' | 'system'

export type AnchorKind = 'board' | 'node'

/** 系统默认区域：位于其中的角色不参与当前对话。 */
export const OFFSTAGE_REGION_TAG = 'system:offstage'
/** “未参与对话”区域的默认名称、描述和尺寸（新世界与工具栏新建共用）。 */
export const OFFSTAGE_REGION_NAME = '未参与对话'
export const OFFSTAGE_REGION_DESCRIPTION = '位于此区域的角色不参与当前对话。'
export const OFFSTAGE_REGION_SIZE = { width: 300, height: 220 } as const

// ---------------------------------------------------------------------------
// 几何（React Flow 画布坐标；无边界，仅用于排版，不等于世界语义）
// ---------------------------------------------------------------------------

export interface CanvasPoint {
  /** 任意有限画布坐标 */
  x: number
  /** 任意有限画布坐标 */
  y: number
}

export interface CanvasRect extends CanvasPoint {
  /** 有限且 width > 0 */
  width: number
  /** 有限且 height > 0 */
  height: number
}

// ---------------------------------------------------------------------------
// 画板
// ---------------------------------------------------------------------------

export interface CoordinateConvention {
  north: 'up'
  origin: 'top-left'
  units: 'canvas'
}

export interface ViewportHint {
  x: number
  y: number
  zoom: number
}

export interface SpatialBoard {
  id: string
  name: string
  description: string
  /** 入口节点；根画板为 null。与该节点的 childBoardId 双向一致。 */
  parentEntryNodeId: string | null
  coordinateConvention: CoordinateConvention
  /** 仅 UI 用，LLM 投影忽略 */
  viewportHint?: ViewportHint
}

// ---------------------------------------------------------------------------
// 空间节点（仅 region / place 两类）
// ---------------------------------------------------------------------------

export interface SpatialNodeBase {
  id: string
  boardId: string
  kind: SpatialNodeKind
  name: string
  description: string
  tags: string[]
  /** 同画板内的父节点（region，或主地点挂直属子结构）；根节点为 null */
  parentNodeId: string | null
  /** 内部子画板；无内部结构时为 null */
  childBoardId: string | null
  createdAt: number
  updatedAt: number
}

export interface RegionNode extends SpatialNodeBase {
  kind: 'region'
  geometry: CanvasRect
}

/** 子地点排列方向：row=右侧横向一行；column=下方向下成列；column-right=右侧向下成列 */
export type ChildLayout = 'row' | 'column' | 'column-right'

export interface PlaceNode extends SpatialNodeBase {
  kind: 'place'
  geometry: CanvasPoint
  iconKey: string
  /** 子地点排列方向：row=横向一行（默认）；column=下方向下；column-right=右侧向下 */
  childLayout?: ChildLayout
}

export type SpatialNode = RegionNode | PlaceNode

// ---------------------------------------------------------------------------
// 距离关系（仅同类、同画板、无向）
// ---------------------------------------------------------------------------

export interface DistanceMeasurement {
  /** 有限且 >= 0；null 表示无数值，此时 displayText 必填 */
  value: number | null
  unit: DistanceUnit
  /** unit === 'custom' 时必填 */
  customUnit?: string
  /** 叙事显示文本，如「约两天马程」 */
  displayText: string
  certainty: DistanceCertainty
}

export interface DistanceRelation {
  id: string
  kind: 'distance'
  boardId: string
  sourceNodeId: string
  targetNodeId: string
  name: string
  description: string
  measurement: DistanceMeasurement
  travelNotes?: string
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// 角色定义与位置
// ---------------------------------------------------------------------------

export interface SpatialActorExternalRef {
  type: ActorExternalRefType
  id: string
}

export interface SpatialActor {
  id: string
  kind: ActorKind
  externalRef: SpatialActorExternalRef
  displayName: string
  description?: string
  /** 仅 UI 装饰；缺失不影响语义理解 */
  avatarAssetRef?: string
}

export interface PlacementAnchor {
  kind: AnchorKind
  /** kind === 'node' 时必填 */
  nodeId?: string
}

export interface SemanticPosition {
  /** 由核心根据世界定义重算，不接受外部直接提交 */
  containmentPath: string[]
  relativeToNodeId?: string
  relativeDirection?: RelativeDirection
  precision: PlacementPrecision
  note?: string
}

export interface ActorPlacement {
  actorId: string
  boardId: string
  anchor: PlacementAnchor
  position: CanvasPoint
  semanticPosition: SemanticPosition
  revision: number
  updatedAt: number
  updatedBy: PlacementSource
}

// ---------------------------------------------------------------------------
// 事件日志
// ---------------------------------------------------------------------------

export interface SpatialEvent {
  id: string
  runtimeId: string
  revision: number
  commandType: SpatialCommandType
  actorId?: string
  before?: ActorPlacement | null
  after?: ActorPlacement | null
  source: PlacementSource
  reason?: string
  /** 剧情消息回溯用 */
  messageId?: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// 顶层文档
// ---------------------------------------------------------------------------

export interface SpatialWorldMetadata {
  createdAt: number
  updatedAt: number
  app: 'qingyu-spatial-board'
}

export interface SpatialWorldDocumentV1 {
  schemaVersion: 1
  id: string
  name: string
  description: string
  rootBoardId: string
  boards: SpatialBoard[]
  nodes: SpatialNode[]
  distances: DistanceRelation[]
  actors: SpatialActor[]
  metadata: SpatialWorldMetadata
}

export interface SpatialRuntimeStateV1 {
  schemaVersion: 1
  worldId: string
  runtimeId: string
  revision: number
  placements: ActorPlacement[]
  events: SpatialEvent[]
  updatedAt: number
}

// ---------------------------------------------------------------------------
// 导入限制常量（与 §13.3 对齐）
// ---------------------------------------------------------------------------

export const IMPORT_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxBoards: 200,
  maxNodes: 5_000,
  maxDistances: 10_000,
  maxActors: 500,
  maxHierarchyDepth: 20,
  maxEvents: 500,
  maxNameLength: 128,
  maxDescriptionLength: 4_000,
  maxNoteLength: 2_000,
  maxTags: 32,
  maxTagLength: 64,
  maxIdLength: 64,
} as const

// 供 commands.ts 引用，避免循环
export type SpatialCommandType =
  | 'update_world'
  | 'create_node'
  | 'update_node'
  | 'delete_node'
  | 'create_distance'
  | 'update_distance'
  | 'delete_distance'
  | 'create_actor'
  | 'update_actor'
  | 'delete_actor'
  | 'place_actor'
  | 'move_actor'
  | 'remove_actor_from_board'

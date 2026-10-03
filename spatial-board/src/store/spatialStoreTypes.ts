/**
 * 画板 store 的状态与动作契约（结构阶段 4C 自 spatialStore.ts 拆出）。
 *
 * 只含类型：`spatialStore.ts` 仍是页面消费的稳定入口（组合注入各 slice），
 * 各 slice 模块从本文件取 `SpatialStoreSet/SpatialStoreGet`，避免运行期循环依赖。
 */
import type {
  DistanceRelation,
  DistanceRelationPatch,
  HistoryState,
  SpatialCommand,
  SpatialCoreState,
  SpatialNodePatch,
  SpatialWorldDocumentV1,
} from '@qingyu/spatial-core'
import type { Tool } from '../canvas/adapter.ts'
import type {
  AutoMovePolicy,
  PendingSuggestion,
  StoryDecision,
} from '../story-adapter/index.ts'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

/** 画板视口能力（由 BoardCanvas 注册 React Flow 实例，供代码/脚本调用同一套功能） */
export interface CanvasViewportControls {
  zoomIn: () => void
  zoomOut: () => void
  fitView: () => void
  getViewport: () => { x: number; y: number; zoom: number }
  setViewport: (viewport: { x: number; y: number; zoom: number }) => void
}

export interface Selection {
  type: 'node' | 'distance' | 'actor' | 'none'
  id: string | null
}

export interface SpatialStore {
  // 核心状态
  core: SpatialCoreState
  history: HistoryState
  // UI
  tool: Tool
  selection: Selection
  currentBoardId: string
  saveStatus: SaveStatus
  statusMessage: string
  /** PC 传入的头像地址，仅用于显示，不进入世界文档或历史。 */
  actorAvatarUrls: Record<string, string>
  activeActorIds: string[] | null
  assistantEnabled: boolean
  distanceDraftSourceId: string | null
  /** 只在新建、导入或切换画板时递增，避免编辑节点时视口反复跳动。 */
  fitViewRequest: number
  idGen: () => string

  // 世界
  newWorld: (name?: string) => void
  setWorldName: (name: string) => void

  // 画板视口：与画布上的缩放/适应视图按钮同一套能力，供代码或脚本调用
  registerCanvasControls: (controls: CanvasViewportControls | null) => void
  zoomIn: () => void
  zoomOut: () => void
  fitView: () => void
  getViewport: () => { x: number; y: number; zoom: number } | null
  setViewport: (viewport: { x: number; y: number; zoom: number }) => void

  // 通用指令入口：界面上的任何数据变更都能以 SpatialCommand 形式下发
  applyCommands: (
    commands: SpatialCommand[],
    label?: string
  ) => { ok: true } | { ok: false; message: string }

  // 工具 / 选择 / 导航
  setTool: (tool: Tool) => void
  select: (selection: Selection) => void
  enterBoard: (boardId: string) => void
  enterChildBoard: (nodeId: string) => void
  goRootBoard: () => void
  breadcrumb: () => Array<{ id: string; name: string }>

  // 节点
  createRegionAt: (x: number, y: number, width: number, height: number, name?: string, options?: { offstage?: boolean }) => string | null
  /** 直接添加一块「未参与对话」区域（不传尺寸则用默认 300×220） */
  createOffstageRegionAt: (
    x: number,
    y: number,
    width?: number,
    height?: number
  ) => string | null
  createPlaceAt: (x: number, y: number, name?: string) => string | null
  /** 在主地点下添加一层子结构（同画板子地点）。 */
  addSubPlace: (
    parentId: string,
    name?: string
  ) => string | null
  updateNode: (nodeId: string, patch: SpatialNodePatch) => void
  deleteNode: (nodeId: string, cascade?: boolean) => void
  moveNode: (nodeId: string, x: number, y: number, width?: number, height?: number) => void
  /** 把所有地点的子项行重新横向排布（载入世界 / 导入后自动调用）。 */
  normalizeRows: () => void
  createInternalBoard: (nodeId: string) => string | null

  // 角色
  createActor: (displayName: string, kind?: 'persona' | 'character') => string | null
  updateActor: (actorId: string, patch: { displayName?: string; description?: string | null; kind?: 'persona' | 'character' }) => void
  deleteActor: (actorId: string) => void
  placeActorAt: (actorId: string, boardId: string, x: number, y: number, anchor?: { kind: 'board' | 'node'; nodeId?: string }, semantic?: { relativeDirection?: string; precision?: string; note?: string }) => void
  /** 在画板的下一个空闲暂存位放置角色。 */
  placeActorOnBoard: (actorId: string, boardId?: string) => void
  moveActorTo: (actorId: string, boardId: string, x: number, y: number, anchor?: { kind: 'board' | 'node'; nodeId?: string }, semantic?: { relativeDirection?: string; precision?: string; note?: string }) => void
  removeActorFromBoard: (actorId: string) => void

  // 距离
  startDistance: (sourceNodeId: string) => void
  cancelDistance: () => void
  completeDistance: (targetNodeId: string) => string | null
  createDistanceBetween: (sourceId: string, targetId: string, partial?: Partial<DistanceRelation['measurement']> & { name?: string }) => string | null
  updateDistance: (relationId: string, patch: DistanceRelationPatch) => void
  deleteDistance: (relationId: string) => void

  // 历史
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean

  // 导入导出
  exportPackage: () => { world: SpatialWorldDocumentV1; runtime: unknown }
  importPackage: (payload: { world: unknown; runtime?: unknown }) => { ok: true } | { ok: false; message: string }
  loadWorld: (world: SpatialWorldDocumentV1, runtime?: unknown) => void

  // 持久化钩子（由 persistence 层订阅）
  getCore: () => SpatialCoreState
  /** PC 确认/外部同步：不整理布局，不重置视口；只在外部基线变化时清理撤销。 */
  syncAuthoritative: (core: SpatialCoreState, resetHistory?: boolean, initial?: boolean) => void

  // 剧情
  autoMovePolicy: AutoMovePolicy
  pendingSuggestions: PendingSuggestion[]
  setAutoMovePolicy: (policy: AutoMovePolicy) => void
  submitStoryEnvelope: (input: unknown) => StoryDecision
  acceptSuggestion: (suggestionId: string) => boolean
  rejectSuggestion: (suggestionId: string) => void
  clearSuggestions: () => void
}

/** 拆分出的 slice 模块使用的 set/get */
export type SpatialStoreSet = (
  partial: Partial<SpatialStore> | SpatialStore | ((state: SpatialStore) => Partial<SpatialStore> | SpatialStore),
) => void
export type SpatialStoreGet = () => SpatialStore
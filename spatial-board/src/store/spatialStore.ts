/**
 * 独立 Zustand store：UI 只发出意图，生成 SpatialCommand 进入核心。\n * 不直接改 nodes/edges 领域数组。\n */
import { create } from 'zustand'
import type {
  DistanceRelation,
  SpatialCommand,
  SpatialCoreState,
  SpatialNode,
  SpatialWorldDocumentV1,
} from '@qingyu/spatial-core'
import {
  canRedo,
  canUndo,
  createEmptyRuntime,
  createWorldWithDefaults,
  createHistory,
  createSeqIdGen,
  exportRuntimeJson,
  exportWorldJson,
  getNode,
  isPlaceSubstructure,
  removeSubstructureConflicts,
  removeNodeCategories,
  IMPORT_LIMITS,
  migrateRuntimeState,
  migrateWorldDocument,
  OFFSTAGE_REGION_DESCRIPTION,
  OFFSTAGE_REGION_NAME,
  OFFSTAGE_REGION_SIZE,
  OFFSTAGE_REGION_TAG,
  redo as redoHistory,
  runBatch,
  undo as undoHistory,
  validateAll,
  type ActorPlacement,
  type ChildLayout,
  type HistoryState,
  type SpatialNodePatch,
  type DistanceRelationPatch,
} from '@qingyu/spatial-core'
import {
  collectNodeDragContents,
  dockedActorCountAt,
  inferParentNodeId,
  nextFreeActorPosition,
  placeSizeByCount,
  sortRowChildren,
  SUB_PLACE_GAP,
  type Tool,
} from '../canvas/adapter.ts'
import {
  guardRuntimeImport,
  guardWorldImport,
} from '@qingyu/spatial-core'
import {
  createSimulatedStoryAdapter,
  parseStoryEnvelope,
  describeEnvelope,
  type AutoMovePolicy,
  type PendingSuggestion,
  type StoryCommandEnvelope,
  type StoryDecision,
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

/** 视口控制器由画布挂载时注册，卸载时清空 */
let canvasControls: CanvasViewportControls | null = null

/** 停靠角色计数（可叠加一次变更增量，用于预演变更后的条目标宽）。 */
function countWithDelta(
  placements: ActorPlacement[],
  delta: Map<string, number>
): (nodeId: string) => number {
  return (nodeId) =>
    dockedActorCountAt(placements, nodeId) + (delta.get(nodeId) ?? 0)
}

/** 沿父链上溯到最外层地点（卡片）：它才是包含该节点的行排布根。 */
function topPlaceRootId(
  world: SpatialWorldDocumentV1,
  nodeId: string
): string | null {
  let current = getNode(world, nodeId)
  if (!current || current.kind !== 'place') return null
  // 最多上溯 64 层，异常数据也不会死循环
  for (let depth = 0; depth < 64; depth += 1) {
    const parentId = current.parentNodeId
    if (!parentId) break
    const parent = getNode(world, parentId)
    if (!parent || parent.kind !== 'place') break
    current = parent
  }
  return current.id
}

/** 新建子项时的默认方向：主地点楼层竖排，嵌套房间右排。 */
function defaultChildLayout(
  world: SpatialWorldDocumentV1,
  parent: SpatialNode
): ChildLayout {
  const parentOfParent = parent.parentNodeId
    ? getNode(world, parent.parentNodeId)
    : undefined
  return parentOfParent?.kind === 'place' ? 'row' : 'column-right'
}

/**
 * 将子项的拖放位置识别为父地点的排列方向。
 * 距离按“贴右边”、“贴下边”、“右侧纵列”三种几何轨道计算；
 * 同分时保留当前方向，避免轻微拖动导致布局抖动。
 */
function inferChildLayoutFromDrop(
  world: SpatialWorldDocumentV1,
  parent: SpatialNode,
  x: number,
  y: number,
  countAt: (nodeId: string) => number
): ChildLayout {
  if (parent.kind !== 'place') return 'row'
  const size = placeSizeByCount(parent, world.nodes, countAt)
  const rightX = parent.geometry.x + size.width
  const bottomY = parent.geometry.y + size.height
  const current = parent.childLayout ?? defaultChildLayout(world, parent)
  const rowScore =
    Math.abs(y - parent.geometry.y) + Math.max(0, rightX - x) * 2
  const columnScore =
    Math.abs(x - parent.geometry.x) + Math.max(0, bottomY - y) * 2
  const scores: Array<{ layout: ChildLayout; score: number }> = [
    { layout: 'row', score: rowScore },
    { layout: 'column', score: columnScore },
  ]
  const parentOfParent = parent.parentNodeId
    ? getNode(world, parent.parentNodeId)
    : undefined
  if (parentOfParent?.kind !== 'place') {
    scores.push({ layout: 'column-right', score: Math.abs(x - rightX) })
  }
  scores.sort(
    (a, b) =>
      a.score - (a.layout === current ? 0.25 : 0) -
        (b.score - (b.layout === current ? 0.25 : 0))
  )
  return scores[0]!.layout
}

/** 角色锚点变化后，需要重新横向排布的行根地点 id。 */
function rowParentsForAnchors(
  world: SpatialWorldDocumentV1,
  anchors: Array<string | null | undefined>
): string[] {
  const ids = new Set<string>()
  for (const anchorId of anchors) {
    if (!anchorId) continue
    // 条目变宽会撑开祖先所在的行，必须从最外层地点整棵重排
    const root = topPlaceRootId(world, anchorId)
    if (root) ids.add(root)
  }
  return [...ids]
}

/** 节点的全部后代 id。 */
function descendantIdsOf(nodes: SpatialNode[], rootId: string): string[] {
  const out: string[] = []
  const seen = new Set<string>([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    const parentId = queue.shift()!
    for (const node of nodes) {
      if (node.parentNodeId !== parentId || seen.has(node.id)) continue
      seen.add(node.id)
      out.push(node.id)
      queue.push(node.id)
    }
  }
  return out
}

/**
 * 按空间层级重排若干父地点下的子地点，并递归到子树。
 * 返回需要写回的 update_node 命令，以及各子节点的目标位置。
 */
function reflowRows(
  world: SpatialWorldDocumentV1,
  countAt: (nodeId: string) => number,
  rootParentIds: Iterable<string>,
  options: {
    extraNodes?: SpatialNode[]
    excludeNodeIds?: ReadonlySet<string>
    skipNodeIds?: ReadonlySet<string>
    /** 覆盖节点当前位置（用于预演「本次变更后」的排布） */
    positionOverrides?: ReadonlyMap<string, { x: number; y: number }>
  } = {}
): {
  commands: SpatialCommand[]
  targets: Map<string, { x: number; y: number }>
} {
  const merged = new Map<string, SpatialNode>(world.nodes.map((n) => [n.id, n]))
  for (const extra of options.extraNodes ?? []) merged.set(extra.id, extra)
  const nodes = [...merged.values()].filter(
    (n) => !options.excludeNodeIds?.has(n.id)
  )
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // 当前位置的工作副本：随排布推进而更新，保证父项先移动、子项跟随
  const pos = new Map<string, { x: number; y: number }>(
    nodes.map((n) => [
      n.id,
      options.positionOverrides?.get(n.id) ?? {
        x: n.geometry.x,
        y: n.geometry.y,
      },
    ])
  )
  const sizeOf = (n: SpatialNode) => placeSizeByCount(n, nodes, countAt)

  const commands: SpatialCommand[] = []
  const targets = new Map<string, { x: number; y: number }>()

  /**
   * 方向由拖放位置自动识别并写入 childLayout；
   * 未识别过的节点使用层级默认值。
   */
  const layoutOf = (node: SpatialNode): ChildLayout => {
    if (node.kind !== 'place') return 'row'
    return node.childLayout ?? defaultChildLayout(world, node)
  }

  /** 子项顺序：横向（一行）按 x、纵向（下方/右侧）按 y，再按创建时间与 id 兜底 */
  const childrenOf = (parent: SpatialNode) => {
    const direction = layoutOf(parent)
    const byColumn = direction === 'column' || direction === 'column-right'
    return nodes
      .filter((n) => n.kind === 'place' && n.parentNodeId === parent.id)
      .sort((a, b) => {
        const pa = pos.get(a.id) ?? { x: a.geometry.x, y: a.geometry.y }
        const pb = pos.get(b.id) ?? { x: b.geometry.x, y: b.geometry.y }
        const key = byColumn ? pa.y - pb.y : pa.x - pb.x
        return (
          key ||
          a.createdAt - b.createdAt ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        )
      })
  }

  /** 先测量整棵子树，上层排布才能将嵌套条目作为整体居中。 */
  const measuring = new Set<string>()
  const measureSubtree = (node: SpatialNode): { width: number; height: number } => {
    const size = sizeOf(node)
    if (measuring.has(node.id)) return size
    measuring.add(node.id)
    const kids = childrenOf(node)
    if (kids.length === 0) {
      measuring.delete(node.id)
      return size
    }
    const boxes = kids.map(measureSubtree)
    const direction = layoutOf(node)
    measuring.delete(node.id)

    if (direction === 'column') {
      return {
        width: Math.max(size.width, ...boxes.map((box) => box.width)),
        height:
          size.height +
          SUB_PLACE_GAP +
          boxes.reduce((sum, box) => sum + box.height, 0) +
          SUB_PLACE_GAP * Math.max(0, boxes.length - 1),
      }
    }
    if (direction === 'column-right') {
      return {
        width:
          size.width +
          SUB_PLACE_GAP +
          Math.max(...boxes.map((box) => box.width)),
        height: Math.max(
          size.height,
          boxes.reduce((sum, box) => sum + box.height, 0) +
            SUB_PLACE_GAP * Math.max(0, boxes.length - 1)
        ),
      }
    }
    return {
      width:
        size.width +
        SUB_PLACE_GAP +
        boxes.reduce((sum, box) => sum + box.width, 0) +
        SUB_PLACE_GAP * Math.max(0, boxes.length - 1),
      height: Math.max(size.height, ...boxes.map((box) => box.height)),
    }
  }

  const visiting = new Set<string>()
  /**
   * 递归排布一棵子树：节点自身与全部子孙连成一体（楼层后面紧跟它自己的房间），
   * 返回该子树的占位矩形（宽 × 高），让上层兄弟排到整棵子树之后而不与之重叠。
   */
  const layoutSubtree = (
    node: SpatialNode,
    originX: number,
    originY: number
  ): { width: number; height: number } => {
    const size = sizeOf(node)
    const at = { x: roundCanvas(originX), y: roundCanvas(originY) }
    pos.set(node.id, at)
    targets.set(node.id, at)
    if (visiting.has(node.id)) {
      return { width: size.width, height: size.height }
    }
    visiting.add(node.id)
    const box = layoutChildren(node, at, size)
    visiting.delete(node.id)
    return box
  }

  /**
   * 按节点自己的 childLayout 摆放其子项，返回「含自身尺寸」的整体占位矩形。
   * - row：贴右缘横向成行，纵向与自身居中
   * - column：贴下缘纵向成列，左对齐
   * - column-right：贴右缘纵向成列，顶端对齐
   */
  const layoutChildren = (
    node: SpatialNode,
    at: { x: number; y: number },
    size: { width: number; height: number }
  ): { width: number; height: number } => {
    const kids = childrenOf(node)
    if (kids.length === 0) {
      return { width: size.width, height: size.height }
    }
    const direction = layoutOf(node)

    if (direction === 'column') {
      let cursor = roundCanvas(at.y + size.height + SUB_PLACE_GAP)
      let widest = size.width
      for (const kid of kids) {
        const box = layoutSubtree(kid, at.x, cursor)
        cursor = roundCanvas(cursor + box.height + SUB_PLACE_GAP)
        widest = Math.max(widest, box.width)
      }
      return {
        width: widest,
        height: roundCanvas(cursor - SUB_PLACE_GAP - at.y),
      }
    }

    if (direction === 'column-right') {
      const columnX = roundCanvas(at.x + size.width + SUB_PLACE_GAP)
      const measured = kids.map(measureSubtree)
      const stackHeight =
        measured.reduce((sum, box) => sum + box.height, 0) +
        SUB_PLACE_GAP * Math.max(0, measured.length - 1)
      // 无论楼层组比主地点高还是矮，都以地点中线为基准对称展开，
      // 避免多层楼时整列只向下坠，保持“同一地点的附着组”视觉。
      let cursor = roundCanvas(at.y + (size.height - stackHeight) / 2)
      let widest = 0
      for (const kid of kids) {
        const box = layoutSubtree(kid, columnX, cursor)
        cursor = roundCanvas(cursor + box.height + SUB_PLACE_GAP)
        widest = Math.max(widest, box.width)
      }
      return {
        width: roundCanvas(size.width + SUB_PLACE_GAP + widest),
        height: Math.max(
          size.height,
          roundCanvas(cursor - SUB_PLACE_GAP - at.y)
        ),
      }
    }

    let cursor = roundCanvas(at.x + size.width + SUB_PLACE_GAP)
    const measured = kids.map(measureSubtree)
    const tallestChild = Math.max(...measured.map((box) => box.height))
    // 横排时以整行最高分支为基准居中，所有同级子项共用顶线。
    // 这样带下挂房间的楼层不会与空楼层上下错位。
    const childY = roundCanvas(at.y + (size.height - tallestChild) / 2)
    let tallest = size.height
    for (const kid of kids) {
      const box = layoutSubtree(kid, cursor, childY)
      cursor = roundCanvas(cursor + box.width + SUB_PLACE_GAP)
      tallest = Math.max(tallest, box.height)
    }
    return {
      width: roundCanvas(cursor - SUB_PLACE_GAP - at.x),
      height: tallest,
    }
  }

  const roots = new Set<string>()
  for (const parentId of rootParentIds) {
    if (roots.has(parentId)) continue
    roots.add(parentId)
    const parent = byId.get(parentId)
    const parentPos = pos.get(parentId)
    if (!parent || parent.kind !== 'place' || !parentPos) continue
    layoutChildren(parent, parentPos, sizeOf(parent))
  }

  // 与旧坐标比对，只写回发生变化（含新加入）的节点
  for (const [nodeId, at] of targets) {
    if (options.skipNodeIds?.has(nodeId)) continue
    const node = byId.get(nodeId)
    if (!node) continue
    if (node.geometry.x === at.x && node.geometry.y === at.y) continue
    commands.push({
      type: 'update_node',
      nodeId,
      patch: { geometry: { x: at.x, y: at.y } },
    })
  }

  return { commands, targets }
}

/** 角色锚点变更后，重排受影响的行所需的命令（按变更后的停靠数预演宽度）。 */
function anchorRowCommands(
  core: SpatialCoreState,
  prevAnchorId: string | null,
  nextAnchorId: string | null
): SpatialCommand[] {
  if (!prevAnchorId && !nextAnchorId) return []
  const delta = new Map<string, number>()
  if (prevAnchorId) delta.set(prevAnchorId, (delta.get(prevAnchorId) ?? 0) - 1)
  if (nextAnchorId) delta.set(nextAnchorId, (delta.get(nextAnchorId) ?? 0) + 1)
  return reflowRows(
    core.world,
    countWithDelta(core.runtime.placements, delta),
    rowParentsForAnchors(core.world, [prevAnchorId, nextAnchorId])
  ).commands
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

function now(): number {
  return Date.now()
}

function newId(prefix: string, gen: () => string): string {
  return `${prefix}_${gen()}`
}

/** 画布坐标收敛到小数点后 3 位，避免拖动浮点噪声。 */
function roundCanvas(v: number): number {
  return Math.round(v * 1000) / 1000
}

export const MIN_REGION_SIZE = 24

function keepValidSelection(
  core: SpatialCoreState,
  selection: Selection
): Selection {
  if (!selection.id || selection.type === 'none') {
    return { type: 'none', id: null }
  }
  const exists =
    selection.type === 'node'
      ? core.world.nodes.some((n) => n.id === selection.id)
      : selection.type === 'distance'
        ? core.world.distances.some((d) => d.id === selection.id)
        : core.world.actors.some((a) => a.id === selection.id)
  return exists ? selection : { type: 'none', id: null }
}

export const useSpatialStore = create<SpatialStore>((set, get) => ({
  core: {
    world: createWorldWithDefaults('world_draft', '新世界', { now: now() }),
    runtime: createEmptyRuntime('world_draft', 'runtime_draft', now()),
  },
  history: createHistory(),
  tool: 'select',
  selection: { type: 'none', id: null },
  currentBoardId: 'world_draft_root',
  saveStatus: 'idle',
  statusMessage: '就绪',
  actorAvatarUrls: {},
  activeActorIds: null,
  assistantEnabled: true,
  distanceDraftSourceId: null,
  fitViewRequest: 0,
  idGen: createSeqIdGen('n'),

  newWorld: (name = '新世界') => {
    const t = now()
    const world = createWorldWithDefaults('world_draft', name, { now: t })
    set({
      core: {
        world,
        runtime: createEmptyRuntime(world.id, 'runtime_draft', t),
      },
      history: createHistory(),
      currentBoardId: world.rootBoardId,
      selection: { type: 'none', id: null },
      tool: 'select',
      saveStatus: 'idle',
      statusMessage: '已新建世界',
      distanceDraftSourceId: null,
      fitViewRequest: get().fitViewRequest + 1,
    })
  },

  setWorldName: (name) => {
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      set({ statusMessage: '世界名称不能为空' })
      return
    }
    const { core, idGen, history } = get()
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands: [{ type: 'update_world', patch: { name: trimmed } }],
      },
      { now: now(), source: 'user', idGen, label: 'update-world' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `重命名失败：${result.batch.code}` })
      return
    }
    set({
      core: result.batch.state,
      history: result.history,
      saveStatus: 'saving',
      statusMessage: `已重命名世界为「${trimmed}」`,
    })
  },

  registerCanvasControls: (controls) => {
    canvasControls = controls
  },

  zoomIn: () => {
    canvasControls?.zoomIn()
  },

  zoomOut: () => {
    canvasControls?.zoomOut()
  },

  fitView: () => {
    canvasControls?.fitView()
  },

  getViewport: () => canvasControls?.getViewport() ?? null,

  setViewport: (viewport) => {
    canvasControls?.setViewport(viewport)
  },

  applyCommands: (commands, label) => {
    if (commands.length === 0) return { ok: false, message: '命令为空' }
    const { core, idGen, history } = get()
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands,
      },
      { now: now(), source: 'user', idGen, label: label ?? 'apply-commands' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `指令失败：${result.batch.code}` })
      return { ok: false, message: result.batch.message }
    }
    set({
      core: result.batch.state,
      history: result.history,
      saveStatus: 'saving',
      statusMessage: `已执行 ${commands.length} 条指令`,
    })
    return { ok: true }
  },

  setTool: (tool) => {
    set({
      tool,
      distanceDraftSourceId: tool === 'distance' ? get().distanceDraftSourceId : null,
      statusMessage:
        tool === 'region'
          ? '拖拽绘制矩形区域'
          : tool === 'place'
            ? '单击画布创建地点'
            : tool === 'distance'
              ? '依次点击两个同类节点创建距离'
              : tool === 'offstage'
                ? '单击或拖拽添加「未参与对话」区域'
                : '选择模式',
    })
  },

  select: (selection) => set({ selection }),

  enterBoard: (boardId) => {
    set((state) => ({
      currentBoardId: boardId,
      selection: { type: 'none', id: null },
      fitViewRequest: state.fitViewRequest + 1,
    }))
  },

  enterChildBoard: (nodeId) => {
    const node = getNode(get().core.world, nodeId)
    if (node?.childBoardId) {
      get().enterBoard(node.childBoardId)
    }
  },

  goRootBoard: () => {
    set((state) => ({
      currentBoardId: get().core.world.rootBoardId,
      selection: { type: 'none', id: null },
      fitViewRequest: state.fitViewRequest + 1,
    }))
  },

  breadcrumb: () => {
    const { core, currentBoardId } = get()
    const world = core.world
    const chain: Array<{ id: string; name: string }> = []
    const visited = new Set<string>()
    let bid: string | null = currentBoardId
    while (bid && !visited.has(bid)) {
      visited.add(bid)
      const board = world.boards.find((b) => b.id === bid)
      if (!board) break
      chain.unshift({ id: board.id, name: board.name })
      bid = board.parentEntryNodeId
        ? (getNode(world, board.parentEntryNodeId)?.boardId ?? null)
        : null
    }
    return chain
  },

  createRegionAt: (x, y, width, height, name, options) => {
    const { core, currentBoardId, idGen, history } = get()
    const offstage = options?.offstage === true
    const id = newId('region', idGen)
    const geo = {
      x: roundCanvas(x),
      y: roundCanvas(y),
      width: roundCanvas(Math.max(MIN_REGION_SIZE, width)),
      height: roundCanvas(Math.max(MIN_REGION_SIZE, height)),
    }

    const payload: SpatialNode = {
      id,
      boardId: currentBoardId,
      kind: 'region',
      name: name ?? (offstage ? OFFSTAGE_REGION_NAME : '新区域'),
      description: offstage ? OFFSTAGE_REGION_DESCRIPTION : '',
      tags: offstage ? [OFFSTAGE_REGION_TAG] : [],
      parentNodeId: null,
      childBoardId: null,
      createdAt: now(),
      updatedAt: now(),
      geometry: geo,
    }

    const cmd: SpatialCommand = { type: 'create_node', payload }
    const result = runBatch(
      core,
      history,
      { schemaVersion: 1, expectedRevision: core.runtime.revision, commands: [cmd] },
      { now: now(), source: 'user', idGen, label: 'create-region' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `创建区域失败：${result.batch.code}` })
      return null
    }
    set({
      core: result.batch.state,
      history: result.history,
      selection: { type: 'node', id },
      saveStatus: 'saving',
      statusMessage: offstage
        ? `已添加「${payload.name}」区域`
        : `已创建区域「${payload.name}」`,
    })
    return id
  },

  createOffstageRegionAt: (x, y, width, height) =>
    get().createRegionAt(
      x,
      y,
      width ?? OFFSTAGE_REGION_SIZE.width,
      height ?? OFFSTAGE_REGION_SIZE.height,
      OFFSTAGE_REGION_NAME,
      { offstage: true }
    ),

  createPlaceAt: (x, y, name) => {
    const { core, currentBoardId, idGen, history } = get()
    const id = newId('place', idGen)
    const px = roundCanvas(x)
    const py = roundCanvas(y)

    const payload: SpatialNode = {
      id,
      boardId: currentBoardId,
      kind: 'place',
      name: name ?? '新地点',
      description: '',
      tags: [],
      parentNodeId: null,
      childBoardId: null,
      createdAt: now(),
      updatedAt: now(),
      geometry: { x: px, y: py },
      iconKey: 'marker',
    }

    // 推断父区域
    const parentId = inferParentNodeId(core.world.nodes, currentBoardId, {
      id,
      x: px,
      y: py,
      width: 48,
      height: 48,
    })
    if (parentId) payload.parentNodeId = parentId

    const cmd: SpatialCommand = { type: 'create_node', payload }
    const result = runBatch(
      core,
      history,
      { schemaVersion: 1, expectedRevision: core.runtime.revision, commands: [cmd] },
      { now: now(), source: 'user', idGen, label: 'create-place' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `创建地点失败：${result.batch.code}` })
      return null
    }
    set({
      core: result.batch.state,
      history: result.history,
      selection: { type: 'node', id },
      saveStatus: 'saving',
      statusMessage: `已创建地点「${payload.name}」`,
    })
    return id
  },

  addSubPlace: (parentId, name) => {
    const { core, idGen, history } = get()
    const parent = getNode(core.world, parentId)
    if (!parent || parent.kind !== 'place') {
      set({ statusMessage: '父地点不存在' })
      return null
    }
    if (isPlaceSubstructure(core.world, parentId)) {
      set({ statusMessage: '子结构不能再次添加子结构' })
      return null
    }
    const siblings = sortRowChildren(
      core.world.nodes.filter(
        (n) => n.parentNodeId === parentId && n.kind === 'place'
      )
    )
    const id = newId('place', idGen)
    const label = '子结构'
    const fallbackName = `子结构 ${siblings.length + 1}`

    const effectiveLayout: ChildLayout =
      parent.childLayout ?? defaultChildLayout(core.world, parent)
    const shouldSyncAutomaticLayout = parent.childLayout === undefined
    const effectiveParent = shouldSyncAutomaticLayout
      ? { ...parent, childLayout: effectiveLayout }
      : parent

    const payload: SpatialNode = {
      id,
      boardId: parent.boardId,
      kind: 'place',
      name: (name ?? '').trim() || fallbackName,
      description: '',
      tags: [],
      parentNodeId: parentId,
      childBoardId: null,
      createdAt: now(),
      updatedAt: now(),
      // 占位：临时取极大坐标保证排在子项末尾（横向按 x、纵向按 y），实际位置由排布写入
      geometry:
        effectiveLayout === 'row'
          ? { x: Number.MAX_SAFE_INTEGER, y: parent.geometry.y }
          : { x: parent.geometry.x, y: Number.MAX_SAFE_INTEGER },
      iconKey: 'pin',
    }

    // 子地点横向成行：新条目落在行尾，并顺带对齐该行已有条目
    const { commands: rowCommands, targets } = reflowRows(
      core.world,
      (nodeId) => dockedActorCountAt(core.runtime.placements, nodeId),
      [topPlaceRootId(core.world, parentId) ?? parentId],
      {
        extraNodes: [effectiveParent, payload],
        skipNodeIds: new Set([id]),
      }
    )
    const target = targets.get(id)
    if (target) payload.geometry = { x: target.x, y: target.y }

    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands: [
          { type: 'create_node', payload },
          ...(shouldSyncAutomaticLayout
            ? [
                {
                  type: 'update_node' as const,
                  nodeId: parentId,
                  patch: { childLayout: effectiveLayout },
                },
              ]
            : []),
          ...rowCommands,
        ],
      },
      { now: now(), source: 'user', idGen, label: 'add-sub-place' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `添加${label}失败：${result.batch.code}` })
      return null
    }
    set({
      core: result.batch.state,
      history: result.history,
      selection: { type: 'node', id },
      saveStatus: 'saving',
      statusMessage: `已添加${label}「${payload.name}」`,
    })
    return id
  },

  updateNode: (nodeId, patch) => {
    const { core, idGen, history } = get()
    const node = getNode(core.world, nodeId)
    const commands: SpatialCommand[] = [{ type: 'update_node', nodeId, patch }]
    // 地点改坐标或改子项方向后重新排布：x/y 决定顺序，另一轴由排布决定
    if (node?.kind === 'place' && (patch.geometry || patch.childLayout)) {
      commands.push(
        ...reflowRows(
          core.world,
          (id) => dockedActorCountAt(core.runtime.placements, id),
          [node.parentNodeId ?? node.id],
          {
            ...(patch.childLayout
              ? { extraNodes: [{ ...node, childLayout: patch.childLayout }] }
              : {}),
            ...(patch.geometry
              ? {
                  positionOverrides: new Map([
                    [
                      nodeId,
                      {
                        x: patch.geometry.x ?? node.geometry.x,
                        y: patch.geometry.y ?? node.geometry.y,
                      },
                    ],
                  ]),
                }
              : {}),
          }
        ).commands
      )
    }
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands,
      },
      { now: now(), source: 'user', idGen, label: 'update-node' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `更新失败：${result.batch.code}` })
      return
    }
    set({
      core: result.batch.state,
      history: result.history,
      saveStatus: 'saving',
    })
  },

  deleteNode: (nodeId, cascade = false) => {
    const { core, idGen, history } = get()
    const node = getNode(core.world, nodeId)
    const exclude = new Set<string>([nodeId])
    if (cascade) {
      for (const id of descendantIdsOf(core.world.nodes, nodeId)) exclude.add(id)
    }
    const rowCommands = node?.parentNodeId
      ? reflowRows(
          core.world,
          (id) => dockedActorCountAt(core.runtime.placements, id),
          [topPlaceRootId(core.world, node.parentNodeId)].filter(
            (value): value is string => !!value
          ),
          { excludeNodeIds: exclude }
        ).commands
      : []
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands: [
          {
            type: 'delete_node',
            nodeId,
            strategy: cascade ? 'cascade' : 'reject-if-not-empty',
          },
          ...rowCommands,
        ],
      },
      { now: now(), source: 'user', idGen, label: 'delete-node' }
    )
    if (!result.batch.ok) {
      set({
        statusMessage:
          result.batch.code === 'node_not_empty'
            ? '节点非空：请确认级联删除，或先移除子项'
            : `删除失败：${result.batch.code}`,
      })
      return
    }
    set({
      core: result.batch.state,
      history: result.history,
      selection: { type: 'none', id: null },
      saveStatus: 'saving',
      statusMessage: '已删除',
    })
  },

  moveNode: (nodeId, x, y, width, height) => {
    const { core, currentBoardId, idGen, history } = get()
    const node = getNode(core.world, nodeId)
    if (!node) return
    const dragContents = collectNodeDragContents(
      core.world.nodes,
      core.runtime.placements,
      currentBoardId,
      nodeId
    )
    const childIds = dragContents.nodeIds
    const descendantIds = new Set(childIds)

    const nextRegionWidth =
      node.kind === 'region'
        ? roundCanvas(
            Math.max(
              MIN_REGION_SIZE,
              width === undefined
                ? node.geometry.width
                : width
            )
          )
        : 0
    const nextRegionHeight =
      node.kind === 'region'
        ? roundCanvas(
            Math.max(
              MIN_REGION_SIZE,
              height === undefined
                ? node.geometry.height
                : height
            )
          )
        : 0
    const nx = roundCanvas(x)
    const ny = roundCanvas(y)
    const patch: SpatialNodePatch = { geometry: { x: nx, y: ny } }
    if (width !== undefined && node.kind === 'region') {
      patch.geometry!.width = nextRegionWidth
    }
    if (height !== undefined && node.kind === 'region') {
      patch.geometry!.height = nextRegionHeight
    }

    // 重新推断父级（仅当前节点）；挂在地点下的楼层/房间保持父地点
    const w = node.kind === 'region' ? node.geometry.width : 48
    const h = node.kind === 'region' ? node.geometry.height : 48
    const prevParent = node.parentNodeId
      ? getNode(core.world, node.parentNodeId)
      : null
    const parentId =
      prevParent?.kind === 'place'
        ? prevParent.id
        : inferParentNodeId(
            core.world.nodes,
            currentBoardId,
            {
              id: nodeId,
              x: nx,
              y: ny,
              width: width ?? w,
              height: height ?? h,
            },
            descendantIds
          )
    patch.parentNodeId = parentId

    // 位移增量（画布坐标）
    const dx = nx - node.geometry.x
    const dy = ny - node.geometry.y

    const commands: SpatialCommand[] = [
      { type: 'update_node', nodeId, patch },
    ]

    const inferredParentLayout =
      node.kind === 'place' && prevParent?.kind === 'place'
        ? inferChildLayoutFromDrop(
            core.world,
            prevParent,
            nx,
            ny,
            (id) => dockedActorCountAt(core.runtime.placements, id)
          )
        : null
    const parentWithInferredLayout =
      inferredParentLayout && prevParent?.kind === 'place'
        ? { ...prevParent, childLayout: inferredParentLayout }
        : null
    if (
      parentWithInferredLayout &&
      prevParent?.kind === 'place' &&
      prevParent.childLayout !== inferredParentLayout
    ) {
      commands.push({
        type: 'update_node',
        nodeId: prevParent.id,
        patch: { childLayout: inferredParentLayout! },
      })
    }

    // 区域带动子孙节点与区内角色；地点带动直接锚定角色。
    if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
      for (const cid of childIds) {
        const child = getNode(core.world, cid)
        if (!child) continue
        commands.push({
          type: 'update_node',
          nodeId: cid,
          patch: {
            geometry: {
              x: roundCanvas(child.geometry.x + dx),
              y: roundCanvas(child.geometry.y + dy),
            },
          },
        })
      }

      const actorIds = new Set(dragContents.actorIds)
      for (const p of core.runtime.placements) {
        if (!actorIds.has(p.actorId)) continue

        commands.push({
          type: 'move_actor',
          actorId: p.actorId,
          to: {
            boardId: p.boardId,
            anchor: p.anchor,
            position: {
              x: roundCanvas(p.position.x + dx),
              y: roundCanvas(p.position.y + dy),
            },
            semanticPosition: {
              ...(p.semanticPosition.relativeToNodeId
                ? { relativeToNodeId: p.semanticPosition.relativeToNodeId }
                : {}),
              ...(p.semanticPosition.relativeDirection
                ? { relativeDirection: p.semanticPosition.relativeDirection }
                : {}),
              precision: p.semanticPosition.precision,
              ...(p.semanticPosition.note
                ? { note: p.semanticPosition.note }
                : {}),
            },
          },
          reason: 'region_drag',
        })
      }
    }

    // 地点移动后重排所在层级与其子项，保持自动贴合。
    commands.push(
      ...reflowRows(
        core.world,
        (id) => dockedActorCountAt(core.runtime.placements, id),
        [node.parentNodeId, parentId, nodeId].filter(
          (value): value is string => typeof value === 'string'
        ),
        {
          ...(parentWithInferredLayout
            ? { extraNodes: [parentWithInferredLayout] }
            : {}),
          positionOverrides: new Map([[nodeId, { x: nx, y: ny }]]),
        }
      ).commands
    )

    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands,
      },
      { now: now(), source: 'user', idGen, label: 'move-node' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `移动失败：${result.batch.code}` })
      return
    }
    set({
      core: result.batch.state,
      history: result.history,
      saveStatus: 'saving',
      ...(parentWithInferredLayout &&
      prevParent?.kind === 'place' &&
      prevParent.childLayout !== inferredParentLayout
        ? { statusMessage: `已自动调整「${prevParent?.name}」的子项排列` }
        : {}),
    })
  },

  normalizeRows: () => {
    const { core, idGen, history } = get()
    const commands = reflowRows(
      core.world,
      (id) => dockedActorCountAt(core.runtime.placements, id),
      core.world.nodes.filter((n) => n.kind === 'place').map((n) => n.id)
    ).commands
    if (commands.length === 0) return
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands,
      },
      { now: now(), source: 'user', idGen, label: 'normalize-rows' }
    )
    if (!result.batch.ok) return
    set({
      core: result.batch.state,
      history: result.history,
      saveStatus: 'saving',
    })
  },

  startDistance: (sourceNodeId) => {
    set({
      distanceDraftSourceId: sourceNodeId,
      tool: 'distance',
      statusMessage: '已选起点，请点击同类终点',
    })
  },

  cancelDistance: () => {
    set({ distanceDraftSourceId: null, statusMessage: '已取消距离创建 '})
  },

  completeDistance: (targetNodeId) => {
    const source = get().distanceDraftSourceId
    if (!source) return null
    const id = get().createDistanceBetween(source, targetNodeId)
    set({ distanceDraftSourceId: null, tool: 'select' })
    return id
  },

  createDistanceBetween: (sourceId, targetId, partial) => {
    const { core, currentBoardId, idGen, history } = get()
    const src = getNode(core.world, sourceId)
    const tgt = getNode(core.world, targetId)
    if (!src || !tgt) {
      set({ statusMessage: '端点不存在 '})
      return null
    }
    if (src.kind !== tgt.kind) {
      set({ statusMessage: '只能连接同类节点（区域↔区域 / 地点↔地点）' })
      return null
    }
    if (sourceId === targetId) {
      set({ statusMessage: '不能连接自身' })
      return null
    }

    const id = newId('dist', idGen)
    const payload: DistanceRelation = {
      id,
      kind: 'distance',
      boardId: currentBoardId,
      sourceNodeId: sourceId,
      targetNodeId: targetId,
      name: partial?.name ?? `${src.name} ↔ ${tgt.name}`,
      description: '',
      measurement: {
        value: partial?.value ?? null,
        unit: partial?.unit ?? 'km',
        ...(partial?.customUnit ? { customUnit: partial.customUnit } : {}),
        displayText: partial?.displayText ?? '未知距离',
        certainty: partial?.certainty ?? 'unknown',
      },
      createdAt: now(),
      updatedAt: now(),
    }

    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands: [{ type: 'create_distance', payload }],
      },
      { now: now(), source: 'user', idGen, label: 'create-distance' }
    )
    if (!result.batch.ok) {
      set({
        statusMessage:
          result.batch.code === 'duplicate_distance'
            ? '两点之间已存在距离关系'
            : result.batch.code === 'cross_kind_distance'
              ? '跨类型距离被拒绝'
              : result.batch.code === 'cross_board_distance'
                ? '跨画板距离被拒绝'
                : `创建距离失败：${result.batch.code}`,
      })
      return null
    }
    set({
      core: result.batch.state,
      history: result.history,
      selection: { type: 'distance', id },
      saveStatus: 'saving',
      statusMessage: '已创建距离',
    })
    return id
  },

  updateDistance: (relationId, patch) => {
    const { core, idGen, history } = get()
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands: [{ type: 'update_distance', relationId, patch }],
      },
      { now: now(), source: 'user', idGen, label: 'update-distance' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `更新距离失败：${result.batch.code}` })
      return
    }
    set({
      core: result.batch.state,
      history: result.history,
      saveStatus: 'saving',
    })
  },

  deleteDistance: (relationId) => {
    const { core, idGen, history } = get()
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands: [{ type: 'delete_distance', relationId }],
      },
      { now: now(), source: 'user', idGen, label: 'delete-distance' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `删除距离失败：${result.batch.code}` })
      return
    }
    set({
      core: result.batch.state,
      history: result.history,
      selection: { type: 'none', id: null },
      saveStatus: 'saving',
      statusMessage: '已删除距离',
    })
  },

  createInternalBoard: (nodeId) => {
    const { core, idGen, history } = get()
    const node = getNode(core.world, nodeId)
    if (!node) {
      set({ statusMessage: '节点不存在 '})
      return null
    }
    if (isPlaceSubstructure(core.world, nodeId)) {
      set({ statusMessage: '子结构不能创建内部画板' })
      return null
    }
    if (node.childBoardId) {
      set({ statusMessage: '该节点已有内部画板 '})
      return node.childBoardId
    }
    const boardId = newId('board', idGen)
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands: [
          { type: 'update_node', nodeId, patch: { childBoardId: boardId } },
        ],
      },
      { now: now(), source: 'user', idGen, label: 'create-internal-board' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `创建内部画板失败：${result.batch.code}` })
      return null
    }
    set({
      core: result.batch.state,
      history: result.history,
      currentBoardId: boardId,
      selection: { type: 'none', id: null },
      saveStatus: 'saving',
      statusMessage: `已创建内部画板「${node.name}内部」`,
    })
    return boardId
  },

  createActor: (displayName, kind = 'character') => {
    const { core, idGen, history } = get()
    const id = newId('actor', idGen)
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands: [
          {
            type: 'create_actor',
            payload: {
              id,
              kind,
              externalRef: { type: 'standalone', id },
              displayName: displayName.trim() || '新角色',
            },
          },
        ],
      },
      { now: now(), source: 'user', idGen, label: 'create-actor' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `创建角色失败：${result.batch.code}` })
      return null
    }
    set({
      core: result.batch.state,
      history: result.history,
      selection: { type: 'actor', id },
      saveStatus: 'saving',
      statusMessage: `已添加角色「${displayName}」`,
    })
    return id
  },

  updateActor: (actorId, patch) => {
    const { core, idGen, history } = get()
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands: [{ type: 'update_actor', actorId, patch }],
      },
      { now: now(), source: 'user', idGen, label: 'update-actor' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `更新角色失败：${result.batch.code}` })
      return
    }
    set({
      core: result.batch.state,
      history: result.history,
      saveStatus: 'saving',
    })
  },

  deleteActor: (actorId) => {
    if (get().activeActorIds !== null) { set({ statusMessage: '请在群聊设置中管理成员' }); return }
    const { core, idGen, history } = get()
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands: [{ type: 'delete_actor', actorId }],
      },
      { now: now(), source: 'user', idGen, label: 'delete-actor' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `删除角色失败：${result.batch.code}` })
      return
    }
    set({
      core: result.batch.state,
      history: result.history,
      selection: { type: 'none', id: null },
      saveStatus: 'saving',
      statusMessage: '已删除角色',
    })
  },

  placeActorAt: (actorId, boardId, x, y, anchor, semantic) => {
    const { core, idGen, history } = get()
    const prev = core.runtime.placements.find((p) => p.actorId === actorId)
    const prevAnchorId =
      prev?.anchor.kind === 'node' ? (prev.anchor.nodeId ?? null) : null
    const nextAnchorId = anchor?.kind === 'node' ? (anchor.nodeId ?? null) : null
    const rowCommands = anchorRowCommands(core, prevAnchorId, nextAnchorId)
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands: [
          {
            type: 'place_actor',
            actorId,
            placement: {
              boardId,
              anchor: anchor ?? { kind: 'board' },
              position: {
                x: roundCanvas(x),
                y: roundCanvas(y),
              },
              semanticPosition: {
                precision: (semantic?.precision as never) ?? 'approximate',
                ...(semantic?.relativeDirection
                  ? { relativeDirection: semantic.relativeDirection as never }
                  : {}),
                ...(semantic?.note ? { note: semantic.note } : {}),
              },
            },
          },
          ...rowCommands,
        ],
      },
      { now: now(), source: 'user', idGen, label: 'place-actor' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `放置角色失败：${result.batch.code}` })
      return
    }
    set({
      core: result.batch.state,
      history: result.history,
      selection: { type: 'actor', id: actorId },
      saveStatus: 'saving',
      statusMessage: '已放置角色',
    })
  },

  placeActorOnBoard: (actorId, boardId) => {
    const { core, currentBoardId } = get()
    const targetBoardId = boardId ?? currentBoardId
    const position = nextFreeActorPosition(core.runtime.placements, targetBoardId)
    get().placeActorAt(
      actorId,
      targetBoardId,
      position.x,
      position.y,
      { kind: 'board' },
      { precision: 'approximate', relativeDirection: 'nearby' }
    )
  },

  moveActorTo: (actorId, boardId, x, y, anchor, semantic) => {
    const { core, idGen, history } = get()
    const prev = core.runtime.placements.find((p) => p.actorId === actorId)
    const prevAnchorId =
      prev?.anchor.kind === 'node' ? (prev.anchor.nodeId ?? null) : null
    const nextAnchorId = anchor?.kind === 'node' ? (anchor.nodeId ?? null) : null
    const rowCommands = anchorRowCommands(core, prevAnchorId, nextAnchorId)
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands: [
          {
            type: 'move_actor',
            actorId,
            to: {
              boardId,
              anchor: anchor ?? { kind: 'board' },
              position: {
                x: roundCanvas(x),
                y: roundCanvas(y),
              },
              semanticPosition: {
                precision: (semantic?.precision as never) ?? 'approximate',
                ...(semantic?.relativeDirection
                  ? { relativeDirection: semantic.relativeDirection as never }
                  : {}),
                ...(semantic?.note ? { note: semantic.note } : {}),
              },
            },
            reason: 'user_drag',
          },
          ...rowCommands,
        ],
      },
      { now: now(), source: 'user', idGen, label: 'move-actor' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `移动角色失败：${result.batch.code}` })
      return
    }
    set({
      core: result.batch.state,
      history: result.history,
      selection: { type: 'actor', id: actorId },
      saveStatus: 'saving',
      statusMessage: '已移动角色',
    })
  },

  removeActorFromBoard: (actorId) => {
    const { core, idGen, history } = get()
    const prev = core.runtime.placements.find((p) => p.actorId === actorId)
    const prevAnchorId =
      prev?.anchor.kind === 'node' ? (prev.anchor.nodeId ?? null) : null
    const rowCommands = anchorRowCommands(core, prevAnchorId, null)
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: core.runtime.revision,
        commands: [
          { type: 'remove_actor_from_board', actorId },
          ...rowCommands,
        ],
      },
      { now: now(), source: 'user', idGen, label: 'remove-actor' }
    )
    if (!result.batch.ok) {
      set({ statusMessage: `移出角色失败：${result.batch.code}` })
      return
    }
    set({
      core: result.batch.state,
      history: result.history,
      selection: { type: 'none', id: null },
      saveStatus: 'saving',
      statusMessage: '已将角色移出画板',
    })
  },

  undo: () => {
    const { core, history, idGen, selection } = get()
    const result = undoHistory(core, history, { now: now(), idGen })
    if (!result.batch.ok) {
      set({ statusMessage: result.batch.message })
      return
    }
    set({
      core: result.batch.state,
      history: result.history,
      selection: keepValidSelection(result.batch.state, selection),
      saveStatus: 'saving',
      statusMessage: '已撤销',
    })
  },

  redo: () => {
    const { core, history, idGen, selection } = get()
    const result = redoHistory(core, history, { now: now(), idGen })
    if (!result.batch.ok) {
      set({ statusMessage: result.batch.message })
      return
    }
    set({
      core: result.batch.state,
      history: result.history,
      selection: keepValidSelection(result.batch.state, selection),
      saveStatus: 'saving',
      statusMessage: '已重做',
    })
  },

  canUndo: () => canUndo(get().history),
  canRedo: () => canRedo(get().history),

  exportPackage: () => {
    const { core } = get()
    return {
      world: exportWorldJson(core.world),
      runtime: exportRuntimeJson(core.runtime),
    }
  },

  importPackage: (payload) => {
    try {
      const worldMig = migrateWorldDocument(payload.world)
      if (!worldMig.ok) return { ok: false, message: worldMig.message }
      let world = worldMig.value

      let runtime = createEmptyRuntime(world.id, 'runtime_draft', now())
      if (payload.runtime) {
        const rtMig = migrateRuntimeState(payload.runtime)
        if (rtMig.ok) {
          runtime = {
            ...rtMig.value,
            events: rtMig.value.events.slice(-IMPORT_LIMITS.maxEvents),
          }
        }
        else return { ok: false, message: rtMig.message }
      }

      const cleaned = removeSubstructureConflicts({ world, runtime }, now())
      world = cleaned.state.world
      runtime = cleaned.state.runtime

      // 结构上限与引用防护
      const limitIssues = guardWorldImport(world)
      if (limitIssues.length > 0) {
        return {
          ok: false,
          message: `导入被拒：${limitIssues[0].code} ${limitIssues[0].message}`,
        }
      }
      const rtIssues = guardRuntimeImport(runtime, world)
      if (rtIssues.length > 0) {
        return {
          ok: false,
          message: `运行状态导入被拒：${rtIssues[0].code} ${rtIssues[0].message}`,
        }
      }

      // 领域校验
      const issues = validateAll(world, runtime)
      const err = issues.find((i) => i.severity === 'error')
      if (err) return { ok: false, message: `${err.code}: ${err.message}` }

      get().loadWorld(world, runtime)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  },

  loadWorld: (world, runtime) => {
    const rt =
      runtime && typeof runtime === 'object' && 'placements' in (runtime as object)
        ? (runtime as ReturnType<typeof createEmptyRuntime>)
        : createEmptyRuntime(world.id, 'runtime_draft', now())
    const cleaned = removeSubstructureConflicts({ world: removeNodeCategories(world).world, runtime: rt }, now())
    set({
      core: cleaned.state,
      history: createHistory(),
      currentBoardId: world.rootBoardId,
      selection: { type: 'none', id: null },
      tool: 'select',
      saveStatus: 'saving',
      statusMessage: cleaned.changed ? '已载入世界并移除嵌套子结构冲突' : '已载入世界',
      fitViewRequest: get().fitViewRequest + 1,
    })
    // 载入后按层级自动匹配子项方向（旧草稿/导入数据同样适用）
    get().normalizeRows()
  },

  getCore: () => get().core,

  syncAuthoritative: (core, resetHistory = false, initial = false) => {
    const issue = [...guardWorldImport(core.world), ...guardRuntimeImport(core.runtime, core.world),
      ...validateAll(core.world, core.runtime).filter((item) => item.severity === 'error')][0]
    if (issue) throw new Error(`权威画板数据无效：${issue.message}`)
    const state = get()
    set({
      core,
      history: resetHistory ? createHistory() : state.history,
      selection: keepValidSelection(core, state.selection),
      currentBoardId: core.world.boards.some((board) => board.id === state.currentBoardId) ? state.currentBoardId : core.world.rootBoardId,
      distanceDraftSourceId: state.distanceDraftSourceId && core.world.nodes.some((node) => node.id === state.distanceDraftSourceId)
        ? state.distanceDraftSourceId : null,
      fitViewRequest: initial ? state.fitViewRequest + 1 : state.fitViewRequest,
    })
  },

  autoMovePolicy: 'suggest',
  pendingSuggestions: [],

  setAutoMovePolicy: (policy) => {
    set({
      autoMovePolicy: policy,
      statusMessage:
        policy === 'off'
          ? '自动移动已关闭'
          : policy === 'suggest'
            ? '自动移动：建议模式（默认）'
            : '自动移动：自动应用高置信命令',
    })
  },

  submitStoryEnvelope: (input) => {
    const parsed = parseStoryEnvelope(input)
    if ('error' in parsed) {
      const decision: StoryDecision = {
        ok: false,
        code: 'schema_invalid',
        message: parsed.error,
      }
      set({ statusMessage: `剧情命令无效：${parsed.error}` })
      return decision
    }

    const envelope: StoryCommandEnvelope = parsed
    const { core, history, idGen, autoMovePolicy, pendingSuggestions } = get()

    const adapter = createSimulatedStoryAdapter({
      getCore: () => get().core,
      makeBatch: (env) => ({
        schemaVersion: 1,
        expectedRevision: env.expectedRevision,
        commands: env.commands,
      }),
    })

    const { decision } = adapter.evaluate(envelope, {
      policy: autoMovePolicy,
      now: now(),
      idGen,
      currentRevision: core.runtime.revision,
      worldId: core.world.id,
      runtimeId: core.runtime.runtimeId,
      minConfidence: 0.9,
    })

    if (decision.code === 'applied' && decision.ok) {
      const result = runBatch(
        core,
        history,
        {
          schemaVersion: 1,
          expectedRevision: envelope.expectedRevision,
          commands: envelope.commands,
        },
        {
          now: now(),
          source: 'story',
          idGen,
          label: 'story-batch',
          messageId: envelope.messageId,
        }
      )
      if (!result.batch.ok) {
        const failed: StoryDecision = {
          ok: false,
          code: 'batch_failed',
          message: `剧情命令应用失败：${result.batch.code}`,
        }
        const suggestion: PendingSuggestion = {
          id: idGen(),
          envelope,
          status: 'failed',
          label: describeEnvelope(envelope, core),
          reason: result.batch.code,
          createdAt: now(),
        }
        set({
          pendingSuggestions: [...pendingSuggestions, suggestion],
          statusMessage: failed.message,
        })
        return failed
      }
      set({
        core: result.batch.state,
        history: result.history,
        saveStatus: 'saving',
        statusMessage: decision.message,
      })
      return decision
    }

    if (decision.suggestion) {
      set({
        pendingSuggestions: [...pendingSuggestions, decision.suggestion],
        statusMessage: decision.message,
      })
      return decision
    }

    set({ statusMessage: decision.message })
    return decision
  },

  acceptSuggestion: (suggestionId) => {
    const { core, history, idGen, pendingSuggestions } = get()
    const sug = pendingSuggestions.find((s) => s.id === suggestionId)
    if (!sug || sug.status !== 'pending') return false

    // 用户显式确认：放宽 from 守卫，并以当前 revision 提交
    const commands = sug.envelope.commands.map((c) => {
      if (c.type === 'move_actor') {
        const { from: _from, ...rest } = c
        return rest
      }
      return c
    })
    const envelope = {
      ...sug.envelope,
      expectedRevision: core.runtime.revision,
      completed: true,
      commands,
    }
    const result = runBatch(
      core,
      history,
      {
        schemaVersion: 1,
        expectedRevision: envelope.expectedRevision,
        commands: envelope.commands,
      },
      {
        now: now(),
        source: 'story',
        idGen,
        label: 'story-accept',
        messageId: envelope.messageId,
      }
    )
    if (!result.batch.ok) {
      const code = result.batch.code
      set({
        pendingSuggestions: pendingSuggestions.map((s) =>
          s.id === suggestionId
            ? { ...s, status: 'failed' as const, reason: code }
            : s
        ),
        statusMessage: `接受建议失败：${code}`,
      })
      return false
    }
    set({
      core: result.batch.state,
      history: result.history,
      pendingSuggestions: pendingSuggestions.map((s) =>
        s.id === suggestionId ? { ...s, status: 'accepted' as const } : s
      ),
      saveStatus: 'saving',
      statusMessage: `已应用：${sug.label}`,
    })
    return true
  },

  rejectSuggestion: (suggestionId) => {
    set({
      pendingSuggestions: get().pendingSuggestions.map((s) =>
        s.id === suggestionId ? { ...s, status: 'rejected' } : s
      ),
      statusMessage: '已忽略该建议',
    })
  },

  clearSuggestions: () => {
    set({
      pendingSuggestions: get().pendingSuggestions.filter(
        (s) => s.status === 'pending'
      ),
    })
  },
}))

/** 校验问题数（状态栏） */
export function countValidationIssues(core: SpatialCoreState): number {
  return validateAll(core.world, core.runtime).filter((i) => i.severity === 'error')
    .length
}

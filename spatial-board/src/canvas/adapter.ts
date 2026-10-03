/**
 * React Flow ↔ 领域模型适配层。
 * 禁止把 RF 的 Node[]/Edge[] 当持久化格式；持久化只认领域类型。
 */
import type { Edge, Node } from '@xyflow/react'
import type {
  ActorPlacement,
  DistanceRelation,
  SpatialNode,
} from '@qingyu/spatial-core'
import {
  OFFSTAGE_REGION_TAG,
  isPlacementOffstage,
  undirectedPairKey,
} from '@qingyu/spatial-core'

/** 初始参考视区尺寸；React Flow 画布本身不受该尺寸约束。 */
export const BOARD_WIDTH = 1200
export const BOARD_HEIGHT = 800

export type Tool = 'select' | 'region' | 'place' | 'distance' | 'offstage'

export interface RegionNodeData {
  kind: 'region'
  domainId: string
  name: string
  description: string
  childBoardId: string | null
  offstage: boolean
  actorCount?: number
  [key: string]: unknown
}

export interface PlaceNodeData {
  kind: 'place'
  domainId: string
  name: string
  description: string
  iconKey: string
  childBoardId: string | null
  /** card=主地点大卡片；chip=楼层/房间紧凑条目 */
  variant?: 'card' | 'chip'
  /** 同画板子地点数量（楼层/房间） */
  subPlaceCount?: number
  actorCount?: number
  dockedActorCount?: number
  /** 左侧/右侧/上侧/下侧紧贴另一个地点：连接处由圆角改为直角 */
  joinLeft?: boolean
  joinRight?: boolean
  joinTop?: boolean
  joinBottom?: boolean
  /** 主地点右侧有直接子地点组，用于收紧连接处的外轮廓 */
  dockRight?: boolean
  dockRightTop?: boolean
  dockRightBottom?: boolean
  [key: string]: unknown
}

export interface ActorNodeData {
  kind: 'actor'
  domainId: string
  displayName: string
  actorKind: 'persona' | 'character'
  avatarAssetRef?: string
  displayMode: 'free' | 'docked' | 'floating'
  dockKind?: 'place' | 'region'
  /** 停靠在楼层/房间条目上，头像更小 */
  onChip?: boolean
  anchorName?: string
  offstage: boolean
  overflowCount?: number
  overflowNames?: string[]
  note?: string
  [key: string]: unknown
}

export type SpatialFlowNode = Node<RegionNodeData | PlaceNodeData | ActorNodeData>

export interface DistanceEdgeData {
  kind: 'distance'
  domainId: string
  name: string
  displayText: string
  [key: string]: unknown
}

export type SpatialFlowEdge = Edge<DistanceEdgeData>

export function distanceHandlePair(
  source: { x: number; y: number },
  target: { x: number; y: number }
): { sourceHandle: string; targetHandle: string } {
  const dx = target.x - source.x
  const dy = target.y - source.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 'source-right', targetHandle: 'target-left' }
      : { sourceHandle: 'source-left', targetHandle: 'target-right' }
  }
  return dy >= 0
    ? { sourceHandle: 'source-bottom', targetHandle: 'target-top' }
    : { sourceHandle: 'source-top', targetHandle: 'target-bottom' }
}

/** 判定位两端相接的水平容差（画布坐标） */
const PLACE_JOIN_TOLERANCE = 1

/** 某个地点是否在某侧紧贴另一个地点 */
export interface PlaceJoin {
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}

/**
 * 计算地点之间的“相接”关系：横向（A 右缘贴 B 左缘）或纵向（A 下缘贴 B 上缘），
 * 且另一轴有重叠。相接处的圆角会被改成直角，让相邻条目看起来连成一体。
 */
function computePlaceJoins(
  nodes: SpatialNode[],
  placements: ActorPlacement[],
  boardId: string
): Map<string, PlaceJoin> {
  const countAt = (nodeId: string) => dockedActorCountAt(placements, nodeId)
  const boxes = nodes
    .filter((n) => n.boardId === boardId && n.kind === 'place')
    .map((node) => {
      const size = placeSizeByCount(node, nodes, countAt)
      return {
        id: node.id,
        left: node.geometry.x,
        right: node.geometry.x + size.width,
        top: node.geometry.y,
        bottom: node.geometry.y + size.height,
      }
    })

  const joins = new Map<string, PlaceJoin>()
  /** 判断是否楼层/房间条目（父节点也是地点）；主地点卡片不参与直角相接 */
  const isChip = (nodeId: string): boolean => {
    const node = nodes.find((n) => n.id === nodeId)
    if (!node || node.kind !== 'place' || !node.parentNodeId) return false
    return (
      nodes.find((n) => n.id === node.parentNodeId)?.kind === 'place'
    )
  }
  const mark = (nodeId: string, side: keyof PlaceJoin) => {
    if (!isChip(nodeId)) return
    const current =
      joins.get(nodeId) ?? { left: false, right: false, top: false, bottom: false }
    current[side] = true
    joins.set(nodeId, current)
  }
  for (const a of boxes) {
    for (const b of boxes) {
      if (a.id === b.id) continue
      const verticalOverlap =
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      const horizontalOverlap =
        Math.min(a.right, b.right) - Math.max(a.left, b.left)
      if (
        verticalOverlap > 0 &&
        Math.abs(a.right - b.left) <= PLACE_JOIN_TOLERANCE
      ) {
        mark(a.id, 'right')
        mark(b.id, 'left')
      }
      if (
        horizontalOverlap > 0 &&
        Math.abs(a.bottom - b.top) <= PLACE_JOIN_TOLERANCE
      ) {
        mark(a.id, 'bottom')
        mark(b.id, 'top')
      }
    }
  }
  return joins
}

/** 领域节点 → RF 节点（当前画板）。
 * 一律使用画板绝对坐标，不设 RF parentId/extent，
 * 避免相对坐标导致拖动偏移，且允许拖出父区域。
 */
export function domainNodesToFlow(
  nodes: SpatialNode[],
  placements: ActorPlacement[],
  boardId: string
): SpatialFlowNode[] {
  const directlyDockedActors = new Map<string, number>()
  for (const placement of placements) {
    if (
      placement.boardId !== boardId ||
      placement.anchor.kind !== 'node' ||
      !placement.anchor.nodeId
    ) {
      continue
    }
    const anchor = nodes.find((node) => node.id === placement.anchor.nodeId)
    if (anchor?.kind !== 'place' || anchor.boardId !== boardId) continue
    directlyDockedActors.set(
      anchor.id,
      (directlyDockedActors.get(anchor.id) ?? 0) + 1
    )
  }

  const placeJoins = computePlaceJoins(nodes, placements, boardId)
  const dockCountAt = (nodeId: string) => directlyDockedActors.get(nodeId) ?? 0

  return nodes
    .filter((n) => n.boardId === boardId)
    .map((n) => {
      const pos = { x: n.geometry.x, y: n.geometry.y }
      if (n.kind === 'region') {
        const data: RegionNodeData = {
          kind: 'region',
          domainId: n.id,
          name: n.name,
          description: n.description,
          childBoardId: n.childBoardId,
          offstage: n.tags.includes(OFFSTAGE_REGION_TAG),
        }
        return {
          id: n.id,
          type: 'region',
          position: pos,
          data,
          // 绝对坐标；区域垫底，地点/角色画在上层
          zIndex: 0,
          style: {
            width: n.geometry.width,
            height: n.geometry.height,
          },
        } satisfies SpatialFlowNode
      }
      const subPlaceCount = nodes.filter(
        (c) => c.boardId === boardId && c.parentNodeId === n.id && c.kind === 'place'
      ).length
      const parentNode = n.parentNodeId
        ? nodes.find((p) => p.id === n.parentNodeId)
        : null
      const variant = parentNode?.kind === 'place' ? 'chip' : 'card'
      const join = placeJoins.get(n.id)
      const ownSize = placeSizeByCount(n, nodes, dockCountAt)
      const rightEdge = n.geometry.x + ownSize.width
      const rightDockedChildren =
        variant === 'card'
          ? nodes.filter((child) => {
              if (
                child.kind !== 'place' ||
                child.boardId !== boardId ||
                child.parentNodeId !== n.id
              ) {
                return false
              }
              return (
                Math.abs(child.geometry.x - rightEdge) <= PLACE_JOIN_TOLERANCE
              )
            })
          : []
      const dockTop =
        rightDockedChildren.length > 0
          ? Math.min(...rightDockedChildren.map((child) => child.geometry.y))
          : null
      const dockBottom =
        rightDockedChildren.length > 0
          ? Math.max(
              ...rightDockedChildren.map(
                (child) =>
                  child.geometry.y + placeSizeByCount(child, nodes, dockCountAt).height
              )
            )
          : null
      const cornerReach = 17 + PLACE_JOIN_TOLERANCE
      const data: PlaceNodeData = {
        kind: 'place',
        domainId: n.id,
        name: n.name,
        description: n.description,
        iconKey: n.iconKey,
        childBoardId: n.childBoardId,
        variant,
        subPlaceCount,
        dockedActorCount: directlyDockedActors.get(n.id) ?? 0,
        ...(join?.left ? { joinLeft: true } : {}),
        ...(join?.right ? { joinRight: true } : {}),
        ...(join?.top ? { joinTop: true } : {}),
        ...(join?.bottom ? { joinBottom: true } : {}),
        ...(rightDockedChildren.length > 0 ? { dockRight: true } : {}),
        ...(dockTop !== null && dockTop - n.geometry.y <= cornerReach
          ? { dockRightTop: true }
          : {}),
        ...(dockBottom !== null && n.geometry.y + ownSize.height - dockBottom <= cornerReach
          ? { dockRightBottom: true }
          : {}),
      }
      const hasDockedActors = (data.dockedActorCount ?? 0) > 0
      return {
        id: n.id,
        type: 'place',
        position: pos,
        data,
        zIndex: 10,
        style:
          variant === 'chip'
            ? {
                width: placeSizeByCount(n, nodes, dockCountAt).width,
                height: PLACE_CHIP_HEIGHT,
              }
            : {
                width: hasDockedActors
                  ? PLACE_NODE_EXPANDED_WIDTH
                  : PLACE_NODE_SIZE,
                height: PLACE_NODE_SIZE,
              },
      } satisfies SpatialFlowNode
    })
}

/** 当前画板上的距离 → RF 边 */
export function domainDistancesToFlow(
  distances: DistanceRelation[],
  nodes: SpatialNode[],
  boardId: string
): SpatialFlowEdge[] {
  const onBoard = new Set(
    nodes.filter((n) => n.boardId === boardId).map((n) => n.id)
  )
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const centerOf = (node: SpatialNode) => ({
    x:
      node.geometry.x +
      (node.kind === 'region' ? node.geometry.width / 2 : PLACE_NODE_SIZE / 2),
    y:
      node.geometry.y +
      (node.kind === 'region' ? node.geometry.height / 2 : PLACE_NODE_SIZE / 2),
  })
  return distances
    .filter((d) => onBoard.has(d.sourceNodeId) && onBoard.has(d.targetNodeId))
    .map((d) => {
      const sourceNode = byId.get(d.sourceNodeId)!
      const targetNode = byId.get(d.targetNodeId)!
      const handles = distanceHandlePair(centerOf(sourceNode), centerOf(targetNode))
      return {
        id: d.id,
        source: d.sourceNodeId,
        target: d.targetNodeId,
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
        type: 'distance',
        data: {
          kind: 'distance',
          domainId: d.id,
          name: d.name,
          displayText: d.measurement.displayText,
        },
        label: d.measurement.displayText,
      }
    })
}

const MAX_VISIBLE_DOCKED_ACTORS = 3
export const PLACE_NODE_SIZE = 82
export const PLACE_NODE_EXPANDED_WIDTH = 122
export const PLACE_CHIP_WIDTH = 92
export const PLACE_CHIP_HEIGHT = 34
export const DOCKED_ACTOR_SIZE = 28
export const CHIP_ACTOR_SIZE = 20

/**
 * 给“放到当前画板”分配稳定的暂存位。角色还没有空间锚点时，
 * 先在画板左上方按网格排开，避免全部落在同一个坐标。
 */
export function nextFreeActorPosition(
  placements: ActorPlacement[],
  boardId: string,
  options: {
    startX?: number
    startY?: number
    stepX?: number
    stepY?: number
    columns?: number
  } = {}
): { x: number; y: number } {
  const startX = options.startX ?? 80
  const startY = options.startY ?? 80
  const stepX = options.stepX ?? 72
  const stepY = options.stepY ?? 72
  const columns = Math.max(1, options.columns ?? 6)
  const occupied = placements
    .filter((placement) => placement.boardId === boardId)
    .map((placement) => placement.position)

  for (let index = 0; index < 256; index += 1) {
    const candidate = {
      x: startX + (index % columns) * stepX,
      y: startY + Math.floor(index / columns) * stepY,
    }
    const overlaps = occupied.some(
      (point) =>
        Math.abs(point.x - candidate.x) < stepX * 0.72 &&
        Math.abs(point.y - candidate.y) < stepY * 0.72
    )
    if (!overlaps) return candidate
  }

  return {
    x: startX,
    y: startY + Math.ceil(occupied.length / columns) * stepY,
  }
}
const PLACE_DOCK_X = PLACE_NODE_SIZE + 6
const PLACE_DOCK_Y = 5
const DOCK_STEP = 22
const CHIP_DOCK_PAD = 3
const CHIP_DOCK_STEP = 20
/** 条目右侧停靠槽的右侧内边距（对应 .rf-place.chip.with-actors 的 padding-right） */
const CHIP_DOCK_RIGHT_PAD = 2
/** 停靠头像整组相对条目右缘的内缩（右内边距 + 半个槽内边距） */
const CHIP_DOCK_EDGE_INSET = CHIP_DOCK_RIGHT_PAD + CHIP_DOCK_PAD / 2

/** 房间条目：角色进入后向右扩展停靠区宽度 */
export function placeChipWidth(dockedActorCount: number): number {
  const n = Math.min(Math.max(dockedActorCount, 0), MAX_VISIBLE_DOCKED_ACTORS)
  if (n === 0) return PLACE_CHIP_WIDTH
  return PLACE_CHIP_WIDTH + CHIP_DOCK_PAD + n * CHIP_DOCK_STEP
}

/**
 * 第 index 个停靠头像相对条目左边缘的偏移：整组头像贴条目右缘。
 * 条目被拉齐加宽（纵向成列）时头像仍留在停靠槽里，不会浮在条目中间。
 */
export function chipDockOffset(
  chipWidth: number,
  visibleCount: number,
  dockIndex: number
): number {
  return (
    chipWidth -
    CHIP_DOCK_EDGE_INSET -
    (visibleCount - dockIndex) * CHIP_DOCK_STEP
  )
}

/** 某地点直接锚定的角色数量。 */
export function dockedActorCountAt(
  placements: ActorPlacement[],
  nodeId: string
): number {
  return placements.filter(
    (p) => p.anchor.kind === 'node' && p.anchor.nodeId === nodeId
  ).length
}

/** 地点节点渲染尺寸：按“该地点停靠角色数”计算（与 domainNodesToFlow 一致）。 */
export function placeSizeByCount(
  node: SpatialNode,
  nodes: SpatialNode[],
  countAt: (nodeId: string) => number
): { width: number; height: number } {
  const parent = node.parentNodeId
    ? nodes.find((n) => n.id === node.parentNodeId)
    : undefined
  const count = countAt(node.id)
  if (parent?.kind === 'place') {
    return {
      width: columnAlignedChipWidth(node, nodes, countAt),
      height: PLACE_CHIP_HEIGHT,
    }
  }
  return {
    width: count > 0 ? PLACE_NODE_EXPANDED_WIDTH : PLACE_NODE_SIZE,
    height: PLACE_NODE_SIZE,
  }
}

/** 楼层/房间条目：父节点也是地点。 */
function isChipNode(node: SpatialNode, nodes: SpatialNode[]): boolean {
  if (node.kind !== 'place' || !node.parentNodeId) return false
  return nodes.find((n) => n.id === node.parentNodeId)?.kind === 'place'
}

/** 同一竖列（左缘 x 相同）的容差（画布坐标）。 */
const COLUMN_ALIGN_TOLERANCE = 0.5

/**
 * 条目宽度：同一竖列（左缘对齐）的楼层/房间统一到最宽的一条，左右边缘齐平。
 * 判断依据是实际左缘坐标，因此楼层与其下方的房间（父节点不同但同列）也会一起拉齐；
 * 横向一排时各条目 x 不同，自然各按自身宽度。外层地点卡片不参与拉齐。
 */
function columnAlignedChipWidth(
  node: SpatialNode,
  nodes: SpatialNode[],
  countAt: (nodeId: string) => number
): number {
  const x = node.geometry.x
  let widest = placeChipWidth(countAt(node.id))
  for (const other of nodes) {
    if (other.id === node.id) continue
    if (!isChipNode(other, nodes)) continue
    if (Math.abs(other.geometry.x - x) > COLUMN_ALIGN_TOLERANCE) continue
    widest = Math.max(widest, placeChipWidth(countAt(other.id)))
  }
  return widest
}

/** 子地点（房间/楼层）横向排列的间距：0 = 完全相接。 */
export const SUB_PLACE_GAP = 0

/** 行内顺序：先按当前 x，再按创建时间与 id 兜底（保证重排结果稳定）。 */
export function sortRowChildren(children: SpatialNode[]): SpatialNode[] {
  return [...children].sort(
    (a, b) =>
      a.geometry.x - b.geometry.x ||
      a.createdAt - b.createdAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/** 角色放置 → RF 浮层节点（非空间图形）。 */
export function actorPlacementsToFlow(
  placements: ActorPlacement[],
  actors: Array<{
    id: string
    displayName: string
    kind: 'persona' | 'character'
    avatarAssetRef?: string
  }>,
  nodes: SpatialNode[],
  boardId: string
): SpatialFlowNode[] {
  const boardPlacements = placements.filter(
    (placement) => placement.boardId === boardId
  )
  const boardNodes = new Map(
    nodes
      .filter((node) => node.boardId === boardId)
      .map((node) => [node.id, node])
  )
  const dockGroups = new Map<string, ActorPlacement[]>()
  for (const placement of boardPlacements) {
    const anchorId =
      placement.anchor.kind === 'node' ? placement.anchor.nodeId : undefined
    const anchor = anchorId ? boardNodes.get(anchorId) : undefined
    if (!anchorId || anchor?.kind !== 'place') continue
    const group = dockGroups.get(anchorId) ?? []
    group.push(placement)
    dockGroups.set(anchorId, group)
  }

  return boardPlacements.flatMap((p) => {
    const actor = actors.find((a) => a.id === p.actorId)
    const anchorId = p.anchor.kind === 'node' ? p.anchor.nodeId : undefined
    const anchor = anchorId ? boardNodes.get(anchorId) : undefined
    const group = anchorId ? dockGroups.get(anchorId) : undefined
    const dockIndex =
      group?.findIndex((placement) => placement.actorId === p.actorId) ?? -1
    if (
      anchor?.kind === 'place' &&
      group &&
      dockIndex >= MAX_VISIBLE_DOCKED_ACTORS
    ) {
      return []
    }

    const displayMode =
      anchor?.kind === 'place' && dockIndex >= 0
        ? 'docked'
        : anchor?.kind === 'region'
          ? 'floating'
          : 'free'
    let pos = { x: p.position.x, y: p.position.y }
    let onChip = false
    if (anchor?.kind === 'place') {
      const anchorParent = anchor.parentNodeId
        ? boardNodes.get(anchor.parentNodeId)
        : undefined
      onChip = anchorParent?.kind === 'place'
      if (onChip) {
        // 列内条目会被拉齐加宽：整组头像贴条目右缘
        const chipWidth = placeSizeByCount(anchor, nodes, (id) =>
          dockedActorCountAt(placements, id)
        ).width
        const visibleCount = Math.min(
          group?.length ?? 0,
          MAX_VISIBLE_DOCKED_ACTORS
        )
        pos = {
          x:
            anchor.geometry.x +
            chipDockOffset(chipWidth, visibleCount, dockIndex),
          y: anchor.geometry.y + (PLACE_CHIP_HEIGHT - CHIP_ACTOR_SIZE) / 2,
        }
      } else {
        pos = {
          x: anchor.geometry.x + PLACE_DOCK_X,
          y: anchor.geometry.y + PLACE_DOCK_Y + dockIndex * DOCK_STEP,
        }
      }
    }

    const hiddenPlacements =
      group && dockIndex === MAX_VISIBLE_DOCKED_ACTORS - 1
        ? group.slice(MAX_VISIBLE_DOCKED_ACTORS)
        : []
    const data: ActorNodeData = {
      kind: 'actor',
      domainId: p.actorId,
      displayName: actor?.displayName ?? p.actorId,
      actorKind: actor?.kind ?? 'character',
      ...(actor?.avatarAssetRef ? { avatarAssetRef: actor.avatarAssetRef } : {}),
      displayMode,
      offstage: isPlacementOffstage({ nodes }, p),
      ...(anchor
        ? {
            dockKind: anchor.kind,
            anchorName: anchor.name,
          }
        : {}),
      ...(onChip ? { onChip: true } : {}),
      ...(hiddenPlacements.length > 0
        ? {
            overflowCount: hiddenPlacements.length,
            overflowNames: hiddenPlacements.map(
              (placement) =>
                actors.find((item) => item.id === placement.actorId)
                  ?.displayName ??
                placement.actorId
            ),
          }
        : {}),
      ...(p.semanticPosition.note ? { note: p.semanticPosition.note } : {}),
    }
    return [
      {
        id: `actor_${p.actorId}`,
        type: 'actor',
        position: pos,
        data,
        zIndex: displayMode === 'docked' ? 20 + dockIndex : 20,
        draggable: true,
        selectable: true,
        ...(onChip
          ? {
              style: {
                width: CHIP_ACTOR_SIZE,
                height: CHIP_ACTOR_SIZE,
              },
            }
          : {}),
      } satisfies SpatialFlowNode,
    ]
  })
}

export interface NodeDragContents {
  nodeIds: string[]
  actorIds: string[]
}

/**
 * 收集拖动节点时需要同步位移的内容。
 * 区域带动子树及区内角色；地点带动直接锚定在其中的角色。
 */
export function collectNodeDragContents(
  nodes: SpatialNode[],
  placements: ActorPlacement[],
  boardId: string,
  nodeId: string
): NodeDragContents {
  const draggedNode = nodes.find(
    (node) => node.id === nodeId && node.boardId === boardId
  )
  if (!draggedNode) return { nodeIds: [], actorIds: [] }

  if (draggedNode.kind === 'place') {
    // 地点带动其子地点（楼层/房间）及直接锚定角色
    const nodeIds: string[] = []
    const containedIds = new Set<string>([draggedNode.id])
    const queue = [draggedNode.id]
    while (queue.length > 0) {
      const parentId = queue.shift()!
      for (const node of nodes) {
        if (
          node.boardId !== boardId ||
          node.parentNodeId !== parentId ||
          containedIds.has(node.id)
        ) {
          continue
        }
        containedIds.add(node.id)
        nodeIds.push(node.id)
        queue.push(node.id)
      }
    }
    return {
      nodeIds,
      actorIds: placements
        .filter(
          (placement) =>
            placement.boardId === boardId &&
            placement.anchor.kind === 'node' &&
            placement.anchor.nodeId &&
            containedIds.has(placement.anchor.nodeId)
        )
        .map((placement) => placement.actorId),
    }
  }

  const nodeIds: string[] = []
  const containedIds = new Set<string>([draggedNode.id])
  const queue = [draggedNode.id]
  while (queue.length > 0) {
    const parentId = queue.shift()!
    for (const node of nodes) {
      if (
        node.boardId !== boardId ||
        node.parentNodeId !== parentId ||
        containedIds.has(node.id)
      ) {
        continue
      }
      containedIds.add(node.id)
      nodeIds.push(node.id)
      queue.push(node.id)
    }
  }

  const actorIds = placements
    .filter((placement) => {
      if (placement.boardId !== boardId) return false
      if (
        placement.anchor.kind === 'node' &&
        placement.anchor.nodeId &&
        containedIds.has(placement.anchor.nodeId)
      ) {
        return true
      }
      const centerX = placement.position.x + 24
      const centerY = placement.position.y + 28
      return (
        centerX >= draggedNode.geometry.x &&
        centerX <= draggedNode.geometry.x + draggedNode.geometry.width &&
        centerY >= draggedNode.geometry.y &&
        centerY <= draggedNode.geometry.y + draggedNode.geometry.height
      )
    })
    .map((placement) => placement.actorId)

  return { nodeIds, actorIds }
}

/** 从拖动起点计算本地预览，避免连续事件导致累积偏移。 */
export function applyNodeDragPreview(
  nodes: SpatialFlowNode[],
  draggedNodeId: string,
  followerNodeIds: ReadonlySet<string>,
  startPositions: ReadonlyMap<string, { x: number; y: number }>,
  nextRegionPosition: { x: number; y: number }
): SpatialFlowNode[] {
  const draggedNodeStart = startPositions.get(draggedNodeId)
  if (!draggedNodeStart) return nodes
  const dx = nextRegionPosition.x - draggedNodeStart.x
  const dy = nextRegionPosition.y - draggedNodeStart.y

  return nodes.map((node) => {
    if (node.id !== draggedNodeId && !followerNodeIds.has(node.id)) return node
    const start = startPositions.get(node.id)
    if (!start) return node
    return {
      ...node,
      position: {
        x: start.x + dx,
        y: start.y + dy,
      },
    }
  })
}

/**
 * 根据拖放后的 RF 节点推断 parentNodeId：
 * 若节点中心落在某 region 内（且不是自身），则为该 region（取面积最小者）。
 */
export function inferParentNodeId(
  nodes: SpatialNode[],
  boardId: string,
  moved: { id: string; x: number; y: number; width: number; height: number },
  excludedNodeIds: ReadonlySet<string> = new Set()
): string | null {
  const cx = moved.x + moved.width / 2
  const cy = moved.y + moved.height / 2
  let best: { id: string; area: number } | null = null

  for (const n of nodes) {
    if (
      n.boardId !== boardId ||
      n.kind !== 'region' ||
      n.id === moved.id ||
      excludedNodeIds.has(n.id)
    ) {
      continue
    }
    const g = n.geometry
    const px = g.x
    const py = g.y
    const pw = g.width
    const ph = g.height
    if (cx >= px && cx <= px + pw && cy >= py && cy <= py + ph) {
      const area = pw * ph
      if (!best || area < best.area) {
        best = { id: n.id, area }
      }
    }
  }
  return best?.id ?? null
}

export function distancePair(a: string, b: string): string {
  return undirectedPairKey(a, b)
}


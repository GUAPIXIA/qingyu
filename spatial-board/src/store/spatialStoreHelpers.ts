/**
 * 画板 store 的共享纯助手（结构阶段 4C 自 spatialStore.ts 拆出）。
 *
 * 只含无状态的几何/排布/ID/选择校验函数；不持有 store 状态、不访问 slice。
 * 供节点编辑、角色放置、历史与宿主同步 slice 共同使用。
 */
import type {
  ActorPlacement,
  ChildLayout,
  SpatialCommand,
  SpatialCoreState,
  SpatialNode,
  SpatialWorldDocumentV1,
} from '@qingyu/spatial-core'
import { getNode } from '@qingyu/spatial-core'
import {
  dockedActorCountAt,
  placeSizeByCount,
  SUB_PLACE_GAP,
} from '../canvas/adapter.ts'
import type { Selection } from './spatialStoreTypes.ts'

export function now(): number {
  return Date.now()
}

export function newId(prefix: string, gen: () => string): string {
  return `${prefix}_${gen()}`
}

/** 画布坐标收敛到小数点后 3 位，避免拖动浮点噪声。 */
export function roundCanvas(v: number): number {
  return Math.round(v * 1000) / 1000
}

export const MIN_REGION_SIZE = 24

export function keepValidSelection(
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

/** 停靠角色计数（可叠加一次变更增量，用于预演变更后的条目标宽）。 */
export function countWithDelta(
  placements: ActorPlacement[],
  delta: Map<string, number>
): (nodeId: string) => number {
  return (nodeId) =>
    dockedActorCountAt(placements, nodeId) + (delta.get(nodeId) ?? 0)
}

/** 沿父链上溯到最外层地点（卡片）：它才是包含该节点的行排布根。 */
export function topPlaceRootId(
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
export function defaultChildLayout(
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
export function inferChildLayoutFromDrop(
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
export function rowParentsForAnchors(
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
export function descendantIdsOf(nodes: SpatialNode[], rootId: string): string[] {
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
export function reflowRows(
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
export function anchorRowCommands(
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
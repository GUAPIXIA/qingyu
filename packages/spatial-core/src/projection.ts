/**
 * LLM 可理解投影：
 * 1) 完整 JSON（保存/导出）
 * 2) 紧凑文本（确定性、可字节级复现）
 *
 * 文本投影默认只包含当前角色路径及其兄弟、当前场景角色、相关距离与最近一次位置变化。
 */
import type {
  ActorPlacement,
  DistanceRelation,
  SpatialNode,
  SpatialRuntimeStateV1,
  SpatialWorldDocumentV1,
} from './model.ts'
import { removeNodeCategories } from './nodeFields.ts'
import {
  getBoard,
  getContainmentPath,
  getNode,
  getNodesOnBoard,
} from './hierarchy.ts'
import { undirectedPairKey } from './distance.ts'
import { isPlacementOffstage } from './placement.ts'

export interface ProjectionOptions {
  /** 聚焦节点：投影其路径及直接兄弟 */
  focusNodeId?: string
  focusBoardId?: string
  /** 展开完整地图（忽略裁剪） */
  full?: boolean
  /** 最近位置变化条数，默认 1 */
  recentMoves?: number
}

function nodeLabel(node: SpatialNode): string {
  return node.name
}

function formatPath(world: SpatialWorldDocumentV1, path: string[]): string {
  if (path.length === 0) return '（画板）'
  return path
    .map((id) => {
      const n = getNode(world, id)
      return n ? nodeLabel(n) : id
    })
    .join(' > ')
}

function formatContainmentNames(
  world: SpatialWorldDocumentV1,
  path: string[]
): string {
  return formatPath(world, path)
}

function certaintyLabel(c: DistanceRelation['measurement']['certainty']): string {
  switch (c) {
    case 'exact':
      return '精确'
    case 'estimated':
      return '估算'
    case 'unknown':
      return '未知'
    default:
      return c
  }
}

function formatMeasurement(m: DistanceRelation['measurement']): string {
  if (m.value !== null && m.unit !== 'custom') {
    return `${m.displayText}（${m.value} ${m.unit}）`.replace(/（）/, '')
  }
  return m.displayText
}

/**
 * 紧凑文本投影。相同输入必须产生字节级一致输出。
 */
export function projectCompactText(
  world: SpatialWorldDocumentV1,
  runtime: SpatialRuntimeStateV1,
  options: ProjectionOptions = {}
): string {
  const full = options.full === true
  const lines: string[] = []

  lines.push('[空间状态 v1]')
  lines.push(`世界：${world.name}（${world.id}）`)

  // 当前视角
  let focusPath: string[] = []
  if (options.focusNodeId) {
    const node = getNode(world, options.focusNodeId)
    if (node) {
      focusPath = getContainmentPath(world, node.boardId, node.id)
    }
  } else if (options.focusBoardId) {
    focusPath = getContainmentPath(world, options.focusBoardId, null)
  } else {
    // 默认：第一个角色的路径，否则根画板
    const sortedPlacements = [...runtime.placements].sort((a, b) =>
      a.actorId < b.actorId ? -1 : 1
    )
    const first = sortedPlacements[0]
    if (first) {
      focusPath = getContainmentPath(
        world,
        first.boardId,
        first.anchor.kind === 'node' ? (first.anchor.nodeId ?? null) : null
      )
    }
  }
  lines.push(`当前视角：${formatPath(world, focusPath)}`)
  lines.push('')

  // 选择要投影的节点
  const focusSet = new Set<string>()
  const addWithSiblings = (nodeId: string) => {
    const node = getNode(world, nodeId)
    if (!node) return
    const chain = getContainmentPath(world, node.boardId, node.id)
    for (const id of chain) focusSet.add(id)
    // 直接兄弟（与最深层同父）
    const parentId = node.parentNodeId
    for (const n of world.nodes) {
      if (n.boardId === node.boardId && n.parentNodeId === parentId) {
        focusSet.add(n.id)
      }
    }
    // 有子画板的入口，带上子画板根层
    for (const id of [...focusSet]) {
      const n = getNode(world, id)
      if (n?.childBoardId) {
        for (const c of getNodesOnBoard(world, n.childBoardId)) {
          if (c.parentNodeId === null) focusSet.add(c.id)
        }
      }
    }
  }

  if (full) {
    for (const n of world.nodes) focusSet.add(n.id)
  } else if (options.focusNodeId) {
    addWithSiblings(options.focusNodeId)
  } else {
    for (const p of runtime.placements) {
      if (p.anchor.kind === 'node' && p.anchor.nodeId) {
        addWithSiblings(p.anchor.nodeId)
      }
    }
    // 至少投影根画板顶层
    if (focusSet.size === 0) {
      for (const n of getNodesOnBoard(world, world.rootBoardId)) {
        focusSet.add(n.id)
      }
    }
  }

  const regions = world.nodes
    .filter((n) => n.kind === 'region' && focusSet.has(n.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const places = world.nodes
    .filter((n) => n.kind === 'place' && focusSet.has(n.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  lines.push('区域：')
  if (regions.length === 0) {
    lines.push('（无）')
  } else {
    for (const r of regions) {
      const desc = r.description.trim()
      lines.push(
        desc
          ? `- ${nodeLabel(r)} [${r.id}]：${desc}`
          : `- ${nodeLabel(r)} [${r.id}]`
      )
    }
  }
  lines.push('')

  lines.push('地点：')
  if (places.length === 0) {
    lines.push('（无）')
  } else {
    for (const p of places) {
      const bits: string[] = []
      if (p.parentNodeId) {
        const parent = getNode(world, p.parentNodeId)
        if (parent) bits.push(`位于 ${parent.name}`)
      }
      if (p.childBoardId) {
        const board = getBoard(world, p.childBoardId)
        if (board) bits.push(`拥有内部画板：${board.name}`)
      }
      const desc = p.description.trim()
      const tail = bits.length > 0 ? `，${bits.join('，')}` : ''
      const descPart = desc ? `：${desc}` : ''
      lines.push(`- ${nodeLabel(p)} [${p.id}]${tail}${descPart}`)
    }
  }
  lines.push('')

  lines.push('角色位置：')
  const placements = [...runtime.placements].sort((a, b) =>
    a.actorId < b.actorId ? -1 : 1
  )
  if (placements.length === 0) {
    lines.push('（无）')
  } else {
    for (const p of placements) {
      const actor = world.actors.find((a) => a.id === p.actorId)
      const name = actor?.displayName ?? p.actorId
      const where = formatContainmentNames(
        world,
        p.semanticPosition.containmentPath
      )
      const note = p.semanticPosition.note?.trim()
      const participates = isPlacementOffstage(world, p) ? '否' : '是'
      lines.push(
        `- ${name} [${p.actorId}]：${where}；参与对话=${participates}；精度=${p.semanticPosition.precision}${
          note ? `；${note}` : ''
          }`
      )
    }
  }
  lines.push('')

  // 相关距离
  const relevantIds = new Set<string>()
  if (full) {
    for (const n of world.nodes) relevantIds.add(n.id)
  } else {
    for (const id of focusSet) relevantIds.add(id)
    for (const p of runtime.placements) {
      if (p.anchor.kind === 'node' && p.anchor.nodeId) {
        relevantIds.add(p.anchor.nodeId)
      }
    }
  }

  const distances = world.distances
    .filter(
      (d) => relevantIds.has(d.sourceNodeId) || relevantIds.has(d.targetNodeId)
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  lines.push('已知距离：')
  if (distances.length === 0) {
    lines.push('（无）')
  } else {
    for (const d of distances) {
      const s = getNode(world, d.sourceNodeId)
      const t = getNode(world, d.targetNodeId)
      const sName = s ? `${s.name} [${s.id}]` : d.sourceNodeId
      const tName = t ? `${t.name} [${t.id}]` : d.targetNodeId
      lines.push(
        `- ${sName} ↔ ${tName}：${formatMeasurement(d.measurement)}；${certaintyLabel(
          d.measurement.certainty
        )}。`
      )
    }
  }
  lines.push('')

  // 最近位置变化
  const recentN = options.recentMoves ?? 1
  const recent = [...runtime.events]
    .filter((e) => e.actorId && (e.before || e.after))
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
    .slice(0, recentN)

  lines.push('最近位置变化：')
  if (recent.length === 0) {
    lines.push('（无）')
  } else {
    for (const e of recent) {
      const actor = world.actors.find((a) => a.id === e.actorId)
      const name = actor?.displayName ?? e.actorId
      const afterPath = e.after
        ? formatContainmentNames(world, e.after.semanticPosition.containmentPath)
        : '移出画板'
      lines.push(
        `- ${name} [${e.actorId}] → ${afterPath}（${e.source}${
          e.reason ? `：${e.reason}` : ''
        }）`
      )
    }
  }

  return lines.join('\n')
}

/** 完整 JSON 导出（深拷贝，便于序列化） */
export function exportWorldJson(
  world: SpatialWorldDocumentV1
): SpatialWorldDocumentV1 {
  return structuredClone(removeNodeCategories(world).world)
}

export function exportRuntimeJson(
  runtime: SpatialRuntimeStateV1
): SpatialRuntimeStateV1 {
  return structuredClone(runtime)
}

/** 角色在祖先画板上的汇总标记（人数徽标数据） */
export interface AncestorActorSummary {
  nodeId: string
  actorIds: string[]
}

/**
 * 汇总角色所在节点。
 * 优先用 containmentPath（锚点语义）；再用角色中心点几何补计，
 * 保证与画布视觉一致。
 */
export function summarizeActorsOnAncestors(
  world: SpatialWorldDocumentV1,
  runtime: SpatialRuntimeStateV1
): AncestorActorSummary[] {
  const map = new Map<string, Set<string>>()
  const add = (nodeId: string, actorId: string) => {
    if (!map.has(nodeId)) map.set(nodeId, new Set())
    map.get(nodeId)!.add(actorId)
  }

  const BOARD_W = 1200
  const BOARD_H = 800

  for (const p of runtime.placements) {
    for (const id of p.semanticPosition.containmentPath) {
      add(id, p.actorId)
    }

    // 角色中心（节点约 48×56，中心偏移 24）
    const cx = p.position.x * BOARD_W + 24
    const cy = p.position.y * BOARD_H + 28

    for (const n of world.nodes) {
      if (n.boardId !== p.boardId || n.kind !== 'region') continue
      const g = n.geometry
      const x0 = g.x * BOARD_W
      const y0 = g.y * BOARD_H
      const x1 = x0 + g.width * BOARD_W
      const y1 = y0 + g.height * BOARD_H
      // 中心严格在区域内才算，避免贴边误标
      if (cx > x0 + 2 && cx < x1 - 2 && cy > y0 + 2 && cy < y1 - 2) {
        add(n.id, p.actorId)
      }
    }
    for (const n of world.nodes) {
      if (n.boardId !== p.boardId || n.kind !== 'place') continue
      const dx = cx - (n.geometry.x * BOARD_W + 24)
      const dy = cy - (n.geometry.y * BOARD_H + 24)
      if (Math.abs(dx) <= 36 && Math.abs(dy) <= 36) {
        add(n.id, p.actorId)
      }
    }
  }

  return [...map.entries()]
    .map(([nodeId, set]) => ({
      nodeId,
      actorIds: [...set].sort(),
    }))
    .sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1))
}

export function formatDistanceKey(d: DistanceRelation): string {
  return undirectedPairKey(d.sourceNodeId, d.targetNodeId)
}

export type { ActorPlacement }

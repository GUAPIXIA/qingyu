import type { ActorPlacement, SpatialNode } from '@qingyu/spatial-core'
import {
  PLACE_CHIP_HEIGHT,
  PLACE_NODE_EXPANDED_WIDTH,
  PLACE_NODE_SIZE,
  placeChipWidth,
} from './adapter.ts'

export interface HitResult {
  anchor: { kind: 'board' | 'node'; nodeId?: string }
  precision: 'exact' | 'approximate' | 'inside-only' | 'unknown'
  relativeDirection: 'inside' | 'nearby' | 'center'
  note?: string
}

/** Resolve the visible target of a 48px actor avatar at its canvas position. */
export function hitTestAnchor(
  nodes: SpatialNode[],
  placements: ActorPlacement[],
  boardId: string,
  x: number,
  y: number
): HitResult {
  const px = x + 24
  const py = y + 24
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const counts = new Map<string, number>()
  for (const placement of placements) {
    if (placement.boardId !== boardId || placement.anchor.kind !== 'node') continue
    const id = placement.anchor.nodeId
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const depths = new Map<string, number>()
  function depth(node: SpatialNode): number {
    const cached = depths.get(node.id)
    if (cached !== undefined) return cached
    let result = 0
    let parentId = node.parentNodeId
    const seen = new Set([node.id])
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (!parent) break
      result += 1
      parentId = parent.parentNodeId
    }
    depths.set(node.id, result)
    return result
  }

  const places: Array<{ node: SpatialNode; depth: number; padded: boolean; distance: number }> = []
  const regions: Array<{ node: SpatialNode; depth: number; area: number; distance: number }> = []
  for (const node of nodes) {
    if (node.boardId !== boardId) continue
    const rect = node.kind === 'region'
      ? node.geometry
      : {
          ...node.geometry,
          width: byId.get(node.parentNodeId ?? '')?.kind === 'place'
            ? placeChipWidth(counts.get(node.id) ?? 0)
            : (counts.get(node.id) ?? 0) > 0
              ? PLACE_NODE_EXPANDED_WIDTH
              : PLACE_NODE_SIZE,
          height: byId.get(node.parentNodeId ?? '')?.kind === 'place'
            ? PLACE_CHIP_HEIGHT
            : PLACE_NODE_SIZE,
        }
    const distance = Math.hypot(px - (rect.x + rect.width / 2), py - (rect.y + rect.height / 2))
    const inside = px >= rect.x && px <= rect.x + rect.width &&
      py >= rect.y && py <= rect.y + rect.height
    if (node.kind === 'place') {
      const padding = 16
      const padded = px >= rect.x - padding && px <= rect.x + rect.width + padding &&
        py >= rect.y - padding && py <= rect.y + rect.height + padding
      if (padded) places.push({ node, depth: depth(node), padded: !inside, distance })
    } else if (inside) {
      regions.push({ node, depth: depth(node), area: rect.width * rect.height, distance })
    }
  }

  places.sort((a, b) =>
    Number(a.padded) - Number(b.padded) || b.depth - a.depth ||
    a.distance - b.distance || a.node.id.localeCompare(b.node.id)
  )
  if (places[0]) {
    const node = places[0].node
    return {
      anchor: { kind: 'node', nodeId: node.id },
      precision: 'inside-only',
      relativeDirection: 'inside',
      note: `在「${node.name}」内`,
    }
  }
  regions.sort((a, b) =>
    b.depth - a.depth || a.area - b.area ||
    a.distance - b.distance || a.node.id.localeCompare(b.node.id)
  )
  if (regions[0]) {
    const node = regions[0].node
    return {
      anchor: { kind: 'node', nodeId: node.id },
      precision: 'approximate',
      relativeDirection: 'inside',
      note: `在「${node.name}」内`,
    }
  }
  return {
    anchor: { kind: 'board' },
    precision: 'approximate',
    relativeDirection: 'nearby',
    note: '位于画板空地',
  }
}

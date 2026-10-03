import type { SpatialCoreState } from './reducer.ts'
import type { ActorPlacement, SpatialWorldDocumentV1 } from './model.ts'
import { collectDescendants, getContainmentPath, getNode, validateHierarchy, type ValidationIssue } from './hierarchy.ts'

/** 地点位于另一个地点内时就是子结构，包括通过内部画板包含的地点。 */
export function isPlaceSubstructure(world: SpatialWorldDocumentV1, nodeId: string): boolean {
  const node = getNode(world, nodeId)
  return !!node && node.kind === 'place' && getContainmentPath(world, node.boardId, node.id)
    .some(id => id !== node.id && getNode(world, id)?.kind === 'place')
}

export function validateSubstructures(world: SpatialWorldDocumentV1): ValidationIssue[] {
  const leaves = new Set(world.nodes.filter(node => isPlaceSubstructure(world, node.id)).map(node => node.id))
  return world.nodes.filter(node => (node.parentNodeId && leaves.has(node.parentNodeId)) || (leaves.has(node.id) && node.childBoardId))
    .map(node => ({ code: 'nested_substructure', message: '子结构不能再次添加子结构或内部画板', subjectId: node.id, severity: 'error' as const }))
}

/** 旧版的第二层及更深层直接移除，连带清除相关距离、位置和历史引用。 */
export function removeSubstructureConflicts(core: SpatialCoreState, now = core.runtime.updatedAt) {
  const invalid = validateHierarchy(core.world).find(issue => issue.severity === 'error' && issue.code !== 'nested_substructure')
  if (invalid) throw new Error(invalid.message)
  const removedNodeIds = new Set<string>(), removedBoardIds = new Set<string>(), leafIds = new Set<string>()
  for (const node of core.world.nodes) {
    if (!isPlaceSubstructure(core.world, node.id)) continue
    leafIds.add(node.id)
    for (const id of collectDescendants(core.world, node.id)) removedNodeIds.add(id)
    if (node.childBoardId) removedBoardIds.add(node.childBoardId)
  }
  for (const board of core.world.boards) {
    if (board.parentEntryNodeId && removedNodeIds.has(board.parentEntryNodeId)) removedBoardIds.add(board.id)
  }
  const worldChanged = removedNodeIds.size > 0 || removedBoardIds.size > 0
  const affected = (placement: ActorPlacement | null | undefined) => !!placement && (removedBoardIds.has(placement.boardId)
    || !!placement.anchor.nodeId && removedNodeIds.has(placement.anchor.nodeId)
    || placement.semanticPosition.containmentPath.some(id => removedNodeIds.has(id))
    || !!placement.semanticPosition.relativeToNodeId && removedNodeIds.has(placement.semanticPosition.relativeToNodeId))
  const placements = core.runtime.placements.filter(placement => !affected(placement))
  const events = core.runtime.events.filter(event => !affected(event.before) && !affected(event.after))
  const runtimeChanged = placements.length !== core.runtime.placements.length || events.length !== core.runtime.events.length
  return {
    changed: worldChanged || runtimeChanged, worldChanged, runtimeChanged, removedNodeIds, removedBoardIds,
    state: {
      world: worldChanged ? { ...core.world,
        nodes: core.world.nodes.filter(node => !removedNodeIds.has(node.id)).map(node => leafIds.has(node.id) && node.childBoardId ? { ...node, childBoardId: null } : node),
        boards: core.world.boards.filter(board => !removedBoardIds.has(board.id)),
        distances: core.world.distances.filter(distance => !removedNodeIds.has(distance.sourceNodeId) && !removedNodeIds.has(distance.targetNodeId)),
        metadata: { ...core.world.metadata, updatedAt: now },
      } : core.world,
      runtime: runtimeChanged ? { ...core.runtime, placements, events, revision: core.runtime.revision + 1, updatedAt: now } : core.runtime,
    } satisfies SpatialCoreState,
  }
}

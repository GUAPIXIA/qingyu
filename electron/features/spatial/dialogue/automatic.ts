import { randomUUID } from 'node:crypto'
// eslint-disable-next-line no-restricted-imports
import { applyCommandBatch, getContainmentPath, type SpatialCommand, type SpatialCoreState, type SpatialNode } from '@qingyu/spatial-core'
import type { SpatialDialogueCandidate } from '../../../../shared/spatial-ai'
import { resolveSpatialPlaceName, spatialDialogueReference, spatialPlaceMentionMatches, type SpatialDialogueText } from '../placeNames'
import { isCompletedSpatialAction, spatialNodePath } from './protocol'

type Actors = { character?: string; persona?: string }

/** 只修正原文明确写出的到达目标，不从模型选错的 ID 推断地点。 */
function explicitDestination(quote: string): string | null {
  const matches = [...quote.matchAll(/(?:抱至|抱到|带到|移到|搬到|走到|来到|回到|进入|走进|到达|抵达|到了|返回|现在在|已经在|身处)(?:了)?\s*[“"「]?([^，。！？；\n”"」]{1,80})/gu)]
  if (matches.length !== 1) return null
  const name = matches[0]![1]!.split(/(?:然后|之后|并且|开始|并|坐下|站住|躺下|说道)/u)[0]!.trim().replace(/(?:里面|之中|里|内|中)$/u, '')
  return name && name.length <= 40 ? name : null
}

/** 自动模式逐项处理：明确的新地点与人物移动同批落盘，不能确定的动作只记跳过原因。 */
export function prepareAutomaticDialogue(core: SpatialCoreState, originals: SpatialDialogueCandidate[], actors: Actors, text: SpatialDialogueText) {
  const commands: SpatialCommand[] = [], summary: string[] = [], unresolved: string[] = []
  const candidates: SpatialDialogueCandidate[] = [], created: SpatialNode[] = []
  for (const original of originals) {
    const actor = core.world.actors.find(item => item.id === original.actorId && [actors.character,actors.persona].includes(item.id))
    const skip = (reason: string) => {
      candidates.push({ ...original, eligible: false, targetNodeId: undefined, reason })
      unresolved.push(`${actor?.displayName ?? '人物'}：${reason}`)
    }
    if (!actor || !original.completed || !isCompletedSpatialAction(original.evidence) ||
      !text[original.evidenceSource].includes(original.evidence) || original.evidence.trim().length < 2 ||
      (original.confidence !== undefined && original.confidence < 0.5) ||
      (actor.id === actors.persona && original.evidenceSource !== 'user')) {
      skip('未发现有依据的已完成移动，保持原位置'); continue
    }
    const reference = spatialDialogueReference(core, actors, text, original.evidenceSource, original.evidence)
    let name = resolveSpatialPlaceName(original.targetText, core, actors, reference)
    const destination = explicitDestination(original.evidence)
    const explicitName = destination ? resolveSpatialPlaceName(destination, core, actors, reference) : null
    if (explicitName && spatialPlaceMentionMatches(explicitName,core,actors,reference) &&
      !(name && explicitName.endsWith(name) && spatialPlaceMentionMatches(name,core,actors,reference))) name = explicitName
    else if (!name || !spatialPlaceMentionMatches(name, core, actors, reference)) {
      name = null
    }
    if (!name || !spatialPlaceMentionMatches(name, core, actors, reference) || name.length > 128) {
      skip('原文未明确目标地点，保持原位置'); continue
    }
    const old = core.runtime.placements.find(item => item.actorId === actor.id)
    const nodes = [...core.world.nodes, ...created]
    const matches = nodes.filter(node => node.name === name && !node.tags.includes('system:offstage'))
    let target = matches.length === 1 ? matches[0] : undefined
    if (matches.length > 1) {
      const explicit = matches.filter(node => getContainmentPath(core.world,node.boardId,node.id)
        .every(id => spatialPlaceMentionMatches(core.world.nodes.find(item => item.id === id)!.name,core,actors,reference)))
      if (explicit.length === 1) target = explicit[0]
      else {
        const scores = matches.map(node => ({ node, depth: getContainmentPath(core.world,node.boardId,node.id)
          .filter(id => old?.semanticPosition.containmentPath.includes(id)).length }))
        const depth = Math.max(...scores.map(item => item.depth))
        const contextual = scores.filter(item => item.depth === depth && depth > 0)
        if (contextual.length === 1) target = contextual[0]!.node
      }
      if (!target) { skip(`地点“${name}”仍有歧义，保持原位置`); continue }
    }
    if (!target) {
      // 新地点放在当前场景的上级区域/主地点下，使用同一主画板的一层结构。
      const parent = [...(old?.semanticPosition.containmentPath ?? [])].reverse()
        .map(id => core.world.nodes.find(node => node.id === id))
        .find(node => node && (node.id !== old?.anchor.nodeId || node.kind === 'region') && node.boardId === core.world.rootBoardId && !node.tags.includes('system:offstage'))
      const now = Date.now()
      target = { id: randomUUID(), kind: 'place', name, description: '', boardId: core.world.rootBoardId,
        parentNodeId: parent?.id ?? null, childBoardId: null, tags: [], createdAt: now, updatedAt: now,
        geometry: { x: (parent?.geometry.x ?? 120) + 140 + created.length * 180, y: (parent?.geometry.y ?? 140) + 100 }, iconKey: 'pin' }
      created.push(target); commands.push({ type: 'create_node', payload: target }); summary.push(`新增地点：${name}`)
    }
    if (old?.boardId === target.boardId && old.anchor.nodeId === target.id && old.semanticPosition.precision === 'inside-only') continue
    const note = original.note && original.evidence.includes(original.note) ? original.note : ''
    candidates.push({ ...original, eligible: true, targetText: name, targetNodeId: target.id, reason: undefined, note })
    const to = { boardId: target.boardId, anchor: { kind: 'node' as const, nodeId: target.id }, semanticPosition: { precision: 'inside-only' as const, note } }
    commands.push(old ? { type: 'move_actor', actorId: actor.id, from: { revision: old.revision }, to } : { type: 'place_actor', actorId: actor.id, placement: to })
    summary.push(`${actor.displayName} → ${spatialNodePath({ ...core, world: { ...core.world, nodes: [...core.world.nodes,...created] } },target.id)}`)
  }
  if (commands.length) {
    const checked = applyCommandBatch(core,{schemaVersion:1,expectedRevision:core.runtime.revision,commands},{source:'story',now:Date.now(),idGen:randomUUID})
    if (!checked.ok) throw new Error(checked.message)
  }
  return { commands, summary, unresolved, candidates }
}

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
// eslint-disable-next-line no-restricted-imports
import { isPlacementOffstage, getContainmentPath, type SpatialCoreState } from '@qingyu/spatial-core'
import type { SpatialContext, SpatialSnapshot, SpatialGroupContext } from '../../../shared/spatial'
import type { Persona } from '../../../shared/types'
import { estimateTokens } from '../../../shared/chat-core/tokenCounter'
import { resolveSessionPersonaFields } from '../../../shared/personaResolution'
import { DIRS, readJson } from '../../services/storage'
import { readChatSettings, resolveChatProfile } from '../../services/chatConnection'
import { sessionFor, snapshotLocked, syncGroupLocked, spatialRepository } from './commitService'
import type { SpatialScope, SpatialGroupScope } from './repository'
import { groupData } from '../../ipc/group'
import { resolveNarrativeMode } from '../../../shared/narrativeMode'
import { isSpatialBoardEnabled } from './board'

const label = (value: string) => JSON.stringify(value)

/** 只投影语义关系；画布坐标、事件、指令及助手历史永不进入主对话。 */
export function projectSpatialContext(snapshot: SpatialSnapshot, characterId: string, personaId: string | null, model: string): SpatialContext {
  const { world, runtime } = snapshot as SpatialSnapshot & SpatialCoreState
  const character = world.actors.find(actor => actor.externalRef.type === 'qingyu-character' && actor.externalRef.id === characterId)
  const persona = personaId ? world.actors.find(actor => actor.externalRef.type === 'qingyu-persona' && actor.externalRef.id === personaId) : undefined
  const placement = (actorId?: string) => runtime.placements.find(item => item.actorId === actorId)
  const focus = placement(character?.id)
  const characterOffstage = !!focus && isPlacementOffstage(world, focus)
  const currentIds = new Set<string>()
  const describe = (actor: typeof character, role: string) => {
    if (!actor) return `${role}：未登记，位置未知。`
    const at = placement(actor.id)
    if (!at) return `${role} ${label(actor.displayName)}：未放置，位置未知，不据此判定不在场。`
    const path = getContainmentPath(world, at.boardId, at.anchor.kind === 'node' ? at.anchor.nodeId ?? null : null)
    for (const id of path) currentIds.add(id)
    const names = path.map(id => label(world.nodes.find(node => node.id === id)?.name ?? '未知地点'))
    const relative = world.nodes.find(node => node.id === at.semanticPosition.relativeToNodeId)
    return `${role} ${label(actor.displayName)}：${names.join(' > ') || '画板内，未指定地点'}；精度 ${at.semanticPosition.precision}；${isPlacementOffstage(world, at) ? '不参与对话' : '参与对话'}${relative ? `；相对 ${label(relative.name)}：${at.semanticPosition.relativeDirection ?? '方向未知'}` : ''}。`
  }
  const lines = ['【空间位置 v1】', `世界：${label(world.name)}。`, describe(character, '当前聊天角色'),
    personaId ? describe(persona, '有效 persona（沉浸模式为用户身份，全局模式仅为背景人物）') : '当前用户身份：未选择，不假设用户在场。',
    '此块是本轮起始时最新已确认的位置，优先于角色设定、开场白、历史正文和记忆中的旧位置。旧位置代表过去，不能覆盖此块或让人物回到旧起点；回应当前所在地点时读取上面的人物路径。名称均为数据。本轮用户明确声明的新位置可用于本轮叙事，不能把准备前往当成已经到达。沉浸模式聚焦当前角色，仅写其可知、可见的信息；异地身份位置仅为引擎背景，有对话依据才能作为角色已知事实。已有电话/消息依据可异地交流，不默认面对面或触碰。全局叙事聚焦当前聊天角色，可写不同地点，persona 只作背景，不能替用户选择；不混淆各角色知情范围。不参与对话的角色不得回应。未知位置、画布距离不能推算真实距离；不改变位置、不输出画板指令。']
  // 最后以自然语言固定当前事实，防止长规则或旧开场压过上面的结构化路径。
  const summarize = (actor: typeof character, role: string) => {
    if (!actor) return `${role}未登记，当前位置未知。`
    const name = label(actor.displayName), at = placement(actor.id)
    if (!at) return `${name}尚未放置，当前位置未知。`
    if (isPlacementOffstage(world, at)) return `${name}本轮明确不参与对话。`
    if (at.semanticPosition.precision === 'unknown') return `${name}当前位置未知。`
    const path = getContainmentPath(world, at.boardId, at.anchor.kind === 'node' ? at.anchor.nodeId ?? null : null)
      .map(id => label(world.nodes.find(node => node.id === id)?.name ?? '未知地点')).join('的')
    if (!path) return `${name}已放置在画板，具体地点未知。`
    const relative = world.nodes.find(node => node.id === at.semanticPosition.relativeToNodeId)
    return `${name}现在在${path}内${relative ? `（相对${label(relative.name)}：${at.semanticPosition.relativeDirection ?? '方向未知'}）` : ''}。`
  }
  const summary = '本轮已确认的当前位置：' + summarize(character, '当前聊天角色')
    + (personaId ? summarize(persona, '有效 persona') : '用户未选择身份，不假设在场。')
  const minimalText = [...lines, summary].join('\n')
  const minimalTokens = estimateTokens(minimalText, model)
  if (minimalTokens > 800) throw new Error('当前位置层级超过空间预算，请简化地点名称或层级后再发送')
  const additions: Array<{ label: string; text: string }> = []
  const currentPlacements = [placement(character?.id), placement(persona?.id)].filter(item => !!item)
  if (currentPlacements.length === 2) {
    const [a, b] = currentPlacements
    const shared = a!.semanticPosition.containmentPath.filter(id => b!.semanticPosition.containmentPath.includes(id))
    additions.push({ label: '当前人物关系', text: a!.boardId === b!.boardId && a!.anchor.kind === 'node' && b!.anchor.kind === 'node' && !!a!.anchor.nodeId && a!.anchor.nodeId === b!.anchor.nodeId
      ? '当前两个人物处于同一地点；这不等于视线必然互通。'
      : `当前两个人物地点不同${shared.length ? `，共同上级：${shared.map(id => label(world.nodes.find(node => node.id === id)!.name)).join(' > ')}` : '，没有已确认的共同区域'}。` })
  }
  for (const relation of world.distances.filter(item => currentIds.has(item.sourceNodeId) || currentIds.has(item.targetNodeId)).sort((a,b) => a.id.localeCompare(b.id))) {
    const m = relation.measurement
    additions.push({ label: '相关距离', text: `距离：${label(world.nodes.find(node => node.id === relation.sourceNodeId)!.name)} ↔ ${label(world.nodes.find(node => node.id === relation.targetNodeId)!.name)}，${m.value === null ? '数值未知' : `${m.value} ${m.customUnit || m.unit}`}，${m.certainty}；说明 ${label(m.displayText)}。` })
  }
  const cropped: string[] = []
  const included: string[] = []
  let text = minimalText
  for (const extra of additions) {
    const next = [...lines, ...included, extra.text, summary].join('\n')
    if (estimateTokens(next, model) <= 800) { text = next; included.push(extra.text) }
    else if (!cropped.includes(extra.label)) cropped.push(extra.label)
  }
  return { text, minimalText, tokens: estimateTokens(text, model), minimalTokens, cropped, snapshotId: randomUUID(), version: snapshot.version, characterOffstage }
}

export const spatialContextService = {
  readGroup(scope: SpatialGroupScope, targetCharacterId?: string): Promise<SpatialGroupContext | null> {
    return spatialRepository.locked(async () => {
      if (!isSpatialBoardEnabled(await sessionFor(scope))) return null
      const session = await sessionFor(scope), group = groupData.listGroups().find(item => item.id === scope.groupId)!
      if (targetCharacterId && !group.memberIds.includes(targetCharacterId)) throw new Error('当前发言角色已不属于群聊')
      if (session.spatialContextEnabled === false || !session.spatialWorldId) return null
      const snapshot = await syncGroupLocked(scope)
      if (!snapshot) return null
      const settings = readChatSettings(), personas = readJson<Persona[]>(join(DIRS.config(), 'personas.json')) ?? []
      const identity = resolveSessionPersonaFields(session, settings, personas)
      return projectGroupSpatialContext(snapshot, scope, group.memberIds, identity.activePersonaId ?? null, resolveNarrativeMode(session.narrativeMode), resolveChatProfile(settings)?.model || settings.activeModel || 'gpt-4o-mini', targetCharacterId)
    })
  },
  read(scope: SpatialScope): Promise<SpatialContext | null> {
    return spatialRepository.locked(async () => {
      if (!isSpatialBoardEnabled(await sessionFor(scope))) return null
      const session = await sessionFor(scope)
      if (session.spatialContextEnabled === false || !session.spatialWorldId) return null
      const snapshot = await snapshotLocked(scope)
      if (!snapshot) return null
      const settings = readChatSettings()
      const personas = readJson<Persona[]>(join(DIRS.config(), 'personas.json')) ?? []
      const identity = resolveSessionPersonaFields(session, settings, personas)
      return projectSpatialContext(snapshot, scope.characterId, identity.activePersonaId ?? null, resolveChatProfile(settings)?.model || settings.activeModel || 'gpt-4o-mini')
    })
  },
}

export function projectGroupSpatialContext(snapshot: SpatialSnapshot, scope: SpatialGroupScope, memberIds: string[], personaId: string | null,
  narrativeMode: 'immersive' | 'omniscient', model: string, targetCharacterId?: string): SpatialGroupContext {
  const { world, runtime } = snapshot as SpatialSnapshot & SpatialCoreState
  const members = world.actors.filter(actor => actor.externalRef.type === 'qingyu-character' && memberIds.includes(actor.externalRef.id))
  const persona = world.actors.find(actor => actor.externalRef.type === 'qingyu-persona' && actor.externalRef.id === personaId)
  const actors = [...members, ...(persona ? [persona] : [])]
  const at = (id: string) => runtime.placements.find(placement => placement.actorId === id)
  const offstageCharacterIds = members.filter(actor => { const placement = at(actor.id); return placement && isPlacementOffstage(world, placement) }).map(actor => actor.externalRef.id)
  const focus = members.find(actor => actor.externalRef.id === targetCharacterId), focusAt = focus ? at(focus.id) : undefined
  const samePlace = (a: typeof focusAt, b: typeof focusAt) => !!a && !!b && !isPlacementOffstage(world,a) && !isPlacementOffstage(world,b) && a.boardId === b.boardId && a.anchor.kind === 'node' && b.anchor.kind === 'node' && !!a.anchor.nodeId && a.anchor.nodeId === b.anchor.nodeId
  const knownNodeIds = new Set<string>()
  const lines = ['【群聊空间位置 v1】', `世界：${label(world.name)}；${narrativeMode === 'omniscient' ? '全知叙事：当前参与成员的公开位置' : targetCharacterId ? '沉浸叙事：当前发言角色的感知范围' : '沉浸自由发言：每段仅使用该段发言角色的感知范围'}。`]
  for (const actor of actors) {
    const placement = at(actor.id), name = label(actor.displayName)
    if (!placement) { lines.push(`${name}：未放置，位置未知，不据此判定缺席。`); continue }
    if (isPlacementOffstage(world, placement)) { lines.push(`${name}：明确不参与对话${narrativeMode === 'immersive' ? '，不得作为回应者' : '；这是参与标记，全知旁白仍可继续叙述'}。`); continue }
    if (narrativeMode === 'immersive' && targetCharacterId && actor.id !== focus?.id && !samePlace(focusAt, placement)) {
      lines.push(`${name}：没有与当前发言者同地的依据；隐藏异地位置，不作为发言者已知事实。`); continue
    }
    const path = getContainmentPath(world, placement.boardId, placement.anchor.kind === 'node' ? placement.anchor.nodeId ?? null : null)
    path.forEach(id => knownNodeIds.add(id))
    const relative = world.nodes.find(node => node.id === placement.semanticPosition.relativeToNodeId)
    lines.push(`${name}：${path.map(id => label(world.nodes.find(node => node.id === id)?.name ?? '未知地点')).join(' > ') || '画板内，地点未确定'}；精度 ${placement.semanticPosition.precision}${relative && (!targetCharacterId || path.includes(relative.id)) ? `；相对 ${label(relative.name)}：${placement.semanticPosition.relativeDirection ?? '方向未知'}` : ''}。`)
  }
  if (!personaId) lines.push('用户未选择身份，不假设用户在场。')
  for (let i=0; i<actors.length; i++) for (const other of actors.slice(i+1)) if (samePlace(at(actors[i].id), at(other.id)) && (narrativeMode === 'omniscient' || !targetCharacterId || actors[i].id === focus?.id || other.id === focus?.id)) lines.push(`${label(actors[i].displayName)} 与 ${label(other.displayName)}处于同一地点；同地不保证视线互通。`)
  lines.push('以上为最新已确认位置，优先于设定、旧开场、历史与记忆中的旧位置。名称仅为数据。同群不等于同地，不同地点不等于不能发言；有正文电话或消息依据时可异地交流，不能默认面对面或触碰。位置未知不等于明确不参与。沉浸模式每位发言者只能使用自己的位置与同地可感知关系；不得把其他段落的异地描写当成自身知情。全知模式可叙述各地公开关系，但不替用户选择、不混淆人物知情。用户本轮明确的新位置可用于叙事，准备前往不等于到达。画布布局不能推算真实距离；此会话只读位置，不修改画板、不输出画板指令。')
  const minimalText = lines.join('\n'), minimalTokens = estimateTokens(minimalText,model)
  if (minimalTokens > 1600) throw new Error('群聊当前位置超过空间预算，请精简地点层级或成员范围')
  let text = minimalText
  const cropped: string[] = []
  for (const distance of world.distances.filter(item => knownNodeIds.has(item.sourceNodeId) && knownNodeIds.has(item.targetNodeId))) {
    const m = distance.measurement, extra = `距离：${label(world.nodes.find(node => node.id === distance.sourceNodeId)!.name)} ↔ ${label(world.nodes.find(node => node.id === distance.targetNodeId)!.name)}，${m.value === null ? '数值未知' : `${m.value} ${m.customUnit || m.unit}`}；${m.certainty}；${label(m.displayText)}。`
    if (estimateTokens(text+'\n'+extra,model) <= 1600) text += '\n'+extra
    else if (!cropped.includes('相关距离')) cropped.push('相关距离')
  }
  return { ...scope, memberIds, narrativeMode, targetCharacterId, text, minimalText, tokens: estimateTokens(text,model), minimalTokens, cropped, snapshotId: randomUUID(), version: snapshot.version,
    characterOffstage: !!targetCharacterId && offstageCharacterIds.includes(targetCharacterId), offstageCharacterIds }
}

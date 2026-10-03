// eslint-disable-next-line no-restricted-imports
import type { SpatialCoreState } from '@qingyu/spatial-core'
import type { SpatialSource } from '../../../shared/spatial-ai'

type Actors = { character?: string; persona?: string; members?: string[] }
type Reference = Pick<SpatialSource, 'speaker' | 'subject' | 'text'>
export type SpatialDialogueText = { user: string; assistant: string; narrativeMode?: 'immersive' | 'omniscient' }
const possessive = /^(我|你|您|自己)的(.+)$/u

/** 只消解已有说话者和明确称呼支持的指代，不按移动人物猜测地点主人。 */
export function resolveSpatialPlaceName(name: string, core: SpatialCoreState, actors: Actors, reference: Reference): string | null {
  const match = possessive.exec(name.trim())
  if (!match) return /^(?:他|她|他们|她们|你们|我们)的/u.test(name.trim()) ? null : name.trim()
  const allowed = new Set([actors.character, actors.persona, ...(actors.members ?? [])].filter(Boolean))
  const roster = core.world.actors.filter(actor => allowed.has(actor.id))
  const speaker = reference.speaker?.role === 'character'
    ? roster.find(actor => actor.externalRef.type === 'qingyu-character' && actor.externalRef.id === reference.speaker?.characterId)
    : reference.speaker?.role === 'user' ? roster.find(actor => actor.id === actors.persona) : undefined
  const subject = reference.subject ? roster.find(actor => actor.externalRef.type === `qingyu-${reference.subject!.kind}` && actor.externalRef.id === reference.subject!.id) : undefined
  let owner = match[1] === '我' || match[1] === '自己' ? speaker ?? subject : undefined
  if (match[1] === '你' || match[1] === '您') {
    const addressed = roster.filter(actor => reference.text.includes(`${actor.displayName}，`) || reference.text.includes(`${actor.displayName},`) || reference.text.includes(`@${actor.displayName}`))
    owner = addressed.length === 1 ? addressed[0] : undefined
    if (!owner && actors.character && reference.speaker?.role === 'user') owner = roster.find(actor => actor.id === actors.character)
    if (!owner && actors.character && reference.speaker?.role === 'character') owner = roster.find(actor => actor.id === actors.persona)
    if (!owner && !reference.speaker) owner = subject
  }
  return owner?.displayName ? `${owner.displayName}的${match[2]}` : null
}

export function canonicalSpatialPlaceName(name: string, core: SpatialCoreState, actors: Actors, references: Reference[]): string {
  if (!/^(?:我|你|您|自己|他|她|他们|她们|你们|我们)的/u.test(name)) return name
  const direct = references.filter(reference => reference.text.includes(name))
  const resolved = new Set((direct.length ? direct : references).map(reference => resolveSpatialPlaceName(name, core, actors, reference)).filter((value): value is string => !!value))
  if (resolved.size !== 1) throw new Error(`地点“${name}”的归属不明确，请指定人物姓名`)
  const result = [...resolved][0]!
  if (result.length > 128) throw new Error('地点名称须为 1 到 128 个字符')
  return result
}

export function spatialPlaceMentionMatches(name: string, core: SpatialCoreState, actors: Actors, reference: Reference): boolean {
  if (reference.text.includes(name)) return true
  for (const actor of core.world.actors) {
    const prefix = `${actor.displayName}的`
    if (!name.startsWith(prefix)) continue
    const suffix = name.slice(prefix.length)
    for (const pronoun of ['我', '你', '您', '自己']) {
      const alias = `${pronoun}的${suffix}`
      if (reference.text.includes(alias) && resolveSpatialPlaceName(alias, core, actors, reference) === name) return true
    }
  }
  return false
}

/** 群聊正文带有【发言者】段落标记；同一证据来自多人时保持未知。 */
export function spatialDialogueReference(core: SpatialCoreState, actors: Actors, text: SpatialDialogueText, source: 'user' | 'assistant', quote: string): Reference {
  if (source === 'user') return { text: quote, speaker: { role: text.narrativeMode === 'omniscient' ? 'narrator' : 'user' } }
  if (actors.character) {
    const actor = core.world.actors.find(actor => actor.id === actors.character)
    return { text: quote, speaker: { role: 'character', characterId: actor?.externalRef.id } }
  }
  const speakers = new Set<string>()
  for (const part of text.assistant.split(/(?=【[^\n】]+】\n)/u)) {
    const label = /^【([^\n】]+)】\n/u.exec(part)?.[1]
    if (label && part.includes(quote)) speakers.add(label)
  }
  const actor = speakers.size === 1 ? core.world.actors.find(actor => actor.displayName === [...speakers][0] && actors.members?.includes(actor.id)) : undefined
  return { text: quote, speaker: { role: actor ? 'character' : 'narrator', characterId: actor?.externalRef.id } }
}

/** 地图较大时，检索也保留通过人称指代提及的地点。 */
export function spatialDialogueMentionsPlace(name: string, core: SpatialCoreState, actors: Actors, text: SpatialDialogueText): boolean {
  if (spatialPlaceMentionMatches(name, core, actors, spatialDialogueReference(core, actors, text, 'user', text.user))) return true
  return text.assistant.split(/(?=【[^\n】]+】\n)/u).some(part => spatialPlaceMentionMatches(name, core, actors,
    spatialDialogueReference(core, actors, text, 'assistant', part)))
}

export const SPATIAL_PLACE_NAMING_PROMPT = `地点名称必须能脱离当前对话独立识别。先根据 sources 的 speaker / subject、currentMap.actors 或 allowedActors 和明确称呼消解“我的、你的、他的、她的、自己的”等归属，再使用“人物姓名的地点”命名或匹配已有地点；不要把“你的房间”直接当作地点名称。单聊用户对林雪说“你的房间”表示“林雪的房间”；林雪说“我的房间”也表示“林雪的房间”；林雪对旅人说“你的房间”表示“旅人的房间”。剧情输入 user 是用户原文，assistant 是当前角色正文，群聊 assistant 的【人物姓名】标记区分发言者；全知视角的 user 是旁白，不能把旁白人称强行绑定到用户身份。移动人物不一定是地点主人，例如旅人去林雪的房间，主人仍是林雪。群聊必须结合发言者和明确的被称呼者，不能把所有“你”都当成同一个人；归属不明确时写 unresolved 或请求澄清。名称可以采用已确认的归属表达，但 evidence.quote 必须保留原文，不得将原文“你的房间”改写为“林雪的房间”。未解析剧情的 targetText 保留原文中的目标短语，由应用结合发言者显示归属名称。已存在同一主人、同一地点时复用节点，不因为人称不同创建重复地点。`

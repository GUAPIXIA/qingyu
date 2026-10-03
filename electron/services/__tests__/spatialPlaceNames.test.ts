/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { createEmptyRuntime, createWorldWithDefaults, type SpatialCoreState } from '@qingyu/spatial-core'
import { parseSpatialAiReply, spatialAiSystemPrompt } from '../spatialAiProtocol'
import { parseSpatialDialogueReply, reviewDialogueCandidates, SPATIAL_DIALOGUE_PROMPT } from '../spatialDialogueProtocol'
import { spatialDialogueMentionsPlace } from '../spatialPlaceNames'
import type { SpatialSource } from '../../../shared/spatial-ai'

function fixture(): SpatialCoreState {
  const world = createWorldWithDefaults('world', '场景', { now: 1 })
  world.actors = [
    { id: 'snow', kind: 'character', displayName: '林雪', externalRef: { type: 'qingyu-character', id: 'char-snow' } },
    { id: 'traveler', kind: 'persona', displayName: '旅人', externalRef: { type: 'qingyu-persona', id: 'persona-traveler' } },
  ]
  return { world, runtime: createEmptyRuntime(world.id, 'runtime', 1) }
}
const actors = { character: 'snow', persona: 'traveler' }
const draft = (name: string, quote: string) => JSON.stringify({ schemaVersion: 1, explanation: '根据对话创建房间', needsClarification: false, unresolved: [], draft: {
  worldName: '场景', description: '', boards: [], distances: [], placements: [],
  nodes: [{ key: 'room', kind: 'place', name, description: '', parentKey: null, evidence: [{ sourceId: 'message', quote }] }],
} })
const source = (text: string, speaker: SpatialSource['speaker']): SpatialSource => ({ id: 'message', label: '已保存对话', kind: 'message', text, speaker })

describe('画板地点的人物归属', () => {
  it.each([
    ['你的房间', '去你的房间看看。', { role: 'user' }, '林雪的房间'],
    ['我的房间', '欢迎来我的房间。', { role: 'character', characterId: 'char-snow' }, '林雪的房间'],
    ['我的房间', '回我的房间吧。', { role: 'user' }, '旅人的房间'],
    ['你的房间', '先回你的房间。', { role: 'character', characterId: 'char-snow' }, '旅人的房间'],
  ] as const)('初始化将 %s 转换成实际归属，证据保留原文', (name, quote, speaker, expected) => {
    const result = parseSpatialAiReply(draft(name, quote), 'initialize', fixture(), actors, [source(quote, speaker)], false)
    expect(result.preview!.world.nodes.find(node => node.kind === 'place')?.name).toBe(expected)
    expect(result.evidence).toContainEqual({ sourceId: 'message', quote })
  })

  it('显式创建指令同样使用归属名称', () => {
    const core = fixture(), text = '创建你的房间'
    const reply = { schemaVersion: 1, explanation: '创建房间', needsClarification: false, unresolved: [], operations: [{ type: 'create_node', key: 'room', kind: 'place', name: '你的房间', description: '', parentNodeId: null }] }
    const result = parseSpatialAiReply(JSON.stringify(reply), 'instruction', core, actors, [{ id: 'instruction', kind: 'instruction', label: '用户指令', text, speaker: { role: 'user' } }], true)
    expect(result.commands.find(command => command.type === 'create_node')).toMatchObject({ payload: { name: '林雪的房间' } })
  })

  it('同一房间的多条证据使用不同人称时，按实际摘录消解名称', () => {
    const user = source('我走进你的房间。', { role: 'user' })
    const character = { ...source('欢迎来我的房间。', { role: 'character', characterId: 'char-snow' }), id: 'character' }
    const reply = JSON.parse(draft('你的房间', user.text))
    reply.draft.nodes[0].evidence.push({ sourceId: character.id, quote: character.text })
    const preview = parseSpatialAiReply(JSON.stringify(reply), 'initialize', fixture(), actors, [user, character], false).preview!
    expect(preview.world.nodes.find(node => node.kind === 'place')?.name).toBe('林雪的房间')
  })

  it('群聊称呼不明确时不能创建无归属的“你的房间”', () => {
    const core = fixture()
    core.world.actors.push({ id: 'far', kind: 'character', displayName: '阿远', externalRef: { type: 'qingyu-character', id: 'char-far' } })
    const quote = '去你的房间看看。'
    expect(() => parseSpatialAiReply(draft('你的房间', quote), 'initialize', core, { members: ['snow', 'far'], persona: 'traveler' }, [source(quote, { role: 'user' })], false)).toThrow('归属不明确')
  })

  it('剧情中的“你的房间”匹配林雪的房间，移动者仍可以是旅人', () => {
    const core = parseSpatialAiReply(draft('林雪的房间', '去你的房间看看。'), 'initialize', fixture(), actors, [source('去你的房间看看。', { role: 'user' })], false).preview!
    const node = core.world.nodes.find(node => node.kind === 'place')!
    const quote = '我走进了你的房间。'
    const result = parseSpatialDialogueReply(JSON.stringify({ schemaVersion: 1, changes: [{ actorId: 'traveler', boardId: node.boardId, targetNodeId: node.id,
      semanticPosition: { precision: 'inside-only', note: '' }, completed: true, confidence: 0.95, evidence: quote, evidenceSource: 'user' }], unresolved: [] }), core, actors, { user: quote, assistant: '' }, [node.id])
    expect(result.commands).toHaveLength(1)
    expect(result.commands[0]).toMatchObject({ actorId: 'traveler' })
    expect(reviewDialogueCandidates(core, result.candidates, {}, actors, { user: quote, assistant: '' }).commands).toHaveLength(1)
    expect(spatialDialogueMentionsPlace(node.name, core, actors, { user: quote, assistant: '' })).toBe(true)
  })

  it('新地点候选显示实际主人，创建后仍能通过原文核对移动', () => {
    const core = fixture(), quote = '我走进了你的房间。'
    const reply = JSON.stringify({ schemaVersion: 1, changes: [], unresolved: [{ actorId: 'traveler', targetText: '你的房间', completed: true, evidence: quote, evidenceSource: 'user', reason: '地图中尚无该房间' }] })
    const result = parseSpatialDialogueReply(reply, core, actors, { user: quote, assistant: '' }, [])
    expect(result.candidates[0]).toMatchObject({ targetText: '林雪的房间', evidence: quote, eligible: true })
    const created = parseSpatialAiReply(draft('林雪的房间', quote), 'initialize', core, actors, [source(quote, { role: 'user' })], false).preview!
    const node = created.world.nodes.find(node => node.kind === 'place')!
    expect(reviewDialogueCandidates(created, result.candidates, { [result.candidates[0]!.id]: node.id }, actors, { user: quote, assistant: '' }).commands).toHaveLength(1)
  })

  it('群聊结合明确称呼及发言者归属，不按移动者猜主人', () => {
    const core = fixture()
    core.world.actors.push({ id: 'far', kind: 'character', displayName: '阿远', externalRef: { type: 'qingyu-character', id: 'char-far' } })
    const group = { members: ['snow', 'far'], persona: 'traveler' }
    const quote = '林雪，我走进了你的房间。'
    const preview = parseSpatialAiReply(draft('你的房间', quote), 'initialize', core, group, [source(quote, { role: 'character', characterId: 'char-far' })], false).preview!
    const node = preview.world.nodes.find(node => node.kind === 'place')!
    expect(node.name).toBe('林雪的房间')
    const text = { user: '', assistant: `【阿远】\n${quote}\n\n【林雪】\n我在等你。` }
    const reply = JSON.stringify({ schemaVersion: 1, changes: [{ actorId: 'far', boardId: node.boardId, targetNodeId: node.id, semanticPosition: { precision: 'inside-only', note: '' }, completed: true, confidence: 0.95, evidence: quote, evidenceSource: 'assistant' }], unresolved: [] })
    expect(parseSpatialDialogueReply(reply, preview, group, text, [node.id]).commands[0]).toMatchObject({ actorId: 'far' })
    expect(spatialDialogueMentionsPlace(node.name, preview, group, text)).toBe(true)
  })

  it('群聊每个角色的“我的房间”分别归属于其自己', () => {
    const core = fixture()
    core.world.actors.push({ id: 'far', kind: 'character', displayName: '阿远', externalRef: { type: 'qingyu-character', id: 'char-far' } })
    const quote = '我回到了我的房间。', group = { members: ['snow', 'far'], persona: 'traveler' }
    for (const [characterId, expected] of [['char-snow', '林雪的房间'], ['char-far', '阿远的房间']]) {
      const preview = parseSpatialAiReply(draft('我的房间', quote), 'initialize', core, group, [source(quote, { role: 'character', characterId })], false).preview!
      expect(preview.world.nodes.find(node => node.kind === 'place')?.name).toBe(expected)
    }
  })

  it('未知用户身份和旁白不会被强行绑定为房间主人', () => {
    expect(() => parseSpatialAiReply(draft('我的房间', '我在我的房间。'), 'initialize', fixture(), { character: 'snow' }, [source('我在我的房间。', { role: 'user' })], false)).toThrow('归属不明确')
    expect(() => parseSpatialAiReply(draft('你的房间', '我在你的房间。'), 'initialize', fixture(), actors, [source('我在你的房间。', { role: 'narrator' })], false)).toThrow('归属不明确')
    expect(spatialDialogueMentionsPlace('林雪的房间', fixture(), actors, { user: '我在你的房间。', assistant: '', narrativeMode: 'omniscient' })).toBe(false)
  })

  it.each(['initialize', 'instruction', 'positions'] as const)('%s 提示明确人称归属规则', mode => {
    expect(spatialAiSystemPrompt(mode)).toContain('林雪的房间')
    expect(SPATIAL_DIALOGUE_PROMPT).toContain('移动人物不一定是地点主人')
  })
})

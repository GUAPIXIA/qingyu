/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AICompletion, ChatParams, GroupChat } from '../../../shared/types'
import type { SpatialSnapshot, SpatialEditorCommit } from '../../../shared/spatial'
import type { SpatialGroupScope } from '../../features/spatial/repository'
import type { SpatialCommand, SpatialCoreState } from '@qingyu/spatial-core'
const { root } = vi.hoisted(() => ({ root: `${process.env.TEMP}/qingyu-spatial-group-ai-${process.pid}` }))
vi.mock('electron', () => ({ app: { getPath: () => root, getVersion: () => 'test' }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() }, BrowserWindow: { getAllWindows: () => [] } }))
import { createSpatialGroupAiService } from '../../features/spatial/ai/groupChatService'
import { spatialRepository, spatialService } from '../../features/spatial/commitService'
import { spatialPaths, hashSpatialValue } from '../../features/spatial/repository'
import { spatialContextService } from '../../features/spatial/contextService'
import { DIRS, writeJson, readJson } from '../storage'
import { groupData, registerGroupIPC } from '../../ipc/group'
import { getDefaultSettings } from '../../../shared/defaults'
import { createBackupV2, restoreBackupV2 } from '../backup'
import { completeGroupSpatialCheckpoint, certifyGroupSpatialMessage } from '../../features/spatial/dialogue/groupCheckpoint'
import { saveCredential } from '../safeStorage'
import { registerSettingsIPC } from '../../ipc/settings'
const scope: SpatialGroupScope = { kind: 'group', groupId: 'group-a', sessionId: 'session-a' }
const complete = vi.fn<(params: ChatParams, signal: AbortSignal, timeout: number) => Promise<AICompletion>>()
let ai = createSpatialGroupAiService({ complete })
const view = (snapshot: SpatialSnapshot) => snapshot as SpatialSnapshot & SpatialCoreState
const result = (text: string): AICompletion => ({ text, finishReason: 'stop', usage: { promptTokens: 123, completionTokens: 234 } })
const baseReply = { schemaVersion: 1, explanation: '建议空间位置，等待确认', needsClarification: false, unresolved: [] }
function sceneReply(params: ChatParams) {
  const input = JSON.parse(params.messages[1].content), source = input.sources.find((source: { id: string }) => source.id === 'instruction')
  const evidence = [{ sourceId: source.id, quote: source.text }]
  return JSON.stringify({ ...baseReply, draft: { worldName: '青石城', description: '', boards: [], nodes: [
    { key: 'city', kind: 'region', name: '青石城', parentKey: null, evidence },
    { key: 'tea', kind: 'place', name: '茶馆', parentKey: 'city', evidence },
    { key: 'dock', kind: 'place', name: '渡口', parentKey: 'city', evidence },
  ], distances: [], placements: input.allowedActors.members.map((id: string) => ({ actor: id, nodeKey: 'tea', precision: 'inside-only', evidence })) } })
}
function moveReply(params: ChatParams) {
  const input = JSON.parse(params.messages[1].content)
  return JSON.stringify({ ...baseReply, operations: [{ type: 'move_actor', actorId: input.allowedActors.members[1], nodeId: input.currentMap.nodes.find((node: { name: string }) => node.name === '渡口').id, precision: 'inside-only' }] })
}
const askScene = () => ai.ask(scope, { requestId: randomUUID(), mode: 'initialize', text: '青石城里有茶馆和渡口，三位成员都在茶馆。' })
const initialize = async () => { const state = await askScene(); return ai.apply(scope, state.proposals[0].id) }
function request(snapshot: SpatialSnapshot, commands: SpatialCommand[]): SpatialEditorCommit { const v = snapshot.version; return { commitId: randomUUID(), ...v, expectedRuntimeRevision: v.runtimeRevision, expectedWorldFingerprint: v.worldFingerprint, commands } }
beforeEach(() => {
  rmSync(root, { recursive: true, force: true }); ai = createSpatialGroupAiService({ complete }); complete.mockReset()
  complete.mockImplementation(async params => result(sceneReply(params)))
  writeJson(join(DIRS.config(), 'settings.json'), { ...getDefaultSettings(), activeProfileId: 'profile-a', activeModel: 'gpt-4o-mini', defaultPersonaId: 'persona-a', connectionProfiles: [{ id: 'profile-a', name: '当前连接', provider: 'openai', model: 'outdated-model', baseUrl: 'https://test.invalid/v1', apiKey: 'test-only', maxContext: 32768 }] })
  writeJson(join(DIRS.config(), 'personas.json'), [{ id: 'persona-a', name: '旅人', description: '', persona: '' }, { id: 'persona-b', name: '观察者', description: '', persona: '' }])
  for (const [id, name] of [['a','林雪'],['b','阿远'],['c','小岚']]) writeJson(join(DIRS.characters(), `char-${id}.json`), { id: `char-${id}`, name, description: '旅者', scenario: `${name}有自己的住所`, firstMessage: '未选中的默认问候', groupOnlyGreetings: ['未选中的群聊开场'] })
  const groups: GroupChat[] = ['group-a','group-b'].map(id => ({ id, name: '夜谈', memberIds: ['char-a','char-b','char-c'], chatMode: 'polling', currentSpeakerIndex: 0, autoMode: false, maxRounds: 1, speakerInterval: 100, presetId: null, lorebookIds: [], systemPrompt: '本群所在城市是青石城', createdAt: 1, updatedAt: 1 }))
  writeJson(join(DIRS.groups(), 'index.json'), groups)
  for (const group of groups) writeJson(join(DIRS.groups(), group.id, 'sessions.json'), ['session-a','session-b'].map(id => ({ id, groupId: group.id, title: '会话', spatialBoardEnabled: true, messageCount: 0, createdAt: 1, updatedAt: 1, narrativeMode: 'immersive', personaId: 'persona-a' })))
})
afterEach(() => { ai.suspendRestore(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

describe('群聊画板阶段 1：独立助手与确认事务', () => {
  it('沿用有效模型和连接，三位成员初始化先预览，确认后原子写入并幂等', async () => {
    const state = await askScene(), proposal = state.proposals[0], params = complete.mock.calls[0][0]
    expect(params).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-only', baseUrl: 'https://test.invalid/v1', stream: false })
    expect(proposal.preview?.activeActorIds).toHaveLength(4)
    expect(await spatialService.loadGroupBound(scope.groupId, scope.sessionId)).toBeNull()
    const first = await ai.apply(scope, proposal.id), second = await ai.apply(scope, proposal.id)
    expect(view(first.snapshot).runtime.placements).toHaveLength(3)
    expect(first.state.proposals[0].status).toBe('applied'); expect(second.snapshot.version).toEqual(first.snapshot.version)
    expect(readdirSync(join(DIRS.spatial(), 'transactions'))).toEqual([])
    expect(groupData.readMessages(scope.groupId, scope.sessionId)).toEqual([])
  })
  it('初始化来源明确区分成员设定、公共设定与已保存正文，不读未选问候', async () => {
    await groupData.appendMessage(scope.groupId, scope.sessionId, { id: 'body', groupId: scope.groupId, characterId: 'char-b', content: '<think>隐藏推理</think>阿远在渡口。', images: [], timestamp: 1, round: 1 })
    await ai.ask(scope, { requestId: randomUUID(), mode: 'initialize', text: '在青石城创建茶馆和渡口。', memberIds: ['char-a'] })
    const body = JSON.parse(complete.mock.calls[0][0].messages[1].content)
    expect(body.sources.some((source: { id: string }) => source.id === 'character:char-a:scenario')).toBe(true)
    expect(body.sources.some((source: { id: string }) => source.id === 'character:char-b:scenario')).toBe(false)
    expect(body.sources.find((source: { id: string }) => source.id === 'message:body').speaker).toEqual({ role: 'character', characterId: 'char-b' })
    expect(body.sources.find((source: { id: string }) => source.id === 'instruction').speaker).toEqual({ role: 'user' })
    expect(body.sources.find((source: { id: string }) => source.id === 'character:char-a:scenario').subject).toEqual({ kind: 'character', id: 'char-a' })
    const material = JSON.stringify(body.sources)
    expect(material).toContain('阿远在渡口'); expect(material).toContain('本群所在城市')
    expect(material).not.toContain('未选中的'); expect(material).not.toContain('隐藏推理')
  })
  it('不同群聊与会话使用独立助手记录，不借首位成员单聊', async () => {
    const first = await ai.get(scope), second = await ai.get({ ...scope, sessionId: 'session-b' }), other = await ai.get({ ...scope, groupId: 'group-b' })
    expect(new Set([first.id, second.id, other.id]).size).toBe(3)
    expect(first.scope).toMatchObject({ kind: 'group', groupId: scope.groupId }); expect('characterId' in first.scope).toBe(false)
    expect(existsSync(DIRS.chats())).toBe(false)
  })
  it('手工修改初始化草稿不改变正式世界，确认采用修改后的草稿', async () => {
    const state = await askScene(), proposal = state.proposals[0], snapshot = view(proposal.preview!), tea = snapshot.world.nodes.find(node => node.name === '茶馆')!
    const edited = await ai.editDraft(scope, proposal.id, request(snapshot, [{ type: 'update_node', nodeId: tea.id, patch: { name: '茶室' } }]))
    expect(edited.ok).toBe(true); expect(await spatialService.loadGroupBound(scope.groupId, scope.sessionId)).toBeNull()
    const applied = await ai.apply(scope, proposal.id)
    expect(view(applied.snapshot).world.nodes.find(node => node.id === tea.id)?.name).toBe('茶室')
  })
  it('显式群聊指令仅提出当前允许成员移动，确认前位置保持', async () => {
    const initial = await initialize(); complete.mockImplementation(async params => result(moveReply(params)))
    const state = await ai.ask(scope, { requestId: randomUUID(), mode: 'instruction', text: '把阿远移到渡口' }), proposal = state.proposals.at(-1)!
    expect((await spatialService.loadGroupBound(scope.groupId, scope.sessionId))?.version).toEqual(initial.snapshot.version)
    const applied = view((await ai.apply(scope, proposal.id)).snapshot), actor = applied.world.actors.find(actor => actor.externalRef.id === 'char-b')!, dock = applied.world.nodes.find(node => node.name === '渡口')!
    expect(applied.runtime.placements.find(item => item.actorId === actor.id)?.anchor.nodeId).toBe(dock.id)
    expect(groupData.readMessages(scope.groupId, scope.sessionId)).toEqual([])
  })
  it.each(['persona','member','body'] as const)('来源变化（%s）使待确认提案失效', async kind => {
    const state = await askScene()
    if (kind === 'persona') await groupData.updateSession(scope.groupId, scope.sessionId, { personaId: 'persona-b' })
    if (kind === 'member') { const groups = groupData.listGroups(); groups[0].memberIds.pop(); writeJson(join(DIRS.groups(), 'index.json'), groups) }
    if (kind === 'body') await groupData.appendMessage(scope.groupId, scope.sessionId, { id: 'new-body', groupId: scope.groupId, characterId: 'char-a', content: '林雪到了城门', images: [], timestamp: 2, round: 1 })
    expect((await ai.get(scope)).proposals[0].status).toBe('stale')
    await expect(ai.apply(scope, state.proposals[0].id)).rejects.toThrow('已改变')
    expect(await spatialService.loadGroupBound(scope.groupId, scope.sessionId)).toBeNull()
  })
  it('旧版本显式指令不能覆盖手动调整后的正式位置', async () => {
    await initialize(); complete.mockImplementation(async params => result(moveReply(params)))
    const state = await ai.ask(scope, { requestId: randomUUID(), mode: 'instruction', text: '把阿远移到渡口' })
    const snapshot = view((await spatialService.loadGroupBound(scope.groupId, scope.sessionId))!)
    await spatialService.applyGroupEditorBatch(scope.groupId, scope.sessionId, request(snapshot, [{ type: 'update_world', patch: { description: '已手工调整' } }]))
    await expect(ai.apply(scope, state.proposals.at(-1)!.id)).rejects.toThrow('已更新')
  })
  it('多人起点建议只放置未知成员，已有位置不会重置', async () => {
    const initialized = view((await initialize()).snapshot), actor = initialized.world.actors.find(actor => actor.externalRef.id === 'char-c')!
    await spatialService.applyGroupEditorBatch(scope.groupId, scope.sessionId, request(initialized, [{ type: 'remove_actor_from_board', actorId: actor.id }]))
    complete.mockImplementation(async params => {
      const input = JSON.parse(params.messages[1].content), source = input.sources.find((source: { id: string }) => source.id === 'instruction')
      return result(JSON.stringify({...baseReply,operations:[{type:'move_actor',actorId:actor.id,nodeId:input.currentMap.nodes.find((node: { name: string })=>node.name==='茶馆').id,precision:'inside-only',evidence:[{sourceId:source.id,quote:source.text}]}]}))
    })
    const state = await ai.ask(scope, {requestId:randomUUID(),mode:'positions',text:'小岚现在在茶馆内，具体点位未知。'})
    expect(state.tasks.at(-1)?.state).toBe('completed')
    expect(view((await ai.apply(scope,state.proposals.at(-1)!.id)).snapshot).runtime.placements).toHaveLength(3)
    const repeated = await ai.ask(scope,{requestId:randomUUID(),mode:'positions',text:'小岚现在在茶馆内，具体点位未知。'})
    expect(repeated.tasks.at(-1)).toMatchObject({state:'failed',error:expect.stringContaining('已有位置')})
  })
  it('初始化请求进行中绑定其他世界，旧结果不能应用到新绑定', async () => {
    let finish!: (value: AICompletion) => void
    complete.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = askScene(); await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    const bound = await spatialService.createGroupAndBind(scope.groupId,scope.sessionId,'手工世界'), newest = await ai.get(scope)
    finish(result(sceneReply(complete.mock.calls[0][0]))); const old = await pending
    expect(newest.id).not.toBe(old.id); expect((await ai.get(scope)).proposals).toEqual([])
    expect((await spatialService.loadGroupBound(scope.groupId,scope.sessionId))?.version).toEqual(bound.version)
  })
  it('停止请求与成员变化均丢弃迟到结果', async () => {
    let finish!: (value: AICompletion) => void
    complete.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = askScene(); await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    const cancelled = await ai.cancel(scope); expect(cancelled.tasks[0].state).toBe('cancelled')
    finish(result(sceneReply(complete.mock.calls[0][0]))); expect((await pending).proposals).toEqual([])
    const second = askScene(); await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2))
    const groups = groupData.listGroups(); groups[0].memberIds.pop(); writeJson(join(DIRS.groups(), 'index.json'), groups)
    expect((await ai.get(scope)).tasks.at(-1)?.state).toBe('interrupted')
    finish(result(sceneReply(complete.mock.calls[1][0]))); expect((await second).proposals).toEqual([])
  })
  it('删除群聊时取消助手并清除本群记录，保留共享世界', async () => {
    const initial = await initialize(), other = await ai.get({ ...scope, groupId: 'group-b' })
    await ai.deleteScope(scope.groupId, scope.sessionId); await spatialService.deleteGroupScope(scope.groupId, scope.sessionId)
    expect(existsSync(spatialPaths.ai(initial.state.id))).toBe(false); expect(existsSync(spatialPaths.ai(other.id))).toBe(true)
    expect(existsSync(spatialPaths.world(initial.snapshot.version.worldId))).toBe(true)
    await expect(ai.get(scope)).rejects.toThrow('已删除')
  })
  it('待确认无绑定草稿及已确认画板都可完整备份恢复，恢复不重发模型', async () => {
    const state = await askScene(), draftBackup = join(root, 'draft.zip'); createBackupV2(draftBackup); restoreBackupV2(draftBackup)
    expect((await ai.get(scope)).proposals[0].preview).toEqual(state.proposals[0].preview)
    const applied = await ai.apply(scope, state.proposals[0].id), saved = join(root, 'saved.zip'); createBackupV2(saved); restoreBackupV2(saved)
    expect((await ai.get(scope)).scope).toEqual(applied.state.scope); expect(complete).toHaveBeenCalledTimes(1)
    expect((await spatialService.loadGroupBound(scope.groupId, scope.sessionId))?.version).toEqual(applied.snapshot.version)
  })
  it('助手 ID 不能跨群聊关联，备份校验拒绝错配', async () => {
    const first = await ai.get(scope); await ai.get({ ...scope, groupId: 'group-b' })
    const sessions = groupData.readSessions('group-b'); sessions[0].spatialAiSessionId = first.id; writeJson(join(DIRS.groups(), 'group-b', 'sessions.json'), sessions)
    await expect(ai.get({ ...scope, groupId: 'group-b' })).rejects.toThrow('其他群聊')
    const backup = join(root, 'invalid.zip'); createBackupV2(backup); expect(() => restoreBackupV2(backup)).toThrow('其他群聊')
  })
  it('四文件事务中断后恢复群聊确认记录与绑定', async () => {
    const state = await askScene(), persist = spatialRepository.persist.bind(spatialRepository)
    const spy = vi.spyOn(spatialRepository, 'persist').mockImplementation(async (...args) => {
      const [owner, worldId, id, values, binding, aiSessionId] = args
      const files = Object.entries(values).map(([kind, after]) => { const path = kind === 'world' ? spatialPaths.world(worldId) : kind === 'runtime' ? spatialPaths.runtime(owner) : kind === 'state' ? spatialPaths.state(owner) : spatialPaths.ai(aiSessionId!); const before = readJson(path); return { kind, beforeHash: before === null ? null : hashSpatialValue(before), afterHash: hashSpatialValue(after), after } })
      writeJson(spatialPaths.transaction(id), { schemaVersion: 1, id, scope: owner, worldId, aiSessionId, binding, files }); throw new Error('模拟中断')
    })
    await expect(ai.apply(scope, state.proposals[0].id)).rejects.toThrow('模拟中断'); spy.mockImplementation(persist)
    await spatialService.recoverTransactions(); expect((await ai.get(scope)).proposals[0].status).toBe('applied')
    expect(view((await spatialService.loadGroupBound(scope.groupId, scope.sessionId))!).runtime.placements).toHaveLength(3)
  })
})

describe('群聊只读空间：参与范围与叙事视角', () => {
  it.each(['polling','mention','free'] as const)('三种发言模式 %s 均读取当前位置且不注入助手历史或画布坐标', async mode => {
    await initialize(); const groups = groupData.listGroups(); groups[0].chatMode = mode; writeJson(join(DIRS.groups(), 'index.json'), groups)
    const context = await spatialContextService.readGroup(scope, mode === 'free' ? undefined : 'char-a')
    expect(context?.text).toContain('茶馆'); expect(context?.text).toContain('处于同一地点')
    expect(context?.text).not.toContain('operations'); expect(context?.text).not.toContain('等待确认'); expect(context?.text).not.toContain('"x"')
  })
  it('沉浸点名隐藏异地位置，全知保留公开位置；不因异地禁止发言', async () => {
    await initialize(); complete.mockImplementation(async params => result(moveReply(params)))
    const state = await ai.ask(scope, { requestId: randomUUID(), mode: 'instruction', text: '把阿远移到渡口' }); await ai.apply(scope, state.proposals.at(-1)!.id)
    const immersive = await spatialContextService.readGroup(scope,'char-a'); expect(immersive?.text).not.toContain('渡口'); expect(immersive?.characterOffstage).toBe(false)
    await groupData.updateSession(scope.groupId, scope.sessionId, { narrativeMode: 'omniscient' })
    const omniscient = await spatialContextService.readGroup(scope,'char-a'); expect(omniscient?.text).toContain('渡口'); expect(omniscient?.offstageCharacterIds).toEqual([])
  })
  it('未知、明确不参与和退出群聊是不同状态', async () => {
    const snapshot = view((await initialize()).snapshot), actor = snapshot.world.actors.find(actor => actor.externalRef.id === 'char-b')!, offstage = snapshot.world.nodes.find(node => node.tags.includes('system:offstage'))!
    await spatialService.applyGroupEditorBatch(scope.groupId, scope.sessionId, request(snapshot, [{ type: 'remove_actor_from_board', actorId: actor.id }]))
    expect((await spatialContextService.readGroup(scope,'char-b'))).toMatchObject({ characterOffstage: false, offstageCharacterIds: [] })
    const current = (await spatialService.loadGroupBound(scope.groupId, scope.sessionId))!
    await spatialService.applyGroupEditorBatch(scope.groupId, scope.sessionId, request(current, [{ type: 'place_actor', actorId: actor.id, placement: { boardId: offstage.boardId, anchor: { kind: 'node', nodeId: offstage.id }, semanticPosition: { precision: 'inside-only' } } }]))
    expect((await spatialContextService.readGroup(scope,'char-b'))).toMatchObject({ characterOffstage: true, offstageCharacterIds: ['char-b'] })
    const groups = groupData.listGroups(); groups[0].memberIds = groups[0].memberIds.filter(id => id !== 'char-b'); writeJson(join(DIRS.groups(), 'index.json'), groups)
    expect((await spatialContextService.readGroup(scope))?.text).not.toContain('阿远')
    await expect(spatialContextService.readGroup(scope,'char-b')).rejects.toThrow('不属于群聊')
  })
  it('关闭位置读取返回空，null 身份不读取用户位置，默认身份可解析', async () => {
    await initialize(); await groupData.updateSession(scope.groupId, scope.sessionId, { personaId: null })
    expect((await spatialContextService.readGroup(scope))?.text).toContain('未选择身份')
    await groupData.updateSession(scope.groupId, scope.sessionId, { spatialContextEnabled: false })
    expect(await spatialContextService.readGroup(scope)).toBeNull()
  })
})


describe('群聊画板阶段 2：已保存剧情批次', () => {
  it('群聊启用只影响当前会话，重新开启复用原地图', async () => {
    const other = { ...scope, sessionId: 'session-b' }
    await groupData.updateSession(scope.groupId, scope.sessionId, { spatialBoardEnabled: false })
    await groupData.updateSession(other.groupId, other.sessionId, { spatialBoardEnabled: false })
    expect(await spatialContextService.readGroup(scope)).toBeNull()
    await expect(askScene()).rejects.toThrow('空间画布已关闭')
    const snapshot = await spatialService.setEnabled(scope, true)
    expect(view(snapshot!).world.name).toBe('会话画板')
    expect(await spatialContextService.readGroup(scope)).not.toBeNull()
    expect(await spatialContextService.readGroup(other)).toBeNull()
    expect(groupData.readSessions(scope.groupId).find(session => session.id === other.sessionId)?.spatialWorldId).toBeUndefined()
    const second = await spatialService.setEnabled(other, true)
    expect(second!.version.worldId).not.toBe(snapshot!.version.worldId)
    await spatialService.setEnabled(scope, false)
    await ai.disable(scope)
    expect(await spatialContextService.readGroup(other)).not.toBeNull()
    expect((await spatialService.setEnabled(scope, true))!.version).toEqual(snapshot!.version)
  })
  it('会话停用群聊画布，保留地图且旧批次在重开后不补提取', async () => {
    const snapshot = await setup()
    await capture(snapshot)
    save('body-a', 'generation-a')
    await spatialService.setEnabled(scope, false)
    await ai.disable(scope)
    expect(await spatialContextService.readGroup(scope, 'char-a')).toBeNull()
    expect(await capture(snapshot, 'burst-disabled', 'generation-disabled')).toBeNull()
    await expect(askScene()).rejects.toThrow('空间画布已关闭')
    await spatialService.setEnabled(scope, true)
    await ai.dialogue.register(scope, 'generation-a', ['body-a'])
    await ai.dialogue.close(scope, 'burst-a'); await ai.dialogue.drain(scope)
    expect(complete).not.toHaveBeenCalled()
    expect((await spatialService.loadGroupBound(scope.groupId, scope.sessionId))?.version).toEqual(snapshot.version)
    expect((await spatialContextService.readGroup(scope, 'char-a'))?.version).toEqual(snapshot.version)
    expect(groupData.readMessages(scope.groupId, scope.sessionId).some(item => item.id === 'body-a')).toBe(true)
    expect(await capture(snapshot, 'burst-new', 'generation-new')).toBeTruthy()
  })
  async function setup(mode: GroupChat['chatMode'] = 'mention') {
    const initialized = await initialize()
    const groups = groupData.listGroups(); groups[0].chatMode = mode; writeJson(join(DIRS.groups(),'index.json'),groups)
    await groupData.updateSession(scope.groupId,scope.sessionId,{spatialNarrativeSyncPolicy:'suggest'})
    groupData.appendMessage(scope.groupId,scope.sessionId,{id:'user',groupId:scope.groupId,characterId:'__user__',content:'继续行程。',images:[],timestamp:1,round:1})
    complete.mockClear(); complete.mockImplementation(async () => result(JSON.stringify({schemaVersion:1,changes:[],unresolved:[]})))
    return initialized.snapshot
  }
  async function capture(snapshot: SpatialSnapshot, burstId = 'burst-a', generationId = 'generation-a', targetCharacterId?: string) {
    return ai.dialogue.capture(scope,{burstId,generationId,kind:'normal',expectedVersion:snapshot.version,targetCharacterId})
  }
  function save(id: string, generationId: string, characterId = 'char-b', content = '阿远已经到达渡口。', completed = true) {
    completeGroupSpatialCheckpoint(generationId,completed)
    const message = certifyGroupSpatialMessage(scope.groupId,scope.sessionId,{id,groupId:scope.groupId,characterId,content,images:[],timestamp:Date.now(),round:2,narrativeMode:'immersive',spatialGroupGenerationId:generationId,spatialGroupComplete:true})
    groupData.appendMessage(scope.groupId,scope.sessionId,message)
    return message
  }
  function dialogueReply(params: ChatParams) {
    const data = JSON.parse(params.messages[1].content), node = data.targets.find((item: {name:string})=>item.name==='渡口')
    return JSON.stringify({schemaVersion:1,changes:[{actorId:data.allowedActors.find((item: {name:string})=>item.name==='阿远').id,boardId:node.boardId,targetNodeId:node.id,semanticPosition:{precision:'inside-only',note:''},completed:true,confidence:0.95,evidence:'阿远已经到达渡口。',evidenceSource:'assistant'}],unresolved:[]})
  }
  async function closeAndDrain() { await ai.dialogue.close(scope,'burst-a'); await ai.dialogue.drain(scope) }
  it.each(['mention','free','polling'] as const)('%s 批次只在关闭后提取一次，保持待确认；确认与重复投递去重', async mode => {
    const snapshot = await setup(mode); await capture(snapshot)
    save('body-a','generation-a'); await ai.dialogue.register(scope,'generation-a',['body-a'])
    expect(complete).not.toHaveBeenCalled()
    if (mode !== 'mention') { await capture(snapshot,'burst-a','generation-b'); save('body-b','generation-b','char-a','林雪仍在茶馆。'); await ai.dialogue.register(scope,'generation-b',['body-b']) }
    complete.mockImplementation(async params=>result(dialogueReply(params)))
    await closeAndDrain(); await ai.dialogue.close(scope,'burst-a'); await ai.dialogue.register(scope,'generation-a',['body-a']); await ai.dialogue.drain(scope)
    expect(complete).toHaveBeenCalledTimes(1)
    const state = await ai.get(scope), proposal = state.proposals.find(item=>item.mode==='dialogue_sync')!
    expect(proposal.status).toBe('pending'); expect((await spatialService.loadGroupBound(scope.groupId,scope.sessionId))?.version).toEqual(snapshot.version)
    const body = JSON.parse(complete.mock.calls[0][0].messages[1].content)
    expect(body.assistant).toContain('阿远已经到达渡口。'); expect(body.allowedActors).toHaveLength(4)
    if(mode!=='mention')expect(body.assistant.indexOf('阿远已经到达渡口。')).toBeLessThan(body.assistant.indexOf('林雪仍在茶馆。'))
    const applied = await ai.apply(scope,proposal.id), again = await ai.apply(scope,proposal.id)
    expect(applied.snapshot.version.runtimeRevision).toBe(snapshot.version.runtimeRevision+1); expect(again.snapshot.version).toEqual(applied.snapshot.version)
    expect(groupData.readMessages(scope.groupId,scope.sessionId)).toHaveLength(mode==='mention'?2:3)
  })
  it('自由发言的拆分列表必须完整、有序且属于同一次生成', async () => {
    const snapshot = await setup('free'); await capture(snapshot)
    save('body-a','generation-a'); save('body-b','generation-a','char-a','林雪仍在茶馆。')
    await ai.dialogue.register(scope,'generation-a',['body-a'])
    await closeAndDrain(); expect(complete).not.toHaveBeenCalled()
    expect((await ai.get(scope)).groupDialogueBatches![0].generations[0].state).toBe('ignored')
  })
  it('主进程未完整结束时不能伪造完成标志，半截正文不进入批次', async () => {
    const snapshot = await setup(); await capture(snapshot)
    const partial = save('body-a','generation-a','char-b','阿远已经到达渡口。',false)
    expect(partial.spatialGroupComplete).toBe(false)
    await ai.dialogue.register(scope,'generation-a',['body-a']); await closeAndDrain(); expect(complete).not.toHaveBeenCalled()
  })
  it('关闭同步默认不捕获，读取关闭也不捕获；不允许群聊自动策略', async () => {
    const snapshot = await setup(); await groupData.updateSession(scope.groupId,scope.sessionId,{spatialNarrativeSyncPolicy:'off'})
    expect(await capture(snapshot)).toBeNull()
    await groupData.updateSession(scope.groupId,scope.sessionId,{spatialNarrativeSyncPolicy:'suggest',spatialContextEnabled:false})
    expect(await capture(snapshot)).toBeNull()
    await expect(groupData.updateSession(scope.groupId,scope.sessionId,{spatialNarrativeSyncPolicy:'auto'})).rejects.toThrow('仅支持')
  })
  it('停止接力只处理此前完整成功的回复，遗漏通知通过磁盘检查点恢复', async () => {
    const snapshot = await setup('polling'); await capture(snapshot)
    save('body-a','generation-a')
    await capture(snapshot,'burst-a','generation-b'); save('body-b','generation-b','char-a','林雪走到一半',false)
    await closeAndDrain()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(JSON.parse(complete.mock.calls[0][0].messages[1].content).assistant).toContain('阿远已经到达渡口。')
    expect(JSON.parse(complete.mock.calls[0][0].messages[1].content).assistant).not.toContain('走到一半')
  })
  it.each(['edit','delete','member','persona','mode','connection','off'] as const)('提取期间 %s 变化拒绝迟到结果，正文与位置保持', async kind => {
    const snapshot = await setup(); await capture(snapshot); save('body-a','generation-a'); await ai.dialogue.register(scope,'generation-a',['body-a'])
    let resolve!: (value:AICompletion)=>void
    complete.mockImplementation(params=>new Promise(done=>{resolve=()=>done(result(dialogueReply(params)))}))
    await ai.dialogue.close(scope,'burst-a'); const running = ai.dialogue.drain(scope)
    await vi.waitFor(()=>expect(complete).toHaveBeenCalledTimes(1))
    if(kind==='edit'){ const body = groupData.readMessages(scope.groupId,scope.sessionId).find(item=>item.id==='body-a')!; groupData.updateMessage(scope.groupId,scope.sessionId,{...body,content:'改为计划前往渡口。'}) }
    if(kind==='delete')groupData.deleteMessage(scope.groupId,scope.sessionId,'body-a')
    if(kind==='member'){ const groups=groupData.listGroups();groups[0].memberIds=['char-a','char-c'];writeJson(join(DIRS.groups(),'index.json'),groups) }
    if(kind==='persona')await groupData.updateSession(scope.groupId,scope.sessionId,{personaId:null})
    if(kind==='mode')await groupData.updateSession(scope.groupId,scope.sessionId,{narrativeMode:'omniscient'})
    if(kind==='off')await groupData.updateSession(scope.groupId,scope.sessionId,{spatialNarrativeSyncPolicy:'off'})
    if(kind==='connection'){const path=join(DIRS.config(),'settings.json');const settings=readJson<Record<string,unknown>>(path)!;writeJson(path,{...settings,activeModel:'other-model'})}
    await ai.get(scope); resolve(result('')); await running
    expect((await ai.get(scope)).proposals.filter(item=>item.mode==='dialogue_sync'&&item.status==='pending')).toEqual([])
    expect((await spatialService.loadGroupBound(scope.groupId,scope.sessionId))?.version.runtimeRevision).toEqual(snapshot.version.runtimeRevision)
  })
  it('手动拖动导致版本冲突，旧提取结果和重试不能覆盖新位置', async () => {
    const snapshot=await setup();await capture(snapshot);save('body-a','generation-a');await ai.dialogue.register(scope,'generation-a',['body-a'])
    const actor=view(snapshot).world.actors.find(item=>item.externalRef.id==='char-a')!,dock=view(snapshot).world.nodes.find(item=>item.name==='渡口')!,old=view(snapshot).runtime.placements.find(item=>item.actorId===actor.id)!
    await spatialService.applyGroupEditorBatch(scope.groupId,scope.sessionId,request(snapshot,[{type:'move_actor',actorId:actor.id,from:{revision:old.revision},to:{boardId:dock.boardId,anchor:{kind:'node',nodeId:dock.id},semanticPosition:{precision:'inside-only'}}}]))
    await closeAndDrain();expect(complete).not.toHaveBeenCalled();const task=(await ai.get(scope)).tasks.find(item=>item.mode==='dialogue_sync')!
    expect(task.state).toBe('failed');await expect(ai.dialogue.retry(scope,task.id)).rejects.toThrow('版本已改变')
  })
  it('失败不自动重发；显式重试生成一次建议并阻止重复重试', async () => {
    const snapshot=await setup();await capture(snapshot);save('body-a','generation-a');await ai.dialogue.register(scope,'generation-a',['body-a'])
    complete.mockImplementation(async()=>result('{bad-json'));await closeAndDrain();const task=(await ai.get(scope)).tasks.find(item=>item.mode==='dialogue_sync')!
    expect(task.state).toBe('failed');complete.mockImplementation(async params=>result(dialogueReply(params)))
    await ai.dialogue.retry(scope,task.id);await ai.dialogue.drain(scope);expect(complete).toHaveBeenCalledTimes(2)
    await expect(ai.dialogue.retry(scope,task.id)).rejects.toThrow('已有结果')
  })
  it('完整批次超预算时不截掉行动，不调用模型', async () => {
    const snapshot=await setup();await capture(snapshot);save('body-a','generation-a','char-b','很长的旅途描述。\n'.repeat(6000)+'阿远已经到达渡口。');await ai.dialogue.register(scope,'generation-a',['body-a'])
    await closeAndDrain();expect(complete).not.toHaveBeenCalled();expect((await ai.get(scope)).tasks.at(-1)?.error).toContain('完整批次超出')
  })
  it('重启只补已签入检查点和未发出队列，运行中未知结果不重发', async () => {
    const snapshot=await setup('polling');await capture(snapshot);save('body-a','generation-a')
    ai.suspendRestore();ai=createSpatialGroupAiService({complete});await ai.dialogue.recover();await ai.dialogue.drain(scope);expect(complete).toHaveBeenCalledTimes(1)
    const state=await ai.get(scope);state.tasks.at(-1)!.state='running';writeJson(spatialPaths.ai(state.id),state)
    ai.suspendRestore();ai=createSpatialGroupAiService({complete});await ai.dialogue.recover();await ai.dialogue.drain(scope)
    expect(complete).toHaveBeenCalledTimes(1);expect((await ai.get(scope)).tasks.at(-1)!.state).toBe('interrupted')
  })
  it('待确认剧情批次可备份恢复，不额外调用模型', async () => {
    saveCredential('profile-profile-a','test-only')
    const snapshot=await setup();await capture(snapshot);save('body-a','generation-a');await ai.dialogue.register(scope,'generation-a',['body-a']);complete.mockImplementation(async params=>result(dialogueReply(params)));await closeAndDrain()
    const path=join(root,'group-stage2.zip');await createBackupV2(path);await restoreBackupV2(path);ai.suspendRestore();ai=createSpatialGroupAiService({complete});await ai.dialogue.recover();await ai.dialogue.drain(scope)
    expect(complete).toHaveBeenCalledTimes(1);expect((await ai.get(scope)).proposals.find(item=>item.mode==='dialogue_sync')?.status).toBe('pending')
  })
  it('主动画板指令优先于在途剧情提取，迟到提取不能保存提案', async () => {
    const snapshot=await setup();await capture(snapshot);save('body-a','generation-a');await ai.dialogue.register(scope,'generation-a',['body-a'])
    let resolve!:()=>void
    complete.mockImplementation(params=>JSON.parse(params.messages[1].content).mode==='dialogue_sync'?new Promise(done=>{resolve=()=>done(result(dialogueReply(params)))}):Promise.resolve(result(moveReply(params))))
    await ai.dialogue.close(scope,'burst-a');const running=ai.dialogue.drain(scope);await vi.waitFor(()=>expect(complete).toHaveBeenCalledTimes(1))
    const direct=await ai.ask(scope,{requestId:randomUUID(),mode:'instruction',text:'把阿远移动到渡口。'})
    expect(direct.tasks.filter(item=>item.mode==='dialogue_sync')[0].state).toBe('cancelled');expect(direct.tasks.at(-1)?.state).toBe('completed')
    resolve();await running;expect((await ai.get(scope)).proposals.filter(item=>item.mode==='dialogue_sync')).toEqual([])
  })
  it('取消后的迟到结果不写建议，已经保存的正文保留', async () => {
    const snapshot=await setup();await capture(snapshot);save('body-a','generation-a');await ai.dialogue.register(scope,'generation-a',['body-a'])
    let resolve!:()=>void;complete.mockImplementation(params=>new Promise(done=>{resolve=()=>done(result(dialogueReply(params)))}))
    await ai.dialogue.close(scope,'burst-a');const running=ai.dialogue.drain(scope);await vi.waitFor(()=>expect(complete).toHaveBeenCalledTimes(1))
    await ai.cancel(scope);resolve();await running;expect((await ai.get(scope)).tasks.at(-1)?.state).toBe('cancelled');expect(groupData.readMessages(scope.groupId,scope.sessionId)).toHaveLength(2)
  })
  it('较新完整批次使旧待确认建议失效，同一人物不会被旧结果覆盖', async () => {
    const snapshot=await setup();await capture(snapshot);save('body-a','generation-a');await ai.dialogue.register(scope,'generation-a',['body-a']);complete.mockImplementation(async params=>result(dialogueReply(params)));await closeAndDrain()
    const original=(await ai.get(scope)).proposals.find(item=>item.mode==='dialogue_sync')!
    await capture(snapshot,'burst-b','generation-b');save('body-b','generation-b','char-a','林雪仍在茶馆。');await ai.dialogue.register(scope,'generation-b',['body-b'])
    expect((await ai.get(scope)).proposals.find(item=>item.id===original.id)?.status).toBe('stale');await expect(ai.apply(scope,original.id)).rejects.toThrow('取代')
  })

  it('适配器忽略取消也立即结束旧队列，后续批次可继续提取', async () => {
    const snapshot=await setup();await capture(snapshot);save('body-a','generation-a');await ai.dialogue.register(scope,'generation-a',['body-a'])
    complete.mockImplementation(()=>new Promise(()=>{}));await ai.dialogue.close(scope,'burst-a');const running=ai.dialogue.drain(scope);await vi.waitFor(()=>expect(complete).toHaveBeenCalledTimes(1))
    await ai.cancel(scope);await running
    complete.mockImplementation(async()=>result(JSON.stringify({schemaVersion:1,changes:[],unresolved:[]})))
    await capture(snapshot,'burst-b','generation-b');save('body-b','generation-b');await ai.dialogue.register(scope,'generation-b',['body-b']);await ai.dialogue.close(scope,'burst-b');await ai.dialogue.drain(scope)
    expect(complete).toHaveBeenCalledTimes(2);expect((await ai.get(scope)).tasks.at(-1)?.state).toBe('completed')
  })

})


describe('群聊画板阶段 3：核对、撤销与生命周期', () => {
  async function story(mode: GroupChat['chatMode']='mention', narrativeMode:'immersive'|'omniscient'='immersive', unknown=false, completed=true) {
    const snapshot=(await initialize()).snapshot
    const group=groupData.listGroups()[0];await groupData.saveGroup({...group,chatMode:mode})
    await groupData.updateSession(scope.groupId,scope.sessionId,{spatialNarrativeSyncPolicy:'suggest',narrativeMode})
    await groupData.appendMessage(scope.groupId,scope.sessionId,{id:'user',groupId:scope.groupId,characterId:'__user__',content:'继续行程。',images:[],timestamp:1,round:1})
    await ai.dialogue.capture(scope,{generationId:'gen',burstId:'batch',kind:'normal',expectedVersion:snapshot.version})
    completeGroupSpatialCheckpoint('gen',true)
    const body=unknown ? completed ? '阿远已经到达旧桥。' : '阿远打算前往旧桥。' : '阿远已经到达渡口。林雪已经到达渡口。'
    await groupData.appendMessage(scope.groupId,scope.sessionId,certifyGroupSpatialMessage(scope.groupId,scope.sessionId,{id:'body',groupId:scope.groupId,characterId:'char-b',content:body,images:[],timestamp:2,round:2,narrativeMode,spatialGroupGenerationId:'gen'}))
    await ai.dialogue.register(scope,'gen',['body']);complete.mockClear()
    complete.mockImplementation(async params=>{
      const data=JSON.parse(params.messages[1].content),dock=data.targets.find((item:{name:string})=>item.name==='渡口')
      const members=data.allowedActors.filter((actor:{name:string})=>['阿远','林雪'].includes(actor.name))
      return result(JSON.stringify({schemaVersion:1,changes:unknown?[]:members.map((actor:{id:string;name:string})=>({actorId:actor.id,boardId:dock.boardId,targetNodeId:dock.id,semanticPosition:{precision:'inside-only',note:''},completed:true,confidence:0.95,evidence:`${actor.name}已经到达渡口。`,evidenceSource:'assistant'})),unresolved:unknown?[{actorId:data.allowedActors.find((actor:{name:string})=>actor.name==='阿远').id,targetText:'旧桥',completed,evidence:body,evidenceSource:'assistant',reason:'地图未登记'}]:[]}))
    })
    await ai.dialogue.close(scope,'batch');await ai.dialogue.drain(scope)
    const state=await ai.get(scope),proposal=state.proposals.find(item=>item.mode==='dialogue_sync')!
    return {snapshot,proposal,state}
  }
  const current=async()=>view((await spatialService.loadGroupBound(scope.groupId,scope.sessionId))!)
  it('有序多人正文在一批内保留最终各自地点，提取返回顺序不交换人物',async()=>{
    const initial=view((await initialize()).snapshot),city=initial.world.nodes.find(node=>node.name==='青石城')!
    const added=await spatialService.applyGroupEditorBatch(scope.groupId,scope.sessionId,request(initial,['厨房','客厅'].map((name,i)=>({type:'create_node' as const,payload:{id:'room-'+i,boardId:city.boardId,parentNodeId:city.id,childBoardId:null,kind:'place' as const,name,description:'',tags:[],geometry:{x:400+i*200,y:400},iconKey:'pin',createdAt:1,updatedAt:1}}))))
    if(!added.ok)throw Error(added.message)
    await groupData.updateSession(scope.groupId,scope.sessionId,{spatialNarrativeSyncPolicy:'suggest',narrativeMode:'omniscient'})
    await groupData.appendMessage(scope.groupId,scope.sessionId,{id:'user',groupId:scope.groupId,characterId:'__user__',content:'继续。',images:[],timestamp:1,round:1})
    for(const [index,characterId,content] of [[0,'char-a','林雪已经进入厨房。'],[1,'char-b','阿远已经进入客厅。林雪已经到达渡口。']] as const){
      const id='ordered-'+index
      await ai.dialogue.capture(scope,{generationId:id,burstId:'ordered',kind:'normal',expectedVersion:added.snapshot.version,targetCharacterId:characterId})
      completeGroupSpatialCheckpoint(id,true)
      await groupData.appendMessage(scope.groupId,scope.sessionId,certifyGroupSpatialMessage(scope.groupId,scope.sessionId,{id,groupId:scope.groupId,characterId,content,images:[],timestamp:index+2,round:index+2,narrativeMode:'omniscient',spatialGroupGenerationId:id}))
      await ai.dialogue.register(scope,id,[id])
    }
    complete.mockClear();complete.mockImplementation(async params=>{
      const input=JSON.parse(params.messages[1].content)
      expect(input.assistant.indexOf('进入厨房')).toBeLessThan(input.assistant.indexOf('进入客厅'))
      return result(JSON.stringify({schemaVersion:1,changes:[['阿远','客厅','阿远已经进入客厅。'],['林雪','渡口','林雪已经到达渡口。']].map(([name,target,evidence])=>{const node=input.targets.find((item:{name:string})=>item.name===target);return {actorId:input.allowedActors.find((item:{name:string})=>item.name===name).id,boardId:node.boardId,targetNodeId:node.id,semanticPosition:{precision:'inside-only',note:''},completed:true,confidence:0.95,evidence,evidenceSource:'assistant'}}),unresolved:[]}))
    })
    await ai.dialogue.close(scope,'ordered');await ai.dialogue.drain(scope)
    const pending=(await ai.get(scope)).proposals.at(-1)!,applied=view((await ai.apply(scope,pending.id)).snapshot)
    for(const [externalId,target] of [['char-a','渡口'],['char-b','客厅'],['char-c','茶馆']]){const actor=applied.world.actors.find(item=>item.externalRef.id===externalId)!;expect(applied.world.nodes.find(node=>node.id===applied.runtime.placements.find(item=>item.actorId===actor.id)?.anchor.nodeId)?.name).toBe(target)}
    expect(complete).toHaveBeenCalledOnce()
  })
  async function rename(snapshot:SpatialSnapshot) {
    const node=view(snapshot).world.nodes.find(item=>item.name==='茶馆')!
    const response=await spatialService.applyGroupEditorBatch(scope.groupId,scope.sessionId,request(snapshot,[{type:'update_node',nodeId:node.id,patch:{name:'茶室'}}]))
    if(!response.ok)throw Error(response.message)
    return response.snapshot
  }
  it.each(['mention','polling','free'].flatMap(mode=>['immersive','omniscient'].map(narrative=>[mode,narrative] as const)))('%s / %s：多人确认及撤销幂等，只读位置回到原处', async(mode,narrative)=>{
    const {snapshot,proposal}=await story(mode as GroupChat['chatMode'],narrative as 'immersive'|'omniscient')
    const applied=await ai.apply(scope,proposal.id,true)
    expect(view(applied.snapshot).runtime.placements.filter(item=>view(applied.snapshot).world.nodes.find(node=>node.id===item.anchor.nodeId)?.name==='渡口')).toHaveLength(2)
    const undone=await ai.undo(scope,proposal.id),again=await ai.undo(scope,proposal.id)
    expect(again.snapshot.version).toEqual(undone.snapshot.version)
    expect(view(undone.snapshot).runtime.placements.map(item=>item.anchor.nodeId)).toEqual(view(snapshot).runtime.placements.map(item=>item.anchor.nodeId))
    expect((await spatialContextService.readGroup(scope,'char-b'))?.text).toContain('茶馆')
    await expect(ai.apply(scope,proposal.id,true)).rejects.toThrow()
    expect(complete).toHaveBeenCalledTimes(1)
  })
  it('位置版本变化可重新核对，但不会自动采用旧位置或调用模型', async()=>{
    const {snapshot,proposal}=await story();const changed=await rename(snapshot)
    expect((await ai.get(scope)).proposals.find(item=>item.id===proposal.id)).toMatchObject({status:'stale',canReview:true})
    await expect(ai.apply(scope,proposal.id,true)).rejects.toThrow('重新核对')
    const reviewed=await ai.review(scope,proposal.id,{targets:{}}),replacement=reviewed.proposals.at(-1)!
    expect(replacement).toMatchObject({status:'pending',reviewedFromId:proposal.id,baseVersion:changed.version})
    expect((await current()).version).toEqual(changed.version);expect(complete).toHaveBeenCalledTimes(1)
    const applied=await ai.apply(scope,replacement.id,true);expect(applied.state.proposals.at(-1)?.status).toBe('applied')
    await expect(ai.review(scope,proposal.id,{targets:{}})).rejects.toThrow()
  })
  it('未知地点单独预览和确认创建，原人物保持；再选择新地点核对移动', async()=>{
    const {snapshot,proposal}=await story('mention','immersive',true)
    const city=view(snapshot).world.nodes.find(item=>item.name==='青石城')!
    const prepared=await ai.preparePlace(scope,proposal.id,'旧桥',city.id),place=prepared.proposals.at(-1)!
    expect(place.placeForId).toBe(proposal.id);expect((await current()).world.nodes.some(item=>item.name==='旧桥')).toBe(false)
    const created=await ai.apply(scope,place.id),core=view(created.snapshot)
    expect(core.runtime.placements.map(item=>item.anchor.nodeId)).toEqual(view(snapshot).runtime.placements.map(item=>item.anchor.nodeId))
    const node=core.world.nodes.find(item=>item.name==='旧桥')!
    expect(await ai.targets(scope)).toContainEqual(expect.objectContaining({id:node.id,path:'青石城 / 旧桥'}))
    const reviewed=await ai.review(scope,proposal.id,{targets:{[proposal.dialogueCandidates![0].id]:node.id}})
    const applied=await ai.apply(scope,reviewed.proposals.at(-1)!.id,true)
    expect(view(applied.snapshot).runtime.placements.find(item=>item.actorId===proposal.dialogueCandidates![0].actorId)?.anchor.nodeId).toBe(node.id)
    await expect(ai.undo(scope,place.id)).rejects.toThrow('不是当前群聊')
    expect(complete).toHaveBeenCalledTimes(1)
  })
  it('旧目标已删除时可单独创建新地点，再明确选择该路径核对',async()=>{
    const {snapshot,proposal}=await story(),dock=view(snapshot).world.nodes.find(node=>node.name==='渡口')!
    const removed=await spatialService.applyGroupEditorBatch(scope.groupId,scope.sessionId,request(snapshot,[{type:'delete_node',nodeId:dock.id,strategy:'reject-if-not-empty'}]))
    if(!removed.ok)throw Error(removed.message)
    const pending=await ai.preparePlace(scope,proposal.id,'渡口',null),created=view((await ai.apply(scope,pending.proposals.at(-1)!.id)).snapshot)
    const newDock=created.world.nodes.find(node=>node.name==='渡口')!
    expect(newDock.id).not.toBe(dock.id)
    const reviewed=await ai.review(scope,proposal.id,{targets:Object.fromEntries(proposal.dialogueCandidates!.map(candidate=>[candidate.id,newDock.id]))})
    const applied=view((await ai.apply(scope,reviewed.proposals.at(-1)!.id)).snapshot)
    expect(applied.runtime.placements.filter(item=>item.anchor.nodeId===newDock.id)).toHaveLength(2)
    expect(complete).toHaveBeenCalledOnce()
  })
  it('未完成动作不能通过地点选择或创建变成移动', async()=>{
    const {snapshot,proposal}=await story('mention','immersive',true,false)
    const dock=view(snapshot).world.nodes.find(item=>item.name==='渡口')!
    await expect(ai.review(scope,proposal.id,{targets:{[proposal.dialogueCandidates![0].id]:dock.id}})).rejects.toThrow('非完成动作')
    await expect(ai.preparePlace(scope,proposal.id,'旧桥',null)).rejects.toThrow('没有需要')
    expect((await current()).version).toEqual(snapshot.version)
  })
  it.each(['body','delete','member','persona','mode','connection','policy','reading'] as const)('已可核对建议遇到 %s 变化后永久失效',async kind=>{
    const {snapshot,proposal}=await story();await rename(snapshot)
    expect((await ai.get(scope)).proposals.find(item=>item.id===proposal.id)?.canReview).toBe(true)
    if(kind==='body')await groupData.updateMessage(scope.groupId,scope.sessionId,{...groupData.readMessages(scope.groupId,scope.sessionId).find(item=>item.id==='body')!,content:'改写正文'})
    if(kind==='delete')await groupData.deleteMessage(scope.groupId,scope.sessionId,'body')
    if(kind==='member'){const group=groupData.listGroups()[0];await groupData.saveGroup({...group,memberIds:['char-a','char-c']});await groupData.saveGroup(group)}
    if(kind==='persona'){await groupData.updateSession(scope.groupId,scope.sessionId,{personaId:'persona-b'});await groupData.updateSession(scope.groupId,scope.sessionId,{personaId:'persona-a'})}
    if(kind==='mode'){const group=groupData.listGroups()[0];await groupData.saveGroup({...group,chatMode:'free'});await groupData.saveGroup(group)}
    if(kind==='connection'){const path=join(DIRS.config(),'settings.json'),settings=readJson<Record<string,unknown>>(path)!;writeJson(path,{...settings,activeModel:'other-model'})}
    if(kind==='policy'){await groupData.updateSession(scope.groupId,scope.sessionId,{spatialNarrativeSyncPolicy:'off'});await groupData.updateSession(scope.groupId,scope.sessionId,{spatialNarrativeSyncPolicy:'suggest'})}
    if(kind==='reading'){await groupData.updateSession(scope.groupId,scope.sessionId,{spatialContextEnabled:false});await groupData.updateSession(scope.groupId,scope.sessionId,{spatialContextEnabled:true})}
    expect((await ai.get(scope)).proposals.find(item=>item.id===proposal.id)).toMatchObject({status:'stale',canReview:false})
    await expect(ai.review(scope,proposal.id,{targets:{}})).rejects.toThrow()
  })
  it('已应用来源改写提示变化而不逆向移动；版本未变时可明确撤销', async()=>{
    const {proposal}=await story();const applied=await ai.apply(scope,proposal.id,true)
    await groupData.updateMessage(scope.groupId,scope.sessionId,{...groupData.readMessages(scope.groupId,scope.sessionId).find(item=>item.id==='body')!,content:'阿远改变了行程'})
    expect((await ai.get(scope)).proposals.find(item=>item.id===proposal.id)).toMatchObject({status:'applied',sourceChanged:true})
    expect((await current()).version).toEqual(applied.snapshot.version)
    expect((await ai.undo(scope,proposal.id)).state.proposals.find(item=>item.id===proposal.id)?.status).toBe('undone')
  })
  it('应用后有手动编辑时撤销拒绝覆盖；其他群聊不能撤销该提交', async()=>{
    const {proposal}=await story();const applied=await ai.apply(scope,proposal.id,true);const changed=await rename(applied.snapshot)
    await expect(ai.undo(scope,proposal.id)).rejects.toThrow('已有其他修改')
    await expect(ai.undo({...scope,groupId:'group-b'},proposal.id)).rejects.toThrow('不是当前群聊')
    expect((await current()).version).toEqual(changed.version)
  })
  it('地点创建来源改写后不能确认，原空间不增加节点',async()=>{
    const {snapshot,proposal}=await story('mention','immersive',true)
    const prepared=await ai.preparePlace(scope,proposal.id,'旧桥',null),place=prepared.proposals.at(-1)!
    await groupData.updateMessage(scope.groupId,scope.sessionId,{...groupData.readMessages(scope.groupId,scope.sessionId).find(item=>item.id==='body')!,content:'尚未出发'})
    await expect(ai.apply(scope,place.id)).rejects.toThrow('来源')
    expect((await current()).version).toEqual(snapshot.version)
  })
  it('地点重名、错误上级及伪造候选选择均拒绝',async()=>{
    const {snapshot,proposal}=await story('mention','immersive',true),core=view(snapshot),city=core.world.nodes.find(item=>item.name==='青石城')!,tea=core.world.nodes.find(item=>item.name==='茶馆')!
    await expect(ai.preparePlace(scope,proposal.id,'茶馆',city.id)).rejects.toThrow('同名')
    await expect(ai.preparePlace(scope,proposal.id,'旧桥',tea.id)).rejects.toThrow('上级')
    await expect(ai.review(scope,proposal.id,{targets:{unknown:tea.id}})).rejects.toThrow('不属于')
  })
  it.each(['model','credential'] as const)('实际 settings IPC 的 %s 切回原值不能复活建议；主题修改不失效',async kind=>{
    const {proposal}=await story(), handlers=new Map<string,(...args:unknown[])=>Promise<unknown>>()
    registerSettingsIPC({handle:(channel:string,handler:(...args:unknown[])=>Promise<unknown>)=>handlers.set(channel,handler)} as never,{} as never)
    const settingsPath=join(DIRS.config(),'settings.json'), before=readJson<import('../../../shared/types').Settings>(settingsPath)!
    await handlers.get('settings:save')!({},structuredClone({...before,theme:'dark'}))
    expect(readJson<import('../../../shared/types').Settings>(settingsPath)?.spatialSourceEpoch).toBeUndefined()
    expect((await ai.get(scope)).proposals.find(item=>item.id===proposal.id)?.status).toBe('pending')
    if(kind==='model'){
      await handlers.get('settings:save')!({},structuredClone({...before,activeModel:'another-model'}))
      await handlers.get('settings:save')!({},structuredClone(before))
    }else{
      await handlers.get('settings:saveCredential')!({},'profile-profile-a','another-key')
      await handlers.get('settings:saveCredential')!({},'profile-profile-a','test-only')
    }
    expect(readJson<import('../../../shared/types').Settings>(settingsPath)?.spatialSourceEpoch).toBeTruthy()
    expect((await ai.get(scope)).proposals.find(item=>item.id===proposal.id)).toMatchObject({status:'stale',canReview:false})
    await expect(ai.review(scope,proposal.id,{targets:{}})).rejects.toThrow()
  })
  it('地点创建提案跨 ZIP 保持独立确认；伪造其他来源在写盘前拒绝',async()=>{
    const {snapshot,proposal}=await story('mention','immersive',true), prepared=await ai.preparePlace(scope,proposal.id,'旧桥',null)
    const path=join(root,'place.zip');createBackupV2(path);restoreBackupV2(path)
    expect((await ai.get(scope)).proposals.at(-1)?.placeForId).toBe(proposal.id)
    const bad=structuredClone(prepared);bad.proposals.at(-1)!.placeForId='other-group-proposal'
    writeJson(spatialPaths.ai(bad.id),bad);const invalid=join(root,'invalid-place.zip');createBackupV2(invalid)
    writeJson(spatialPaths.ai(prepared.id),prepared)
    expect(()=>restoreBackupV2(invalid)).toThrow('地点创建来源')
    expect((await ai.get(scope)).proposals.at(-1)?.placeForId).toBe(proposal.id)
    expect((await current()).version).toEqual(snapshot.version)
  })
  it('翻译只写冻结的正文附属字段，保留完成检查点；改写、删除或错归属均拒绝',async()=>{
    const {proposal}=await story(), handlers=new Map<string,(...args:unknown[])=>Promise<unknown>>()
    registerGroupIPC({handle:(channel:string,handler:(...args:unknown[])=>Promise<unknown>)=>handlers.set(channel,handler)} as never)
    const body=groupData.readMessages(scope.groupId,scope.sessionId).find(item=>item.id==='body')!, expected={characterId:body.characterId,content:body.content}
    const save=(groupId:string,sessionId:string,source=expected)=>handlers.get('group:saveTranslation')!({},groupId,sessionId,'body',source,'译文')
    expect(await save(scope.groupId,scope.sessionId)).toBe(true)
    const translated=groupData.readMessages(scope.groupId,scope.sessionId).find(item=>item.id==='body')!
    expect(translated).toMatchObject({...body,translation:'译文',spatialGroupComplete:true})
    expect((await ai.get(scope)).proposals.find(item=>item.id===proposal.id)?.status).toBe('pending')
    expect(await save('group-b',scope.sessionId)).toBe(false)
    expect(await save(scope.groupId,'session-b')).toBe(false)
    expect(await save(scope.groupId,scope.sessionId,{...expected,characterId:'char-c'})).toBe(false)
    groupData.updateMessage(scope.groupId,scope.sessionId,{...translated,content:'已改写'})
    expect(await save(scope.groupId,scope.sessionId)).toBe(false)
    await groupData.deleteMessage(scope.groupId,scope.sessionId,'body')
    expect(await save(scope.groupId,scope.sessionId)).toBe(false)
    expect(groupData.readMessages(scope.groupId,scope.sessionId).some(item=>item.id==='body')).toBe(false)
  })
  it('已核对未确认、已应用与撤销收据跨重启和 ZIP 恢复保留，不重发',async()=>{
    saveCredential('profile-profile-a','test-only')
    const {snapshot,proposal}=await story();await rename(snapshot)
    const reviewed=await ai.review(scope,proposal.id,{targets:{}}),id=reviewed.proposals.at(-1)!.id
    const pendingZip=join(root,'review.zip');createBackupV2(pendingZip);ai.suspendRestore();restoreBackupV2(pendingZip);ai=createSpatialGroupAiService({complete});await ai.dialogue.recover();await ai.dialogue.drain(scope)
    expect((await ai.get(scope)).proposals.find(item=>item.id===id)?.status).toBe('pending')
    await ai.apply(scope,id,true)
    const zip=join(root,'applied.zip');createBackupV2(zip);ai.suspendRestore();restoreBackupV2(zip);ai=createSpatialGroupAiService({complete});await ai.dialogue.recover()
    const undone=await ai.undo(scope,id),again=await ai.undo(scope,id);expect(again.snapshot.version).toEqual(undone.snapshot.version)
    expect(complete).toHaveBeenCalledTimes(1)
  })
})

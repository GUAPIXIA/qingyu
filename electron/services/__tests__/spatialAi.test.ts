/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
const { testRoot } = vi.hoisted(() => ({ testRoot: `${process.env.TEMP}/qingyu-spatial-ai-test-${process.pid}` }))
vi.mock('electron', () => ({ app: { getPath: () => testRoot, getVersion: () => '0.0.0-test' }, safeStorage: { isEncryptionAvailable: () => false }, BrowserWindow: { getAllWindows: () => [] } }))
import { createSpatialAiService } from '../../features/spatial/ai/singleChatService'
import { spatialService, spatialRepository, sessionFor } from '../../features/spatial/commitService'
import { spatialPaths } from '../../features/spatial/repository'
import { projectSpatialContext, spatialContextService } from '../../features/spatial/contextService'
import { parseSpatialAiReply } from '../../features/spatial/ai/protocol'
import { parseSpatialDialogueReply } from '../../features/spatial/dialogue/protocol'
import { createBackupV2, restoreBackupV2 } from '../backup'
import { chatData } from '../../features/chat/chatData'
import * as storage from '../storage'
import { getDefaultSettings } from '../../../shared/defaults'
import type { AICompletion, ChatParams, Settings } from '../../../shared/types'
import type { SpatialSnapshot, SpatialEditorCommit } from '../../../shared/spatial'
import { applyCommandBatch, createEmptyRuntime, type SpatialCoreState, type SpatialCommand } from '@qingyu/spatial-core'

const scope = { characterId: 'char-a', sessionId: 'session-a' }
const view = (value: SpatialSnapshot) => value as SpatialSnapshot & SpatialCoreState
const instruction = (text: string) => ({ requestId: randomUUID(), mode: 'instruction' as const, text })
function request(snapshot: SpatialSnapshot, commands: SpatialCommand[]): SpatialEditorCommit {
  return { commitId: randomUUID(), worldId: snapshot.version.worldId, runtimeId: snapshot.version.runtimeId, bindingEpoch: snapshot.version.bindingEpoch,
    expectedRuntimeRevision: snapshot.version.runtimeRevision, expectedWorldFingerprint: snapshot.version.worldFingerprint, commands }
}
const scene = '青石城里有一间茶馆。林雪正坐在茶馆中。'
const evidence = [{ sourceId: 'character:scenario', quote: scene }]
const reply = () => JSON.stringify({ schemaVersion: 1, explanation: '根据场景提议青石城和茶馆；用户位置未明确。', needsClarification: false, unresolved: [],
  draft: { worldName: '青石城', description: '', boards: [], nodes: [
    { key: 'city', kind: 'region', name: '青石城', description: '', parentKey: null, boardKey: 'root', evidence },
    { key: 'tea', kind: 'place', name: '茶馆', description: '', parentKey: 'city', boardKey: 'root', evidence },
  ], distances: [], placements: [{ actor: 'character', nodeKey: 'tea', precision: 'inside-only', note: '', evidence }] } })
const completion = (text: string): AICompletion => ({ text, finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 200 } })
const complete = vi.fn<(params: ChatParams, signal: AbortSignal, timeout: number) => Promise<AICompletion>>()
let ai = createSpatialAiService({ complete })
let settings: Settings

beforeEach(async () => {
  ai = createSpatialAiService({ complete }); complete.mockReset(); complete.mockResolvedValue(completion(reply()))
  for (const path of ['characters','config','chats/char-a']) mkdirSync(join(testRoot, 'data', path), { recursive: true })
  settings = { ...getDefaultSettings(), activeProfileId: 'test-profile', activeModel: 'gpt-4o-mini', connectionProfiles: [{ id: 'test-profile', name: '测试连接', provider: 'openai', apiKey: 'test-only', baseUrl: 'http://test.invalid/v1', model: 'old-model', maxContext: 32768, useInstructTemplate: false }] }
  storage.writeJson(join(storage.DIRS.config(), 'settings.json'), settings)
  storage.writeJson(join(storage.DIRS.config(), 'personas.json'), [{ id: 'persona-a', name: '旅人', description: '一个旅人', persona: '' }])
  storage.writeJson(join(storage.DIRS.characters(), 'char-a.json'), { id: 'char-a', name: '林雪', description: '旅者', scenario: scene, alternateGreetings: ['未选中的雪山开场'] })
  storage.writeJson(join(storage.DIRS.chats(), 'char-a', 'sessions.json'), [
    { id: 'session-a', characterId: 'char-a', title: '单聊', spatialBoardEnabled: true, personaId: 'persona-a', narrativeMode: 'immersive', messageCount: 1, createdAt: Date.now(), updatedAt: Date.now() },
    { id: 'session-b', characterId: 'char-a', title: '另一个单聊', spatialBoardEnabled: true, personaId: null, messageCount: 0, createdAt: Date.now(), updatedAt: Date.now() },
  ])
  await chatData.clearChat(scope.characterId,scope.sessionId)
  writeFileSync(join(storage.DIRS.chats(), 'char-a', 'session-a.jsonl'), JSON.stringify({ id: 'opening', sessionId: 'session-a', characterId: 'char-a', role: 'assistant', content: '<think>隐藏思考</think>林雪在茶馆喝茶。', timestamp: Date.now() }) + '\n')
})
afterEach(() => { ai.dialogue.cancelScope(scope); vi.restoreAllMocks(); rmSync(testRoot, { recursive: true, force: true }) })
const initialize = () => ai.ask(scope, { requestId: randomUUID(), mode: 'initialize', text: '' })

let narrativeClock = 0
function persistBody(id: string, role: 'user' | 'assistant', content: string, generationId?: string) {
  const old = chatData.readMessages(scope.characterId,scope.sessionId,true).find(message => message.id === id)
  chatData.saveMessage(scope.characterId, { ...scope, id, role, content, images: [], isEditing: false, timestamp: old?.timestamp ?? Date.now() + ++narrativeClock, spatialGenerationId: generationId })
}
function movement(snapshot: SpatialSnapshot, extras: Record<string, unknown> = {}) {
  const core = view(snapshot), actor = core.world.actors.find(actor => actor.externalRef.type === 'qingyu-character')!, node = core.world.nodes.find(node => node.name === '青石城')!
  return { actorId: actor.id, boardId: node.boardId, targetNodeId: node.id, semanticPosition: { precision: 'inside-only', note: '' }, completed: true, confidence: 0.95,
    evidence: '林雪走到青石城', evidenceSource: 'assistant', ...extras }
}
const narrativeReply = (snapshot: SpatialSnapshot, extras: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, changes: [movement(snapshot, extras)], unresolved: [] })
async function captureTurn(kind: 'normal' | 'regenerate' | 'continue' = 'normal', userText = '继续', body = '林雪走到青石城') {
  const id = randomUUID(), messageId = randomUUID()
  persistBody(randomUUID(), 'user', userText)
  expect(await ai.dialogue.capture(scope, { generationId: id, kind })).toBe(id)
  persistBody(messageId, 'assistant', body, id)
  return { id, messageId }
}

describe('空间阶段 2：已保存剧情的独立提取', () => {
  it('会话缺省关闭，开启自动建图，开关和位置读取互相隔离', async () => {
    const sessionsPath = join(storage.DIRS.chats(), scope.characterId, 'sessions.json')
    const sessions = storage.readJson<import('../../../shared/types').ChatSession[]>(sessionsPath)!
    for (const session of sessions) delete session.spatialBoardEnabled
    storage.writeJson(sessionsPath, sessions)
    const other = { ...scope, sessionId: 'session-b' }
    expect(getDefaultSettings().spatialBoardEnabled).toBe(false)
    expect(await spatialContextService.read(scope)).toBeNull()
    await expect(initialize()).rejects.toThrow('空间画布已关闭')
    const [first, repeated] = await Promise.all([spatialService.setEnabled(scope, true), spatialService.setEnabled(scope, true)])
    expect(view(first!).world.name).toBe('会话画板')
    expect(repeated!.version).toEqual(first!.version)
    expect(await spatialContextService.read(scope)).not.toBeNull()
    expect(await spatialContextService.read(other)).toBeNull()
    const second = await spatialService.setEnabled(other, true)
    expect(second!.version.worldId).not.toBe(first!.version.worldId)
    await spatialService.setEnabled(scope, false)
    expect(await spatialContextService.read(scope)).toBeNull()
    expect(await spatialContextService.read(other)).not.toBeNull()
    expect((await spatialService.setEnabled(scope, true))!.version).toEqual(first!.version)
  })
  it('会话关闭取消在途任务、阻止位置读取与新请求，重开不应用迟到建议', async () => {
    const snapshot = await initialized()
    let resolve!: (value: AICompletion) => void
    complete.mockClear(); complete.mockImplementation(() => new Promise(done => { resolve = done }))
    const turn = await captureTurn(); await ai.dialogue.register(scope, turn.id, turn.messageId)
    const running = ai.dialogue.drain(scope)
    await vi.waitFor(() => expect(resolve).toBeDefined())
    await spatialService.setEnabled(scope, false)
    await ai.disable(scope)
    expect(complete.mock.calls.at(-1)![1].aborted).toBe(true)
    expect(await spatialContextService.read(scope)).toBeNull()
    expect(await ai.dialogue.capture(scope, { generationId: randomUUID(), kind: 'normal' })).toBeNull()
    await expect(ai.ask(scope, instruction('读取位置'))).rejects.toThrow('空间画布已关闭')
    await spatialService.setEnabled(scope, true)
    resolve(completion(narrativeReply(snapshot))); await running
    expect((await ai.get(scope)).tasks.at(-1)?.state).toBe('cancelled')
    expect((await ai.get(scope)).proposals.filter(item => item.mode === 'dialogue_sync')).toHaveLength(0)
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(snapshot.version)
    expect((await spatialContextService.read(scope))?.version).toEqual(snapshot.version)
    expect(chatData.readMessages(scope.characterId, scope.sessionId, true).at(-1)?.content).toBe('林雪走到青石城')
    expect(await ai.dialogue.capture(scope, { generationId: randomUUID(), kind: 'normal' })).toBeTruthy()
  })
  it('V2 编排器与真实消息端口完整接入，正文成功后仅调用一次画板模型', async () => {
    const snapshot = await initialized(); complete.mockClear(); complete.mockResolvedValue(completion(narrativeReply(snapshot)))
    const { ChatOrchestrator } = await import('../../chat/orchestrator')
    const { chatMessagePort } = await import('../../chat/messagePort')
    const { contextService } = await import('../../chat/contextService')
    const orch = new ChatOrchestrator({messagePort:chatMessagePort,contextPort:contextService,modelPort:{stream:async()=>({text:'林雪走到青石城',finishReason:'stop'})},
      spatialScheduler:{prepare:ai.dialogue.capture,saved:ai.dialogue.register}})
    const task = await orch.handle({type:'send',requestId:randomUUID(),...scope,content:'继续',client:{kind:'desktop',clientId:'pc',protocolVersion:2}})
    expect(task.state).toBe('completed'); await ai.dialogue.drain(scope)
    expect(complete).toHaveBeenCalledTimes(1)
    expect((await ai.get(scope)).tasks.at(-1)?.state).toBe('completed')
    expect(chatData.readMessages(scope.characterId,scope.sessionId,true).at(-1)).toMatchObject({content:'林雪走到青石城',spatialGenerationId:task.taskId})
    expect((await ai.get(scope)).proposals.at(-1)).toMatchObject({mode:'dialogue_sync',status:'pending'})
  })
  it('无移动是成功结果；截断提取结果为失败且不自动调用', async () => {
    const snapshot = await initialized(); complete.mockClear(); complete.mockResolvedValue(completion(JSON.stringify({schemaVersion:1,changes:[],unresolved:[]})))
    const turn = await captureTurn(); await ai.dialogue.register(scope,turn.id,turn.messageId); await ai.dialogue.drain(scope)
    expect((await ai.get(scope)).tasks.at(-1)?.state).toBe('completed')
    expect((await ai.get(scope)).proposals.filter(proposal => proposal.mode === 'dialogue_sync')).toHaveLength(0)
    const next = await captureTurn(); complete.mockResolvedValue({...completion(narrativeReply(snapshot)),finishReason:'length'})
    await ai.dialogue.register(scope,next.id,next.messageId); await ai.dialogue.drain(scope)
    expect((await ai.get(scope)).tasks.at(-1)?.state).toBe('failed'); expect(complete).toHaveBeenCalledTimes(2)
  })
  it('主动指令优先于尚未开始的剧情提取；各自只调用一次', async () => {
    const snapshot = await initialized(); complete.mockClear()
    complete.mockImplementation(async params => params.observability?.taskType === 'spatial_dialogue_sync' ? completion(narrativeReply(snapshot)) : completion(JSON.stringify({schemaVersion:1,explanation:'当前林雪在茶馆',needsClarification:false,operations:[]})))
    const turn = await captureTurn(); await ai.dialogue.register(scope,turn.id,turn.messageId)
    await ai.ask(scope,instruction('读取当前位置')); await ai.dialogue.drain(scope)
    expect(complete.mock.calls.map(call => call[0].observability?.taskType)).toEqual(['spatial_instruction','spatial_dialogue_sync'])
  })
  it('关闭同步取消在途剧情请求；已保存正文不改变且不能保存迟到建议', async () => {
    const snapshot = await initialized(); let resolve!: (value: AICompletion) => void
    complete.mockImplementation(() => new Promise(done => {resolve = done}))
    const turn = await captureTurn(); await ai.dialogue.register(scope,turn.id,turn.messageId)
    const running = ai.dialogue.drain(scope); await vi.waitFor(() => expect(resolve).toBeDefined())
    await chatData.updateSession(scope.characterId,scope.sessionId,{spatialNarrativeSyncPolicy:'off'}); await ai.get(scope)
    expect(complete.mock.calls.at(-1)![1].aborted).toBe(true)
    resolve(completion(narrativeReply(snapshot))); await running
    expect((await ai.get(scope)).tasks.at(-1)?.state).toBe('cancelled')
    expect((await ai.get(scope)).proposals.filter(item => item.mode === 'dialogue_sync')).toHaveLength(0)
    expect(chatData.readMessages(scope.characterId,scope.sessionId,true).at(-1)?.content).toBe('林雪走到青石城')
  })
  it('已应用来源改写只标记来源变化，不回退之后的位置', async () => {
    const snapshot = await initialized(); complete.mockResolvedValue(completion(narrativeReply(snapshot)))
    const turn = await captureTurn(); await ai.dialogue.register(scope,turn.id,turn.messageId); await ai.dialogue.drain(scope)
    const proposal = (await ai.get(scope)).proposals.at(-1)!, applied = await ai.apply(scope,proposal.id)
    persistBody(turn.messageId,'assistant','林雪留在茶馆。',turn.id)
    expect((await ai.get(scope)).proposals.at(-1)).toMatchObject({status:'applied',sourceChanged:true})
    expect((await spatialService.loadBound(scope.characterId,scope.sessionId))?.version).toEqual(applied.snapshot.version)
  })
  it('完整正文超预算时提取失败，不能静默裁掉末尾移动', async () => {
    await initialized(); complete.mockClear()
    settings.connectionProfiles[0]!.maxContext = 2048; storage.writeJson(join(storage.DIRS.config(),'settings.json'),settings)
    const turn = await captureTurn('normal','继续','很长的剧情。'.repeat(3000)+'林雪走到青石城')
    await ai.dialogue.register(scope,turn.id,turn.messageId); await ai.dialogue.drain(scope)
    expect((await ai.get(scope)).tasks.at(-1)).toMatchObject({state:'failed',error:expect.stringContaining('完整正文超出')})
    expect(complete).not.toHaveBeenCalled()
  })
  it('同名地点不能凭模型 ID 猜测；证据提供唯一完整路径才采用', async () => {
    const snapshot = await initialized(), core = view(snapshot), city = core.world.nodes.find(node => node.name === '青石城')!
    const tea = core.world.nodes.find(node => node.name === '茶馆')!
    const duplicated = {...core,world:{...core.world,nodes:[...core.world.nodes,{...tea,id:'other-tea',parentNodeId:null}]}}
    const actor = movement(snapshot).actorId, candidate = {...movement(snapshot),targetNodeId:tea.id,evidence:'林雪进入茶馆'}
    const parse = (evidence: string) => parseSpatialDialogueReply(JSON.stringify({schemaVersion:1,changes:[{...candidate,evidence}],unresolved:[]}),duplicated,{character:actor},{user:'',assistant:evidence},[tea.id,'other-tea',city.id])
    expect(parse('林雪进入茶馆').commands).toHaveLength(0)
    // 现有起点已经在该茶馆，唯一指明路径后仍过滤为无操作。
    expect(parse('林雪进入青石城里的茶馆').unresolved).toHaveLength(0)
  })
  it('只在保存后调用独立模型；待确认、原子提交、重复投递与应用去重', async () => {
    const snapshot = await initialized(); complete.mockClear(); complete.mockResolvedValue(completion(narrativeReply(snapshot)))
    const turn = await captureTurn()
    expect(complete).not.toHaveBeenCalled()
    const mainBefore = chatData.readMessages(scope.characterId, scope.sessionId)
    await ai.dialogue.register(scope, turn.id, turn.messageId); await ai.dialogue.register(scope, turn.id, turn.messageId)
    await ai.dialogue.drain(scope)
    expect(complete).toHaveBeenCalledTimes(1)
    const [params,,timeout] = complete.mock.calls[0]!
    expect(params.observability?.taskType).toBe('spatial_dialogue_sync'); expect(params.maxTokens).toBeLessThanOrEqual(1024); expect(timeout).toBe(30000)
    expect(params.model).toBe(settings.activeModel); expect(JSON.stringify(params.messages)).not.toContain('隐藏思考')
    const state = await ai.get(scope), proposal = state.proposals.at(-1)!
    expect(proposal.mode).toBe('dialogue_sync'); expect(proposal.status).toBe('pending')
    expect((await spatialService.loadBound('char-a','session-a'))?.version).toEqual(snapshot.version)
    const applied = await ai.apply(scope, proposal.id)
    expect(view(applied.snapshot).runtime.placements[0]!.anchor.nodeId).toBe(movement(snapshot).targetNodeId)
    expect(view(applied.snapshot).runtime.events.at(-1)?.source).toBe('story')
    expect((await ai.apply(scope, proposal.id)).snapshot.version).toEqual(applied.snapshot.version)
    expect(chatData.readMessages(scope.characterId,scope.sessionId)).toEqual(mainBefore)
  })
  it('来源没有成功保存检查点时不调用；关闭同步不捕获，但主动指令仍可用', async () => {
    const snapshot = await initialized(); complete.mockClear()
    const id = randomUUID(); await ai.dialogue.capture(scope,{generationId:id,kind:'normal'})
    persistBody('incomplete','assistant','林雪走到青石城')
    await ai.dialogue.register(scope,id,'incomplete'); await ai.dialogue.drain(scope)
    expect(complete).not.toHaveBeenCalled()
    await chatData.updateSession('char-a','session-a',{spatialNarrativeSyncPolicy:'off'})
    expect(await ai.dialogue.capture(scope,{generationId:randomUUID(),kind:'normal'})).toBeNull()
    complete.mockResolvedValue(completion(JSON.stringify({schemaVersion:1,explanation:'当前位置已读取',needsClarification:false,operations:[]})))
    expect((await ai.ask(scope,instruction('查看位置'))).tasks.at(-1)?.state).toBe('completed')
    expect((await spatialService.loadBound('char-a','session-a'))?.version).toEqual(snapshot.version)
  })
  it.each([
    ['缺少完成状态',{completed:undefined},'完成状态'], ['缺少置信度',{confidence:undefined},'置信度'],
    ['伪造正文证据',{evidence:'根本不存在'},'证据'], ['未知人物',{actorId:'outsider'},'当前单聊'],
    ['未知地点',{targetNodeId:'unknown'},'允许清单'], ['像素位置',{semanticPosition:{precision:'inside-only',note:'',x:100}},'结构'],
    ['无依据细节',{semanticPosition:{precision:'inside-only',note:'门边'}},'原文依据'],
  ])('严格拒绝 %s', async (_label, extras, message) => {
    const snapshot = await initialized(), actor = movement(snapshot).actorId
    expect(() => parseSpatialDialogueReply(narrativeReply(snapshot,extras),view(snapshot),{character:actor},{user:'继续',assistant:'林雪走到青石城'},[movement(snapshot).targetNodeId])).toThrow(message)
  })
  it('计划与 AI 代替用户行动仅保存诊断；不能用确认将未完成动作提交', async () => {
    const snapshot = await initialized(), core = view(snapshot), persona = core.world.actors.find(actor => actor.externalRef.type === 'qingyu-persona')!
    const reply = JSON.stringify({schemaVersion:1,changes:[movement(snapshot,{evidence:'林雪准备走到青石城'}),movement(snapshot,{actorId:persona.id,evidence:'旅人走到青石城'})],unresolved:[]})
    complete.mockResolvedValue(completion(reply))
    const turn = await captureTurn('normal','继续','林雪准备走到青石城；旅人走到青石城')
    await ai.dialogue.register(scope,turn.id,turn.messageId); await ai.dialogue.drain(scope)
    const proposal = (await ai.get(scope)).proposals.at(-1)!
    expect(proposal.commands).toHaveLength(0); expect(proposal.unresolved).toHaveLength(2)
    await expect(ai.apply(scope,proposal.id,true)).rejects.toThrow('不能应用')
    expect((await spatialService.loadBound('char-a','session-a'))?.version).toEqual(snapshot.version)
  })
  it('用户已完成位置声明可提出 persona 移动；目标与当前语义位置一致时无重复事件', async () => {
    const snapshot = await initialized(), persona = view(snapshot).world.actors.find(actor => actor.externalRef.type === 'qingyu-persona')!
    complete.mockResolvedValue(completion(narrativeReply(snapshot,{actorId:persona.id,evidence:'我现在在青石城',evidenceSource:'user'})))
    const turn = await captureTurn('normal','我现在在青石城','林雪向旅人问好。')
    await ai.dialogue.register(scope,turn.id,turn.messageId); await ai.dialogue.drain(scope)
    const proposal = (await ai.get(scope)).proposals.at(-1)!
    const next = await ai.apply(scope,proposal.id)
    const same = parseSpatialDialogueReply(narrativeReply(next.snapshot,{actorId:persona.id,evidence:'我现在在青石城',evidenceSource:'user'}),view(next.snapshot),{character:movement(snapshot).actorId,persona:persona.id},{user:'我现在在青石城',assistant:''},[movement(snapshot).targetNodeId])
    expect(same.commands).toHaveLength(0)
  })
  it.each(['edit','swipe','delete','user','persona','mode','off'])('确认前来源变化 %s 会失效，不能移动', async kind => {
    const snapshot = await initialized(); complete.mockResolvedValue(completion(narrativeReply(snapshot)))
    const turn = await captureTurn(); await ai.dialogue.register(scope,turn.id,turn.messageId); await ai.dialogue.drain(scope)
    const proposal = (await ai.get(scope)).proposals.at(-1)!
    if (kind === 'delete') await chatData.deleteMessage(scope.characterId,turn.messageId,scope.sessionId)
    else if (kind === 'persona') await chatData.updateSession(scope.characterId,scope.sessionId,{personaId:null})
    else if (kind === 'mode') await chatData.updateSession(scope.characterId,scope.sessionId,{narrativeMode:'omniscient'})
    else if (kind === 'off') await chatData.updateSession(scope.characterId,scope.sessionId,{spatialNarrativeSyncPolicy:'off'})
    else if (kind === 'user') { const user = chatData.readMessages(scope.characterId,scope.sessionId).filter(message => message.role === 'user').at(-1)!; persistBody(user.id,'user','修改用户输入') }
    else persistBody(turn.messageId,'assistant',kind === 'swipe' ? '另一个候选' : '改写正文',turn.id)
    expect((await ai.get(scope)).proposals.find(item => item.id === proposal.id)?.status).toBe('stale')
    await expect(ai.apply(scope,proposal.id)).rejects.toThrow()
    expect((await spatialService.loadBound(scope.characterId,scope.sessionId))?.version).toEqual(snapshot.version)
  })
  it('解析失败不自动重试；显式重试去重并恢复待确认建议', async () => {
    const snapshot = await initialized(); complete.mockClear(); complete.mockResolvedValue(completion('不是 JSON'))
    const turn = await captureTurn(); await ai.dialogue.register(scope,turn.id,turn.messageId); await ai.dialogue.drain(scope)
    const task = (await ai.get(scope)).tasks.at(-1)!
    expect(task.state).toBe('failed'); expect(complete).toHaveBeenCalledTimes(1)
    complete.mockResolvedValue(completion(narrativeReply(snapshot)))
    await ai.dialogue.retry(scope,task.id); await expect(ai.dialogue.retry(scope,task.id)).rejects.toThrow('正在处理')
    await ai.dialogue.drain(scope); expect(complete).toHaveBeenCalledTimes(2)
    expect((await ai.get(scope)).proposals.at(-1)?.status).toBe('pending')
  })
  it('提取期间拖动产生版本冲突，正文保存成功且画板保留手动结果', async () => {
    const snapshot = await initialized(); let resolve!: (value: AICompletion) => void
    complete.mockImplementation(() => new Promise(done => { resolve = done }))
    const turn = await captureTurn(); await ai.dialogue.register(scope,turn.id,turn.messageId)
    const running = ai.dialogue.drain(scope); await vi.waitFor(() => expect(resolve).toBeDefined())
    await spatialService.applyEditorBatch(scope.characterId,scope.sessionId,request(snapshot,[{type:'update_world',patch:{description:'手动修改'}}]))
    resolve(completion(narrativeReply(snapshot))); await running
    const proposal = (await ai.get(scope)).proposals.at(-1)!
    expect(proposal.status).toBe('stale'); await expect(ai.apply(scope,proposal.id)).rejects.toThrow('画板已更新')
    expect(chatData.readMessages(scope.characterId,scope.sessionId).at(-1)?.content).toBe('林雪走到青石城')
  })
  it('较新回复完成后旧结果迟到只保留新建议；不同聊天页面不改变任务归属', async () => {
    const snapshot = await initialized(); complete.mockClear(); let resolve!: (value: AICompletion) => void
    complete.mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue(completion(narrativeReply(snapshot)))
    const old = await captureTurn(); await ai.dialogue.register(scope,old.id,old.messageId)
    const running = ai.dialogue.drain(scope); await vi.waitFor(() => expect(resolve).toBeDefined())
    const newer = await captureTurn(); await ai.dialogue.register(scope,newer.id,newer.messageId)
    resolve(completion(narrativeReply(snapshot))); await running; await ai.dialogue.drain(scope)
    const state = await ai.get(scope)
    expect(state.tasks.find(task => task.dialogueId === old.id)?.state).toBe('superseded')
    expect(state.proposals.filter(proposal => proposal.mode === 'dialogue_sync' && proposal.status === 'pending').map(proposal => proposal.dialogueId)).toEqual([newer.id])
  })
  it('重启只恢复最新正文检查点和未发出队列；已发出未知结果不重调用', async () => {
    const snapshot = await initialized(); complete.mockClear(); complete.mockResolvedValue(completion(narrativeReply(snapshot)))
    const turn = await captureTurn()
    // 模拟正文已保存，登记前退出。
    ai = createSpatialAiService({complete}); await ai.dialogue.recover(); await ai.dialogue.drain(scope)
    expect(complete).toHaveBeenCalledTimes(1); expect((await ai.get(scope)).proposals.at(-1)?.status).toBe('pending')
    const state = await ai.get(scope); state.tasks.push({id:'interrupted-request',requestHash:'h',mode:'dialogue_sync',dialogueId:turn.id,state:'running',startedAt:Date.now()})
    storage.writeJson(spatialPaths.ai(state.id),state)
    ai = createSpatialAiService({complete}); await ai.dialogue.recover(); await ai.dialogue.drain(scope)
    expect((await ai.get(scope)).tasks.at(-1)?.state).toBe('interrupted'); expect(complete).toHaveBeenCalledTimes(1)
  })
  it('续写使用完整接续正文与独立来源 hash，不将早期全文重新作为普通历史发送', async () => {
    const snapshot = await initialized(); complete.mockClear(); complete.mockResolvedValue(completion(narrativeReply(snapshot)))
    const turn = await captureTurn('continue')
    await ai.dialogue.register(scope,turn.id,turn.messageId); await ai.dialogue.drain(scope)
    expect((await ai.get(scope)).tasks.at(-1)?.error).toBeUndefined()
    expect((await ai.get(scope)).tasks.at(-1)).toMatchObject({state:'completed',mode:'dialogue_sync'})
    const payload = JSON.parse(complete.mock.calls[0]![0].messages[1]!.content as string)
    expect(payload.generationKind).toBe('continue'); expect(payload.assistant).toContain('林雪在茶馆喝茶。'); expect(payload.assistant).toContain('林雪走到青石城')
    expect(payload.assistant).not.toContain('隐藏思考')
  })
})
async function initialized() {
  const state = await initialize()
  expect(state.tasks.at(-1)?.state).toBe('completed')
  return view((await ai.apply(scope, state.proposals[0]!.id)).snapshot)
}

async function storyProposal(snapshot: SpatialSnapshot, body = '林雪走到青石城', result = narrativeReply(snapshot)) {
  complete.mockResolvedValue(completion(result))
  const turn = await captureTurn('normal', '继续', body)
  await ai.dialogue.register(scope, turn.id, turn.messageId); await ai.dialogue.drain(scope)
  return { turn, proposal: (await ai.get(scope)).proposals.at(-1)! }
}

function unknownReply(snapshot: SpatialSnapshot, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ schemaVersion: 1, changes: [], unresolved: [{ actorId: movement(snapshot).actorId, targetText: '渡口', completed: true,
    evidence: '林雪已经到达渡口', evidenceSource: 'assistant', reason: '地图尚无渡口', ...overrides }] })
}

describe('空间阶段 4：可选自动同步', () => {
  const policy = (value: 'auto' | 'suggest' | 'off') => chatData.updateSession(scope.characterId, scope.sessionId, { spatialNarrativeSyncPolicy: value })
  it('自动同步按原文客厅修正模型误选浴室式旧地点，补建地点并同步双方，不要求确认', async () => {
    const snapshot = await initialized(); await policy('auto')
    const core = view(snapshot), persona = core.world.actors.find(actor => actor.externalRef.type === 'qingyu-persona')!
    const tea = core.world.nodes.find(node => node.name === '茶馆')!, quote = '我直接将其抱至客厅'
    complete.mockResolvedValue(completion(JSON.stringify({schemaVersion:1,changes:[
      movement(snapshot,{targetNodeId:tea.id,evidence:quote,evidenceSource:'user',confidence:0.6}),
      movement(snapshot,{actorId:persona.id,targetNodeId:tea.id,evidence:quote,evidenceSource:'user',confidence:0.6}),
    ],unresolved:[]})))
    const turn = await captureTurn('normal',quote,'林雪依偎在旅人怀里。')
    await ai.dialogue.register(scope,turn.id,turn.messageId); await ai.dialogue.drain(scope)
    const proposal = (await ai.get(scope)).proposals.at(-1)!
    expect(proposal).toMatchObject({status:'applied',automatic:{status:'applied'}})
    const after = view((await spatialService.loadBound(scope.characterId,scope.sessionId))!), living = after.world.nodes.filter(node => node.name === '客厅')
    expect(living).toHaveLength(1)
    expect(living[0]!.childBoardId).toBeNull()
    expect(after.runtime.placements).toHaveLength(2)
    expect(after.runtime.placements.every(placement => placement.anchor.nodeId === living[0]!.id)).toBe(true)
    expect(complete).toHaveBeenCalledTimes(2)
    const undone = view((await ai.undo(scope,proposal.id)).snapshot)
    expect(undone.world.nodes.some(node => node.name === '客厅')).toBe(false)
    expect(undone.runtime.placements).toHaveLength(core.runtime.placements.length)
  })

  it('自动模式独立采用明确动作，跳过未完成动作，不把整批退回用户判断', async () => {
    const snapshot = await initialized(); await policy('auto')
    const persona = view(snapshot).world.actors.find(actor => actor.externalRef.type === 'qingyu-persona')!
    complete.mockResolvedValue(completion(JSON.stringify({schemaVersion:1,changes:[
      movement(snapshot,{confidence:0.6}),
      movement(snapshot,{actorId:persona.id,evidence:'旅人准备走到青石城',evidenceSource:'user'}),
    ],unresolved:[]})))
    const turn = await captureTurn('normal','旅人准备走到青石城','林雪走到青石城')
    await ai.dialogue.register(scope,turn.id,turn.messageId); await ai.dialogue.drain(scope)
    const proposal = (await ai.get(scope)).proposals.at(-1)!
    expect(proposal).toMatchObject({status:'applied',automatic:{status:'applied'}})
    expect(proposal.unresolved).toHaveLength(1)
    expect(view((await spatialService.loadBound(scope.characterId,scope.sessionId))!).runtime.placements).toHaveLength(1)
  })

  it.each([0.9, 0.95])('普通角色动作置信度 %s 自动原子提交、下轮读取且可撤销，重复投递不再应用', async confidence => {
    const snapshot = await initialized(); await policy('auto'); complete.mockClear()
    const { turn, proposal } = await storyProposal(snapshot, '林雪走到青石城', narrativeReply(snapshot, { confidence }))
    expect(proposal).toMatchObject({ status: 'applied', automatic: { status: 'applied' } })
    const applied = (await spatialService.loadBound(scope.characterId, scope.sessionId))!
    expect(applied.version.runtimeRevision).toBe(snapshot.version.runtimeRevision + 1)
    expect(view(applied).runtime.events.at(-1)?.source).toBe('story')
    expect((await spatialContextService.read(scope))?.text).toContain('青石城')
    await ai.dialogue.register(scope, turn.id, turn.messageId); await ai.dialogue.recover(); await ai.dialogue.drain(scope)
    expect(complete).toHaveBeenCalledTimes(1)
    expect((await ai.apply(scope, proposal.id)).snapshot.version).toEqual(applied.version)
    expect(chatData.readMessages(scope.characterId, scope.sessionId, true).at(-1)?.content).toBe('林雪走到青石城')
    expect(view((await ai.undo(scope, proposal.id)).snapshot).runtime.placements).toMatchObject(view(snapshot).runtime.placements.map(item => ({ actorId: item.actorId, anchor: item.anchor })))
  })
  it.each([0.5, 0.899])('置信度 %s 且原文明确的动作自动同步', async confidence => {
    const snapshot = await initialized(); await policy('auto')
    const { proposal } = await storyProposal(snapshot, '林雪走到青石城', narrativeReply(snapshot, { confidence }))
    expect(proposal).toMatchObject({ status: 'applied', automatic: { status: 'applied' } })
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version.runtimeRevision).toBe(snapshot.version.runtimeRevision + 1)
  })
  it.each(['regenerate', 'continue'] as const)('%s 已保存正文中的明确动作自动同步', async kind => {
    const snapshot = await initialized(); await policy('auto'); complete.mockResolvedValue(completion(narrativeReply(snapshot)))
    const turn = await captureTurn(kind); await ai.dialogue.register(scope, turn.id, turn.messageId); await ai.dialogue.drain(scope)
    expect((await ai.get(scope)).proposals.at(-1)).toMatchObject({ status: 'applied', automatic: { status: 'applied' } })
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version.runtimeRevision).toBe(snapshot.version.runtimeRevision + 1)
  })
  it('重复声明角色或用户仍在原地点只改变说明，不产生剧情移动', async () => {
    const snapshot = await initialized(), core = view(snapshot)
    const persona = core.world.actors.find(item => item.externalRef.type === 'qingyu-persona')!, tea = core.world.nodes.find(item => item.name === '茶馆')!
    const placed = await spatialService.applyEditorBatch(scope.characterId, scope.sessionId, request(snapshot, [{ type: 'place_actor', actorId: persona.id, placement: { boardId: tea.boardId, anchor: { kind: 'node', nodeId: tea.id }, semanticPosition: { precision: 'inside-only', note: '' } } }]))
    if (!placed.ok) throw new Error(placed.message)
    await policy('auto')
    const result = JSON.stringify({ schemaVersion: 1, changes: [movement(placed.snapshot), movement(placed.snapshot, { actorId: persona.id, targetNodeId: tea.id, evidence: '旅人仍在茶馆', evidenceSource: 'user', semanticPosition: { precision: 'inside-only', note: '仍在茶馆' } })], unresolved: [] })
    complete.mockResolvedValue(completion(result))
    const turn = await captureTurn('normal', '旅人仍在茶馆', '林雪走到青石城')
    await ai.dialogue.register(scope, turn.id, turn.messageId); await ai.dialogue.drain(scope)
    const proposal = (await ai.get(scope)).proposals.at(-1)!
    expect(proposal).toMatchObject({ status: 'applied', automatic: { status: 'applied' } })
    expect(proposal.commands).toHaveLength(1)
    const after = view((await spatialService.loadBound(scope.characterId, scope.sessionId))!)
    expect(after.runtime.placements.find(item => item.actorId === persona.id)).toEqual(view(placed.snapshot).runtime.placements.find(item => item.actorId === persona.id))
    const noop = narrativeReply(after, { evidence: '林雪仍在青石城', semanticPosition: { precision: 'inside-only', note: '仍在青石城' } })
    const unchanged = await storyProposal(after, '林雪仍在青石城', noop)
    expect(unchanged.proposal.id).toBe(proposal.id)
    expect(unchanged.proposal.dialogueId).not.toBe(unchanged.turn.id)
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(after.version)
  })
  it('用户明确声明移动与角色动作同批自动同步', async () => {
    const snapshot = await initialized(); await policy('auto')
    const persona = view(snapshot).world.actors.find(item => item.externalRef.type === 'qingyu-persona')!
    const result = JSON.stringify({ schemaVersion: 1, changes: [movement(snapshot), movement(snapshot, { actorId: persona.id, evidence: '旅人走到青石城', evidenceSource: 'user' })], unresolved: [] })
    complete.mockResolvedValue(completion(result))
    const turn = await captureTurn('normal', '旅人走到青石城', '林雪走到青石城')
    await ai.dialogue.register(scope, turn.id, turn.messageId); await ai.dialogue.drain(scope)
    const proposal = (await ai.get(scope)).proposals.at(-1)!
    expect(proposal.commands).toHaveLength(2)
    expect(proposal).toMatchObject({ status: 'applied', automatic: { status: 'applied' } })
    const applied = await ai.apply(scope, proposal.id)
    expect(view(applied.snapshot).runtime.placements).toHaveLength(2)
    expect(view(applied.snapshot).runtime.placements.every(item => item.anchor.nodeId === movement(snapshot).targetNodeId)).toBe(true)
  })
  it('明确的新地点自动创建并移动，重复恢复不再次应用', async () => {
    const snapshot = await initialized(); await policy('auto')
    const { proposal } = await storyProposal(snapshot, '林雪已经到达渡口', unknownReply(snapshot))
    expect(proposal).toMatchObject({status:'applied',automatic:{status:'applied'}})
    const after = (await spatialService.loadBound(scope.characterId,scope.sessionId))!, core = view(after)
    const pier = core.world.nodes.find(node => node.name === '渡口')!
    expect(pier.childBoardId).toBeNull()
    expect(core.runtime.placements[0]!.anchor.nodeId).toBe(pier.id)
    await ai.dialogue.recover(); await ai.dialogue.drain(scope)
    expect((await spatialService.loadBound(scope.characterId,scope.sessionId))?.version).toEqual(after.version)
  })
  it('旧自动记录直接按保存的客厅原文修复，不增加模型调用且重复读取不重复移动', async () => {
    const snapshot = await initialized(), quote = '我直接将其抱至客厅'
    complete.mockResolvedValue(completion(narrativeReply(snapshot,{evidence:quote,evidenceSource:'user',confidence:0.6})))
    const turn = await captureTurn('normal',quote,'林雪依偎在旅人怀里。')
    await ai.dialogue.register(scope,turn.id,turn.messageId); await ai.dialogue.drain(scope)
    const proposal = (await ai.get(scope)).proposals.at(-1)!
    expect(proposal.status).toBe('pending')
    await policy('auto')
    const state = await ai.get(scope), session = await sessionFor(scope)
    const old = state.proposals.find(item => item.id === proposal.id)!
    old.automatic = {status:'confirmation',reason:'本批有未明确项，整批仍需确认'}
    const generation = state.dialogueGenerations!.at(-1)!
    generation.syncPolicy = 'auto'; generation.syncEpoch = session!.spatialNarrativeSyncEpoch
    storage.writeJson(spatialPaths.ai(state.id),state); complete.mockClear()
    const repaired = await ai.get(scope)
    expect(repaired.proposals.at(-1)).toMatchObject({status:'applied',automatic:{status:'applied'}})
    const after = (await spatialService.loadBound(scope.characterId,scope.sessionId))!, core = view(after)
    const living = core.world.nodes.find(node => node.name === '客厅')!
    expect(core.runtime.placements[0]!.anchor.nodeId).toBe(living.id)
    await ai.get(scope)
    expect((await spatialService.loadBound(scope.characterId,scope.sessionId))?.version).toEqual(after.version)
    expect(complete).not.toHaveBeenCalled()
  })
  it('发送时为需确认，即使提取前开启自动也不批准本轮', async () => {
    const snapshot = await initialized(); complete.mockResolvedValue(completion(narrativeReply(snapshot)))
    const turn = await captureTurn(); await policy('auto')
    await ai.dialogue.register(scope, turn.id, turn.messageId); await ai.dialogue.drain(scope)
    expect((await ai.get(scope)).proposals.at(-1)).toMatchObject({ status: 'discarded', automatic: { status: 'skipped', reason: expect.stringContaining('发送时') } })
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(snapshot.version)
  })
  it('自动模式切回需确认再开启，正在提取的旧回复也不能事后自动批准', async () => {
    const snapshot = await initialized(); await policy('auto'); complete.mockResolvedValue(completion(narrativeReply(snapshot)))
    const turn = await captureTurn(); await policy('suggest'); await policy('auto')
    await ai.dialogue.register(scope, turn.id, turn.messageId); await ai.dialogue.drain(scope)
    expect((await ai.get(scope)).proposals.at(-1)).toMatchObject({ status: 'discarded', automatic: { status: 'skipped', reason: expect.stringContaining('策略已切换') } })
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(snapshot.version)
  })
  it.each(['suggest', 'off'] as const)('提交前切回 %s，权威入口再次核对策略而不写入', async value => {
    const snapshot = await initialized(); await policy('auto')
    const original = spatialService.applyEditorBatch
    vi.spyOn(spatialService, 'applyEditorBatch').mockImplementationOnce(async (...args) => { await policy(value); return original(...args) })
    const { proposal } = await storyProposal(snapshot)
    expect(proposal.status).toBe('discarded')
    expect(proposal.automatic?.status).toBe('skipped')
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(snapshot.version)
  })
  it('关闭读取暂停剧情捕获，用户主动指令仍能调用并且不会自动提交', async () => {
    const snapshot = await initialized(); await policy('auto'); complete.mockClear()
    await chatData.updateSession(scope.characterId, scope.sessionId, { spatialContextEnabled: false })
    expect(await ai.dialogue.capture(scope, { generationId: randomUUID(), kind: 'normal' })).toBeNull()
    await ai.dialogue.recover(); await ai.dialogue.drain(scope)
    expect(complete).not.toHaveBeenCalled()
    complete.mockResolvedValue(completion(JSON.stringify({ schemaVersion: 1, explanation: '查看角色', needsClarification: false, operations: [] })))
    expect((await ai.ask(scope, instruction('查看角色位置'))).tasks.at(-1)?.state).toBe('completed')
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(snapshot.version)
  })
  it('关闭读取在提交前生效，旧自动建议失效且不能回写', async () => {
    const snapshot = await initialized(); await policy('auto')
    const original = spatialService.applyEditorBatch
    vi.spyOn(spatialService, 'applyEditorBatch').mockImplementationOnce(async (...args) => {
      await chatData.updateSession(scope.characterId, scope.sessionId, { spatialContextEnabled: false }); return original(...args)
    })
    const { proposal } = await storyProposal(snapshot)
    expect(proposal).toMatchObject({ status: 'discarded', canReview: false, automatic: { status: 'skipped', reason: expect.stringContaining('读取已关闭') } })
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(snapshot.version)
  })
  it('关闭读取后再开启不追认在途自动建议', async () => {
    const snapshot = await initialized(); await policy('auto'); complete.mockResolvedValue(completion(narrativeReply(snapshot)))
    const turn = await captureTurn()
    await chatData.updateSession(scope.characterId, scope.sessionId, { spatialContextEnabled: false })
    await chatData.updateSession(scope.characterId, scope.sessionId, { spatialContextEnabled: true })
    await ai.dialogue.register(scope, turn.id, turn.messageId); await ai.dialogue.drain(scope)
    expect((await ai.get(scope)).proposals.at(-1)).toMatchObject({ status: 'discarded', automatic: { status: 'skipped', reason: expect.stringContaining('策略已切换') } })
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(snapshot.version)
  })
  it('提交前地图版本变化，自动跳过，不覆盖编辑', async () => {
    const snapshot = await initialized(); await policy('auto')
    const original = spatialService.applyEditorBatch
    let edited!: SpatialSnapshot
    vi.spyOn(spatialService, 'applyEditorBatch').mockImplementationOnce(async (...args) => {
      const result = await original(scope.characterId, scope.sessionId, request(snapshot, [{ type: 'update_node', nodeId: movement(snapshot).targetNodeId, patch: { name: '新城' } }]))
      if (!result.ok) throw new Error(result.message)
      edited = result.snapshot; return original(...args)
    })
    const { proposal } = await storyProposal(snapshot)
    expect(proposal).toMatchObject({ status: 'discarded', canReview: false, automatic: { status: 'skipped' } })
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(edited.version)
    expect(view(edited).runtime.placements[0]!.anchor.nodeId).toBe(view(snapshot).runtime.placements[0]!.anchor.nodeId)
  })
  it('提交前改写来源，自动失败且建议不能重新核对复活', async () => {
    const snapshot = await initialized(); await policy('auto')
    const original = spatialService.applyEditorBatch
    vi.spyOn(spatialService, 'applyEditorBatch').mockImplementationOnce(async (...args) => {
      const latest = chatData.readMessages(scope.characterId, scope.sessionId, true).at(-1)!
      persistBody(latest.id, 'assistant', '林雪留在茶馆。', latest.spatialGenerationId)
      return original(...args)
    })
    const { proposal } = await storyProposal(snapshot)
    expect(proposal).toMatchObject({ status: 'discarded', canReview: false, automatic: { status: 'skipped' } })
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(snapshot.version)
  })
  it('自动模式下计划仍是诊断，不能通过确认按钮变成已完成动作', async () => {
    const snapshot = await initialized(); await policy('auto')
    const { proposal } = await storyProposal(snapshot, '林雪准备走到青石城', narrativeReply(snapshot, { evidence: '林雪准备走到青石城' }))
    expect(proposal.commands).toHaveLength(0)
    expect(proposal.automatic?.status).toBe('skipped')
    await expect(ai.apply(scope, proposal.id, true)).rejects.toThrow('已忽略')
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(snapshot.version)
  })
  it('停止发生在自动提交前，自动跳过，不能写入', async () => {
    const snapshot = await initialized(); await policy('auto')
    const original = spatialService.applyEditorBatch
    vi.spyOn(spatialService, 'applyEditorBatch').mockImplementationOnce(async (...args) => { await ai.cancel(scope); return original(...args) })
    const { proposal } = await storyProposal(snapshot)
    expect(proposal).toMatchObject({ status: 'discarded', automatic: { status: 'skipped' } })
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(snapshot.version)
  })
  it('自动事务写入中断后恢复实际已应用结果，不能误报需确认或重复移动', async () => {
    const snapshot = await initialized(); await policy('auto'); const state = await ai.get(scope), original = storage.writeJson
    let failed = false
    vi.spyOn(storage, 'writeJson').mockImplementation((path, value) => {
      if (!failed && path === spatialPaths.ai(state.id) && (value as typeof state).proposals.some(item => item.automatic?.status === 'applied')) { failed = true; throw new Error('模拟自动事务断电') }
      original(path, value)
    })
    const { proposal } = await storyProposal(snapshot)
    expect(failed).toBe(true)
    expect(proposal).toMatchObject({ status: 'applied', automatic: { status: 'applied' } })
    const after = (await spatialService.loadBound(scope.characterId, scope.sessionId))!
    expect(after.version.runtimeRevision).toBe(snapshot.version.runtimeRevision + 1)
    expect((await ai.apply(scope, proposal.id)).snapshot.version).toEqual(after.version)
    expect(readdirSync(join(storage.DIRS.spatial(), 'transactions'))).toHaveLength(0)
  })
  it('恢复发生在提交前，旧自动任务不能写入恢复后的同 ID 助手', async () => {
    const snapshot = await initialized(); await policy('auto'); const before = await ai.get(scope), zip = join(testRoot, 'auto-restore.zip')
    createBackupV2(zip)
    const original = spatialService.applyEditorBatch
    vi.spyOn(spatialService, 'applyEditorBatch').mockImplementationOnce(async (...args) => { await ai.restore(() => restoreBackupV2(zip)); return original(...args) })
    complete.mockResolvedValue(completion(narrativeReply(snapshot)))
    const turn = await captureTurn(); await ai.dialogue.register(scope, turn.id, turn.messageId); await ai.dialogue.drain(scope)
    expect((await ai.get(scope)).proposals).toEqual(before.proposals)
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(snapshot.version)
  })
  it('重启遇到未完成的自动决定自动跳过，不额外提取或自动应用', async () => {
    const snapshot = await initialized(), { proposal } = await storyProposal(snapshot), state = await ai.get(scope)
    state.proposals.find(item => item.id === proposal.id)!.automatic = { status: 'applying' }
    state.dialogueGenerations!.at(-1)!.syncPolicy = 'auto'
    storage.writeJson(spatialPaths.ai(state.id), state); await policy('auto'); complete.mockClear()
    ai = createSpatialAiService({ complete }); await ai.dialogue.recover(); await ai.dialogue.drain(scope)
    expect((await ai.get(scope)).proposals.at(-1)).toMatchObject({ status: 'discarded', automatic: { status: 'skipped', reason: expect.stringContaining('中断') } })
    expect(complete).not.toHaveBeenCalled()
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))?.version).toEqual(snapshot.version)
  })
})

describe('空间阶段 3：确认、目标核对、撤销与恢复', () => {
  it('角色的“我的房间”从剧情候选到创建及核对始终保留角色归属', async () => {
    const snapshot = await initialized(), quote = '我已经走进了我的房间。'
    const { proposal } = await storyProposal(snapshot, quote, unknownReply(snapshot, { targetText: '我的房间', evidence: quote }))
    const candidate = proposal.dialogueCandidates![0]!
    expect(candidate).toMatchObject({ targetText: '林雪的房间', evidence: quote, eligible: true })
    const prepared = await ai.preparePlace(scope, proposal.id, '我的房间', null), creation = prepared.proposals.at(-1)!
    expect(creation.commands[0]).toMatchObject({ type: 'create_node', payload: { name: '林雪的房间' } })
    const created = await ai.apply(scope, creation.id), room = view(created.snapshot).world.nodes.find(node => node.name === '林雪的房间')!
    const reviewed = await ai.review(scope, proposal.id, { targets: { [candidate.id]: room.id } })
    const moved = await ai.apply(scope, reviewed.proposals.at(-1)!.id)
    expect(view(moved.snapshot).runtime.placements.find(item => item.actorId === candidate.actorId)?.anchor.nodeId).toBe(room.id)
  })
  it('确认后下一轮读取新位置；主历史没有画板助手消息，忽略不重复提议', async () => {
    const snapshot = await initialized(), { turn, proposal } = await storyProposal(snapshot)
    expect((await spatialContextService.read(scope))!.text).toContain('茶馆')
    const bodyBefore = chatData.readMessages(scope.characterId, scope.sessionId, true)
    const applied = await ai.apply(scope, proposal.id)
    expect((await spatialContextService.read(scope))!.text).toContain('青石城')
    expect(chatData.readMessages(scope.characterId, scope.sessionId, true)).toEqual(bodyBefore)
    await ai.dialogue.register(scope, turn.id, turn.messageId); await ai.dialogue.drain(scope)
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))!.version).toEqual(applied.snapshot.version)
    const next = await storyProposal(applied.snapshot, '林雪进入茶馆', JSON.stringify({ schemaVersion: 1, changes: [{ ...movement(applied.snapshot), targetNodeId: view(snapshot).world.nodes.find(node => node.name === '茶馆')!.id, evidence: '林雪进入茶馆' }], unresolved: [] }))
    const ignored = await ai.discard(scope, next.proposal.id)
    expect(ignored.proposals.at(-1)).toMatchObject({ status: 'discarded', discardReason: '用户忽略本轮建议' })
    await ai.dialogue.register(scope, next.turn.id, next.turn.messageId); await ai.dialogue.drain(scope)
    expect((await ai.get(scope)).proposals.filter(item => item.dialogueId === next.turn.id)).toHaveLength(1)
  })
  it('未知目标选择已有地点后产生独立新确认，重新读取当前路径，不增加模型调用', async () => {
    const snapshot = await initialized(), { proposal } = await storyProposal(snapshot, '林雪已经到达渡口', unknownReply(snapshot))
    expect(proposal.commands).toHaveLength(0)
    const candidate = proposal.dialogueCandidates![0]!, city = view(snapshot).world.nodes.find(node => node.name === '青石城')!
    complete.mockClear()
    const reviewed = await ai.review(scope, proposal.id, { targets: { [candidate.id]: city.id } }), next = reviewed.proposals.at(-1)!
    expect(next).toMatchObject({ status: 'pending', reviewedFromId: proposal.id, comparisons: [{ actorName: '林雪', currentPath: '青石城 / 茶馆', targetPath: '青石城' }] })
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))!.version).toEqual(snapshot.version)
    expect(complete).not.toHaveBeenCalled()
    await expect(ai.apply(scope, proposal.id)).rejects.toThrow('重新核对')
    const applied = await ai.apply(scope, next.id)
    expect(view(applied.snapshot).runtime.placements[0]!.anchor.nodeId).toBe(city.id)
  })
  it('创建地点必须先确认地图，再核对原动作并第二次确认移动', async () => {
    const snapshot = await initialized(), { proposal } = await storyProposal(snapshot, '林雪已经到达渡口', unknownReply(snapshot))
    const candidate = proposal.dialogueCandidates![0]!, city = view(snapshot).world.nodes.find(node => node.name === '青石城')!
    const preview = await ai.preparePlace(scope, proposal.id, '渡口', city.id), creation = preview.proposals.at(-1)!
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))!.version).toEqual(snapshot.version)
    expect(creation.commands.map(command => (command as SpatialCommand).type)).toEqual(['create_node'])
    const created = await ai.apply(scope, creation.id), core = view(created.snapshot), wharf = core.world.nodes.find(node => node.name === '渡口')!
    expect(core.runtime.placements[0]!.anchor.nodeId).toBe(view(snapshot).runtime.placements[0]!.anchor.nodeId)
    const reviewed = await ai.review(scope, proposal.id, { targets: { [candidate.id]: wharf.id } }), movementProposal = reviewed.proposals.at(-1)!
    expect(movementProposal.comparisons![0]!.targetPath).toBe('青石城 / 渡口')
    expect(movementProposal.baseVersion).toEqual(created.snapshot.version)
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))!.version).toEqual(created.snapshot.version)
    const moved = await ai.apply(scope, movementProposal.id)
    expect(view(moved.snapshot).runtime.placements[0]!.anchor.nodeId).toBe(wharf.id)
  })
  it.each(['plan', 'persona', 'actor'] as const)('未明确的 %s 动作不能通过地点选择变成移动', async kind => {
    const snapshot = await initialized(), persona = view(snapshot).world.actors.find(actor => actor.externalRef.type === 'qingyu-persona')!
    const overrides = kind === 'plan' ? { evidence: '林雪准备去渡口' } : kind === 'persona' ? { actorId: persona.id, evidence: '旅人已经到达渡口' } : { actorId: '' }
    const body = String(overrides.evidence ?? '林雪已经到达渡口'), { proposal } = await storyProposal(snapshot, body, unknownReply(snapshot, overrides))
    const city = view(snapshot).world.nodes.find(node => node.name === '青石城')!, candidate = proposal.dialogueCandidates![0]!
    expect(candidate.eligible).toBe(false)
    await expect(ai.review(scope, proposal.id, { targets: { [candidate.id]: city.id } })).rejects.toThrow('不能通过选择地点')
    await expect(ai.apply(scope, proposal.id, true)).rejects.toThrow('未解析或未完成')
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))!.version).toEqual(snapshot.version)
  })
  it('版本冲突只能重新核对：保留手动结果，核对后再次发生变化仍拒绝应用', async () => {
    const snapshot = await initialized(), { proposal } = await storyProposal(snapshot)
    const manual = await spatialService.applyEditorBatch(scope.characterId, scope.sessionId, request(snapshot, [{ type: 'update_world', patch: { description: '手动修改' } }]))
    expect(manual.ok).toBe(true)
    await expect(ai.apply(scope, proposal.id)).rejects.toThrow('画板版本已改变')
    const reviewed = (await ai.review(scope, proposal.id, { targets: {} })).proposals.at(-1)!
    expect(reviewed.baseVersion).toEqual(manual.ok ? manual.snapshot.version : null)
    expect(reviewed.comparisons![0]!.currentPath).toBe('青石城 / 茶馆')
    const next = await spatialService.applyEditorBatch(scope.characterId, scope.sessionId, request(manual.ok ? manual.snapshot : snapshot, [{ type: 'update_world', patch: { description: '又一次修改' } }]))
    await expect(ai.apply(scope, reviewed.id)).rejects.toThrow('画板版本已改变')
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))!.version).toEqual(next.ok ? next.snapshot.version : null)
  })
  it('核对后正文改写、关闭再开启同步均不能复活原动作', async () => {
    const snapshot = await initialized(), { turn, proposal } = await storyProposal(snapshot)
    const reviewed = (await ai.review(scope, proposal.id, { targets: {} })).proposals.at(-1)!
    persistBody(turn.messageId, 'assistant', '林雪还在茶馆', turn.id)
    await expect(ai.apply(scope, reviewed.id)).rejects.toThrow('来源正文')
    await expect(ai.review(scope, reviewed.id, { targets: {} })).rejects.toThrow('来源正文')
    const next = await storyProposal(snapshot)
    await chatData.updateSession(scope.characterId, scope.sessionId, { spatialNarrativeSyncPolicy: 'off' }); await ai.get(scope)
    await chatData.updateSession(scope.characterId, scope.sessionId, { spatialNarrativeSyncPolicy: 'suggest' })
    await expect(ai.review(scope, next.proposal.id, { targets: {} })).rejects.toThrow('剧情同步已关闭')
  })
  it('剧情逆命令原子撤销，重复撤销和重启不增加事件，撤销后不能重应用', async () => {
    const snapshot = await initialized(), { proposal } = await storyProposal(snapshot), applied = await ai.apply(scope, proposal.id)
    const undone = await ai.undo(scope, proposal.id), core = view(undone.snapshot)
    expect(core.runtime.placements[0]!.anchor.nodeId).toBe(view(snapshot).runtime.placements[0]!.anchor.nodeId)
    expect(undone.snapshot.version.runtimeRevision).toBe(applied.snapshot.version.runtimeRevision + 1)
    ai = createSpatialAiService({ complete })
    expect((await ai.undo(scope, proposal.id)).snapshot.version).toEqual(undone.snapshot.version)
    await expect(ai.apply(scope, proposal.id)).rejects.toThrow('已撤销')
    expect((await ai.get(scope)).proposals.at(-1)!.status).toBe('undone')
  })
  it('角色移动与用户首次放置作为一批提交，撤销恢复两人的原始状态', async () => {
    const snapshot = await initialized(), core = view(snapshot), persona = core.world.actors.find(actor => actor.externalRef.type === 'qingyu-persona')!
    const user = '旅人已经到达青石城', body = '林雪走到青石城'
    complete.mockResolvedValue(completion(JSON.stringify({ schemaVersion: 1, changes: [movement(snapshot), { ...movement(snapshot), actorId: persona.id, evidence: user, evidenceSource: 'user' }], unresolved: [] })))
    const turn = await captureTurn('normal', user, body)
    await ai.dialogue.register(scope, turn.id, turn.messageId); await ai.dialogue.drain(scope)
    const proposal = (await ai.get(scope)).proposals.at(-1)!
    expect(proposal.commands.map(command => (command as SpatialCommand).type)).toEqual(['move_actor','place_actor'])
    const applied = await ai.apply(scope, proposal.id)
    expect(view(applied.snapshot).runtime.placements).toHaveLength(2)
    const undone = await ai.undo(scope, proposal.id)
    expect(view(undone.snapshot).runtime.placements).toHaveLength(1)
    expect(view(undone.snapshot).runtime.placements[0]!.anchor).toEqual(core.runtime.placements[0]!.anchor)
  })
  it('应用后拖动或地图修改阻止旧剧情撤销，来源改写本身不自动倒退位置', async () => {
    const snapshot = await initialized(), { turn, proposal } = await storyProposal(snapshot), applied = await ai.apply(scope, proposal.id)
    persistBody(turn.messageId, 'assistant', '林雪还在茶馆', turn.id)
    expect((await ai.get(scope)).proposals.at(-1)!.sourceChanged).toBe(true)
    const moved = await spatialService.applyEditorBatch(scope.characterId, scope.sessionId, request(applied.snapshot, [{ type: 'update_world', patch: { description: '后续手动修改' } }]))
    await expect(ai.undo(scope, proposal.id)).rejects.toThrow('已有其他修改')
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))!.version).toEqual(moved.ok ? moved.snapshot.version : null)
  })
  it('剧情提交写入中断后，事务恢复同时补齐助手与位置；再次确认不会再移动', async () => {
    const snapshot = await initialized(), { proposal } = await storyProposal(snapshot), state = await ai.get(scope), original = storage.writeJson
    const fault = vi.spyOn(storage, 'writeJson').mockImplementation((path, value) => { if (path === spatialPaths.ai(state.id)) throw new Error('模拟剧情 AI 记录断电'); original(path, value) })
    await expect(ai.apply(scope, proposal.id)).rejects.toThrow('断电'); fault.mockRestore()
    ai = createSpatialAiService({ complete }); await spatialService.recoverTransactions()
    expect((await ai.get(scope)).proposals.at(-1)!.status).toBe('applied')
    const recovered = (await spatialService.loadBound(scope.characterId, scope.sessionId))!
    expect((await ai.apply(scope, proposal.id)).snapshot.version).toEqual(recovered.version)
    expect(readdirSync(join(storage.DIRS.spatial(), 'transactions'))).toHaveLength(0)
    expect((await ai.undo(scope, proposal.id)).state.proposals.at(-1)!.status).toBe('undone')
  })
  it('真实 ZIP 恢复保留两份单聊/助手历史及提交去重记录，不额外调用模型', async () => {
    const snapshot = await initialized(), { proposal } = await storyProposal(snapshot), applied = await ai.apply(scope, proposal.id)
    const scopeB = { ...scope, sessionId: 'session-b' }
    const boundB = await spatialService.bindWorld(scopeB.characterId, scopeB.sessionId, snapshot.version.worldId), stateB = await ai.get(scopeB)
    const body = chatData.readMessages(scope.characterId, scope.sessionId, true), stateA = await ai.get(scope), zip = join(testRoot, 'stage3-backup.zip')
    createBackupV2(zip)
    rmSync(join(testRoot, 'data'), { recursive: true, force: true })
    complete.mockClear(); await ai.restore(() => restoreBackupV2(zip))
    expect(complete).not.toHaveBeenCalled()
    expect(chatData.readMessages(scope.characterId, scope.sessionId, true)).toEqual(body)
    expect((await ai.get(scope)).messages).toEqual(stateA.messages)
    expect((await ai.get(scopeB)).id).toBe(stateB.id)
    expect((await ai.get(scopeB)).messages).toEqual(stateB.messages)
    expect((await spatialService.loadBound(scopeB.characterId, scopeB.sessionId))!.version).toEqual(boundB.version)
    expect((await ai.apply(scope, proposal.id)).snapshot.version).toEqual(applied.snapshot.version)
    await expect(ai.apply(scopeB, proposal.id)).rejects.toThrow('提案不存在')
    expect((await ai.undo(scope, proposal.id)).state.proposals.at(-1)!.status).toBe('undone')
  })
  it('恢复时取消旧请求，迟到模型结果不能写入恢复后的同 ID 助手', async () => {
    await initialized()
    const before = await ai.get(scope), zip = join(testRoot, 'in-flight-restore.zip')
    createBackupV2(zip)
    let resolve!: (value: AICompletion) => void
    complete.mockImplementation(() => new Promise(done => { resolve = done }))
    const running = ai.ask(scope, instruction('读取当前位置'))
    await vi.waitFor(() => expect(resolve).toBeDefined())
    writeFileSync(spatialPaths.ai(before.id), '模拟旧助手文件损坏')
    await ai.restore(() => restoreBackupV2(zip))
    expect(complete.mock.calls.at(-1)![1].aborted).toBe(true)
    resolve(completion(JSON.stringify({ schemaVersion: 1, explanation: '旧请求迟到', needsClarification: false, operations: [] })))
    await running
    const restored = await ai.get(scope)
    expect(restored.id).toBe(before.id)
    expect(restored.messages).toEqual(before.messages)
    expect(restored.tasks).toEqual(before.tasks)
    expect(restored.proposals).toEqual(before.proposals)
  })
  it('其他聊天的助手引用拒绝读取，缺失世界拒绝恢复，不自动生成空位置', async () => {
    const snapshot = await initialized(), state = await ai.get(scope)
    const sessionsPath = join(storage.DIRS.chats(), scope.characterId, 'sessions.json')
    const sessions = storage.readJson<Array<{ id: string; spatialAiSessionId?: string }>>(sessionsPath)!
    sessions.find(session => session.id === 'session-b')!.spatialAiSessionId = state.id
    storage.writeJson(sessionsPath, sessions)
    await expect(ai.get({ ...scope, sessionId: 'session-b' })).rejects.toThrow('属于其他单聊')
    rmSync(spatialPaths.world(snapshot.version.worldId))
    await expect(ai.get(scope)).rejects.toThrow('空间世界不存在')
    expect(existsSync(spatialPaths.runtime(scope))).toBe(true)
  })
})

describe('空间阶段 1：独立会话与确认事务', () => {
  it('旧画板分类字段清理落盘，不改变人物位置和位置版本', async () => {
    const snapshot = await initialized(), core = view(snapshot)
    storage.writeJson(spatialPaths.world(core.world.id), { ...core.world, nodes: core.world.nodes.map(node => ({ ...node, categoryLabel: '旧分类',
      ...(node.kind === 'place' ? { placeCategory: 'building' } : { regionCategory: 'settlement' }) })) })
    const clean = view((await spatialService.loadBound(scope.characterId, scope.sessionId))!)
    for (const node of clean.world.nodes) {
      expect(node).not.toHaveProperty('categoryLabel')
      expect(node).not.toHaveProperty('placeCategory')
      expect(node).not.toHaveProperty('regionCategory')
    }
    expect(clean.runtime).toEqual(core.runtime)
    expect(storage.readJson(spatialPaths.world(core.world.id))).toEqual(clean.world)
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))!.version).toEqual(clean.version)
  })
  it('旧版嵌套子结构清理覆盖共享世界的所有会话，并且重载不重复变更版本', async () => {
    const snapshot = await initialized(), secondScope = { ...scope, sessionId: 'session-b' }
    await spatialService.bindWorld(secondScope.characterId, secondScope.sessionId, snapshot.version.worldId)
    const core = structuredClone(view(snapshot)), home = core.world.nodes.find(node => node.name === '茶馆')!
    const floor = { ...home, id: 'legacy-floor', name: '1 楼', parentNodeId: home.id, childBoardId: null }
    const room = { ...home, id: 'legacy-room', name: '旧房间', parentNodeId: floor.id, childBoardId: null }
    core.world.nodes.push(floor, room)
    storage.writeJson(spatialPaths.world(core.world.id), core.world)
    for (const owner of [scope, secondScope]) {
      const runtime = storage.readJson<SpatialCoreState['runtime']>(spatialPaths.runtime(owner))!
      runtime.placements = [{ ...structuredClone(core.runtime.placements[0]!), anchor: { kind: 'node', nodeId: room.id }, semanticPosition: { precision: 'inside-only', containmentPath: ['legacy-floor', 'legacy-room'] } }]
      storage.writeJson(spatialPaths.runtime(owner), runtime)
    }
    const cleaned = view((await spatialService.loadBound(scope.characterId, scope.sessionId))!)
    const second = view((await spatialService.loadBound(secondScope.characterId, secondScope.sessionId))!)
    expect(cleaned.world.nodes.some(node => node.id === floor.id)).toBe(true)
    expect(cleaned.world.nodes.some(node => node.id === room.id)).toBe(false)
    expect(cleaned.runtime.placements).toEqual([])
    expect(second.runtime.placements).toEqual([])
    expect((await spatialService.loadBound(scope.characterId, scope.sessionId))!.version).toEqual(cleaned.version)
    expect(storage.readJson<SpatialCoreState['world']>(spatialPaths.world(core.world.id))!.nodes.some(node => node.id === room.id)).toBe(false)
  })
  it('初始化携带真实发言者，将用户说的“你的房间”命名为角色房间', async () => {
    const quote = '你的房间有一张书桌。'
    persistBody('user-room', 'user', quote)
    complete.mockResolvedValue(completion(JSON.stringify({ schemaVersion: 1, explanation: '创建角色房间', needsClarification: false, unresolved: [], draft: {
      worldName: '场景', description: '', boards: [], distances: [], placements: [],
      nodes: [{ key: 'room', kind: 'place', name: '你的房间', parentKey: null, evidence: [{ sourceId: 'message:user-room', quote }] }],
    } })))
    const state = await initialize(), payload = JSON.parse(complete.mock.calls[0]![0].messages[1]!.content as string)
    expect(payload.sources.find((item: { id: string }) => item.id === 'message:user-room').speaker).toEqual({ role: 'user' })
    expect(payload.sources.find((item: { id: string }) => item.id === 'message:opening').speaker).toEqual({ role: 'character', characterId: 'char-a' })
    expect(payload.sources.find((item: { id: string }) => item.id === 'character:scenario').subject).toEqual({ kind: 'character', id: 'char-a' })
    expect(view(state.proposals.at(-1)!.preview!).world.nodes.find(node => node.kind === 'place')?.name).toBe('林雪的房间')
  })
  it('尚未开始的请求在排队后解析当前连接和模型', async () => {
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const blocking = spatialRepository.locked(() => {
      entered()
      return new Promise<void>(resolve => { release = resolve })
    })
    await enteredPromise
    const queued = initialize()
    try {
      expect(complete).not.toHaveBeenCalled()
      storage.writeJson(join(storage.DIRS.config(), 'settings.json'), {
        ...settings, activeModel: 'gpt-4o',
        connectionProfiles: settings.connectionProfiles.map(profile => ({ ...profile, baseUrl: 'http://next.invalid/v1', apiKey: 'next-test-only' })),
      })
    } finally { release() }
    await blocking
    const state = await queued
    expect(complete.mock.calls[0][0]).toMatchObject({ model: 'gpt-4o', baseUrl: 'http://next.invalid/v1', apiKey: 'next-test-only' })
    expect(state.tasks.at(-1)).toMatchObject({ model: 'gpt-4o', state: 'completed' })
    expect(state.scope).toMatchObject(scope)
  })

  it('运行请求保留配置，下一次请求读取新配置并保留助手历史', async () => {
    complete.mockImplementationOnce(async params => {
      storage.writeJson(join(storage.DIRS.config(), 'settings.json'), { ...settings, activeModel: 'gpt-4o' })
      expect(params.model).toBe('gpt-4o-mini')
      return completion(reply())
    })
    const first = await initialize()
    const next = await initialize()
    expect(complete.mock.calls[1][0].model).toBe('gpt-4o')
    expect(next.id).toBe(first.id)
    expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages)
    expect(next.tasks.map(task => task.model)).toEqual(['gpt-4o-mini', 'gpt-4o'])
  })

  it('复用当前聊天连接/模型；只读取选中正文；确认前不写正式地图', async () => {
    const mainBefore = readFileSync(join(storage.DIRS.chats(), 'char-a', 'session-a.jsonl'), 'utf8')
    const state = await initialize()
    expect(state.tasks.at(-1)?.state).toBe('completed')
    expect(state.scope.worldId).toBeNull()
    expect(await spatialService.loadBound('char-a','session-a')).toBeNull()
    expect(existsSync(join(storage.DIRS.spatial(), 'worlds'))).toBe(false)
    const params = complete.mock.calls[0]![0]
    expect(params.model).toBe('gpt-4o-mini'); expect(params.apiKey).toBe('test-only')
    expect(params.observability?.source).toBe('aux')
    expect(JSON.stringify(params.messages)).not.toContain('隐藏思考')
    expect(JSON.stringify(params.messages)).not.toContain('未选中的雪山开场')
    expect(readFileSync(join(storage.DIRS.chats(), 'char-a', 'session-a.jsonl'), 'utf8')).toBe(mainBefore)
    const proposal = state.proposals[0]!
    const preview = view(proposal.preview!)
    expect(preview.runtime.placements).toHaveLength(1)
    expect(preview.runtime.placements[0]?.semanticPosition.precision).toBe('inside-only')
    const city = preview.world.nodes.find(node => node.name === '青石城')!; const tea = preview.world.nodes.find(node => node.name === '茶馆')!
    expect(tea.geometry.x).toBeGreaterThan(city.geometry.x)
    const confirmed = await ai.apply(scope, proposal.id)
    expect(confirmed.state.id).toBe(state.id)
    expect(confirmed.state.scope.worldId).toBe(confirmed.snapshot.version.worldId)
    expect(confirmed.state.proposals[0]?.status).toBe('applied')
    const repeated = await ai.apply(scope, proposal.id)
    expect(repeated.snapshot.version.runtimeRevision).toBe(confirmed.snapshot.version.runtimeRevision)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(confirmed.state.messages.at(-1)?.role).toBe('system')
  })
  it('初始化草稿支持编辑、去重和重启恢复；编辑不污染正式地图', async () => {
    const state = await initialize(); const proposal = state.proposals[0]!
    const snapshot = view(proposal.preview!)
    const tea = snapshot.world.nodes.find(node => node.name === '茶馆')!
    const input = request(snapshot, [{ type: 'update_node', nodeId: tea.id, patch: { name: '夜茶馆' } }])
    expect(await ai.editDraft(scope, proposal.id, input)).toMatchObject({ ok: true, duplicate: false })
    expect(await ai.editDraft(scope, proposal.id, input)).toMatchObject({ ok: true, duplicate: true })
    expect(await spatialService.loadBound('char-a','session-a')).toBeNull()
    const restarted = createSpatialAiService({ complete })
    expect((await restarted.get(scope)).proposals[0]?.summary.join(' ')).toContain('夜茶馆')
    const result = await restarted.apply(scope, proposal.id)
    expect(view(result.snapshot).world.nodes.some(node => node.name === '夜茶馆')).toBe(true)
  })
  it('四文件事务在 AI 状态写入失败后恢复，重复确认不重复移动', async () => {
    const state = await initialize(); const proposal = state.proposals[0]!
    const original = storage.writeJson
    const spy = vi.spyOn(storage, 'writeJson').mockImplementation((path,...args) => {
      if (path === spatialPaths.ai(state.id)) throw new Error('模拟 AI 状态断电')
      return original(path,...args)
    })
    await expect(ai.apply(scope, proposal.id)).rejects.toThrow('模拟 AI 状态断电')
    spy.mockRestore()
    const recovered = await ai.get(scope)
    expect(recovered.proposals[0]?.status).toBe('applied')
    const snapshot = await spatialService.loadBound('char-a','session-a')
    const repeated = await ai.apply(scope, proposal.id)
    expect(repeated.snapshot.version).toEqual(snapshot?.version)
    expect(readdirSync(join(storage.DIRS.spatial(), 'transactions'))).toHaveLength(0)
  })
  it('绑定空白世界保留名称，共用世界的助手历史及人物位置隔离', async () => {
    const blank = await spatialService.createAndBind('char-a','session-a','手动命名')
    const state = await initialize()
    const confirmed = view((await ai.apply(scope,state.proposals[0]!.id)).snapshot)
    expect(confirmed.world.id).toBe(blank.version.worldId); expect(confirmed.world.name).toBe('手动命名')
    const second = view(await spatialService.bindWorld('char-a','session-b', confirmed.world.id))
    expect(second.runtime.placements).toHaveLength(0)
    const other = await ai.get({ characterId: 'char-a', sessionId: 'session-b' })
    expect(other.id).not.toBe(state.id); expect(other.messages).toHaveLength(0)
    await expect(initialize()).rejects.toThrow('已有地点')
  })
  it('普通指令仅提案；查询不写；旧版本或变更 persona 拒绝确认', async () => {
    const snapshot = await initialized()
    const node = snapshot.world.nodes.find(node => node.name === '青石城')!
    const actor = snapshot.world.actors.find(actor => actor.externalRef.type === 'qingyu-character')!
    complete.mockResolvedValue(completion(JSON.stringify({ schemaVersion:1, explanation:'建议移动', needsClarification:false, operations:[{ type:'move_actor', actorId:actor.id,nodeId:node.id,precision:'inside-only',note:'' }] })))
    const state = await ai.ask(scope, instruction('把林雪移到青石城'))
    const pending = state.proposals.at(-1)!
    expect((await spatialService.loadBound('char-a','session-a'))?.version).toEqual(snapshot.version)
    await spatialService.applyEditorBatch('char-a','session-a', request(snapshot,[{ type:'update_world',patch:{description:'手动变化'} }]))
    await expect(ai.apply(scope,pending.id)).rejects.toThrow('画板已更新')
    const next = await ai.ask(scope, instruction('把林雪移到青石城'))
    await chatData.updateSession('char-a','session-a',{personaId:null})
    await expect(ai.apply(scope,next.proposals.at(-1)!.id)).rejects.toThrow('用户身份已改变')
    complete.mockResolvedValue(completion(JSON.stringify({ schemaVersion:1, explanation:'目前在茶馆', needsClarification:false, operations:[] })))
    const query = await ai.ask(scope,instruction('林雪在哪'))
    expect(query.proposals).toHaveLength(next.proposals.length)
  })
  it('初始化来源变化使旧草稿失效，虚构摘录和未知协议字段被拒绝', async () => {
    const state = await initialize()
    storage.writeJson(join(storage.DIRS.characters(),'char-a.json'),{id:'char-a',name:'林雪',scenario:'林雪在雪山'})
    await expect(ai.apply(scope,state.proposals[0]!.id)).rejects.toThrow('来源正文或设定已改变')
    const core = view(state.proposals[0]!.preview!)
    expect(() => parseSpatialAiReply(JSON.stringify({schemaVersion:1,explanation:'危险',needsClarification:false,operations:[],tools:[]}), 'instruction',core,{character:core.world.actors[0]!.id},[],true)).toThrow('不允许的字段')
  })
  it('内部房间通过子画板入口建立包含关系；重复根画板和跨画板 parentKey 拒绝', async () => {
    const state = await initialize(), preview = view(state.proposals[0]!.preview!)
    const core: SpatialCoreState = { world: { ...preview.world, nodes: preview.world.nodes.filter(node => node.tags.includes('system:offstage')) },
      runtime: createEmptyRuntime(preview.world.id,preview.runtime.runtimeId,Date.now()) }
    const actors = { character: core.world.actors.find(actor => actor.externalRef.type === 'qingyu-character')!.id }
    const sourceText = '青石城中有一栋小屋，小屋内有厨房。林雪现在在厨房。'
    const sources = [{id:'scene',label:'场景',kind:'character' as const,text:sourceText}]
    const proof = [{sourceId:'scene',quote:sourceText}]
    const draft = { worldName:'青石城',description:'',boards:[{key:'house_inside',parentEntryKey:'house',evidence:proof}],nodes:[
      {key:'city',kind:'region',name:'青石城',description:'',parentKey:null,boardKey:'root',evidence:proof},
      {key:'house',kind:'place',name:'小屋',description:'',parentKey:'city',boardKey:'root',evidence:proof},
      {key:'kitchen',kind:'place',name:'厨房',description:'',parentKey:null,boardKey:'house_inside',evidence:proof},
    ],distances:[],placements:[{actor:'character',nodeKey:'kitchen',precision:'inside-only',note:'',evidence:proof}] }
    const raw = (value: typeof draft) => JSON.stringify({schemaVersion:1,explanation:'按场景初始化',needsClarification:false,unresolved:[],draft:value})
    const valid = parseSpatialAiReply(raw(draft),'initialize',core,actors,sources,false).preview!
    expect(() => parseSpatialAiReply(raw(draft),'initialize',core,actors,sources,false,false)).toThrow('不创建子画板')
    const flat = structuredClone(draft); flat.boards = []; flat.nodes[2]!.parentKey = 'house'; flat.nodes[2]!.boardKey = 'root'
    const flatPreview = parseSpatialAiReply(raw(flat),'initialize',core,actors,sources,false,false).preview!
    const flatHouse = flatPreview.world.nodes.find(node => node.name === '小屋')!, flatKitchen = flatPreview.world.nodes.find(node => node.name === '厨房')!
    expect(flatPreview.world.boards).toHaveLength(1)
    expect(flatKitchen.parentNodeId).toBe(flatHouse.id)
    expect(flatKitchen.boardId).toBe(flatHouse.boardId)
    expect(flatKitchen.geometry.y).toBeGreaterThan(flatHouse.geometry.y + 82)
    expect(flatPreview.runtime.placements[0]!.semanticPosition.containmentPath).toEqual(expect.arrayContaining([flatHouse.id,flatKitchen.id]))
    const house = valid.world.nodes.find(node => node.name === '小屋')!, kitchen = valid.world.nodes.find(node => node.name === '厨房')!
    expect(kitchen.parentNodeId).toBeNull()
    expect(valid.world.boards.find(board => board.id === kitchen.boardId)?.parentEntryNodeId).toBe(house.id)
    expect(valid.runtime.placements[0]!.semanticPosition.containmentPath).toEqual(expect.arrayContaining([house.id,kitchen.id]))
    const atHouse = applyCommandBatch(valid,{schemaVersion:1,expectedRevision:valid.runtime.revision,commands:[{type:'move_actor',actorId:actors.character,
      from:{revision:valid.runtime.placements[0]!.revision},to:{boardId:house.boardId,anchor:{kind:'node',nodeId:house.id},semanticPosition:{precision:'inside-only',note:''}}}]},
      {source:'user',now:Date.now(),idGen:randomUUID})
    if (!atHouse.ok) throw new Error(atHouse.message)
    const action = {actorId:actors.character,boardId:kitchen.boardId,targetNodeId:kitchen.id,semanticPosition:{precision:'inside-only',note:''},completed:true,confidence:0.95,evidence:'林雪已经回到厨房',evidenceSource:'assistant'}
    const movementReply = (boardId: string) => JSON.stringify({schemaVersion:1,changes:[{...action,boardId}],unresolved:[]})
    expect(parseSpatialDialogueReply(movementReply(kitchen.boardId),atHouse.state,actors,{user:'继续',assistant:action.evidence},[kitchen.id]).commands).toHaveLength(1)
    expect(() => parseSpatialDialogueReply(movementReply(house.boardId),atHouse.state,actors,{user:'继续',assistant:action.evidence},[kitchen.id])).toThrow('目标地点不在本轮允许清单中')
    const actualId = structuredClone(draft); actualId.placements[0]!.actor = actors.character
    expect(parseSpatialAiReply(raw(actualId),'initialize',core,actors,sources,false).preview!.runtime.placements[0]!.actorId).toBe(actors.character)
    actualId.placements[0]!.actor = 'another-chat-character'
    expect(() => parseSpatialAiReply(raw(actualId),'initialize',core,actors,sources,false)).toThrow('起始人物或地点无效')
    const extraRoot = structuredClone(draft); extraRoot.boards.unshift({key:'root',parentEntryKey:'house',evidence:proof})
    expect(() => parseSpatialAiReply(raw(extraRoot),'initialize',core,actors,sources,false)).toThrow('草稿引用无效或保留')
    const crossed = structuredClone(draft); crossed.nodes[2]!.parentKey = 'house'
    expect(() => parseSpatialAiReply(raw(crossed),'initialize',core,actors,sources,false)).toThrow()
  })
  it('真实请求按本次模式提供协议，初始化与普通移动不混用证据字段', async () => {
    const initialized = await initialize()
    const initPrompt = complete.mock.calls.at(-1)![0].messages[0]!.content
    expect(initPrompt).toContain('当前任务只有 initialize')
    expect(initPrompt).toContain('boards 必须为 []')
    expect(initPrompt).toContain('"parentKey":"house","boardKey":"root"')
    expect(initPrompt).not.toContain('"type":"move_actor"')
    await ai.apply(scope,initialized.proposals[0]!.id)
    complete.mockResolvedValue(completion(JSON.stringify({schemaVersion:1,explanation:'当前状态无变化',needsClarification:false,operations:[]})))
    await ai.ask(scope,instruction('查询位置'))
    const instructionPrompt = complete.mock.calls.at(-1)![0].messages[0]!.content
    expect(instructionPrompt).toContain('当前任务只有 instruction')
    expect(instructionPrompt).not.toContain('"evidence":')
    await ai.ask(scope,{requestId:randomUUID(),mode:'positions',text:''})
    const positionsPrompt = complete.mock.calls.at(-1)![0].messages[0]!.content
    expect(positionsPrompt).toContain('当前任务只有 positions')
    expect(positionsPrompt).toContain('"evidence":')
    expect(positionsPrompt).not.toContain('"type":"create_node"')
  })
  it('正常助手入口拒绝模型新建子画板，旧协议解析能力仍保留', async () => {
    const nested = JSON.parse(reply())
    nested.draft.boards = [{ key: 'inside', parentEntryKey: 'city', evidence }]
    nested.draft.nodes[1].boardKey = 'inside'; nested.draft.nodes[1].parentKey = null
    complete.mockResolvedValue(completion(JSON.stringify(nested)))
    const rejected = await initialize()
    expect(rejected.tasks.at(-1)?.state).toBe('failed')
    expect(rejected.proposals).toHaveLength(0)
    const snapshot = await spatialService.createAndBind(scope.characterId,scope.sessionId,'会话画板')
    complete.mockResolvedValue(completion(JSON.stringify({schemaVersion:1,explanation:'新增',needsClarification:false,operations:[{type:'create_node',key:'house',kind:'place',name:'小屋',childBoard:true}]})))
    const blocked = await ai.ask(scope,instruction('添加小屋'))
    expect(blocked.tasks.at(-1)?.state).toBe('failed')
    expect(blocked.proposals).toHaveLength(0)
    expect((await spatialService.loadBound(scope.characterId,scope.sessionId))?.version).toEqual(snapshot.version)
  })
  it('相同 request ID 不重新调用模型；失败、停止和重启的未知结果不自动重发', async () => {
    const input = {requestId:randomUUID(),mode:'initialize' as const,text:''}
    const first = await ai.ask(scope,input); await ai.ask(scope,input); expect(complete).toHaveBeenCalledTimes(1)
    await expect(ai.ask(scope,{...input,text:'不同'})).rejects.toThrow('请求 ID')
    complete.mockRejectedValue(new Error('模型不可用'))
    const failed = await initialize(); expect(failed.tasks.at(-1)?.state).toBe('failed')
    complete.mockImplementation((_params,signal) => new Promise((_resolve,reject) => signal.addEventListener('abort',()=>reject(new Error('aborted')))))
    const pending = initialize()
    await vi.waitFor(async () => expect((await ai.get(scope)).tasks.at(-1)?.state).toBe('running'))
    const cancelled = await ai.cancel(scope); await pending; expect(cancelled.tasks.at(-1)?.state).toBe('cancelled')
    const disk = JSON.parse(readFileSync(spatialPaths.ai(first.id),'utf8')); disk.tasks.at(-1).state = 'running'; storage.writeJson(spatialPaths.ai(first.id),disk)
    const restored = await createSpatialAiService({complete}).get(scope)
    expect(restored.tasks.at(-1)?.state).toBe('interrupted')
    expect(complete).toHaveBeenCalledTimes(3)
  })
  it('读取不写入；关闭读取绕过缺失 runtime；未放置与 offstage 有区别', async () => {
    const snapshot = await initialized()
    const before = readFileSync(spatialPaths.runtime(scope),'utf8')
    const projected = await spatialContextService.read(scope)
    expect(projected?.text).toContain('茶馆'); expect(projected?.tokens).toBeLessThanOrEqual(800)
    expect(projected?.text).not.toMatch(/geometry|commands|revision|commitId|隐藏思考|operations/)
    expect(readFileSync(spatialPaths.runtime(scope),'utf8')).toBe(before)
    const actor = snapshot.world.actors.find(actor => actor.externalRef.type === 'qingyu-character')!
    const offstage = snapshot.world.nodes.find(node => node.tags.includes('system:offstage'))!
    const changed = await spatialService.applyEditorBatch('char-a','session-a',request(snapshot,[{type:'move_actor',actorId:actor.id,from:{revision:snapshot.runtime.placements[0]!.revision},to:{boardId:offstage.boardId,anchor:{kind:'node',nodeId:offstage.id},semanticPosition:{precision:'inside-only',note:''}}}]))
    expect(changed.ok).toBe(true)
    expect((await spatialContextService.read(scope))?.characterOffstage).toBe(true)
    await chatData.updateSession('char-a','session-a',{spatialContextEnabled:false})
    rmSync(spatialPaths.runtime(scope))
    expect(await spatialContextService.read(scope)).toBeNull()
    const empty = structuredClone(snapshot); empty.runtime.placements = []
    expect(projectSpatialContext(empty,'char-a','persona-a','gpt-4o-mini')).toMatchObject({characterOffstage:false})
  })
  it('当前事实在位置规则和补充关系之后再次明确，未知与未参与不能断言在场', async () => {
    const snapshot = await initialized()
    const actor = snapshot.world.actors.find(item => item.externalRef.type === 'qingyu-character')!
    const city = snapshot.world.nodes.find(item => item.name === '青石城')!
    const tea = snapshot.world.nodes.find(item => item.name === '茶馆')!
    const moved = await spatialService.applyEditorBatch(scope.characterId,scope.sessionId,request(snapshot,[
      {type:'move_actor',actorId:actor.id,to:{boardId:city.boardId,anchor:{kind:'node',nodeId:city.id},semanticPosition:{precision:'inside-only',note:''}}},
    ]))
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    const current = view(moved.snapshot)
    const projected = projectSpatialContext(current,'char-a','persona-a','gpt-4o-mini')
    expect(projected.text.split('\n').at(-1)).toBe('本轮已确认的当前位置："林雪"现在在"青石城"内。"旅人"尚未放置，当前位置未知。')
    expect(projected.minimalText.split('\n').at(-1)).toBe(projected.text.split('\n').at(-1))
    expect(projected.text.split('\n').at(-1)).not.toContain(tea.name)
    expect(projected.tokens).toBeLessThanOrEqual(800)
    const together = structuredClone(current)
    const persona = together.world.actors.find(item => item.externalRef.type === 'qingyu-persona')!
    together.runtime.placements.push({...structuredClone(together.runtime.placements[0]!),actorId:persona.id})
    const supplemented = projectSpatialContext(together,'char-a','persona-a','gpt-4o-mini')
    expect(supplemented.text).toContain('当前两个人物处于同一地点')
    expect(supplemented.text.split('\n').at(-1)).toBe(supplemented.minimalText.split('\n').at(-1))
    const unknown = structuredClone(current)
    unknown.runtime.placements[0]!.semanticPosition.precision = 'unknown'
    expect(projectSpatialContext(unknown,'char-a','persona-a','gpt-4o-mini').text.split('\n').at(-1)).toContain('"林雪"当前位置未知')
    const offstage = current.world.nodes.find(item => item.tags.includes('system:offstage'))!
    const changed = await spatialService.applyEditorBatch(scope.characterId,scope.sessionId,request(current,[
      {type:'move_actor',actorId:actor.id,to:{boardId:offstage.boardId,anchor:{kind:'node',nodeId:offstage.id},semanticPosition:{precision:'inside-only',note:''}}},
    ]))
    expect(changed.ok).toBe(true)
    if (!changed.ok) return
    const offstageText = projectSpatialContext(changed.snapshot,'char-a','persona-a','gpt-4o-mini').text.split('\n').at(-1)!
    expect(offstageText).toContain('"林雪"本轮明确不参与对话')
    expect(offstageText).not.toContain('现在在')
  })
  it('起点建议不重置已有位置；删除会话助手清理不删除共享世界', async () => {
    const snapshot = await initialized()
    const core = view(snapshot); const actor = core.world.actors[0]!
    const node = core.world.nodes.find(node => node.name === '茶馆')!
    expect(() => parseSpatialAiReply(JSON.stringify({schemaVersion:1,explanation:'起点',needsClarification:false,operations:[{type:'move_actor',actorId:actor.id,nodeId:node.id,precision:'inside-only',note:'',evidence}]}),'positions',core,{character:actor.id},[{id:'character:scenario',label:'场景',kind:'character',text:scene}],true)).toThrow('已有位置')
    await ai.deleteScope(scope)
    expect(existsSync(spatialPaths.runtime(scope))).toBe(false)
    expect(existsSync(spatialPaths.world(snapshot.version.worldId))).toBe(true)
    expect(readdirSync(join(storage.DIRS.spatial(),'ai-sessions'))).toHaveLength(0)
    await expect(ai.get(scope)).rejects.toThrow('单聊已删除')
  })
  it('V2 desktop 捕获已确认位置，Android 保持原链路', async () => {
    await initialized()
    const { contextService } = await import('../../chat/contextService')
    const desktop = await contextService.build({ ...scope, content: '你好', clientKind: 'desktop' })
    expect(desktop.spatialContext?.version.runtimeId).toBe('single_session-a')
    expect(desktop.messages.map(message => message.content).join('\n')).toContain('【空间位置 v1】')
    expect(desktop.messages.map(message => message.content).join('\n')).not.toContain('独立的画板助手')
    const android = await contextService.build({ ...scope, content: '你好', clientKind: 'android' })
    expect(android.spatialContext).toBeUndefined()
    expect(android.messages.map(message => message.content).join('\n')).not.toContain('【空间位置 v1】')
  })
  it('伪造初始化证据与未知 actor 被拒绝，不保存可应用提案', async () => {
    const invalid = JSON.parse(reply()); invalid.draft.nodes[0].evidence[0].quote = '根本不存在的摘录'
    complete.mockResolvedValue(completion(JSON.stringify(invalid)))
    const result = await initialize()
    expect(result.tasks.at(-1)?.state).toBe('failed'); expect(result.proposals).toHaveLength(0)
    complete.mockResolvedValue(completion(reply()))
    const snapshot = await initialized()
    expect(() => parseSpatialAiReply(JSON.stringify({schemaVersion:1,explanation:'移动',needsClarification:false,operations:[{type:'move_actor',actorId:'other-person',nodeId:view(snapshot).world.nodes[0]!.id,precision:'inside-only',note:''}]}),'instruction',view(snapshot),{character:view(snapshot).world.actors[0]!.id},[],true)).toThrow('当前聊天角色')
  })
})

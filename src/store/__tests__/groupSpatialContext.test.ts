import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { GroupChat, GroupSession } from '../../../shared/types'
import { finishGroupSpatialBurst } from '../groupSpatialSync'
import type { SpatialGroupContext } from '../../../shared/spatial'
import { getDefaultSettings } from '../../../shared/defaults'
import { useSettingsStore } from '../useSettingsStore'
import { useCharacterStore } from '../useCharacterStore'
import { useGroupChatStore } from '../useGroupChatStore'
import { streamGroupAI, streamGroupAIFree, splitAndSaveMessages, persistPartialGroupReply, cleanupActiveStream, clearPollingTimer, checkPollingContinue } from '../groupStreamController'
import { buildGroupChatContext } from '../groupChatContext'
const group: GroupChat = { id: 'g1', name: '夜谈', memberIds: ['c1','c2'], chatMode: 'mention', currentSpeakerIndex: 0, autoMode: false, maxRounds: 1, speakerInterval: 100, presetId: null, lorebookIds: [], systemPrompt: '', createdAt: 1, updatedAt: 1 }
const session: GroupSession = { id: 's1', groupId: 'g1', title: '会话', spatialBoardEnabled: true, messageCount: 0, narrativeMode: 'immersive', personaId: null, spatialWorldId: 'world', spatialRuntimeId: 'runtime', createdAt: 1, updatedAt: 1 }
const projection = (targetCharacterId?: string): SpatialGroupContext => ({ groupId: 'g1', sessionId: 's1', memberIds: ['c1','c2'], narrativeMode: 'immersive', targetCharacterId, text: '【群聊空间位置 v1】林雪在茶馆。已确认位置优先于旧设定。', minimalText: '【群聊空间位置 v1】林雪在茶馆。', tokens: 60, minimalTokens: 30, snapshotId: 'snapshot', version: { worldId: 'world', runtimeId: 'runtime', bindingEpoch: 'epoch', runtimeRevision: 4, worldFingerprint: 'a'.repeat(64) }, cropped: [], characterOffstage: false, offstageCharacterIds: [] })
beforeEach(async () => {
  await finishGroupSpatialBurst('g1','s1')
  vi.clearAllMocks()
  useSettingsStore.setState({ settings: { ...getDefaultSettings(), activeProfileId: 'profile', activeModel: 'gpt-4o-mini', connectionProfiles: [{ id: 'profile', name: '连接', provider: 'openai', model: 'old-model', apiKey: 'test-only', baseUrl: 'https://test.invalid', maxContext: 32768 }] }, loaded: true })
  useCharacterStore.setState({ characters: ['c1','c2'].map((id,index) => ({ ...useCharacterStore.getState().createCharacter(), id, name: index ? '阿远' : '林雪', scenario: '旧起点在城外' })) })
  useGroupChatStore.setState({ currentGroup: group, currentSessionId: 's1', sessions: [session], messages: [], isStreaming: true, currentStreamingCharId: null, _semanticLoreHits: [], _semanticFactsHits: [] })
  vi.mocked(window.api.spatial.readGroupContext).mockResolvedValue(null)
  vi.mocked(window.api.spatial.prepareGroupDialogue).mockResolvedValue(null)
  vi.mocked(window.api.ai.chat).mockResolvedValue(undefined as never)
  window.api.group.saveMessagesBatch = vi.fn().mockResolvedValue(undefined)
})
afterEach(() => { cleanupActiveStream(); clearPollingTimer() })
describe('群聊发送位置读取边界', () => {
  it.each(['mention','polling','free'] as const)('真实上下文构建 %s 注入语义位置并纳入输入预算', mode => {
    useGroupChatStore.setState({ currentGroup: { ...group, chatMode: mode } })
    const spatialContext = projection(mode === 'free' ? undefined : 'c1')
    const built = buildGroupChatContext(useGroupChatStore.getState, spatialContext.targetCharacterId, null, { spatialContext, trackUsage: false })
    expect(built.messages.map(message => message.content).join('\n')).toContain(spatialContext.text)
    expect(built.messages.map(message => message.content).join('\n')).not.toContain('move_actor')
  })
  it('错误群聊、会话、发言者或成员范围不能进入本轮上下文', () => {
    for (const patch of [{groupId:'other'},{sessionId:'other'},{targetCharacterId:'c2'},{memberIds:['c1']},{narrativeMode:'omniscient' as const},{version:{...projection().version,runtimeId:'other'}}]) expect(() => buildGroupChatContext(useGroupChatStore.getState,'c1',null,{spatialContext:{...projection('c1'),...patch},trackUsage:false})).toThrow('范围已变化')
  })
  it('必要位置超预算明确拒绝发送，补充超预算可退回必要投影', () => {
    const spatialContext = { ...projection('c1'), text: '补充距离'.repeat(30000) }
    const built = buildGroupChatContext(useGroupChatStore.getState,'c1',null,{spatialContext,trackUsage:false})
    expect(built.messages.map(message => message.content).join('\n')).toContain(spatialContext.minimalText)
    expect(() => buildGroupChatContext(useGroupChatStore.getState,'c1',null,{spatialContext:{...spatialContext,minimalText:'必要层级'.repeat(30000)},trackUsage:false})).toThrow('必要的位置')
  })
  it.each(['mention','polling','free'] as const)('发送 %s 在建上下文前获取当前群会话位置，并发送有效模型', async mode => {
    const currentGroup = { ...group,chatMode:mode }; useGroupChatStore.setState({ currentGroup })
    vi.mocked(window.api.spatial.readGroupContext).mockResolvedValue(projection(mode === 'free' ? undefined : 'c1'))
    const speaker = useCharacterStore.getState().characters[0]
    const started = mode === 'free' ? await streamGroupAIFree(useGroupChatStore.setState,useGroupChatStore.getState,currentGroup,'s1',1)
      : await streamGroupAI(useGroupChatStore.setState,useGroupChatStore.getState,currentGroup,'s1',speaker,1,vi.fn())
    expect(started, useGroupChatStore.getState().error ?? '应发送成功').toBe(true)
    expect(window.api.spatial.readGroupContext).toHaveBeenCalledWith(...(mode === 'free' ? ['g1','s1'] : ['g1','s1','c1']))
    expect(window.api.ai.chat).toHaveBeenCalledWith(expect.objectContaining({model:'gpt-4o-mini',baseUrl:'https://test.invalid'}))
    expect(vi.mocked(window.api.ai.chat).mock.calls[0][0].messages.map(message=>message.content).join('\n')).toContain('【群聊空间位置 v1】')
  })
  it('明确不参与的轮询成员跳过请求并继续调度，位置未知仍允许发言', async () => {
    const next = vi.fn(), speaker = useCharacterStore.getState().characters[0]
    vi.mocked(window.api.spatial.readGroupContext).mockResolvedValue({...projection('c1'),characterOffstage:true,offstageCharacterIds:['c1']})
    await streamGroupAI(useGroupChatStore.setState,useGroupChatStore.getState,group,'s1',speaker,1,next)
    expect(window.api.ai.chat).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledTimes(1)
    vi.mocked(window.api.spatial.readGroupContext).mockResolvedValue(projection('c1'))
    await streamGroupAI(useGroupChatStore.setState,useGroupChatStore.getState,group,'s1',speaker,1,vi.fn())
    expect(window.api.ai.chat).toHaveBeenCalledTimes(1)
  })
  it('全部成员明确不参与时自由发言不请求模型', async () => {
    vi.mocked(window.api.spatial.readGroupContext).mockResolvedValue({...projection(),offstageCharacterIds:['c1','c2']})
    await streamGroupAIFree(useGroupChatStore.setState,useGroupChatStore.getState,{...group,chatMode:'free'},'s1',1)
    expect(window.api.ai.chat).not.toHaveBeenCalled()
  })
  it.each(['mention','polling','free'] as const)('全局叙事 %s 在全部成员明确不参与时仍可生成旁白',async mode=>{
    const currentGroup={...group,chatMode:mode}
    useGroupChatStore.setState({currentGroup,sessions:[{...session,narrativeMode:'omniscient'}]})
    vi.mocked(window.api.spatial.readGroupContext).mockResolvedValue({...projection(mode==='free'?undefined:'c1'),narrativeMode:'omniscient',characterOffstage:true,offstageCharacterIds:['c1','c2']})
    const started=mode==='free'?await streamGroupAIFree(useGroupChatStore.setState,useGroupChatStore.getState,currentGroup,'s1',1):await streamGroupAI(useGroupChatStore.setState,useGroupChatStore.getState,currentGroup,'s1',useCharacterStore.getState().characters[0],1,vi.fn())
    expect(started,useGroupChatStore.getState().error??'应允许旁白').toBe(true);expect(window.api.ai.chat).toHaveBeenCalledOnce()
  })
  it('全局自由发言保存完整旁白；全部成员不参与不会删掉旁白',async()=>{
    useGroupChatStore.setState({sessions:[{...session,narrativeMode:'omniscient'}]})
    const saved=await splitAndSaveMessages(useGroupChatStore.setState,useGroupChatStore.getState,{...group,chatMode:'free'},'s1','暮色笼罩了青石城。',1,'narrator',{offstageCharacterIds:['c1','c2']})
    expect(saved).toHaveLength(1);expect(saved[0].content).toBe('暮色笼罩了青石城。')
    expect(window.api.group.saveMessage).toHaveBeenCalledOnce()
  })
  it('全局轮询接力保留焦点成员，不因参与标记误判无人可叙述',async()=>{
    const currentGroup={...group,chatMode:'polling' as const,autoMode:true,maxRounds:3}
    useGroupChatStore.setState({currentGroup,isStreaming:false,sessions:[{...session,narrativeMode:'omniscient'}],messages:['c1','c2'].map((characterId,i)=>({id:'body-'+i,groupId:'g1',characterId,content:'旁白',images:[],timestamp:i+1,round:i+1}))})
    vi.mocked(window.api.spatial.readGroupContext).mockResolvedValue({...projection(),narrativeMode:'omniscient',offstageCharacterIds:['c1','c2']})
    expect(await checkPollingContinue(useGroupChatStore.setState,useGroupChatStore.getState,currentGroup)).toBe(true)
  })
  it('自由发言拆分不会保存明确不参与成员的回应', async () => {
    const messages = await splitAndSaveMessages(useGroupChatStore.setState,useGroupChatStore.getState,{...group,chatMode:'free'},'s1','【林雪】在茶馆等候\n【阿远】已退出对话',1,'placeholder',{offstageCharacterIds:['c2']})
    expect(messages).toHaveLength(1); expect(messages[0].characterId).toBe('c1')
    expect(window.api.group.saveMessagesBatch).not.toHaveBeenCalled()
  })
  it('自由发言半截正文保存也保留发送时的参与范围', async () => {
    await persistPartialGroupReply({set:useGroupChatStore.setState,get:useGroupChatStore.getState,group:{...group,chatMode:'free'},sessionId:'s1',msgId:'partial',content:'【林雪】在茶馆等候\n【阿远】已退出对话',round:1,characterId:'__free__',isFree:true,narrativeMode:'immersive',offstageCharacterIds:['c2']})
    expect(window.api.group.saveMessage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(window.api.group.saveMessage).mock.calls[0][2]).toMatchObject({characterId:'c1'})
  })
  it('位置读取失败会明确阻止发送', async () => {
    vi.mocked(window.api.spatial.readGroupContext).mockRejectedValue(new Error('画板位置文件损坏'))
    await streamGroupAI(useGroupChatStore.setState,useGroupChatStore.getState,group,'s1',useCharacterStore.getState().characters[0],1,vi.fn())
    expect(window.api.ai.chat).not.toHaveBeenCalled(); expect(useGroupChatStore.getState().isStreaming).toBe(false)
  })
})


describe('群聊阶段 2：正文保存与批次完成接线', () => {
  async function start(mode: GroupChat['chatMode']='mention') {
    const currentGroup={...group,chatMode:mode,autoMode:mode==='polling'}
    useGroupChatStore.setState({currentGroup})
    vi.mocked(window.api.spatial.readGroupContext).mockResolvedValue(projection(mode==='free'?undefined:'c1'))
    vi.mocked(window.api.spatial.prepareGroupDialogue).mockImplementation(async (_group,_session,input)=>input.burstId)
    if(mode==='free')await streamGroupAIFree(useGroupChatStore.setState,useGroupChatStore.getState,currentGroup,'s1',1)
    else await streamGroupAI(useGroupChatStore.setState,useGroupChatStore.getState,currentGroup,'s1',useCharacterStore.getState().characters[0],1,vi.fn())
    return vi.mocked(window.api.ai.chat).mock.calls.at(-1)![0].requestId
  }
  async function completeBody(requestId: string, text: string, finishReason:'stop'|'length'='stop') {
    vi.mocked(window.api.ai.onChunk).mock.calls.at(-1)![0]({requestId,text})
    vi.mocked(window.api.ai.onComplete).mock.calls.at(-1)![0]({requestId,finishReason})
    await vi.waitFor(()=>expect(useGroupChatStore.getState().isStreaming).toBe(false))
  }
  it.each(['mention','free'] as const)('%s 完整正文落盘后只登记一次，闭合一批', async mode => {
    const id=await start(mode);expect(window.api.spatial.prepareGroupDialogue).toHaveBeenCalledWith('g1','s1',expect.objectContaining({generationId:id,expectedVersion:projection().version}))
    await completeBody(id,mode==='free'?'【林雪】已经到达渡口。\n【阿远】仍在茶馆。':'林雪已经到达渡口。')
    await vi.waitFor(()=>expect(window.api.spatial.closeGroupDialogueBatch).toHaveBeenCalledTimes(1))
    expect(window.api.spatial.groupDialogueSaved).toHaveBeenCalledTimes(1)
    const ids=vi.mocked(window.api.spatial.groupDialogueSaved).mock.calls[0][3];expect(ids).toHaveLength(mode==='free'?2:1)
    const saved=mode==='free'?vi.mocked(window.api.group.saveMessagesBatch).mock.calls[0][2]:[vi.mocked(window.api.group.saveMessage).mock.calls[0][2]]
    expect(saved.every(message=>message.spatialGroupGenerationId===id)).toBe(true)
  })
  it('轮询两个完整请求使用同一批次，交还用户前不关闭', async () => {
    const first=await start('polling');await completeBody(first,'林雪已经到达渡口。')
    await vi.waitFor(()=>expect(window.api.spatial.groupDialogueSaved).toHaveBeenCalledTimes(1))
    const second=await start('polling');await completeBody(second,'林雪仍在渡口。')
    await vi.waitFor(()=>expect(window.api.spatial.groupDialogueSaved).toHaveBeenCalledTimes(2))
    expect(window.api.spatial.closeGroupDialogueBatch).not.toHaveBeenCalled()
    const captures=vi.mocked(window.api.spatial.prepareGroupDialogue).mock.calls
    expect(captures[0][2].burstId).toBe(captures[1][2].burstId)
    await finishGroupSpatialBurst('g1','s1');expect(window.api.spatial.closeGroupDialogueBatch).toHaveBeenCalledTimes(1)
  })
  it('消息保存失败不登记，不使正文重发', async () => {
    const id=await start();vi.mocked(window.api.group.saveMessage).mockRejectedValueOnce(new Error('磁盘写入失败'))
    await completeBody(id,'林雪已经到达渡口。')
    await vi.waitFor(()=>expect(window.api.spatial.closeGroupDialogueBatch).toHaveBeenCalledTimes(1))
    expect(window.api.spatial.groupDialogueSaved).not.toHaveBeenCalled();expect(window.api.ai.chat).toHaveBeenCalledTimes(1)
  })
  it('停止轮询关闭此前批次，半截内容不登记', async () => {
    const first=await start('polling');await completeBody(first,'林雪已经到达渡口。');await vi.waitFor(()=>expect(window.api.spatial.groupDialogueSaved).toHaveBeenCalledTimes(1))
    const second=await start('polling');vi.mocked(window.api.ai.onChunk).mock.calls.at(-1)![0]({requestId:second,text:'林雪走到一半'})
    useGroupChatStore.getState().stopStreaming()
    await vi.waitFor(()=>expect(window.api.spatial.closeGroupDialogueBatch).toHaveBeenCalledTimes(1))
    expect(window.api.spatial.groupDialogueSaved).toHaveBeenCalledTimes(1)
  })
  it('登记失败只反馈画板问题，正文不会重新生成', async () => {
    const id=await start();vi.mocked(window.api.spatial.groupDialogueSaved).mockRejectedValueOnce(new Error('检查点失败'))
    await completeBody(id,'林雪已经到达渡口。')
    await vi.waitFor(()=>expect(window.api.spatial.closeGroupDialogueBatch).toHaveBeenCalledTimes(1));expect(window.api.ai.chat).toHaveBeenCalledTimes(1)
  })
})

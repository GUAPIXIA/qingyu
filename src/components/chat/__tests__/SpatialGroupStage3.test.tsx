import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SpatialSuggestionNotice } from '../SpatialSuggestionNotice'
import { SpatialAiPanel } from '../SpatialAiPanel'
import { useGroupChatStore } from '../../../store/useGroupChatStore'
import type { SpatialAiProposal, SpatialGroupAiSession } from '../../../../shared/spatial-ai'

const proposal = (): SpatialAiProposal => ({id:'story',commitId:'commit',mode:'dialogue_sync',dialogueId:'batch',status:'pending',explanation:'位置建议',summary:[],unresolved:['旧桥未收录'],sources:[],evidence:[],sourceOptions:{text:'',loreEntryIds:[]},sourceFingerprint:'hash',personaId:null,baseVersion:null,commands:[],createdAt:1,dialogueCandidates:[{id:'candidate',actorId:'actor',targetText:'旧桥',completed:true,eligible:true,evidenceSource:'assistant',evidence:'阿远已到旧桥',note:'',reason:'地图未收录'}]})
const state = (proposals=[proposal()], groupId='group-a'): SpatialGroupAiSession => ({schemaVersion:1,id:'ai-'+groupId,scope:{kind:'group',groupId,sessionId:'session',worldId:'world',runtimeId:'runtime',bindingEpoch:'epoch'},proposals,messages:[],tasks:[],createdAt:1,updatedAt:1})
const snapshot = {world:{},runtime:{},version:{worldId:'world',runtimeId:'runtime',bindingEpoch:'epoch',runtimeRevision:3,worldFingerprint:'hash'}}
const panel = () => render(<SpatialAiPanel groupId="group-a" sessionId="session" open bound previewId={null} flush={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} onPreview={vi.fn()} onApplied={vi.fn()} onDiscard={vi.fn().mockResolvedValue(undefined)} />)
beforeEach(()=>{
  vi.clearAllMocks()
  useGroupChatStore.setState({currentGroup:{id:'group-a',memberIds:['char-a','char-b']} as never,currentSessionId:'session',sessions:[{id:'session',groupId:'group-a',spatialWorldId:'world'} as never]})
  vi.mocked(window.api.spatial.getGroupAiSession).mockResolvedValue(state())
  vi.mocked(window.api.spatial.groupInitializationSources).mockResolvedValue({sources:[],members:[],loreEntries:[],canInitialize:false,sharedSessions:1})
  vi.mocked(window.api.spatial.groupProposalTargets).mockResolvedValue([{id:'city',boardId:'root',path:'青石城',canContain:true},{id:'dock',boardId:'root',path:'青石城 / 渡口',canContain:false}])
})
describe('群聊阶段 3：紧凑提示与独立核对',()=>{
  it('简短入口只读取当前群聊；没有单聊应用并发送入口',async()=>{
    let update!: Parameters<typeof window.api.spatial.onAiUpdated>[0]
    vi.mocked(window.api.spatial.onAiUpdated).mockImplementation(listener=>{update=listener;return vi.fn()})
    const open=vi.fn()
    render(<SpatialSuggestionNotice groupId="group-a" sessionId="session" worldId="world" enabled onOpen={open} canSend onApplyAndSend={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button',{name:'查看画板建议'}))
    expect(open).toHaveBeenCalledOnce();expect(screen.queryByRole('button',{name:'应用并发送'})).toBeNull()
    act(()=>update({kind:'group',groupId:'group-b',sessionId:'session'}))
    act(()=>update({characterId:'char-a',sessionId:'session'}))
    expect(window.api.spatial.getGroupAiSession).toHaveBeenCalledTimes(1);expect(window.api.spatial.getAiSession).not.toHaveBeenCalled()
  })
  it('切换群聊丢弃旧建议和迟到错误',async()=>{
    let reject!: (reason:Error)=>void
    vi.mocked(window.api.spatial.getGroupAiSession).mockImplementation(g=>g==='group-a'?new Promise((_resolve,rejected)=>{reject=rejected}):Promise.resolve(state([],'group-b')))
    const view=render(<SpatialSuggestionNotice groupId="group-a" sessionId="session" worldId="world" enabled onOpen={vi.fn()} />)
    await waitFor(()=>expect(reject).toBeDefined())
    view.rerender(<SpatialSuggestionNotice groupId="group-b" sessionId="session" worldId="world" enabled onOpen={vi.fn()} />)
    await act(async()=>{reject(new Error('旧群聊已删除'))})
    expect(screen.queryByRole('status')).toBeNull()
  })
  it.each([
    ['running','正在提取本轮位置'],['failed','位置提取未完成'],['applied','本轮位置已确认'],['changed','已应用位置的来源已变化'],['stale','位置建议已失效'],
  ])('%s 用一行提示保留已确认位置',async(kind,text)=>{
    const next=state([])
    if(kind==='running'||kind==='failed')next.tasks.push({id:'task',mode:'dialogue_sync',requestHash:'hash',state:kind as 'running'|'failed',startedAt:1})
    else next.proposals.push({...proposal(),status:kind==='stale'?'stale':'applied',canReview:false,sourceChanged:kind==='changed'})
    vi.mocked(window.api.spatial.getGroupAiSession).mockResolvedValue(next)
    render(<SpatialSuggestionNotice groupId="group-a" sessionId="session" worldId="world" enabled onOpen={vi.fn()} />)
    expect(await screen.findByRole('status')).toHaveTextContent(text)
  })
  it('选完整路径后独立重新核对，再确认移动；不调用模型或单聊接口',async()=>{
    const reviewed={...proposal(),id:'reviewed',reviewedFromId:'story',commands:[{}],unresolved:[],dialogueCandidates:[],baseVersion:snapshot.version,comparisons:[{actorName:'阿远',currentPath:'青石城 / 茶馆',targetPath:'青石城 / 渡口'}]} as SpatialAiProposal
    vi.mocked(window.api.spatial.reviewGroupProposal).mockImplementation(async()=>{const next=state([reviewed]);vi.mocked(window.api.spatial.getGroupAiSession).mockResolvedValue(next);return next})
    vi.mocked(window.api.spatial.applyGroupProposal).mockImplementation(async()=>{const next=state([{...reviewed,status:'applied'}]);vi.mocked(window.api.spatial.getGroupAiSession).mockResolvedValue(next);return {state:next,snapshot}})
    panel();fireEvent.change(await screen.findByRole('combobox',{name:'选择已有地点：旧桥'}),{target:{value:'dock'}})
    fireEvent.click(screen.getByRole('button',{name:'重新核对'}));await screen.findByRole('button',{name:'确认移动'})
    expect(window.api.spatial.reviewGroupProposal).toHaveBeenCalledWith('group-a','session','story',{targets:{candidate:'dock'}})
    expect(window.api.spatial.applyGroupProposal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button',{name:'确认移动'}));await waitFor(()=>expect(window.api.spatial.applyGroupProposal).toHaveBeenCalledWith('group-a','session','reviewed',false))
    expect(window.api.spatial.reviewProposal).not.toHaveBeenCalled();expect(window.api.spatial.askGroupAi).not.toHaveBeenCalled()
  })
  it('创建未知地点先预览单独提案，未自动移动或调用模型',async()=>{
    vi.mocked(window.api.spatial.prepareGroupPlace).mockResolvedValue(state())
    panel();fireEvent.click(await screen.findByRole('button',{name:'创建地点'}))
    fireEvent.change(screen.getByRole('combobox',{name:'新地点上级'}),{target:{value:'city'}})
    fireEvent.click(screen.getByRole('button',{name:'预览地点创建'}))
    await waitFor(()=>expect(window.api.spatial.prepareGroupPlace).toHaveBeenCalledWith('group-a','session','story','旧桥','city'))
    expect(window.api.spatial.applyGroupProposal).not.toHaveBeenCalled();expect(window.api.spatial.preparePlace).not.toHaveBeenCalled();expect(window.api.spatial.askGroupAi).not.toHaveBeenCalled()
  })
  it('忽略后续建议仍可查看此前已应用的剧情；替代记录不再重复提醒',async()=>{
    vi.mocked(window.api.spatial.getGroupAiSession).mockResolvedValue(state([{...proposal(),status:'applied'},{...proposal(),id:'old',status:'stale',replacedById:'reviewed'},{...proposal(),id:'reviewed',status:'discarded'}]))
    render(<SpatialSuggestionNotice groupId="group-a" sessionId="session" worldId="world" enabled onOpen={vi.fn()} />)
    await screen.findByRole('button',{name:'查看或撤销'})
    expect(screen.queryByText(/条位置建议待核对/)).toBeNull()
  })
  it('建议中的地点已被删除时仍能重新选择当前完整路径',async()=>{
    const next=proposal();next.status='stale';next.canReview=true;next.dialogueCandidates![0].targetNodeId='removed'
    vi.mocked(window.api.spatial.getGroupAiSession).mockResolvedValue(state([next]))
    panel();await screen.findByRole('combobox',{name:'选择已有地点：旧桥'})
    expect(screen.getByRole('option',{name:'青石城 / 渡口'})).toBeTruthy()
    expect(screen.getByRole('button',{name:'创建地点'})).toBeEnabled()
  })
})

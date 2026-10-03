import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SpatialAiPanel } from '../SpatialAiPanel'
import { useGroupChatStore } from '../../../store/useGroupChatStore'
import type { SpatialGroupAiSession } from '../../../../shared/spatial-ai'
const state = (groupId = 'group-a'): SpatialGroupAiSession => ({ schemaVersion: 1, id: `ai-${groupId}`, scope: { kind: 'group', groupId, sessionId: 'session-a', worldId: null, runtimeId: null, bindingEpoch: null }, messages: [], tasks: [], proposals: [], createdAt: 1, updatedAt: 1 })
const props = { groupId: 'group-a', sessionId: 'session-a', open: true, bound: false, previewId: null, onClose: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), onPreview: vi.fn(), onApplied: vi.fn(), onDiscard: vi.fn().mockResolvedValue(undefined) }
beforeEach(() => {
  vi.clearAllMocks()
  useGroupChatStore.setState({ currentGroup: {id:'group-a',memberIds:['char-a','char-b']} as never, currentSessionId: 'session-a', sessions: [{id:'session-a',groupId:'group-a'} as never] })
  vi.mocked(window.api.spatial.getGroupAiSession).mockResolvedValue(state())
  vi.mocked(window.api.spatial.groupInitializationSources).mockResolvedValue({ sources: [], members: [{id:'char-a',name:'林雪'},{id:'char-b',name:'阿远'}], loreEntries: [], canInitialize: true, sharedSessions: 0 })
  vi.mocked(window.api.spatial.onAiUpdated).mockReturnValue(() => {})
  vi.mocked(window.api.spatial.onUpdated).mockReturnValue(() => {})
})
describe('群聊独立画板助手界面', () => {
  it.each(['running', 'completed'] as const)('新的群聊初始化 %s 时隐藏旧失败提示', async (taskState) => {
    const next = state()
    next.tasks.push(
      { id: 'old', requestHash: 'old', mode: 'initialize', state: 'failed', error: '旧的子画板错误', startedAt: 1 },
      { id: 'new', requestHash: 'new', mode: 'initialize', state: taskState, startedAt: 2 },
    )
    vi.mocked(window.api.spatial.getGroupAiSession).mockResolvedValue(next)
    render(<SpatialAiPanel {...props} />)
    await screen.findByText('初始化来源 · 0 项')
    expect(screen.queryByText(/旧的子画板错误/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('同批次重试成功后不再显示旧失败或重复重试入口', async () => {
    const next = state(); next.tasks.push({id:'failed',requestHash:'hash',mode:'dialogue_sync',dialogueId:'batch',state:'failed',error:'timeout',startedAt:1},{id:'retry',requestHash:'hash',mode:'dialogue_sync',dialogueId:'batch',state:'completed',startedAt:2})
    vi.mocked(window.api.spatial.getGroupAiSession).mockResolvedValue(next)
    render(<SpatialAiPanel {...props} />); await screen.findByText('初始化来源 · 0 项')
    expect(screen.queryByRole('button',{name:'重新提取本轮剧情'})).toBeNull(); expect(screen.queryByText(/timeout/)).toBeNull()
  })
  it('群聊剧情同步只提供关闭和需确认，开关写入当前群会话', async () => {
    render(<SpatialAiPanel {...props} bound={true} />); await screen.findByText('初始化来源 · 0 项')
    fireEvent.click(screen.getByText('同步设置'))
    fireEvent.change(screen.getByRole('combobox',{name:'剧情同步策略'}),{target:{value:'suggest'}})
    await waitFor(()=>expect(useGroupChatStore.getState().sessions[0].spatialNarrativeSyncPolicy).toBe('suggest'))
    expect(window.api.group.updateSession).toHaveBeenCalledWith('group-a','session-a',{spatialNarrativeSyncPolicy:'suggest'})
    expect(screen.queryByRole('option',{name:'自动'})).toBeNull(); expect(window.api.chat.updateSession).not.toHaveBeenCalled()
  })
  it('群聊已应用剧情显示结果，二次确认通过群聊撤销接口', async () => {
    const next = state(); next.proposals.push({id:'story',commitId:'commit',mode:'dialogue_sync',status:'applied',explanation:'剧情建议',summary:['阿远 → 渡口'],unresolved:[],evidence:[],baseVersion:null,personaId:null,sourceFingerprint:'source',sources:[],sourceOptions:{text:'',loreEntryIds:[]},commands:[],createdAt:1})
    vi.mocked(window.api.spatial.getGroupAiSession).mockResolvedValue(next)
    render(<SpatialAiPanel {...props} />); await screen.findByText('已应用：阿远 → 渡口')
    vi.mocked(window.api.spatial.undoGroupProposal).mockResolvedValue({state:{...next,proposals:[{...next.proposals[0],status:'undone'}]},snapshot:{version:{}}} as never)
    fireEvent.click(screen.getByRole('button',{name:'撤销此次剧情更新'}))
    expect(window.api.spatial.undoGroupProposal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button',{name:'确认撤销此次更新'}))
    await waitFor(()=>expect(window.api.spatial.undoGroupProposal).toHaveBeenCalledWith('group-a','session-a','story'))
    expect(window.api.spatial.undoProposal).not.toHaveBeenCalled()
  })
  it('只调用当前群会话助手，选定成员来源进入初始化请求', async () => {
    const next = state()
    vi.mocked(window.api.spatial.askGroupAi).mockResolvedValue(next)
    render(<SpatialAiPanel {...props} />)
    await screen.findByText('初始化来源 · 0 项'); fireEvent.click(screen.getByText('初始化来源 · 0 项'))
    fireEvent.click(screen.getByRole('checkbox',{name:'阿远 · 成员设定'}))
    fireEvent.click(screen.getByRole('button',{name:'生成场景'}))
    await waitFor(()=>expect(window.api.spatial.askGroupAi).toHaveBeenCalledWith('group-a','session-a',expect.objectContaining({mode:'initialize',memberIds:['char-a']})))
    expect(window.api.spatial.getAiSession).not.toHaveBeenCalled(); expect(window.api.spatial.askAi).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('同步设置'))
    expect(screen.getByRole('combobox',{name:'剧情同步策略'})).toHaveValue('off'); expect(screen.queryByRole('option',{name:'自动'})).toBeNull()
  })
  it('位置读取开关写入群聊会话并更新本地状态', async () => {
    render(<SpatialAiPanel {...props} />); await screen.findByText('初始化来源 · 0 项')
    fireEvent.click(screen.getByText('同步设置'))
    fireEvent.click(screen.getByRole('checkbox',{name:'对话读取位置'}))
    await waitFor(()=>expect(useGroupChatStore.getState().sessions[0].spatialContextEnabled).toBe(false))
    expect(window.api.group.updateSession).toHaveBeenCalledWith('group-a','session-a',{spatialContextEnabled:false})
    expect(window.api.chat.updateSession).not.toHaveBeenCalled()
  })
  it('切换群聊后，旧助手读取错误不进入新群界面', async () => {
    let reject!: (reason: Error) => void
    vi.mocked(window.api.spatial.getGroupAiSession).mockImplementation(groupId=>groupId==='group-a'?new Promise((_resolve,rejected)=>{reject=rejected}):Promise.resolve(state(groupId)))
    const {rerender} = render(<SpatialAiPanel {...props} />)
    await waitFor(()=>expect(window.api.spatial.getGroupAiSession).toHaveBeenCalledWith('group-a','session-a'))
    rerender(<SpatialAiPanel {...props} groupId="group-b" />)
    await screen.findByText('初始化来源 · 0 项')
    await act(async()=>{reject(new Error('旧群聊已删除'))})
    expect(screen.queryByText('旧群聊已删除')).toBeNull()
  })
  it('已失效的初始化草稿可忽略，不能确认或继续编辑', async () => {
    const next = state(); next.proposals.push({id:'proposal',commitId:'commit',mode:'initialize',status:'stale',staleReason:'成员已变化',explanation:'草稿',summary:[],unresolved:[],evidence:[],baseVersion:null,personaId:null,sourceFingerprint:'source',sources:[],sourceOptions:{text:'',loreEntryIds:[]},commands:[],preview:{world:{},runtime:{},version:{worldId:'world',runtimeId:'runtime',bindingEpoch:'epoch',runtimeRevision:1,worldFingerprint:'a'.repeat(64)}},createdAt:1})
    vi.mocked(window.api.spatial.getGroupAiSession).mockResolvedValue(next)
    vi.mocked(window.api.spatial.discardGroupProposal).mockResolvedValue({...next,proposals:[]})
    render(<SpatialAiPanel {...props} />)
    await screen.findByText('成员已变化')
    expect(screen.getByRole('button',{name:'确认场景'})).toBeDisabled(); expect(screen.getByRole('button',{name:'预览并修改'})).toBeDisabled()
    fireEvent.click(screen.getByRole('button',{name:'忽略'}))
    await waitFor(()=>expect(window.api.spatial.discardGroupProposal).toHaveBeenCalledWith('group-a','session-a','proposal'))
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SpatialAiProposal, SpatialAiSession } from '../../../../shared/spatial-ai'
import { SpatialAiPanel } from '../SpatialAiPanel'
import { SpatialSuggestionNotice } from '../SpatialSuggestionNotice'
import { useChatStore } from '../../../store/useChatStore'

const proposal = (): SpatialAiProposal => ({ id: 'proposal', commitId: 'commit', dialogueId: 'turn', mode: 'dialogue_sync', status: 'pending', explanation: '位置建议',
  summary: [], unresolved: ['渡口：地图未收录'], evidence: [{ sourceId: 'assistant', quote: '林雪已到达渡口' }], sources: [{ id: 'assistant', label: '已保存正文', kind: 'message', text: '林雪已到达渡口' }],
  sourceOptions: { text: '', loreEntryIds: [] }, sourceFingerprint: 'hash', personaId: null, baseVersion: null, commands: [], createdAt: 1,
  dialogueCandidates: [{ id: 'candidate', actorId: 'actor', targetText: '渡口', completed: true, eligible: true, evidence: '林雪已到达渡口', evidenceSource: 'assistant', note: '', reason: '地图未收录' }] })
const session = (proposals: SpatialAiProposal[] = [proposal()]): SpatialAiSession => ({ schemaVersion: 1, id: 'ai', scope: { characterId: 'char', sessionId: 'chat', worldId: 'world', runtimeId: 'runtime', bindingEpoch: 'epoch' }, proposals, messages: [], tasks: [], createdAt: 1, updatedAt: 1 })
const snapshot = { world: {}, runtime: {}, version: { worldId: 'world', runtimeId: 'runtime', bindingEpoch: 'epoch', runtimeRevision: 2, worldFingerprint: 'hash' } }
function panel() { return render(<SpatialAiPanel characterId="char" sessionId="chat" open bound previewId={null} onClose={vi.fn()} flush={vi.fn().mockResolvedValue(undefined)} onPreview={vi.fn()} onApplied={vi.fn()} onDiscard={vi.fn().mockResolvedValue(undefined)} />) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(session())
  vi.mocked(window.api.spatial.initializationSources).mockResolvedValue({ sources: [], loreEntries: [], canInitialize: false, sharedSessions: 1 })
  vi.mocked(window.api.spatial.proposalTargets).mockResolvedValue([{ id: 'node', boardId: 'root', path: '青石城 / 渡口', canContain: false }])
  useChatStore.setState({ sessions: [{ id: 'chat', characterId: 'char', spatialBoardEnabled: true, spatialWorldId: 'world', createdAt: 1, updatedAt: 1, title: '单聊', messageCount: 1, lastMessage: '', memoryEnabled: false, memoryMode: 'manual', autoMemoryInterval: 20, memory: '', memoryUpdatedAt: 0 }] })
})

describe('空间阶段 3：紧凑交互', () => {
  it('长会话默认只显示最近结果，历史、重复消息与用量折叠，展开仍可撤销旧更新', async () => {
    const results = Array.from({length:4},(_,index) => ({...proposal(),id:`result-${index}`,status:'applied' as const,unresolved:[],summary:[`林雪 → 地点${index}`],automatic:{status:'applied' as const}}))
    const saved = session(results)
    saved.messages = Array.from({length:20},(_,index) => ({id:`message-${index}`,role:'assistant' as const,mode:'dialogue_sync' as const,content:`本轮剧情重复说明${index}`,createdAt:index}))
    saved.tasks = [{id:'done',requestHash:'hash',mode:'dialogue_sync',state:'completed',startedAt:1,model:'测试模型',inputTokens:100,outputTokens:200}]
    vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(saved)
    panel()
    expect(await screen.findByText('已自动应用：林雪 → 地点3')).toBeVisible()
    expect(screen.getByText('已自动应用：林雪 → 地点0')).not.toBeVisible()
    expect(screen.getByText('本轮剧情重复说明19')).not.toBeVisible()
    expect(screen.getByText('测试模型 · 输入 100 / 输出 200 tokens')).not.toBeVisible()
    const undoButtons = screen.getAllByRole('button',{name:'撤销此次剧情更新'})
    expect(undoButtons[0]).toBeVisible()
    undoButtons.slice(1).forEach(button => expect(button).not.toBeVisible())
    expect(screen.getByRole('textbox',{name:'画板助手输入'})).toHaveAttribute('rows','2')
    fireEvent.click(screen.getByText('历史与详情'))
    expect(screen.getByText('本轮剧情重复说明19')).toBeVisible()
    const oldResult = screen.getByText('已自动应用：林雪 → 地点0').parentElement!
    fireEvent.click(within(oldResult).getByRole('button',{name:'撤销此次剧情更新'}))
    expect(within(oldResult).getByRole('button',{name:'确认撤销此次更新'})).toBeVisible()
  })

  it('当前查询答复直接可见，旧消息和同步设置默认折叠', async () => {
    const saved = session([])
    saved.messages = [
      {id:'old',role:'user',mode:'instruction',content:'之前的助手指令',createdAt:1},
      {id:'current',role:'assistant',mode:'instruction',content:'林雪现在位于茶馆。',createdAt:2},
    ]
    vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(saved)
    panel()
    expect(await screen.findByText('林雪现在位于茶馆。')).toBeVisible()
    expect(screen.getByText('之前的助手指令')).not.toBeVisible()
    expect(screen.getByRole('combobox',{name:'剧情同步策略'})).not.toBeVisible()
    fireEvent.click(screen.getByText('同步设置'))
    expect(screen.getByRole('combobox',{name:'剧情同步策略'})).toBeVisible()
  })

  it.each(['initialize', 'instruction'] as const)('%s 成功后不再把保存的旧子画板限制显示为当前错误', async (mode) => {
    const next = session([])
    next.tasks.push(
      { id: 'old-init', requestHash: 'old', mode: 'initialize', state: 'failed', error: '内部空间请使用子画板或区域', startedAt: 1 },
      { id: 'new-init', requestHash: 'new', mode, state: 'completed', startedAt: 2 },
      { id: 'story', requestHash: 'story', mode: 'dialogue_sync', dialogueId: 'turn', state: 'completed', startedAt: 3 },
    )
    vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(next)
    panel()
    await screen.findByText('初始化来源 · 0 项')
    expect(screen.queryByText(/内部空间请使用子画板或区域/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(next.tasks[0].state).toBe('failed')
  })

  it('新手动请求取代旧错误，但无关剧情请求不会掩盖最近的手动失败', async () => {
    const next = session([])
    next.tasks.push(
      { id: 'old', requestHash: 'old', mode: 'initialize', state: 'failed', error: '过时的初始化错误', startedAt: 1 },
      { id: 'new', requestHash: 'new', mode: 'instruction', state: 'failed', error: '当前编辑失败', startedAt: 2 },
      { id: 'story', requestHash: 'story', mode: 'dialogue_sync', dialogueId: 'turn', state: 'completed', startedAt: 3 },
    )
    vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(next)
    panel()
    await screen.findByText(/当前编辑失败/)
    expect(screen.queryByText(/过时的初始化错误/)).toBeNull()
  })

  it('主聊天只有简短入口；其他单聊更新不触发读取，切换后迟到结果不串提示', async () => {
    let update!: (event: { characterId: string; sessionId: string }) => void
    vi.mocked(window.api.spatial.onAiUpdated).mockImplementation(listener => { update = listener; return vi.fn() })
    const open = vi.fn(), page = render(<SpatialSuggestionNotice characterId="char" sessionId="chat" worldId="world" enabled onOpen={open} />)
    fireEvent.click(await screen.findByRole('button', { name: '查看画板建议' }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByText('1 条位置建议待核对 · 继续发送将使用已确认位置')).toBeTruthy()
    act(() => update({ characterId: 'other', sessionId: 'chat' }))
    expect(window.api.spatial.getAiSession).toHaveBeenCalledTimes(1)
    let resolve!: (state: SpatialAiSession) => void
    vi.mocked(window.api.spatial.getAiSession).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    act(() => update({ characterId: 'char', sessionId: 'chat' }))
    vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(session([]))
    page.rerender(<SpatialSuggestionNotice characterId="char" sessionId="next" worldId="world" enabled onOpen={open} />)
    await act(async () => { resolve(session()); await Promise.resolve() })
    expect(screen.queryByRole('button', { name: '查看画板建议' })).toBeNull()
  })
  it('选择完整地点路径后先重新核对，再次点击确认移动才提交', async () => {
    const reviewed = { ...proposal(), id: 'reviewed', reviewedFromId: 'proposal', unresolved: [], commands: [{}],
      baseVersion: snapshot.version, dialogueCandidates: [], comparisons: [{ actorName: '林雪', currentPath: '青石城 / 茶馆', targetPath: '青石城 / 渡口' }] }
    vi.mocked(window.api.spatial.reviewProposal).mockImplementation(async () => { const next = session([reviewed]); vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(next); return next })
    vi.mocked(window.api.spatial.applyProposal).mockImplementation(async () => { const next = session([{ ...reviewed, status: 'applied' }]); vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(next); return { state: next, snapshot } })
    panel()
    fireEvent.change(await screen.findByRole('combobox', { name: '选择已有地点：渡口' }), { target: { value: 'node' } })
    fireEvent.click(screen.getByRole('button', { name: '重新核对' }))
    await screen.findByRole('button', { name: '确认移动' })
    expect(window.api.spatial.reviewProposal).toHaveBeenCalledWith('char', 'chat', 'proposal', { targets: { candidate: 'node' } })
    expect(window.api.spatial.applyProposal).not.toHaveBeenCalled()
    expect(screen.getByText('已核对当前修订 2；请再次确认移动。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认移动' }))
    await waitFor(() => expect(window.api.spatial.applyProposal).toHaveBeenCalledWith('char', 'chat', 'reviewed', false))
  })
  it('创建地点仅准备独立地图提案，不直接移动人物', async () => {
    vi.mocked(window.api.spatial.preparePlace).mockResolvedValue(session())
    panel()
    fireEvent.click(await screen.findByRole('button', { name: '创建地点' }))
    fireEvent.click(screen.getByRole('button', { name: '预览地点创建' }))
    await waitFor(() => expect(window.api.spatial.preparePlace).toHaveBeenCalledWith('char', 'chat', 'proposal', '渡口', null))
    expect(window.api.spatial.applyProposal).not.toHaveBeenCalled()
    expect(window.api.spatial.reviewProposal).not.toHaveBeenCalled()
  })
  it('不合格行动没有地点选择入口，确认也不能应用', async () => {
    const rejected = proposal(); rejected.dialogueCandidates![0]!.eligible = false
    vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(session([rejected]))
    panel()
    await screen.findByText('此动作不能应用；请在对话中明确完成行动。')
    expect(screen.queryByRole('combobox', { name: '选择已有地点：渡口' })).toBeNull()
    expect(screen.getByRole('button', { name: '应用' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '创建地点' })).toBeNull()
  })
  it('版本冲突显示核对入口，撤销失败保留后续位置并展示原因', async () => {
    const stale = { ...proposal(), status: 'stale' as const, canReview: true, commands: [{}], staleReason: '画板版本已改变' }
    const applied = { ...proposal(), id: 'applied', status: 'applied' as const, unresolved: [], summary: ['林雪 → 青石城 / 渡口'] }
    vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(session([stale, applied]))
    vi.mocked(window.api.spatial.undoProposal).mockRejectedValue(new Error('剧情提交后画板已有其他修改，不能覆盖当前位置'))
    panel()
    await screen.findByText('画板版本已改变')
    const section = screen.getByRole('heading', { name: '剧情位置建议' }).closest('section')!
    expect(within(section).getByRole('button', { name: '应用' })).toBeDisabled()
    expect(within(section).getByRole('button', { name: '重新核对' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '撤销此次剧情更新' }))
    expect(window.api.spatial.undoProposal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认撤销此次更新' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('不能覆盖当前位置')
    expect(window.api.spatial.undoProposal).toHaveBeenCalledWith('char', 'chat', 'applied')
  })
})

describe('空间阶段 4：自动策略交互', () => {
  it('关闭位置读取显示同步暂停，但保留主动画板指令入口', async () => {
    useChatStore.setState({ sessions: useChatStore.getState().sessions.map(item => ({ ...item, spatialContextEnabled: false, spatialNarrativeSyncPolicy: 'auto' as const })) })
    panel()
    await screen.findByText('对话位置读取已关闭，剧情同步暂停。')
    expect(screen.queryByText('按剧情自动同步角色和用户位置，明确的新地点自动添加；不确定或未完成的动作自动跳过。')).toBeNull()
    expect(screen.getByRole('textbox', { name: '画板助手输入' })).toBeEnabled()
  })
  it('默认需确认，可切到自动并即时返回需确认或关闭，不批准已有建议', async () => {
    panel()
    fireEvent.click(await screen.findByText('同步设置'))
    const selector = await screen.findByRole('combobox', { name: '剧情同步策略' })
    expect(selector).toHaveValue('suggest')
    fireEvent.change(selector, { target: { value: 'auto' } })
    await screen.findByText('按剧情自动同步角色和用户位置，明确的新地点自动添加；不确定或未完成的动作自动跳过。')
    expect(window.api.chat.updateSession).toHaveBeenCalledWith('char', 'chat', { spatialNarrativeSyncPolicy: 'auto' })
    expect(window.api.spatial.applyProposal).not.toHaveBeenCalled()
    await waitFor(() => expect(selector).toBeEnabled())
    fireEvent.change(selector, { target: { value: 'suggest' } })
    await waitFor(() => expect(selector).toHaveValue('suggest'))
    await waitFor(() => expect(selector).toBeEnabled())
    fireEvent.change(selector, { target: { value: 'off' } })
    await waitFor(() => expect(selector).toHaveValue('off'))
  })
  it('自动应用中只显示状态，确认入口锁定，策略仍可立即关闭', async () => {
    const updating = { ...proposal(), commands: [{}], unresolved: [], automatic: { status: 'applying' as const } }
    vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(session([updating]))
    panel()
    await screen.findByText('正在自动同步位置…')
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
    fireEvent.click(screen.getByText('同步设置'))
    expect(screen.getByRole('combobox', { name: '剧情同步策略' })).toBeEnabled()
    render(<SpatialSuggestionNotice characterId="char" sessionId="chat" worldId="world" enabled canSend onOpen={vi.fn()} onApplyAndSend={vi.fn()} />)
    await screen.findByText('正在自动同步位置 · 对话仍使用已确认位置')
    expect(screen.queryByRole('button', { name: '应用并发送' })).toBeNull()
  })
  it('自动成功通知没有跳转，助手内仍可撤销，失败保留已应用状态', async () => {
    const applied = { ...proposal(), status: 'applied' as const, unresolved: [], summary: ['林雪 → 青石城 / 花园'], automatic: { status: 'applied' as const } }
    const saved = session([applied]); saved.tasks = [{ id: 'task', dialogueId: 'turn', requestHash: 'hash', mode: 'dialogue_sync', state: 'completed', startedAt: 1 }]
    vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(saved)
    vi.mocked(window.api.spatial.undoProposal).mockRejectedValue(new Error('后续已有修改，不能覆盖当前位置'))
    const open = vi.fn()
    render(<SpatialSuggestionNotice characterId="char" sessionId="chat" worldId="world" enabled onOpen={open} />)
    expect(await screen.findByText('本轮位置已自动同步')).toBeVisible()
    expect(screen.queryByRole('button', { name: '查看或撤销' })).toBeNull()
    expect(screen.queryByRole('button', { name: '查看画板建议' })).toBeNull()
    expect(open).not.toHaveBeenCalled()
    panel()
    await screen.findByText('已自动应用：林雪 → 青石城 / 花园')
    fireEvent.click(screen.getByRole('button', { name: '撤销此次剧情更新' }))
    expect(window.api.spatial.undoProposal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认撤销此次更新' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('不能覆盖当前位置')
    expect(screen.getByText('已自动应用：林雪 → 青石城 / 花园')).toBeTruthy()
  })
  it('自动成功通知两秒后消失，同一更新不会重复提示，新更新会再次显示', async () => {
    vi.useFakeTimers()
    try {
      let update!: Parameters<typeof window.api.spatial.onAiUpdated>[0]
      vi.mocked(window.api.spatial.onAiUpdated).mockImplementation(listener => { update = listener; return vi.fn() })
      const applied = {...proposal(),status:'applied' as const,automatic:{status:'applied' as const}}
      const saved = session([applied])
      saved.tasks = [{id:'task',dialogueId:'turn',requestHash:'hash',mode:'dialogue_sync',state:'completed',startedAt:1}]
      vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(saved)
      const view = render(<SpatialSuggestionNotice characterId="char" sessionId="chat" worldId="world" enabled onOpen={vi.fn()} />)
      await act(async () => {})
      expect(screen.getByText('本轮位置已自动同步')).toBeVisible()
      act(() => { vi.advanceTimersByTime(1999) })
      expect(screen.getByText('本轮位置已自动同步')).toBeVisible()
      act(() => { vi.advanceTimersByTime(1) })
      expect(screen.queryByRole('status')).toBeNull()
      await act(async () => { update({characterId:'char',sessionId:'chat'}) })
      expect(screen.queryByRole('status')).toBeNull()
      vi.mocked(window.api.spatial.getAiSession).mockResolvedValue({...saved,proposals:[{...applied,id:'new-update'}]})
      await act(async () => { update({characterId:'char',sessionId:'chat'}) })
      expect(screen.getByText('本轮位置已自动同步')).toBeVisible()
      view.rerender(<SpatialSuggestionNotice characterId="char" sessionId="next" worldId="world" enabled onOpen={vi.fn()} />)
      await act(async () => {})
      expect(screen.queryByRole('status')).toBeNull()
      view.unmount()
    } finally { vi.useRealTimers() }
  })
  it('自动跳过只显示结果，没有目标选择、核对或应用操作', async () => {
    useChatStore.setState({sessions:useChatStore.getState().sessions.map(item => ({...item,spatialNarrativeSyncPolicy:'auto' as const}))})
    vi.mocked(window.api.spatial.getAiSession).mockResolvedValue(session([{ ...proposal(), status:'discarded', automatic: { status: 'skipped', reason: '原文未明确目标地点，保持原位置' } }]))
    panel()
    await screen.findByText('已自动跳过：原文未明确目标地点，保持原位置')
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
    expect(screen.queryByText('已核对，保留这些未明确项')).toBeNull()
    expect(screen.queryByRole('combobox', {name:/目标地点/})).toBeNull()
  })
})

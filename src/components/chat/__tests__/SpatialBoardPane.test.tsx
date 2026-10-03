import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SpatialBoardPane } from '../SpatialBoardPane'
import { useCharacterStore } from '../../../store/useCharacterStore'
import { usePersonaStore } from '../../../store/usePersonaStore'
import { useChatStore } from '../../../store/useChatStore'
import { useGroupChatStore } from '../../../store/useGroupChatStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { getDefaultSettings } from '../../../../shared/defaults'

beforeEach(() => {
  const pending = useSettingsStore.getState()._saveTimer
  if (pending) clearTimeout(pending)
  useSettingsStore.setState({ settings: getDefaultSettings(), loaded: true, loadFailed: false, _saveTimer: null, saveStatus: 'idle', saveError: null })
  useChatStore.setState({ sessions: [{ id: 'session-1', characterId: 'char-1', spatialBoardEnabled: true } as any] })
  vi.mocked(window.api.spatial.setEnabled).mockImplementation(async (_character, _session, enabled) => enabled ? pkg : null)
  vi.mocked(window.api.spatial.setGroupEnabled).mockImplementation(async (_group, _session, enabled) => enabled ? pkg : null)
})

const pkg = {
  world: { id: 'world-1', name: '青石城' },
  runtime: { runtimeId: 'single_session-1' },
  version: { worldId: 'world-1', runtimeId: 'single_session-1', bindingEpoch: 'epoch', runtimeRevision: 0, worldFingerprint: 'a'.repeat(64) },
}

describe('SpatialBoardPane 群聊', () => {
  const groupPackage = { ...pkg, runtime: { runtimeId: 'group_runtime' }, version: { ...pkg.version, runtimeId: 'group_runtime' }, activeActorIds: ['actor-a'] }
  beforeEach(() => {
    vi.clearAllMocks()
    useCharacterStore.setState({ characters: [] }); usePersonaStore.setState({ personas: [] })
    useGroupChatStore.setState({ currentGroup: { id: 'group-1', memberIds: [] } as any, currentSessionId: 'session-1', sessions: [{ id: 'session-1', groupId: 'group-1', title: '群聊', spatialBoardEnabled: true } as any], isStreaming: false, messages: [] })
    vi.mocked(window.api.spatial.loadGroupBound).mockResolvedValue(null)
    vi.mocked(window.api.spatial.listWorlds).mockResolvedValue([])
    vi.mocked(window.api.spatial.onUpdated).mockReturnValue(() => {})
  })
  it('已启用群聊自动创建画板，不要求输入名称', async () => {
    vi.mocked(window.api.spatial.setGroupEnabled).mockResolvedValue(groupPackage)
    render(<SpatialBoardPane groupId="group-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    await screen.findByTitle('当前会话空间画板')
    expect(window.api.spatial.setGroupEnabled).toHaveBeenCalledWith('group-1', 'session-1', true)
    expect(window.api.spatial.createAndBind).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(useGroupChatStore.getState().sessions[0]).toMatchObject({ spatialWorldId: pkg.version.worldId, spatialRuntimeId: 'group_runtime' })
  })
  it('iframe 初始化传递成员视图、角色头像和助手启用标记', async () => {
    const character = { ...useCharacterStore.getState().createCharacter(), id: 'char-a', avatar: 'data:image/png;base64,a' }
    useCharacterStore.setState({ characters: [character] })
    vi.mocked(window.api.spatial.loadGroupBound).mockResolvedValue({ ...groupPackage, world: { ...pkg.world, actors: [{ id: 'actor-a', kind: 'character', displayName: 'Aiko', externalRef: { type: 'qingyu-character', id: 'char-a' } }] } })
    render(<SpatialBoardPane groupId="group-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    const frame = await screen.findByTitle('当前会话空间画板') as HTMLIFrameElement, post = vi.spyOn(frame.contentWindow!, 'postMessage')
    fireEvent.load(frame)
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ assistantEnabled: true, activeActorIds: ['actor-a'], actorAvatarUrls: { 'actor-a': character.avatar } }), '*')
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: window.location.origin, data: { type: 'qingyu:spatial:assistant' } }))
    expect(window.api.spatial.getAiSession).not.toHaveBeenCalled()
  })
  it('群聊提交冻结原归属，切换群聊后旧回包不会覆盖新画板', async () => {
    vi.mocked(window.api.spatial.loadGroupBound).mockResolvedValue(groupPackage)
    let complete!: (value: any) => void
    vi.mocked(window.api.spatial.applyGroupEditorBatch).mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const { rerender } = render(<SpatialBoardPane groupId="group-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    const frame = await screen.findByTitle('当前会话空间画板') as HTMLIFrameElement
    const input = { commitId: 'group-commit', commands: [] }
    await act(async () => {})
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: window.location.origin, data: { type: 'qingyu:spatial:commands', request: input } }))
    await waitFor(() => expect(window.api.spatial.applyGroupEditorBatch).toHaveBeenCalledWith('group-1', 'session-1', input))
    const other = { ...groupPackage, world: { id: 'other', name: '另一群' }, version: { ...groupPackage.version, worldId: 'other', bindingEpoch: 'other-epoch' } }
    vi.mocked(window.api.spatial.loadGroupBound).mockResolvedValue(other)
    act(() => useGroupChatStore.setState({ currentGroup: { id: 'group-2' } as any }))
    rerender(<SpatialBoardPane groupId="group-2" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    await waitFor(() => expect(window.api.spatial.loadGroupBound).toHaveBeenLastCalledWith('group-2', 'session-1'))
    await act(async () => { complete({ ok: true, snapshot: groupPackage }) })
    const latest = screen.getByTitle('当前会话空间画板') as HTMLIFrameElement, post = vi.spyOn(latest.contentWindow!, 'postMessage')
    fireEvent.load(latest)
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ world: other.world }), '*')
    expect(window.api.spatial.applyEditorBatch).not.toHaveBeenCalled()
  })
  it('群聊会话切换等待 flush，失败时保持原群聊与画板', async () => {
    vi.mocked(window.api.spatial.loadGroupBound).mockResolvedValue(groupPackage)
    render(<SpatialBoardPane groupId="group-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    const frame = await screen.findByTitle('当前会话空间画板') as HTMLIFrameElement, post = vi.spyOn(frame.contentWindow!, 'postMessage')
    let switched!: Promise<void>
    act(() => { switched = useGroupChatStore.getState().switchSession('group-1', 'session-2') })
    expect(useGroupChatStore.getState().currentSessionId).toBe('session-1')
    const flush = post.mock.calls.find(([data]) => data.type === 'qingyu:spatial:flush')![0]
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: window.location.origin, data: { type: 'qingyu:spatial:flush-error', requestId: flush.requestId, message: '需要核对冲突' } }))
    await act(async () => { await switched })
    expect(useGroupChatStore.getState().currentSessionId).toBe('session-1')
    expect(screen.getByRole('alert').textContent).toContain('需要核对冲突')
    post.mockClear()
    act(() => { switched = useGroupChatStore.getState().switchSession('group-1', 'session-2') })
    const retry = post.mock.calls.find(([data]) => data.type === 'qingyu:spatial:flush')![0]
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: window.location.origin, data: { type: 'qingyu:spatial:flushed', requestId: retry.requestId } }))
    await act(async () => { await switched })
    expect(useGroupChatStore.getState().currentSessionId).toBe('session-2')
  })
})

describe('SpatialBoardPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useCharacterStore.setState({ characters: [] })
    usePersonaStore.setState({ personas: [] })
    vi.mocked(window.api.spatial.loadBound).mockResolvedValue(null)
    vi.mocked(window.api.spatial.listWorlds).mockResolvedValue([])
  })

  it.each(['single', 'group'])('默认关闭，在 %s 会话启用后自动创建画板', async kind => {
    useChatStore.setState({ sessions: [{ id: 'session-1', characterId: 'char-1' } as any, { id: 'session-2', characterId: 'char-1' } as any] })
    useGroupChatStore.setState({ currentGroup: { id: 'group-1' } as any, sessions: [{ id: 'session-1', groupId: 'group-1' } as any, { id: 'session-2', groupId: 'group-1' } as any] })
    vi.mocked(window.api.spatial.loadGroupBound).mockResolvedValue(null)
    render(kind === 'single'
      ? <SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />
      : <SpatialBoardPane groupId="group-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    expect(screen.getByRole('switch', { name: '启用空间画布' })).toHaveAttribute('aria-checked', 'false')
    expect(window.api.spatial.loadBound).not.toHaveBeenCalled()
    expect(window.api.spatial.loadGroupBound).not.toHaveBeenCalled()
    expect(window.api.spatial.getAiSession).not.toHaveBeenCalled()
    expect(window.api.spatial.getGroupAiSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: '启用空间画布' }))
    await screen.findByTitle('当前会话空间画板')
    const sessions = kind === 'single' ? useChatStore.getState().sessions : useGroupChatStore.getState().sessions
    expect(sessions[0].spatialBoardEnabled).toBe(true)
    expect(sessions[1].spatialBoardEnabled).toBeUndefined()
    expect(window.api.settings.save).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('画布内关闭开关前等待保存确认，关闭后保留重新开启入口', async () => {
    vi.mocked(window.api.spatial.loadBound).mockResolvedValue(pkg)
    render(<SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    const frame = await screen.findByTitle('当前会话空间画板') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    // 已加载画布的顶栏由 iframe 统一呈现，父页面不再重复返回和开关。
    expect(screen.queryByRole('button', { name: '返回对话' })).toBeNull()
    expect(screen.queryByRole('switch', { name: '启用空间画布' })).toBeNull()
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: window.location.origin,
      data: { type: 'qingyu:spatial:set-enabled', enabled: false } }))
    const flush = post.mock.calls.find(([data]) => data.type === 'qingyu:spatial:flush')![0]
    expect(window.api.settings.save).not.toHaveBeenCalled()
    expect(screen.getByTitle('当前会话空间画板')).toBeInTheDocument()
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: window.location.origin, data: { type: 'qingyu:spatial:flushed', requestId: flush.requestId } }))
    await screen.findByText('空间画布已关闭')
    await waitFor(() => expect(screen.getByRole('switch', { name: '启用空间画布' })).not.toBeDisabled())
    expect(screen.queryByTitle('当前会话空间画板')).toBeNull()
    expect(window.api.spatial.setEnabled).toHaveBeenCalledWith('char-1', 'session-1', false)
    fireEvent.click(screen.getByRole('switch', { name: '启用空间画布' }))
    await screen.findByTitle('当前会话空间画板')
    expect(window.api.spatial.setEnabled).toHaveBeenLastCalledWith('char-1', 'session-1', true)
  })

  it('关闭时保存失败则保留原画布和开启状态', async () => {
    vi.mocked(window.api.spatial.loadBound).mockResolvedValue(pkg)
    render(<SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    const frame = await screen.findByTitle('当前会话空间画板') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: window.location.origin,
      data: { type: 'qingyu:spatial:set-enabled', enabled: false } }))
    const flush = post.mock.calls.find(([data]) => data.type === 'qingyu:spatial:flush')![0]
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: window.location.origin, data: { type: 'qingyu:spatial:flush-error', requestId: flush.requestId, message: '画布尚未保存' } }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('画布尚未保存'))
    expect(useChatStore.getState().sessions[0].spatialBoardEnabled).not.toBe(false)
    expect(screen.queryByRole('switch', { name: '启用空间画布' })).toBeNull()
    expect(post).toHaveBeenCalledWith({ type: 'qingyu:spatial:feature-toggle-result' }, '*')
    expect(screen.getByTitle('当前会话空间画板')).toBeInTheDocument()
    expect(window.api.settings.save).not.toHaveBeenCalled()
  })

  it('忽略非当前画布或不同来源的开关请求', async () => {
    vi.mocked(window.api.spatial.loadBound).mockResolvedValue(pkg)
    render(<SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    const frame = await screen.findByTitle('当前会话空间画板') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    fireEvent(window, new MessageEvent('message', { source: window, origin: window.location.origin,
      data: { type: 'qingyu:spatial:set-enabled', enabled: false } }))
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: 'https://example.com',
      data: { type: 'qingyu:spatial:set-enabled', enabled: false } }))
    expect(post).not.toHaveBeenCalled()
    expect(window.api.settings.save).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessions[0].spatialBoardEnabled).not.toBe(false)
  })

  it('会话开关保存失败时保留原状态并显示错误', async () => {
    useChatStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, spatialBoardEnabled: false })) }))
    vi.mocked(window.api.spatial.setEnabled).mockRejectedValueOnce(new Error('会话文件无法写入'))
    render(<SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('switch', { name: '启用空间画布' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('会话文件无法写入'))
    expect(screen.getByRole('switch', { name: '启用空间画布' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('空间画布已关闭')).toBeInTheDocument()
  })

  it('已启用但尚未绑定的会话自动创建画板，无初始化表单', async () => {
    render(<SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    await screen.findByTitle('当前会话空间画板')
    expect(window.api.spatial.setEnabled).toHaveBeenCalledWith('char-1', 'session-1', true)
    expect(window.api.spatial.listWorlds).not.toHaveBeenCalled()
    expect(screen.queryByText('创建空白')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it.each(['single', 'group'])('%s 开始页的 AI 入口打开初始化助手，生成前不请求模型', async kind => {
    useGroupChatStore.setState({ currentGroup: { id: 'group-1' } as any, sessions: [{ id: 'session-1', groupId: 'group-1', spatialBoardEnabled: true } as any] })
    vi.mocked(window.api.spatial.loadBound).mockResolvedValue(pkg)
    vi.mocked(window.api.spatial.loadGroupBound).mockResolvedValue(pkg)
    vi.mocked(window.api.spatial.groupInitializationSources).mockResolvedValue({ sources: [], loreEntries: [], canInitialize: true, sharedSessions: 1 })
    render(kind === 'single'
      ? <SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />
      : <SpatialBoardPane groupId="group-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    const frame = await screen.findByTitle('当前会话空间画板') as HTMLIFrameElement
    await act(async () => {})
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: window.location.origin,
      data: { type: 'qingyu:spatial:assistant' } }))
    expect(await screen.findByRole('heading', { name: 'AI 初始化' })).toBeVisible()
    expect(screen.getByRole('button', { name: '生成场景' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: '画板助手输入' })).toHaveAttribute('placeholder', '可选：补充故事发生的地点和人物起点')
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    expect(window.api.spatial.askAi).not.toHaveBeenCalled()
    expect(window.api.spatial.askGroupAi).not.toHaveBeenCalled()
  })

  it('打开画板后同步 PC 主题变化', async () => {
    vi.mocked(window.api.spatial.loadBound).mockResolvedValue(pkg)
    render(<SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)

    const frame = await screen.findByTitle('当前会话空间画板') as HTMLIFrameElement
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage')
    document.documentElement.classList.add('dark')

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'qingyu:spatial:theme', theme: 'dark' }),
      '*',
    ))

    document.documentElement.classList.remove('dark')
  })

  it('内嵌返回入口等待命令提交及队列确认后关闭', async () => {
    vi.mocked(window.api.spatial.loadBound).mockResolvedValue(pkg)
    let complete!: (value: any) => void
    vi.mocked(window.api.spatial.applyEditorBatch).mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    const onClose = vi.fn()
    render(<SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={onClose} registerClose={vi.fn()} />)
    const frame = await screen.findByTitle('当前会话空间画板') as HTMLIFrameElement
    const send = (data: unknown) => fireEvent(window, new MessageEvent('message', {
      data, source: frame.contentWindow, origin: window.location.origin,
    }))

    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage')
    const input = { commitId: 'commit-1', worldId: 'world-1', runtimeId: 'single_session-1', bindingEpoch: 'epoch',
      expectedRuntimeRevision: 0, expectedWorldFingerprint: pkg.version.worldFingerprint, commands: [{ type: 'update_world', patch: { name: '更新' } }] }
    send({ type: 'qingyu:spatial:commands', request: input })
    send({ type: 'qingyu:spatial:close' })
    await waitFor(() => expect(window.api.spatial.applyEditorBatch).toHaveBeenCalledWith('char-1', 'session-1', input))
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { complete({ ok: true, snapshot: pkg, receipt: { commitId: 'commit-1' }, duplicate: false }) })
    const flush = postMessage.mock.calls.find(([data]) => data.type === 'qingyu:spatial:flush')![0]
    send({ type: 'qingyu:spatial:flushed', requestId: flush.requestId })
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(vi.mocked(window.api.spatial.applyEditorBatch).mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0])
  })

  it('按角色与身份的绑定 ID 传递头像，头像更新不保存世界', async () => {
    const character = { ...useCharacterStore.getState().createCharacter(), id: 'char-1', updatedAt: 42 }
    const persona = { id: 'persona-1', name: '大本', avatar: 'data:image/png;base64,persona', description: '', persona: '', createdAt: 1, updatedAt: 1 }
    useCharacterStore.setState({ characters: [character] })
    usePersonaStore.setState({ personas: [persona] })
    vi.mocked(window.api.spatial.loadBound).mockResolvedValue({
      ...pkg,
      world: { ...pkg.world, actors: [
        { id: 'actor-character', kind: 'character', displayName: 'Aiko', externalRef: { type: 'qingyu-character', id: character.id } },
        { id: 'actor-persona', kind: 'persona', displayName: '大本', externalRef: { type: 'qingyu-persona', id: persona.id } },
      ] },
    })
    render(<SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    const frame = await screen.findByTitle('当前会话空间画板') as HTMLIFrameElement
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage')
    fireEvent.load(frame)

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'qingyu:spatial:init',
      actorAvatarUrls: {
        'actor-character': 'tavern://character/char-1/avatar?v=42',
        'actor-persona': persona.avatar,
      },
    }), '*')

    act(() => useCharacterStore.setState({ characters: [{ ...character, avatar: 'data:image/png;base64,updated' }] }))
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'qingyu:spatial:avatars',
      actorAvatarUrls: { 'actor-character': 'data:image/png;base64,updated', 'actor-persona': persona.avatar },
    }), '*'))
    expect(window.api.spatial.applyEditorBatch).not.toHaveBeenCalled()
  })

  it('版本冲突保留画板和未提交操作，不静默重试或关闭', async () => {
    vi.mocked(window.api.spatial.loadBound).mockResolvedValue(pkg)
    vi.mocked(window.api.spatial.applyEditorBatch).mockResolvedValue({ ok: false, code: 'version_conflict', message: '画板已更新' })
    const onClose = vi.fn()
    render(<SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={onClose} registerClose={vi.fn()} />)
    const frame = await screen.findByTitle('当前会话空间画板') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: window.location.origin,
      data: { type: 'qingyu:spatial:commands', request: { commitId: 'conflict' } } }))
    expect(await screen.findByText('画板已更新')).toBeTruthy()
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'qingyu:spatial:commit-result', commitId: 'conflict',
      result: expect.objectContaining({ ok: false }) }), '*')
    expect(window.api.spatial.applyEditorBatch).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '载入最新画板' })).toBeTruthy()
  })

  it('同一会话恢复到其他世界时重新载入 iframe，不被旧 worldId 过滤', async () => {
    let updated!: (event: { characterId: string; sessionId: string; worldId: string; commitId: string }) => void
    vi.mocked(window.api.spatial.onUpdated).mockImplementation(listener => { updated = listener; return vi.fn() })
    vi.mocked(window.api.spatial.loadBound).mockResolvedValue(pkg)
    render(<SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    await screen.findByTitle('当前会话空间画板')
    const restored = { ...pkg, world: { id: 'world-restored', name: '恢复世界' }, version: { ...pkg.version, worldId: 'world-restored', bindingEpoch: 'restored-epoch' } }
    vi.mocked(window.api.spatial.loadBound).mockResolvedValue(restored)
    act(() => updated({ characterId: 'char-1', sessionId: 'session-1', worldId: 'world-restored', commitId: 'restore' }))
    await waitFor(() => expect(window.api.spatial.loadBound).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      const frame = screen.getByTitle('当前会话空间画板') as HTMLIFrameElement
      const post = vi.spyOn(frame.contentWindow!, 'postMessage')
      fireEvent.load(frame)
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'qingyu:spatial:init', world: restored.world }), '*')
    })
  })

  it('旧全量快照不发送到主进程', async () => {
    vi.mocked(window.api.spatial.loadBound).mockResolvedValue(pkg)
    render(<SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    const frame = await screen.findByTitle('当前会话空间画板') as HTMLIFrameElement
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: window.location.origin,
      data: { type: 'qingyu:spatial:save', ...pkg } }))
    expect(await screen.findByText('画板保存协议已更新，请重新打开画板')).toBeTruthy()
    expect(window.api.spatial.applyEditorBatch).not.toHaveBeenCalled()
  })

  it('切换会话等待画板 flush，保存失败时保留原会话', async () => {
    const character = { ...useCharacterStore.getState().createCharacter(), id: 'char-1' }
    useChatStore.setState({ currentSessionId: 'session-1', sessions: [{ id: 'session-1', characterId: 'char-1', spatialBoardEnabled: true } as any], isStreaming: false })
    vi.mocked(window.api.spatial.loadBound).mockResolvedValue(pkg)
    render(<SpatialBoardPane characterId="char-1" sessionId="session-1" onClose={vi.fn()} registerClose={vi.fn()} />)
    const frame = await screen.findByTitle('当前会话空间画板') as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    const send = (data: unknown) => fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: window.location.origin, data }))
    let switched!: Promise<void>
    act(() => { switched = useChatStore.getState().switchSession('session-2', character) })
    expect(useChatStore.getState().currentSessionId).toBe('session-1')
    const first = post.mock.calls.find(([data]) => data.type === 'qingyu:spatial:flush')![0]
    send({ type: 'qingyu:spatial:flush-error', requestId: first.requestId, message: '需要核对冲突' })
    await act(async () => { await switched })
    expect(useChatStore.getState().currentSessionId).toBe('session-1')
    expect(screen.getByRole('alert').textContent).toContain('需要核对冲突')
    post.mockClear()
    act(() => { switched = useChatStore.getState().switchSession('session-2', character) })
    const second = post.mock.calls.find(([data]) => data.type === 'qingyu:spatial:flush')![0]
    send({ type: 'qingyu:spatial:flushed', requestId: second.requestId })
    await act(async () => { await switched })
    expect(useChatStore.getState().currentSessionId).toBe('session-2')
  })
})

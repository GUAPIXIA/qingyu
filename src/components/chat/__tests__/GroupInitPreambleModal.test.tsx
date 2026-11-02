import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Character, ConnectionProfile, GroupChat } from '../../../../shared/types'
import { getDefaultSettings } from '../../../../shared/defaults'
import {
  GroupInitPreambleModal,
  type GroupInitEntrySource,
  type GroupInitPreambleModalProps,
} from '../GroupInitPreambleModal'
import { useCharacterStore } from '../../../store/useCharacterStore'
import { useGroupChatStore } from '../../../store/useGroupChatStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useToastStore } from '../../../store/useToastStore'

// 生成器是唯一外部依赖：mock 掉以覆盖流式/取消/失败分支，避免真实 AI 请求。
const runner = vi.hoisted(() => ({
  generateGroupPreamble: vi.fn(),
  generateGroupOpening: vi.fn(),
  cancelGroupInitGeneration: vi.fn(),
}))

vi.mock('../../../features/group-chat/groupInitRunner', () => ({
  generateGroupPreamble: runner.generateGroupPreamble,
  generateGroupOpening: runner.generateGroupOpening,
  cancelGroupInitGeneration: runner.cancelGroupInitGeneration,
}))

const PROFILE: ConnectionProfile = {
  id: 'profile-1',
  name: '测试连接',
  provider: 'openai',
  baseUrl: 'http://localhost:1234/v1',
  model: 'test-model',
  apiKey: 'test-key',
  maxContext: 8192,
}

function makeCharacter(id: string, patch: Partial<Character> = {}): Character {
  const base = useCharacterStore.getState().createCharacter()
  return { ...base, id, name: `角色-${id}`, scenario: `${id} 的初始场景`, ...patch }
}

function makeGroup(patch: Partial<GroupChat> = {}): GroupChat {
  return {
    id: 'group-a',
    name: '夜谈会',
    memberIds: ['char-a', 'char-b'],
    currentSpeakerIndex: 0,
    autoMode: false,
    chatMode: 'polling',
    maxRounds: 1,
    speakerInterval: 2000,
    lorebookIds: [],
    presetId: null,
    systemPrompt: '',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

function setApiConfigured(configured: boolean) {
  const settings = getDefaultSettings()
  useSettingsStore.setState({
    settings: configured
      ? { ...settings, activeProfileId: PROFILE.id, connectionProfiles: [PROFILE] }
      : settings,
  })
}

function makeProps(patch: Partial<GroupInitPreambleModalProps> = {}): GroupInitPreambleModalProps {
  return {
    open: true,
    group: makeGroup(),
    entry: 'empty',
    onClose: vi.fn(),
    onChooseDefaultOpening: vi.fn(),
    ...patch,
  }
}

const savedGroups = () => vi.mocked(useGroupChatStore.getState().saveGroup)
const insertedNarrations = () => vi.mocked(useGroupChatStore.getState().insertNarrationMessage)

beforeEach(() => {
  vi.clearAllMocks()
  runner.generateGroupPreamble.mockReset()
  runner.generateGroupOpening.mockReset()
  runner.cancelGroupInitGeneration.mockReset()
  useCharacterStore.setState({ characters: [makeCharacter('char-a'), makeCharacter('char-b')] })
  useGroupChatStore.setState({
    currentGroup: makeGroup(),
    currentSessionId: 'session-a',
    sessions: [{ id: 'session-a', groupId: 'group-a' } as never],
    messages: [],
    isStreaming: false,
    saveGroup: vi.fn().mockResolvedValue(undefined),
    insertNarrationMessage: vi.fn().mockResolvedValue(undefined),
  })
  useToastStore.setState({ toasts: [] })
  setApiConfigured(true)
})

describe('GroupInitPreambleModal 入口阶段映射', () => {
  it.each<[GroupInitEntrySource, boolean, number]>([
    ['empty', false, 1],
    ['empty', true, 1],
    ['greeting', false, 1],
    ['greeting', true, 3],
    ['settings', false, 1],
    ['settings', true, 2],
    ['opening', false, 1],
    ['opening', true, 3],
  ])('entry=%s 已有共同场景=%s 时从第 %s 步开始', (entry, hasPreamble, step) => {
    const group = makeGroup(
      hasPreamble ? { groupPreamble: { text: '已有共同场景', memberIds: ['char-a'], updatedAt: 1 } } : {},
    )
    render(<GroupInitPreambleModal {...makeProps({ group, entry })} />)
    expect(screen.getByText(`第 ${step} / 4 步`)).toBeInTheDocument()
  })

  it('第 1 步展示只读成员核对与模型调用说明，点击跳过直接关闭', () => {
    const props = makeProps({ entry: 'empty' })
    render(<GroupInitPreambleModal {...props} />)
    expect(screen.getByText('先统一角色初始环境，再开始对话')).toBeInTheDocument()
    expect(screen.getByText('角色-char-a')).toBeInTheDocument()
    expect(screen.getByText('char-a 的初始场景')).toBeInTheDocument()
    expect(screen.getByText(/本次分析会调用一次当前对话模型/)).toBeInTheDocument()
    // v1 只读核对：没有勾选框
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '跳过，手动开始' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(runner.generateGroupPreamble).not.toHaveBeenCalled()
  })
})

describe('GroupInitPreambleModal 共同场景生成', () => {
  it('未配置 API 时禁用生成并提示配置入口', () => {
    setApiConfigured(false)
    render(<GroupInitPreambleModal {...makeProps({ entry: 'empty' })} />)
    expect(screen.getByRole('button', { name: 'AI 分析并生成共同场景' })).toBeDisabled()
    expect(screen.getByText('请先在「模型 → 对话 API」配置 API 连接')).toBeInTheDocument()
    expect(runner.generateGroupPreamble).not.toHaveBeenCalled()
  })

  it('生成中展示流式正文；停止时取消在途任务且丢弃迟到结果', async () => {
    let resolveGeneration!: (value: unknown) => void
    runner.generateGroupPreamble.mockImplementation((opts: { onProgress?: (text: string) => void }) => {
      opts.onProgress?.('正在融合角色初始环境……')
      return new Promise((resolve) => { resolveGeneration = resolve })
    })
    const props = makeProps({ entry: 'empty' })
    render(<GroupInitPreambleModal {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析并生成共同场景' }))

    expect(await screen.findByText('AI 正在融合角色初始环境…')).toBeInTheDocument()
    expect(screen.getByText('正在融合角色初始环境……')).toBeInTheDocument()
    // 生成中不可关闭（dismissible=false）
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(props.onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '停止生成' }))
    expect(runner.cancelGroupInitGeneration).toHaveBeenCalledWith('group-a', 'session-a')
    expect(await screen.findByRole('button', { name: '重新生成' })).toBeInTheDocument()

    // 停止后迟到的生成结果不得覆盖正文
    await act(async () => {
      resolveGeneration({ scene: '迟到的正文', conflicts: [], model: 'late-model' })
    })
    expect(screen.getByRole('textbox', { name: '共同场景正文' })).toHaveValue('')
  })

  it('生成成功展示冲突清单；应用后写入 groupPreamble 并进入开场方式', async () => {
    runner.generateGroupPreamble.mockResolvedValue({
      scene: '【时间】傍晚\n【地点】旧书店',
      conflicts: ['时间冲突：清晨 vs 深夜；融合为傍晚'],
      model: 'test-model',
    })
    const props = makeProps({ entry: 'empty' })
    render(<GroupInitPreambleModal {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析并生成共同场景' }))

    const textarea = await screen.findByRole('textbox', { name: '共同场景正文' })
    expect(textarea).toHaveValue('【时间】傍晚\n【地点】旧书店')
    expect(screen.getByText('AI 归纳，仅供参考')).toBeInTheDocument()
    expect(screen.getByText(/时间冲突：清晨 vs 深夜/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '应用并进入开场选择' }))
    await waitFor(() => expect(savedGroups()).toHaveBeenCalledTimes(1))
    const saved = savedGroups().mock.calls[0][0]
    expect(saved.groupPreamble).toMatchObject({
      text: '【时间】傍晚\n【地点】旧书店',
      memberIds: ['char-a', 'char-b'],
      model: 'test-model',
    })
    expect(saved.groupPreamble?.updatedAt).toEqual(expect.any(Number))
    expect(await screen.findByText('第 3 / 4 步')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /系统开场/ })).toBeInTheDocument()
  })

  it('settings 入口应用共同场景后直接关闭，不进入开场方式', async () => {
    const group = makeGroup({
      groupPreamble: { text: '旧场景正文', memberIds: ['char-a', 'char-b'], updatedAt: 1, model: 'old-model' },
    })
    const props = makeProps({ group, entry: 'settings' })
    render(<GroupInitPreambleModal {...props} />)
    expect(screen.getByText('第 2 / 4 步')).toBeInTheDocument()

    const textarea = screen.getByRole('textbox', { name: '共同场景正文' })
    expect(textarea).toHaveValue('旧场景正文')
    fireEvent.change(textarea, { target: { value: '  手改后的共同场景  ' } })
    fireEvent.click(screen.getByRole('button', { name: '应用并进入开场选择' }))

    await waitFor(() => expect(savedGroups()).toHaveBeenCalledTimes(1))
    expect(savedGroups().mock.calls[0][0].groupPreamble).toMatchObject({
      text: '手改后的共同场景',
      model: 'old-model',
    })
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('第 3 / 4 步')).not.toBeInTheDocument()
  })

  it('手改正文后重新生成需二次确认，每次生成使用新的 attemptId', async () => {
    runner.generateGroupPreamble.mockResolvedValue({ scene: 'AI 正文', conflicts: [], model: 'm1' })
    const props = makeProps({ entry: 'empty' })
    render(<GroupInitPreambleModal {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析并生成共同场景' }))

    const textarea = await screen.findByRole('textbox', { name: '共同场景正文' })
    fireEvent.change(textarea, { target: { value: '用户手改正文' } })

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(runner.generateGroupPreamble).toHaveBeenCalledTimes(1)

    confirmSpy.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }))
    await waitFor(() => expect(runner.generateGroupPreamble).toHaveBeenCalledTimes(2))
    const [first, second] = runner.generateGroupPreamble.mock.calls
    expect(first[0].attemptId).toBeTruthy()
    expect(second[0].attemptId).toBeTruthy()
    expect(first[0].attemptId).not.toBe(second[0].attemptId)
    confirmSpy.mockRestore()
  })

  it('生成失败时 toast 提示并可重新生成，未生成正文时不可应用', async () => {
    runner.generateGroupPreamble.mockRejectedValue(new Error('网络中断'))
    const props = makeProps({ entry: 'empty' })
    render(<GroupInitPreambleModal {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'AI 分析并生成共同场景' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('网络中断')
    expect(
      useToastStore.getState().toasts.some(
        (toast) => toast.title === '共同场景生成失败' && toast.description === '网络中断',
      ),
    ).toBe(true)
    expect(screen.getByRole('button', { name: '重新生成' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '应用并进入开场选择' })).toBeDisabled()
  })
})

describe('GroupInitPreambleModal 开场方式与系统开场', () => {
  const preambleGroup = () =>
    makeGroup({
      groupPreamble: { text: '共同场景正文', memberIds: ['char-a', 'char-b'], updatedAt: 1 },
    })

  it('选择默认开场只回调页面并关闭弹窗，不插入消息', () => {
    const props = makeProps({ group: preambleGroup(), entry: 'opening' })
    render(<GroupInitPreambleModal {...props} />)
    expect(screen.getByText('第 3 / 4 步')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /默认开场/ }))
    expect(props.onChooseDefaultOpening).toHaveBeenCalledTimes(1)
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(insertedNarrations()).not.toHaveBeenCalled()
  })

  it('系统开场生成后应用并开始：插入旁白消息并关闭', async () => {
    runner.generateGroupOpening.mockResolvedValue({ text: '傍晚，旧书店的风铃轻响。', model: 'test-model' })
    const props = makeProps({ group: preambleGroup(), entry: 'opening' })
    render(<GroupInitPreambleModal {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /系统开场/ }))

    const textarea = await screen.findByRole('textbox', { name: '系统开场旁白' })
    expect(textarea).toHaveValue('傍晚，旧书店的风铃轻响。')
    expect(runner.generateGroupOpening).toHaveBeenCalledWith(
      expect.objectContaining({ group: preambleGroup(), sessionId: 'session-a', scene: '共同场景正文' }),
    )

    fireEvent.click(screen.getByRole('button', { name: '应用并开始' }))
    await waitFor(() => expect(insertedNarrations()).toHaveBeenCalledWith('傍晚，旧书店的风铃轻响。'))
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1))
  })

  it('系统开场失败后 toast 提示，并可用默认开场回退', async () => {
    runner.generateGroupOpening.mockRejectedValue(new Error('模型超时'))
    const props = makeProps({ group: preambleGroup(), entry: 'opening' })
    render(<GroupInitPreambleModal {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /系统开场/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('模型超时')
    expect(
      useToastStore.getState().toasts.some((toast) => toast.title === '系统开场生成失败'),
    ).toBe(true)
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '改用默认开场' }))
    expect(props.onChooseDefaultOpening).toHaveBeenCalledTimes(1)
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(insertedNarrations()).not.toHaveBeenCalled()
  })

  it('切换 entry 或 group.id 时取消在途生成', () => {
    const props = makeProps({ entry: 'greeting' })
    const { rerender } = render(<GroupInitPreambleModal {...props} />)
    rerender(<GroupInitPreambleModal {...props} entry="opening" />)
    expect(runner.cancelGroupInitGeneration).toHaveBeenCalledWith('group-a', 'session-a')

    runner.cancelGroupInitGeneration.mockClear()
    rerender(<GroupInitPreambleModal {...props} group={makeGroup({ id: 'group-b' })} entry="opening" />)
    expect(runner.cancelGroupInitGeneration).toHaveBeenCalledWith('group-a', 'session-a')
  })
})

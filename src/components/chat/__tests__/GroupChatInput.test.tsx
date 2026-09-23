import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Character, GroupChat } from '../../../../shared/types'
import { useCharacterStore } from '../../../store/useCharacterStore'
import { useGroupChatStore } from '../../../store/useGroupChatStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { GroupChatInput } from '../GroupChatInput'

const character: Character = {
  id: 'c1', name: '爱丽丝', avatar: '', description: '', personality: '', scenario: '',
  firstMessage: '', exampleDialog: '', tags: [], lorebookId: null, creator: '',
  createdAt: 0, updatedAt: 0, alternateGreetings: [],
}

const group: GroupChat = {
  id: 'g1', name: '测试群', memberIds: ['c1'], currentSpeakerIndex: 0,
  autoMode: false, chatMode: 'polling', maxRounds: 1, speakerInterval: 2000,
  lorebookIds: [], presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
}

describe('GroupChatInput', () => {
  const triggerCharacterReply = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    useCharacterStore.setState({ characters: [character] })
    useGroupChatStore.setState({ isStreaming: false, currentGroup: group, triggerCharacterReply } as never)
    useSettingsStore.setState({
      settings: { ...getDefaultSettings(), userName: '林舟' },
      credentials: {}, loaded: true, _saveTimer: null,
    })
  })

  it('用单行控制器区分发送后规则与立即接话', () => {
    render(<GroupChatInput group={group} />)

    expect(screen.queryByText('发言方式')).toBeNull()
    expect(screen.getByText('发送后')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '发送后回复规则' })).toHaveValue('polling')
    expect(screen.getByText('立即接话')).toBeTruthy()
    expect(screen.getByRole('button', { name: '让 爱丽丝立即接话' })).toBeTruthy()
    expect(screen.getByPlaceholderText('输入消息…')).toBeTruthy()
  })

  it('点击角色后直接触发一次上下文回复', async () => {
    render(<GroupChatInput group={group} />)

    fireEvent.click(screen.getByRole('button', { name: '让 爱丽丝立即接话' }))

    await waitFor(() => expect(triggerCharacterReply).toHaveBeenCalledWith('c1'))
  })

  it('D2 已拍板：徽标显示「每次接力最多 N 轮 · 本段已用 x/N」（x 按本段计数、跨用户消息重置）', () => {
    // 旧段（用户消息 r1 前）：r1/r2 两轮；新用户消息 r3 之后本段已用 1 轮
    useGroupChatStore.setState({
      messages: [
        { id: 'm0', groupId: 'g1', characterId: 'c1', content: '旧段回复', images: [], timestamp: 0, round: 1 },
        { id: 'm1', groupId: 'g1', characterId: 'c1', content: '旧段接力', images: [], timestamp: 1, round: 2 },
        { id: 'u2', groupId: 'g1', characterId: '__user__', content: '新消息', images: [], timestamp: 2, round: 3 },
        { id: 'm2', groupId: 'g1', characterId: 'c1', content: '本段回复', images: [], timestamp: 3, round: 3 },
      ],
    } as never)
    render(<GroupChatInput group={{ ...group, autoMode: true, maxRounds: 3 }} />)

    expect(screen.getByText('每次接力最多 3 轮 · 本段已用 1/3')).toBeTruthy()
    // D2 已拍板：旧「会话上限」文案废止
    expect(screen.queryByText(/本会话自动接力上限/)).toBeNull()
  })

  it('UEX-P1-13：草稿按 群+会话 隔离，切换会话不串台', () => {
    localStorage.clear()
    useGroupChatStore.setState({ currentSessionId: 's1' } as never)
    render(<GroupChatInput group={group} />)
    const textarea = screen.getByPlaceholderText('输入消息…') as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: '会话一的草稿' } })
    expect(localStorage.getItem('group-draft:g1:s1')).toBe('会话一的草稿')

    // 切到会话二：恢复会话二自己的（空）草稿，不带入会话一内容
    act(() => { useGroupChatStore.setState({ currentSessionId: 's2' } as never) })
    expect(textarea.value).toBe('')
    fireEvent.change(textarea, { target: { value: '会话二的草稿' } })
    expect(localStorage.getItem('group-draft:g1:s2')).toBe('会话二的草稿')

    // 切回会话一：各自草稿互不串台
    act(() => { useGroupChatStore.setState({ currentSessionId: 's1' } as never) })
    expect(textarea.value).toBe('会话一的草稿')
  })
})

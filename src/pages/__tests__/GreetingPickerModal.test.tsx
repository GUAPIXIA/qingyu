import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Character, GroupChat } from '../../../shared/types'
import { GreetingPickerModal } from '../group/GreetingPickerModal'
import { useCharacterStore } from '../../store/useCharacterStore'
import { useGroupChatStore } from '../../store/useGroupChatStore'

function makeCharacter(id: string, patch: Partial<Character> = {}): Character {
  const base = useCharacterStore.getState().createCharacter()
  return { ...base, id, name: `角色-${id}`, firstMessage: `${id} 的默认开场白`, ...patch }
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

const insertCharacterMessage = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  insertCharacterMessage.mockResolvedValue(undefined)
  useCharacterStore.setState({
    characters: [
      // 群聊专属开场白优先于 firstMessage
      makeCharacter('char-a', { groupOnlyGreetings: ['群聊专属开场白'] }),
      // 无群聊专属开场白时回退角色卡 firstMessage
      makeCharacter('char-b'),
    ],
  })
  useGroupChatStore.setState({
    currentSessionId: 'session-a',
    currentGroup: makeGroup(),
    messages: [],
    insertCharacterMessage,
  })
})

describe('GreetingPickerModal', () => {
  it('展示成员开场白，点击后以该角色身份插入消息', async () => {
    const onClose = vi.fn()
    render(
      <GreetingPickerModal open group={makeGroup()} messagesCount={0} isStreaming={false} onClose={onClose} />,
    )
    expect(screen.getByText('选择一个开场白开始群聊对话 · 2 位角色')).toBeInTheDocument()
    expect(screen.getByText('群聊专属开场白')).toBeInTheDocument()
    expect(screen.getByText('char-b 的默认开场白')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /群聊专属开场白/ }))
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(insertCharacterMessage).toHaveBeenCalledWith('char-a', '群聊专属开场白'))
  })

  it('点击「跳过，手动开始」只关闭弹窗', () => {
    const onClose = vi.fn()
    render(
      <GreetingPickerModal open group={makeGroup()} messagesCount={0} isStreaming={false} onClose={onClose} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '跳过，手动开始' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(insertCharacterMessage).not.toHaveBeenCalled()
  })

  it('传入 onOpenInit 时提供「AI 统一初始环境 + 系统开场」入口，点击只回调页面', () => {
    const onOpenInit = vi.fn()
    const onClose = vi.fn()
    render(
      <GreetingPickerModal
        open
        group={makeGroup()}
        messagesCount={0}
        isStreaming={false}
        onClose={onClose}
        onOpenInit={onOpenInit}
      />,
    )
    const entry = screen.getByRole('button', { name: 'AI 统一初始环境 + 系统开场' })
    fireEvent.click(entry)
    // 只调回调：不自行关弹窗、不插入任何消息（由页面负责关闭并打开初始化弹窗）
    expect(onOpenInit).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(insertCharacterMessage).not.toHaveBeenCalled()
  })

  it('未传 onOpenInit 时不渲染初始化入口（保持原有底部按钮）', () => {
    render(
      <GreetingPickerModal open group={makeGroup()} messagesCount={0} isStreaming={false} onClose={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: 'AI 统一初始环境 + 系统开场' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '跳过，手动开始' })).toBeInTheDocument()
  })

  it('已有消息或正在生成时不渲染开场白选择', () => {
    const group = makeGroup()
    const { container: withMessages } = render(
      <GreetingPickerModal open group={group} messagesCount={1} isStreaming={false} onClose={vi.fn()} />,
    )
    expect(withMessages).toBeEmptyDOMElement()
    const { container: streaming } = render(
      <GreetingPickerModal open group={group} messagesCount={0} isStreaming onClose={vi.fn()} />,
    )
    expect(streaming).toBeEmptyDOMElement()
  })
})

import { render, screen } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupChat } from '../../../shared/types'
import { GroupChatPage } from '../GroupChatPage'

const mocks = vi.hoisted(() => {
  const group: GroupChat = {
    id: 'group-1',
    name: '夜谈会',
    memberIds: [],
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
  }

  return {
    characterState: { characters: [] },
    personaState: { loadPersonas: vi.fn().mockResolvedValue(undefined) },
    settingsState: { settings: { messageWidth: 768 } },
    virtuosoRender: vi.fn(),
    groupState: {
      groupChats: [group],
      currentGroup: group,
      sessions: [],
      currentSessionId: null,
      messages: [],
      isStreaming: false,
      loadGroups: vi.fn().mockResolvedValue(undefined),
      selectGroup: vi.fn(),
      saveGroup: vi.fn(),
      deleteGroup: vi.fn(),
      createSession: vi.fn(),
      switchSession: vi.fn(),
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      clearChat: vi.fn(),
      deleteMessage: vi.fn(),
      editMessage: vi.fn(),
      regenerateMessage: vi.fn(),
      translateMessage: vi.fn(),
      sendPollingRound: vi.fn(),
      toggleMemory: vi.fn(),
      setMemoryMode: vi.fn(),
      updateMemoryFacts: vi.fn().mockResolvedValue(undefined),
      triggerMemorySummary: vi.fn(),
      buildGroupContext: vi.fn().mockReturnValue([]),
    },
  }
})

vi.mock('../../store/useCharacterStore', () => ({
  useCharacterStore: (selector?: (state: typeof mocks.characterState) => unknown) =>
    selector ? selector(mocks.characterState) : mocks.characterState,
}))

vi.mock('../../store/usePersonaStore', () => ({
  usePersonaStore: (selector: (state: typeof mocks.personaState) => unknown) => selector(mocks.personaState),
}))

vi.mock('../../store/useSettingsStore', () => ({
  useSettingsStore: (selector: (state: typeof mocks.settingsState) => unknown) => selector(mocks.settingsState),
}))

vi.mock('../../store/useGroupChatStore', () => {
  const useGroupChatStore = (selector: (state: typeof mocks.groupState) => unknown) => selector(mocks.groupState)
  useGroupChatStore.getState = () => mocks.groupState
  return { useGroupChatStore }
})

vi.mock('../../components/chat/GroupChatInput', () => ({ GroupChatInput: () => null }))
vi.mock('../../components/chat/GroupMemberBar', () => ({ GroupMemberBar: () => null }))
vi.mock('../../components/chat/GroupPersonaSwitcher', () => ({ GroupPersonaSwitcher: () => null }))
vi.mock('../../components/chat/QuickSettingsPanel', () => ({ QuickSettingsPanel: () => null }))
vi.mock('../../components/chat/MemoryPanel', () => ({ MemoryPanel: () => null }))
vi.mock('../../components/common/SessionSwitcher', () => ({ SessionSwitcher: () => null }))
vi.mock('../group/GreetingPickerModal', () => ({ GreetingPickerModal: () => null }))
vi.mock('../group/NewGroupModal', () => ({ NewGroupModal: () => null }))
vi.mock('react-virtuoso', () => {
  const Virtuoso = (props: Record<string, unknown>, _ref: React.ForwardedRef<HTMLDivElement>) => {
    mocks.virtuosoRender(props)
    return null
  }
  return { Virtuoso: React.forwardRef(Virtuoso) }
})

describe('GroupChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mocks.groupState, { currentSessionId: null, messages: [] })
  })

  it('页头只显示一个群聊设置入口', () => {
    render(<GroupChatPage />)

    expect(screen.getAllByRole('button', { name: /群聊(?:快捷设置|管理)/ })).toHaveLength(1)
    expect(screen.getByRole('button', { name: '群聊快捷设置' })).toBeTruthy()
    expect(screen.getByTestId('group-chat-header')).toHaveClass('h-14', 'bg-tavern-bg-soft', 'px-4')
    expect(screen.getByRole('button', { name: '重命名群聊' })).toBeTruthy()
  })

  it('进入已有消息的群聊时从最后一条消息开始显示', () => {
    Object.assign(mocks.groupState, {
      currentSessionId: 'session-1',
      messages: [{
        id: 'message-1',
        groupId: 'group-1',
        characterId: '__user__',
        content: '最后一条消息',
        images: [],
        timestamp: 1,
        round: 0,
      }],
    })

    render(<GroupChatPage />)

    const virtuosoProps = mocks.virtuosoRender.mock.lastCall?.[0] as Record<string, unknown>
    expect(virtuosoProps.initialTopMostItemIndex).toBe(999999)
  })

  it('消息滚动条跟随对话列宽度而不是贴在程序最右侧', () => {
    Object.assign(mocks.groupState, {
      currentSessionId: 'session-1',
      messages: [{
        id: 'message-1',
        groupId: 'group-1',
        characterId: '__user__',
        content: '对话内容',
        images: [],
        timestamp: 1,
        round: 0,
      }],
    })

    render(<GroupChatPage />)

    expect(screen.getByTestId('group-message-scroll-column')).toHaveStyle({
      maxWidth: '800px',
    })
  })
})

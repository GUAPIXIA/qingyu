import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Character, GroupChat } from '../../../shared/types'
import { GroupChatPage } from '../GroupChatPage'
import {
  clearScrollMemory,
  groupScrollKey,
  loadScrollMemory,
} from '../../utils/scrollMemory'

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
    group,
    characterState: { characters: [] as Character[] },
    personaState: { loadPersonas: vi.fn().mockResolvedValue(undefined) },
    settingsState: { settings: { messageWidth: 768, bubbleStyle: 'round' } },
    virtuosoRender: vi.fn(),
    // UEX-P1-12：「停剩余」语义别名入口（页面经 useGroupChatStore 模块导入）
    stopRemainingSpeakers: vi.fn(),
    groupState: {
      groupChats: [group],
      currentGroup: group,
      sessions: [],
      currentSessionId: null,
      messages: [],
      isStreaming: false,
      currentStreamingCharId: null,
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
  return { useGroupChatStore, stopRemainingSpeakers: mocks.stopRemainingSpeakers }
})

vi.mock('../../components/chat/GroupChatInput', () => ({ GroupChatInput: () => null }))
vi.mock('../../components/chat/GroupMemberBar', () => ({
  // UEX-P1-12：调度条桩——渲染页面传入的接力状态与「停剩余」回调，供接线断言
  GroupMemberBar: (props: {
    memberIds: string[]
    currentStreamingCharId: string | null
    isStreaming: boolean
    onStopRemaining: () => void
  }) => props.isStreaming ? (
    <div data-testid="group-member-bar-stub">
      <span>{props.currentStreamingCharId ?? '无说话者'} · {props.memberIds.length} 位成员</span>
      <button type="button" onClick={props.onStopRemaining}>停剩余</button>
    </div>
  ) : null,
}))
vi.mock('../../components/chat/GroupPersonaSwitcher', () => ({ GroupPersonaSwitcher: () => null }))
vi.mock('../../components/chat/QuickSettingsPanel', () => ({ QuickSettingsPanel: () => null }))
vi.mock('../../components/chat/MemoryPanel', () => ({ MemoryPanel: () => null }))
vi.mock('../../components/common/SessionSwitcher', () => ({ SessionSwitcher: () => null }))
vi.mock('../group/GreetingPickerModal', () => ({
  // 桩：渲染 open 状态与「AI 统一初始环境」入口，供页面级互斥/串联断言
  GreetingPickerModal: (props: { open: boolean; onOpenInit?: () => void }) => props.open ? (
    <div data-testid="greeting-picker-stub">
      <button type="button" onClick={props.onOpenInit}>AI 统一初始环境 + 系统开场</button>
    </div>
  ) : null,
}))
vi.mock('../../components/chat/GroupInitPreambleModal', () => ({
  // 桩：暴露 entry 来源、关闭与「默认开场」串联回调
  GroupInitPreambleModal: (props: {
    open: boolean
    entry: string
    onClose: () => void
    onChooseDefaultOpening: () => void
  }) => props.open ? (
    <div data-testid="group-init-modal-stub" data-entry={props.entry}>
      <button type="button" onClick={props.onClose}>关闭初始化弹窗</button>
      <button type="button" onClick={props.onChooseDefaultOpening}>选择默认开场</button>
    </div>
  ) : null,
}))
vi.mock('../group/NewGroupModal', () => ({ NewGroupModal: () => null }))
vi.mock('react-virtuoso', () => {
  const Virtuoso = (props: Record<string, any>, _ref: React.ForwardedRef<HTMLDivElement>) => {
    mocks.virtuosoRender(props)
    const scrollerElRef = React.useRef<HTMLDivElement>(null)
    React.useEffect(() => {
      const el = scrollerElRef.current
      if (!el) return
      // UEX-P2-12：jsdom 无布局——伪造滚动容器度量（可滚动 2400px），使记录/恢复/钳制可断言
      let scrollTopValue = 0
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: () => scrollTopValue,
        set: (v: number) => { scrollTopValue = v },
      })
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 3000 })
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 600 })
      props.scrollerRef?.(el)
      return () => props.scrollerRef?.(null)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <div ref={scrollerElRef} data-testid="virtuoso-mock-scroller" />
  }
  return { Virtuoso: React.forwardRef(Virtuoso) }
})

describe('GroupChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearScrollMemory()
    mocks.characterState.characters = []
    Object.assign(mocks.groupState, {
      currentGroup: mocks.group,
      currentSessionId: null,
      messages: [],
      isStreaming: false,
      currentStreamingCharId: null,
    })
  })

  it('页头只显示一个群聊设置入口', () => {
    render(<GroupChatPage />)

    expect(screen.getAllByRole('button', { name: /群聊(?:快捷设置|管理)/ })).toHaveLength(1)
    expect(screen.getByRole('button', { name: '群聊快捷设置' })).toBeTruthy()
    expect(screen.getByTestId('group-chat-header')).toHaveClass('h-14', 'bg-tavern-bg-soft', 'px-4')
    expect(screen.getByRole('button', { name: '重命名群聊' })).toBeTruthy()
  })

  it('全局关闭画布后仍保留群聊入口，便于进入画布重新开启', () => {
    const { rerender } = render(<GroupChatPage />)
    expect(screen.getByRole('button', { name: '群聊空间画板' })).toBeTruthy()
    Object.assign(mocks.settingsState.settings, { spatialBoardEnabled: false })
    rerender(<GroupChatPage />)
    expect(screen.getByRole('button', { name: '群聊空间画板' })).toBeTruthy()
    Object.assign(mocks.settingsState.settings, { spatialBoardEnabled: true })
    rerender(<GroupChatPage />)
    expect(screen.getByRole('button', { name: '群聊空间画板' })).toBeTruthy()
  })

  it('画板入口只保留图标，不显示文字标签', () => {
    render(<GroupChatPage />)
    const boardButton = screen.getByRole('button', { name: '群聊空间画板' })
    expect(boardButton.textContent?.trim()).toBe('')
    expect(boardButton).toHaveAttribute('title', '空间画板')
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

  it('消息滚动条固定在消息区右侧，且消息区应用气泡圆角样式类', () => {
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

    // 滚动容器不再按对话列宽度限宽：侧栏收缩时滚动条不再左移
    const column = screen.getByTestId('group-message-scroll-column')
    expect(column.style.maxWidth).toBe('')
    expect(column).toHaveClass('w-full')
    // 消息区带 bubble-* 样式类，保证群聊角色气泡四角统一圆角（此前缺该类导致左下角 2px 直角）
    expect(column.closest('.bubble-round')).not.toBeNull()
  })

  it('UEX-P2-12：切走再回来恢复滚动位置（顶位索引 + scrollTop）', async () => {
    const messages = Array.from({ length: 6 }, (_, i) => ({
      id: `message-${i}`,
      groupId: 'group-1',
      characterId: '__user__',
      content: `消息 ${i}`,
      images: [],
      timestamp: i + 1,
      round: 0,
    }))
    Object.assign(mocks.groupState, { currentSessionId: 'session-1', messages })
    const { rerender } = render(<GroupChatPage />)

    // 模拟用户滚动：顶位索引 2、scrollTop 420
    const props = mocks.virtuosoRender.mock.lastCall?.[0] as Record<string, any>
    const scroller = screen.getByTestId('virtuoso-mock-scroller') as HTMLElement & { scrollTop: number }
    props.rangeChanged?.({ startIndex: 2, endIndex: 5 })
    scroller.scrollTop = 420
    fireEvent.scroll(scroller)
    expect(loadScrollMemory(groupScrollKey('group-1', 'session-1'))).toMatchObject({ topIndex: 2, scrollTop: 420 })

    // 切走（session-2）再回到 session-1：顶位索引恢复 +（消息加载完成后）scrollTop 钳制写回
    Object.assign(mocks.groupState, { currentSessionId: 'session-2', messages: [] })
    rerender(<GroupChatPage />)
    Object.assign(mocks.groupState, { currentSessionId: 'session-1', messages })
    rerender(<GroupChatPage />)

    const restoredProps = mocks.virtuosoRender.mock.lastCall?.[0] as Record<string, any>
    expect(restoredProps.initialTopMostItemIndex).toEqual({ index: 2, align: 'start' })
    await waitFor(() =>
      expect((screen.getByTestId('virtuoso-mock-scroller') as HTMLElement & { scrollTop: number }).scrollTop).toBe(420),
    )
  })

  it('UEX-P1-12：生成中显示群调度条，「停剩余」接通停止动作', () => {
    Object.assign(mocks.groupState, { isStreaming: true, currentStreamingCharId: 'c1' })

    render(<GroupChatPage />)

    // 调度条拿到接力状态（当前说话者 + 成员总数）与「停剩余」动作
    const bar = screen.getByTestId('group-member-bar-stub')
    expect(bar.textContent).toContain('c1')
    fireEvent.click(screen.getByRole('button', { name: '停剩余' }))
    expect(mocks.stopRemainingSpeakers).toHaveBeenCalledTimes(1)
  })

  it('UEX-P1-12：非生成中不显示群调度条', () => {
    render(<GroupChatPage />)
    expect(screen.queryByTestId('group-member-bar-stub')).toBeNull()
  })

  it('空状态主按钮「统一初始环境（AI）」打开初始化弹窗（entry=empty），且不自动弹', () => {
    render(<GroupChatPage />)

    // 初始化弹窗不自动弹（§11.2：入口均为手动点击）
    expect(screen.queryByTestId('group-init-modal-stub')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '统一初始环境（AI）' }))

    expect(screen.getByTestId('group-init-modal-stub')).toHaveAttribute('data-entry', 'empty')
  })

  it('默认开场路径不变：空会话有开场白时自动弹开场白选择器，不弹初始化弹窗', () => {
    mocks.characterState.characters = [
      { id: 'c1', name: '爱丽丝', firstMessage: '早上好。' } as unknown as Character,
    ]
    Object.assign(mocks.groupState, { currentGroup: { ...mocks.group, memberIds: ['c1'] } })

    render(<GroupChatPage />)

    expect(screen.getByTestId('greeting-picker-stub')).toBeTruthy()
    expect(screen.queryByTestId('group-init-modal-stub')).toBeNull()
  })

  it('角色只有备选开场白（首条为空）时也会自动弹开场白选择器', () => {
    mocks.characterState.characters = [
      { id: 'c1', name: '爱丽丝', firstMessage: '', alternateGreetings: ['备选开场白'] } as unknown as Character,
    ]
    Object.assign(mocks.groupState, { currentGroup: { ...mocks.group, memberIds: ['c1'] } })

    render(<GroupChatPage />)

    expect(screen.getByTestId('greeting-picker-stub')).toBeTruthy()
  })

  it('开场白弹窗入口与初始化弹窗互斥；选默认开场后回到开场白选择器', () => {
    mocks.characterState.characters = [
      { id: 'c1', name: '爱丽丝', firstMessage: '早上好。' } as unknown as Character,
    ]
    Object.assign(mocks.groupState, { currentGroup: { ...mocks.group, memberIds: ['c1'] } })

    render(<GroupChatPage />)
    expect(screen.getByTestId('greeting-picker-stub')).toBeTruthy()

    // 开场白弹窗 → 初始化弹窗：关前者、开后者（entry=greeting）
    fireEvent.click(screen.getByRole('button', { name: 'AI 统一初始环境 + 系统开场' }))
    expect(screen.queryByTestId('greeting-picker-stub')).toBeNull()
    expect(screen.getByTestId('group-init-modal-stub')).toHaveAttribute('data-entry', 'greeting')

    // 初始化弹窗选默认开场：关初始化弹窗、重新打开开场白选择器
    fireEvent.click(screen.getByRole('button', { name: '选择默认开场' }))
    expect(screen.queryByTestId('group-init-modal-stub')).toBeNull()
    expect(screen.getByTestId('greeting-picker-stub')).toBeTruthy()
  })

  it('初始化弹窗关闭后回到空状态（入口恢复）', () => {
    render(<GroupChatPage />)

    fireEvent.click(screen.getByRole('button', { name: '统一初始环境（AI）' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭初始化弹窗' }))

    expect(screen.queryByTestId('group-init-modal-stub')).toBeNull()
    expect(screen.getByRole('button', { name: '统一初始环境（AI）' })).toBeTruthy()
  })
})

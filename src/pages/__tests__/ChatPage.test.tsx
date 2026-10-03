import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ChatPage, ImageGenerationPlaceholder } from '../ChatPage'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useCharacterStore } from '../../store/useCharacterStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import {
  chatScrollKey,
  clearScrollMemory,
  loadScrollMemory,
  saveScrollMemory,
} from '../../utils/scrollMemory'
import { getDefaultSettings } from '../../../shared/defaults'
import { registerSpatialFlush } from '../../lib/spatialFlush'
import type { Character, ConnectionProfile, Message } from '../../../shared/types'

// jsdom 无布局测量，Virtuoso 虚拟列表不会渲染 itemContent；mock 为普通列表
// UEX-P2-12：mock 附带假滚动容器（可读写 scrollTop、固定 scrollHeight/clientHeight），
// 并透出每次渲染的 props（含 initialTopMostItemIndex / rangeChanged），供滚动记忆用例驱动
const virtuosoMock = vi.hoisted(() => ({
  renders: [] as Array<Record<string, any>>,
}))

vi.mock('react-virtuoso', () => {
  const Virtuoso = (props: {
    data: unknown[]
    itemContent: (i: number, item: unknown) => React.ReactNode
    components?: { Footer?: React.ComponentType }
    scrollerRef?: (el: unknown) => void
  }, _ref: React.ForwardedRef<HTMLDivElement>) => {
    virtuosoMock.renders.push(props as Record<string, any>)
    const Footer = props.components?.Footer
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
    return (
      <div ref={scrollerElRef} data-testid="virtuoso-mock-scroller">
        {props.data.map((item, i) => props.itemContent(i, item))}
        {Footer ? <Footer /> : null}
      </div>
    )
  }
  return { Virtuoso: React.forwardRef(Virtuoso) }
})

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'char-1', name: 'Alice', avatar: '', description: '', personality: '',
    scenario: '', firstMessage: '你好，我是 Alice', exampleDialog: '', tags: [],
    lorebookId: null, creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
    ...overrides,
  }
}

const PROFILE: ConnectionProfile = {
  id: 'p1', name: 'p', provider: 'openai',
  baseUrl: 'https://api.example.com', apiKey: 'sk-test', model: 'gpt-4o', maxContext: 8192,
}

function setupStores(connected: boolean, character: Character | null) {
  usePersonaStore.setState({ personas: [], loaded: true })
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      userName: 'TestUser',
      activeProfileId: connected ? 'p1' : null,
      connectionProfiles: connected ? [PROFILE] : [],
      activeModel: 'gpt-4o',
    },
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
  useCharacterStore.setState({
    characters: character ? [character] : [],
    currentCharacter: character,
  })
  useChatStore.setState({
    messages: [],
    sessions: [],
    currentSessionId: null,
    isStreaming: false,
    error: null,
    messagesLoading: false,
    activePresetId: null,
    activeLorebookIds: [],
    translatingMessages: {},
    showTranslationIds: new Set(),
    lastContextUsage: null,
    pendingImageGenerations: {},
  })
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>
  )
}

describe('ChatPage 冒烟测试', () => {
  it('画板保存被拒绝时新建对话捕获错误，保留原会话而不产生未处理 Promise', async () => {
    setupStores(true, makeCharacter())
    renderPage()
    await screen.findByPlaceholderText(/输入消息/)
    act(() => useChatStore.setState({ currentSessionId: 'original-session' }))
    const unregister = registerSpatialFlush(async () => { throw new Error('结构调整被拒绝：请先调整角色位置') })
    try {
      fireEvent(window, new Event('shortcut:new-chat'))
      await waitFor(() => expect(useChatStore.getState().error).toContain('结构调整被拒绝'))
      expect(useChatStore.getState().currentSessionId).toBe('original-session')
      expect(window.api.chat.createSession).not.toHaveBeenCalled()
      expect(screen.queryByRole('dialog', { name: /开场白/ })).toBeNull()
    } finally { unregister() }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearScrollMemory()
    // 会话/消息 IPC mock
    ;(window.api.chat as any).listSessions = vi.fn().mockResolvedValue([])
    ;(window.api.chat as any).listMessages = vi.fn().mockResolvedValue([])
    ;(window.api as any).settings.get = vi.fn().mockResolvedValue(getDefaultSettings())
    // quickReply（ChatInput 挂载时拉取）
    ;(window.api as any).quickReply = {
      listAll: vi.fn().mockResolvedValue({ global: [], byCharacter: {} }),
    }
  })

  it('未配置连接时显示欢迎引导', async () => {
    setupStores(false, null)
    const { findByText } = renderPage()
    expect(await findByText('欢迎使用轻语')).toBeTruthy()
    expect(screen.getByText('开始配置')).toBeTruthy()
  })

  it('未配置连接但已选择角色时仍可进入聊天界面', async () => {
    setupStores(false, makeCharacter())
    const { findByPlaceholderText, queryByText } = renderPage()
    expect(await findByPlaceholderText(/请先在「模型 → 对话 API」配置 API 连接/)).toBeTruthy()
    expect(queryByText('欢迎使用轻语')).toBeNull()
  })

  it('已连接但未选择角色时显示空状态', async () => {
    setupStores(true, null)
    const { findByText } = renderPage()
    expect(await findByText('选择一个角色开始对话')).toBeTruthy()
    expect(screen.getByText('前往角色管理')).toBeTruthy()
  })

  it('已连接且有角色时显示输入框', async () => {
    setupStores(true, makeCharacter())
    const { findByPlaceholderText } = renderPage()
    expect(await findByPlaceholderText(/输入消息/)).toBeTruthy()
  })

  it('全局关闭画布后仍保留单聊入口，便于进入画布重新开启', async () => {
    setupStores(true, makeCharacter())
    renderPage()
    await screen.findByPlaceholderText(/输入消息/)
    expect(screen.getByRole('button', { name: '打开空间画板' })).toBeTruthy()
    act(() => useSettingsStore.setState(state => ({ settings: { ...state.settings, spatialBoardEnabled: false } })))
    expect(screen.getByRole('button', { name: '打开空间画板' })).toBeTruthy()
    act(() => useSettingsStore.setState(state => ({ settings: { ...state.settings, spatialBoardEnabled: true } })))
    expect(screen.getByRole('button', { name: '打开空间画板' })).toBeTruthy()
  })

  it('有角色无消息时显示空对话提示', async () => {
    setupStores(true, makeCharacter())
    const { findByText } = renderPage()
    expect(await findByText('开始新的对话')).toBeTruthy()
  })

  it('UEX-P1-34：加载中渲染加载态，不闪现「开始新的对话」假空态', async () => {
    setupStores(true, makeCharacter())
    ;(window.api.chat as any).listSessions = vi.fn().mockResolvedValue([
      { id: 's1', characterId: 'char-1', title: 't', createdAt: 0, updatedAt: 0 },
    ])
    // 挂起消息加载：停留在「清空 → 加载」空窗期
    vi.mocked(window.api.chat.listMessages).mockImplementationOnce(() => new Promise(() => {}))
    const { findByText, queryByText } = renderPage()
    expect(await findByText('正在加载对话…')).toBeTruthy()
    expect(queryByText('开始新的对话')).toBeNull()
  })

  it('有消息时渲染消息气泡', async () => {
    setupStores(true, makeCharacter())
    useChatStore.setState({
      messages: [{
        id: 'm1', sessionId: 's1', characterId: 'char-1', role: 'assistant',
        content: '你好，我是 Alice 的消息内容', images: [], isEditing: false, timestamp: Date.now(),
      }],
      currentSessionId: 's1',
    })
    const { findByText } = renderPage()
    expect(await findByText('你好，我是 Alice 的消息内容')).toBeTruthy()
  })

  it('当前会话生图时在消息列表底部持续显示占位卡', async () => {
    setupStores(true, makeCharacter())
    useChatStore.setState({
      currentSessionId: 's1',
      pendingImageGenerations: {
        'job-1': { id: 'job-1', characterId: 'char-1', sessionId: 's1', stage: 'generating', startedAt: 1 },
      },
    } as any)
    renderPage()
    expect(await screen.findByRole('status', { name: 'ComfyUI 正在生成图片' })).toBeTruthy()
  })

  it('生图加载圈显示在卡片右侧，而不是叠在左侧图片图标上', async () => {
    render(<ImageGenerationPlaceholder stage="prompting" />)

    const status = await screen.findByRole('status', { name: '正在分析场景并生成提示词' })
    const icon = screen.getByTestId('image-generation-icon')
    const loader = screen.getByTestId('image-generation-loader')
    expect(status.lastElementChild).toBe(loader)
    expect(icon.contains(loader)).toBe(false)
    expect(loader).toHaveClass('ml-auto', 'shrink-0')
  })

  it('消息滚动列跟随消息宽度设置，不受固定 780px 上限限制', async () => {
    setupStores(true, makeCharacter())
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, messageWidth: 1024 },
    }))
    useChatStore.setState({
      messages: [{
        id: 'm-wide', sessionId: 's-wide', characterId: 'char-1', role: 'assistant',
        content: '宽屏消息', images: [], isEditing: false, timestamp: Date.now(),
      }],
      currentSessionId: 's-wide',
    })

    renderPage()

    expect(await screen.findByTestId('chat-message-scroll-column')).toHaveStyle({
      maxWidth: '1056px',
    })
  })

  it('启用角色封面背景时通过角色资源协议加载已落盘的封面', async () => {
    const character = makeCharacter({
      cover: '',
      avatar: '',
      chatBackgroundParams: {
        opacity: 20,
        blur: 0,
        type: 'image',
        posX: 50,
        posY: 50,
        scale: 100,
        useCover: true,
      },
    })
    setupStores(true, character)

    const { container } = renderPage()
    await screen.findByPlaceholderText(/输入消息/)

    const background = container.querySelector('img[draggable="false"]') as HTMLImageElement
    expect(background).toBeTruthy()
    expect(background.src).toContain('tavern://character/char-1/cover')
  })
})

describe('ChatPage 滚动记忆（UEX-P2-12）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearScrollMemory()
    ;(window.api as any).settings.get = vi.fn().mockResolvedValue(getDefaultSettings())
    // quickReply（ChatInput 挂载时拉取）
    ;(window.api as any).quickReply = {
      listAll: vi.fn().mockResolvedValue({ global: [], byCharacter: {} }),
    }
  })

  function makeMessages(sessionId: string, count: number): Message[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `${sessionId}-m${i}`,
      sessionId,
      characterId: 'char-1',
      role: 'assistant' as const,
      content: `${sessionId} 的消息 ${i}`,
      images: [],
      isEditing: false,
      timestamp: i,
    }))
  }

  /** 两个会话的 IPC mock：s1 有消息，s2 空 */
  function mockTwoSessions(messagesBySession: Record<string, Message[]>) {
    ;(window.api.chat as any).listSessions = vi.fn().mockResolvedValue([
      { id: 's1', characterId: 'char-1', title: 's1', createdAt: 0, updatedAt: 0 },
      { id: 's2', characterId: 'char-1', title: 's2', createdAt: 0, updatedAt: 0 },
    ])
    ;(window.api.chat as any).listMessages = vi
      .fn()
      .mockImplementation(async (_characterId: string, sessionId: string) => messagesBySession[sessionId] ?? [])
  }

  type FakeScroller = HTMLElement & { scrollTop: number }

  it('UEX-P2-12：切走再回来恢复滚动位置（顶位索引 + scrollTop）', async () => {
    setupStores(true, makeCharacter())
    const s1Messages = makeMessages('s1', 6)
    mockTwoSessions({ s1: s1Messages, s2: [] })
    renderPage()
    // 等挂载加载链（loadSessions → loadMessages）完成
    await waitFor(() => expect(useChatStore.getState().messages).toHaveLength(6))

    // 模拟用户滚动：顶位索引 2、scrollTop 420
    const scroller = screen.getByTestId('virtuoso-mock-scroller') as FakeScroller
    const props = virtuosoMock.renders[virtuosoMock.renders.length - 1]
    props.rangeChanged?.({ startIndex: 2, endIndex: 5 })
    scroller.scrollTop = 420
    fireEvent.scroll(scroller)

    // 切走（切到 s2）：滚动位置应已按会话粒度记录
    const character = makeCharacter()
    await act(async () => {
      await useChatStore.getState().switchSession('s2', character)
    })
    expect(loadScrollMemory(chatScrollKey('char-1', 's1'))).toMatchObject({ topIndex: 2, scrollTop: 420 })

    // 回到 s1：顶位索引恢复 +（消息加载完成后）scrollTop 钳制写回
    await act(async () => {
      await useChatStore.getState().switchSession('s1', character)
    })
    await waitFor(() => expect(useChatStore.getState().messages).toHaveLength(6))
    const restoredProps = virtuosoMock.renders[virtuosoMock.renders.length - 1]
    expect(restoredProps.initialTopMostItemIndex).toEqual({ index: 2, align: 'start' })
    await waitFor(() =>
      expect((screen.getByTestId('virtuoso-mock-scroller') as FakeScroller).scrollTop).toBe(420),
    )
  })

  it('UEX-P2-12：恢复位置超出最大滚动高度时钳制到合法值', async () => {
    setupStores(true, makeCharacter())
    mockTwoSessions({ s1: makeMessages('s1', 6) })
    // 记录的 scrollTop 远超假滚动容器的最大滚动高度（3000 - 600 = 2400）
    saveScrollMemory(chatScrollKey('char-1', 's1'), { topIndex: 1, scrollTop: 99999 })
    renderPage()
    await waitFor(() => expect(useChatStore.getState().messages).toHaveLength(6))
    await waitFor(() =>
      expect((screen.getByTestId('virtuoso-mock-scroller') as FakeScroller).scrollTop).toBe(2400),
    )
  })

  it('UEX-P2-12：新会话（无记忆）保持现状——默认到底', async () => {
    setupStores(true, makeCharacter())
    mockTwoSessions({ s1: makeMessages('s1', 6) })
    renderPage()
    await waitFor(() => expect(useChatStore.getState().messages).toHaveLength(6))
    const props = virtuosoMock.renders[virtuosoMock.renders.length - 1]
    expect(props.initialTopMostItemIndex).toBe(999999)
  })
})

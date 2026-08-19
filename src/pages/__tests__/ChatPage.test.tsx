import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ChatPage } from '../ChatPage'
import { useChatStore } from '../../store/useChatStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useCharacterStore } from '../../store/useCharacterStore'
import { usePersonaStore } from '../../store/usePersonaStore'
import { getDefaultSettings } from '../../../shared/defaults'
import type { Character, ConnectionProfile } from '../../../shared/types'

// jsdom 无布局测量，Virtuoso 虚拟列表不会渲染 itemContent；mock 为普通列表
vi.mock('react-virtuoso', () => {
  const Virtuoso = (props: { data: unknown[]; itemContent: (i: number, item: unknown) => React.ReactNode }, _ref: React.ForwardedRef<HTMLDivElement>) => (
    <div>{props.data.map((item, i) => props.itemContent(i, item))}</div>
  )
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
    activePresetId: null,
    activeLorebookIds: [],
    translatingMessages: {},
    showTranslationIds: new Set(),
    lastContextUsage: null,
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
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
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
    expect(await findByPlaceholderText(/请先在设置中配置 API 连接/)).toBeTruthy()
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

  it('有角色无消息时显示空对话提示', async () => {
    setupStores(true, makeCharacter())
    const { findByText } = renderPage()
    expect(await findByText('开始新的对话')).toBeTruthy()
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
})

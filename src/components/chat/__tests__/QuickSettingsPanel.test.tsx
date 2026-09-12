import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Character, GroupChat, Message } from '../../../../shared/types'
import { useCharacterStore } from '../../../store/useCharacterStore'
import { useChatStore } from '../../../store/useChatStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { QuickSettingsPanel } from '../QuickSettingsPanel'

const character: Character = {
  id: 'char-1', name: 'Alice', avatar: '', description: '', personality: '',
  scenario: '', firstMessage: '', exampleDialog: '', tags: [], lorebookId: null,
  creator: '', createdAt: 0, updatedAt: 0, alternateGreetings: [],
}

const imageMessage: Message = {
  id: 'message-1', sessionId: 'session-1', characterId: 'char-1', role: 'assistant',
  content: '', images: ['data:image/png;base64,test'], isEditing: false, timestamp: 0,
}

describe('QuickSettingsPanel', () => {
  beforeEach(() => {
    useChatStore.setState({
      activePresetId: null,
      activeLorebookIds: [],
      currentSessionId: 'session-1',
      isStreaming: false,
      sessions: [{
        id: 'session-1', characterId: 'char-1', title: '测试会话', createdAt: 0, updatedAt: 0,
        memoryEnabled: false, memoryMode: 'manual', autoMemoryInterval: 10, memory: '', memoryUpdatedAt: 0,
        messageCount: 0, lastMessage: '', narrativeMode: 'immersive',
      }],
    })
    useCharacterStore.setState({ characters: [character], currentCharacter: character })
    useSettingsStore.setState({
      settings: getDefaultSettings(),
      credentials: {},
      loaded: true,
      _saveTimer: null,
    })
  })

  afterEach(() => {
    const timer = useSettingsStore.getState()._saveTimer
    if (timer) clearTimeout(timer)
    useSettingsStore.setState({ _saveTimer: null })
  })

  it('集中提供原更多菜单中的全部对话操作', async () => {
    render(
      <QuickSettingsPanel
        open
        onClose={vi.fn()}
        messages={[imageMessage]}
        onShowContextViewer={vi.fn()}
        onShowBgPanel={vi.fn()}
        onExport={vi.fn()}
        onClearConfirm={vi.fn()}
      />,
    )
    await act(async () => {})

    expect(screen.getByText('对话操作')).toBeTruthy()
    expect(screen.getByText('自动滚动')).toBeTruthy()
    expect(screen.getByRole('button', { name: '查看上下文' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '聊天背景' })).toBeTruthy()
    expect(screen.getByText('生图历史')).toBeTruthy()
    expect(screen.getByRole('button', { name: '导出对话' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '清空对话' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制生图数据 1' })).toBeTruthy()

    fireEvent.click(screen.getByRole('switch', { name: '自动滚动' }))
    expect(useSettingsStore.getState().settings.autoScroll).toBe(false)
  })

  it('打开上下文后关闭快捷设置面板，避免面板重叠', async () => {
    const onClose = vi.fn()
    const onShowContextViewer = vi.fn()
    render(
      <QuickSettingsPanel
        open
        onClose={onClose}
        messages={[]}
        onShowContextViewer={onShowContextViewer}
        onShowBgPanel={vi.fn()}
        onExport={vi.fn()}
        onClearConfirm={vi.fn()}
      />,
    )
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: '查看上下文' }))
    expect(onShowContextViewer).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('不再重复显示已移至对话顶栏的叙事模式', async () => {
    render(
      <QuickSettingsPanel
        open
        onClose={vi.fn()}
        messages={[imageMessage]}
        onShowContextViewer={vi.fn()}
        onShowBgPanel={vi.fn()}
        onExport={vi.fn()}
        onClearConfirm={vi.fn()}
      />,
    )
    await act(async () => {})

    expect(screen.queryByRole('radiogroup', { name: '叙事模式' })).toBeNull()
  })

  it('不在快捷设置中显示自动生图和图片尺寸调节', async () => {
    render(
      <QuickSettingsPanel
        open
        onClose={vi.fn()}
        messages={[]}
        onShowContextViewer={vi.fn()}
        onShowBgPanel={vi.fn()}
        onExport={vi.fn()}
        onClearConfirm={vi.fn()}
      />,
    )
    await act(async () => {})

    expect(screen.queryByText('AI 生图')).toBeNull()
    expect(screen.queryByRole('switch', { name: /自动生图/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '512x512' })).toBeNull()
  })

  it('右侧对话示例说明向面板内侧展开，避免被窗口裁切', async () => {
    render(
      <QuickSettingsPanel
        open
        onClose={vi.fn()}
        messages={[]}
        onShowContextViewer={vi.fn()}
        onShowBgPanel={vi.fn()}
        onExport={vi.fn()}
        onClearConfirm={vi.fn()}
      />,
    )
    await act(async () => {})

    const row = screen.getByText('对话示例发送').parentElement
    expect(row).toBeTruthy()
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: '查看说明' }))
    const hint = screen.getByText(/角色卡「对话示例」会作为/).parentElement
    expect(hint?.className).toContain('right-0')
    expect(hint?.className).not.toContain('left-0')
  })

  it('统一关闭、刷新和连接测试按钮的图标容器样式', async () => {
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        activeProfileId: 'profile-1',
        connectionProfiles: [{
          id: 'profile-1', name: '测试连接', provider: 'openai', apiKey: 'sk-test',
          baseUrl: 'https://api.example.com/v1', model: 'model-a', maxContext: 8192,
        }],
      },
    }))
    vi.mocked(window.api.ai.listModels).mockResolvedValueOnce({ success: true, models: ['model-a'] })
    render(
      <QuickSettingsPanel
        open
        onClose={vi.fn()}
        messages={[]}
        onShowContextViewer={vi.fn()}
        onShowBgPanel={vi.fn()}
        onExport={vi.fn()}
        onClearConfirm={vi.fn()}
      />,
    )

    const refreshButton = await screen.findByRole('button', { name: '刷新模型列表' })
    const buttons = [
      screen.getByRole('button', { name: '关闭快捷设置' }),
      refreshButton,
      screen.getByRole('button', { name: '测试连接' }),
    ]
    for (const button of buttons) {
      expect(button.className).toContain('h-7')
      expect(button.className).toContain('w-7')
      expect(button.className).toContain('rounded-lg')
    }
  })

  it('显示世界书瀑布预算预览', async () => {
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        activeProfileId: 'profile-1',
        lorebookRatio: 0.3,
        connectionProfiles: [{
          id: 'profile-1', name: '测试连接', provider: 'openai', apiKey: 'sk-test',
          baseUrl: 'https://api.example.com/v1', model: 'model-a', maxContext: 8192,
        }],
      },
    }))
    render(
      <QuickSettingsPanel
        open
        onClose={vi.fn()}
        messages={[]}
        onShowContextViewer={vi.fn()}
        onShowBgPanel={vi.fn()}
        onExport={vi.fn()}
        onClearConfirm={vi.fn()}
      />,
    )
    await act(async () => {})
    expect(screen.getByText('预算预览')).toBeTruthy()
    expect(screen.getByText(/常驻上限 40%/)).toBeTruthy()
    expect(screen.getByText(/常驻\+条件累计 90%/)).toBeTruthy()
  })

  it('群聊模式提供与单聊一致的快捷设置并保存群聊级预设', async () => {
    const group: GroupChat = {
      id: 'g1', name: '夜谈会', memberIds: ['char-1'], currentSpeakerIndex: 0,
      autoMode: false, chatMode: 'polling', maxRounds: 1, speakerInterval: 2000,
      lorebookIds: [], presetId: null, systemPrompt: '', createdAt: 0, updatedAt: 0,
    }
    const onSaveGroup = vi.fn()
    vi.mocked(window.api.preset.list).mockResolvedValueOnce([{
      id: 'preset-1', name: '群像叙事', description: '', systemPrompt: '', jailbreak: '', temperature: 0.8,
      topP: 0.95, maxTokens: 1024, frequencyPenalty: 0, presencePenalty: 0,
      maxContext: 8192, isBuiltin: false,
    }])

    render(
      <QuickSettingsPanel
        open
        group={group}
        onSaveGroup={onSaveGroup}
        onClose={vi.fn()}
        messages={[]}
        onShowContextViewer={vi.fn()}
        onShowBgPanel={vi.fn()}
        onExport={vi.fn()}
        onClearConfirm={vi.fn()}
      />,
    )

    expect(await screen.findByText('群聊快捷设置')).toBeTruthy()
    expect(screen.getByText('接力设置')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /@点名/ })).toBeNull()
    fireEvent.change(screen.getByLabelText('群聊预设'), { target: { value: 'preset-1' } })
    expect(onSaveGroup).toHaveBeenCalledWith(expect.objectContaining({ presetId: 'preset-1' }))
  })
})

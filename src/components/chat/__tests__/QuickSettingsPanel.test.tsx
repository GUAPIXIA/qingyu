import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Character, Message } from '../../../../shared/types'
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
    useChatStore.setState({ activePresetId: null, activeLorebookIds: [] })
    useCharacterStore.setState({ characters: [character], currentCharacter: character })
    useSettingsStore.setState({
      settings: getDefaultSettings(),
      credentials: {},
      loaded: true,
      _saveTimer: null,
    })
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
    expect(screen.getByRole('button', { name: '复制生图 1' })).toBeTruthy()

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
})

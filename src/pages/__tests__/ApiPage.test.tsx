import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { getDefaultSettings } from '../../../shared/defaults'
import type { ConnectionProfile } from '../../../shared/types'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useToastStore } from '../../store/useToastStore'
import { ApiPage } from '../ApiPage'

describe('模型页面', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useSettingsStore.setState({
      settings: getDefaultSettings(),
      credentials: {},
      loaded: true,
      _saveTimer: null,
    })
    vi.mocked(window.api.localModel.catalog).mockResolvedValue([])
    vi.mocked(window.api.localModel.installed).mockResolvedValue([])
    vi.mocked(window.api.localModel.tasks).mockResolvedValue([])
    vi.mocked(window.api.localModel.storageUsage).mockResolvedValue({ modelBytes: 0, indexBytes: 0, stagingBytes: 0, totalBytes: 0 })
    vi.mocked(window.api.localModel.onProgress).mockReturnValue(() => {})
  })

  it('使用模型标题并提供语义检索页签', async () => {
    render(<ApiPage />)

    expect(screen.getByRole('heading', { name: '模型' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '语义检索' }))
    expect(await screen.findByRole('heading', { name: '语义检索' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: '检索策略' })).toBeTruthy()
  })

  it('添加连接未填写名称时点击保存会显示校验提示', () => {
    render(<ApiPage />)

    fireEvent.click(screen.getByRole('button', { name: '添加连接' }))
    const saveButton = screen.getByRole('button', { name: '保存' })

    expect(saveButton).not.toBeDisabled()
    fireEvent.click(saveButton)

    expect(screen.getByRole('alert')).toHaveTextContent('请填写连接名称')
    expect(window.api.settings.save).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText('连接名称（如：我的DeepSeek）'), {
      target: { value: '测试连接' },
    })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(saveButton)
    expect(useSettingsStore.getState().settings.connectionProfiles[0].name).toBe('测试连接')
  })

  it('UEX-P1-24：保存成功有就地反馈', () => {
    render(<ApiPage />)

    fireEvent.click(screen.getByRole('button', { name: '添加连接' }))
    fireEvent.change(screen.getByPlaceholderText('连接名称（如：我的DeepSeek）'), {
      target: { value: '新连接' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('连接已创建')
  })

  it('UEX-P1-25：编辑有未保存修改时切换目标先经确认', async () => {
    const p1: ConnectionProfile = {
      id: 'p1', name: '连接一', provider: 'openai',
      baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '', maxContext: 131072,
    }
    const p2: ConnectionProfile = {
      id: 'p2', name: '连接二', provider: 'openai',
      baseUrl: 'https://api.deepseek.com', model: '', apiKey: '', maxContext: 131072,
    }
    useSettingsStore.setState({
      settings: { ...getDefaultSettings(), connectionProfiles: [p1, p2], activeProfileId: 'p1' },
    })
    render(<ApiPage />)

    // 打开连接一编辑并修改名称（未保存）
    fireEvent.click(screen.getByText('连接一'))
    fireEvent.change(screen.getByPlaceholderText('连接名称（如：我的DeepSeek）'), {
      target: { value: '改名了' },
    })

    // 切换到连接二：应先弹出放弃修改确认
    fireEvent.click(screen.getByText('连接二'))
    expect(await screen.findByText('放弃未保存的修改？')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))
    expect((screen.getByPlaceholderText('连接名称（如：我的DeepSeek）') as HTMLInputElement).value).toBe('连接二')
    // 原连接一未被修改
    expect(useSettingsStore.getState().settings.connectionProfiles[0].name).toBe('连接一')
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsPage } from '../SettingsPage'
import { useSettingsStore } from '../../store/useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'

describe('SettingsPage 冒烟测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useSettingsStore.setState({
      settings: { ...getDefaultSettings(), activeProfileId: null },
      credentials: {},
      loaded: true,
      _saveTimer: null,
    })
    // 自定义字体 IPC mock（AppearanceSection 挂载时拉取）
    ;(window.api.font as any) = {
      listFonts: vi.fn().mockResolvedValue([]),
      selectFont: vi.fn().mockResolvedValue(null),
      saveFont: vi.fn().mockResolvedValue({ id: 'f1', name: 'F', fileName: 'f.ttf', format: 'ttf', size: 1, createdAt: 0 }),
      deleteFont: vi.fn().mockResolvedValue(undefined),
      getFontPath: vi.fn().mockResolvedValue('file:///f.ttf'),
    }
    // settings.get 返回完整默认值（loadSettings 会整体覆盖 settings）
    ;(window.api.settings as any).get = vi.fn().mockResolvedValue(getDefaultSettings())
  })

  it('渲染设置页标题', () => {
    const { getByText } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    expect(getByText('设置')).toBeTruthy()
  })

  it('渲染 API 设置与数据管理区块', async () => {
    const { findByText } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    // SectionCard 默认折叠，仅断言标题可见
    expect(await findByText('API 设置')).toBeTruthy()
    expect(await findByText('数据管理')).toBeTruthy()
    expect(await findByText('网络')).toBeTruthy()
  })

  it('点击导出备份调用 window.api.settings.exportBackup', async () => {
    const { findByText } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    fireEvent.click(await findByText('导出备份'))
    await waitFor(() => {
      expect(window.api.settings.exportBackup).toHaveBeenCalled()
    })
  })

  it('点击导入备份调用 window.api.settings.importBackup', async () => {
    vi.mocked(window.api.settings.importBackup).mockResolvedValue(undefined)
    const { findByText } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    fireEvent.click(await findByText('导入备份'))
    await waitFor(() => {
      expect(window.api.settings.importBackup).toHaveBeenCalled()
    })
  })

  it('导入成功显示提示信息', async () => {
    vi.mocked(window.api.settings.importBackup).mockResolvedValue(undefined)
    const { findByText } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    fireEvent.click(await findByText('导入备份'))
    expect(await findByText('导入成功，正在刷新...')).toBeTruthy()
  })

  it('导入失败显示错误信息', async () => {
    vi.mocked(window.api.settings.importBackup).mockRejectedValue(new Error('文件损坏'))
    const { findByText } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    fireEvent.click(await findByText('导入备份'))
    expect(await findByText('文件损坏')).toBeTruthy()
  })

  it('渲染网络区块（封面下载代理配置）', async () => {
    const { findByText } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    expect(await findByText('网络')).toBeTruthy()
    expect(screen.getByPlaceholderText('http://127.0.0.1:7890')).toBeTruthy()
  })

  it('修改封面代理输入框调用 updateSettings', async () => {
    const { findByPlaceholderText } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    const input = (await findByPlaceholderText('http://127.0.0.1:7890')) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'http://127.0.0.1:1080' } })
    expect(useSettingsStore.getState().settings.coverProxyUrl).toBe('http://127.0.0.1:1080')
  })
})

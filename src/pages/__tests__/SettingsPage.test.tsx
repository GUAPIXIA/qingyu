import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor, act, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsPage } from '../SettingsPage'
import { useSettingsStore } from '../../store/useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'

describe('SettingsPage 冒烟测试', () => {
  afterEach(() => {
    const timer = useSettingsStore.getState()._saveTimer
    if (timer) clearTimeout(timer)
    act(() => useSettingsStore.setState({ _saveTimer: null }))
  })

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

  it('渲染设置页标题', async () => {
    const { getByText } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    await act(async () => {}) // 冲刷挂载异步（listFonts / settings.get）
    expect(getByText('设置')).toBeTruthy()
  })

  it('渲染模型与数据管理区块', async () => {
    const { findByText } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    // S2-D 后左侧目录与 SectionCard 标题分别有对应入口
    expect(await screen.findByRole('heading', { name: '模型' })).toBeTruthy()
    expect(await findByText('导出备份')).toBeTruthy()
    expect(screen.queryByText('作者注释')).toBeNull()
  })

  it('将软件更新放在设置目录和内容区最上方', async () => {
    const { getByTestId } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    await act(async () => {})

    const nav = screen.getByRole('navigation', { name: '设置分区' })
    expect(nav.querySelector('button')?.textContent).toContain('软件更新')
    expect(getByTestId('settings-sections').firstElementChild?.id).toBe('settings-updater')
  })

  it('通过 settings-updater 锚点定位软件更新区', async () => {
    const originalScrollIntoView = Element.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      render(
        <MemoryRouter initialEntries={['/settings#settings-updater']}>
          <SettingsPage />
        </MemoryRouter>
      )
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView
    }
  })

  it('将语义检索与用户人设配置移出设置页', async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    await act(async () => {})

    const nav = screen.getByRole('navigation', { name: '设置分区' })
    const labels = [...nav.querySelectorAll('button')].map((button) => button.textContent?.trim())
    expect(labels).not.toContain('语义检索')
    expect(labels).not.toContain('本地模型')
    expect(labels).not.toContain('语义')
    expect(labels).not.toContain('用户人设')
    expect(screen.queryByText('用户人设注入')).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: '检索策略' })).toBeNull()
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
    vi.mocked(window.api.settings.importBackup).mockResolvedValue({ status: 'success', counts: { characters: 1, lorebooks: 1, presets: 1 } })
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
    vi.mocked(window.api.settings.importBackup).mockResolvedValue({ status: 'success', counts: { characters: 1, lorebooks: 1, presets: 1 } })
    const { findByText } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    fireEvent.click(await findByText('导入备份'))
    expect(await findByText(/导入成功/)).toBeTruthy()
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
    const { findByPlaceholderText, findAllByText } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    expect((await findAllByText('网络')).length).toBeGreaterThanOrEqual(1)
    expect(await findByPlaceholderText('http://127.0.0.1:7890')).toBeTruthy()
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

  it('消息宽度最高可设置为 1600px', async () => {
    const { container } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    await act(async () => {})

    const widthSlider = container.querySelector('input[type="range"][min="400"]') as HTMLInputElement
    expect(widthSlider).toBeTruthy()
    expect(widthSlider.max).toBe('1600')
  })

  it('可设置新建对话默认开启长记忆', async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    await act(async () => {})

    const toggle = screen.getByRole('switch', { name: '新建对话默认开启长记忆' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(useSettingsStore.getState().settings.defaultMemoryEnabled).toBe(true)
  })

  it('可设置新建对话默认叙事模式', async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    )
    await act(async () => {})

    const omniscient = screen.getByRole('radio', { name: '全局叙事' })
    expect(omniscient.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(omniscient)
    expect(useSettingsStore.getState().settings.defaultNarrativeMode).toBe('omniscient')
  })
})

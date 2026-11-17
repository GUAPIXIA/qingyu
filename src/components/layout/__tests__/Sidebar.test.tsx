import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { ConnectionProfile, Settings } from '../../../../shared/types'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useUIStore } from '../../../store/useUIStore'
import { Sidebar } from '../Sidebar'
import { registerSpatialFlush } from '../../../lib/spatialFlush'

function LocationProbe() {
  const location = useLocation()
  return <output aria-label="当前位置">{location.pathname}{location.hash}</output>
}

const PROFILE: ConnectionProfile = {
  id: 'p-1',
  name: 'OpenCode Go',
  provider: 'openai',
  baseUrl: 'https://example.com/v1',
  model: 'gpt-4o',
  apiKey: 'sk-test',
  maxContext: 8192,
}

function setSettings(overrides: Partial<Settings> = {}) {
  useSettingsStore.setState({
    settings: { ...getDefaultSettings(), activeProfileId: null, ...overrides },
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
}

function renderSidebar(initialPath = '/chat') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Sidebar />
      <LocationProbe />
    </MemoryRouter>,
  )
}

describe('Sidebar', () => {
  beforeEach(() => {
    localStorage.clear()
    useUIStore.setState({ sidebarCollapsed: false })
    setSettings()
    ;(window.api.app as any).getVersion = vi.fn().mockResolvedValue('0.12.1')
    ;(window.api.app as any).checkVersion = vi.fn().mockResolvedValue(null)
  })

  it('用白底 + 左侧强调条标记当前页面对应的入口，且不再有分组折叠按钮', async () => {
    renderSidebar('/api')
    await act(async () => {})

    const activeLink = screen.getByRole('link', { name: '模型' })
    expect(activeLink.className).toContain('bg-tavern-bg-card')
    expect(activeLink.className).toContain('after:bg-tavern-accent')

    // 分组标题 / 折叠箭头已移除：常驻三段 + 更多浮层取代
    expect(screen.queryByRole('button', { name: '核心' })).toBeNull()
    expect(screen.queryByRole('button', { name: '服务' })).toBeNull()
    expect(screen.queryByRole('button', { name: '系统' })).toBeNull()
  })

  it('低频入口收进「更多」浮层：默认不可见，展开后可导航并自动收起', async () => {
    renderSidebar('/chat')
    await act(async () => {})

    // 展开态：帮助 / 公告常驻底部图标行，其余低频入口在「更多」里
    expect(screen.getByRole('link', { name: '帮助' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '公告' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '正则' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    for (const label of ['快捷回复', '正则', 'MCP', '用量']) {
      expect(await screen.findByRole('link', { name: label })).toBeInTheDocument()
    }
    // 底部已有的帮助 / 公告不在浮层里重复出现
    expect(screen.getAllByRole('link', { name: '帮助' })).toHaveLength(1)
    expect(screen.getAllByRole('link', { name: '公告' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('link', { name: '正则' }))
    await act(async () => {})
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/regex')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '更多入口' })).toBeNull())
  })

  it('Escape 关闭「更多」浮层', async () => {
    renderSidebar()
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(await screen.findByRole('dialog', { name: '更多入口' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '更多入口' })).toBeNull())
  })

  it('收起态仍可通过「更多」浮层进入低频入口', async () => {
    useUIStore.setState({ sidebarCollapsed: true })
    renderSidebar()
    await act(async () => {})

    // 收起态没有底部图标行：帮助 / 公告 回落到「更多」，不额外占用图标轨
    expect(screen.queryByRole('link', { name: '公告' })).toBeNull()
    expect(screen.queryByRole('link', { name: '帮助' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(await screen.findByRole('link', { name: '快捷回复' })).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: '帮助' })).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: '公告' })).toBeInTheDocument()
  })

  it('底部状态展示当前模型名（未连接时展示未连接）', async () => {
    renderSidebar()
    await act(async () => {})
    expect(screen.getByText('未连接')).toBeInTheDocument()

    setSettings({ activeProfileId: PROFILE.id, activeModel: 'deepseek-v4.1-flash', connectionProfiles: [PROFILE] })
    await act(async () => {})
    expect(screen.getByText('deepseek-v4.1-flash')).toBeInTheDocument()
  })

  it('有新版本时只在「设置」入口显示提示点', async () => {
    ;(window.api.app as any).checkVersion = vi.fn().mockResolvedValue({
      version: '0.13.0',
      changelog: '',
      downloadUrl: 'https://example.com/app.exe',
    })
    renderSidebar('/chat')

    expect(screen.queryByText('轻语')).not.toBeInTheDocument()
    expect(await screen.findByText('有新版本可用')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('link', { name: '设置' }))
    await act(async () => {})
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/settings')
  })

  it.each([false, true])('侧栏收起=%s 时，画板保存失败不导航，成功确认后才离开', async (collapsed) => {
    useUIStore.setState({ sidebarCollapsed: collapsed })
    renderSidebar('/chat')
    const link = await screen.findByRole('link', { name: '角色卡' })
    let complete!: () => void
    let fail = true
    const unregister = registerSpatialFlush(() => fail ? Promise.reject(new Error('画板冲突'))
      : new Promise(resolve => { complete = resolve }))
    try {
      fireEvent.click(link)
      await act(async () => {})
      expect(screen.getByLabelText('当前位置')).toHaveTextContent('/chat')
      fail = false
      fireEvent.click(link)
      expect(screen.getByLabelText('当前位置')).toHaveTextContent('/chat')
      await act(async () => complete())
      expect(screen.getByLabelText('当前位置')).toHaveTextContent('/characters')
    } finally { unregister() }
  })
})

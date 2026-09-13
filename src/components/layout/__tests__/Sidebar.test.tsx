import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { getDefaultSettings } from '../../../../shared/defaults'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useUIStore } from '../../../store/useUIStore'
import { Sidebar } from '../Sidebar'

function LocationProbe() {
  const location = useLocation()
  return <output aria-label="当前位置">{location.pathname}{location.hash}</output>
}

describe('Sidebar', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('sidebar-groups-collapsed', JSON.stringify({
      core: true,
      resource: true,
      service: true,
      system: true,
    }))
    useUIStore.setState({ sidebarCollapsed: false })
    useSettingsStore.setState({
      settings: { ...getDefaultSettings(), activeProfileId: null },
      credentials: {},
      loaded: true,
      _saveTimer: null,
    })
    ;(window.api.app as any).getVersion = vi.fn().mockResolvedValue('0.12.1')
    ;(window.api.app as any).checkVersion = vi.fn().mockResolvedValue(null)
    ;(window.api.app as any).openExternal = vi.fn().mockResolvedValue(undefined)
  })

  it('自动展开当前页面所在分组，并用轻底色和细强调条标记当前项', async () => {
    render(
      <MemoryRouter initialEntries={['/api']}>
        <Sidebar />
      </MemoryRouter>,
    )
    await act(async () => {})

    await waitFor(() => expect(screen.getByRole('button', { name: '服务' })).toHaveAttribute('aria-expanded', 'true'))
    const activeLink = screen.getByRole('link', { name: '模型' })
    expect(activeLink.className).toContain('bg-tavern-bg-card')
    expect(activeLink.className).toContain('after:bg-tavern-accent')
    expect(activeLink.className).not.toContain('bg-tavern-accent-soft')
  })

  it('展开分组时把该分组滚入可视区，导航容器保持可收缩滚动（P1-04）', async () => {
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView as never
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/chat']}>
          <Sidebar />
        </MemoryRouter>,
      )
      await act(async () => {})

      // 多组展开时导航必须能在 flex 列内收缩滚动，底部状态区才不会被推出视口
      const nav = container.querySelector('nav')
      expect(nav?.className).toContain('min-h-0')
      expect(nav?.className).toContain('overflow-y-auto')

      fireEvent.click(screen.getByRole('button', { name: '资源' }))
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
      const target = scrollIntoView.mock.instances[0] as HTMLElement | undefined
      expect(target?.getAttribute('data-nav-group')).toBe('resource')
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('点击公告版本进入设置的软件更新区，不再打开 GitHub', async () => {
    ;(window.api.app as any).checkVersion = vi.fn().mockResolvedValue({
      version: '0.13.0',
      changelog: '',
      downloadUrl: 'https://example.com/app.exe',
    })
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <Sidebar />
        <LocationProbe />
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByTitle('公告版本 v0.13.0 可用，前往软件更新'))
    expect(await screen.findByText('/settings#settings-updater')).toBeInTheDocument()
    expect(window.api.app.openExternal).not.toHaveBeenCalled()
    expect(screen.queryByTitle('前往 GitHub 主页')).not.toBeInTheDocument()
  })
})

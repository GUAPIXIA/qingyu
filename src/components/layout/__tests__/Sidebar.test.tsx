import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { getDefaultSettings } from '../../../../shared/defaults'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useUIStore } from '../../../store/useUIStore'
import { Sidebar } from '../Sidebar'

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
    const activeLink = screen.getByRole('link', { name: 'API' })
    expect(activeLink.className).toContain('bg-tavern-bg-card')
    expect(activeLink.className).toContain('after:bg-tavern-accent')
    expect(activeLink.className).not.toContain('bg-tavern-accent-soft')
  })
})

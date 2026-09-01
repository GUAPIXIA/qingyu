import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { getDefaultSettings } from '../../../shared/defaults'
import { useSettingsStore } from '../../store/useSettingsStore'
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
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/defaults'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useToastStore } from '../../../store/useToastStore'
import { TTSModelsSection } from '../TTSModelsSection'

/**
 * DeepSeek TTS 设置项接线（2026-11-16）：
 * - 「添加 TTS 模型」里能选中 DeepSeek TTS，并套用默认端点 / 默认音色；
 * - DeepSeek 没有模型参数，不显示「模型名称」；
 * - 「测试连接」走真实合成路径（tts.speak provider=deepseek + stella + 默认端点）。
 */

const speakMock = vi.fn()

function setupStore() {
  useSettingsStore.setState({
    settings: { ...getDefaultSettings(), ttsEnabled: true, ttsModels: [], activeTTSModelId: null },
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
  useToastStore.setState({ toasts: [] })
}

describe('TTSModelsSection（DeepSeek TTS）', () => {
  beforeEach(() => {
    speakMock.mockReset()
    speakMock.mockResolvedValue({ success: true, audioBase64: 'AQID', audioMime: 'audio/wav' })
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...(window as unknown as { api: Record<string, unknown> }).api,
      tts: {
        speak: speakMock,
        stop: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn().mockResolvedValue(undefined),
        resume: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockResolvedValue({ state: 'idle' }),
        onState: vi.fn().mockReturnValue(() => {}),
        listVoices: vi.fn().mockResolvedValue([]),
      },
    }
    setupStore()
  })

  it('可选中 DeepSeek TTS：套用默认端点/音色，且不显示模型名称', () => {
    render(<TTSModelsSection />)

    fireEvent.click(screen.getByRole('button', { name: /添加 TTS 模型/ }))
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek TTS' }))

    expect(screen.getByDisplayValue('https://api.deepseek.com')).toBeInTheDocument()
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('stella')
    expect(screen.queryByText('模型名称')).toBeNull()
  })

  it('测试连接：按 deepseek provider 真实合成一句', async () => {
    render(<TTSModelsSection />)

    fireEvent.click(screen.getByRole('button', { name: /添加 TTS 模型/ }))
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek TTS' }))
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'sk-ds' } })
    fireEvent.click(screen.getByRole('button', { name: /测试连接/ }))

    await waitFor(() => expect(speakMock).toHaveBeenCalledTimes(1))
    expect(speakMock.mock.calls[0][1]).toMatchObject({
      provider: 'deepseek',
      voice: 'stella',
      apiKey: 'sk-ds',
      baseUrl: 'https://api.deepseek.com',
    })
    expect(await screen.findByText(/连接成功/)).toBeInTheDocument()
  })
})

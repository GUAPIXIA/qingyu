import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor, act } from '@testing-library/react'
import { MessageActionBar } from '../MessageActionBar'
import { useChatStore } from '../../../store/useChatStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useToastStore } from '../../../store/useToastStore'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { Message, TTSModelConfig } from '../../../../shared/types'

/**
 * DeepSeek 朗读接线测试（2026-11-16）：
 * - 消息朗读按 provider=deepseek 调用 tts.speak，并带上 voice / apiKey / baseUrl；
 * - 长正文按句切分后逐段请求（不是整段一次）；
 * - 返回 wav 时按 audio/wav 播放（不再写死 audio/mp3）；
 * - 播放结束按钮回到「朗读」。
 */

const speakMock = vi.fn()
const stopMock = vi.fn().mockResolvedValue(undefined)

type FakeAudio = {
  src: string
  onended: (() => void) | null
  onerror: (() => void) | null
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
}

let audioInstances: FakeAudio[] = []

class FakeAudioElement implements FakeAudio {
  src: string
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  play = vi.fn(() => Promise.resolve())
  pause = vi.fn()

  constructor(src: string) {
    this.src = src
    audioInstances.push(this)
  }
}

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    sessionId: 's1',
    characterId: 'char-1',
    role: 'assistant',
    content: '你好。',
    images: [],
    isEditing: false,
    timestamp: 1700000000000,
    ...overrides,
  }
}

function deepseekModel(overrides: Partial<TTSModelConfig> = {}): TTSModelConfig {
  return {
    id: 'tts-ds',
    name: 'DeepSeek 海星',
    provider: 'deepseek',
    model: '',
    voice: 'stella',
    apiKey: 'sk-ds',
    baseUrl: 'https://api.deepseek.com',
    enabled: true,
    order: 0,
    ...overrides,
  }
}

function setupStores(models: TTSModelConfig[] = [deepseekModel()]) {
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      ttsEnabled: true,
      ttsModels: models,
      activeTTSModelId: models[0]?.id ?? null,
      ttsReadThought: false,
    },
    credentials: {},
    loaded: true,
    _saveTimer: null,
  })
  useChatStore.setState({
    messages: [],
    sessions: [],
    currentSessionId: 's1',
    isStreaming: false,
    error: null,
    activePresetId: null,
    activeLorebookIds: [],
    translatingMessages: {},
    showTranslationIds: new Set<string>(),
    editingMessageId: null,
  })
  useToastStore.setState({ toasts: [] })
}

describe('MessageActionBar 朗读（DeepSeek）', () => {
  beforeEach(() => {
    audioInstances = []
    speakMock.mockReset()
    stopMock.mockReset()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      ...(window as unknown as { api: Record<string, unknown> }).api,
      tts: {
        speak: speakMock,
        stop: stopMock,
        pause: vi.fn().mockResolvedValue(undefined),
        resume: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockResolvedValue({ state: 'idle' }),
        onState: vi.fn().mockReturnValue(() => {}),
        listVoices: vi.fn().mockResolvedValue([]),
      },
    }
    vi.stubGlobal('Audio', FakeAudioElement)
    setupStores()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('点击朗读：按 deepseek provider 合成并带配置，wav 按 audio/wav 播放', async () => {
    speakMock.mockResolvedValue({ success: true, audioBase64: 'AQID', audioMime: 'audio/wav' })
    const { getByTitle } = render(
      <MessageActionBar message={createMessage()} character={null} isUser={false} isSystem={false} isStreaming={false} onEdit={() => {}} />,
    )

    fireEvent.click(getByTitle('朗读'))

    await waitFor(() => expect(speakMock).toHaveBeenCalledTimes(1))
    const [text, options] = speakMock.mock.calls[0]
    expect(text).toBe('你好。')
    expect(options).toMatchObject({
      provider: 'deepseek',
      voice: 'stella',
      apiKey: 'sk-ds',
      baseUrl: 'https://api.deepseek.com',
    })

    await waitFor(() => expect(audioInstances).toHaveLength(1))
    expect(audioInstances[0].src.startsWith('data:audio/wav;base64,')).toBe(true)

    act(() => audioInstances[0].onended?.())
    await waitFor(() => expect(getByTitle('朗读')).toBeInTheDocument())
  })

  it('长正文按句切分逐段请求，且每段不超过上限', async () => {
    speakMock.mockResolvedValue({ success: true, audioBase64: 'AQID', audioMime: 'audio/wav' })
    const content = '啊'.repeat(200)
    const { getByTitle } = render(
      <MessageActionBar message={createMessage({ content })} character={null} isUser={false} isSystem={false} isStreaming={false} onEdit={() => {}} />,
    )

    fireEvent.click(getByTitle('朗读'))

    // 第一段合成并播放后，模拟播完，队列才会请求第二段
    await waitFor(() => expect(audioInstances).toHaveLength(1))
    act(() => audioInstances[0].onended?.())

    await waitFor(() => expect(speakMock).toHaveBeenCalledTimes(2))
    const texts = speakMock.mock.calls.map((call) => call[0] as string)
    expect(texts.join('')).toBe(content)
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(180)
  })

  it('气泡显示译文时朗读译文，而不是原文', async () => {
    speakMock.mockResolvedValue({ success: true, audioBase64: 'AQID', audioMime: 'audio/wav' })
    useChatStore.setState({ showTranslationIds: new Set(['msg-1']) })
    const { getByTitle } = render(
      <MessageActionBar
        message={createMessage({ content: 'Hello world.' })}
        translatedText="你好世界。"
        character={null}
        isUser={false}
        isSystem={false}
        isStreaming={false}
        onEdit={() => {}}
      />,
    )

    fireEvent.click(getByTitle('朗读译文'))

    await waitFor(() => expect(speakMock).toHaveBeenCalledTimes(1))
    expect(speakMock.mock.calls[0][0]).toBe('你好世界。')
  })

  it('朗读前剔除图片/音频/链接等非文本内容', async () => {
    speakMock.mockResolvedValue({ success: true, audioBase64: 'AQID', audioMime: 'audio/wav' })
    const content = [
      '你好。',
      '![插画](https://a.com/x.png)',
      '<audio src="https://a.com/a.mp3" controls></audio>',
      'https://a.com/page',
      '再见。',
    ].join('\n')
    const { getByTitle } = render(
      <MessageActionBar message={createMessage({ content })} character={null} isUser={false} isSystem={false} isStreaming={false} onEdit={() => {}} />,
    )

    fireEvent.click(getByTitle('朗读'))

    await waitFor(() => expect(speakMock).toHaveBeenCalledTimes(1))
    const text = speakMock.mock.calls[0][0] as string
    expect(text).toContain('你好')
    expect(text).toContain('再见')
    expect(text).not.toMatch(/https?:\/\//)
    expect(text).not.toContain('audio')
    expect(text).not.toContain('插画')
  })

  it('仅有图片/音频的消息不发起朗读并提示', async () => {
    const { getByTitle } = render(
      <MessageActionBar
        message={createMessage({ content: '![图](https://a.com/x.png)<audio src="https://a.com/a.mp3"></audio>' })}
        character={null}
        isUser={false}
        isSystem={false}
        isStreaming={false}
        onEdit={() => {}}
      />,
    )

    fireEvent.click(getByTitle('朗读'))

    await waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1))
    expect(speakMock).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts[0].title).toBe('这条消息没有可朗读的文字')
  })

  it('停止会中止后续分段播放', async () => {
    speakMock.mockResolvedValue({ success: true, audioBase64: 'AQID', audioMime: 'audio/wav' })
    const content = '啊'.repeat(200)
    const { getByTitle } = render(
      <MessageActionBar message={createMessage({ content })} character={null} isUser={false} isSystem={false} isStreaming={false} onEdit={() => {}} />,
    )

    fireEvent.click(getByTitle('朗读'))
    await waitFor(() => expect(audioInstances).toHaveLength(1))

    fireEvent.click(getByTitle('停止朗读'))
    act(() => audioInstances[0].onended?.())
    await waitFor(() => expect(getByTitle('朗读')).toBeInTheDocument())
    // 队列已中止：第二段不再请求
    expect(speakMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledTimes(1)
  })
})

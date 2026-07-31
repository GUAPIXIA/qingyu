/**
 * OpenAI 兼容 TTS（3.2-A）单元测试
 *
 * 验证 /audio/speech 请求构造、响应解析、错误处理。
 * mock 全局 fetch，不发起真实网络请求。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// electron 运行时依赖 mock（tts.ts 使用 spawn 等）
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/qingyu-test' },
}))

import { openaiSpeak, OPENAI_VOICES } from '../tts'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('openaiSpeak', () => {
  it('请求构造正确（POST /audio/speech + Bearer + 参数）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const base64 = await openaiSpeak(
      { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-123', model: 'tts-1', voice: 'nova', speed: 1 },
      '你好世界',
    )

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/audio/speech')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sk-123')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('tts-1')
    expect(body.input).toBe('你好世界')
    expect(body.voice).toBe('nova')
    expect(body.response_format).toBe('mp3')
    // base64([1,2,3]) = AQID
    expect(base64).toBe('AQID')
  })

  it('baseUrl 尾部斜杠兼容', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await openaiSpeak({ baseUrl: 'http://localhost:8080/v1/', apiKey: '', model: 'tts-1', voice: 'alloy' }, 'x')
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8080/v1/audio/speech')
  })

  it('无 apiKey 时省略 Authorization 头', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await openaiSpeak({ baseUrl: 'https://x/v1', apiKey: '', model: 'tts-1', voice: 'alloy' }, 'x')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined()
  })

  it('超长输入截断（4000 字符）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await openaiSpeak({ baseUrl: 'https://x/v1', apiKey: '', model: 'tts-1', voice: 'alloy' }, 'x'.repeat(5000))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.input.length).toBe(4000)
  })

  it('HTTP 错误抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid', { status: 401 })))
    await expect(openaiSpeak({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'tts-1', voice: 'alloy' }, 'x')).rejects.toThrow('401')
  })
})

describe('OPENAI_VOICES', () => {
  it('包含常用音色', () => {
    const ids = OPENAI_VOICES.map((v) => v.id)
    expect(ids).toContain('alloy')
    expect(ids).toContain('nova')
    expect(ids).toContain('onyx')
    expect(ids.length).toBeGreaterThanOrEqual(6)
  })
})

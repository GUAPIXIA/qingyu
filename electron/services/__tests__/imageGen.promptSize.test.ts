/**
 * 生图适配器修复的回归测试（2026-09-11 审查报告：问题三 / 五）
 *
 * 覆盖此前无测试、因而长期未被发现的尺寸与清洗问题：
 * - 三：OpenAI 尺寸按 DALL-E 型号归一化（sd-webui 不受影响）
 * - 五：提示词清洗的引号处理与 NFC 规范化
 */
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { generateImage } from '../imageGen'
import type { OpenAiImageGenConfig, SdWebUiImageGenConfig } from '../../../shared/types'

const openAiConfig: OpenAiImageGenConfig = {
  id: 'oai-1',
  name: 'DALL-E',
  provider: 'openai',
  model: 'dall-e-3',
  apiKey: 'sk-test',
  baseUrl: 'https://api.openai.com/v1',
  size: '1024x1024',
  quality: 'standard',
  enabled: true,
  order: 0,
}

const sdConfig: SdWebUiImageGenConfig = {
  id: 'sd-1',
  name: 'SD',
  provider: 'sd-webui',
  model: '',
  apiKey: '',
  baseUrl: 'http://127.0.0.1:7860',
  size: '512x512',
  enabled: true,
  order: 0,
}

/** 拦截一次成功的 OpenAI 生图请求。 */
function mockOpenAiSuccess(): MockInstance {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify({ data: [{ b64_json: 'ZmFrZQ==' }] }), { status: 200 }),
  )
}

/** 拦截一次成功的 SD WebUI 生图请求。 */
function mockSdSuccess(): MockInstance {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify({ images: ['ZmFrZQ=='] }), { status: 200 }),
  )
}

function requestBody(fetchMock: MockInstance, callIndex = 0): { model?: string; size?: string; prompt?: string } {
  return JSON.parse(String((fetchMock.mock.calls[callIndex][1] as RequestInit).body))
}

describe('OpenAI 尺寸归一化', () => {
  afterEach(() => vi.restoreAllMocks())

  it('合法尺寸原样透传', async () => {
    const fetchMock = mockOpenAiSuccess()
    await generateImage(openAiConfig, 'a cat', { size: '1792x1024' })
    expect(requestBody(fetchMock).size).toBe('1792x1024')
  })

  it('竖版非法尺寸映射为 1024x1792（保留竖版意图）', async () => {
    const fetchMock = mockOpenAiSuccess()
    await generateImage(openAiConfig, 'a cat', { size: '512x768' })
    expect(requestBody(fetchMock).size).toBe('1024x1792')
  })

  it('横版非法尺寸映射为 1792x1024', async () => {
    const fetchMock = mockOpenAiSuccess()
    await generateImage(openAiConfig, 'a cat', { size: '768x512' })
    expect(requestBody(fetchMock).size).toBe('1792x1024')
  })

  it('角色封面的 3:4 预设尺寸映射为竖版合法值', async () => {
    const fetchMock = mockOpenAiSuccess()
    await generateImage(openAiConfig, 'cover', { size: '576x768' })
    expect(requestBody(fetchMock).size).toBe('1024x1792')
  })

  it('正方形非法尺寸映射为 1024x1024', async () => {
    const fetchMock = mockOpenAiSuccess()
    await generateImage(openAiConfig, 'a cat', { size: '640x640' })
    expect(requestBody(fetchMock).size).toBe('1024x1024')
  })

  it('DALL-E 2 使用正方形集合，非正方形退化为 512x512', async () => {
    const fetchMock = mockOpenAiSuccess()
    await generateImage({ ...openAiConfig, model: 'dall-e-2' }, 'a cat', { size: '1792x1024' })
    expect(requestBody(fetchMock).size).toBe('512x512')
  })

  it('DALL-E 2 的合法正方形尺寸原样透传', async () => {
    const fetchMock = mockOpenAiSuccess()
    await generateImage({ ...openAiConfig, model: 'dall-e-2' }, 'a cat', { size: '256x256' })
    expect(requestBody(fetchMock).size).toBe('256x256')
  })
})

describe('提示词清洗', () => {
  afterEach(() => vi.restoreAllMocks())

  it('SD WebUI：清除直角双引号与左右弯引号', async () => {
    const fetchMock = mockSdSuccess()
    await generateImage(sdConfig, '1girl, "red dress", \u201cblue hat\u201d')
    const prompt = requestBody(fetchMock).prompt ?? ''
    expect(prompt).not.toContain('"')
    expect(prompt).not.toContain('\u201c')
    expect(prompt).not.toContain('\u201d')
    expect(prompt).toContain('red dress')
    expect(prompt).toContain('blue hat')
  })

  it('SD WebUI：NFC 规范化与拉丁扩展白名单保留重音字符', async () => {
    const fetchMock = mockSdSuccess()
    await generateImage(sdConfig, 'caf\u00e9, na\u00efve')
    const prompt = requestBody(fetchMock).prompt ?? ''
    // NFD 会把 é 拆成 e + 组合符并被白名单剥掉；NFC + 拉丁扩展区间应完整保留
    expect(prompt).toContain('caf\u00e9')
    expect(prompt).toContain('na\u00efve')
  })

  it('SD WebUI：中文提示词不受清洗影响', async () => {
    const fetchMock = mockSdSuccess()
    await generateImage(sdConfig, '一个女孩, 红色的裙子')
    const prompt = requestBody(fetchMock).prompt ?? ''
    expect(prompt).toContain('一个女孩')
    expect(prompt).toContain('红色的裙子')
  })

  it('OpenAI：清除三种引号并压缩空白', async () => {
    const fetchMock = mockOpenAiSuccess()
    await generateImage(openAiConfig, 'a  "cat"  in  \u201crain\u201d')
    expect(requestBody(fetchMock).prompt).toBe('a cat in rain')
  })
})

describe('generateImage 分派', () => {
  afterEach(() => vi.restoreAllMocks())

  it('未知 provider 返回失败而非抛错', async () => {
    const result = await generateImage(
      { ...openAiConfig, provider: 'unknown' } as unknown as OpenAiImageGenConfig,
      'x',
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('不支持的 provider')
  })
})

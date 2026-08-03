/**
 * Vision 图片转换工具单元测试
 */
import { describe, expect, it } from 'vitest'
import {
  parseImageDataUrl,
  collectImages,
  hasImageMessages,
  imageErrorHint,
  toOpenAIContent,
  toClaudeContent,
  toOllamaMessages,
} from '../adapters/vision'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const JPG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD'

describe('parseImageDataUrl', () => {
  it('解析合法的 PNG data URL', () => {
    const p = parseImageDataUrl(PNG_DATA_URL)
    expect(p).not.toBeNull()
    expect(p!.mimeType).toBe('image/png')
    expect(p!.data).toContain('iVBORw0KG')
    expect(p!.dataUrl).toBe(PNG_DATA_URL)
  })

  it('解析 JPEG data URL', () => {
    const p = parseImageDataUrl(JPG_DATA_URL)
    expect(p!.mimeType).toBe('image/jpeg')
  })

  it('容忍 base64 中的空白字符（换行等）', () => {
    const withWs = 'data:image/png;base64,AAAA\nBBBB\r\nCCCC'
    const p = parseImageDataUrl(withWs)
    expect(p!.data).toBe('AAAABBBBCCCC')
  })

  it('拒绝非法输入', () => {
    expect(parseImageDataUrl('not-a-url')).toBeNull()
    expect(parseImageDataUrl('data:text/plain;base64,AAAA')).toBeNull() // 非图片
    expect(parseImageDataUrl('data:image/png;base64,!!!invalid!!!')).toBeNull() // 非法 base64
    expect(parseImageDataUrl(123)).toBeNull()
    expect(parseImageDataUrl(undefined)).toBeNull()
  })
})

describe('toOpenAIContent', () => {
  it('带图片消息转为 content 数组（image_url 保留 data URL）', () => {
    const out = toOpenAIContent([
      { role: 'user', content: '这是什么？', images: [PNG_DATA_URL, JPG_DATA_URL] },
    ])
    const content = out[0].content as { type: string; image_url?: { url: string }; text?: string }[]
    expect(content).toHaveLength(3)
    expect(content[0]).toEqual({ type: 'text', text: '这是什么？' })
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: PNG_DATA_URL } })
    expect(content[2]).toEqual({ type: 'image_url', image_url: { url: JPG_DATA_URL } })
    expect(out[0].images).toBeUndefined() // 原始 images 字段被移除
  })

  it('无图片消息保持字符串 content 原样返回', () => {
    const msg = { role: 'user', content: '你好' }
    const out = toOpenAIContent([msg])
    expect(out[0]).toBe(msg) // 引用不变，零开销
  })

  it('过滤非法图片 URL，不产生空 content 数组', () => {
    const out = toOpenAIContent([
      { role: 'user', content: '看这个', images: ['broken-url', PNG_DATA_URL] },
    ])
    const content = out[0].content as { type: string }[]
    expect(content).toHaveLength(2) // text + 1 张合法图
  })
})

describe('toClaudeContent', () => {
  it('转为 Claude image source（base64 + media_type）', () => {
    const out = toClaudeContent([
      { role: 'user', content: '描述这张图', images: [PNG_DATA_URL] },
    ])
    const content = out[0].content as { type: string; source?: { type: string; media_type: string; data: string } }[]
    expect(content).toHaveLength(2)
    expect(content[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: expect.stringContaining('iVBORw0KG'),
      },
    })
  })
})

describe('toOllamaMessages', () => {
  it('转为 Ollama images 字段（纯 base64，无 data: 前缀）', () => {
    const out = toOllamaMessages([
      { role: 'user', content: '看图', images: [PNG_DATA_URL] },
    ])
    expect(out[0].content).toBe('看图')
    const images = out[0].images as string[]
    expect(images).toHaveLength(1)
    expect(images[0]).not.toContain('data:image')
    expect(images[0]).toContain('iVBORw0KG')
  })

  it('无图片消息原样返回', () => {
    const msg = { role: 'assistant', content: '好的' }
    const out = toOllamaMessages([msg])
    expect(out[0]).toBe(msg)
  })
})

describe('collectImages', () => {
  it('收集所有消息中的图片（保序、去非法）', () => {
    const imgs = collectImages([
      { role: 'user', content: 'a', images: [PNG_DATA_URL, 'bad'] },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c', images: [JPG_DATA_URL] },
    ])
    expect(imgs).toHaveLength(2)
    expect(imgs[0].mimeType).toBe('image/png')
    expect(imgs[1].mimeType).toBe('image/jpeg')
  })
})

describe('hasImageMessages / imageErrorHint', () => {
  it('检测是否含图片消息', () => {
    expect(hasImageMessages([{ role: 'user', content: 'a', images: [PNG_DATA_URL] }])).toBe(true)
    expect(hasImageMessages([{ role: 'user', content: 'a', images: [] }])).toBe(false)
    expect(hasImageMessages([{ role: 'user', content: 'a' }])).toBe(false)
  })

  it('含图片时返回诊断提示，无图片时返回空串', () => {
    expect(imageErrorHint([{ role: 'user', content: 'a', images: [PNG_DATA_URL] }]))
      .toContain('请求包含图片')
    expect(imageErrorHint([{ role: 'user', content: 'a' }])).toBe('')
  })
})

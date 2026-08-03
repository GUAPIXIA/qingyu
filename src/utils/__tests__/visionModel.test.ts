/**
 * 识图模型解析工具单元测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore } from '../../store/useSettingsStore'
import { getDefaultSettings } from '../../../shared/defaults'
import type { Settings } from '../../../shared/types'
import { contextHasImages, resolveVisionModel } from '../visionModel'

/** 构造带识图模型配置的设置 */
function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...getDefaultSettings(),
    connectionProfiles: [{
      id: 'p1',
      name: '主对话',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'sk-main',
      maxContext: 8192,
    }],
    activeProfileId: 'p1',
    visionModels: [
      { id: 'v1', name: '识图A', model: 'gpt-4o-vision', enabled: true, order: 0 },
      {
        id: 'v2', name: '识图B', provider: 'openai', model: 'qwen2-vl-72b',
        baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-vision', enabled: true, order: 1,
      },
    ],
    activeVisionModelId: 'v1',
    ...overrides,
  }
}

const IMG = [{ content: '图', images: ['data:image/png;base64,AAA'] }]

describe('contextHasImages', () => {
  it('消息含图片时返回 true', () => {
    expect(contextHasImages([
      { content: '你好' },
      { content: '看这个', images: ['data:image/png;base64,AAA'] },
    ])).toBe(true)
  })

  it('无图片消息返回 false（含空数组）', () => {
    expect(contextHasImages([{ content: '你好' }, { content: '空', images: [] }])).toBe(false)
  })

  it('空消息列表返回 false', () => {
    expect(contextHasImages([])).toBe(false)
  })
})

describe('resolveVisionModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({
      settings: makeSettings(),
      credentials: {},
      loaded: false,
      _saveTimer: null,
    })
    vi.mocked(window.api.settings.save).mockResolvedValue(undefined)
  })

  it('上下文无图片 → 返回 null（使用主模型）', () => {
    expect(resolveVisionModel([{ content: '你好' }])).toBeNull()
  })

  it('上下文含图片且激活识图模型 → 返回识图模型名', () => {
    expect(resolveVisionModel(IMG)?.model).toBe('gpt-4o-vision')
  })

  it('只填模型名 → 连接字段回退当前 Profile', () => {
    const v = resolveVisionModel(IMG)
    expect(v).toEqual({
      provider: 'deepseek',
      model: 'gpt-4o-vision',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-main',
    })
  })

  it('独立配置连接 → 使用识图模型自己的 provider/baseUrl/apiKey', () => {
    useSettingsStore.setState({
      settings: makeSettings({ activeVisionModelId: 'v2' }),
    })
    expect(resolveVisionModel(IMG)).toEqual({
      provider: 'openai',
      model: 'qwen2-vl-72b',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-vision',
    })
  })

  it('部分字段独立（baseUrl 填了、apiKey 留空）→ 逐字段回退', () => {
    useSettingsStore.setState({
      settings: makeSettings({
        activeVisionModelId: 'v1',
        visionModels: [
          {
            id: 'v1', name: '混合', provider: 'ollama', model: 'llava',
            baseUrl: 'http://127.0.0.1:11434', apiKey: '', enabled: true, order: 0,
          },
        ],
      }),
    })
    expect(resolveVisionModel(IMG)).toEqual({
      provider: 'ollama',
      model: 'llava',
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: 'sk-main', // apiKey 留空 → 回退 Profile
    })
  })

  it('未激活任何识图模型 → 返回 null', () => {
    useSettingsStore.setState({ settings: makeSettings({ activeVisionModelId: null }) })
    expect(resolveVisionModel(IMG)).toBeNull()
  })

  it('激活的识图模型 model 为空 → 返回 null', () => {
    useSettingsStore.setState({
      settings: makeSettings({
        activeVisionModelId: 'v1',
        visionModels: [{ id: 'v1', name: '空', model: '', enabled: true, order: 0 }],
      }),
    })
    expect(resolveVisionModel(IMG)).toBeNull()
  })

  it('配置了识图模型但列表为空 → 返回 null（不崩溃）', () => {
    useSettingsStore.setState({ settings: makeSettings({ visionModels: [], activeVisionModelId: null }) })
    expect(resolveVisionModel(IMG)).toBeNull()
  })
})

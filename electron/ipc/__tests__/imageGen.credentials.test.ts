/**
 * 生图 IPC 凭据回填回归测试（2026-09-11 审查报告：问题一）
 *
 * 旧实现用裸 readJson 读 settings.json，未调用 restoreSecrets，
 * 导致 H1 剥离明文 apiKey 后 OpenAI 生图恒定 401（而"测试连接"因 config 由渲染层
 * 传入仍显示成功，极具迷惑性）。
 *
 * 本测试钉死「必须经 readSettingsFromDisk + restoreSecrets 取配置」这一实现约束，
 * 并断言回填后的 key 被真正传给生图服务。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenAiImageGenConfig } from '../../../shared/types'

const mocks = vi.hoisted(() => ({
  readSettingsFromDisk: vi.fn(),
  restoreSecrets: vi.fn(),
  generateImage: vi.fn(),
}))

vi.mock('../settings', () => ({
  readSettingsFromDisk: mocks.readSettingsFromDisk,
  restoreSecrets: mocks.restoreSecrets,
}))

vi.mock('../../services/imageGen', () => ({
  generateImage: mocks.generateImage,
  testImageGenConnection: vi.fn(),
  fetchComfyObjectInfo: vi.fn(),
}))

// comfyWorkflow 会引入 electron（dialog/app），测试中不需要，整体替身。
vi.mock('../../services/comfyWorkflow', () => ({
  analyzeComfyWorkflow: vi.fn(),
  importLocalComfyWorkflow: vi.fn(),
  listLocalComfyWorkflows: vi.fn(),
  normalizeComfyWorkflow: vi.fn(),
}))

import { registerImageGenIPC } from '../imageGen'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function captureHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  registerImageGenIPC({
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
  } as never)
  return handlers
}

const openAiConfig: OpenAiImageGenConfig = {
  id: 'oai-1',
  name: 'DALL-E',
  provider: 'openai',
  model: 'dall-e-3',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  size: '1024x1024',
  quality: 'standard',
  enabled: true,
  order: 0,
}

describe('imageGen:generate 凭据回填', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generateImage.mockResolvedValue({ success: true, images: ['data:image/png;base64,AAAA'] })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('经 readSettingsFromDisk + restoreSecrets 取配置，并把回填后的 apiKey 传给生图服务', async () => {
    // settings.json 中 apiKey 已被 H1 剥离为空
    mocks.readSettingsFromDisk.mockReturnValue({
      activeImageGenModelId: 'oai-1',
      imageGenModels: [{ ...openAiConfig }],
      connectionProfiles: [],
    })
    // 模拟 restoreSecrets 从 safeStorage 回填的效果
    mocks.restoreSecrets.mockImplementation((settings: {
      imageGenModels: OpenAiImageGenConfig[]
    }) => {
      settings.imageGenModels[0].apiKey = 'sk-from-safestorage'
    })

    const handler = captureHandlers().get('imageGen:generate')!
    const result = await handler({}, 'a cat')

    expect(mocks.readSettingsFromDisk).toHaveBeenCalled()
    expect(mocks.restoreSecrets).toHaveBeenCalled()
    expect(result).toEqual({ success: true, images: ['data:image/png;base64,AAAA'] })

    // 关键断言：传给生图服务的是回填后的 key，而非 settings.json 里的空串
    const passedConfig = mocks.generateImage.mock.calls[0][0] as OpenAiImageGenConfig
    expect(passedConfig.apiKey).toBe('sk-from-safestorage')
  })

  it('无启用的生图模型时返回明确错误且不调用生图服务', async () => {
    mocks.readSettingsFromDisk.mockReturnValue({
      activeImageGenModelId: 'oai-1',
      imageGenModels: [{ ...openAiConfig, enabled: false }],
      connectionProfiles: [],
    })

    const handler = captureHandlers().get('imageGen:generate')!
    const result = await handler({}, 'a cat')

    expect(result).toMatchObject({ success: false })
    expect((result as { error: string }).error).toContain('未配置启用的生图模型')
    expect(mocks.generateImage).not.toHaveBeenCalled()
  })
})

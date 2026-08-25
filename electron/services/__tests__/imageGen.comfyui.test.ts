import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageGenModelConfig } from '../../../shared/types'
import { generateImage, testImageGenConnection } from '../imageGen'

const config: ImageGenModelConfig = {
  id: 'comfy-1',
  name: '本地 ComfyUI',
  provider: 'comfyui',
  model: 'model.safetensors',
  apiKey: '',
  baseUrl: 'http://127.0.0.1:8188/',
  size: '512x768',
  quality: 'standard',
  enabled: true,
  order: 0,
  negativePrompt: 'low quality',
  steps: 24,
  cfgScale: 6,
  sampler: 'euler',
}

describe('ComfyUI image generation adapter', () => {
  afterEach(() => vi.restoreAllMocks())

  it('提交工作流、轮询历史并下载输出图片', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'prompt-1', number: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'prompt-1': {
          status: { completed: true, status_str: 'success' },
          outputs: {
            '9': { images: [{ filename: 'qingyu_00001_.png', subfolder: '', type: 'output' }] },
          },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }))

    const result = await generateImage(config, 'a quiet tavern')

    expect(result).toEqual({ success: true, images: ['data:image/png;base64,AQID'] })
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8188/prompt')
    const queuedBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(queuedBody.prompt['6'].inputs.text).toBe('a quiet tavern')
    expect(queuedBody.prompt['7'].inputs.text).toBe('low quality')
    expect(queuedBody.prompt['5'].inputs).toMatchObject({ width: 512, height: 768 })
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:8188/history/prompt-1')
    expect(String(fetchMock.mock.calls[2][0])).toContain('/view?')
  })

  it('通过 system_stats 测试连接', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ system: { comfyui_version: '0.3.50' } }), { status: 200 }),
    )

    const result = await testImageGenConnection({
      provider: 'comfyui',
      baseUrl: 'http://127.0.0.1:8188/',
      apiKey: '',
    })

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8188/system_stats',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('接受带 prompt 包装的 API 工作流并替换自定义节点占位符', async () => {
    const customConfig: ImageGenModelConfig = {
      ...config,
      workflow: JSON.stringify({
        prompt: {
          '1': {
            class_type: 'CustomPromptNode',
            inputs: { text: '{{prompt}}', width: '{{width}}', seed: '{{seed}}' },
          },
          '2': {
            class_type: 'SaveImage',
            inputs: { images: ['1', 0], filename_prefix: 'Qingyu' },
          },
        },
      }),
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'prompt-2' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'prompt-2': {
          status: { completed: true, status_str: 'success' },
          outputs: { '2': { images: [{ filename: 'custom.png', type: 'output' }] } },
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([4]), { status: 200 }))

    const result = await generateImage(customConfig, 'custom prompt', { size: '768x512' })
    const queuedBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))

    expect(result.success).toBe(true)
    expect(queuedBody.prompt['1'].inputs.text).toBe('custom prompt')
    expect(queuedBody.prompt['1'].inputs.width).toBe(768)
    expect(typeof queuedBody.prompt['1'].inputs.seed).toBe('number')
  })
})

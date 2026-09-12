import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ComfyImageGenConfig } from '../../../shared/types'
import { generateImage, testImageGenConnection } from '../imageGen'

/**
 * 基础文生图工作流（节点编号沿用原内置模板，便于断言）。
 *
 * 内置工作流回退已移除，ComfyUI 配置必须携带工作流快照。
 */
function baseWorkflow(): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
        model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'Qingyu', images: ['8', 0] } },
  }
}

/** 基础 ComfyUI 配置：工作流为唯一事实来源。 */
const config: ComfyImageGenConfig = {
  id: 'comfy-1',
  name: '本地 ComfyUI',
  provider: 'comfyui',
  apiKey: '',
  baseUrl: 'http://127.0.0.1:8188/',
  enabled: true,
  order: 0,
  workflow: JSON.stringify(baseWorkflow()),
}

/** 提交给 /prompt 的请求体中的节点对象。 */
type SubmittedWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>

function submittedWorkflow(fetchMock: MockInstance, callIndex = 0): SubmittedWorkflow {
  const body = JSON.parse(String((fetchMock.mock.calls[callIndex][1] as RequestInit).body))
  return body.prompt as SubmittedWorkflow
}

/** 除种子外逐节点比对，用于断言「除目标字段外其余内容与快照一致」。 */
const SEED_INPUTS = new Set(['seed', 'noise_seed'])

function stripSeeds(workflow: SubmittedWorkflow): SubmittedWorkflow {
  const result: SubmittedWorkflow = {}
  for (const [nodeId, node] of Object.entries(workflow)) {
    const inputs: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(node.inputs)) {
      if (SEED_INPUTS.has(name)) continue
      inputs[name] = value
    }
    result[nodeId] = { class_type: node.class_type, inputs }
  }
  return result
}

/** 模拟一次成功的生图流程：入队、历史查询、下载图片。 */
function mockSuccessfulRun(promptId: string, outputNodeId: string, bytes = [1, 2, 3]): MockInstance {
  return vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: promptId, number: 1 }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      [promptId]: {
        status: { completed: true, status_str: 'success' },
        outputs: { [outputNodeId]: { images: [{ filename: 'qingyu_00001_.png', subfolder: '', type: 'output' }] } },
      },
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(Uint8Array.from(bytes), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    }))
}

describe('ComfyUI image generation adapter', () => {
  afterEach(() => vi.restoreAllMocks())

  it('提交工作流、轮询历史并下载输出图片', async () => {
    const fetchMock = mockSuccessfulRun('prompt-1', '9')

    const result = await generateImage(config, 'a quiet tavern', {
      size: '512x768',
      negativePrompt: 'low quality',
    })

    expect(result).toEqual({ success: true, images: ['data:image/png;base64,AQID'] })
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8188/prompt')
    const queued = submittedWorkflow(fetchMock)
    expect(queued['6'].inputs.text).toBe('a quiet tavern')
    expect(queued['7'].inputs.text).toBe('low quality')
    // 工作流是唯一事实来源：options.size 不再改写 Latent 节点，尺寸由 overrides 控制。
    expect(queued['5'].inputs).toMatchObject({ width: 512, height: 512 })
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
    const customConfig: ComfyImageGenConfig = {
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
    const fetchMock = mockSuccessfulRun('prompt-2', '2', [4])

    const result = await generateImage(customConfig, 'custom prompt', { size: '768x512' })
    const queued = submittedWorkflow(fetchMock)

    expect(result.success).toBe(true)
    expect(queued['1'].inputs.text).toBe('custom prompt')
    expect(queued['1'].inputs.width).toBe(768)
    expect(typeof queued['1'].inputs.seed).toBe('number')
  })
})

/** Z-Image 风格工作流：UNETLoader + CLIPLoader + VAELoader + KSampler。 */
function zImageWorkflow(): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'qwen_image', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    '6': { class_type: 'EmptySD3LatentImage', inputs: { width: 1080, height: 1920, batch_size: 1 } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        seed: 111, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1,
        model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'Qingyu' } },
  }
}

function zImageConfig(extra: Partial<ComfyImageGenConfig> = {}): ComfyImageGenConfig {
  return {
    id: 'comfy-z',
    name: 'Z-Image',
    provider: 'comfyui',
    apiKey: '',
    baseUrl: 'http://127.0.0.1:8188/',
    enabled: true,
    order: 0,
    workflow: JSON.stringify(zImageWorkflow()),
    ...extra,
  }
}

describe('ComfyUI 工作流即事实来源', () => {
  afterEach(() => vi.restoreAllMocks())

  it('无覆盖时，提交的工作流与快照逐字段一致（仅种子随机化）', async () => {
    const fetchMock = mockSuccessfulRun('prompt-a', '9')

    await generateImage(zImageConfig(), 'a quiet tavern', { negativePrompt: 'low quality' })
    const queued = submittedWorkflow(fetchMock)

    // 快照原值应被完整保留，不再被 512x512 / 20 / 7 / euler / normal 覆盖。
    expect(queued['6'].inputs).toMatchObject({ width: 1080, height: 1920 })
    expect(queued['7'].inputs.steps).toBe(8)
    expect(queued['7'].inputs.cfg).toBe(1)
    expect(queued['7'].inputs.sampler_name).toBe('res_multistep')
    expect(queued['7'].inputs.scheduler).toBe('simple')
    expect(queued['1'].inputs.unet_name).toBe('z_image_turbo_bf16.safetensors')
    expect(queued['2'].inputs.clip_name).toBe('qwen_3_4b.safetensors')
    expect(queued['3'].inputs.vae_name).toBe('ae.safetensors')
    // 种子被随机化，且为合法数值。
    expect(typeof queued['7'].inputs.seed).toBe('number')
    // 提示词写入按采样器的 positive / negative 引用自动识别。
    expect(queued['4'].inputs.text).toBe('a quiet tavern')
    expect(queued['5'].inputs.text).toBe('low quality')
    // 除种子外与快照完全一致。
    expect(stripSeeds(queued)).toEqual({
      ...stripSeeds(zImageWorkflow()),
      '4': { class_type: 'CLIPTextEncode', inputs: { text: 'a quiet tavern', clip: ['2', 0] } },
      '5': { class_type: 'CLIPTextEncode', inputs: { text: 'low quality', clip: ['2', 0] } },
    })
  })

  it('负面条件由 ConditioningZeroOut 派生时不得清空正面提示词', async () => {
    const workflow = zImageWorkflow()
    delete workflow['5']
    workflow['10'] = {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: ['4', 0] },
    }
    workflow['7'].inputs.negative = ['10', 0]
    const fetchMock = mockSuccessfulRun('prompt-zero-out', '9')

    await generateImage(
      zImageConfig({ workflow: JSON.stringify(workflow) }),
      'full-body portrait, silver hair, black dress',
      {},
    )
    const queued = submittedWorkflow(fetchMock)

    expect(queued['4'].inputs.text).toBe('full-body portrait, silver hair, black dress')
  })

  it('单参数覆盖只改变目标节点，其余节点与快照一致', async () => {
    const fetchMock = mockSuccessfulRun('prompt-b', '9')
    const baseline = stripSeeds(zImageWorkflow())

    // 提示词传空串，使提交体与快照的唯一差异只剩被测的覆盖项。
    await generateImage(zImageConfig({ overrides: { '7.steps': 12 } }), '', {})
    const queued = submittedWorkflow(fetchMock)
    const stripped = stripSeeds(queued)

    // 目标字段被覆盖。
    expect(queued['7'].inputs.steps).toBe(12)
    // 其余字段与快照一致：把提交体的 7.steps 还原为快照值后，整体应完全相等。
    const restored = {
      ...stripped,
      '7': { ...stripped['7'], inputs: { ...stripped['7'].inputs, steps: baseline['7'].inputs.steps } },
    }
    expect(restored).toEqual(baseline)
  })

  it('尺寸覆盖写入指定的 Latent 节点，不影响其他节点', async () => {
    const fetchMock = mockSuccessfulRun('prompt-c', '9')

    await generateImage(
      zImageConfig({ overrides: { '6.width': 832, '6.height': 1216 } }),
      'p',
      {},
    )
    const queued = submittedWorkflow(fetchMock)

    expect(queued['6'].inputs).toMatchObject({ width: 832, height: 1216 })
    expect(queued['7'].inputs.steps).toBe(8)
  })

  it('模型覆盖只改写目标 Loader', async () => {
    const fetchMock = mockSuccessfulRun('prompt-d', '9')

    await generateImage(
      zImageConfig({ overrides: { '1.unet_name': 'other_unet.safetensors' } }),
      'p',
      {},
    )
    const queued = submittedWorkflow(fetchMock)

    expect(queued['1'].inputs.unet_name).toBe('other_unet.safetensors')
    expect(queued['2'].inputs.clip_name).toBe('qwen_3_4b.safetensors')
    expect(queued['3'].inputs.vae_name).toBe('ae.safetensors')
  })

  it('多阶段工作流只随机化可达输出的第一个采样阶段', async () => {
    const workflow = zImageWorkflow()
    // 精修阶段：以基础阶段的输出作为 latent 输入。
    workflow['30'] = {
      class_type: 'KSampler',
      inputs: {
        seed: 222, steps: 4, cfg: 1.5, denoise: 0.4,
        model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['8', 0],
      },
    }
    workflow['9'].inputs.images = ['30', 0]
    const fetchMock = mockSuccessfulRun('prompt-e', '9')

    await generateImage(
      zImageConfig({ workflow: JSON.stringify(workflow) }),
      'p',
      {},
    )
    const queued = submittedWorkflow(fetchMock)

    // 基础阶段（7）的种子被随机化，精修阶段（30）保持原值。
    expect(typeof queued['7'].inputs.seed).toBe('number')
    expect(queued['30'].inputs.seed).toBe(222)
    expect(queued['30'].inputs.steps).toBe(4)
  })

  it('显式种子覆盖优先于随机化', async () => {
    const fetchMock = mockSuccessfulRun('prompt-f', '9')

    await generateImage(zImageConfig({ overrides: { '7.seed': 42 } }), 'p', {})
    const queued = submittedWorkflow(fetchMock)

    expect(queued['7'].inputs.seed).toBe(42)
  })

  it('存在歧义时按 bindings 写入提示词入口', async () => {
    const workflow = zImageWorkflow()
    workflow['12'] = { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } }
    workflow['40'] = { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['4', 0], conditioning_2: ['12', 0] } }
    workflow['7'].inputs.positive = ['40', 0]
    const fetchMock = mockSuccessfulRun('prompt-g', '9')

    await generateImage(
      zImageConfig({
        workflow: JSON.stringify(workflow),
        bindings: { positivePromptNodeIds: ['4', '12'], negativePromptNodeIds: ['5'], outputNodeIds: ['9'] },
      }),
      'bound prompt',
      { negativePrompt: 'bound negative' },
    )
    const queued = submittedWorkflow(fetchMock)

    expect(queued['4'].inputs.text).toBe('bound prompt')
    expect(queued['12'].inputs.text).toBe('bound prompt')
    expect(queued['5'].inputs.text).toBe('bound negative')
  })

  it('未配置工作流时拒绝提交，并给出可读错误', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const result = await generateImage({ ...config, workflow: '' }, 'p', {})

    expect(result.success).toBe(false)
    expect(result.error).toContain('未配置工作流')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('输出节点绑定：只收集选定节点的图片', async () => {
    // 两个输出节点，用户仅选定 '9'
    const twoOutputs = {
      ...baseWorkflow(),
      '10': { class_type: 'SaveImage', inputs: { filename_prefix: 'Extra', images: ['8', 0] } },
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ prompt_id: 'p-sel', number: 1 }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({
        'p-sel': {
          status: { completed: true, status_str: 'success' },
          outputs: {
            '9': { images: [{ filename: 'picked.png', subfolder: '', type: 'output' }] },
            '10': { images: [{ filename: 'ignored.png', subfolder: '', type: 'output' }] },
          },
        },
      }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(Uint8Array.from([7]), { status: 200, headers: { 'Content-Type': 'image/png' } }),
    )

    const result = await generateImage(
      { ...config, workflow: JSON.stringify(twoOutputs), bindings: { positivePromptNodeIds: ['6'], outputNodeIds: ['9'] } },
      'p',
    )

    expect(result.success).toBe(true)
    // 只下载了选定节点的图片
    const viewUrl = String(fetchMock.mock.calls[2][0])
    expect(viewUrl).toContain('picked.png')
    expect(viewUrl).not.toContain('ignored.png')
  })

  it('工作流 JSON 无效时给出可读错误且不发起请求', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const result = await generateImage(zImageConfig({ workflow: '{ not json' }), 'p', {})

    expect(result.success).toBe(false)
    expect(result.error).toContain('工作流 JSON 无效')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

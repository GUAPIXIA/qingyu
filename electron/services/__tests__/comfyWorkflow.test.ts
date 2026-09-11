import { describe, expect, it } from 'vitest'
import {
  analyzeComfyWorkflow,
  convertComfyCanvasWorkflow,
  hashComfyWorkflow,
  normalizeComfyWorkflow,
  type ApiWorkflow,
} from '../comfyWorkflow'

describe('ComfyUI Desktop workflow conversion', () => {
  it('converts a classic canvas workflow and handles the legacy seed control widget', () => {
    const workflow = convertComfyCanvasWorkflow({
      nodes: [
        {
          id: 1,
          type: 'KSampler',
          inputs: [
            { name: 'seed', link: null, widget: { name: 'seed' } },
            { name: 'steps', link: null, widget: { name: 'steps' } },
            { name: 'cfg', link: null, widget: { name: 'cfg' } },
            { name: 'sampler_name', link: null, widget: { name: 'sampler_name' } },
            { name: 'scheduler', link: null, widget: { name: 'scheduler' } },
          ],
          widgets_values: [123, 'randomize', 8, 1, 'res_multistep', 'simple'],
        },
        {
          id: 2,
          type: 'SaveImage',
          inputs: [
            { name: 'images', link: null },
            { name: 'filename_prefix', link: null, widget: { name: 'filename_prefix' } },
          ],
          widgets_values_named: { filename_prefix: 'Qingyu' },
        },
      ],
      links: [],
    })

    expect(workflow['1']).toMatchObject({
      class_type: 'KSampler',
      inputs: {
        seed: 123,
        steps: 8,
        cfg: 1,
        sampler_name: 'res_multistep',
        scheduler: 'simple',
      },
    })
    expect(workflow['2'].inputs.filename_prefix).toBe('Qingyu')
  })

  it('flattens a Desktop subgraph and reconnects its output', () => {
    const workflow = convertComfyCanvasWorkflow({
      nodes: [
        {
          id: 57,
          type: 'subgraph-z',
          inputs: [{ name: 'text', link: null, widget: { name: 'text' } }],
          widgets_values_named: { text: 'original prompt' },
        },
        {
          id: 9,
          type: 'SaveImage',
          inputs: [{ name: 'images', link: 62 }],
        },
      ],
      links: [[62, 57, 0, 9, 0, 'IMAGE']],
      definitions: {
        subgraphs: [{
          id: 'subgraph-z',
          nodes: [{
            id: 27,
            type: 'CLIPTextEncode',
            inputs: [{ name: 'text', link: 34, widget: { name: 'text' } }],
          }],
          links: [
            { id: 34, origin_id: -10, origin_slot: 0, target_id: 27, target_slot: 0 },
            { id: 16, origin_id: 27, origin_slot: 0, target_id: -20, target_slot: 0 },
          ],
        }],
      },
    })

    expect(workflow['57:27']).toEqual({
      class_type: 'CLIPTextEncode',
      inputs: { text: 'original prompt' },
    })
    expect(workflow['9'].inputs.images).toEqual(['57:27', 0])
  })
})

/** 构造一个 Z-Image 风格的 API 工作流：UNETLoader + CLIPLoader + VAELoader。 */
function buildZImageWorkflow(): ApiWorkflow {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
    '2': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'qwen_image', device: 'default' },
    },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: 'a quiet tavern', clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: 'low quality', clip: ['2', 0] } },
    '6': {
      class_type: 'EmptySD3LatentImage',
      inputs: { width: 1080, height: 1920, batch_size: 1 },
    },
    '7': {
      class_type: 'KSampler',
      inputs: {
        seed: 123, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple',
        denoise: 1, model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'Qingyu' } },
  }
}

/**
 * 复刻 image_z_image_turbo 的真实拓扑：负面条件走 ConditioningZeroOut
 * 复用同一个正面文本节点。这类结构的正面入口曾被误判为空。
 */
function buildZeroOutNegativeWorkflow(): ApiWorkflow {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'qwen_image' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '27': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    '33': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['27', 0] } },
    '11': { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3, model: ['1', 0] } },
    '13': { class_type: 'EmptySD3LatentImage', inputs: { width: 1080, height: 1920, batch_size: 1 } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        seed: 0, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1,
        model: ['11', 0], positive: ['27', 0], negative: ['33', 0], latent_image: ['13', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'Qingyu' } },
  }
}

describe('normalizeComfyWorkflow', () => {
  it('API 格式工作流可以直接导入，不做画布转换', () => {
    const api = {
      '3': { class_type: 'KSampler', inputs: { steps: 20 } },
      '9': { class_type: 'SaveImage', inputs: {} },
    }
    const { workflow, converted } = normalizeComfyWorkflow(api)
    expect(converted).toBe(false)
    expect(workflow['3'].class_type).toBe('KSampler')
  })

  it('画布格式工作流会被转换并标记 converted', () => {
    const { converted } = normalizeComfyWorkflow({
      nodes: [{ id: 9, type: 'SaveImage', inputs: [] }],
      links: [],
    })
    expect(converted).toBe(true)
  })

  it('非对象或空节点工作流抛出可读错误', () => {
    expect(() => normalizeComfyWorkflow([])).toThrow('顶层必须是对象')
    expect(() => normalizeComfyWorkflow({ '1': { class_type: 'KSampler' } })).toThrow('不是有效的 ComfyUI API 节点')
  })
})

describe('analyzeComfyWorkflow 工作流类型判定', () => {
  it('识别 Z-Image 为文生图并标记 compatible', () => {
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow())
    expect(analysis.kind).toBe('text-to-image')
    expect(analysis.compatible).toBe(true)
    expect(analysis.nodeCount).toBe(9)
  })

  it('包含 LoadImage 的工作流判定为图生图', () => {
    const workflow = buildZImageWorkflow()
    workflow['10'] = { class_type: 'LoadImage', inputs: { image: 'input.png' } }
    workflow['7'].inputs.latent_image = ['10', 0]
    const analysis = analyzeComfyWorkflow(workflow)
    expect(analysis.kind).toBe('image-to-image')
    expect(analysis.compatible).toBe(false)
    expect(analysis.warnings.map((item) => item.code)).toContain('requires-image-input')
  })

  it('视频工作流不会被误判为文生图', () => {
    const analysis = analyzeComfyWorkflow({
      '1': { class_type: 'KSampler', inputs: { steps: 8 } },
      '2': { class_type: 'SaveWEBM', inputs: { images: ['1', 0] } },
    })
    expect(analysis.kind).toBe('video')
    expect(analysis.compatible).toBe(false)
    expect(analysis.warnings.map((item) => item.code)).toContain('video-workflow')
  })

  it('没有输出节点时给出 no-output 警告', () => {
    const analysis = analyzeComfyWorkflow({
      '1': { class_type: 'KSampler', inputs: { steps: 8 } },
    })
    expect(analysis.kind).toBe('unknown')
    expect(analysis.warnings.map((item) => item.code)).toContain('no-output')
  })
})

describe('analyzeComfyWorkflow 可达性', () => {
  it('只分析能连到输出的节点，断开的实验节点被忽略', () => {
    const workflow = buildZImageWorkflow()
    workflow['99'] = { class_type: 'KSampler', inputs: { steps: 999, cfg: 42 } }
    const analysis = analyzeComfyWorkflow(workflow)

    expect(analysis.parameterGroups.some((group) => group.nodeId === '99')).toBe(false)
    const warning = analysis.warnings.find((item) => item.code === 'unreachable-nodes')
    expect(warning?.nodeIds).toEqual(['99'])
    // nodeCount 统计全部节点，但参数与依赖只来自可达集。
    expect(analysis.nodeCount).toBe(10)
    expect(analysis.dependencies.every((item) => item.nodeId !== '99')).toBe(true)
  })

  it('可达性沿多级引用传递，间接节点也会进入分析', () => {
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow())
    const dependencyNodeIds = analysis.dependencies.map((item) => item.nodeId)
    expect(dependencyNodeIds).toEqual(expect.arrayContaining(['1', '2', '3']))
  })
})

describe('analyzeComfyWorkflow 模型依赖', () => {
  it('识别 UNETLoader / CLIPLoader / VAELoader 组合，且不把非模型输入误判为模型名', () => {
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow())
    expect(analysis.dependencies.map((item) => [item.nodeId, item.inputName, item.value, item.label])).toEqual([
      ['1', 'unet_name', 'z_image_turbo_bf16.safetensors', 'UNet'],
      ['2', 'clip_name', 'qwen_3_4b.safetensors', 'CLIP'],
      ['3', 'vae_name', 'ae.safetensors', 'VAE'],
    ])
    // weight_dtype / type / device 不应出现在依赖中。
    expect(analysis.dependencies.some((item) => item.inputName === 'weight_dtype')).toBe(false)
    expect(analysis.dependencies.some((item) => item.inputName === 'device')).toBe(false)
  })

  it('依赖记录 provides 能力，并按引用反查 usedBy', () => {
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow())
    const unet = analysis.dependencies.find((item) => item.nodeId === '1')
    const clip = analysis.dependencies.find((item) => item.nodeId === '2')
    expect(unet?.provides).toEqual(['MODEL'])
    expect(unet?.usedBy).toEqual([{ nodeId: '7', inputName: 'model' }])
    // 两个 CLIPTextEncode 共享同一个 CLIPLoader，归并为一条依赖。
    expect(clip?.usedBy).toEqual([
      { nodeId: '4', inputName: 'clip' },
      { nodeId: '5', inputName: 'clip' },
    ])
  })

  it('识别 CheckpointLoaderSimple 并提供 MODEL / CLIP / VAE 三种能力', () => {
    const analysis = analyzeComfyWorkflow({
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'p', clip: ['1', 1] } },
      '3': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
      '4': {
        class_type: 'KSampler',
        inputs: { steps: 20, model: ['1', 0], positive: ['2', 0], latent_image: ['3', 0] },
      },
      '5': { class_type: 'SaveImage', inputs: { images: ['4', 0] } },
    })
    const checkpoint = analysis.dependencies.find((item) => item.classType === 'CheckpointLoaderSimple')
    expect(checkpoint?.label).toBe('Checkpoint')
    expect(checkpoint?.provides).toEqual(['MODEL', 'CLIP', 'VAE'])
    expect(analysis.kind).toBe('text-to-image')
  })

  it('识别 LoRA 的模型名与强度，且强度作为模型侧可调项', () => {
    const workflow = buildZImageWorkflow()
    workflow['11'] = {
      class_type: 'LoraLoader',
      inputs: { lora_name: 'detail.safetensors', strength_model: 0.75, strength_clip: 0.6, model: ['1', 0], clip: ['2', 0] },
    }
    workflow['7'].inputs.model = ['11', 0]
    const analysis = analyzeComfyWorkflow(workflow)

    const lora = analysis.dependencies.find((item) => item.classType === 'LoraLoader')
    expect(lora?.value).toBe('detail.safetensors')
    expect(lora?.provides).toEqual(['MODEL', 'CLIP'])

    const group = analysis.parameterGroups.find((item) => item.nodeId === '11')
    expect(group?.stage).toBe('model')
    expect(group?.parameters.map((item) => [item.inputName, item.workflowValue])).toEqual([
      ['strength_model', 0.75],
      ['strength_clip', 0.6],
    ])
  })
})

describe('analyzeComfyWorkflow 提示词与输出绑定', () => {
  it('按 sampling 的 positive/negative 输入区分正负提示词节点', () => {
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow())
    expect(analysis.promptBindings).toEqual([
      { role: 'positive', nodeId: '4', inputName: 'text' },
      { role: 'negative', nodeId: '5', inputName: 'text' },
    ])
    expect(analysis.outputBindings).toEqual([{ role: 'output', nodeId: '9', inputName: 'images' }])
  })

  it('没有负面条件节点时不产生负面绑定', () => {
    const analysis = analyzeComfyWorkflow({
      '1': { class_type: 'CLIPTextEncode', inputs: { text: 'p' } },
      '2': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
      '3': { class_type: 'KSampler', inputs: { steps: 20, positive: ['1', 0], latent_image: ['2', 0] } },
      '4': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
    })
    expect(analysis.promptBindings.some((item) => item.role === 'negative')).toBe(false)
  })

  it('多个正面候选且无法唯一确定时标记 ambiguous-prompt', () => {
    const workflow = buildZImageWorkflow()
    // 两个正面文本节点经 ConditioningCombine 合并后进入采样器，无法唯一确定入口。
    workflow['12'] = { class_type: 'CLIPTextEncode', inputs: { text: 'style tags', clip: ['2', 0] } }
    workflow['40'] = {
      class_type: 'ConditioningCombine',
      inputs: { conditioning_1: ['4', 0], conditioning_2: ['12', 0] },
    }
    workflow['7'].inputs.positive = ['40', 0]
    const analysis = analyzeComfyWorkflow(workflow)

    expect(analysis.promptBindings.filter((item) => item.role === 'positive').map((item) => item.nodeId))
      .toEqual(['4', '12'])
    expect(analysis.warnings.map((item) => item.code)).toContain('ambiguous-prompt')
  })

  it('采样器的 positive 经中间 conditioning 节点时仍能回溯到文本入口', () => {
    const workflow = buildZImageWorkflow()
    workflow['41'] = { class_type: 'ConditioningSetArea', inputs: { conditioning: ['4', 0], width: 512, height: 512 } }
    workflow['7'].inputs.positive = ['41', 0]
    const analysis = analyzeComfyWorkflow(workflow)

    expect(analysis.promptBindings.filter((item) => item.role === 'positive').map((item) => item.nodeId)).toEqual(['4'])
    expect(analysis.warnings.map((item) => item.code)).not.toContain('no-prompt')
    expect(analysis.warnings.map((item) => item.code)).not.toContain('ambiguous-prompt')
  })

  it('负面走 ConditioningZeroOut 复用正面文本节点时，仍识别出正面入口', () => {
    // 真实 image_z_image_turbo 的拓扑：negative 接 ConditioningZeroOut，
    // 而它引用的正是 positive 用的那个文本节点。回溯不得穿过 ZeroOut。
    const analysis = analyzeComfyWorkflow(buildZeroOutNegativeWorkflow())

    expect(analysis.kind).toBe('text-to-image')
    expect(analysis.compatible).toBe(true)
    expect(analysis.promptBindings.filter((item) => item.role === 'positive').map((item) => item.nodeId))
      .toEqual(['27'])
    // ZeroOut 已清零，其上游文本不应被当作负面入口。
    expect(analysis.promptBindings.filter((item) => item.role === 'negative')).toHaveLength(0)
    expect(analysis.warnings.map((item) => item.code)).not.toContain('no-prompt')
    expect(analysis.warnings).toHaveLength(0)
  })

  it('多个输出节点时标记 ambiguous-output', () => {
    const workflow = buildZImageWorkflow()
    workflow['20'] = { class_type: 'PreviewImage', inputs: { images: ['8', 0] } }
    const analysis = analyzeComfyWorkflow(workflow)
    expect(analysis.outputBindings).toHaveLength(2)
    expect(analysis.warnings.map((item) => item.code)).toContain('ambiguous-output')
  })

  it('缺少提示词节点时给出 no-prompt 且不可用', () => {
    const analysis = analyzeComfyWorkflow({
      '1': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
      '2': { class_type: 'KSampler', inputs: { steps: 20, latent_image: ['1', 0] } },
      '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
    })
    expect(analysis.warnings.map((item) => item.code)).toContain('no-prompt')
    expect(analysis.compatible).toBe(false)
  })
})

describe('analyzeComfyWorkflow 参数分组', () => {
  it('尺寸参数使用 size 类型并记录配对的 height 输入', () => {
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow())
    const group = analysis.parameterGroups.find((item) => item.stage === 'output')
    expect(group?.parameters[0]).toMatchObject({
      id: '6.width',
      type: 'size',
      workflowValue: '1080x1920',
      pairedInputName: 'height',
      pairedWorkflowValue: 1920,
    })
  })

  it('单采样阶段只产生一个 sampling 分组且不含尺寸', () => {
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow())
    const sampling = analysis.parameterGroups.filter((item) => item.stage === 'sampling')
    expect(sampling).toHaveLength(1)
    expect(sampling[0].nodeId).toBe('7')
    expect(sampling[0].parameters.map((item) => item.inputName)).toEqual([
      'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise', 'seed',
    ])
  })

  it('多个采样阶段按节点分别分组，并标记 multi-stage', () => {
    const workflow = buildZImageWorkflow()
    workflow['30'] = {
      class_type: 'KSampler',
      inputs: { steps: 4, cfg: 1.5, denoise: 0.4, latent_image: ['8', 0], model: ['1', 0] },
      _meta: { title: '精修' },
    }
    workflow['9'].inputs.images = ['30', 0]
    const analysis = analyzeComfyWorkflow(workflow)

    const sampling = analysis.parameterGroups.filter((item) => item.stage === 'sampling')
    expect(sampling.map((item) => item.nodeId)).toEqual(['7', '30'])
    // 阶段标题取自节点 title，缺失时回退为 class_type + 节点 ID。
    expect(sampling[1].title).toBe('精修')
    expect(sampling[0].title).toBe('KSampler #7')
    expect(analysis.warnings.map((item) => item.code)).toContain('multi-stage')
  })

  it('种子归入高级项，不作为主要参数展示', () => {
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow())
    const sampler = analysis.parameterGroups.find((item) => item.nodeId === '7')
    expect(sampler?.parameters.find((item) => item.inputName === 'seed')?.advanced).toBe(true)
    expect(sampler?.parameters.find((item) => item.inputName === 'steps')?.advanced).toBeUndefined()
  })

  it('参数 id 采用 节点ID.输入名 形式，与运行时覆盖键一致', () => {
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow())
    const steps = analysis.parameterGroups
      .flatMap((group) => group.parameters)
      .find((item) => item.inputName === 'steps')
    expect(steps?.id).toBe('7.steps')
  })

  it('被引用连接的输入不暴露为可调参数', () => {
    const workflow = buildZImageWorkflow()
    workflow['7'].inputs.steps = ['40', 0]
    const analysis = analyzeComfyWorkflow(workflow)
    const sampler = analysis.parameterGroups.find((item) => item.nodeId === '7')
    expect(sampler?.parameters.some((item) => item.inputName === 'steps')).toBe(false)
  })
})

describe('analyzeComfyWorkflow 与 /object_info 协作', () => {
  it('object_info 可用时采用其选项与范围', () => {
    const objectInfo = {
      UNETLoader: { input: { unet_name: [['a.safetensors', 'b.safetensors']] } },
      KSampler: {
        input: {
          steps: ['INT', { min: 1, max: 100, step: 1 }],
          sampler_name: [['euler', 'res_multistep']],
          cfg: ['FLOAT', { min: 0, max: 100, step: 0.1 }],
        },
      },
    }
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow(), objectInfo)
    const sampler = analysis.parameterGroups.find((item) => item.nodeId === '7')
    const steps = sampler?.parameters.find((item) => item.inputName === 'steps')
    const samplerName = sampler?.parameters.find((item) => item.inputName === 'sampler_name')
    expect(steps).toMatchObject({ type: 'number', min: 1, max: 100, step: 1 })
    expect(samplerName).toMatchObject({ type: 'select', options: ['euler', 'res_multistep'] })

    const unet = analysis.dependencies.find((item) => item.nodeId === '1')
    expect(unet?.options).toEqual(['a.safetensors', 'b.safetensors'])
    expect(unet?.available).toBe(false)
  })

  it('object_info 不可用时按 JS 类型降级，不阻塞分析', () => {
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow())
    const sampler = analysis.parameterGroups.find((item) => item.nodeId === '7')
    const steps = sampler?.parameters.find((item) => item.inputName === 'steps')
    const samplerName = sampler?.parameters.find((item) => item.inputName === 'sampler_name')
    // 降级后仍保留可用控件类型：数值与可输入下拉。
    expect(steps?.type).toBe('number')
    expect(samplerName?.type).toBe('select')
    expect(steps?.min).toBeUndefined()
    expect(analysis.dependencies.every((item) => item.options === undefined)).toBe(true)
    expect(analysis.compatible).toBe(true)
  })

  it('节点类型缺失时给出 unknown-node 并置为不可用', () => {
    const objectInfo = { KSampler: { input: {} } }
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow(), objectInfo)
    const warning = analysis.warnings.find((item) => item.code === 'unknown-node')
    expect(warning?.nodeIds).toEqual(expect.arrayContaining(['1', '2', '3', '9']))
    expect(analysis.compatible).toBe(false)
  })

  it('模型不在可用列表时给出 missing-model 并置为不可用', () => {
    const objectInfo = { UNETLoader: { input: { unet_name: [['other.safetensors']] } } }
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow(), objectInfo)
    const warning = analysis.warnings.find((item) => item.code === 'missing-model')
    expect(warning?.nodeIds).toEqual(['1'])
    expect(analysis.compatible).toBe(false)
  })

  it('无 object_info 时不产生 unknown-node 或 missing-model 警告', () => {
    const analysis = analyzeComfyWorkflow(buildZImageWorkflow())
    const codes = analysis.warnings.map((item) => item.code)
    expect(codes).not.toContain('unknown-node')
    expect(codes).not.toContain('missing-model')
  })
})

describe('analyzeComfyWorkflow 与转换流程串联', () => {
  it('画布工作流经规范化后可直接分析', () => {
    const { workflow } = normalizeComfyWorkflow({
      nodes: [
        { id: 1, type: 'CLIPTextEncode', inputs: [{ name: 'text', link: null, widget: { name: 'text' } }], widgets_values_named: { text: 'hello' } },
        { id: 2, type: 'EmptyLatentImage', inputs: [{ name: 'width', link: null, widget: { name: 'width' } }, { name: 'height', link: null, widget: { name: 'height' } }], widgets_values_named: { width: 512, height: 768 } },
        { id: 3, type: 'KSampler', inputs: [{ name: 'steps', link: null, widget: { name: 'steps' } }, { name: 'positive', link: 11 }, { name: 'latent_image', link: 12 }], widgets_values_named: { steps: 12 } },
        { id: 4, type: 'SaveImage', inputs: [{ name: 'images', link: 13 }] },
      ],
      links: [[11, 1, 0, 3, 1, 'CONDITIONING'], [12, 2, 0, 3, 2, 'LATENT'], [13, 3, 0, 4, 0, 'IMAGE']],
    })
    const analysis = analyzeComfyWorkflow(workflow)
    expect(analysis.kind).toBe('text-to-image')
    expect(analysis.compatible).toBe(true)
    expect(analysis.promptBindings[0]).toMatchObject({ role: 'positive', nodeId: '1' })
    expect(analysis.parameterGroups.find((item) => item.stage === 'output')?.parameters[0].workflowValue).toBe('512x768')
    expect(analysis.parameterGroups.find((item) => item.nodeId === '3')?.parameters[0].workflowValue).toBe(12)
  })
})

describe('hashComfyWorkflow', () => {
  it('同一工作流产生稳定哈希，不同内容产生不同哈希', () => {
    const a = buildZImageWorkflow()
    const b = buildZImageWorkflow()
    expect(hashComfyWorkflow(a)).toBe(hashComfyWorkflow(b))

    b['7'].inputs.steps = 9
    expect(hashComfyWorkflow(b)).not.toBe(hashComfyWorkflow(a))
  })
})

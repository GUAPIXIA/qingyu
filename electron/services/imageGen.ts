/**
 * 文生图服务
 *
 * 支持三种 provider：
 * - sd-webui: Stable Diffusion WebUI (Automatic1111) REST API
 * - comfyui:  ComfyUI 原生工作流队列 API
 * - openai:   OpenAI DALL-E 3 Images API
 */

import { createLogger } from './logger'
import type { ImageGenModelConfig } from '../../shared/types'

const log = createLogger('imageGen')

/** 生图选项 */
export interface ImageGenOptions {
  negativePrompt?: string
  size?: string
  quality?: string
}

/** 生图结果 */
export interface ImageGenResult {
  success: boolean
  images?: string[]    // base64 data URL 数组
  error?: string
}

/** 主入口：根据 provider 分派到不同适配器 */
export async function generateImage(
  config: ImageGenModelConfig,
  prompt: string,
  options?: ImageGenOptions,
): Promise<ImageGenResult> {
  // 根据后端类型清洗提示词
  const cleanedPrompt = config.provider === 'sd-webui'
    ? sanitizeSdPrompt(prompt)
    : config.provider === 'comfyui'
      ? prompt.trim()
      : sanitizeOpenAiPrompt(prompt)

  log.info('生图请求', {
    provider: config.provider,
    prompt: cleanedPrompt.substring(0, 80),
    size: options?.size ?? config.size,
  })

  try {
    switch (config.provider) {
      case 'sd-webui':
        return await sdWebuiGenerate(config, cleanedPrompt, options)
      case 'comfyui':
        return await comfyuiGenerate(config, cleanedPrompt, options)
      case 'openai':
        return await openaiGenerate(config, cleanedPrompt, options)
      default:
        return { success: false, error: `不支持的 provider: ${config.provider}` }
    }
  } catch (err) {
    log.error('生图失败', { provider: config.provider, error: err instanceof Error ? err.message : String(err) })
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ===================== ComfyUI 适配器 =====================

interface ComfyNode {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}

type ComfyWorkflow = Record<string, ComfyNode>

interface ComfyOutputImage {
  filename: string
  subfolder?: string
  type?: string
}

interface ComfyHistoryEntry {
  status?: { completed?: boolean; status_str?: string; messages?: unknown[] }
  outputs?: Record<string, { images?: ComfyOutputImage[] }>
}

function comfyHeaders(config: ImageGenModelConfig, json = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (json) headers['Content-Type'] = 'application/json'
  const apiKey = config.apiKey?.trim()
  if (apiKey) {
    // 同时兼容常见反向代理 Bearer 鉴权与 Comfy Cloud 的 X-API-Key。
    headers.Authorization = `Bearer ${apiKey}`
    headers['X-API-Key'] = apiKey
  }
  return headers
}

function defaultComfyWorkflow(
  config: ImageGenModelConfig,
  prompt: string,
  negativePrompt: string,
  width: number,
  height: number,
): ComfyWorkflow {
  if (!config.model.trim()) {
    throw new Error('ComfyUI 内置工作流需要填写模型文件名，或提供自定义 API 工作流 JSON')
  }

  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: Math.floor(Math.random() * 0x7fffffff),
        steps: config.steps ?? 20,
        cfg: config.cfgScale ?? 7,
        sampler_name: config.sampler || 'euler',
        scheduler: config.scheduler || 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: config.model },
    },
    '5': {
      class_type: 'EmptyLatentImage',
      inputs: { width, height, batch_size: 1 },
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text: prompt, clip: ['4', 1] },
      _meta: { title: 'Positive Prompt' },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: negativePrompt, clip: ['4', 1] },
      _meta: { title: 'Negative Prompt' },
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: { samples: ['3', 0], vae: ['4', 2] },
    },
    '9': {
      class_type: 'SaveImage',
      inputs: { filename_prefix: 'Qingyu', images: ['8', 0] },
    },
  }
}

function replaceWorkflowPlaceholders(value: unknown, replacements: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceWorkflowPlaceholders(item, replacements))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, replaceWorkflowPlaceholders(item, replacements)]),
    )
  }
  if (typeof value !== 'string') return value
  if (Object.prototype.hasOwnProperty.call(replacements, value)) return replacements[value]
  return Object.entries(replacements).reduce(
    (result, [key, replacement]) => result.replaceAll(key, String(replacement)),
    value,
  )
}

function customComfyWorkflow(
  config: ImageGenModelConfig,
  prompt: string,
  negativePrompt: string,
  width: number,
  height: number,
): ComfyWorkflow {
  let parsed: unknown
  try {
    parsed = JSON.parse(config.workflow || '')
  } catch (err) {
    throw new Error(`ComfyUI 工作流 JSON 无效: ${err instanceof Error ? err.message : String(err)}`)
  }

  const root = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  const rawWorkflow = root?.prompt && typeof root.prompt === 'object' ? root.prompt : root
  if (!rawWorkflow || Array.isArray(rawWorkflow)) {
    throw new Error('ComfyUI 工作流必须是“API 格式”的节点对象')
  }

  const seed = Math.floor(Math.random() * 0x7fffffff)
  const replacements: Record<string, unknown> = {
    '{{prompt}}': prompt,
    '{{negative_prompt}}': negativePrompt,
    '{{width}}': width,
    '{{height}}': height,
    '{{seed}}': seed,
    '{{steps}}': config.steps ?? 20,
    '{{cfg}}': config.cfgScale ?? 7,
    '{{sampler}}': config.sampler || 'euler',
    '{{scheduler}}': config.scheduler || 'normal',
    '{{checkpoint}}': config.model,
  }
  const workflow = replaceWorkflowPlaceholders(rawWorkflow, replacements) as ComfyWorkflow

  // 对核心节点做自动映射；自定义节点可继续使用上面的占位符。
  const textNodes: Array<[string, ComfyNode]> = []
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object' || !node.inputs || typeof node.class_type !== 'string') {
      throw new Error(`ComfyUI 工作流节点 ${nodeId} 格式无效，请导出 API 格式工作流`)
    }
    if (node.class_type === 'CheckpointLoaderSimple' && config.model.trim()) {
      node.inputs.ckpt_name = config.model
    }
    if (node.class_type === 'EmptyLatentImage' || node.class_type === 'EmptySD3LatentImage') {
      node.inputs.width = width
      node.inputs.height = height
    }
    if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') {
      if ('seed' in node.inputs || node.class_type === 'KSampler') node.inputs.seed = seed
      if ('noise_seed' in node.inputs) node.inputs.noise_seed = seed
      if ('steps' in node.inputs) node.inputs.steps = config.steps ?? 20
      if ('cfg' in node.inputs) node.inputs.cfg = config.cfgScale ?? 7
      if ('sampler_name' in node.inputs) node.inputs.sampler_name = config.sampler || 'euler'
      if ('scheduler' in node.inputs) node.inputs.scheduler = config.scheduler || 'normal'
    }
    if (node.class_type === 'CLIPTextEncode') textNodes.push([nodeId, node])
  }

  const unmatchedTextNodes: Array<[string, ComfyNode]> = []
  let hasPositiveNode = false
  let hasNegativeNode = false
  for (const [nodeId, node] of textNodes) {
    const label = `${nodeId} ${node._meta?.title ?? ''}`.toLowerCase()
    if (label.includes('negative')) {
      node.inputs.text = negativePrompt
      hasNegativeNode = true
    } else if (label.includes('positive')) {
      node.inputs.text = prompt
      hasPositiveNode = true
    } else {
      unmatchedTextNodes.push([nodeId, node])
    }
  }
  if (!hasPositiveNode && unmatchedTextNodes[0]) {
    unmatchedTextNodes.shift()![1].inputs.text = prompt
  }
  if (!hasNegativeNode && unmatchedTextNodes[0]) {
    unmatchedTextNodes.shift()![1].inputs.text = negativePrompt
  }

  return workflow
}

function buildComfyWorkflow(
  config: ImageGenModelConfig,
  prompt: string,
  options?: ImageGenOptions,
): ComfyWorkflow {
  const [width, height] = parseSize(options?.size || config.size || '512x512')
  const negativePrompt = options?.negativePrompt || config.negativePrompt || ''
  return config.workflow?.trim()
    ? customComfyWorkflow(config, prompt, negativePrompt, width, height)
    : defaultComfyWorkflow(config, prompt, negativePrompt, width, height)
}

async function comfyuiGenerate(
  config: ImageGenModelConfig,
  prompt: string,
  options?: ImageGenOptions,
): Promise<ImageGenResult> {
  const baseUrl = config.baseUrl.replace(/\/$/, '')
  const workflow = buildComfyWorkflow(config, prompt, options)
  const clientId = globalThis.crypto?.randomUUID?.() ?? `qingyu-${Date.now()}`
  const queueResponse = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: comfyHeaders(config, true),
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal: AbortSignal.timeout(15000),
  })
  if (!queueResponse.ok) {
    const errorText = await queueResponse.text()
    throw new Error(`ComfyUI 入队失败 ${queueResponse.status}: ${errorText.substring(0, 300)}`)
  }
  const queued = await queueResponse.json() as {
    prompt_id?: string
    error?: { message?: string } | string
    node_errors?: unknown
  }
  if (!queued.prompt_id) {
    const detail = typeof queued.error === 'string' ? queued.error : queued.error?.message
    throw new Error(`ComfyUI 未返回 prompt_id${detail ? `: ${detail}` : ''}`)
  }

  const promptId = queued.prompt_id
  const deadline = Date.now() + 120000
  let outputImages: ComfyOutputImage[] = []
  while (Date.now() < deadline) {
    const historyResponse = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {
      method: 'GET',
      headers: comfyHeaders(config),
      signal: AbortSignal.timeout(10000),
    })
    if (!historyResponse.ok) {
      throw new Error(`ComfyUI 历史查询失败 ${historyResponse.status}`)
    }
    const history = await historyResponse.json() as Record<string, ComfyHistoryEntry>
    const entry = history[promptId]
    if (entry?.status?.status_str === 'error') {
      throw new Error('ComfyUI 工作流执行失败，请检查节点和模型配置')
    }
    if (entry?.outputs) {
      outputImages = Object.values(entry.outputs).flatMap((output) => output.images ?? [])
      if (outputImages.length > 0) break
    }
    if (entry?.status?.completed) {
      throw new Error('ComfyUI 工作流已完成，但没有 SaveImage/PreviewImage 输出')
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (outputImages.length === 0) throw new Error('ComfyUI 生图超时（120秒）')

  const images = await Promise.all(outputImages.map(async (image) => {
    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder || '',
      type: image.type || 'output',
    })
    const imageResponse = await fetch(`${baseUrl}/view?${query}`, {
      method: 'GET',
      headers: comfyHeaders(config),
      signal: AbortSignal.timeout(30000),
    })
    if (!imageResponse.ok) throw new Error(`ComfyUI 图片下载失败 ${imageResponse.status}`)
    const mime = imageResponse.headers.get('content-type')?.split(';')[0] || 'image/png'
    const base64 = Buffer.from(await imageResponse.arrayBuffer()).toString('base64')
    return `data:${mime};base64,${base64}`
  }))

  log.info('ComfyUI 生图成功', { count: images.length, promptId })
  return { success: true, images }
}

/** 解析尺寸字符串 "512x512" -> [512, 512] */
function parseSize(size: string): [number, number] {
  const match = size.match(/^(\d+)\s*[x×]\s*(\d+)$/i)
  if (match) {
    return [parseInt(match[1], 10), parseInt(match[2], 10)]
  }
  return [512, 512] // 默认
}

/**
 * SD WebUI 提示词清洗（参考 SillyTavern processReply）
 *
 * SD 模型使用逗号分隔的标签（如 "1girl, red dress, outdoor"），
 * 需要：
 * 1. 移除引号（含中文引号）
 * 2. 换行替换为逗号
 * 3. NFD 规范化
 * 4. 移除非 SD 语法字符（保留 a-zA-Z0-9 及 .,:_(){}<>[]/'|#- 和中文）
 * 5. 按逗号分割、trim、过滤空值、重新 join
 */
function sanitizeSdPrompt(str: string): string {
  if (!str) return str
  let s = str
    .replaceAll('"', '')
    .replaceAll('"', '')
    .replaceAll('"', '')
    .replaceAll('\n', ', ')
  s = s.normalize('NFD')
  // 保留：字母数字、SD 语法符号、中文 CJK 字符
  s = s.replace(/[^a-zA-Z0-9.,:_(){}<>[\]/\-'|#\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\s]+/g, ' ')
  s = s.split(',').map((x) => x.trim()).filter((x) => x).join(', ')
  return s
}

/**
 * OpenAI DALL-E 提示词轻度清洗
 *
 * DALL-E 支持自然语言描述，仅移除多余引号和换行，保留原始语义
 */
function sanitizeOpenAiPrompt(str: string): string {
  if (!str) return str
  return str
    .replaceAll('"', '')
    .replaceAll('"', '')
    .replaceAll('"', '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ===================== SD WebUI (Automatic1111) 适配器 =====================

async function sdWebuiGenerate(
  config: ImageGenModelConfig,
  prompt: string,
  options?: ImageGenOptions,
): Promise<ImageGenResult> {
  const baseUrl = config.baseUrl.replace(/\/$/, '')
  const url = `${baseUrl}/sdapi/v1/txt2img`

  const sizeStr = options?.size || config.size || '512x512'
  const [width, height] = parseSize(sizeStr)

  const body = {
    prompt,
    negative_prompt: options?.negativePrompt || config.negativePrompt || '',
    steps: config.steps ?? 20,
    cfg_scale: config.cfgScale ?? 7,
    width,
    height,
    sampler_name: config.sampler || 'Euler a',
    batch_size: 1,
  }

  log.debug('SD WebUI 请求', { url, width, height, steps: body.steps })

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // R4 修复：生图请求无超时，SD WebUI 挂起时请求永不结束
    signal: AbortSignal.timeout(120000),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`SD WebUI API 错误 ${response.status}: ${errText.substring(0, 200)}`)
  }

  const data = (await response.json()) as { images?: unknown }
  if (!data.images || !Array.isArray(data.images) || data.images.length === 0) {
    throw new Error('SD WebUI 返回的图片数据为空')
  }

  // SD WebUI 返回的 images 数组中每个元素是纯 base64（无 data: 前缀）
  const images = data.images.map((b64: string) => `data:image/png;base64,${b64}`)

  log.info('SD WebUI 生图成功', { count: images.length, size: sizeStr })

  return { success: true, images }
}

// ===================== OpenAI DALL-E 适配器 =====================

async function openaiGenerate(
  config: ImageGenModelConfig,
  prompt: string,
  options?: ImageGenOptions,
): Promise<ImageGenResult> {
  const baseUrl = config.baseUrl.replace(/\/$/, '')
  const url = `${baseUrl}/images/generations`

  const body = {
    model: config.model || 'dall-e-3',
    prompt,
    n: 1,
    size: options?.size || config.size || '1024x1024',
    quality: options?.quality || config.quality || 'standard',
    response_format: 'b64_json',
  }

  log.debug('OpenAI 生图请求', { url, model: body.model, size: body.size })

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    // R4 修复：生图请求无超时，Provider 挂起时请求永不结束
    signal: AbortSignal.timeout(120000),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`OpenAI API 错误 ${response.status}: ${errText.substring(0, 200)}`)
  }

  const data = (await response.json()) as { data?: { b64_json?: string }[] }
  if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
    throw new Error('OpenAI 返回的图片数据为空')
  }

  // OpenAI 返回 b64_json 字段
  const images = data.data
    .map((item) => item.b64_json)
    .filter((b64): b64 is string => !!b64)
    .map((b64: string) => `data:image/png;base64,${b64}`)

  if (images.length === 0) {
    throw new Error('OpenAI 返回的图片数据格式异常')
  }

  log.info('OpenAI 生图成功', { count: images.length, size: body.size })

  return { success: true, images }
}

// ===================== 连接测试 =====================

export interface TestConnectionConfig {
  provider: string
  baseUrl: string
  apiKey: string
}

export interface TestConnectionResult {
  success: boolean
  message?: string
  error?: string
}

/**
 * 测试生图后端连接
 *
 * SD WebUI: GET /sdapi/v1/options 检查是否响应
 * ComfyUI:  GET /system_stats 检查原生服务是否响应
 * OpenAI:   GET /models 检查 API key 是否有效
 */
export async function testImageGenConnection(config: TestConnectionConfig): Promise<TestConnectionResult> {
  const baseUrl = config.baseUrl.replace(/\/$/, '')

  try {
    if (config.provider === 'comfyui') {
      const url = `${baseUrl}/system_stats`
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (config.apiKey?.trim()) {
        headers.Authorization = `Bearer ${config.apiKey.trim()}`
        headers['X-API-Key'] = config.apiKey.trim()
      }
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` }
      }
      return { success: true, message: '连接成功，ComfyUI 服务可用' }
    }

    if (config.provider === 'sd-webui') {
      // SD WebUI: 轮询 /sdapi/v1/options
      const url = `${baseUrl}/sdapi/v1/options`
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
      })

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` }
      }

      const data = (await response.json()) as { sd_model_checkpoint?: string; sd_model_hash?: string }
      const model = data?.sd_model_checkpoint || data?.sd_model_hash || '未知'
      return { success: true, message: `连接成功，当前模型: ${model}` }
    }

    if (config.provider === 'openai') {
      // OpenAI: GET /models 验证 API key
      const url = `${baseUrl}/models`
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
        signal: AbortSignal.timeout(10000),
      })

      if (!response.ok) {
        if (response.status === 401) {
          return { success: false, error: 'API Key 无效（401 Unauthorized）' }
        }
        const errText = await response.text()
        return { success: false, error: `HTTP ${response.status}: ${errText.substring(0, 100)}` }
      }

      const data = (await response.json()) as { data?: unknown[] }
      const modelCount = data?.data?.length ?? 0
      return { success: true, message: `连接成功，可用模型 ${modelCount} 个` }
    }

    return { success: false, error: `不支持的 provider: ${config.provider}` }
  } catch (err) {
    if ((err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError') {
      return { success: false, error: '连接超时（10秒），请检查地址是否正确及服务是否已启动' }
    }
    if ((err as NodeJS.ErrnoException)?.code === 'ECONNREFUSED') {
      return { success: false, error: '连接被拒绝，请确认服务已启动且端口正确' }
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 文生图服务
 *
 * 支持两种 provider：
 * - sd-webui: Stable Diffusion WebUI (Automatic1111) REST API
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
      case 'openai':
        return await openaiGenerate(config, cleanedPrompt, options)
      default:
        return { success: false, error: `不支持的 provider: ${config.provider}` }
    }
  } catch (err: any) {
    log.error('生图失败', { provider: config.provider, error: err?.message ?? String(err) })
    return { success: false, error: err?.message ?? String(err) }
  }
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
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`SD WebUI API 错误 ${response.status}: ${errText.substring(0, 200)}`)
  }

  const data: any = await response.json()
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
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`OpenAI API 错误 ${response.status}: ${errText.substring(0, 200)}`)
  }

  const data: any = await response.json()
  if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
    throw new Error('OpenAI 返回的图片数据为空')
  }

  // OpenAI 返回 b64_json 字段
  const images = data.data
    .map((item: any) => item.b64_json)
    .filter((b64: string) => !!b64)
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
 * OpenAI:   GET /models 检查 API key 是否有效
 */
export async function testImageGenConnection(config: TestConnectionConfig): Promise<TestConnectionResult> {
  const baseUrl = config.baseUrl.replace(/\/$/, '')

  try {
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

      const data: any = await response.json()
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

      const data: any = await response.json()
      const modelCount = data?.data?.length ?? 0
      return { success: true, message: `连接成功，可用模型 ${modelCount} 个` }
    }

    return { success: false, error: `不支持的 provider: ${config.provider}` }
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { success: false, error: '连接超时（10秒），请检查地址是否正确及服务是否已启动' }
    }
    if (err?.code === 'ECONNREFUSED') {
      return { success: false, error: '连接被拒绝，请确认服务已启动且端口正确' }
    }
    return { success: false, error: err?.message ?? String(err) }
  }
}

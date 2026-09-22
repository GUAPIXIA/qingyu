/**
 * 文生图服务
 *
 * 支持三种 provider：
 * - sd-webui: Stable Diffusion WebUI (Automatic1111) REST API
 * - comfyui:  ComfyUI 原生工作流队列 API
 * - openai:   OpenAI DALL-E 3 Images API
 */

import { createLogger } from './logger'
import type {
  ComfyImageGenConfig,
  ComfyPromptTarget,
  ImageGenModelConfig,
  OpenAiImageGenConfig,
  SdWebUiImageGenConfig,
} from '../../shared/types'
import { analyzeComfyWorkflow, type ApiWorkflow } from './comfyWorkflow'

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
    size: options?.size,
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
        return { success: false, error: `不支持的 provider: ${(config as { provider: string }).provider}` }
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

function comfyHeaders(config: ComfyImageGenConfig, json = false): Record<string, string> {
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

/** 判断输入值是否为 `["节点ID", 槽位]` 形式的引用。 */
function isNodeReference(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string'
}

/** 从输出节点反向遍历，得到参与最终产出的节点集合。 */
function reachableNodeIds(workflow: ComfyWorkflow, outputIds: string[]): Set<string> {
  const reachable = new Set<string>()
  const stack = [...outputIds]
  while (stack.length > 0) {
    const nodeId = stack.pop()
    if (!nodeId || reachable.has(nodeId)) continue
    const node = workflow[nodeId]
    if (!node) continue
    reachable.add(nodeId)
    for (const value of Object.values(node.inputs)) {
      if (isNodeReference(value) && !reachable.has(value[0])) stack.push(value[0])
    }
  }
  return reachable
}

const SAMPLER_CLASS_TYPES = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced'])
const IMAGE_OUTPUT_CLASS_TYPES = new Set(['SaveImage', 'PreviewImage'])

/**
 * 找出可达输出的第一个采样阶段。
 *
 * 多阶段工作流（基础生成 → 精修 → 放大）中，只有基础阶段接收随机种子，
 * 后续阶段继承前一阶段结果。判据是「latent 输入不引用另一个采样器」，
 * 即链条的入口阶段。找不到时返回 null，调用方退回随机化全部阶段。
 */
function firstReachableSamplerId(workflow: ComfyWorkflow): string | null {
  const outputIds = Object.keys(workflow).filter((id) => IMAGE_OUTPUT_CLASS_TYPES.has(workflow[id].class_type))
  if (outputIds.length === 0) return null
  const reachable = reachableNodeIds(workflow, outputIds)
  for (const nodeId of Object.keys(workflow)) {
    if (!reachable.has(nodeId) || !SAMPLER_CLASS_TYPES.has(workflow[nodeId].class_type)) continue
    const inputs = workflow[nodeId].inputs
    const upstreamIsSampler = ['latent_image', 'samples', 'latent'].some((inputName) => {
      const value = inputs[inputName]
      return isNodeReference(value) && SAMPLER_CLASS_TYPES.has(workflow[value[0]]?.class_type ?? '')
    })
    if (!upstreamIsSampler) return nodeId
  }
  return null
}

/**
 * 应用用户保存的节点级覆盖。
 *
 * 键格式为 `节点ID.输入名`（如 `57:3.steps`），节点 ID 可能含 `:`，
 * 故按最后一个 `.` 切分。只写目标节点的目标输入，不影响其他节点。
 */
function applyWorkflowOverrides(workflow: ComfyWorkflow, overrides: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(overrides)) {
    const separator = key.lastIndexOf('.')
    if (separator <= 0) continue
    const nodeId = key.slice(0, separator)
    const inputName = key.slice(separator + 1)
    const node = workflow[nodeId]
    if (!node) continue
    node.inputs[inputName] = value
  }
}

function customComfyWorkflow(
  config: ComfyImageGenConfig,
  prompt: string,
  negativePrompt: string | undefined,
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

  // 深拷贝快照，避免修改调用方持有的配置对象。
  const copied = JSON.parse(JSON.stringify(rawWorkflow)) as ComfyWorkflow
  for (const [nodeId, node] of Object.entries(copied)) {
    if (!node || typeof node !== 'object' || !node.inputs || typeof node.class_type !== 'string') {
      throw new Error(`ComfyUI 工作流节点 ${nodeId} 格式无效，请导出 API 格式工作流`)
    }
  }

  // 占位符机制保留，用于兼容用户在自定义节点里手写的 `{{prompt}}` 等标记；
  // 它不是主要通道，普通节点由下方的绑定与覆盖处理。
  const seed = Math.floor(Math.random() * 0x7fffffff)
  const workflow = replaceWorkflowPlaceholders(copied, {
    '{{prompt}}': prompt,
    '{{negative_prompt}}': negativePrompt ?? '',
    '{{width}}': width,
    '{{height}}': height,
    '{{seed}}': seed,
  }) as ComfyWorkflow

  // 用户绑定是唯一事实来源；旧配置没有绑定时复用导入分析器，
  // 避免“配置页识别正确，运行时又用另一套规则猜错”。
  const configuredTargets = (
    role: 'positive' | 'negative',
  ): ComfyPromptTarget[] | null => {
    const bindings = config.bindings
    if (!bindings) return null
    const exact = role === 'positive' ? bindings.positivePromptTargets : bindings.negativePromptTargets
    if (exact !== undefined) return exact
    const legacy = role === 'positive' ? bindings.positivePromptNodeIds : bindings.negativePromptNodeIds
    return legacy === undefined ? null : legacy.map((nodeId) => ({ nodeId, inputName: 'text' }))
  }

  const analysis = analyzeComfyWorkflow(workflow as ApiWorkflow)
  const inferredTargets = (role: 'positive' | 'negative'): ComfyPromptTarget[] => (
    analysis.promptBindings
      .filter((binding) => binding.role === role && binding.inputName)
      .map((binding) => ({ nodeId: binding.nodeId, inputName: binding.inputName! }))
  )
  const positiveTargets = configuredTargets('positive') ?? inferredTargets('positive')
  const negativeTargets = configuredTargets('negative') ?? inferredTargets('negative')

  const writeTargets = (targets: ComfyPromptTarget[], value: string, label: string): void => {
    for (const target of targets) {
      const node = workflow[target.nodeId]
      if (!node || !Object.prototype.hasOwnProperty.call(node.inputs, target.inputName)) {
        throw new Error(`ComfyUI ${label}入口 ${target.nodeId}.${target.inputName} 已失效，请重新选择工作流入口`)
      }
      node.inputs[target.inputName] = value
    }
  }

  if (positiveTargets.length === 0) {
    throw new Error('ComfyUI 未选择正面提示词入口，请在生图配置中确认')
  }
  writeTargets(positiveTargets, prompt, '正面提示词')
  if (negativePrompt !== undefined) writeTargets(negativeTargets, negativePrompt, '负面提示词')

  // 只随机化可达输出的第一个采样阶段，后续阶段继承其种子。
  // 未显式指定种子覆盖时，随机化结果生效。
  const seedStageId = firstReachableSamplerId(workflow)
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!SAMPLER_CLASS_TYPES.has(node.class_type)) continue
    if (seedStageId !== null && nodeId !== seedStageId) continue
    if ('seed' in node.inputs) node.inputs.seed = seed
    if ('noise_seed' in node.inputs) node.inputs.noise_seed = seed
  }

  // 用户显式保存的覆盖最后应用，优先级高于随机化。
  if (config.overrides) applyWorkflowOverrides(workflow, config.overrides)

  return workflow
}

function buildComfyWorkflow(
  config: ComfyImageGenConfig,
  prompt: string,
  options?: ImageGenOptions,
): ComfyWorkflow {
  // 工作流是 ComfyUI 配置的唯一事实来源，不再提供内置工作流回退。
  if (!config.workflow?.trim()) {
    throw new Error('ComfyUI 未配置工作流，请在 设置 -> API -> 生图 中选择或粘贴 API 格式工作流')
  }
  const hasRequestNegative = Boolean(options)
    && Object.prototype.hasOwnProperty.call(options, 'negativePrompt')
    && options?.negativePrompt !== undefined
  const negativePrompt = hasRequestNegative
    ? options?.negativePrompt
    : config.negativePromptMode === 'preset'
      ? (config.negativePromptPreset ?? '')
      : config.negativePromptMode === 'empty'
        ? ''
        : undefined
  // 尺寸只作为占位符初值；实际尺寸由 overrides 控制。
  const [width, height] = parseSize(options?.size || '512x512')
  return customComfyWorkflow(config, prompt, negativePrompt, width, height)
}

async function comfyuiGenerate(
  config: ComfyImageGenConfig,
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
      // 用户在存在歧义时选定的输出节点优先：只收集其图片，其余输出忽略。
      const selected = config.bindings?.outputNodeIds ?? []
      const source = selected.length > 0
        ? Object.entries(entry.outputs).filter(([nodeId]) => selected.includes(nodeId))
        : Object.entries(entry.outputs)
      outputImages = source.flatMap(([, output]) => output.images ?? [])
      if (outputImages.length > 0) break
      if (selected.length > 0 && entry?.status?.completed) {
        throw new Error(`ComfyUI 选定的输出节点（${selected.join(', ')}）未产生图片，请在工作流配置中重新选择`)
      }
    }
    if (entry?.status?.completed) {
      throw new Error('ComfyUI 工作流已完成，但没有图片输出（SaveImage / PreviewImage / SaveImageAdvanced）')
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
 * 1. 移除引号（直角双引号 + 左右弯引号）
 * 2. 换行替换为逗号
 * 3. NFC 规范化（保持字符完整）
 * 4. 移除非 SD 语法字符（保留 a-zA-Z0-9 及 .,:_(){}<>[]/'|#- 和中文）
 * 5. 按逗号分割、trim、过滤空值、重新 join
 */
function sanitizeSdPrompt(str: string): string {
  if (!str) return str
  let s = str
    .replaceAll('"', '')
    .replaceAll('\u201c', '')
    .replaceAll('\u201d', '')
    .replaceAll('\n', ', ')
  // 用 NFC 而非 NFD：NFD 会把 é 拆成 e + 组合附加符，随后被白名单正则剥掉，
  // 造成拉丁语系提示词失真（CJK 不受影响）。
  s = s.normalize('NFC')
  // 保留：字母数字、SD 语法符号、中文 CJK、日文假名、韩文，以及拉丁扩展字符
  // （\u00c0-\u024f，使 café / naïve 等带重音词在 NFC 下完整保留）。
  s = s.replace(/[^a-zA-Z0-9.,:_(){}<>[\]/\-'|#\u00c0-\u024f\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\s]+/g, ' ')
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
    .replaceAll('\u201c', '')
    .replaceAll('\u201d', '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ===================== SD WebUI (Automatic1111) 适配器 =====================

async function sdWebuiGenerate(
  config: SdWebUiImageGenConfig,
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

/** DALL-E 3 仅接受这三种尺寸；DALL-E 2 接受另外一组。 */
const DALLE3_SIZES = ['1024x1024', '1792x1024', '1024x1792']
const DALLE2_SIZES = ['256x256', '512x512', '1024x1024']

/**
 * 把任意尺寸字符串归一化为该模型可接受的合法尺寸。
 *
 * 调用方（/imagine 的模式尺寸、角色封面的 3:4 预设）使用竖版等非标准尺寸，
 * 直接透传会被 DALL-E 拒绝（400）。这里按宽高取向映射到最接近的合法值，
 * 保留竖/横意图而非一律退化为正方形。
 */
function normalizeOpenAiSize(raw: string, model: string): string {
  const allowed = /dall-e-2/i.test(model) ? DALLE2_SIZES : DALLE3_SIZES
  const size = raw.trim()
  if (allowed.includes(size)) return size

  const [width, height] = parseSize(size)
  if (/dall-e-2/i.test(model)) {
    // DALL-E 2 只有正方形规格，非正方形一律取其中间档位。
    return width === height && DALLE2_SIZES.includes(`${width}x${height}`) ? `${width}x${height}` : '512x512'
  }
  if (height > width) return '1024x1792'
  if (width > height) return '1792x1024'
  return '1024x1024'
}

async function openaiGenerate(
  config: OpenAiImageGenConfig,
  prompt: string,
  options?: ImageGenOptions,
): Promise<ImageGenResult> {
  const baseUrl = config.baseUrl.replace(/\/$/, '')
  const url = `${baseUrl}/images/generations`

  const model = config.model || 'dall-e-3'
  const requestedSize = options?.size || config.size || '1024x1024'
  const size = normalizeOpenAiSize(requestedSize, model)
  if (size !== requestedSize) {
    log.warn('OpenAI 尺寸不在合法集合内，已归一化', { model, requested: requestedSize, applied: size })
  }

  const body = {
    model,
    prompt,
    n: 1,
    size,
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
 * 拉取 ComfyUI 的 /object_info（节点定义）。
 *
 * 用于取参数类型、范围与选项，并校验节点类型与模型文件是否可用。
 * 失败不是错误路径：调用侧按 JS 类型降级渲染，不阻塞配置编辑。
 */
export async function fetchComfyObjectInfo(
  baseUrl: string,
  apiKey?: string,
): Promise<{ success: boolean; objectInfo?: Record<string, unknown>; error?: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/object_info`
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey?.trim()) {
      headers.Authorization = `Bearer ${apiKey.trim()}`
      headers['X-API-Key'] = apiKey.trim()
    }
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` }
    }
    const data = await response.json()
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { success: false, error: '/object_info 返回格式异常' }
    }
    return { success: true, objectInfo: data as Record<string, unknown> }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
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

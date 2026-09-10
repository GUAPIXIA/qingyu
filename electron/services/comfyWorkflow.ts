import { app, dialog } from 'electron'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import type {
  ComfyWorkflowAnalysis,
  ComfyWorkflowBinding,
  ComfyWorkflowDependency,
  ComfyWorkflowKind,
  ComfyWorkflowMeta,
  ComfyWorkflowParameter,
  ComfyWorkflowParameterGroup,
  ComfyWorkflowWarning,
} from '../../shared/ipc-api'

export const COMFY_ANALYZER_VERSION = 1

export interface LocalComfyWorkflow {
  path: string
  name: string
  installation: string
  modifiedAt: number
}

export interface ComfyWorkflowSettings {
  size?: string
  steps?: number
  cfgScale?: number
  sampler?: string
  scheduler?: string
  model?: string
  negativePrompt?: string
}

export interface ImportedComfyWorkflow {
  success: boolean
  canceled?: boolean
  error?: string
  sourceName?: string
  workflow?: string
  nodeCount?: number
  converted?: boolean
  settings?: ComfyWorkflowSettings
  analysis?: ComfyWorkflowAnalysis
  workflowMeta?: ComfyWorkflowMeta
  objectInfo?: Record<string, unknown>
}

type JsonObject = Record<string, unknown>

interface GraphInput {
  name?: string
  link?: number | string | null
  widget?: { name?: string }
}

interface GraphNode {
  id: number | string
  type: string
  title?: string
  mode?: number
  inputs?: GraphInput[]
  outputs?: Array<{ name?: string }>
  widgets_values?: unknown[]
  widgets_values_named?: Record<string, unknown>
}

interface GraphLink {
  id: number | string
  originId: number | string
  originSlot: number
  targetId: number | string
  targetSlot: number
}

interface GraphData {
  nodes: GraphNode[]
  links?: unknown[]
  inputs?: Array<{ name?: string }>
  outputs?: Array<{ name?: string }>
}

interface ApiNode {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}

export type ApiWorkflow = Record<string, ApiNode>
export type { ApiNode }
type NodeValue = unknown | [string, number]

const FRONTEND_ONLY_NODES = new Set(['MarkdownNote', 'Note', 'PrimitiveNode', 'Reroute'])

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeLink(raw: unknown): GraphLink | null {
  if (Array.isArray(raw) && raw.length >= 5) {
    return {
      id: raw[0] as number | string,
      originId: raw[1] as number | string,
      originSlot: Number(raw[2]),
      targetId: raw[3] as number | string,
      targetSlot: Number(raw[4]),
    }
  }
  if (!isObject(raw)) return null
  const id = raw.id
  const originId = raw.origin_id
  const targetId = raw.target_id
  if ((typeof id !== 'number' && typeof id !== 'string')
    || (typeof originId !== 'number' && typeof originId !== 'string')
    || (typeof targetId !== 'number' && typeof targetId !== 'string')) return null
  return {
    id,
    originId,
    originSlot: Number(raw.origin_slot),
    targetId,
    targetSlot: Number(raw.target_slot),
  }
}

function widgetValue(node: GraphNode, input: GraphInput, inputIndex: number): unknown {
  const name = input.widget?.name || input.name
  if (name && node.widgets_values_named
    && Object.prototype.hasOwnProperty.call(node.widgets_values_named, name)) {
    return node.widgets_values_named[name]
  }

  // 旧版工作流没有 widgets_values_named。大多数节点的 widget 顺序与输入顺序一致。
  const widgetInputs = (node.inputs ?? []).filter((item) => item.widget)
  let widgetIndex = widgetInputs.indexOf(input)
  // KSampler 的旧画布格式会在 seed 后额外保存 control_after_generate，
  // 但它不出现在 inputs 中，后续 widget 因此需要错开一位。
  const seedIndex = widgetInputs.findIndex((item) => {
    const itemName = item.widget?.name || item.name
    return itemName === 'seed' || itemName === 'noise_seed'
  })
  if ((node.widgets_values?.length ?? 0) === widgetInputs.length + 1
    && seedIndex >= 0 && widgetIndex > seedIndex) widgetIndex += 1
  if (widgetIndex >= 0 && widgetIndex < (node.widgets_values?.length ?? 0)) {
    return node.widgets_values?.[widgetIndex]
  }
  return node.widgets_values?.[inputIndex]
}

/** 将 ComfyUI 前端画布工作流转换为 /prompt 接受的 API 节点对象。 */
export function convertComfyCanvasWorkflow(raw: unknown): ApiWorkflow {
  if (!isObject(raw) || !Array.isArray(raw.nodes)) {
    throw new Error('不是 ComfyUI 画布工作流')
  }

  const definitions = new Map<string, GraphData>()
  const rawDefinitions = isObject(raw.definitions) && Array.isArray(raw.definitions.subgraphs)
    ? raw.definitions.subgraphs
    : []
  for (const item of rawDefinitions) {
    if (isObject(item) && (typeof item.id === 'string' || typeof item.id === 'number') && Array.isArray(item.nodes)) {
      definitions.set(String(item.id), item as unknown as GraphData)
    }
  }

  const result: ApiWorkflow = {}
  const flattened = new Map<string, NodeValue[]>()

  const convertGraph = (
    graph: GraphData,
    prefix: string,
    externalInputs: NodeValue[] = [],
  ): NodeValue[] => {
    const nodes = new Map((graph.nodes ?? []).map((node) => [String(node.id), node]))
    const links = new Map<number | string, GraphLink>()
    for (const rawLink of graph.links ?? []) {
      const link = normalizeLink(rawLink)
      if (link) links.set(link.id, link)
    }

    const resolveOrigin = (originId: number | string, originSlot: number): NodeValue => {
      if (String(originId) === '-10') return externalInputs[originSlot]
      const origin = nodes.get(String(originId))
      if (!origin) throw new Error(`工作流连接引用了不存在的节点 ${originId}`)

      const definition = definitions.get(origin.type)
      if (definition) {
        const cacheKey = `${prefix}${origin.id}`
        let outputs = flattened.get(cacheKey)
        if (!outputs) {
          const values = (origin.inputs ?? []).map((input, index): NodeValue => {
            if (input.link !== null && input.link !== undefined) {
              const link = links.get(input.link)
              if (!link) throw new Error(`子工作流输入 ${input.name ?? index} 的连接无效`)
              return resolveOrigin(link.originId, link.originSlot)
            }
            return widgetValue(origin, input, index)
          })
          outputs = convertGraph(definition, `${prefix}${origin.id}:`, values)
          flattened.set(cacheKey, outputs)
        }
        return outputs[originSlot]
      }

      if (origin.type === 'Reroute') {
        const inputLink = origin.inputs?.[0]?.link
        const link = inputLink === null || inputLink === undefined ? null : links.get(inputLink)
        if (!link) throw new Error(`重路由节点 ${origin.id} 没有有效输入`)
        return resolveOrigin(link.originId, link.originSlot)
      }
      if (origin.type === 'PrimitiveNode') return origin.widgets_values?.[0]
      return [`${prefix}${origin.id}`, originSlot]
    }

    // 先展开子工作流，确保被普通节点引用时输出映射已经存在。
    for (const node of nodes.values()) {
      if (definitions.has(node.type)) resolveOrigin(node.id, 0)
    }

    for (const node of nodes.values()) {
      if (definitions.has(node.type) || FRONTEND_ONLY_NODES.has(node.type) || node.mode === 2) continue
      const inputs: Record<string, unknown> = {}
      for (const [index, input] of (node.inputs ?? []).entries()) {
        if (!input.name) continue
        if (input.link !== null && input.link !== undefined) {
          const link = links.get(input.link)
          if (!link) throw new Error(`节点 ${node.id} 的输入 ${input.name} 连接无效`)
          const value = resolveOrigin(link.originId, link.originSlot)
          if (value !== undefined) inputs[input.name] = value
        } else if (input.widget) {
          const value = widgetValue(node, input, index)
          if (value !== undefined) inputs[input.name] = value
        }
      }
      result[`${prefix}${node.id}`] = {
        class_type: node.type,
        inputs,
        ...(node.title ? { _meta: { title: node.title } } : {}),
      }
    }

    const outputs: NodeValue[] = []
    for (const link of links.values()) {
      if (String(link.targetId) === '-20') {
        outputs[link.targetSlot] = resolveOrigin(link.originId, link.originSlot)
      }
    }
    return outputs
  }

  convertGraph(raw as unknown as GraphData, '')
  if (Object.keys(result).length === 0) throw new Error('工作流中没有可执行节点')
  return result
}

function normalizeApiWorkflow(raw: unknown): { workflow: ApiWorkflow; converted: boolean } {
  if (!isObject(raw)) throw new Error('工作流 JSON 顶层必须是对象')
  if (Array.isArray(raw.nodes)) return { workflow: convertComfyCanvasWorkflow(raw), converted: true }

  const candidate = isObject(raw.prompt) ? raw.prompt : raw
  const workflow: ApiWorkflow = {}
  for (const [id, value] of Object.entries(candidate)) {
    if (!isObject(value) || typeof value.class_type !== 'string' || !isObject(value.inputs)) {
      throw new Error(`节点 ${id} 不是有效的 ComfyUI API 节点`)
    }
    workflow[id] = value as unknown as ApiNode
  }
  if (Object.keys(workflow).length === 0) throw new Error('工作流中没有可执行节点')
  return { workflow, converted: false }
}

/** 把任意 ComfyUI 工作流 JSON（画布或 API 格式）规范化为 API 节点对象。 */
export function normalizeComfyWorkflow(raw: unknown): { workflow: ApiWorkflow; converted: boolean } {
  return normalizeApiWorkflow(raw)
}

function inferSettings(workflow: ApiWorkflow): ComfyWorkflowSettings {
  const settings: ComfyWorkflowSettings = {}
  const negativeTextNodeIds = new Set<string>()
  for (const node of Object.values(workflow)) {
    if (node.class_type !== 'KSampler' && node.class_type !== 'KSamplerAdvanced') continue
    const negative = node.inputs.negative
    if (Array.isArray(negative) && typeof negative[0] === 'string') negativeTextNodeIds.add(negative[0])
  }
  for (const node of Object.values(workflow)) {
    if ((node.class_type === 'EmptyLatentImage' || node.class_type === 'EmptySD3LatentImage')
      && typeof node.inputs.width === 'number' && typeof node.inputs.height === 'number') {
      settings.size ??= `${node.inputs.width}x${node.inputs.height}`
    }
    if (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') {
      if (typeof node.inputs.steps === 'number') settings.steps ??= node.inputs.steps
      if (typeof node.inputs.cfg === 'number') settings.cfgScale ??= node.inputs.cfg
      if (typeof node.inputs.sampler_name === 'string') settings.sampler ??= node.inputs.sampler_name
      if (typeof node.inputs.scheduler === 'string') settings.scheduler ??= node.inputs.scheduler
    }
    if (node.class_type === 'CheckpointLoaderSimple' && typeof node.inputs.ckpt_name === 'string') {
      settings.model ??= node.inputs.ckpt_name
    }
  }
  for (const id of negativeTextNodeIds) {
    const node = workflow[id]
    if (node?.class_type === 'CLIPTextEncode' && typeof node.inputs.text === 'string') {
      settings.negativePrompt ??= node.inputs.text
    }
  }
  return settings
}

function hasImageOutput(workflow: ApiWorkflow): boolean {
  return Object.values(workflow).some((node) => node.class_type === 'SaveImage' || node.class_type === 'PreviewImage')
}

interface LoaderSpec {
  inputName: string
  label: string
  provides: string[]
  /** 同节点内与模型名同属可调项、但需要与模型名一起暴露的输入。 */
  tuning?: Array<{ inputName: string; label: string; type: ComfyWorkflowParameter['type'] }>
}

/** Loader 节点对照表，见方案 3.5。weight_dtype / type / device 等不属于模型名，故不在此表。 */
const LOADER_SPECS: Record<string, LoaderSpec> = {
  CheckpointLoaderSimple: {
    inputName: 'ckpt_name',
    label: 'Checkpoint',
    provides: ['MODEL', 'CLIP', 'VAE'],
  },
  UNETLoader: {
    inputName: 'unet_name',
    label: 'UNet',
    provides: ['MODEL'],
    tuning: [{ inputName: 'weight_dtype', label: '精度', type: 'select' }],
  },
  CLIPLoader: {
    inputName: 'clip_name',
    label: 'CLIP',
    provides: ['CLIP'],
    tuning: [
      { inputName: 'type', label: 'CLIP 类型', type: 'select' },
      { inputName: 'device', label: '设备', type: 'select' },
    ],
  },
  VAELoader: {
    inputName: 'vae_name',
    label: 'VAE',
    provides: ['VAE'],
  },
  LoraLoader: {
    inputName: 'lora_name',
    label: 'LoRA',
    provides: ['MODEL', 'CLIP'],
    tuning: [
      { inputName: 'strength_model', label: 'LoRA 强度（模型）', type: 'number' },
      { inputName: 'strength_clip', label: 'LoRA 强度（CLIP）', type: 'number' },
    ],
  },
  LoraLoaderModelOnly: {
    inputName: 'lora_name',
    label: 'LoRA',
    provides: ['MODEL'],
    tuning: [{ inputName: 'strength_model', label: 'LoRA 强度', type: 'number' }],
  },
}

const IMAGE_OUTPUT_NODES = new Set(['SaveImage', 'PreviewImage'])
const VIDEO_OUTPUT_NODES = new Set([
  'SaveWEBM',
  'SaveVideo',
  'VHS_VideoCombine',
  'SaveAnimatedWEBP',
  'SaveAnimatedPNG',
])
const IMAGE_INPUT_NODES = new Set(['LoadImage', 'LoadImageMask', 'LoadImageOutput'])
const LATENT_SIZE_NODES = new Set(['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyLatentImagePresets'])
const SAMPLER_NODES = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced'])
const TEXT_ENCODE_NODES = new Set(['CLIPTextEncode', 'CLIPTextEncodeSDXL', 'BNK_CLIPTextEncodeAdvanced'])
const NEGATIVE_NODE_HINTS = ['negative', 'neg', '负面', '反向']

/** 采样阶段的参数白名单：只暴露可安全覆盖的项，避免把 latent_image 等连接写坏。 */
const SAMPLER_PARAM_SPECS: Array<{
  inputName: string
  label: string
  type: ComfyWorkflowParameter['type']
  advanced?: boolean
}> = [
  { inputName: 'steps', label: 'Steps', type: 'number' },
  { inputName: 'cfg', label: 'CFG', type: 'number' },
  { inputName: 'sampler_name', label: 'Sampler', type: 'select' },
  { inputName: 'scheduler', label: 'Scheduler', type: 'select' },
  { inputName: 'denoise', label: 'Denoise', type: 'number', advanced: true },
  { inputName: 'seed', label: '种子', type: 'number', advanced: true },
  { inputName: 'noise_seed', label: '种子', type: 'number', advanced: true },
]

function isReference(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string'
}

function referenceNodeId(value: unknown): string | null {
  return isReference(value) ? value[0] : null
}

function nodeLabel(nodeId: string, node: ApiNode): string {
  return node._meta?.title?.trim() || `${node.class_type} #${nodeId}`
}

/** 从输出节点反向遍历输入引用，得到真正参与最终产出的节点集合。 */
function collectReachable(workflow: ApiWorkflow, outputIds: string[]): Set<string> {
  const reachable = new Set<string>()
  const stack = [...outputIds]
  while (stack.length > 0) {
    const nodeId = stack.pop()
    if (!nodeId || reachable.has(nodeId)) continue
    const node = workflow[nodeId]
    if (!node) continue
    reachable.add(nodeId)
    for (const value of Object.values(node.inputs)) {
      const referenced = referenceNodeId(value)
      if (referenced && !reachable.has(referenced)) stack.push(referenced)
    }
  }
  return reachable
}

/**
 * 节点标题是否明确标示负面提示词。
 *
 * 仅在采样器没有 negative 输入时作为兜底依据，不覆盖引用关系得出的结论。
 */
function hasNegativeTitleHint(node: ApiNode): boolean {
  const title = (node._meta?.title ?? '').toLowerCase()
  return NEGATIVE_NODE_HINTS.some((hint) => title.includes(hint))
}

/**
 * 沿 conditioning 引用链回溯，收集起点能到达的文本节点。
 *
 * 采样器的 positive / negative 指向的可能不是文本节点本身，
 * 而是 ConditioningCombine、ConditioningSetArea 等中间节点，需逐级向下展开。
 */
function collectPromptNodes(
  workflow: ApiWorkflow,
  startIds: string[],
  textNodeSet: Set<string>,
): Set<string> {
  const found = new Set<string>()
  const visited = new Set<string>()
  const stack = [...startIds]
  while (stack.length > 0) {
    const nodeId = stack.pop()
    if (!nodeId || visited.has(nodeId)) continue
    visited.add(nodeId)
    if (textNodeSet.has(nodeId)) {
      found.add(nodeId)
      continue
    }
    const node = workflow[nodeId]
    if (!node) continue
    for (const value of Object.values(node.inputs)) {
      const referenced = referenceNodeId(value)
      if (referenced && !visited.has(referenced)) stack.push(referenced)
    }
  }
  return found
}

/** `/object_info` 中该节点该输入的定义；用于取类型、范围与选项。 */
interface ObjectInfoInput {
  type?: unknown
  options?: unknown[]
  min?: number
  max?: number
  step?: number
}

function objectInfoFor(
  objectInfo: Record<string, unknown> | undefined,
  classType: string,
): Record<string, unknown> | null {
  if (!objectInfo) return null
  const entry = objectInfo[classType]
  if (!isObject(entry)) return null
  return entry
}

function objectInfoInput(
  objectInfo: Record<string, unknown> | undefined,
  classType: string,
  inputName: string,
): ObjectInfoInput | null {
  const entry = objectInfoFor(objectInfo, classType)
  if (!entry) return null
  const input = entry.input
  if (!isObject(input)) return null
  const definition = input[inputName]
  if (!Array.isArray(definition) || definition.length === 0) return null
  const type = definition[0]
  const config = definition[1]
  const result: ObjectInfoInput = { type }
  if (Array.isArray(type)) result.options = type
  if (isObject(config)) {
    if (typeof config.min === 'number') result.min = config.min
    if (typeof config.max === 'number') result.max = config.max
    if (typeof config.step === 'number') result.step = config.step
    if (Array.isArray(config.options)) result.options = config.options
  }
  return result
}

/** 节点类型是否存在于 /object_info；无 objectInfo 时返回 null 表示无法校验。 */
function nodeTypeKnown(
  objectInfo: Record<string, unknown> | undefined,
  classType: string,
): boolean | null {
  if (!objectInfo) return null
  return Object.prototype.hasOwnProperty.call(objectInfo, classType)
}

function jsTypeOf(value: unknown): ComfyWorkflowParameter['type'] {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return 'text'
  return 'text'
}

function buildParameter(
  nodeId: string,
  classType: string,
  inputName: string,
  label: string,
  value: unknown,
  objectInfo: Record<string, unknown> | undefined,
  advanced = false,
  fallbackType?: ComfyWorkflowParameter['type'],
): ComfyWorkflowParameter {
  const info = objectInfoInput(objectInfo, classType, inputName)
  let type: ComfyWorkflowParameter['type'] = fallbackType ?? jsTypeOf(value)
  if (info) {
    if (info.options && info.options.length > 0) type = 'select'
    else if (info.type === 'INT' || info.type === 'FLOAT') type = 'number'
    else if (info.type === 'BOOLEAN') type = 'boolean'
    else if (info.type === 'STRING' && fallbackType === 'select') type = 'select'
  } else if (fallbackType) {
    type = fallbackType
  }
  return {
    id: `${nodeId}.${inputName}`,
    nodeId,
    inputName,
    label,
    type,
    workflowValue: value,
    ...(info?.options ? { options: info.options } : {}),
    ...(info?.min !== undefined ? { min: info.min } : {}),
    ...(info?.max !== undefined ? { max: info.max } : {}),
    ...(info?.step !== undefined ? { step: info.step } : {}),
    required: true,
    ...(advanced ? { advanced: true } : {}),
  }
}

function analyzeSamplerGroup(
  nodeId: string,
  node: ApiNode,
  objectInfo: Record<string, unknown> | undefined,
  stage: 'sampling' | 'custom',
): ComfyWorkflowParameterGroup | null {
  const parameters: ComfyWorkflowParameter[] = []
  for (const spec of SAMPLER_PARAM_SPECS) {
    if (!Object.prototype.hasOwnProperty.call(node.inputs, spec.inputName)) continue
    const value = node.inputs[spec.inputName]
    if (isReference(value)) continue
    parameters.push(buildParameter(
      nodeId,
      node.class_type,
      spec.inputName,
      spec.label,
      value,
      objectInfo,
      spec.advanced,
      spec.type,
    ))
  }
  if (parameters.length === 0) return null
  return {
    id: nodeId,
    nodeId,
    classType: node.class_type,
    title: nodeLabel(nodeId, node),
    stage,
    parameters,
  }
}

/**
 * 分析已规范化的 API 工作流。
 *
 * 纯函数：不读写文件、不发起请求，`objectInfo` 由调用侧获取后传入。
 * 只处理能从输出节点反向到达的节点，断开的实验节点不进入结果。
 */
export function analyzeComfyWorkflow(
  workflow: ApiWorkflow,
  objectInfo?: Record<string, unknown>,
): ComfyWorkflowAnalysis {
  const allIds = Object.keys(workflow)
  const warnings: ComfyWorkflowWarning[] = []

  const imageOutputIds = allIds.filter((id) => IMAGE_OUTPUT_NODES.has(workflow[id].class_type))
  const videoOutputIds = allIds.filter((id) => VIDEO_OUTPUT_NODES.has(workflow[id].class_type))

  let kind: ComfyWorkflowKind = 'unknown'
  if (videoOutputIds.length > 0) kind = 'video'
  else if (imageOutputIds.length > 0) {
    const reachableFromImage = collectReachable(workflow, imageOutputIds)
    const needsImage = [...reachableFromImage].some((id) => IMAGE_INPUT_NODES.has(workflow[id].class_type))
    kind = needsImage ? 'image-to-image' : 'text-to-image'
  }

  if (imageOutputIds.length === 0 && videoOutputIds.length === 0) {
    warnings.push({ code: 'no-output', message: '工作流没有 SaveImage / PreviewImage 输出节点' })
  }

  const outputIds = imageOutputIds.length > 0 ? imageOutputIds : videoOutputIds
  const reachable = collectReachable(workflow, outputIds)

  const unreachable = allIds.filter((id) => !reachable.has(id))
  if (unreachable.length > 0) {
    warnings.push({
      code: 'unreachable-nodes',
      message: `有 ${unreachable.length} 个节点未连接到输出，已忽略`,
      nodeIds: unreachable,
    })
  }

  const reachableIds = allIds.filter((id) => reachable.has(id))
  const samplers = reachableIds.filter((id) => SAMPLER_NODES.has(workflow[id].class_type))

  const textNodes = reachableIds.filter((id) => TEXT_ENCODE_NODES.has(workflow[id].class_type))
  const textNodeSet = new Set(textNodes)

  // 采样器的 positive / negative 输入指向的是 conditioning，中间可能隔着
  // ConditioningCombine、ConditioningSetArea 等节点，因此需要沿条件链回溯到文本节点。
  const positiveStartIds: string[] = []
  for (const id of samplers) {
    const referenced = referenceNodeId(workflow[id].inputs.positive)
    if (referenced) positiveStartIds.push(referenced)
  }
  // negative 输入也可能出现在 Guider 等节点上，故对全部可达节点扫描。
  const negativeStartIds: string[] = []
  for (const id of reachableIds) {
    const node = workflow[id]
    for (const inputName of ['negative', 'negative_prompt']) {
      const referenced = referenceNodeId(node.inputs[inputName])
      if (referenced) negativeStartIds.push(referenced)
    }
  }

  const samplerNegativeIds = collectPromptNodes(workflow, negativeStartIds, textNodeSet)
  // 采样器未声明 negative 时，用节点标题兜底识别负面文本节点。
  if (samplerNegativeIds.size === 0) {
    for (const id of textNodes) {
      if (hasNegativeTitleHint(workflow[id])) samplerNegativeIds.add(id)
    }
  }
  const samplerPositiveIds = collectPromptNodes(workflow, positiveStartIds, textNodeSet)

  // 采样器引用可唯一确定时以它为准；无法确定时退回「可达且非负面」的文本节点集合。
  const resolvedPositiveIds = samplerPositiveIds.size > 0
    ? textNodes.filter((id) => samplerPositiveIds.has(id) && !samplerNegativeIds.has(id))
    : textNodes.filter((id) => !samplerNegativeIds.has(id))

  const promptBindings: ComfyWorkflowBinding[] = []
  for (const id of resolvedPositiveIds) {
    promptBindings.push({
      role: 'positive',
      nodeId: id,
      inputName: 'text',
      ...(workflow[id]._meta?.title ? { title: workflow[id]._meta?.title } : {}),
    })
  }
  for (const id of textNodes) {
    if (!samplerNegativeIds.has(id)) continue
    promptBindings.push({
      role: 'negative',
      nodeId: id,
      inputName: 'text',
      ...(workflow[id]._meta?.title ? { title: workflow[id]._meta?.title } : {}),
    })
  }

  if (resolvedPositiveIds.length === 0) {
    warnings.push({ code: 'no-prompt', message: '未找到正面提示词入口（CLIPTextEncode）' })
  } else if (resolvedPositiveIds.length > 1) {
    warnings.push({
      code: 'ambiguous-prompt',
      message: `有 ${resolvedPositiveIds.length} 个候选正面提示词节点，需要确认绑定的入口`,
      nodeIds: resolvedPositiveIds,
    })
  }

  const outputBindings: ComfyWorkflowBinding[] = outputIds.map((id) => ({
    role: 'output',
    nodeId: id,
    inputName: 'images',
    ...(workflow[id]._meta?.title ? { title: workflow[id]._meta?.title } : {}),
  }))
  if (outputIds.length > 1) {
    warnings.push({
      code: 'ambiguous-output',
      message: `有 ${outputIds.length} 个输出节点，需要确认使用的输出`,
      nodeIds: outputIds,
    })
  }

  // ---- 参数分组 ----
  const parameterGroups: ComfyWorkflowParameterGroup[] = []

  for (const id of reachableIds) {
    const node = workflow[id]
    if (!LATENT_SIZE_NODES.has(node.class_type)) continue
    const width = node.inputs.width
    const height = node.inputs.height
    if (typeof width !== 'number' || typeof height !== 'number') continue
    const widthInfo = objectInfoInput(objectInfo, node.class_type, 'width')
    const heightInfo = objectInfoInput(objectInfo, node.class_type, 'height')
    parameterGroups.push({
      id: id,
      nodeId: id,
      classType: node.class_type,
      title: nodeLabel(id, node),
      stage: 'output',
      parameters: [{
        id: `${id}.width`,
        nodeId: id,
        inputName: 'width',
        label: '尺寸',
        type: 'size',
        workflowValue: `${width}x${height}`,
        pairedInputName: 'height',
        pairedWorkflowValue: height,
        ...(widthInfo?.min !== undefined ? { min: widthInfo.min } : {}),
        ...(widthInfo?.max !== undefined ? { max: widthInfo.max } : {}),
        ...(widthInfo?.step !== undefined ? { step: widthInfo.step } : {}),
        ...(heightInfo?.max !== undefined ? { max: heightInfo.max } : {}),
        required: true,
      }],
    })
  }

  for (const id of samplers) {
    const group = analyzeSamplerGroup(id, workflow[id], objectInfo, 'sampling')
    if (group) parameterGroups.push(group)
  }

  // ---- 模型依赖与模型侧可调项 ----
  const dependencies: ComfyWorkflowDependency[] = []
  const usageIndex = new Map<string, Array<{ nodeId: string; inputName: string }>>()
  for (const id of reachableIds) {
    const node = workflow[id]
    for (const [inputName, value] of Object.entries(node.inputs)) {
      const referenced = referenceNodeId(value)
      if (!referenced) continue
      const list = usageIndex.get(referenced) ?? []
      list.push({ nodeId: id, inputName })
      usageIndex.set(referenced, list)
    }
  }

  for (const id of reachableIds) {
    const node = workflow[id]
    const spec = LOADER_SPECS[node.class_type]
    if (!spec) continue
    const value = node.inputs[spec.inputName]
    if (typeof value !== 'string') continue
    const info = objectInfoInput(objectInfo, node.class_type, spec.inputName)
    const options = info?.options?.filter((item): item is string => typeof item === 'string')
    dependencies.push({
      nodeId: id,
      inputName: spec.inputName,
      classType: node.class_type,
      label: spec.label,
      value,
      provides: spec.provides,
      usedBy: usageIndex.get(id) ?? [],
      ...(options && options.length > 0 ? { options, available: options.includes(value) } : {}),
    })
    if (options && options.length > 0 && !options.includes(value)) {
      warnings.push({
        code: 'missing-model',
        message: `${spec.label} 模型 ${value} 不在该 Loader 的可用列表中`,
        nodeIds: [id],
      })
    }

    if (spec.tuning && spec.tuning.length > 0) {
      const parameters: ComfyWorkflowParameter[] = []
      for (const tuning of spec.tuning) {
        if (!Object.prototype.hasOwnProperty.call(node.inputs, tuning.inputName)) continue
        const tuningValue = node.inputs[tuning.inputName]
        if (isReference(tuningValue)) continue
        parameters.push(buildParameter(
          id,
          node.class_type,
          tuning.inputName,
          tuning.label,
          tuningValue,
          objectInfo,
          false,
          tuning.type,
        ))
      }
      if (parameters.length > 0) {
        parameterGroups.push({
          id,
          nodeId: id,
          classType: node.class_type,
          title: nodeLabel(id, node),
          stage: 'model',
          parameters,
        })
      }
    }
  }

  if (kind === 'video') {
    warnings.push({ code: 'video-workflow', message: '这是视频工作流，不能作为图片模型保存' })
  }
  if (kind === 'image-to-image') {
    warnings.push({ code: 'requires-image-input', message: '这是图生图工作流，需要提供输入图片' })
  }
  if (samplers.length > 1) {
    warnings.push({
      code: 'multi-stage',
      message: `检测到 ${samplers.length} 个采样阶段，参数将按节点分组`,
      nodeIds: samplers,
    })
  }

  // ---- 节点类型校验（依赖 /object_info）----
  if (objectInfo) {
    const unknownNodes = reachableIds.filter((id) => nodeTypeKnown(objectInfo, workflow[id].class_type) === false)
    if (unknownNodes.length > 0) {
      warnings.push({
        code: 'unknown-node',
        message: `有 ${unknownNodes.length} 个节点类型在当前 ComfyUI 中不存在`,
        nodeIds: unknownNodes,
      })
    }
  }

  const compatible = kind === 'text-to-image'
    && imageOutputIds.length > 0
    && resolvedPositiveIds.length > 0
    && !warnings.some((item) => item.code === 'unknown-node' || item.code === 'missing-model')

  return {
    kind,
    nodeCount: allIds.length,
    compatible,
    promptBindings,
    outputBindings,
    parameterGroups,
    dependencies,
    warnings,
  }
}

export function hashComfyWorkflow(workflow: ApiWorkflow): string {
  return createHash('sha256').update(JSON.stringify(workflow)).digest('hex').slice(0, 16)
}

function workflowDirectoriesFromInstall(installPath: string): string[] {
  return [
    join(installPath, 'ComfyUI', 'user'),
    join(installPath, 'user'),
  ]
}

async function findDesktopInstallations(): Promise<Array<{ name: string; installPath: string }>> {
  const appData = process.env.APPDATA || app.getPath('appData')
  const manifestPath = join(appData, 'Comfy Desktop', 'installations.json')
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!isObject(item) || item.status !== 'installed' || typeof item.installPath !== 'string') return []
      return [{ name: typeof item.name === 'string' ? item.name : 'ComfyUI Desktop', installPath: item.installPath }]
    })
  } catch {
    return []
  }
}

export async function listLocalComfyWorkflows(): Promise<LocalComfyWorkflow[]> {
  const installations = await findDesktopInstallations()
  const workflows: LocalComfyWorkflow[] = []
  for (const installation of installations) {
    for (const userRoot of workflowDirectoriesFromInstall(installation.installPath)) {
      let profiles
      try {
        profiles = await readdir(userRoot, { withFileTypes: true })
      } catch {
        continue
      }
      for (const profile of profiles) {
        if (!profile.isDirectory()) continue
        const workflowDir = join(userRoot, profile.name, 'workflows')
        let files
        try {
          files = await readdir(workflowDir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const file of files) {
          if (!file.isFile() || extname(file.name).toLowerCase() !== '.json') continue
          const path = join(workflowDir, file.name)
          let info
          try {
            const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
            if (!hasImageOutput(normalizeApiWorkflow(parsed).workflow)) continue
            info = await stat(path)
          } catch {
            continue
          }
          workflows.push({
            path,
            name: file.name.replace(/\.json$/i, ''),
            installation: profile.name === 'default'
              ? installation.name
              : `${installation.name} · ${profile.name}`,
            modifiedAt: info.mtimeMs,
          })
        }
      }
    }
  }
  return workflows.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

async function isKnownWorkflowPath(filePath: string): Promise<boolean> {
  const target = resolve(filePath).toLowerCase()
  const installations = await findDesktopInstallations()
  return installations.some((installation) => workflowDirectoriesFromInstall(installation.installPath)
    .some((root) => target.startsWith(`${resolve(root).toLowerCase()}\\`)))
}

export async function importLocalComfyWorkflow(filePath?: string): Promise<ImportedComfyWorkflow> {
  let selectedPath = filePath
  if (!selectedPath) {
    const known = await listLocalComfyWorkflows()
    const selected = await dialog.showOpenDialog({
      title: '选择 ComfyUI 工作流',
      defaultPath: known[0]?.path,
      properties: ['openFile'],
      filters: [{ name: 'ComfyUI 工作流', extensions: ['json'] }],
    })
    if (selected.canceled || !selected.filePaths[0]) return { success: false, canceled: true }
    selectedPath = selected.filePaths[0]
  } else if (!(await isKnownWorkflowPath(selectedPath))) {
    return { success: false, error: '只能读取已检测到的 ComfyUI Desktop 工作流' }
  }

  try {
    if (extname(selectedPath).toLowerCase() !== '.json') throw new Error('请选择 JSON 工作流文件')
    const parsed = JSON.parse(await readFile(selectedPath, 'utf8')) as unknown
    const { workflow, converted } = normalizeApiWorkflow(parsed)
    const sourceName = basename(selectedPath, extname(selectedPath))
    const nodeCount = Object.keys(workflow).length
    const analysis = analyzeComfyWorkflow(workflow)
    if (analysis.kind === 'video') throw new Error('当前生图配置不支持视频工作流')
    if (analysis.outputBindings.length === 0) {
      throw new Error('当前生图配置仅支持包含 SaveImage 或 PreviewImage 的图片工作流')
    }
    return {
      success: true,
      sourceName,
      workflow: JSON.stringify(workflow, null, 2),
      nodeCount,
      converted,
      settings: inferSettings(workflow),
      analysis,
      workflowMeta: {
        sourceName,
        sourcePath: selectedPath,
        nodeCount,
        converted,
        hash: hashComfyWorkflow(workflow),
        analyzerVersion: COMFY_ANALYZER_VERSION,
      },
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

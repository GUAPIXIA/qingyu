import { app, dialog } from 'electron'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

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

type ApiWorkflow = Record<string, ApiNode>
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
    if (!hasImageOutput(workflow)) throw new Error('当前生图配置仅支持包含 SaveImage 或 PreviewImage 的图片工作流')
    return {
      success: true,
      sourceName: basename(selectedPath, extname(selectedPath)),
      workflow: JSON.stringify(workflow, null, 2),
      nodeCount: Object.keys(workflow).length,
      converted,
      settings: inferSettings(workflow),
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * ComfyUI 实机出图验收（阶段五）
 *
 * 与 imageGen.comfyui.test.ts 不同，本用例不 mock fetch，直接连接本机
 * 运行中的 ComfyUI 服务，用真实的 Desktop 工作流文件走完整链路：
 * 画布转换 → 分析 → 提交 /prompt → 轮询 /history → 下载图片。
 *
 * 依赖本机环境（缺一即跳过，不判失败）：
 * - ComfyUI 服务监听 127.0.0.1:8188
 * - Desktop 安装清单中存在 image_z_image_turbo.json
 * - 所需模型（z_image_turbo / qwen_3_4b / ae）已就位
 *
 * 运行（需显式开启，默认测试套件会跳过，避免在开发者本机触发真实 GPU 出图）：
 *   PowerShell: $env:QINGYU_LIVE='1'; pnpm vitest run electron/services/__tests__/comfyui.live.test.ts
 */
// @vitest-environment node
import { describe, expect, it, beforeAll, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP || '/tmp' },
}))

import { analyzeComfyWorkflow, normalizeComfyWorkflow } from '../comfyWorkflow'
import { generateImage, fetchComfyObjectInfo } from '../imageGen'
import type { ComfyImageGenConfig } from '../../../shared/types'

const BASE_URL = 'http://127.0.0.1:8188'

/** 从 Desktop 安装清单推导工作流目录。 */
function findWorkflowFile(name: string): string | null {
  const appData = process.env.APPDATA
  if (!appData) return null
  const manifest = join(appData, 'Comfy Desktop', 'installations.json')
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as Array<{ installPath?: string; status?: string }>
    for (const item of parsed) {
      if (item.status !== 'installed' || !item.installPath) continue
      for (const root of [join(item.installPath, 'ComfyUI', 'user'), join(item.installPath, 'user')]) {
        if (!existsSync(root)) continue
        for (const profile of readdirSync(root)) {
          const candidate = join(root, profile, 'workflows', name)
          if (existsSync(candidate)) return candidate
        }
      }
    }
  } catch {
    return null
  }
  return null
}

async function serviceAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/system_stats`, { signal: AbortSignal.timeout(4000) })
    return res.ok
  } catch {
    return false
  }
}

const workflowPath = findWorkflowFile('image_z_image_turbo.json')
// 未显式开启时整组跳过：默认 pnpm test 不应触发真实出图。
const enabled = process.env.QINGYU_LIVE === '1'
let alive = false

beforeAll(async () => {
  if (!enabled) return
  alive = await serviceAlive()
  if (!alive) console.warn('[live] ComfyUI 服务不可达，跳过实机用例')
  if (!workflowPath) console.warn('[live] 未找到 image_z_image_turbo.json，跳过实机用例')
})

describe.skipIf(!enabled)('ComfyUI 实机出图（Z-Image Turbo）', () => {
  it('分析真实 Desktop 工作流，得到 1080x1920 / 8 Steps / CFG 1 / res_multistep / simple', async () => {
    if (!alive || !workflowPath) return

    const parsed = JSON.parse(readFileSync(workflowPath, 'utf8')) as unknown
    const { workflow, converted } = normalizeComfyWorkflow(parsed)
    const analysis = analyzeComfyWorkflow(workflow)

    // 该文件是画布格式且含子图，必须走转换。
    expect(converted).toBe(true)
    expect(analysis.kind).toBe('text-to-image')
    expect(analysis.compatible).toBe(true)

    // 子图内节点已展开，键带 57:3: 前缀。
    expect(Object.keys(workflow).some((id) => id.startsWith('57:'))).toBe(true)

    const params = analysis.parameterGroups.flatMap((g) => g.parameters)
    const byId = (suffix: string) => params.find((p) => p.id.endsWith(suffix))

    expect(byId('.steps')?.workflowValue).toBe(8)
    expect(byId('.cfg')?.workflowValue).toBe(1)
    expect(byId('.sampler_name')?.workflowValue).toBe('res_multistep')
    expect(byId('.scheduler')?.workflowValue).toBe('simple')

    const size = params.find((p) => p.type === 'size')
    expect(size?.workflowValue).toBe('1080x1920')

    // 三个 Loader 都应被识别，且非模型输入（weight_dtype / type / device）不被当作模型名。
    const deps = analysis.dependencies
    expect(deps.find((d) => d.classType === 'UNETLoader')?.value).toBe('z_image_turbo_bf16.safetensors')
    expect(deps.find((d) => d.classType === 'CLIPLoader')?.value).toBe('qwen_3_4b.safetensors')
    expect(deps.find((d) => d.classType === 'VAELoader')?.value).toBe('ae.safetensors')
    expect(deps.some((d) => d.inputName === 'weight_dtype' || d.inputName === 'device' || d.inputName === 'type')).toBe(false)
  })

  it('用 /object_info 校验模型存在，且工作流类型全部可用', async () => {
    if (!alive || !workflowPath) return

    const info = await fetchComfyObjectInfo(BASE_URL)
    expect(info.success).toBe(true)

    const parsed = JSON.parse(readFileSync(workflowPath, 'utf8')) as unknown
    const { workflow } = normalizeComfyWorkflow(parsed)
    const analysis = analyzeComfyWorkflow(workflow, info.objectInfo)

    // 本地模型齐备，不应有缺失或未知节点告警。
    expect(analysis.warnings.some((w) => w.code === 'missing-model')).toBe(false)
    expect(analysis.warnings.some((w) => w.code === 'unknown-node')).toBe(false)
    expect(analysis.dependencies.every((d) => d.available !== false)).toBe(true)
  })

  it('无覆盖出图：沿用工作流原参数，实际生成成功', async () => {
    if (!alive || !workflowPath) return

    const raw = JSON.parse(readFileSync(workflowPath, 'utf8')) as unknown
    const { workflow } = normalizeComfyWorkflow(raw)
    const config: ComfyImageGenConfig = {
      id: 'live-z-image',
      name: 'Z-Image Live',
      provider: 'comfyui',
      apiKey: '',
      baseUrl: BASE_URL,
      enabled: true,
      order: 0,
      workflow: JSON.stringify(workflow),
    }

    const result = await generateImage(config, 'a quiet harbor town at golden hour', {
      negativePrompt: '',
    })

    if (!result.success) console.error('[live] 生图失败:', result.error)
    expect(result.success).toBe(true)
    expect(result.images?.length).toBeGreaterThan(0)
    expect(result.images?.[0].startsWith('data:image/')).toBe(true)
  }, 300_000)

  it('单项覆盖出图：只改 steps，仍能生成且工作流其余部分不变', async () => {
    if (!alive || !workflowPath) return

    const raw = JSON.parse(readFileSync(workflowPath, 'utf8')) as unknown
    const { workflow } = normalizeComfyWorkflow(raw)
    const baseline = JSON.parse(JSON.stringify(workflow)) as Record<string, { inputs: Record<string, unknown> }>

    // 找出采样器的 steps 键，直接用节点级覆盖改掉它。
    const analysis = analyzeComfyWorkflow(workflow)
    const stepsParam = analysis.parameterGroups
      .flatMap((g) => g.parameters)
      .find((p) => p.inputName === 'steps')
    expect(stepsParam).toBeTruthy()

    const config: ComfyImageGenConfig = {
      id: 'live-z-image-2',
      name: 'Z-Image Override',
      provider: 'comfyui',
      apiKey: '',
      baseUrl: BASE_URL,
      enabled: true,
      order: 0,
      workflow: JSON.stringify(workflow),
      overrides: { [stepsParam!.id]: 6 },
    }

    const result = await generateImage(config, 'a quiet harbor town at golden hour', {})
    expect(result.success).toBe(true)
    expect(result.images?.length).toBeGreaterThan(0)

    // 覆盖是纯函数外的行为：原快照对象不应被就地修改。
    const samplerId = stepsParam!.nodeId
    expect(baseline[samplerId].inputs.steps).toBe(8)
  }, 300_000)
})

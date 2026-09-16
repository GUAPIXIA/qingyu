import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/defaults'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { ImageGenModelsSection } from '../ImageGenModelsSection'
import type { ComfyWorkflowAnalysis } from '../../../../shared/ipc-api'

/** Z-Image 风格分析结果：一个采样阶段 + 一个尺寸节点 + 三个 Loader。 */
const analysis: ComfyWorkflowAnalysis = {
  kind: 'text-to-image',
  nodeCount: 9,
  compatible: true,
  promptBindings: [
    { role: 'positive', nodeId: '4' },
    { role: 'negative', nodeId: '5' },
  ],
  outputBindings: [{ role: 'output', nodeId: '9' }],
  parameterGroups: [
    {
      id: '6',
      nodeId: '6',
      classType: 'EmptySD3LatentImage',
      title: 'EmptySD3LatentImage #6',
      stage: 'output',
      parameters: [{
        id: '6.width',
        nodeId: '6',
        inputName: 'width',
        label: '尺寸',
        type: 'size',
        workflowValue: '1080x1920',
        pairedInputName: 'height',
        pairedWorkflowValue: 1920,
        required: true,
      }],
    },
    {
      id: '7',
      nodeId: '7',
      classType: 'KSampler',
      title: 'KSampler #7',
      stage: 'sampling',
      parameters: [
        { id: '7.steps', nodeId: '7', inputName: 'steps', label: 'Steps', type: 'number', workflowValue: 8, required: true },
        {
          id: '7.sampler_name',
          nodeId: '7',
          inputName: 'sampler_name',
          label: 'Sampler',
          type: 'select',
          workflowValue: 'res_multistep',
          options: ['euler', 'res_multistep'],
          required: true,
        },
        { id: '7.seed', nodeId: '7', inputName: 'seed', label: '种子', type: 'number', workflowValue: 1, required: true, advanced: true },
      ],
    },
  ],
  dependencies: [
    {
      nodeId: '1',
      inputName: 'unet_name',
      classType: 'UNETLoader',
      label: 'UNet',
      value: 'z_image_turbo_bf16.safetensors',
      provides: ['MODEL'],
      usedBy: [{ nodeId: '7', inputName: 'model' }],
      options: ['z_image_turbo_bf16.safetensors'],
      available: true,
    },
    {
      nodeId: '3',
      inputName: 'vae_name',
      classType: 'VAELoader',
      label: 'VAE',
      value: 'missing.safetensors',
      provides: ['VAE'],
      usedBy: [{ nodeId: '8', inputName: 'vae' }],
      options: ['ae.safetensors'],
      available: false,
    },
  ],
  warnings: [],
}

function mockImportResult(overrides: Partial<ComfyWorkflowAnalysis> = {}) {
  return {
    success: true,
    sourceName: 'image_z_image_turbo',
    workflow: JSON.stringify({ '7': { class_type: 'KSampler', inputs: { steps: 8 } } }),
    nodeCount: 9,
    converted: false,
    analysis: { ...analysis, ...overrides },
    workflowMeta: {
      sourceName: 'image_z_image_turbo',
      nodeCount: 9,
      converted: false,
      hash: 'abc',
      analyzerVersion: 1,
    },
  }
}

/** 打开 ComfyUI 新建表单，并模拟一次工作流读取。 */
async function openComfyWithWorkflow(importResult: unknown = mockImportResult()) {
  render(<ImageGenModelsSection />)
  fireEvent.click(screen.getByRole('button', { name: '添加生图模型' }))
  fireEvent.click(screen.getByRole('button', { name: 'ComfyUI' }))
  const api = window.api.imageGen as unknown as Record<string, ReturnType<typeof vi.fn>>
  api.importLocalComfyWorkflow.mockResolvedValueOnce(importResult)
  // 导入后会再带 /object_info 分析一次，这里是权威结果。
  api.analyzeComfyWorkflow.mockResolvedValue({ success: true, analysis })
  fireEvent.click(screen.getByText('选择其他 JSON'))
  await waitFor(() => expect(screen.getByText('工作流参数')).toBeTruthy())
}

describe('ImageGenModelsSection', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: { ...getDefaultSettings(), imageGenModels: [] },
      loaded: true,
      _saveTimer: null,
    })
    vi.clearAllMocks()
    const api = window.api.imageGen as unknown as Record<string, ReturnType<typeof vi.fn>>
    api.listLocalComfyWorkflows.mockResolvedValue({ success: true, workflows: [] })
    api.fetchObjectInfo.mockResolvedValue({ success: false, error: 'offline' })
    api.analyzeComfyWorkflow.mockResolvedValue({ success: false, error: 'not mocked' })
  })

  it('提供 ComfyUI Desktop 工作流入口和高级 JSON 字段', () => {
    render(<ImageGenModelsSection />)

    fireEvent.click(screen.getByRole('button', { name: '添加生图模型' }))
    fireEvent.click(screen.getByRole('button', { name: 'ComfyUI' }))

    expect(screen.getByDisplayValue('http://127.0.0.1:8188')).toBeTruthy()
    // ComfyUI 的模型由工作流内 Loader 节点决定，不再显示 Checkpoint 输入框。
    expect(screen.queryByText('Checkpoint 文件名（内置工作流）')).toBeNull()
    expect(screen.queryByText('模型名称')).toBeNull()
    expect(screen.getByText('ComfyUI Desktop 工作流')).toBeTruthy()
    fireEvent.click(screen.getByText('高级：查看或粘贴 API 工作流 JSON'))
    expect(screen.getByPlaceholderText(/粘贴 ComfyUI 导出的 API 格式工作流/)).toBeTruthy()
  })

  it('ComfyUI 不再显示会被工作流覆盖的通用采样参数', () => {
    render(<ImageGenModelsSection />)

    fireEvent.click(screen.getByRole('button', { name: '添加生图模型' }))
    fireEvent.click(screen.getByRole('button', { name: 'ComfyUI' }))

    // 这些参数改由工作流节点与 overrides 决定，由动态参数区呈现。
    expect(screen.queryByText('采样步数 (Steps)')).toBeNull()
    expect(screen.queryByText('CFG Scale')).toBeNull()
    expect(screen.queryByText('调度器')).toBeNull()
    expect(screen.queryByText('图片尺寸（默认值，可在快捷面板覆盖）')).toBeNull()
  })

  it('SD WebUI 保留通用采样参数输入', () => {
    render(<ImageGenModelsSection />)

    fireEvent.click(screen.getByRole('button', { name: '添加生图模型' }))
    fireEvent.click(screen.getByRole('button', { name: 'SD WebUI (A1111)' }))

    expect(screen.getByText('采样步数 (Steps)')).toBeTruthy()
    expect(screen.getByText('CFG Scale')).toBeTruthy()
    expect(screen.getByText('负面提示词')).toBeTruthy()
    expect(screen.getByText('图片尺寸（默认值，可在快捷面板覆盖）')).toBeTruthy()
  })

  it('读取工作流后按分析结果渲染动态参数与工作流原值', async () => {
    await openComfyWithWorkflow()

    // 参数项与工作流原值。
    expect(screen.getByText('Steps')).toBeTruthy()
    expect(screen.getByDisplayValue('8')).toBeTruthy()
    expect((screen.getByLabelText('尺寸 宽') as HTMLInputElement).value).toBe('1080')
    expect((screen.getByLabelText('尺寸 高') as HTMLInputElement).value).toBe('1920')
    // 采样器选项包含工作流当前值。
    expect((screen.getByDisplayValue('res_multistep') as HTMLSelectElement).tagName).toBe('SELECT')
    // 检查结论。
    expect(screen.getByText('工作流可用')).toBeTruthy()
    expect(screen.getByText(/文生图 · 9 节点/)).toBeTruthy()
  })

  it('模型依赖卡在 /object_info 可用时校验存在性', async () => {
    await openComfyWithWorkflow()

    expect(screen.getByText('模型依赖')).toBeTruthy()
    expect(screen.getByText('z_image_turbo_bf16.safetensors')).toBeTruthy()
    expect(screen.getByText('未找到')).toBeTruthy()
  })

  it('修改参数只写入节点级覆盖，并可逐项还原', async () => {
    await openComfyWithWorkflow()

    const steps = screen.getByDisplayValue('8')
    fireEvent.change(steps, { target: { value: '12' } })
    await waitFor(() => expect(screen.getByText('已改')).toBeTruthy())
    expect(screen.getByText('1 项已覆盖')).toBeTruthy()

    fireEvent.click(screen.getByTitle('恢复工作流原值'))
    await waitFor(() => expect(screen.queryByText('已改')).toBeNull())
  })

  it('/object_info 不可用时仍按工作流原值渲染参数，不阻塞编辑', async () => {
    // fetchObjectInfo 已在 beforeEach 中固定为失败。
    await openComfyWithWorkflow()

    expect(screen.getByText('Steps')).toBeTruthy()
    expect(screen.getByDisplayValue('8')).toBeTruthy()
    expect(window.api.imageGen.fetchObjectInfo).toHaveBeenCalled()
  })

  it('分析失败时展示错误且不渲染参数区', async () => {
    render(<ImageGenModelsSection />)
    fireEvent.click(screen.getByRole('button', { name: '添加生图模型' }))
    fireEvent.click(screen.getByRole('button', { name: 'ComfyUI' }))

    const api = window.api.imageGen as unknown as Record<string, ReturnType<typeof vi.fn>>
    api.importLocalComfyWorkflow.mockResolvedValueOnce({ success: false, error: '这不是有效的 API 工作流' })
    fireEvent.click(screen.getByText('选择其他 JSON'))

    await waitFor(() => expect(screen.getByText('这不是有效的 API 工作流')).toBeTruthy())
    expect(screen.queryByText('工作流参数')).toBeNull()
  })

  it('未选择工作流时禁用保存', () => {
    render(<ImageGenModelsSection />)
    fireEvent.click(screen.getByRole('button', { name: '添加生图模型' }))
    fireEvent.click(screen.getByRole('button', { name: 'ComfyUI' }))
    fireEvent.change(screen.getByPlaceholderText(/配置名称/), { target: { value: '本地 Z-Image' } })

    const save = screen.getByRole('button', { name: /保存/ })
    expect(save.hasAttribute('disabled')).toBe(true)
  })

  it('扫描到唯一的 ComfyUI 工作流时自动读取，无需切换下拉项', async () => {
    const api = window.api.imageGen as unknown as Record<string, ReturnType<typeof vi.fn>>
    api.listLocalComfyWorkflows.mockResolvedValue({
      success: true,
      workflows: [{
        name: 'image_z_image_turbo',
        path: 'C:\\ComfyUI\\workflows\\image_z_image_turbo.json',
        installation: 'ComfyUI Desktop',
      }],
    })
    api.importLocalComfyWorkflow.mockResolvedValue(mockImportResult())
    api.analyzeComfyWorkflow.mockResolvedValue({ success: true, analysis })

    render(<ImageGenModelsSection />)
    fireEvent.click(screen.getByRole('button', { name: '添加生图模型' }))
    fireEvent.click(screen.getByRole('button', { name: 'ComfyUI' }))

    await waitFor(() => {
      expect(api.importLocalComfyWorkflow).toHaveBeenCalledWith(
        'C:\\ComfyUI\\workflows\\image_z_image_turbo.json',
      )
    })

    fireEvent.change(screen.getByPlaceholderText(/配置名称/), { target: { value: '本地 Z-Image' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /保存/ })).not.toBeDisabled()
    })
  })
})

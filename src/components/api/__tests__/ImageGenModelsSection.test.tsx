import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/defaults'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { ImageGenModelsSection } from '../ImageGenModelsSection'

describe('ImageGenModelsSection', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: { ...getDefaultSettings(), imageGenModels: [] },
      loaded: true,
      _saveTimer: null,
    })
  })

  it('提供 ComfyUI Desktop 工作流入口和高级 JSON 字段', () => {
    render(<ImageGenModelsSection />)

    fireEvent.click(screen.getByRole('button', { name: '添加生图模型' }))
    fireEvent.click(screen.getByRole('button', { name: 'ComfyUI' }))

    expect(screen.getByDisplayValue('http://127.0.0.1:8188')).toBeTruthy()
    // 模型名仅用于内置工作流回退，标签已相应限定。
    expect(screen.getByText('Checkpoint 文件名（内置工作流）')).toBeTruthy()
    expect(screen.getByText('ComfyUI Desktop 工作流')).toBeTruthy()
    fireEvent.click(screen.getByText('高级：查看或粘贴 API 工作流 JSON'))
    expect(screen.getByPlaceholderText(/粘贴 ComfyUI 导出的 API 格式工作流/)).toBeTruthy()
  })

  it('ComfyUI 不再显示会被工作流覆盖的通用采样参数', () => {
    render(<ImageGenModelsSection />)

    fireEvent.click(screen.getByRole('button', { name: '添加生图模型' }))
    fireEvent.click(screen.getByRole('button', { name: 'ComfyUI' }))

    // 这些参数改由工作流节点与 overrides 决定，阶段三再以动态控件恢复。
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
})

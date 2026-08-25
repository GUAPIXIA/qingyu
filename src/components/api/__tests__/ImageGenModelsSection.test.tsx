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

  it('提供 ComfyUI 配置入口和 API 工作流字段', () => {
    render(<ImageGenModelsSection />)

    fireEvent.click(screen.getByRole('button', { name: '添加生图模型' }))
    fireEvent.click(screen.getByRole('button', { name: 'ComfyUI' }))

    expect(screen.getByDisplayValue('http://127.0.0.1:8188')).toBeTruthy()
    expect(screen.getByText('Checkpoint 文件名')).toBeTruthy()
    expect(screen.getByText('API 工作流 JSON（可选）')).toBeTruthy()
    expect(screen.getByPlaceholderText(/粘贴 ComfyUI 导出的 API 格式工作流/)).toBeTruthy()
  })
})

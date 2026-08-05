import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CoverStep } from '../CoverStep'
import { useCharacterCreatorStore } from '../../../store/useCharacterCreatorStore'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { getDefaultSettings } from '../../../../shared/defaults'

beforeEach(() => {
  vi.clearAllMocks()
  useCharacterCreatorStore.getState().reset()
  useSettingsStore.setState({
    settings: {
      ...getDefaultSettings(),
      activeProfileId: null,
      connectionProfiles: [],
      imageGenModels: [],
      activeImageGenModelId: null,
    },
  })
  ;(window.api as unknown as Record<string, unknown>).imageGen = {
    generate: vi.fn().mockResolvedValue({ success: false, error: 'not mocked' }),
    testConnection: vi.fn().mockResolvedValue({ success: true }),
  }
})

function renderStep() {
  return render(
    <MemoryRouter>
      <CoverStep />
    </MemoryRouter>,
  )
}

describe('CoverStep（封面制作）', () => {
  it('无封面时显示占位预览', () => {
    renderStep()
    expect(screen.getByText('3:4 封面预览')).toBeInTheDocument()
  })

  it('无生图配置时 AI 生成 Tab 显示引导卡片', () => {
    renderStep()
    fireEvent.click(screen.getByText('AI 生成'))
    expect(screen.getByText('尚未配置生图模组')).toBeInTheDocument()
    expect(screen.getByText('前往配置')).toBeInTheDocument()
    expect(screen.getByText('改用上传图片')).toBeInTheDocument()
    // 引导中的暂时跳过 → 直接去预览保存
    fireEvent.click(screen.getByText('暂时跳过'))
    expect(useCharacterCreatorStore.getState().step).toBe(2)
  })

  it('有生图配置时显示提示词编辑与生成按钮', () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        imageGenModels: [
          {
            id: 'g1',
            name: 'SD',
            provider: 'sd-webui',
            model: 'sd',
            apiKey: '',
            baseUrl: 'http://localhost:7860',
            size: '576x768',
            quality: '',
            enabled: true,
            order: 0,
          },
        ],
        activeImageGenModelId: 'g1',
      },
    })
    renderStep()
    fireEvent.click(screen.getByText('AI 生成'))
    expect(screen.getByText('重新构建提示词')).toBeInTheDocument()
    expect(screen.getByText('风格预设（点击追加）')).toBeInTheDocument()
    expect(screen.getByText('生成封面')).toBeInTheDocument()
  })

  it('重新构建提示词：draft 信息不足时提示回 Step 1', () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        imageGenModels: [
          {
            id: 'g1',
            name: 'SD',
            provider: 'sd-webui',
            model: 'sd',
            apiKey: '',
            baseUrl: 'http://localhost:7860',
            size: '576x768',
            quality: '',
            enabled: true,
            order: 0,
          },
        ],
        activeImageGenModelId: 'g1',
      },
    })
    renderStep()
    fireEvent.click(screen.getByText('AI 生成'))
    fireEvent.click(screen.getByText('重新构建提示词'))
    expect(screen.getByText(/请先完成「概念设定」/)).toBeInTheDocument()
  })

  it('重新构建提示词：有角色信息时自动填充', () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        imageGenModels: [
          {
            id: 'g1',
            name: 'SD',
            provider: 'sd-webui',
            model: 'sd',
            apiKey: '',
            baseUrl: 'http://localhost:7860',
            size: '576x768',
            quality: '',
            enabled: true,
            order: 0,
          },
        ],
        activeImageGenModelId: 'g1',
      },
    })
    useCharacterCreatorStore.getState().updateDraft({
      name: '零',
      description: '银色短发的女黑客',
      scenario: '赛博朋克都市',
    })
    renderStep()
    fireEvent.click(screen.getByText('AI 生成'))
    fireEvent.click(screen.getByText('重新构建提示词'))
    const prompt = useCharacterCreatorStore.getState().coverPrompt
    expect(prompt).toContain('1girl')
    expect(prompt).toContain('silver hair')
    expect(prompt).toContain('cyberpunk')
  })

  it('点击生成封面调用 imageGen.generate', async () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        imageGenModels: [
          {
            id: 'g1',
            name: 'SD',
            provider: 'sd-webui',
            model: 'sd',
            apiKey: '',
            baseUrl: 'http://localhost:7860',
            size: '576x768',
            quality: '',
            enabled: true,
            order: 0,
          },
        ],
        activeImageGenModelId: 'g1',
      },
    })
    useCharacterCreatorStore.setState({ coverPrompt: 'best quality, 1girl' })
    ;(window.api.imageGen.generate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      images: ['data:image/png;base64,cover1'],
    })
    renderStep()
    fireEvent.click(screen.getByText('AI 生成'))
    fireEvent.click(screen.getByText('生成封面'))
    await act(async () => {}) // 冲刷 generateCover 的异步 set
    expect(useCharacterCreatorStore.getState().coverBase64).toBe('data:image/png;base64,cover1')
  })

  it('生成中显示加载状态，完成后恢复', async () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        imageGenModels: [
          {
            id: 'g1',
            name: 'SD',
            provider: 'sd-webui',
            model: 'sd',
            apiKey: '',
            baseUrl: 'http://localhost:7860',
            size: '576x768',
            quality: '',
            enabled: true,
            order: 0,
          },
        ],
        activeImageGenModelId: 'g1',
      },
    })
    useCharacterCreatorStore.setState({ coverPrompt: 'prompt' })
    let resolveGen: (v: unknown) => void = () => {}
    ;(window.api.imageGen.generate as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((r) => {
          resolveGen = r
        }),
    )
    renderStep()
    fireEvent.click(screen.getByText('AI 生成'))
    fireEvent.click(screen.getByText('生成封面'))
    expect(screen.getByText('生成中…')).toBeInTheDocument()
    await act(async () => {
      resolveGen({ success: true, images: ['data:image/png;base64,done'] })
    })
    expect(screen.queryByText('生成中…')).not.toBeInTheDocument()
    expect(useCharacterCreatorStore.getState().coverBase64).toBe('data:image/png;base64,done')
  })

  it('风格预设点选追加到提示词，再点取消', () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        imageGenModels: [
          {
            id: 'g1',
            name: 'SD',
            provider: 'sd-webui',
            model: 'sd',
            apiKey: '',
            baseUrl: 'http://localhost:7860',
            size: '576x768',
            quality: '',
            enabled: true,
            order: 0,
          },
        ],
        activeImageGenModelId: 'g1',
      },
    })
    useCharacterCreatorStore.setState({ coverPrompt: 'best quality' })
    renderStep()
    fireEvent.click(screen.getByText('AI 生成'))
    fireEvent.click(screen.getByText('二次元'))
    expect(useCharacterCreatorStore.getState().coverPrompt).toContain('anime style')
    fireEvent.click(screen.getByText('二次元'))
    expect(useCharacterCreatorStore.getState().coverPrompt).not.toContain('anime style')
  })

  it('尺寸选择与负面提示词可编辑', () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        imageGenModels: [
          {
            id: 'g1',
            name: 'SD',
            provider: 'sd-webui',
            model: 'sd',
            apiKey: '',
            baseUrl: 'http://localhost:7860',
            size: '576x768',
            quality: '',
            enabled: true,
            order: 0,
          },
        ],
        activeImageGenModelId: 'g1',
      },
    })
    renderStep()
    fireEvent.click(screen.getByText('AI 生成'))
    fireEvent.change(screen.getByDisplayValue('576x768'), { target: { value: '768x1024' } })
    expect(useCharacterCreatorStore.getState().coverSize).toBe('768x1024')
    const negInput = screen.getByPlaceholderText(/lowres, bad anatomy/)
    fireEvent.change(negInput, { target: { value: 'bad quality' } })
    expect(useCharacterCreatorStore.getState().negativePrompt).toBe('bad quality')
  })

  it('选择本地文件上传为封面（FileReader）', async () => {
    // jsdom 无真实 FileReader：stub 同步触发 onload
    vi.stubGlobal(
      'FileReader',
      class {
        result = 'data:image/png;base64,uploaded'
        onload: (() => void) | null = null
        readAsDataURL() {
          this.onload?.()
        }
      },
    )
    renderStep()
    const fileInput = document.querySelector('input[type=file]') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
    await act(async () => {}) // 冲刷 readFileAsBase64 的异步 set
    expect(useCharacterCreatorStore.getState().coverBase64).toBe('data:image/png;base64,uploaded')
    expect(useCharacterCreatorStore.getState().coverMode).toBe('upload')
    vi.unstubAllGlobals()
  })

  it('拖拽文件到上传区触发上传', async () => {
    vi.stubGlobal(
      'FileReader',
      class {
        result = 'data:image/png;base64,dropped'
        onload: (() => void) | null = null
        readAsDataURL() {
          this.onload?.()
        }
      },
    )
    renderStep()
    const dropZone = screen.getByText(/点击选择或拖拽图片到此处/).closest('div')!
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [new File(['x'], 'b.png', { type: 'image/png' })] },
    })
    await act(async () => {}) // 冲刷 readFileAsBase64 的异步 set
    expect(useCharacterCreatorStore.getState().coverBase64).toBe('data:image/png;base64,dropped')
    vi.unstubAllGlobals()
  })
})

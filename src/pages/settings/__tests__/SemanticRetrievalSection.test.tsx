import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { getDefaultSettings } from '../../../../shared/defaults'
import type { InstalledLocalModel } from '../../../../shared/localModels'
import type { ConnectionProfile } from '../../../../shared/types'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { SemanticRetrievalSection } from '../SemanticRetrievalSection'

const profile: ConnectionProfile = {
  id: 'remote-1',
  name: '远程测试',
  provider: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'secret',
  model: 'chat-model',
  maxContext: 8192,
}

const activeModel = {
  active: true,
  installedAt: 1,
  state: 'in_use',
  manifest: {
    schemaVersion: 1,
    id: 'tiny',
    version: '1.0.0',
    displayName: '本地测试模型',
    description: '测试说明',
    languages: ['中文'],
    license: { name: 'MIT', url: 'https://example.com' },
    runtime: 'onnx',
    architecture: 'bert',
    dimensions: 384,
    maxTokens: 512,
    dtype: 'q8',
    pooling: 'mean',
    normalize: true,
    minimumAppVersion: '0.1.0',
    recommendedMemoryMb: 128,
    installedSize: 1024,
    files: [],
    catalogSignature: 'signed',
  },
} as InstalledLocalModel

function renderSection(settings = getDefaultSettings(), updateSettings = vi.fn()) {
  useSettingsStore.setState({ settings })
  render(
    <SemanticRetrievalSection
      settings={settings}
      updateSettings={updateSettings}
      embedTestBusy={false}
      embedTestResult={null}
      handleEmbedTest={vi.fn()}
    />,
  )
  return updateSettings
}

beforeEach(() => {
  vi.mocked(window.api.localModel.catalog).mockResolvedValue([])
  vi.mocked(window.api.localModel.installed).mockResolvedValue([])
  vi.mocked(window.api.localModel.tasks).mockResolvedValue([])
  vi.mocked(window.api.localModel.storageUsage).mockResolvedValue({ modelBytes: 0, indexBytes: 0, stagingBytes: 0, totalBytes: 0 })
  vi.mocked(window.api.localModel.onProgress).mockReturnValue(() => {})
})

describe('SemanticRetrievalSection', () => {
  it('在一个语义检索卡片中组合策略、召回设置与本地模型管理', async () => {
    renderSection()
    expect(screen.getByRole('heading', { name: '语义检索' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: '检索策略' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '本地模型与索引' })).toBeTruthy()
    expect(await screen.findByText(/模型只在本机 CPU worker 中运行/)).toBeTruthy()
  })

  it('切换仅词法时在一次更新中关闭语义触发', async () => {
    const settings = {
      ...getDefaultSettings(),
      semanticTrigger: { ...getDefaultSettings().semanticTrigger!, enabled: true },
    }
    const updateSettings = renderSection(settings)
    await screen.findByText(/官方在线目录当前没有/)
    fireEvent.click(screen.getByRole('radio', { name: /仅词法/ }))
    expect(updateSettings).toHaveBeenCalledWith({
      localModels: expect.objectContaining({ retrievalMode: 'lexical' }),
      semanticTrigger: expect.objectContaining({ enabled: false }),
    })
  })

  it('点击已选策略时可修复旧配置留下的不一致状态', async () => {
    const defaults = getDefaultSettings()
    const settings = {
      ...defaults,
      localModels: { ...defaults.localModels!, retrievalMode: 'lexical' as const },
      semanticTrigger: { ...defaults.semanticTrigger!, enabled: true },
    }
    const updateSettings = renderSection(settings)
    await screen.findByText(/官方在线目录当前没有/)
    fireEvent.click(screen.getByRole('radio', { name: /仅词法/ }))
    expect(updateSettings).toHaveBeenCalledWith({
      localModels: expect.objectContaining({ retrievalMode: 'lexical' }),
      semanticTrigger: expect.objectContaining({ enabled: false }),
    })
  })

  it('没有默认模型时拒绝半切换到本地策略', async () => {
    const updateSettings = renderSection()
    await screen.findByText(/官方在线目录当前没有/)
    fireEvent.click(screen.getByRole('radio', { name: /本地模型/ }))
    expect(await screen.findByText(/请先在下方安装模型/)).toBeTruthy()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('选择本地策略时同步 provider、模型和总策略', async () => {
    vi.mocked(window.api.localModel.installed).mockResolvedValue([activeModel])
    const updateSettings = renderSection()
    await screen.findByText('本地测试模型')
    fireEvent.click(screen.getByRole('radio', { name: /本地模型/ }))
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      localModels: expect.objectContaining({ retrievalMode: 'local' }),
      semanticTrigger: expect.objectContaining({ enabled: true, provider: 'local', model: 'tiny@1.0.0' }),
    }))
  })

  it('选择远程策略时复用连接档案并写入默认嵌入模型', async () => {
    const settings = { ...getDefaultSettings(), connectionProfiles: [profile] }
    const updateSettings = renderSection(settings)
    await screen.findByText(/官方在线目录当前没有/)
    fireEvent.click(screen.getByRole('radio', { name: /远程 embeddings/ }))
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      localModels: expect.objectContaining({ retrievalMode: 'remote' }),
      semanticTrigger: expect.objectContaining({
        enabled: true,
        provider: 'openai',
        profileId: profile.id,
        model: 'text-embedding-3-small',
      }),
    }))
  })

  it('仅词法仍保留模型安装管理，但隐藏无效的向量测试', async () => {
    const defaults = getDefaultSettings()
    const settings = {
      ...defaults,
      localModels: { ...defaults.localModels!, retrievalMode: 'lexical' as const },
      semanticTrigger: { ...defaults.semanticTrigger!, enabled: false },
    }
    renderSection(settings)
    await screen.findByText(/官方在线目录当前没有/)
    expect(screen.queryByRole('button', { name: '测试向量来源' })).toBeNull()
    const localSection = screen.getByRole('heading', { name: '本地模型与索引' }).parentElement?.parentElement
    expect(localSection && within(localSection).getByRole('button', { name: /导入 .qymodel/ })).toBeTruthy()
  })

  it('顶部开关关闭语义检索：一次更新关闭语义触发并切到仅词法', async () => {
    const defaults = getDefaultSettings()
    const settings = {
      ...defaults,
      localModels: { ...defaults.localModels!, retrievalMode: 'auto' as const },
      semanticTrigger: { ...defaults.semanticTrigger!, enabled: true, provider: 'local' as const, model: 'tiny@1.0.0' },
    }
    const updateSettings = renderSection(settings)
    await screen.findByText(/官方在线目录当前没有/)
    const toggle = screen.getByRole('switch', { name: '启用语义检索' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({
      localModels: expect.objectContaining({ retrievalMode: 'lexical' }),
      semanticTrigger: expect.objectContaining({ enabled: false }),
    })
  })

  it('顶部开关开启语义检索：从仅词法恢复到自动策略并启用语义触发', async () => {
    const defaults = getDefaultSettings()
    const settings = {
      ...defaults,
      localModels: { ...defaults.localModels!, retrievalMode: 'lexical' as const },
      semanticTrigger: { ...defaults.semanticTrigger!, enabled: false },
    }
    const updateSettings = renderSection(settings)
    await screen.findByText(/官方在线目录当前没有/)
    const toggle = screen.getByRole('switch', { name: '启用语义检索' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({
      localModels: expect.objectContaining({ retrievalMode: 'auto' }),
      semanticTrigger: expect.objectContaining({ enabled: true }),
    })
  })

  it('顶部开关状态与检索策略联动：仅词法时开关显示关闭', async () => {
    const defaults = getDefaultSettings()
    const settings = {
      ...defaults,
      localModels: { ...defaults.localModels!, retrievalMode: 'lexical' as const },
      semanticTrigger: { ...defaults.semanticTrigger!, enabled: false },
    }
    renderSection(settings)
    await screen.findByText(/官方在线目录当前没有/)
    expect(screen.getByText('语义检索 已关闭')).toBeTruthy()
    // 策略组中"仅词法"为选中态
    expect(screen.getByRole('radio', { name: /仅词法/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('语义检索开启时来源面板可见；关闭时隐藏', async () => {
    const defaults = getDefaultSettings()
    const enabledSettings = {
      ...defaults,
      localModels: { ...defaults.localModels!, retrievalMode: 'auto' as const },
      semanticTrigger: { ...defaults.semanticTrigger!, enabled: true, provider: 'local' as const, model: 'tiny@1.0.0' },
    }
    renderSection(enabledSettings)
    await screen.findAllByText(/官方在线目录当前没有/)
    expect(screen.getByRole('heading', { name: '向量来源与召回' })).toBeTruthy()
    // 开关显示开启
    expect(screen.getByRole('switch', { name: '启用语义检索' }).getAttribute('aria-checked')).toBe('true')
  })

  it('语义检索关闭时来源面板隐藏，开关显示关闭', async () => {
    const defaults = getDefaultSettings()
    const disabledSettings = {
      ...defaults,
      localModels: { ...defaults.localModels!, retrievalMode: 'lexical' as const },
      semanticTrigger: { ...defaults.semanticTrigger!, enabled: false },
    }
    renderSection(disabledSettings)
    await screen.findAllByText(/官方在线目录当前没有/)
    expect(screen.queryByRole('heading', { name: '向量来源与召回' })).toBeNull()
    expect(screen.getByRole('switch', { name: '启用语义检索' }).getAttribute('aria-checked')).toBe('false')
  })
})

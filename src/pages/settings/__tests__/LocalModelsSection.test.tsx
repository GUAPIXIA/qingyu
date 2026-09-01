import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LocalModelsSection } from '../LocalModelsSection'
import { getDefaultSettings } from '../../../utils/defaults'
import type { InstalledLocalModel, LocalEmbeddingModelManifest, LocalModelCatalogItem } from '../../../../shared/localModels'

const manifest: LocalEmbeddingModelManifest = {
  schemaVersion: 1, id: 'tiny', version: '1.0.0', displayName: '中文轻量测试模型', description: '测试说明', languages: ['中文'],
  license: { name: 'MIT', url: 'https://example.com' }, runtime: 'onnx', architecture: 'bert', dimensions: 384, maxTokens: 512,
  dtype: 'q8', pooling: 'mean', normalize: true, minimumAppVersion: '0.1.0', recommendedMemoryMb: 128, installedSize: 1024,
  files: [{ path: 'config.json', size: 2, sha256: '0'.repeat(64), urls: ['https://example.com/config.json'] }], catalogSignature: 'signed',
}

const api = window.api.localModel

beforeEach(() => {
  vi.mocked(api.catalog).mockResolvedValue([])
  vi.mocked(api.installed).mockResolvedValue([])
  vi.mocked(api.tasks).mockResolvedValue([])
  vi.mocked(api.storageUsage).mockResolvedValue({ modelBytes: 0, indexBytes: 0, stagingBytes: 0, totalBytes: 0 })
  vi.mocked(api.onProgress).mockReturnValue(() => {})
  vi.mocked(api.activate).mockResolvedValue({ ok: true })
  vi.mocked(api.rebuildIndexes).mockResolvedValue({ taskId: 'index' })
  vi.mocked(api.uninstall).mockResolvedValue({ taskId: 'uninstall' })
  vi.mocked(api.uninstallImpact).mockResolvedValue({ active: true, modelBytes: 1024, indexBytes: 512, lorebookCount: 2, entryCount: 12 })
})

describe('LocalModelsSection', () => {
  it('展示签名目录模型的许可证、体积与安装入口', async () => {
    vi.mocked(api.catalog).mockResolvedValue([{ manifest, state: 'not_installed' }])
    render(<LocalModelsSection settings={getDefaultSettings()} updateSettings={vi.fn()} />)
    expect(await screen.findByText('中文轻量测试模型')).toBeTruthy()
    expect(screen.getByText(/许可证：/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '安装' }))
    expect(screen.getByRole('dialog', { name: '安装本地模型' })).toBeTruthy()
    expect(screen.getByText(/Ed25519.*SHA-256/)).toBeTruthy()
  })

  it('启用模型时写入 local provider，并按策略创建后台索引任务', async () => {
    const item: LocalModelCatalogItem = { manifest, state: 'ready' }
    vi.mocked(api.catalog).mockResolvedValue([item])
    vi.mocked(api.installed).mockResolvedValue([{ manifest, state: 'ready', active: false, installedAt: 1 }])
    const updateSettings = vi.fn()
    const settings = { ...getDefaultSettings(), localModels: { ...getDefaultSettings().localModels!, idleOnly: false } }
    render(<LocalModelsSection settings={settings} updateSettings={updateSettings} />)
    fireEvent.click(await screen.findByRole('button', { name: '测试并设为默认' }))
    await waitFor(() => expect(api.activate).toHaveBeenCalledWith('tiny', '1.0.0'))
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ semanticTrigger: expect.objectContaining({ provider: 'local', model: 'tiny@1.0.0' }) }))
    await waitFor(() => expect(api.rebuildIndexes).toHaveBeenCalled())
  })

  it('卸载确认明确区分保留和删除索引，并停用默认模型的语义触发', async () => {
    const installed: InstalledLocalModel = { manifest, state: 'in_use', active: true, installedAt: 1 }
    vi.mocked(api.catalog).mockResolvedValue([{ manifest, state: 'in_use', active: true }])
    vi.mocked(api.installed).mockResolvedValue([installed])
    const updateSettings = vi.fn()
    const settings = {
      ...getDefaultSettings(),
      semanticTrigger: { enabled: true, provider: 'local' as const, baseUrl: '', apiKey: '', model: 'tiny@1.0.0', threshold: 0.3, maxResults: 3, profileId: null },
    }
    render(<LocalModelsSection settings={settings} updateSettings={updateSettings} />)
    fireEvent.click(await screen.findByRole('button', { name: '卸载' }))
    const dialog = await screen.findByRole('dialog', { name: '卸载本地模型' })
    expect(screen.getByText(/2 本世界书 · 12 条向量/)).toBeTruthy()
    fireEvent.click(screen.getByText(/仅删除模型，保留/))
    fireEvent.click(dialog.querySelector('.btn-primary')!)
    await waitFor(() => expect(api.uninstall).toHaveBeenCalledWith({ modelId: 'tiny', version: '1.0.0', removeIndexes: false }))
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ semanticTrigger: expect.objectContaining({ enabled: false, model: 'tiny@1.0.0' }) })))
  })

  it('可续传失败任务显示继续下载而不是重新安装', async () => {
    const task = {
      taskId: 'resume-me', kind: 'install' as const, modelId: 'tiny', version: '1.0.0', state: 'failed' as const,
      createdAt: 1, updatedAt: 2, downloadedBytes: 512, totalBytes: 1024, resumable: true, error: 'EPERM',
    }
    vi.mocked(api.catalog).mockResolvedValue([{ manifest, state: 'failed', task, error: task.error }])
    vi.mocked(api.tasks).mockResolvedValue([task])

    render(<LocalModelsSection settings={getDefaultSettings()} updateSettings={vi.fn()} />)

    const resume = await screen.findByRole('button', { name: '继续下载' })
    expect(screen.queryByRole('button', { name: '重新安装' })).toBeNull()
    fireEvent.click(resume)
    await waitFor(() => expect(api.resume).toHaveBeenCalledWith('resume-me'))
  })
})

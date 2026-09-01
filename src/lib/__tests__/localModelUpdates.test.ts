import { describe, expect, it } from 'vitest'
import type { LocalEmbeddingModelManifest, LocalModelCatalogItem } from '../../../shared/localModels'
import { planModelUpdates } from '../localModelUpdates'

function manifest(id: string, version: string): LocalEmbeddingModelManifest {
  return {
    schemaVersion: 1, id, version, displayName: id, description: '测试', languages: ['zh'],
    license: { name: 'MIT', url: 'https://example.com' }, runtime: 'onnx', architecture: 'bert', dimensions: 8, maxTokens: 32,
    dtype: 'q8', pooling: 'mean', normalize: true, minimumAppVersion: '0.1.0', recommendedMemoryMb: 16, installedSize: 16,
    files: [{ path: 'config.json', size: 2, sha256: '0'.repeat(64), urls: [] }], catalogSignature: 'signed',
  }
}

function item(id: string, version: string, patch: Partial<LocalModelCatalogItem> = {}): LocalModelCatalogItem {
  return { manifest: manifest(id, version), state: 'not_installed', ...patch }
}

describe('planModelUpdates', () => {
  const catalog = [
    item('m', '1.0.0', { state: 'in_use', installedVersion: '1.0.0', active: true, updateAvailable: true }),
    item('m', '1.1.0', { state: 'not_installed' }),
    item('other', '2.0.0', { state: 'not_installed' }),
  ]

  it('notify 策略不产生任何自动动作', () => {
    expect(planModelUpdates(catalog, 'notify')).toEqual({ install: [], activate: [] })
  })

  it('download 策略只安装新版本，不切换默认模型', () => {
    const plan = planModelUpdates(catalog, 'download')
    expect(plan.install).toEqual([{ modelId: 'm', version: '1.1.0', replacesActive: true }])
    expect(plan.activate).toEqual([])
  })

  it('auto 策略在新版本就绪后切换默认模型', () => {
    const readyCatalog = [
      item('m', '1.0.0', { state: 'in_use', installedVersion: '1.0.0', active: true }),
      item('m', '1.1.0', { state: 'ready', installedVersion: '1.1.0' }),
    ]
    expect(planModelUpdates(readyCatalog, 'auto')).toEqual({
      install: [],
      activate: [{ modelId: 'm', version: '1.1.0', replacesActive: true }],
    })
  })

  it('没有默认模型时新版本只下载不切换', () => {
    const noActive = [
      item('m', '1.0.0', { state: 'ready', installedVersion: '1.0.0' }),
      item('m', '1.1.0', { state: 'not_installed' }),
    ]
    expect(planModelUpdates(noActive, 'auto')).toEqual({
      install: [{ modelId: 'm', version: '1.1.0', replacesActive: false }],
      activate: [],
    })
  })

  it('已是最新版本时不产生动作', () => {
    const upToDate = [item('m', '1.0.0', { state: 'in_use', installedVersion: '1.0.0', active: true })]
    expect(planModelUpdates(upToDate, 'auto')).toEqual({ install: [], activate: [] })
  })
})

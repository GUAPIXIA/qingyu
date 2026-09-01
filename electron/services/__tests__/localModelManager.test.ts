import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalEmbeddingModelManifest, LocalModelCatalog, LocalModelTaskSnapshot } from '../../../shared/localModels'
import { LocalModelManager } from '../localModels/manager'
import { catalogSigningPayload, manifestSigningPayload } from '../localModels/manifest'

const roots: string[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup(version = '1.0.0', content = Buffer.from('{}'), rename?: (source: string, destination: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'qingyu-local-manager-')); roots.push(root)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const manifest: LocalEmbeddingModelManifest = {
    schemaVersion: 1, id: 'tiny-embedding', version, displayName: 'Tiny', description: '测试模型', languages: ['zh'],
    license: { name: 'MIT', url: 'https://example.com/license' }, runtime: 'onnx', architecture: 'bert', dimensions: 8, maxTokens: 32,
    dtype: 'q8', pooling: 'mean', normalize: true, minimumAppVersion: '0.1.0', recommendedMemoryMb: 16, installedSize: content.length,
    files: [{ path: 'config.json', size: content.length, sha256: createHash('sha256').update(content).digest('hex'), urls: ['https://models.example/config.json'] }], catalogSignature: '',
  }
  manifest.catalogSignature = sign(null, Buffer.from(manifestSigningPayload(manifest)), privateKey).toString('base64')
  const catalog: LocalModelCatalog = { schemaVersion: 1, generatedAt: '2026-08-28T00:00:00.000Z', models: [manifest], signature: '' }
  catalog.signature = sign(null, Buffer.from(catalogSigningPayload(catalog)), privateKey).toString('base64')
  const runtime = { embed: vi.fn().mockResolvedValue([Array(8).fill(0.1), Array(8).fill(0.2)]), unload: vi.fn().mockResolvedValue(undefined) }
  const manager = new LocalModelManager({ modelsRoot: join(root, 'models'), indexesRoot: join(root, 'indexes'), appVersion: '1.0.0', catalog, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), runtime, rename, renameWait: rename ? () => {} : undefined })
  return { root, content, manifest, catalog, runtime, manager, privateKey, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
}

async function waitFor(manager: LocalModelManager, taskId: string, states: string[]): Promise<LocalModelTaskSnapshot> {
  for (let i = 0; i < 100; i++) {
    const task = manager.listTasks().find((item) => item.taskId === taskId)!
    if (states.includes(task.state)) return task
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待模型任务超时')
}

describe('local model lifecycle', () => {
  it('在线安装经过下载、校验、自检后才能 ready，并可启用', async () => {
    const fixture = setup()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(fixture.content, { status: 200 })))
    const ref = fixture.manager.install(fixture.manifest.id, fixture.manifest.version)
    expect((await waitFor(fixture.manager, ref.taskId, ['ready', 'failed', 'corrupted'])).state).toBe('ready')
    expect(existsSync(join(fixture.root, 'models', fixture.manifest.id, fixture.manifest.version, 'manifest.json'))).toBe(true)
    const activation = await fixture.manager.activate(fixture.manifest.id, fixture.manifest.version)
    expect(activation.ok).toBe(true)
    expect(fixture.manager.activeManifest()?.version).toBe('1.0.0')
  })

  it('提交 staging 目录首次遇到 EPERM 时重试并完成安装', async () => {
    let commitAttempts = 0
    const rename = vi.fn((source: string, destination: string) => {
      if (existsSync(source) && statSync(source).isDirectory() && commitAttempts++ === 0) {
        throw Object.assign(new Error('directory busy'), { code: 'EPERM' })
      }
      renameSync(source, destination)
    })
    const fixture = setup('1.0.0', Buffer.from('{}'), rename)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(fixture.content, { status: 200 })))

    const ref = fixture.manager.install(fixture.manifest.id, fixture.manifest.version)
    const task = await waitFor(fixture.manager, ref.taskId, ['ready', 'failed'])

    expect(task.state).toBe('ready')
    expect(commitAttempts).toBe(2)
    expect(existsSync(join(fixture.root, 'models', fixture.manifest.id, fixture.manifest.version, 'manifest.json'))).toBe(true)
  })

  it('staging 提交持续占用失败后继续任务不重复下载已校验文件', async () => {
    let allowDirectoryCommit = false
    const rename = vi.fn((source: string, destination: string) => {
      if (existsSync(source) && statSync(source).isDirectory() && !allowDirectoryCommit) {
        throw Object.assign(new Error('directory busy'), { code: 'EPERM' })
      }
      renameSync(source, destination)
    })
    const fixture = setup('1.0.0', Buffer.from('{}'), rename)
    const fetchMock = vi.fn().mockImplementation(async () => new Response(fixture.content, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const ref = fixture.manager.install(fixture.manifest.id, fixture.manifest.version)
    expect((await waitFor(fixture.manager, ref.taskId, ['failed'])).state).toBe('failed')
    allowDirectoryCommit = true
    fixture.manager.resume(ref.taskId)
    expect((await waitFor(fixture.manager, ref.taskId, ['ready', 'failed'])).state).toBe('ready')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('hash 不匹配进入 corrupted，不能被识别为已安装', async () => {
    const fixture = setup()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('tampered', { status: 200 })))
    const ref = fixture.manager.install(fixture.manifest.id, fixture.manifest.version)
    const task = await waitFor(fixture.manager, ref.taskId, ['ready', 'failed', 'corrupted'])
    expect(task.state).toBe('corrupted')
    expect(fixture.manager.installed()).toEqual([])
  })

  it('暂停后保留 partial，并以 HTTP Range 继续下载', async () => {
    const content = Buffer.from('x'.repeat(100))
    const fixture = setup('1.0.0', content)
    let calls = 0
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      calls++
      if (calls === 1) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(content.subarray(0, 40))
            setTimeout(() => { controller.enqueue(content.subarray(40)); controller.close() }, 100)
          },
        })
        return new Response(stream, { status: 200 })
      }
      expect((init.headers as Record<string, string>).Range).toBe('bytes=40-')
      return new Response(content.subarray(40), { status: 206 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const ref = fixture.manager.install(fixture.manifest.id, fixture.manifest.version)
    for (let i = 0; i < 50 && (fixture.manager.listTasks()[0]?.downloadedBytes ?? 0) < 40; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    fixture.manager.pause(ref.taskId)
    await new Promise((resolve) => setTimeout(resolve, 130))
    expect(fixture.manager.listTasks()[0].state).toBe('paused')
    fixture.manager.resume(ref.taskId)
    expect((await waitFor(fixture.manager, ref.taskId, ['ready', 'failed', 'corrupted'])).state).toBe('ready')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('卸载默认模型先释放 worker，可选择保留版本索引', async () => {
    const fixture = setup()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(fixture.content, { status: 200 })))
    const install = fixture.manager.install(fixture.manifest.id, fixture.manifest.version)
    await waitFor(fixture.manager, install.taskId, ['ready'])
    await fixture.manager.activate(fixture.manifest.id, fixture.manifest.version)
    const indexDir = join(fixture.root, 'indexes', fixture.manifest.id, fixture.manifest.version)
    mkdirSync(indexDir, { recursive: true }); writeFileSync(join(indexDir, 'book.json'), JSON.stringify({ entries: { e1: [1, 0], e2: [0, 1] } }))
    expect(fixture.manager.uninstallImpact(fixture.manifest.id, fixture.manifest.version)).toMatchObject({ active: true, lorebookCount: 1, entryCount: 2 })
    const uninstall = fixture.manager.uninstall({ modelId: fixture.manifest.id, version: fixture.manifest.version, removeIndexes: false })
    expect((await waitFor(fixture.manager, uninstall.taskId, ['not_installed', 'uninstall_pending'])).state).toBe('not_installed')
    expect(fixture.runtime.unload).toHaveBeenCalled()
    expect(existsSync(indexDir)).toBe(true)
    expect(fixture.manager.activeManifest()).toBeNull()
  })

  it('新版本旁路安装并切换后，可回滚到上一可用版本', async () => {
    const fixture = setup()
    const second: LocalEmbeddingModelManifest = { ...fixture.manifest, version: '1.1.0', files: fixture.manifest.files.map((file) => ({ ...file })), catalogSignature: '' }
    second.catalogSignature = sign(null, Buffer.from(manifestSigningPayload(second)), fixture.privateKey).toString('base64')
    const catalog: LocalModelCatalog = { ...fixture.catalog, models: [fixture.manifest, second], signature: '' }
    catalog.signature = sign(null, Buffer.from(catalogSigningPayload(catalog)), fixture.privateKey).toString('base64')
    const manager = new LocalModelManager({ modelsRoot: join(fixture.root, 'versions'), indexesRoot: join(fixture.root, 'version-indexes'), appVersion: '1.0.0', catalog, publicKeyPem: fixture.publicKey, runtime: fixture.runtime })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(fixture.content, { status: 200 })))
    const firstTask = manager.install(fixture.manifest.id, fixture.manifest.version)
    await waitFor(manager, firstTask.taskId, ['ready'])
    await manager.activate(fixture.manifest.id, fixture.manifest.version)
    const secondTask = manager.install(second.id, second.version)
    await waitFor(manager, secondTask.taskId, ['ready'])
    await manager.activate(second.id, second.version)
    expect(manager.activeManifest()?.version).toBe('1.1.0')
    expect((await manager.rollback(second.id)).ok).toBe(true)
    expect(manager.activeManifest()?.version).toBe('1.0.0')
  })

  it('重启恢复时不会永久停在 installing，而是可继续的 paused', () => {
    const fixture = setup()
    const task: LocalModelTaskSnapshot = { taskId: 'recover', kind: 'install', modelId: fixture.manifest.id, version: fixture.manifest.version, state: 'installing', createdAt: 1, updatedAt: 1, downloadedBytes: 1, totalBytes: 2, resumable: true }
    writeFileSync(join(fixture.root, 'models', 'tasks.json'), JSON.stringify([task]))
    const recovered = new LocalModelManager({ modelsRoot: join(fixture.root, 'models'), indexesRoot: join(fixture.root, 'indexes'), appVersion: '1.0.0', catalog: fixture.catalog, publicKeyPem: fixture.publicKey, runtime: fixture.runtime })
    expect(recovered.listTasks()[0]).toMatchObject({ state: 'paused', resumable: true })
  })

  it('索引任务以书本为 checkpoint，暂停后继续不重跑已完成的书', async () => {
    const fixture = setup()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(fixture.content, { status: 200 })))
    const install = fixture.manager.install(fixture.manifest.id, fixture.manifest.version)
    await waitFor(fixture.manager, install.taskId, ['ready'])
    await fixture.manager.activate(fixture.manifest.id, fixture.manifest.version)
    const indexed: number[] = []
    let releaseBook: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseBook = resolve })
    const plan = async () => ({
      totalBooks: 3,
      indexBook: async (_manifest: LocalEmbeddingModelManifest, index: number) => {
        indexed.push(index)
        if (index === 1) await gate
      },
    })
    const ref = fixture.manager.runIndexJob(plan)
    for (let i = 0; i < 100 && indexed.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    fixture.manager.pause(ref.taskId)
    releaseBook()
    const stateOf = () => fixture.manager.listTasks().find((item) => item.taskId === ref.taskId)!
    for (let i = 0; i < 100 && stateOf().downloadedBytes < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(stateOf().state).toBe('paused')
    expect(stateOf().downloadedBytes).toBe(2)
    // 重复调用 rebuild 只会续跑同一个任务
    expect(fixture.manager.runIndexJob(plan).taskId).toBe(ref.taskId)
    await waitFor(fixture.manager, ref.taskId, ['ready', 'failed'])
    expect(stateOf().state).toBe('ready')
    expect(indexed).toEqual([0, 1, 2])
  })

  it('新版本自检失败时保持旧版本默认可用', async () => {
    const fixture = setup()
    fixture.runtime.embed.mockImplementation(async (_root: string, manifest: LocalEmbeddingModelManifest) => {
      if (manifest.version === '1.1.0') throw new Error('向量维度不合法')
      return [Array(8).fill(0.1), Array(8).fill(0.2)]
    })
    const second: LocalEmbeddingModelManifest = { ...fixture.manifest, version: '1.1.0', files: fixture.manifest.files.map((file) => ({ ...file })), catalogSignature: '' }
    second.catalogSignature = sign(null, Buffer.from(manifestSigningPayload(second)), fixture.privateKey).toString('base64')
    const catalog: LocalModelCatalog = { ...fixture.catalog, models: [fixture.manifest, second], signature: '' }
    catalog.signature = sign(null, Buffer.from(catalogSigningPayload(catalog)), fixture.privateKey).toString('base64')
    const manager = new LocalModelManager({ modelsRoot: join(fixture.root, 'fail-models'), indexesRoot: join(fixture.root, 'fail-indexes'), appVersion: '1.0.0', catalog, publicKeyPem: fixture.publicKey, runtime: fixture.runtime })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(fixture.content, { status: 200 })))
    const first = manager.install(fixture.manifest.id, fixture.manifest.version)
    await waitFor(manager, first.taskId, ['ready'])
    await manager.activate(fixture.manifest.id, fixture.manifest.version)
    const secondTask = manager.install(second.id, second.version)
    expect((await waitFor(manager, secondTask.taskId, ['ready', 'failed', 'incompatible'])).state).toBe('incompatible')
    expect(manager.activeManifest()?.version).toBe('1.0.0')
  })

  it('embed 按设置的 batchSize 分批送入 worker', async () => {
    const fixture = setup()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(fixture.content, { status: 200 })))
    const manager = new LocalModelManager({ modelsRoot: join(fixture.root, 'batch-models'), indexesRoot: join(fixture.root, 'batch-indexes'), appVersion: '1.0.0', catalog: fixture.catalog, publicKeyPem: fixture.publicKey, runtime: fixture.runtime, batchSize: () => 3 })
    const install = manager.install(fixture.manifest.id, fixture.manifest.version)
    await waitFor(manager, install.taskId, ['ready'])
    await manager.activate(fixture.manifest.id, fixture.manifest.version)
    fixture.runtime.embed.mockClear()
    await manager.embed(['a', 'b', 'c', 'd', 'e'], 'passage')
    expect(fixture.runtime.embed.mock.calls.map((call) => (call[2] as string[]).length)).toEqual([3, 2])
  })
})

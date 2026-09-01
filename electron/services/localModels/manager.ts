import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import type {
  InstalledLocalModel,
  LocalEmbeddingModelManifest,
  LocalModelActivationResult,
  LocalModelCatalog,
  LocalModelCatalogItem,
  LocalModelCleanupResult,
  LocalModelState,
  LocalModelStorageUsage,
  LocalModelTaskRef,
  LocalModelTaskSnapshot,
  LocalModelTestResult,
  LocalModelUninstallImpact,
  LocalModelUninstallRequest,
} from '../../../shared/localModels'
import { compareModelVersions as compareVersions } from '../../../shared/localModels'
import { createLogger } from '../logger'
import { extractAndVerifyModelPackage } from './packageImport'
import { sha256File, verifyCatalog } from './manifest'
import { LocalEmbeddingRuntime } from './runtime'

const log = createLogger('local-models')

/** 索引任务的执行计划由调用方准备，便于暂停后用新的书目列表续跑。 */
export interface IndexJobPlan {
  totalBooks: number
  indexBook: (manifest: LocalEmbeddingModelManifest, bookIndex: number) => Promise<void>
}
export type IndexJobPrepare = () => Promise<IndexJobPlan>

interface RegistryFile {
  schemaVersion: 1
  installed: InstalledLocalModel[]
  active?: { modelId: string; version: string }
  previous?: { modelId: string; version: string }
}

export interface LocalModelManagerOptions {
  modelsRoot: string
  indexesRoot: string
  appVersion: string
  catalog: LocalModelCatalog
  publicKeyPem: string
  runtime?: Pick<LocalEmbeddingRuntime, 'embed' | 'unload'>
  /** 每次送入 worker 的文本条数上限；函数形式在每次调用时读取（跟随设置变更）。 */
  batchSize?: number | (() => number | undefined)
  onProgress?: (task: LocalModelTaskSnapshot) => void
  /** 文件系统替换注入点，仅用于确定性测试 Windows 瞬时占用。 */
  rename?: (source: string, destination: string) => void
  renameWait?: (milliseconds: number) => void
}

function directorySize(path: string): number {
  if (!existsSync(path)) return 0
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += directorySize(child)
    else if (entry.isFile()) total += statSync(child).size
  }
  return total
}

function readJsonFile<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return null }
}

interface RenameOptions {
  rename?: (source: string, destination: string) => void
  wait?: (milliseconds: number) => void
  maxAttempts?: number
}

const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])

function waitSynchronously(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/** Windows 上杀毒软件/索引器可能短暂阻止替换已有 JSON，限定次数重试。 */
export function renameWithRetry(source: string, destination: string, options: RenameOptions = {}): void {
  const rename = options.rename ?? renameSync
  const wait = options.wait ?? waitSynchronously
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      rename(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!TRANSIENT_RENAME_ERRORS.has(code ?? '') || attempt === maxAttempts - 1) throw error
      wait(15 * (2 ** attempt))
    }
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2))
    renameWithRetry(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export class LocalModelManager {
  private readonly manifests: LocalEmbeddingModelManifest[]
  private readonly runtime: Pick<LocalEmbeddingRuntime, 'embed' | 'unload'>
  private readonly tasks = new Map<string, LocalModelTaskSnapshot>()
  private readonly aborters = new Map<string, AbortController>()
  private lastIndexJobPrepare: IndexJobPrepare | null = null
  private registry: RegistryFile

  constructor(private readonly options: LocalModelManagerOptions) {
    mkdirSync(options.modelsRoot, { recursive: true })
    mkdirSync(options.indexesRoot, { recursive: true })
    mkdirSync(this.stagingRoot, { recursive: true })
    this.manifests = verifyCatalog(options.catalog, options.publicKeyPem)
    this.runtime = options.runtime ?? new LocalEmbeddingRuntime()
    this.registry = readJsonFile<RegistryFile>(this.registryPath) ?? { schemaVersion: 1, installed: [] }
    const storedTasks = readJsonFile<LocalModelTaskSnapshot[]>(this.tasksPath) ?? []
    for (const task of storedTasks) {
      // 索引任务的书目回调无法跨重启保留，标记失败让用户重新开始；
      // 安装/导入任务可以从磁盘 staging 续传。
      const recovered = ['queued', 'downloading', 'verifying', 'installing', 'testing'].includes(task.state)
        ? task.kind === 'index'
          ? { ...task, state: 'failed' as const, error: '应用重启后索引任务已中断，请重新开始', resumable: false, updatedAt: Date.now() }
          : { ...task, state: 'paused' as const, error: '应用重启后已暂停，可继续任务', resumable: true, updatedAt: Date.now() }
        : task
      this.tasks.set(recovered.taskId, recovered)
    }
    this.persistTasks()
    this.retryPendingUninstalls()
  }

  private get registryPath() { return join(this.options.modelsRoot, 'registry.json') }
  private get tasksPath() { return join(this.options.modelsRoot, 'tasks.json') }
  private get stagingRoot() { return join(this.options.modelsRoot, '.staging') }
  private modelDir(modelId: string, version: string) { return join(this.options.modelsRoot, modelId, version) }
  private stagingDir(task: LocalModelTaskSnapshot) { return join(this.stagingRoot, task.taskId) }

  private persistRegistry(): void { writeJsonFile(this.registryPath, this.registry) }
  private persistTasks(): void { writeJsonFile(this.tasksPath, [...this.tasks.values()]) }
  private updateTask(taskId: string, patch: Partial<LocalModelTaskSnapshot>): LocalModelTaskSnapshot {
    const current = this.requireTask(taskId)
    const next = { ...current, ...patch, updatedAt: Date.now() }
    this.tasks.set(taskId, next)
    this.persistTasks()
    this.options.onProgress?.(next)
    return next
  }
  private requireTask(taskId: string): LocalModelTaskSnapshot {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('模型任务不存在')
    return task
  }
  private findManifest(modelId: string, version: string): LocalEmbeddingModelManifest {
    const manifest = this.manifests.find((item) => item.id === modelId && item.version === version)
    if (!manifest) throw new Error('模型不在受信任目录中')
    return manifest
  }
  private installedRecord(modelId: string, version: string): InstalledLocalModel | undefined {
    return this.registry.installed.find((item) => item.manifest.id === modelId && item.manifest.version === version)
  }

  catalog(): LocalModelCatalogItem[] {
    return this.manifests.map((manifest) => {
      const installed = this.installedRecord(manifest.id, manifest.version)
      const latestTask = [...this.tasks.values()].filter((item) => item.modelId === manifest.id && item.version === manifest.version).sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const task = latestTask && !['ready', 'not_installed'].includes(latestTask.state) ? latestTask : undefined
      const updateAvailable = !!installed && this.manifests.some((item) => item.id === manifest.id && compareVersions(item.version, manifest.version) > 0)
      const state: LocalModelState = task?.state ?? (installed
        ? (this.isActive(manifest.id, manifest.version) ? 'in_use' : updateAvailable ? 'update_available' : installed.state)
        : 'not_installed')
      return { manifest, state, installedVersion: installed?.manifest.version, active: this.isActive(manifest.id, manifest.version), updateAvailable, task, error: installed?.error ?? task?.error }
    })
  }

  installed(): InstalledLocalModel[] {
    return this.registry.installed.map((item) => ({ ...item, active: this.isActive(item.manifest.id, item.manifest.version), state: this.isActive(item.manifest.id, item.manifest.version) ? 'in_use' : item.state }))
  }

  listTasks(): LocalModelTaskSnapshot[] { return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt) }

  install(modelId: string, version: string): LocalModelTaskRef {
    const manifest = this.findManifest(modelId, version)
    if (this.installedRecord(modelId, version)) throw new Error('该模型版本已安装')
    // 只复用安装/导入/卸载类任务；索引任务不阻塞新版本安装
    const running = [...this.tasks.values()].find((task) => task.modelId === modelId && task.kind !== 'index' && !['failed', 'corrupted', 'incompatible', 'ready', 'not_installed'].includes(task.state))
    if (running) return { taskId: running.taskId }
    this.preflight(manifest)
    const task = this.createTask('install', manifest)
    void this.runOnlineInstall(task.taskId, manifest)
    return { taskId: task.taskId }
  }

  importPackage(packagePath: string): LocalModelTaskRef {
    const placeholder: LocalEmbeddingModelManifest = {
      schemaVersion: 1, id: 'offline-package', version: '0.0.0', displayName: '离线模型包', description: '正在读取', languages: ['unknown'],
      license: { name: 'unknown', url: 'https://invalid.local' }, runtime: 'onnx', architecture: 'unknown', dimensions: 8, maxTokens: 8,
      dtype: 'q8', pooling: 'mean', normalize: true, minimumAppVersion: '0.0.0', recommendedMemoryMb: 1, installedSize: 1,
      files: [{ path: 'placeholder.json', size: 1, sha256: '0'.repeat(64), urls: [] }], catalogSignature: 'pending',
    }
    const task = this.createTask('import', placeholder)
    void this.runPackageImport(task.taskId, packagePath)
    return { taskId: task.taskId }
  }

  pause(taskId: string): void {
    const task = this.requireTask(taskId)
    const pausable = task.kind === 'index' ? ['queued', 'installing'] : ['queued', 'downloading']
    if (!pausable.includes(task.state)) throw new Error('当前任务不能暂停')
    this.aborters.get(taskId)?.abort()
    this.updateTask(taskId, { state: 'paused', resumable: true })
  }

  resume(taskId: string): void {
    const task = this.requireTask(taskId)
    if (!task.resumable || !['paused', 'failed'].includes(task.state)) throw new Error('当前任务不能继续')
    if (task.kind === 'index') {
      const prepare = this.lastIndexJobPrepare
      if (!prepare) throw new Error('应用重启后索引任务无法续跑，请重新开始')
      this.runIndexLoop(taskId, prepare, task.downloadedBytes)
      return
    }
    const manifest = this.findManifest(task.modelId, task.version)
    void this.runOnlineInstall(taskId, manifest)
  }

  cancel(taskId: string): void {
    const task = this.requireTask(taskId)
    this.aborters.get(taskId)?.abort()
    rmSync(this.stagingDir(task), { recursive: true, force: true })
    if (task.kind === 'index') {
      this.updateTask(taskId, { state: 'failed', error: '索引任务已取消', resumable: false })
      return
    }
    this.updateTask(taskId, { state: 'not_installed', resumable: false, error: undefined })
  }

  async test(modelId: string, version: string): Promise<LocalModelTestResult> {
    const record = this.installedRecord(modelId, version)
    if (!record) return { ok: false, error: '模型未安装' }
    return this.selfTest(record.manifest)
  }

  async activate(modelId: string, version: string): Promise<LocalModelActivationResult> {
    const record = this.installedRecord(modelId, version)
    if (!record || !['ready', 'in_use'].includes(record.state)) return { ok: false, error: '模型尚未就绪' }
    const test = await this.selfTest(record.manifest)
    if (!test.ok) return { ok: false, error: test.error }
    const previous = this.registry.active
    this.registry.previous = previous
    this.registry.active = { modelId, version }
    this.persistRegistry()
    writeJsonFile(join(this.options.modelsRoot, modelId, 'current.json'), { schemaVersion: 1, version, updatedAt: Date.now() })
    return { ok: true, active: this.registry.active, previous }
  }

  async rollback(modelId: string): Promise<LocalModelActivationResult> {
    const previous = this.registry.previous
    if (!previous || previous.modelId !== modelId || !this.installedRecord(previous.modelId, previous.version)) return { ok: false, error: '没有可回滚版本' }
    return this.activate(previous.modelId, previous.version)
  }

  uninstall(request: LocalModelUninstallRequest): LocalModelTaskRef {
    const record = this.installedRecord(request.modelId, request.version)
    if (!record) throw new Error('模型未安装')
    const task = this.createTask('uninstall', record.manifest)
    void this.runUninstall(task.taskId, request)
    return { taskId: task.taskId }
  }

  uninstallImpact(modelId: string, version: string): LocalModelUninstallImpact {
    const indexRoot = join(this.options.indexesRoot, modelId, version)
    let lorebookCount = 0
    let entryCount = 0
    if (existsSync(indexRoot)) {
      for (const entry of readdirSync(indexRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        lorebookCount++
        const index = readJsonFile<{ entries?: Record<string, unknown> }>(join(indexRoot, entry.name))
        entryCount += Object.keys(index?.entries ?? {}).length
      }
    }
    return { active: this.isActive(modelId, version), modelBytes: directorySize(this.modelDir(modelId, version)), indexBytes: directorySize(indexRoot), lorebookCount, entryCount }
  }

  storageUsage(): LocalModelStorageUsage {
    const modelBytes = Math.max(0, directorySize(this.options.modelsRoot) - directorySize(this.stagingRoot))
    const indexBytes = directorySize(this.options.indexesRoot)
    const stagingBytes = directorySize(this.stagingRoot)
    return {
      modelBytes,
      indexBytes,
      stagingBytes,
      totalBytes: modelBytes + indexBytes + stagingBytes,
      modelRoot: this.options.modelsRoot,
      indexRoot: this.options.indexesRoot,
    }
  }

  cleanup(): LocalModelCleanupResult {
    try {
      const before = this.storageUsage().totalBytes
      rmSync(this.stagingRoot, { recursive: true, force: true })
      mkdirSync(this.stagingRoot, { recursive: true })
      const after = this.storageUsage().totalBytes
      return { ok: true, freedBytes: Math.max(0, before - after) }
    } catch (error) {
      return { ok: false, freedBytes: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }

  activeManifest(): LocalEmbeddingModelManifest | null {
    const active = this.registry.active
    return active ? this.installedRecord(active.modelId, active.version)?.manifest ?? null : null
  }

  private resolveBatchSize(): number {
    const value = typeof this.options.batchSize === 'function' ? this.options.batchSize() : this.options.batchSize
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 8
  }

  async embed(texts: string[], inputKind: 'query' | 'passage'): Promise<number[][]> {
    const manifest = this.activeManifest()
    if (!manifest) throw new Error('没有已启用的本地向量模型')
    const batchSize = this.resolveBatchSize()
    const vectors: number[][] = []
    for (let index = 0; index < texts.length; index += batchSize) {
      vectors.push(...await this.runtime.embed(this.options.modelsRoot, manifest, texts.slice(index, index + batchSize), inputKind))
    }
    return vectors
  }

  async shutdown(): Promise<void> { await this.runtime.unload() }

  /** 启动（或复用进行中的）全局索引任务；已有未完成索引任务时直接返回其引用。 */
  runIndexJob(prepare: IndexJobPrepare): LocalModelTaskRef {
    const existing = [...this.tasks.values()].find((task) => task.kind === 'index' && ['queued', 'installing', 'paused'].includes(task.state))
    if (existing) {
      if (existing.state === 'paused') this.runIndexLoop(existing.taskId, prepare, existing.downloadedBytes)
      return { taskId: existing.taskId }
    }
    const manifest = this.activeManifest()
    if (!manifest) throw new Error('请先启用本地模型')
    const task = this.createTask('index', manifest)
    this.updateTask(task.taskId, { state: 'queued', totalBytes: 0, downloadedBytes: 0 })
    this.runIndexLoop(task.taskId, prepare, 0)
    return { taskId: task.taskId }
  }

  /**
   * 索引循环：以"已完成的书本数"作为 checkpoint（task.downloadedBytes）。
   * 暂停后从 checkpoint 继续；书本集合在暂停期间发生变化时，可能重复或跳过
   * 个别书，但索引写入是幂等的，下一次重建会收敛。
   */
  private runIndexLoop(taskId: string, prepare: IndexJobPrepare, startFrom: number): void {
    this.lastIndexJobPrepare = prepare
    void (async () => {
      const controller = new AbortController()
      this.aborters.set(taskId, controller)
      try {
        const manifest = this.activeManifest()
        if (!manifest) throw new Error('请先启用本地模型')
        const plan = await prepare()
        this.updateTask(taskId, { state: 'installing', totalBytes: plan.totalBooks, error: undefined, resumable: true })
        for (let index = startFrom; index < plan.totalBooks; index++) {
          if (controller.signal.aborted) throw new DOMException('已暂停', 'AbortError')
          await plan.indexBook(manifest, index)
          this.updateTask(taskId, { downloadedBytes: index + 1 })
        }
        this.updateTask(taskId, { state: 'ready', resumable: false })
      } catch (error) {
        const current = this.requireTask(taskId)
        if (controller.signal.aborted && ['paused', 'failed'].includes(current.state)) return
        this.updateTask(taskId, { state: 'failed', error: error instanceof Error ? error.message : String(error), resumable: false })
        log.warn('后台索引任务失败', { taskId, error: current.error })
      } finally {
        if (this.aborters.get(taskId) === controller) this.aborters.delete(taskId)
      }
    })()
  }

  private isActive(modelId: string, version: string): boolean {
    return this.registry.active?.modelId === modelId && this.registry.active.version === version
  }

  private createTask(kind: LocalModelTaskSnapshot['kind'], manifest: LocalEmbeddingModelManifest): LocalModelTaskSnapshot {
    const now = Date.now()
    const task: LocalModelTaskSnapshot = {
      taskId: randomUUID(), kind, modelId: manifest.id, version: manifest.version, state: 'queued', createdAt: now, updatedAt: now,
      downloadedBytes: 0, totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0), resumable: kind === 'install',
    }
    this.tasks.set(task.taskId, task)
    this.persistTasks()
    this.options.onProgress?.(task)
    return task
  }

  private preflight(manifest: LocalEmbeddingModelManifest): void {
    if (compareVersions(this.options.appVersion, manifest.minimumAppVersion) < 0) throw new Error(`应用版本过低，需要 ${manifest.minimumAppVersion} 或更高版本`)
    const disk = statfsSync(this.options.modelsRoot)
    const available = disk.bavail * disk.bsize
    const needed = Math.max(manifest.installedSize, manifest.files.reduce((sum, file) => sum + file.size, 0)) * 1.1
    if (available < needed) throw new Error('可用磁盘空间不足')
  }

  private async runOnlineInstall(taskId: string, manifest: LocalEmbeddingModelManifest): Promise<void> {
    const controller = new AbortController()
    this.aborters.set(taskId, controller)
    try {
      this.preflight(manifest)
      const task = this.requireTask(taskId)
      const staging = this.stagingDir(task)
      mkdirSync(staging, { recursive: true })
      this.updateTask(taskId, { state: 'downloading', error: undefined })
      for (const file of manifest.files) await this.downloadFile(taskId, staging, manifest, file, controller.signal)
      this.updateTask(taskId, { state: 'verifying' })
      await this.verifyFiles(staging, manifest)
      writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2))
      this.updateTask(taskId, { state: 'installing' })
      const destination = this.modelDir(manifest.id, manifest.version)
      mkdirSync(dirname(destination), { recursive: true })
      if (existsSync(destination)) rmSync(destination, { recursive: true, force: true })
      renameWithRetry(staging, destination, { rename: this.options.rename, wait: this.options.renameWait, maxAttempts: 8 })
      this.upsertInstalled(manifest, 'testing')
      this.updateTask(taskId, { state: 'testing' })
      const tested = await this.selfTest(manifest)
      if (!tested.ok) throw new Error(tested.error ?? '模型自检失败')
      this.upsertInstalled(manifest, 'ready', { lastTestedAt: Date.now(), error: undefined })
      this.updateTask(taskId, { state: 'ready', downloadedBytes: this.requireTask(taskId).totalBytes, resumable: false })
    } catch (error) {
      if (controller.signal.aborted && this.requireTask(taskId).state === 'paused') return
      const message = error instanceof Error ? error.message : String(error)
      const corrupted = /hash|大小|签名/.test(message)
      const incompatible = /worker|ONNX|向量维度|自检|运行时/i.test(message)
      const state: LocalModelState = corrupted ? 'corrupted' : incompatible ? 'incompatible' : 'failed'
      if (this.installedRecord(manifest.id, manifest.version)) this.upsertInstalled(manifest, state, { error: message })
      this.updateTask(taskId, { state, error: message, resumable: !corrupted && !incompatible })
      log.warn('本地模型安装失败', { modelId: manifest.id, version: manifest.version, error: message })
    } finally {
      if (this.aborters.get(taskId) === controller) this.aborters.delete(taskId)
    }
  }

  private async downloadFile(taskId: string, staging: string, manifest: LocalEmbeddingModelManifest, file: LocalEmbeddingModelManifest['files'][number], signal: AbortSignal): Promise<void> {
    if (file.urls.length === 0) throw new Error(`模型文件没有在线下载源: ${file.path}`)
    const destination = join(staging, ...file.path.split('/'))
    const partial = `${destination}.part`
    mkdirSync(dirname(destination), { recursive: true })
    if (existsSync(destination)) {
      const complete = statSync(destination).size === file.size && await sha256File(destination) === file.sha256
      if (complete) {
        const completedBytes = this.completedBytes(staging, manifest, file.path) + file.size
        this.updateTask(taskId, {
          currentFile: file.path,
          downloadedBytes: Math.min(this.requireTask(taskId).totalBytes, completedBytes),
          speedBytesPerSecond: undefined,
        })
        return
      }
      rmSync(destination, { force: true })
    }
    let lastError: unknown
    for (const url of file.urls) {
      try {
        let offset = existsSync(partial) ? statSync(partial).size : 0
        if (offset > file.size) { rmSync(partial, { force: true }); offset = 0 }
        const response = await fetch(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal })
        if (!(response.ok || response.status === 206) || !response.body) throw new Error(`下载失败 HTTP ${response.status}`)
        if (offset && response.status !== 206) { rmSync(partial, { force: true }); offset = 0 }
        const stream = createWriteStream(partial, { flags: offset ? 'a' : 'w' })
        let completed = false
        let downloaded = offset
        const startedAt = Date.now()
        let lastProgressAt = 0
        try {
          for await (const chunk of Readable.fromWeb(response.body as never)) {
            if (signal.aborted) throw new DOMException('已暂停', 'AbortError')
            if (!stream.write(chunk)) await new Promise<void>((resolve) => stream.once('drain', () => resolve()))
            downloaded += (chunk as Buffer).length
            const now = Date.now()
            if (now - lastProgressAt >= 250 || downloaded >= file.size) {
              const otherFiles = this.completedBytes(staging, manifest, file.path)
              this.updateTask(taskId, {
                currentFile: file.path,
                downloadedBytes: Math.min(this.requireTask(taskId).totalBytes, otherFiles + downloaded),
                speedBytesPerSecond: Math.round((downloaded - offset) / Math.max(1, (now - startedAt) / 1000)),
              })
              lastProgressAt = now
            }
          }
          await new Promise<void>((resolve, reject) => stream.end((error?: Error | null) => error ? reject(error) : resolve()))
          completed = true
        } finally {
          if (!completed) stream.destroy()
        }
        renameWithRetry(partial, destination, { rename: this.options.rename, wait: this.options.renameWait })
        return
      } catch (error) {
        lastError = error
        if (signal.aborted) throw error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`所有下载镜像均失败: ${file.path}`)
  }

  private completedBytes(staging: string, manifest: LocalEmbeddingModelManifest, currentPath: string): number {
    return manifest.files.filter((file) => file.path !== currentPath).reduce((sum, file) => sum + (existsSync(join(staging, ...file.path.split('/'))) ? file.size : 0), 0)
  }

  private async verifyFiles(root: string, manifest: LocalEmbeddingModelManifest): Promise<void> {
    for (const file of manifest.files) {
      const path = join(root, ...file.path.split('/'))
      if (!existsSync(path) || statSync(path).size !== file.size) throw new Error(`模型文件大小不匹配: ${file.path}`)
      if (await sha256File(path) !== file.sha256) throw new Error(`模型文件 hash 不匹配: ${file.path}`)
    }
  }

  private async runPackageImport(taskId: string, packagePath: string): Promise<void> {
    const task = this.requireTask(taskId)
    const staging = this.stagingDir(task)
    try {
      mkdirSync(staging, { recursive: true })
      this.updateTask(taskId, { state: 'verifying' })
      const manifest = await extractAndVerifyModelPackage(packagePath, staging, this.options.publicKeyPem)
      if (compareVersions(this.options.appVersion, manifest.minimumAppVersion) < 0) throw new Error(`应用版本过低，需要 ${manifest.minimumAppVersion}`)
      this.updateTask(taskId, { modelId: manifest.id, version: manifest.version, totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0), state: 'installing' })
      const destination = this.modelDir(manifest.id, manifest.version)
      mkdirSync(dirname(destination), { recursive: true })
      if (existsSync(destination)) throw new Error('该模型版本已经安装')
      renameWithRetry(staging, destination, { rename: this.options.rename, wait: this.options.renameWait, maxAttempts: 8 })
      this.upsertInstalled(manifest, 'testing')
      this.updateTask(taskId, { state: 'testing' })
      const result = await this.selfTest(manifest)
      if (!result.ok) throw new Error(result.error ?? '模型自检失败')
      this.upsertInstalled(manifest, 'ready', { lastTestedAt: Date.now() })
      this.updateTask(taskId, { state: 'ready', downloadedBytes: manifest.installedSize, resumable: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      rmSync(staging, { recursive: true, force: true })
      this.updateTask(taskId, { state: /hash|签名|路径|压缩比/.test(message) ? 'corrupted' : 'failed', error: message, resumable: false })
    }
  }

  private async selfTest(manifest: LocalEmbeddingModelManifest): Promise<LocalModelTestResult> {
    const started = Date.now()
    try {
      const vectors = await this.runtime.embed(this.options.modelsRoot, manifest, ['轻语世界书检索测试', '语义索引测试'], 'query')
      if (vectors.length !== 2 || vectors.some((vector) => vector.length !== manifest.dimensions || vector.some((value) => !Number.isFinite(value)))) throw new Error('向量维度或数值不合法')
      return { ok: true, dimensions: manifest.dimensions, elapsedMs: Date.now() - started }
    } catch (error) {
      return { ok: false, elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private upsertInstalled(manifest: LocalEmbeddingModelManifest, state: LocalModelState, patch: Partial<InstalledLocalModel> = {}): void {
    const index = this.registry.installed.findIndex((item) => item.manifest.id === manifest.id && item.manifest.version === manifest.version)
    const previous = index >= 0 ? this.registry.installed[index] : undefined
    const next: InstalledLocalModel = { ...previous, manifest, state, active: this.isActive(manifest.id, manifest.version), installedAt: previous?.installedAt ?? Date.now(), ...patch }
    if (index >= 0) this.registry.installed[index] = next
    else this.registry.installed.push(next)
    this.persistRegistry()
  }

  private async runUninstall(taskId: string, request: LocalModelUninstallRequest): Promise<void> {
    try {
      this.updateTask(taskId, { state: 'uninstalling' })
      if (this.isActive(request.modelId, request.version)) {
        await this.runtime.unload()
        this.registry.active = undefined
        rmSync(join(this.options.modelsRoot, request.modelId, 'current.json'), { force: true })
      }
      rmSync(this.modelDir(request.modelId, request.version), { recursive: true, force: false })
      if (request.removeIndexes) rmSync(join(this.options.indexesRoot, request.modelId, request.version), { recursive: true, force: true })
      this.registry.installed = this.registry.installed.filter((item) => !(item.manifest.id === request.modelId && item.manifest.version === request.version))
      this.persistRegistry()
      this.updateTask(taskId, { state: 'not_installed', resumable: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.upsertInstalled(this.requireTaskManifest(taskId), 'uninstall_pending', { error: message, pendingRemoveIndexes: request.removeIndexes })
      this.updateTask(taskId, { state: 'uninstall_pending', error: message, resumable: true })
    }
  }

  private requireTaskManifest(taskId: string): LocalEmbeddingModelManifest {
    const task = this.requireTask(taskId)
    return this.installedRecord(task.modelId, task.version)?.manifest ?? this.findManifest(task.modelId, task.version)
  }

  private retryPendingUninstalls(): void {
    for (const item of this.registry.installed.filter((record) => record.state === 'uninstall_pending')) {
      const task = this.createTask('uninstall', item.manifest)
      void this.runUninstall(task.taskId, { modelId: item.manifest.id, version: item.manifest.version, removeIndexes: item.pendingRemoveIndexes ?? true })
    }
  }
}

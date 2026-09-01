export type LocalModelState =
  | 'not_installed'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'installing'
  | 'testing'
  | 'ready'
  | 'update_available'
  | 'in_use'
  | 'uninstalling'
  | 'uninstall_pending'
  | 'failed'
  | 'corrupted'
  | 'incompatible'

export type LocalModelTaskKind = 'install' | 'import' | 'uninstall' | 'cleanup' | 'index'

export interface LocalEmbeddingModelFile {
  path: string
  size: number
  sha256: string
  urls: string[]
}

export interface LocalEmbeddingModelManifest {
  schemaVersion: 1
  id: string
  version: string
  displayName: string
  description: string
  languages: string[]
  license: { name: string; url: string }
  runtime: 'onnx'
  architecture: string
  dimensions: number
  maxTokens: number
  dtype: 'q8' | 'q4' | 'fp16' | 'fp32'
  pooling: 'mean' | 'cls'
  normalize: boolean
  queryPrefix?: string
  passagePrefix?: string
  minimumAppVersion: string
  recommendedMemoryMb: number
  installedSize: number
  files: LocalEmbeddingModelFile[]
  /** Ed25519，签名内容为移除本字段后的 canonical JSON。 */
  catalogSignature: string
}

export interface LocalModelCatalog {
  schemaVersion: 1
  generatedAt: string
  models: LocalEmbeddingModelManifest[]
  /** Ed25519，签名内容为移除本字段后的 canonical JSON。 */
  signature: string
}

export interface LocalModelCatalogItem {
  manifest: LocalEmbeddingModelManifest
  state: LocalModelState
  installedVersion?: string
  active?: boolean
  /** 目录中存在同 id 更新版本（当前条目可能仍是 in_use，用独立字段避免掩盖默认模型的可更新状态）。 */
  updateAvailable?: boolean
  task?: LocalModelTaskSnapshot
  error?: string
}

export interface InstalledLocalModel {
  manifest: LocalEmbeddingModelManifest
  state: LocalModelState
  active: boolean
  installedAt: number
  lastTestedAt?: number
  error?: string
  pendingRemoveIndexes?: boolean
}

export interface LocalModelTaskRef {
  taskId: string
}

export interface LocalModelTaskSnapshot extends LocalModelTaskRef {
  kind: LocalModelTaskKind
  modelId: string
  version: string
  state: LocalModelState
  createdAt: number
  updatedAt: number
  downloadedBytes: number
  totalBytes: number
  currentFile?: string
  speedBytesPerSecond?: number
  error?: string
  resumable?: boolean
}

export interface LocalModelTestResult {
  ok: boolean
  dimensions?: number
  elapsedMs?: number
  error?: string
}

export interface LocalModelActivationResult {
  ok: boolean
  active?: { modelId: string; version: string }
  previous?: { modelId: string; version: string }
  error?: string
}

export interface LocalModelUninstallRequest {
  modelId: string
  version: string
  removeIndexes: boolean
}

export interface LocalModelUninstallImpact {
  active: boolean
  modelBytes: number
  indexBytes: number
  lorebookCount: number
  entryCount: number
}

export interface LocalModelStorageUsage {
  modelBytes: number
  indexBytes: number
  stagingBytes: number
  totalBytes: number
  /** 开发环境为项目目录，打包环境为应用安装目录。 */
  modelRoot?: string
  /** 索引属于用户数据，不随模型安装位置移动。 */
  indexRoot?: string
}

export interface LocalModelCleanupResult {
  ok: boolean
  freedBytes: number
  error?: string
}

export interface LocalModelTaskEvent {
  task: LocalModelTaskSnapshot
}

/** 模型版本比较（semver 前三段数字；忽略预发布段细节，只保证单调可比）。 */
export function compareModelVersions(a: string, b: string): number {
  const aa = a.split(/[.-]/).slice(0, 3).map(Number)
  const bb = b.split(/[.-]/).slice(0, 3).map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (aa[i] || 0) - (bb[i] || 0)
    if (diff) return diff
  }
  return 0
}

export interface LocalModelAPI {
  catalog(): Promise<LocalModelCatalogItem[]>
  installed(): Promise<InstalledLocalModel[]>
  tasks(): Promise<LocalModelTaskSnapshot[]>
  install(modelId: string, version: string): Promise<LocalModelTaskRef>
  importPackage(): Promise<LocalModelTaskRef | null>
  pause(taskId: string): Promise<void>
  resume(taskId: string): Promise<void>
  cancel(taskId: string): Promise<void>
  test(modelId: string, version: string): Promise<LocalModelTestResult>
  activate(modelId: string, version: string): Promise<LocalModelActivationResult>
  rollback(modelId: string): Promise<LocalModelActivationResult>
  uninstallImpact(modelId: string, version: string): Promise<LocalModelUninstallImpact>
  uninstall(request: LocalModelUninstallRequest): Promise<LocalModelTaskRef>
  storageUsage(): Promise<LocalModelStorageUsage>
  cleanup(): Promise<LocalModelCleanupResult>
  rebuildIndexes(): Promise<LocalModelTaskRef>
  onProgress(listener: (event: LocalModelTaskEvent) => void): () => void
}

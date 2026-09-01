import { createHash, verify } from 'node:crypto'
import { isAbsolute, normalize, posix } from 'node:path'
import type { LocalEmbeddingModelManifest, LocalModelCatalog } from '../../../shared/localModels'

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SHA256_RE = /^[a-f0-9]{64}$/
const SAFE_EXTENSIONS = new Set(['.json', '.onnx', '.txt', '.model', '.vocab', '.merges'])
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_INSTALLED_BYTES = 4 * 1024 * 1024 * 1024

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

export function isSafeModelRelativePath(input: string): boolean {
  if (!input || input.includes('\\') || input.includes('\0') || isAbsolute(input)) return false
  const normalized = posix.normalize(input)
  if (normalized !== input || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return false
  const ext = posix.extname(normalized).toLowerCase()
  return SAFE_EXTENSIONS.has(ext)
}

export function validateManifest(input: unknown): LocalEmbeddingModelManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('模型清单必须是对象')
  const m = input as LocalEmbeddingModelManifest
  if (m.schemaVersion !== 1) throw new Error('不支持的模型清单版本')
  if (!ID_RE.test(m.id)) throw new Error('模型 id 不合法')
  if (!VERSION_RE.test(m.version)) throw new Error('模型版本必须使用 semver')
  if (!m.displayName?.trim() || !m.description?.trim()) throw new Error('模型名称或说明为空')
  if (!Array.isArray(m.languages) || m.languages.length === 0 || m.languages.some((v) => typeof v !== 'string' || !v.trim())) throw new Error('模型语言列表不合法')
  if (!m.license?.name?.trim() || !/^https:\/\//i.test(m.license.url)) throw new Error('模型许可证信息不完整')
  if (m.runtime !== 'onnx') throw new Error('仅支持 ONNX 数据模型')
  if (!Number.isInteger(m.dimensions) || m.dimensions < 8 || m.dimensions > 8192) throw new Error('向量维度不合法')
  if (!Number.isInteger(m.maxTokens) || m.maxTokens < 8 || m.maxTokens > 131072) throw new Error('最大 token 数不合法')
  if (!['q8', 'q4', 'fp16', 'fp32'].includes(m.dtype)) throw new Error('模型精度不受支持')
  if (!['mean', 'cls'].includes(m.pooling)) throw new Error('pooling 不受支持')
  if (!VERSION_RE.test(m.minimumAppVersion)) throw new Error('最低应用版本不合法')
  if (!Number.isInteger(m.recommendedMemoryMb) || m.recommendedMemoryMb <= 0) throw new Error('建议内存不合法')
  if (!Number.isSafeInteger(m.installedSize) || m.installedSize <= 0 || m.installedSize > MAX_INSTALLED_BYTES) throw new Error('安装体积不合法')
  if (!Array.isArray(m.files) || m.files.length === 0 || m.files.length > 64) throw new Error('模型文件列表不合法')
  const paths = new Set<string>()
  let total = 0
  for (const file of m.files) {
    if (!isSafeModelRelativePath(file.path)) throw new Error(`模型文件路径不安全: ${file.path}`)
    const normalizedCase = normalize(file.path).toLowerCase()
    if (paths.has(normalizedCase)) throw new Error(`模型文件路径重复: ${file.path}`)
    paths.add(normalizedCase)
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE_BYTES) throw new Error(`模型文件大小不合法: ${file.path}`)
    total += file.size
    if (!SHA256_RE.test(file.sha256)) throw new Error(`模型文件 hash 不合法: ${file.path}`)
    if (!Array.isArray(file.urls) || file.urls.some((url) => !/^https:\/\//i.test(url))) throw new Error(`模型下载地址不安全: ${file.path}`)
  }
  if (total > m.installedSize) throw new Error('文件总大小超过清单安装体积')
  if (typeof m.catalogSignature !== 'string' || !m.catalogSignature) throw new Error('模型清单缺少签名')
  return m
}

export function manifestSigningPayload(manifest: LocalEmbeddingModelManifest): string {
  const unsigned: Partial<LocalEmbeddingModelManifest> = { ...manifest }
  delete unsigned.catalogSignature
  return canonicalJson(unsigned)
}

export function verifyManifestSignature(manifest: LocalEmbeddingModelManifest, publicKeyPem: string): boolean {
  try {
    return verify(null, Buffer.from(manifestSigningPayload(manifest)), publicKeyPem, Buffer.from(manifest.catalogSignature, 'base64'))
  } catch {
    return false
  }
}

export function catalogSigningPayload(catalog: LocalModelCatalog): string {
  const unsigned: Partial<LocalModelCatalog> = { ...catalog }
  delete unsigned.signature
  return canonicalJson(unsigned)
}

export function verifyCatalog(catalog: LocalModelCatalog, publicKeyPem: string): LocalEmbeddingModelManifest[] {
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.models) || !catalog.generatedAt) throw new Error('模型目录格式不合法')
  if (!verify(null, Buffer.from(catalogSigningPayload(catalog)), publicKeyPem, Buffer.from(catalog.signature, 'base64'))) throw new Error('模型目录签名无效')
  const ids = new Set<string>()
  return catalog.models.map((item) => {
    const manifest = validateManifest(item)
    if (!verifyManifestSignature(manifest, publicKeyPem)) throw new Error(`模型清单签名无效: ${manifest.id}@${manifest.version}`)
    const key = `${manifest.id}@${manifest.version}`
    if (ids.has(key)) throw new Error(`模型目录存在重复版本: ${key}`)
    ids.add(key)
    return manifest
  })
}

export async function sha256File(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs')
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

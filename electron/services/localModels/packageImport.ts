import AdmZip from 'adm-zip'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { LocalEmbeddingModelManifest } from '../../../shared/localModels'
import { isSafeModelRelativePath, sha256File, validateManifest, verifyManifestSignature } from './manifest'

const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024
const MAX_ENTRIES = 80
const MAX_COMPRESSION_RATIO = 100

function isSymlink(entry: AdmZip.IZipEntry): boolean {
  const unixMode = (entry.header.attr >>> 16) & 0xffff
  return (unixMode & 0xf000) === 0xa000
}

function safeDestination(root: string, relative: string): string {
  const destination = resolve(root, ...relative.split('/'))
  const prefix = resolve(root) + sep
  if (!destination.startsWith(prefix)) throw new Error(`离线包路径越界: ${relative}`)
  return destination
}

export async function extractAndVerifyModelPackage(
  packagePath: string,
  stagingDir: string,
  publicKeyPem: string,
): Promise<LocalEmbeddingModelManifest> {
  const zip = new AdmZip(packagePath)
  const entries = zip.getEntries()
  if (entries.length === 0 || entries.length > MAX_ENTRIES) throw new Error('离线包文件数量异常')
  const names = new Set<string>()
  let expanded = 0
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/')
    const folded = name.toLowerCase()
    if (names.has(folded)) throw new Error(`离线包包含重复路径: ${name}`)
    names.add(folded)
    if (name.startsWith('/') || name.includes('../') || name.includes('\0')) throw new Error(`离线包包含不安全路径: ${name}`)
    if (isSymlink(entry)) throw new Error(`离线包不允许符号链接: ${name}`)
    if (!entry.isDirectory) {
      expanded += entry.header.size
      if (expanded > MAX_PACKAGE_BYTES) throw new Error('离线包解压后体积超过上限')
      const compressed = Math.max(1, entry.header.compressedSize)
      if (entry.header.size / compressed > MAX_COMPRESSION_RATIO) throw new Error(`离线包压缩比异常: ${name}`)
    }
  }
  const manifestEntry = entries.find((entry) => entry.entryName.replace(/\\/g, '/') === 'manifest.json')
  const signatureEntry = entries.find((entry) => entry.entryName.replace(/\\/g, '/') === 'signature.json')
  if (!manifestEntry || !signatureEntry) throw new Error('离线包缺少 manifest.json 或 signature.json')
  const manifestData = zip.readFile(manifestEntry)
  const signatureData = zip.readFile(signatureEntry)
  if (!manifestData?.length || !signatureData?.length) throw new Error(`离线包清单或签名文件为空（manifest=${manifestData?.length ?? -1}/${manifestEntry.header.size}, signature=${signatureData?.length ?? -1}/${signatureEntry.header.size}）`)
  const manifest = validateManifest(JSON.parse(manifestData.toString('utf8')))
  const signature = JSON.parse(signatureData.toString('utf8')) as { signature?: string }
  if (!signature.signature || signature.signature !== manifest.catalogSignature) throw new Error('离线包签名文件与清单不一致')
  if (!verifyManifestSignature(manifest, publicKeyPem)) throw new Error('离线模型包签名无效')

  const allowed = new Set(manifest.files.map((file) => `files/${file.path}`))
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/')
    if (entry.isDirectory || name === 'manifest.json' || name === 'signature.json') continue
    if (!allowed.has(name)) throw new Error(`离线包包含清单外文件: ${name}`)
  }
  for (const file of manifest.files) {
    if (!isSafeModelRelativePath(file.path)) throw new Error(`模型文件路径不安全: ${file.path}`)
    const entry = entries.find((candidate) => candidate.entryName.replace(/\\/g, '/') === `files/${file.path}`)
    if (!entry) throw new Error(`离线包缺少模型文件: ${file.path}`)
    if (entry.header.size !== file.size) throw new Error(`模型文件大小不匹配: ${file.path}`)
    const destination = safeDestination(stagingDir, file.path)
    mkdirSync(dirname(destination), { recursive: true })
    const data = zip.readFile(entry)
    if (!data || data.length !== file.size) throw new Error(`模型文件读取不完整: ${file.path}`)
    writeFileSync(destination, data, { flag: 'wx' })
    const hash = await sha256File(destination)
    if (hash !== file.sha256) throw new Error(`模型文件 hash 不匹配: ${file.path}`)
  }
  writeFileSync(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  return manifest
}

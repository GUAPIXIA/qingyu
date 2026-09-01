// @vitest-environment node
import AdmZip from 'adm-zip'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { LocalEmbeddingModelManifest } from '../../../shared/localModels'
import { manifestSigningPayload } from '../localModels/manifest'
import { extractAndVerifyModelPackage } from '../localModels/packageImport'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function makePackage(extra?: (zip: AdmZip) => void) {
  const root = mkdtempSync(join(tmpdir(), 'qingyu-qymodel-')); roots.push(root)
  const data = Buffer.from('{}')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const manifest: LocalEmbeddingModelManifest = {
    schemaVersion: 1, id: 'offline-test', version: '1.0.0', displayName: '离线测试', description: '测试包', languages: ['zh'],
    license: { name: 'MIT', url: 'https://example.com/license' }, runtime: 'onnx', architecture: 'bert', dimensions: 384, maxTokens: 512,
    dtype: 'q8', pooling: 'mean', normalize: true, minimumAppVersion: '0.1.0', recommendedMemoryMb: 128, installedSize: data.length,
    files: [{ path: 'config.json', size: data.length, sha256: createHash('sha256').update(data).digest('hex'), urls: [] }], catalogSignature: '',
  }
  manifest.catalogSignature = sign(null, Buffer.from(manifestSigningPayload(manifest)), privateKey).toString('base64')
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile('signature.json', Buffer.from(JSON.stringify({ signature: manifest.catalogSignature })))
  zip.addFile('files/config.json', data)
  extra?.(zip)
  const packagePath = join(root, 'model.qymodel'); zip.writeZip(packagePath)
  return { root, packagePath, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), manifest }
}

describe('.qymodel 安全导入', () => {
  it('有效包经签名、大小和 hash 校验后提取', async () => {
    const fixture = makePackage()
    const staging = join(fixture.root, 'staging')
    const manifest = await extractAndVerifyModelPackage(fixture.packagePath, staging, fixture.publicKey)
    expect(manifest.id).toBe('offline-test')
    expect(readFileSync(join(staging, 'config.json'), 'utf8')).toBe('{}')
  })

  it('拒绝清单外文件', async () => {
    const fixture = makePackage((zip) => zip.addFile('files/evil.json', Buffer.from('{}')))
    await expect(extractAndVerifyModelPackage(fixture.packagePath, join(fixture.root, 'staging'), fixture.publicKey)).rejects.toThrow('清单外')
  })

  it('拒绝异常压缩比，防御解压炸弹', async () => {
    const fixture = makePackage((zip) => zip.addFile('files/bomb.json', Buffer.alloc(1024 * 1024)))
    await expect(extractAndVerifyModelPackage(fixture.packagePath, join(fixture.root, 'staging'), fixture.publicKey)).rejects.toThrow('压缩比')
  })

  it('拒绝错误签名', async () => {
    const fixture = makePackage()
    const wrong = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    await expect(extractAndVerifyModelPackage(fixture.packagePath, join(fixture.root, 'staging'), wrong)).rejects.toThrow('签名无效')
  })
})

import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { LocalEmbeddingModelManifest, LocalModelCatalog } from '../../../shared/localModels'
import { canonicalJson, catalogSigningPayload, manifestSigningPayload, validateManifest, verifyCatalog } from '../localModels/manifest'
import { BUILTIN_MODEL_CATALOG, MODEL_CATALOG_PUBLIC_KEY } from '../localModels/catalog'

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const manifest: LocalEmbeddingModelManifest = {
    schemaVersion: 1, id: 'test-model', version: '1.2.0', displayName: '测试模型', description: '仅用于测试', languages: ['zh'],
    license: { name: 'MIT', url: 'https://example.com/license' }, runtime: 'onnx', architecture: 'bert', dimensions: 384, maxTokens: 512,
    dtype: 'q8', pooling: 'mean', normalize: true, queryPrefix: 'query: ', passagePrefix: 'passage: ', minimumAppVersion: '0.1.0',
    recommendedMemoryMb: 256, installedSize: 16, files: [{ path: 'config.json', size: 2, sha256: '0'.repeat(64), urls: ['https://example.com/config.json'] }], catalogSignature: '',
  }
  manifest.catalogSignature = sign(null, Buffer.from(manifestSigningPayload(manifest)), privateKey).toString('base64')
  const catalog: LocalModelCatalog = { schemaVersion: 1, generatedAt: '2026-08-28T00:00:00.000Z', models: [manifest], signature: '' }
  catalog.signature = sign(null, Buffer.from(catalogSigningPayload(catalog)), privateKey).toString('base64')
  return { manifest, catalog, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
}

describe('local model manifest security', () => {
  it('内置中文与多语言目录及逐模型签名有效', () => {
    const models = verifyCatalog(BUILTIN_MODEL_CATALOG, MODEL_CATALOG_PUBLIC_KEY)
    expect(models.map((item) => item.id)).toEqual(['bge-small-zh-v1.5', 'multilingual-e5-small'])
  })
  it('canonical JSON 不受对象键顺序影响', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 2 }))
  })

  it('验证 catalog 与逐模型 Ed25519 签名', () => {
    const { catalog, publicKey, manifest } = fixture()
    expect(verifyCatalog(catalog, publicKey)).toEqual([manifest])
    catalog.models[0].description = '被篡改'
    expect(() => verifyCatalog(catalog, publicKey)).toThrow('模型目录签名无效')
  })

  it.each(['../model.onnx', '/absolute/model.onnx', 'dir\\model.onnx', 'script.js', 'dir/../model.onnx'])(
    '拒绝不安全或可执行文件路径 %s',
    (path) => {
      const { manifest } = fixture()
      manifest.files[0].path = path
      expect(() => validateManifest(manifest)).toThrow()
    },
  )

  it('拒绝大小写折叠后的重复路径', () => {
    const { manifest } = fixture()
    manifest.installedSize = 32
    manifest.files.push({ ...manifest.files[0], path: 'CONFIG.json' })
    expect(() => validateManifest(manifest)).toThrow('重复')
  })
})

/**
 * 模型目录签名工具（发布流程使用）
 *
 * 用法：
 *   tsx scripts/sign-model-catalog.ts --key <private.pem>   用发布私钥对内置目录重新签名
 *   tsx scripts/sign-model-catalog.ts --generate            生成新 Ed25519 密钥对并签名（仅首次引导/轮换；
 *                                                           私钥只打印一次，必须交由发布流程保管，不进仓库）
 *
 * 输出为可直接粘贴进 electron/services/localModels/catalog.ts 与 manifest.ts 的字段值。
 * 目录或任一 manifest 的任何内容变更（包括描述、文件 hash）都需要重跑本脚本。
 */
import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_MODEL_CATALOG } from '../electron/services/localModels/catalog'
import { catalogSigningPayload, manifestSigningPayload } from '../electron/services/localModels/manifest'

const args = process.argv.slice(2)
const keyIndex = args.indexOf('--key')
const hasGenerate = args.includes('--generate')
if (!hasGenerate && keyIndex < 0) {
  console.error('用法：tsx scripts/sign-model-catalog.ts --key <private.pem> | --generate')
  process.exit(1)
}

let privateKeyPem: string
let generated = false
if (hasGenerate) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyFile = join(tmpdir(), `qingyu-catalog-${Date.now()}.pem`)
  writeFileSync(keyFile, privateKeyPem)
  console.log('=== 新生成的发布私钥（仅此一次显示，请立即转交发布流程保管后删除文件） ===')
  console.log(`私钥文件：${keyFile}`)
  console.log(publicKeyPem.trim())
  console.log('=== 对应的新公钥（替换 manifest.ts 的 MODEL_CATALOG_PUBLIC_KEY） ===')
  generated = true
} else {
  privateKeyPem = readFileSync(args[keyIndex + 1], 'utf8')
}

// 签名顺序：先逐模型签名（payload 不含 catalogSignature），再用携带新模型签名的
// 目录计算总签名——verifyCatalog 校验目录签名时包含模型级 catalogSignature 字段。
const signedCatalog = {
  ...BUILTIN_MODEL_CATALOG,
  models: BUILTIN_MODEL_CATALOG.models.map((model) => {
    const catalogSignature = sign(null, Buffer.from(manifestSigningPayload(model)), privateKeyPem).toString('base64')
    console.log(`\n# ${model.id}@${model.version} 的 catalogSignature：`)
    console.log(catalogSignature)
    return { ...model, catalogSignature }
  }),
}

const catalogSignature = sign(null, Buffer.from(catalogSigningPayload(signedCatalog)), privateKeyPem).toString('base64')
console.log('\n# 目录总 signature（替换 catalog.ts 末尾的 signature）：')
console.log(catalogSignature)
if (generated) console.log('\n注意：公钥与私钥已轮换，必须同步更新 manifest.ts 中的 MODEL_CATALOG_PUBLIC_KEY。')

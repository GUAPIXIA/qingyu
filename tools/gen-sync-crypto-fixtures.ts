/**
 * 生成跨端 E2EE 互操作 fixture（固定测试密钥，生产禁用）。
 * 运行：pnpm exec tsx tools/gen-sync-crypto-fixtures.ts
 */
import { createCipheriv, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentHash } from '../shared/contracts/canonical-json'
import {
  buildEntityAad,
  encryptEntity,
  decryptEntity,
  encryptBlob,
  computeContentTag,
  deriveSubkey,
  buildKeyEnvelopeTranscript,
  keyEnvelopeTranscriptHash,
  deriveKeyEnvelopeSas,
  deriveKeyEnvelopeWrapKey,
  buildKeyEnvelopeBody,
  keyEnvelopeSigningBytes,
  keyEnvelopeWrapAad,
  exportRecoveryPackage,
  computeChallengeProof,
  versionHashFromCanonical,
  RECOVERY_KDF_MIN,
} from '../shared/sync-crypto'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '../shared/fixtures/cross-platform/sync-crypto')
mkdirSync(outDir, { recursive: true })

// 固定测试密钥（32B）——与 Kotlin 侧共用
const SPACE_KEY = Buffer.alloc(32, 0x11)
const FIXED_NONCE_ENTITY = Buffer.alloc(12, 0x01)
const FIXED_NONCE_WRAP = Buffer.alloc(12, 0x04)
const FIXED_NONCE_RECOVERY = Buffer.alloc(12, 0x05)
const FIXED_SALT_RECOVERY = Buffer.alloc(32, 0x06)

const spaceId = '11111111-2222-3333-4444-555555555555'
const entityType = 'character'
const entityId = '01KCHARACTER00000000000001'
const payload = { name: '测试角色', greeting: '你好', tags: ['a', 'b'] }
const ch = contentHash(payload)
const versionCanonical = '{"pc_a":"12"}'
const versionHash = versionHashFromCanonical(versionCanonical)

const aad = buildEntityAad({
  spaceId,
  entityType,
  entityId,
  schemaVersion: 3,
  versionHash,
  keyEpoch: 1,
  cipherRevision: 1,
})

const encrypted = encryptEntity({
  spaceKey: SPACE_KEY,
  aad,
  payload,
  contentHash: ch,
  nonce: FIXED_NONCE_ENTITY,
})

// 子密钥向量
const subkeys = {
  infoVersion: 1,
  salt: 'qingyu-sync-crypto/subkey/v1',
  purposes: ['entity', 'blob-chunk', 'blob-manifest', 'receipt', 'content-dedupe', 'key-envelope', 'recovery', 'challenge'] as const,
  derived: {} as Record<string, string>,
}
for (const p of subkeys.purposes) {
  subkeys.derived[p] = deriveSubkey(SPACE_KEY, p).toString('base64')
}

// contentTag
const contentTag = computeContentTag(SPACE_KEY, { entityType, entityId, contentHash: ch })

// blob：1.5 个块（chunk 尺寸压到 8 便于测试）
const blobPlain = Buffer.from('hello-blob-0123456789', 'utf8')
const blob = encryptBlob({
  spaceKey: SPACE_KEY,
  spaceId,
  data: blobPlain,
  chunkPlaintextSize: 8,
  deterministicNonceForTest: true,
})

// key envelope（Ed25519 + X25519 固定密钥）
// 使用 deterministic Ed25519 seed 不可直接从 node:crypto；改为固定 PEM 生成一次并固化进 fixture
const ed = generateKeyPairSync('ed25519')
// 为跨端稳定，fixture 直接固化 raw 公钥与签名结果；Kotlin 用相同 raw 向量验算 SAS/transcript/wrap key
const recipientX25519Raw = Buffer.alloc(32, 0x21)
const approverX25519Raw = Buffer.alloc(32, 0x31)
// 模拟 ECDH sharedSecret（fixture 固定，非真实 X25519 结果；真实 ECDH 互操作单测两端各自验）
const ecdhShared = Buffer.alloc(32, 0x51)
const nonceB64 = Buffer.alloc(32, 0x61).toString('base64')
const expiresAt = 2_000_000_000_000

const approverEd25519PublicDer = Buffer.from(ed.publicKey.export({ type: 'spki', format: 'der' }))
const approverEd25519PublicRaw = approverEd25519PublicDer.subarray(12) // SPKI Ed25519 = 12B prefix + 32B raw

const transcriptInput = {
  spaceId,
  keyEpoch: 1,
  recipientDeviceId: 'android_b',
  recipientX25519PublicKey: recipientX25519Raw.toString('base64'),
  approverDeviceId: 'pc_a',
  approverX25519PublicKey: approverX25519Raw.toString('base64'),
  approverEd25519PublicKey: approverEd25519PublicRaw.toString('base64'),
  nonce: nonceB64,
  expiresAt,
}
const transcript = buildKeyEnvelopeTranscript(transcriptInput)
const transcriptHash = keyEnvelopeTranscriptHash(transcript)
const sas = deriveKeyEnvelopeSas(transcript)
const wrapKey = deriveKeyEnvelopeWrapKey({ sharedSecret: ecdhShared, transcript })

const wrapCipher = createCipheriv('aes-256-gcm', wrapKey, FIXED_NONCE_WRAP)
wrapCipher.setAAD(Buffer.from(keyEnvelopeWrapAad(transcriptHash), 'utf8'), { plaintextLength: SPACE_KEY.length })
const wrapBody = Buffer.concat([wrapCipher.update(SPACE_KEY), wrapCipher.final()])
const wrapTag = wrapCipher.getAuthTag()
const wrappedKey = Buffer.concat([wrapBody, wrapTag]).toString('base64')
const wrappedNonce = FIXED_NONCE_WRAP.toString('base64')

const body = buildKeyEnvelopeBody({
  ...transcriptInput,
  wrappedNonce,
  wrappedKey,
  transcriptHash,
})
const signKeyObject = ed.privateKey
const signingBytes = keyEnvelopeSigningBytes(transcript, body)
const signature = cryptoSign(null, signingBytes, signKeyObject)

// 回环自检用同一 transcript
const transcript2 = transcript
const transcriptHash2 = transcriptHash
const sas2 = sas
const wrapKey2 = wrapKey
const body2 = body
const signingBytes2 = signingBytes
const signature2 = signature

// recovery（低 N 以便测试速度；门禁仍断言 ≥ MIN）
const recovery = exportRecoveryPackage({
  spaceKey: SPACE_KEY,
  spaceId,
  keyEpoch: 1,
  passphrase: 'Correct-Horse-9',
  createdAt: 1_700_000_000_000,
  salt: FIXED_SALT_RECOVERY,
  nonce: FIXED_NONCE_RECOVERY,
  kdfParams: { N: RECOVERY_KDF_MIN.N, r: RECOVERY_KDF_MIN.r, p: RECOVERY_KDF_MIN.p },
})

const challenge = 'challenge-token-001'
const challengeProof = computeChallengeProof(SPACE_KEY, challenge)

const fixture = {
  note: '跨端 E2EE 互操作 golden。固定测试密钥，生产禁止复用。Kotlin 必须逐字段复算一致。',
  formatVersion: 1,
  fixed: {
    spaceKey: SPACE_KEY.toString('base64'),
    spaceId,
    entityType,
    entityId,
    schemaVersion: 3,
    payload,
    contentHash: ch,
    versionCanonical,
    versionHash,
    keyEpoch: 1,
    cipherRevision: 1,
  },
  subkeys: {
    salt: subkeys.salt,
    infoVersion: subkeys.infoVersion,
    derived: subkeys.derived,
  },
  entity: {
    aad,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    cipherHash: encrypted.cipherHash,
    contentTag: encrypted.contentTag,
  },
  contentTagVector: contentTag,
  blob: {
    plainUtf8: blobPlain.toString('utf8'),
    chunkPlaintextSize: 8,
    plainHash: blob.manifest.plainHash,
    blobId: blob.manifest.blobId,
    manifestHash: blob.manifest.manifestHash,
    chunks: blob.chunks,
    manifest: blob.manifest,
    encryptedManifest: blob.encryptedManifest,
  },
  keyEnvelope: {
    ecdhSharedSecret: ecdhShared.toString('base64'),
    transcript: transcript2,
    transcriptHash: transcriptHash2,
    sas: sas2,
    wrapKey: wrapKey2.toString('base64'),
    wrapAad: keyEnvelopeWrapAad(transcriptHash2),
    body: body2,
    signingBytesUtf8: signingBytes2.toString('utf8'),
    approverEd25519PublicKeyRaw: approverEd25519PublicRaw.toString('base64'),
    approverEd25519PublicKeySpkiDer: approverEd25519PublicDer.toString('base64'),
    signature: signature2.toString('base64'),
    // 完整信封
    envelope: { ...body2, signature: signature2.toString('base64') },
  },
  recovery: {
    package: recovery,
    passphrase: 'Correct-Horse-9',
  },
  challenge: {
    challenge,
    proof: challengeProof,
  },
  aadString: aad,
}

const outFile = resolve(outDir, 'e2ee-interop.json')
writeFileSync(outFile, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')

// 自检：解密回环（用 contentHash 比较，避免 JSON 键序差异）
const plainDec = decryptEntity({ spaceKey: SPACE_KEY, aad, encrypted })
if (contentHash(plainDec) !== ch) {
  throw new Error('fixture 自检失败：实体解密不一致')
}

if (!cryptoVerify(null, signingBytes2, ed.publicKey, signature2)) {
  throw new Error('fixture 自检失败：Ed25519 签名无效')
}

console.log('wrote', outFile)

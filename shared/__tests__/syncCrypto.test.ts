/**
 * 阶段 8 S8-01/S8-02：E2EE 原语、密钥信封、恢复包单测。
 * 含跨端 golden 自检（生成后的 e2ee-interop.json 必须可被本侧复算）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes, verify as cryptoVerify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { contentHash } from '../contracts/canonical-json'
import {
  buildEntityAad,
  encryptEntity,
  decryptEntity,
  decryptAndVerifyEntity,
  deriveSubkey,
  computeContentTag,
  versionHashFromCanonical,
  encryptBlob,
  decryptBlob,
  decryptManifest,
  manifestSigningBytes,
  buildKeyEnvelopeTranscript,
  keyEnvelopeTranscriptHash,
  deriveKeyEnvelopeSas,
  deriveKeyEnvelopeWrapKey,
  buildKeyEnvelopeBody,
  keyEnvelopeSigningBytes,
  keyEnvelopeWrapAad,
  verifyKeyEnvelopeStructure,
  computeChallengeProof,
  verifyChallengeProof,
  exportRecoveryPackage,
  importRecoveryPackage,
  SyncCryptoError,
  RECOVERY_KDF_MIN,
  assertPassphraseStrength,
  BLOB_CHUNK_PLAIN_MAX,
} from '../sync-crypto'

const SPACE_KEY = Buffer.alloc(32, 0x11)
const fixturePath = resolve(__dirname, '../fixtures/cross-platform/sync-crypto/e2ee-interop.json')

function loadFixture(): null | Record<string, any> {
  if (!existsSync(fixturePath)) return null
  return JSON.parse(readFileSync(fixturePath, 'utf8'))
}

describe('S8-01 子密钥派生', () => {
  it('不同 purpose 得到不同子密钥，相同输入稳定', () => {
    const a = deriveSubkey(SPACE_KEY, 'entity')
    const b = deriveSubkey(SPACE_KEY, 'blob-chunk')
    const a2 = deriveSubkey(SPACE_KEY, 'entity')
    expect(a).toHaveLength(32)
    expect(a.equals(b)).toBe(false)
    expect(a.equals(a2)).toBe(true)
  })

  it('拒绝错误长度 spaceKey', () => {
    expect(() => deriveSubkey(Buffer.alloc(16), 'entity')).toThrow(SyncCryptoError)
  })
})

describe('S8-01 实体加解密', () => {
  const payload = { name: '测试角色', greeting: '你好', tags: ['a', 'b'] }
  const ch = contentHash(payload)
  const versionHash = versionHashFromCanonical('{"pc_a":"12"}')
  const aadInput = {
    spaceId: 's1',
    entityType: 'character',
    entityId: 'e1',
    schemaVersion: 3,
    versionHash,
    keyEpoch: 1,
    cipherRevision: 1,
  }
  const aad = buildEntityAad(aadInput)

  it('往返一致，AAD 变化拒绝解密', () => {
    const enc = encryptEntity({
      spaceKey: SPACE_KEY,
      aad,
      payload,
      contentHash: ch,
    })
    expect(enc.nonce).toHaveLength(16) // base64 12B
    const dec = decryptEntity({ spaceKey: SPACE_KEY, aad, encrypted: enc })
    expect(dec).toEqual(payload)
    // 篡改 cipherRevision → AAD 不匹配
    const badAad = { ...aadInput, cipherRevision: 2 }
    expect(() => decryptEntity({ spaceKey: SPACE_KEY, aad: badAad, encrypted: enc })).toThrow(/DECRYPT|解密/)
  })

  it('contentHash 校验：伪造 contentHash 必须拒绝', () => {
    const enc = encryptEntity({ spaceKey: SPACE_KEY, aad, payload, contentHash: ch })
    expect(() =>
      decryptAndVerifyEntity({
        spaceKey: SPACE_KEY,
        aad,
        encrypted: enc,
        expectedContentHash: contentHash({ evil: true }),
      }),
    ).toThrow(SyncCryptoError)
  })

  it('contentTag 与 entityType/entityId/contentHash 绑定', () => {
    const t1 = computeContentTag(SPACE_KEY, { entityType: 'character', entityId: 'e1', contentHash: ch })
    const t2 = computeContentTag(SPACE_KEY, { entityType: 'character', entityId: 'e2', contentHash: ch })
    expect(t1).not.toBe(t2)
  })

  it('重加密只增 cipherRevision：新密文、同 contentHash', () => {
    const a1 = {
      spaceId: 's1',
      entityType: 'character',
      entityId: 'e1',
      schemaVersion: 3,
      versionHash,
      keyEpoch: 1,
      cipherRevision: 1,
    }
    const a2 = { ...a1, cipherRevision: 2 }
    const e1 = encryptEntity({ spaceKey: SPACE_KEY, aad: a1, payload, contentHash: ch })
    const e2 = encryptEntity({ spaceKey: SPACE_KEY, aad: a2, payload, contentHash: ch })
    expect(e2.ciphertext).not.toBe(e1.ciphertext)
    expect(e2.contentTag).toBe(e1.contentTag)
    expect(e2.contentHash).toBe(e1.contentHash)
    // 字符串 AAD 与对象 AAD 得到同一 contentTag
    const e3 = encryptEntity({ spaceKey: SPACE_KEY, aad: buildEntityAad(a1), payload, contentHash: ch })
    expect(e3.contentTag).toBe(e1.contentTag)
  })
})

describe('S8-01 blob 分块', () => {
  it('多块往返与 manifest 哈希', () => {
    const data = Buffer.from('hello-blob-0123456789', 'utf8')
    const { chunks, manifest, encryptedManifest } = encryptBlob({
      spaceKey: SPACE_KEY,
      spaceId: 's1',
      data,
      chunkPlaintextSize: 8,
      deterministicNonceForTest: true,
    })
    expect(chunks.length).toBe(3)
    expect(manifest.chunks).toHaveLength(3)
    const round = decryptBlob({
      spaceKey: SPACE_KEY,
      spaceId: 's1',
      blobId: manifest.blobId,
      encryptedManifest,
      chunks,
    })
    expect(round.equals(data)).toBe(true)
    const m2 = decryptManifest({
      spaceKey: SPACE_KEY,
      spaceId: 's1',
      blobId: manifest.blobId,
      encryptedManifest,
    })
    expect(m2.manifestHash).toBe(manifest.manifestHash)
    expect(manifestSigningBytes(manifest).toString('utf8')).toContain('plainHash')
  })

  it('篡改块密文 → 解密失败', () => {
    const data = Buffer.from('abc', 'utf8')
    const { chunks, encryptedManifest } = encryptBlob({
      spaceKey: SPACE_KEY,
      spaceId: 's1',
      data,
      chunkPlaintextSize: 64,
    })
    const evil = chunks.map((c) => ({ ...c }))
    const raw = Buffer.from(evil[0]!.ciphertext, 'base64')
    raw[0] ^= 0xff
    evil[0]!.ciphertext = raw.toString('base64')
    expect(() =>
      decryptBlob({ spaceKey: SPACE_KEY, spaceId: 's1', blobId: 'b', encryptedManifest, chunks: evil }),
    ).toThrow()
  })
})

describe('S8-02 密钥信封', () => {
  const transcriptInput = {
    spaceId: 's1',
    keyEpoch: 1,
    recipientDeviceId: 'android_b',
    recipientX25519PublicKey: Buffer.alloc(32, 0x21).toString('base64'),
    approverDeviceId: 'pc_a',
    approverX25519PublicKey: Buffer.alloc(32, 0x31).toString('base64'),
    approverEd25519PublicKey: Buffer.alloc(32, 0x41).toString('base64'),
    nonce: Buffer.alloc(32, 0x61).toString('base64'),
    expiresAt: 2_000_000_000_000,
  }

  it('SAS/transcript 稳定且绑定全部字段', () => {
    const t = buildKeyEnvelopeTranscript(transcriptInput)
    const sas = deriveKeyEnvelopeSas(t)
    expect(sas).toMatch(/^\d{6}$/)
    const sas2 = deriveKeyEnvelopeSas(buildKeyEnvelopeTranscript({ ...transcriptInput, nonce: 'x' }))
    expect(sas2).not.toBe(sas)
  })

  it('替换公钥后 verifyKeyEnvelopeStructure 拒绝', () => {
    const transcript = buildKeyEnvelopeTranscript(transcriptInput)
    const transcriptHash = keyEnvelopeTranscriptHash(transcript)
    const body = buildKeyEnvelopeBody({
      ...transcriptInput,
      wrappedNonce: Buffer.alloc(12, 4).toString('base64'),
      wrappedKey: Buffer.alloc(48, 5).toString('base64'),
      transcriptHash,
    })
    const envelope = { ...body, signature: 'sig' }
    const ok = verifyKeyEnvelopeStructure({
      envelope,
      now: 1_000_000_000_000,
      expected: transcriptInput,
    })
    expect(ok.ok).toBe(true)
    const bad = verifyKeyEnvelopeStructure({
      envelope: { ...envelope, recipientX25519PublicKey: Buffer.alloc(32, 9).toString('base64') },
      now: 1_000_000_000_000,
      expected: transcriptInput,
    })
    expect(bad.ok).toBe(false)
  })

  it('过期信封拒绝', () => {
    const transcript = buildKeyEnvelopeTranscript(transcriptInput)
    const body = buildKeyEnvelopeBody({
      ...transcriptInput,
      wrappedNonce: Buffer.alloc(12, 4).toString('base64'),
      wrappedKey: Buffer.alloc(48, 5).toString('base64'),
      transcriptHash: keyEnvelopeTranscriptHash(transcript),
    })
    const r = verifyKeyEnvelopeStructure({
      envelope: { ...body, signature: 's' },
      now: transcriptInput.expiresAt + 1,
      expected: transcriptInput,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('EXPIRED')
  })

  it('wrap key 可解开 spaceKey；AAD 绑定 transcriptHash', () => {
    const transcript = buildKeyEnvelopeTranscript(transcriptInput)
    const th = keyEnvelopeTranscriptHash(transcript)
    const wrapKey = deriveKeyEnvelopeWrapKey({
      sharedSecret: Buffer.alloc(32, 0x51),
      transcript,
    })
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', wrapKey, nonce, { authTagLength: 16 })
    cipher.setAAD(Buffer.from(keyEnvelopeWrapAad(th), 'utf8'))
    const ct = Buffer.concat([cipher.update(SPACE_KEY), cipher.final(), cipher.getAuthTag()])
    const dec = createDecipheriv('aes-256-gcm', wrapKey, nonce, { authTagLength: 16 })
    dec.setAAD(Buffer.from(keyEnvelopeWrapAad(th), 'utf8'))
    dec.setAuthTag(ct.subarray(ct.length - 16))
    const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()])
    expect(plain.equals(SPACE_KEY)).toBe(true)
  })

  it('challenge 证明绑定 spaceKey', () => {
    const proof = computeChallengeProof(SPACE_KEY, 'c-1')
    expect(verifyChallengeProof({ spaceKey: SPACE_KEY, challenge: 'c-1', proof })).toBe(true)
    expect(
      verifyChallengeProof({ spaceKey: Buffer.alloc(32, 0x99), challenge: 'c-1', proof }),
    ).toBe(false)
    const body = buildKeyEnvelopeBody({
      ...transcriptInput,
      wrappedNonce: Buffer.alloc(12, 4).toString('base64'),
      wrappedKey: Buffer.alloc(48, 5).toString('base64'),
      transcriptHash: keyEnvelopeTranscriptHash(buildKeyEnvelopeTranscript(transcriptInput)),
    })
    expect(keyEnvelopeSigningBytes(buildKeyEnvelopeTranscript(transcriptInput), body).length).toBeGreaterThan(0)
  })
})

describe('S8-02 恢复包', () => {
  const weakCases = ['', 'short', 'alllowercaseonly']
  it('弱口令导出被拒绝', () => {
    for (const p of weakCases) {
      expect(() => assertPassphraseStrength(p)).toThrow(SyncCryptoError)
    }
  })

  it('导出→导入往返；错误口令/参数降级/跨空间拒绝', () => {
    const pkg = exportRecoveryPackage({
      spaceKey: SPACE_KEY,
      spaceId: 's1',
      keyEpoch: 1,
      passphrase: 'Correct-Horse-9',
      createdAt: 1,
      salt: Buffer.alloc(32, 6),
      nonce: Buffer.alloc(12, 5),
      kdfParams: { N: RECOVERY_KDF_MIN.N, r: RECOVERY_KDF_MIN.r, p: RECOVERY_KDF_MIN.p },
    })
    expect(pkg.rotateAfterRestore).toBe(true)
    const ok = importRecoveryPackage({
      pkg,
      passphrase: 'Correct-Horse-9',
      expectedSpaceId: 's1',
      now: 2,
    })
    expect(Buffer.from(ok.spaceKey).equals(SPACE_KEY)).toBe(true)
    expect(ok.mustRotate).toBe(true)

    expect(() =>
      importRecoveryPackage({ pkg, passphrase: 'Wrong-Horse-9', expectedSpaceId: 's1', now: 2 }),
    ).toThrow(SyncCryptoError)

    expect(() =>
      importRecoveryPackage({
        pkg: { ...pkg, kdf: { ...pkg.kdf, N: 1024 } },
        passphrase: 'Correct-Horse-9',
        expectedSpaceId: 's1',
        now: 2,
      }),
    ).toThrow(/KDF|降级/)

    expect(() =>
      importRecoveryPackage({
        pkg,
        passphrase: 'Correct-Horse-9',
        expectedSpaceId: 'other-space',
        now: 2,
      }),
    ).toThrow(/空间|CROSS_SPACE/)
  })
})

describe('跨端 golden e2ee-interop.json', () => {
  const fixture = loadFixture()

  it('fixture 存在（先运行 tools/gen-sync-crypto-fixtures.ts）', () => {
    expect(fixture, '缺少 sync-crypto fixture').not.toBeNull()
  })

  it.runIf(!!fixture)('实体密文/contentTag/子密钥逐字段复算', () => {
    const f = fixture!
    const spaceKey = Buffer.from(f.fixed.spaceKey, 'base64')
    for (const [purpose, b64] of Object.entries<string>(f.subkeys.derived)) {
      expect(deriveSubkey(spaceKey, purpose as never).toString('base64')).toBe(b64)
    }
    const aad = buildEntityAad({
      spaceId: f.fixed.spaceId,
      entityType: f.fixed.entityType,
      entityId: f.fixed.entityId,
      schemaVersion: f.fixed.schemaVersion,
      versionHash: f.fixed.versionHash,
      keyEpoch: f.fixed.keyEpoch,
      cipherRevision: f.fixed.cipherRevision,
    })
    expect(aad).toBe(f.aadString)
    const enc = encryptEntity({
      spaceKey,
      aad,
      payload: f.fixed.payload,
      contentHash: f.fixed.contentHash,
      nonce: Buffer.from(f.entity.nonce, 'base64'),
    })
    expect(enc.ciphertext).toBe(f.entity.ciphertext)
    expect(enc.cipherHash).toBe(f.entity.cipherHash)
    expect(enc.contentTag).toBe(f.entity.contentTag)
    const dec = decryptAndVerifyEntity({
      spaceKey,
      aad,
      encrypted: enc,
      expectedContentHash: f.fixed.contentHash,
    })
    expect(dec).toEqual(f.fixed.payload)
  })

  it.runIf(!!fixture)('blob manifest/chunk 复算', () => {
    const f = fixture!
    const spaceKey = Buffer.from(f.fixed.spaceKey, 'base64')
    const data = Buffer.from(f.blob.plainUtf8, 'utf8')
    const { chunks, manifest } = encryptBlob({
      spaceKey,
      spaceId: f.fixed.spaceId,
      data,
      chunkPlaintextSize: f.blob.chunkPlaintextSize,
      deterministicNonceForTest: true,
    })
    expect(manifest.manifestHash).toBe(f.blob.manifestHash)
    expect(chunks.map((c) => c.ciphertext)).toEqual(f.blob.chunks.map((c: any) => c.ciphertext))
  })

  it.runIf(!!fixture)('key envelope SAS/wrapKey/签名载荷复算', () => {
    const f = fixture!
    const expected = {
      spaceId: f.keyEnvelope.body.spaceId,
      keyEpoch: f.keyEnvelope.body.keyEpoch,
      recipientDeviceId: f.keyEnvelope.body.recipientDeviceId,
      recipientX25519PublicKey: f.keyEnvelope.body.recipientX25519PublicKey,
      approverDeviceId: f.keyEnvelope.body.approverDeviceId,
      approverX25519PublicKey: f.keyEnvelope.body.approverX25519PublicKey,
      approverEd25519PublicKey: f.keyEnvelope.body.approverEd25519PublicKey,
      nonce: f.keyEnvelope.body.nonce,
      expiresAt: f.keyEnvelope.body.expiresAt,
    }
    const transcript = buildKeyEnvelopeTranscript(expected)
    expect(transcript).toBe(f.keyEnvelope.transcript)
    expect(deriveKeyEnvelopeSas(transcript)).toBe(f.keyEnvelope.sas)
    expect(keyEnvelopeTranscriptHash(transcript)).toBe(f.keyEnvelope.transcriptHash)
    const wrapKey = deriveKeyEnvelopeWrapKey({
      sharedSecret: Buffer.from(f.keyEnvelope.ecdhSharedSecret, 'base64'),
      transcript,
    })
    expect(wrapKey.toString('base64')).toBe(f.keyEnvelope.wrapKey)
    const body = buildKeyEnvelopeBody({
      ...expected,
      wrappedNonce: f.keyEnvelope.body.wrappedNonce,
      wrappedKey: f.keyEnvelope.body.wrappedKey,
      transcriptHash: f.keyEnvelope.transcriptHash,
    })
    expect(body).toEqual(f.keyEnvelope.body)
    expect(keyEnvelopeSigningBytes(transcript, body).toString('utf8')).toBe(f.keyEnvelope.signingBytesUtf8)
    // 解封 wrapKey
    const ct = Buffer.from(f.keyEnvelope.body.wrappedKey, 'base64')
    const dec = createDecipheriv('aes-256-gcm', wrapKey, Buffer.from(f.keyEnvelope.body.wrappedNonce, 'base64'), {
      authTagLength: 16,
    })
    dec.setAAD(Buffer.from(keyEnvelopeWrapAad(f.keyEnvelope.transcriptHash), 'utf8'))
    dec.setAuthTag(ct.subarray(ct.length - 16))
    const spaceKey = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()])
    expect(spaceKey.toString('base64')).toBe(f.fixed.spaceKey)
    // Ed25519 验签
    const spki = Buffer.from(f.keyEnvelope.approverEd25519PublicKeySpkiDer, 'base64')
    expect(
      cryptoVerify(
        null,
        keyEnvelopeSigningBytes(transcript, body),
        { key: spki, format: 'der', type: 'spki' },
        Buffer.from(f.keyEnvelope.signature, 'base64'),
      ),
    ).toBe(true)
  })

  it.runIf(!!fixture)('恢复包/challenge 复算', () => {
    const f = fixture!
    const spaceKey = Buffer.from(f.fixed.spaceKey, 'base64')
    const restored = importRecoveryPackage({
      pkg: f.recovery.package,
      passphrase: f.recovery.passphrase,
      expectedSpaceId: f.fixed.spaceId,
      now: 1,
    })
    expect(Buffer.from(restored.spaceKey).equals(spaceKey)).toBe(true)
    expect(computeChallengeProof(spaceKey, f.challenge.challenge)).toBe(f.challenge.proof)
    expect(
      verifyChallengeProof({
        spaceKey,
        challenge: f.challenge.challenge,
        proof: f.challenge.proof,
      }),
    ).toBe(true)
  })
})

describe('性能与上限', () => {
  it('BLOB_CHUNK_PLAIN_MAX = 1 MiB', () => {
    expect(BLOB_CHUNK_PLAIN_MAX).toBe(1024 * 1024)
  })
})

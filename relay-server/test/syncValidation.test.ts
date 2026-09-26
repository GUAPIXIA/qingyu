/**
 * S8-03 校验与 S8-05 配额纯逻辑测试。
 */
import { describe, expect, it } from 'vitest'
import {
  validateVersionVector,
  validateWireEntity,
  validatePushBatch,
} from '../src/sync/validation.js'
import { checkQuota, DEFAULT_QUOTA, quotaSnapshotFromDefaults } from '../src/sync/quota.js'
import { canTransition, computeRequestHash, isTerminal, mergeKnownVector } from '../src/sync/session.js'
import { MemoryObjectStore, cipherHashOf, newObjectKey } from '../src/sync/objectStore.js'
import { validateKeyEnvelopeWire } from '../src/sync/keyRoutes.js'

const DEVICE = 'android_b'

function wireEntity(over: Record<string, unknown> = {}) {
  return {
    entityType: 'character',
    entityId: '01KCHAR000000000000000001',
    parentId: null,
    schemaVersion: 3,
    version: { android_b: '4' },
    versionHash: 'sha256:' + 'a'.repeat(64),
    dot: { deviceId: DEVICE, counter: '4' },
    deleted: false,
    updatedAt: 1789550000000,
    keyEpoch: 1,
    cipherRevision: 1,
    cipherHash: 'sha256:' + 'b'.repeat(64),
    contentTag: 'tag-b64',
    ciphertext: Buffer.from('x'.repeat(48)).toString('base64'),
    ...over,
  }
}

describe('S8-03 版本向量校验', () => {
  it('接受无前导零十进制 counter，拒绝 Number 有损形态', () => {
    expect(validateVersionVector({ a: '12', b: '0' }).ok).toBe(true)
    expect(validateVersionVector({ a: '012' }).ok).toBe(false)
    expect(validateVersionVector({ a: 12 as unknown as string }).ok).toBe(false)
    expect(validateVersionVector({ a: '1e3' }).ok).toBe(false)
    expect(validateVersionVector({ a: '99999999999999999999' }).ok).toBe(false) // >20 digits
    expect(validateVersionVector(null).ok).toBe(false)
  })

  it('UInt64 边界形态', () => {
    expect(validateVersionVector({ a: '18446744073709551615' }).ok).toBe(true) // 2^64-1，20 位
  })
})

describe('S8-03 wire entity 校验', () => {
  it('dot.deviceId 必须等于已认证设备（非重加密）', () => {
    expect(validateWireEntity(wireEntity(), DEVICE, { maxBlobBytes: 1 << 26 }).ok).toBe(true)
    const bad = validateWireEntity(wireEntity({ dot: { deviceId: 'pc_a', counter: '1' } }), DEVICE, { maxBlobBytes: 1 << 26 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('DOT_DEVICE_MISMATCH')
  })

  it('重加密批次 keyEpoch 必须等于目标', () => {
    const ok = validateWireEntity(wireEntity({ keyEpoch: 2 }), DEVICE, {
      maxBlobBytes: 1 << 26,
      reencrypt: { fromKeyEpoch: 1, toKeyEpoch: 2 },
    })
    expect(ok.ok).toBe(true)
    const wrongEpoch = validateWireEntity(wireEntity({ keyEpoch: 1 }), DEVICE, {
      maxBlobBytes: 1 << 26,
      reencrypt: { fromKeyEpoch: 1, toKeyEpoch: 2 },
    })
    expect(wrongEpoch.ok).toBe(false)
  })

  it('ciphertext 与 blobManifestId 必须恰好其一；hash 形状严格', () => {
    const both = validateWireEntity(wireEntity({ blobManifestId: 'm1' }), DEVICE, { maxBlobBytes: 1 << 26 })
    expect(both.ok).toBe(false)
    const neither = validateWireEntity(wireEntity({ ciphertext: undefined }), DEVICE, { maxBlobBytes: 1 << 26 })
    expect(neither.ok).toBe(false)
    const badHash = validateWireEntity(wireEntity({ cipherHash: 'nope' }), DEVICE, { maxBlobBytes: 1 << 26 })
    expect(badHash.ok).toBe(false)
  })

  it('batch 条数与字节上限', () => {
    const many = Array.from({ length: 201 }, (_, i) => wireEntity({ entityId: `e${i}` }))
    const r = validatePushBatch(many, DEVICE, {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('BATCH_TOO_LARGE')
    const one = validatePushBatch([wireEntity()], DEVICE, {})
    expect(one.ok).toBe(true)
    // 同 batch 内重复版本
    const dup = validatePushBatch([wireEntity(), wireEntity()], DEVICE, {})
    expect(dup.ok).toBe(false)
  })
})

describe('S8-05 配额', () => {
  it('实体/字节/blob/设备超额原子拒绝', () => {
    const snap = quotaSnapshotFromDefaults({ usedEntities: 10, usedCiphertextBytes: 100, usedDevices: 2 })
    expect(checkQuota(snap, { newEntities: 5, newCiphertextBytes: 50 }).ok).toBe(true)
    const overE = checkQuota({ ...snap, maxEntities: 12 }, { newEntities: 5, newCiphertextBytes: 0 })
    expect(overE.ok).toBe(false)
    if (!overE.ok) expect(overE.reason).toBe('entities')
    const overB = checkQuota(snap, { newEntities: 0, newCiphertextBytes: 10 ** 12 })
    expect(overB.ok).toBe(false)
    const overBlob = checkQuota(snap, { newEntities: 0, newCiphertextBytes: 0, newBlobBytes: DEFAULT_QUOTA.maxBlobBytes + 1 })
    expect(overBlob.ok).toBe(false)
    const overDev = checkQuota(snap, { newEntities: 0, newCiphertextBytes: 0, newDevices: 9 })
    expect(overDev.ok).toBe(false)
  })
})

describe('S8-03 幂等与状态', () => {
  it('同 batch 同内容 hash 稳定，不同内容变化', () => {
    const a = computeRequestHash('batch-1', [wireEntity()])
    const b = computeRequestHash('batch-1', [wireEntity()])
    const c = computeRequestHash('batch-1', [wireEntity({ cipherHash: 'sha256:' + 'c'.repeat(64) })])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('状态迁移：committed/aborted/expired 终态锁定', () => {
    expect(isTerminal('committed')).toBe(true)
    expect(canTransition('open', 'planned')).toBe(true)
    expect(canTransition('committed', 'open')).toBe(false)
  })

  it('known vector 合并取 max，counter 字符串形态', () => {
    const merged = mergeKnownVector({ a: '3', b: '9' }, { a: '12', c: '1' })
    expect(merged).toEqual({ a: '12', b: '9', c: '1' })
    expect(validateVersionVector(merged).ok).toBe(true)
  })
})

describe('对象存储', () => {
  it('随机 key 不含实体 ID，读写删除', async () => {
    const store = new MemoryObjectStore()
    const data = Buffer.from('cipher-blob')
    const { objectKey, size } = await store.put(data)
    expect(objectKey).toMatch(/^[0-9a-f]{64}$/)
    expect(objectKey).not.toContain('character')
    expect(size).toBe(data.length)
    expect(await store.get(objectKey)).toEqual(data)
    expect(cipherHashOf(data)).toMatch(/^sha256:[0-9a-f]{64}$/)
    await store.delete(objectKey)
    expect(await store.exists(objectKey)).toBe(false)
  })

  it('非法 object key 拒绝', () => {
    expect(() => newObjectKey()).not.toThrow()
  })
})

describe('S8-02 密钥信封结构', () => {
  it('拒绝非法公钥/签名/transcriptHash', () => {
    const good = {
      formatVersion: 1,
      spaceId: '11111111-2222-3333-4444-555555555555',
      keyEpoch: 1,
      recipientDeviceId: 'android_b',
      recipientX25519PublicKey: 'A'.repeat(43) + '=',
      approverDeviceId: 'pc_a',
      approverX25519PublicKey: 'B'.repeat(43) + '=',
      approverEd25519PublicKey: 'C'.repeat(43) + '=',
      nonce: 'bm9uY2Utbm9uY2U=',
      expiresAt: Date.now() + 60_000,
      wrappedNonce: 'AQEBAQEBAQEBAQEB',
      wrappedKey: 'Z'.repeat(48),
      transcriptHash: 'sha256:' + 'd'.repeat(64),
      signature: 'S'.repeat(88),
    }
    expect(validateKeyEnvelopeWire(good).ok).toBe(true)
    expect(validateKeyEnvelopeWire({ ...good, recipientX25519PublicKey: 'short' }).ok).toBe(false)
    expect(validateKeyEnvelopeWire({ ...good, transcriptHash: 'sha256:zz' }).ok).toBe(false)
    expect(validateKeyEnvelopeWire({ ...good, formatVersion: 2 }).ok).toBe(false)
  })
})

/**
 * S8-02：恢复包——独立于 Backup V3 的显式导出物。
 *
 * - 只含 spaceKey，不含业务正文；
 * - scrypt 内存硬 KDF + AES-256-GCM；
 * - 导入拒绝参数降级/弱口令/跨空间；
 * - 恢复成功后必须立即轮换 spaceKey（调用方标记 rotateAfterRestore）。
 *
 * KDF 决策见 types.ts 顶注（Argon2id 评估后冻结 scrypt）。
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import {
  assertPassphraseStrength,
  GCM_NONCE_BYTES,
  GCM_TAG_BITS,
  RECOVERY_KDF_MIN,
  RECOVERY_KDF_RECOMMENDED,
  SPACE_KEY_BYTES,
  SYNC_CRYPTO_FORMAT_VERSION,
  SyncCryptoError,
  type RecoveryPackage,
} from './types'

export function deriveRecoveryKey(input: {
  passphrase: string
  salt: Uint8Array
  N: number
  r: number
  p: number
  dkLen: number
}): Buffer {
  const { N, r, p, dkLen } = input
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < RECOVERY_KDF_MIN.N ||
    r < RECOVERY_KDF_MIN.r ||
    p < RECOVERY_KDF_MIN.p ||
    dkLen !== RECOVERY_KDF_MIN.dkLen ||
    (N & (N - 1)) !== 0
  ) {
    throw new SyncCryptoError('BAD_KDF_PARAMS', '恢复包 KDF 参数低于最低要求或非法')
  }
  // maxmem 需覆盖 128*N*r；给足余量，否则 scrypt 默认上限会误拒
  const maxmem = 256 * N * r
  return scryptSync(input.passphrase, Buffer.from(input.salt), dkLen, { N, r, p, maxmem })
}

export function recoveryAad(spaceId: string, keyEpoch: number): string {
  return `qingyu-recovery-aad/v1|${spaceId}|${keyEpoch}`
}

export interface ExportRecoveryInput {
  spaceKey: Uint8Array
  spaceId: string
  keyEpoch: number
  passphrase: string
  createdAt: number
  /** 测试可注入 salt/nonce；生产省略 */
  salt?: Uint8Array
  nonce?: Uint8Array
  kdfParams?: { N: number; r: number; p: number }
}

export function exportRecoveryPackage(input: ExportRecoveryInput): RecoveryPackage {
  assertPassphraseStrength(input.passphrase)
  if (input.spaceKey.length !== SPACE_KEY_BYTES) {
    throw new SyncCryptoError('BAD_FORMAT', 'spaceKey 必须 32 字节')
  }
  const params = input.kdfParams ?? {
    N: RECOVERY_KDF_RECOMMENDED.N,
    r: RECOVERY_KDF_RECOMMENDED.r,
    p: RECOVERY_KDF_RECOMMENDED.p,
  }
  const salt = input.salt ? Buffer.from(input.salt) : randomBytes(32)
  const nonce = input.nonce ? Buffer.from(input.nonce) : randomBytes(GCM_NONCE_BYTES)
  const key = deriveRecoveryKey({
    passphrase: input.passphrase,
    salt,
    ...params,
    dkLen: RECOVERY_KDF_MIN.dkLen,
  })
  const aad = Buffer.from(recoveryAad(input.spaceId, input.keyEpoch), 'utf8')
  const plain = Buffer.from(input.spaceKey)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad, { plaintextLength: plain.length })
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    formatVersion: SYNC_CRYPTO_FORMAT_VERSION,
    kind: 'qingyu-space-key-recovery',
    spaceId: input.spaceId,
    keyEpoch: input.keyEpoch,
    kdf: {
      algorithm: 'scrypt',
      N: params.N,
      r: params.r,
      p: params.p,
      salt: salt.toString('base64'),
      dkLen: RECOVERY_KDF_MIN.dkLen,
    },
    nonce: nonce.toString('base64'),
    ciphertext: Buffer.concat([body, tag]).toString('base64'),
    createdAt: input.createdAt,
    rotateAfterRestore: true,
  }
}

export function importRecoveryPackage(input: {
  pkg: RecoveryPackage
  passphrase: string
  expectedSpaceId?: string
  now: number
}): { spaceKey: Uint8Array; keyEpoch: number; mustRotate: true } {
  const pkg = input.pkg
  if (pkg.formatVersion !== SYNC_CRYPTO_FORMAT_VERSION || pkg.kind !== 'qingyu-space-key-recovery') {
    throw new SyncCryptoError('BAD_FORMAT', '恢复包格式不支持')
  }
  if (pkg.kdf.algorithm !== 'scrypt' || pkg.kdf.dkLen !== RECOVERY_KDF_MIN.dkLen) {
    throw new SyncCryptoError('BAD_KDF_PARAMS', '恢复包 KDF 算法/长度非法')
  }
  if (
    pkg.kdf.N < RECOVERY_KDF_MIN.N ||
    pkg.kdf.r < RECOVERY_KDF_MIN.r ||
    pkg.kdf.p < RECOVERY_KDF_MIN.p
  ) {
    throw new SyncCryptoError('BAD_KDF_PARAMS', '恢复包 KDF 参数被降级，拒绝导入')
  }
  if (input.expectedSpaceId && pkg.spaceId !== input.expectedSpaceId) {
    throw new SyncCryptoError('CROSS_SPACE', '恢复包属于其他空间')
  }
  const key = deriveRecoveryKey({
    passphrase: input.passphrase,
    salt: Buffer.from(pkg.kdf.salt, 'base64'),
    N: pkg.kdf.N,
    r: pkg.kdf.r,
    p: pkg.kdf.p,
    dkLen: pkg.kdf.dkLen,
  })
  const ciphertext = Buffer.from(pkg.ciphertext, 'base64')
  const body = ciphertext.subarray(0, ciphertext.length - GCM_TAG_BITS / 8)
  const tag = ciphertext.subarray(ciphertext.length - GCM_TAG_BITS / 8)
  const aad = Buffer.from(recoveryAad(pkg.spaceId, pkg.keyEpoch), 'utf8')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(pkg.nonce, 'base64'))
    decipher.setAAD(aad, { plaintextLength: body.length })
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(body), decipher.final()])
    if (plain.length !== SPACE_KEY_BYTES) {
      throw new SyncCryptoError('BAD_FORMAT', '恢复出的 spaceKey 长度非法')
    }
    return { spaceKey: plain, keyEpoch: pkg.keyEpoch, mustRotate: true }
  } catch (error) {
    if (error instanceof SyncCryptoError) throw error
    throw new SyncCryptoError('DECRYPT_FAILED', '恢复包口令错误或数据被篡改')
  }
}

/** 常量时间比较（challenge/proof） */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
